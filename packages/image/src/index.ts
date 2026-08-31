/**
 * @codb/image — convert image formats, resize, compress.
 *
 * Fully local, no server/VPS required:
 *  - Browser: native <img> + <canvas> (+ toBlob).
 *  - Node:    @napi-rs/canvas (prebuilt binary, headless) via dynamic import.
 *
 * The same public API (image.convert) works in both runtimes.
 */

import { registry, sniffType } from "@codb/core";
import type { CODBInput, CODBOutput } from "@codb/core";
import { normalizeInput, bytesToBase64 } from "@codb/core";
import { PDFDocument } from "pdf-lib";
import { encodeBmp, encodeGif, encodeSvg, encodeTiff, type PixelSource } from "./encoders";

export { encodeBmp, encodeGif, encodeSvg, encodeTiff } from "./encoders";
export type { PixelSource } from "./encoders";

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  gif: "image/gif",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tif: "image/tiff",
};

export interface ImageOpOptions {
  format: string;
  quality: number;
  width?: number;
  height?: number;
  contain?: boolean;
}

function isNode(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

/** Normalize a format string to its canonical output key. */
function normFormat(format: string): string {
  if (format === "jpeg" || format === "jpg") return "jpeg";
  if (format === "tiff" || format === "tif") return "tiff";
  return format;
}

function isHeicLike(type?: string, name?: string, bytes?: Uint8Array): boolean {
  const t = type?.toLowerCase();
  if (t === "image/heic" || t === "image/heif" || t === "image/heic-sequence" || t === "image/heif-sequence") return true;
  const ext = name?.toLowerCase().split(".").pop();
  if (ext === "heic" || ext === "heif" || ext === "heics" || ext === "heifs") return true;
  const sniffed = bytes ? sniffType(bytes) : undefined;
  return sniffed === "image/heic" || sniffed === "image/heif";
}

async function decodeHeicToPngBlob(bytes: Uint8Array): Promise<Blob> {
  const mod = await import("heic2any");
  const heic2any = mod.default;
  const out = await heic2any({
    blob: new Blob([bytes as BlobPart], { type: "image/heic" }),
    toType: "image/png",
  });
  return Array.isArray(out) ? out[0] : out;
}

/** Compute target dimensions preserving aspect ratio (consistent across runtimes). */
function computeSize(srcW: number, srcH: number, opts: ImageOpOptions): { w: number; h: number } {
  const { width, height, contain } = opts;
  if (width && height && !contain) return { w: Math.round(width), h: Math.round(height) };
  if (width && height && contain) {
    const s = Math.min(width / srcW, height / srcH);
    return { w: Math.round(srcW * s), h: Math.round(srcH * s) };
  }
  if (width) {
    const s = width / srcW;
    return { w: Math.round(width), h: Math.round(srcH * s) };
  }
  if (height) {
    const s = height / srcH;
    return { w: Math.round(srcW * s), h: Math.round(height) };
  }
  return { w: srcW, h: srcH };
}

/** --- Node via @napi-rs/canvas (prebuilt, headless, no VPS) --- */
async function convertNode(input: CODBInput, opts: ImageOpOptions): Promise<CODBOutput> {
  const nc = await import("@napi-rs/canvas");
  const norm = await normalizeInput(input);
  if (isHeicLike(norm.type, norm.name, norm.bytes)) {
    throw new Error("HEIC/HEIF input decoding is browser-only. Convert Apple photos in the browser runtime.");
  }
  const source = await nc.loadImage(norm.bytes as unknown as Buffer);

  const { w, h } = computeSize(source.width, source.height, opts);
  const canvas = nc.createCanvas(w, h);
  const g = canvas.getContext("2d");
  g.imageSmoothingEnabled = true;

  const srcW = source.width;
  const srcH = source.height;

  if (opts.width && opts.height && !opts.contain) {
    const s = Math.max(opts.width / srcW, opts.height / srcH);
    const dx = (opts.width - srcW * s) / 2;
    const dy = (opts.height - srcH * s) / 2;
    g.drawImage(source as never, dx, dy, srcW * s, srcH * s);
  } else {
    g.drawImage(source as never, 0, 0, w, h);
  }

  const f = normFormat(opts.format);
  const mime = IMAGE_MIME[f];
  if (mime === "image/svg+xml") {
    const png = new Uint8Array(canvas.toBuffer("image/png"));
    return encodeSvg(w, h, bytesToBase64(png));
  }

  return encodeNode(canvas as unknown as { toBuffer(mime: string, quality?: number): Uint8Array }, g as unknown as PixelSource, w, h, opts.format, opts.quality);
}

function encodeNode(canvas: { toBuffer(mime: string, quality?: number): Uint8Array }, g: PixelSource, width: number, height: number, format: string, quality: number): Uint8Array {
  const f = normFormat(format);
  const mime = IMAGE_MIME[f] ?? "image/png";
  if (mime === "image/png") return new Uint8Array(canvas.toBuffer("image/png"));
  if (mime === "image/jpeg") return new Uint8Array(canvas.toBuffer("image/jpeg", quality));
  if (mime === "image/webp") return new Uint8Array(canvas.toBuffer("image/webp", quality));
  if (mime === "image/bmp") return encodeBmp(g, width, height);
  if (mime === "image/gif") return encodeGif(g, width, height);
  if (mime === "image/tiff") return encodeTiff(g, width, height);
  if (mime === "image/svg+xml") {
    throw new Error("@codb/image cannot encode SVG synchronously in Node; use the browser runtime or the package encoder.");
  }
  throw new Error(`@codb/image cannot encode "${format}" in Node; supported: png, jpeg, webp, bmp, gif, tiff.`);
}

/** --- Browser via native canvas --- */
async function convertBrowser(input: CODBInput, opts: ImageOpOptions): Promise<CODBOutput> {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof doc.createElement !== "function" || typeof Image === "undefined") {
    throw new Error("Browser image conversion requires a document with canvas support.");
  }
  const norm = await normalizeInput(input);
  const u8 = norm.bytes;
  const sourceBlob = isHeicLike(norm.type, norm.name, u8)
    ? await decodeHeicToPngBlob(u8)
    : new Blob([u8 as BlobPart], { type: norm.type || sniffType(u8) || "image/png" });
  const img = new Image();
  const url = URL.createObjectURL(sourceBlob);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to decode image."));
    img.src = url;
  });
  URL.revokeObjectURL(url);

  const srcW = img.naturalWidth || 1;
  const srcH = img.naturalHeight || 1;
  const { w, h } = computeSize(srcW, srcH, opts);
  const canvas = doc.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;

  if (opts.width && opts.height && !opts.contain) {
    const s = Math.max(opts.width / srcW, opts.height / srcH);
    const dx = (opts.width - srcW * s) / 2;
    const dy = (opts.height - srcH * s) / 2;
    g.drawImage(img, dx, dy, srcW * s, srcH * s);
  } else {
    g.drawImage(img, 0, 0, w, h);
  }

  const mime = IMAGE_MIME[normFormat(opts.format)] ?? "image/png";
  const f = normFormat(opts.format);
  if (f === "bmp") return encodeBmp(g as unknown as PixelSource, w, h);
  if (f === "gif") return encodeGif(g as unknown as PixelSource, w, h);
  if (f === "tiff") return encodeTiff(g as unknown as PixelSource, w, h);
  if (f === "svg") {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed for image/png"))), "image/png", opts.quality ?? 0.9);
    });
    const png = new Uint8Array(await blob.arrayBuffer());
    return encodeSvg(w, h, bytesToBase64(png));
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`toBlob failed for ${mime}`))), mime, opts.quality ?? 0.9);
  });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function convertImage(input: CODBInput, opts: ImageOpOptions): Promise<CODBOutput> {
  return isNode() ? convertNode(input, opts) : convertBrowser(input, opts);
}

export function register() {
  registry.register(
    { category: "image", op: "convert" },
    {
      backends: ["local"],
      run: async (input, options) =>
        convertImage(input as unknown as CODBInput, {
          format: (options.to as string) ?? "png",
          quality: options.quality ?? 0.9,
          width: options.width,
          height: options.height,
          contain: false,
        }),
    },
  );

  registry.register(
    { category: "image", op: "pdf" },
    { backends: ["local"], run: async (input, options) => imageToPdf(input as unknown as CODBInput, options) },
  );
}

/** Embed one or more images into a PDF with each image on its own page. */
export async function imageToPdf(
  input: CODBInput | CODBInput[],
  opts: { width?: number; height?: number } = {},
): Promise<CODBOutput> {
  const list = Array.isArray(input) ? input : [input];
  const doc = await PDFDocument.create();
  const defaultPage = opts.width && opts.height ? { w: opts.width, h: opts.height } : null;

  for (const item of list) {
    const norm = await normalizeInput(item as CODBInput);
    const mime = sniffType(norm.bytes) ?? norm.type;
    let embeddable: { bytes: Uint8Array; mime: string } =
      mime === "image/png" || mime === "image/jpeg"
        ? { bytes: norm.bytes, mime }
        : { bytes: await toPng(norm), mime: "image/png" };

    const img = embeddable.mime === "image/jpeg" ? await doc.embedJpg(embeddable.bytes as unknown as Uint8Array) : await doc.embedPng(embeddable.bytes as unknown as Uint8Array);

    const pw = defaultPage ? defaultPage.w : img.width;
    const ph = defaultPage ? defaultPage.h : img.height;
    const page = doc.addPage([pw, ph]);

    // Fit the image inside the page preserving aspect ratio.
    const s = Math.min(pw / img.width, ph / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    page.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
  }

  return new Uint8Array(await doc.save({ useObjectStreams: true }));
}

/** Re-encode arbitrary image bytes to PNG via the runtime canvas. */
async function toPng(norm: { bytes: Uint8Array; type?: string; name?: string }): Promise<Uint8Array> {
  if (isNode()) {
    if (isHeicLike(norm.type, norm.name, norm.bytes)) {
      throw new Error("HEIC/HEIF input decoding is browser-only. Convert Apple photos to PDF in the browser runtime.");
    }
    const nc = await import("@napi-rs/canvas");
    const source = await nc.loadImage(norm.bytes as unknown as Buffer);
    const canvas = nc.createCanvas(source.width, source.height);
    const g = canvas.getContext("2d");
    g.drawImage(source as never, 0, 0);
    return new Uint8Array(canvas.toBuffer("image/png"));
  }
  const doc = (globalThis as { document?: Document }).document;
  if (!doc) throw new Error("Decoding image requires a browser canvas (or run in Node).");
  const u8 = norm.bytes;
  const sourceBlob = isHeicLike(norm.type, norm.name, u8)
    ? await decodeHeicToPngBlob(u8)
    : new Blob([u8 as BlobPart], { type: norm.type || sniffType(u8) || "image/png" });
  const img = new Image();
  const url = URL.createObjectURL(sourceBlob);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to decode image."));
    img.src = url;
  });
  URL.revokeObjectURL(url);
  const canvas = doc.createElement("canvas");
  canvas.width = img.naturalWidth || 1;
  canvas.height = img.naturalHeight || 1;
  const g = canvas.getContext("2d")!;
  g.drawImage(img, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
  return new Uint8Array(await blob.arrayBuffer());
}
