/**
 * @codb/pdf — merge, split, reorder, render to images, extract text.
 *
 * Fully local (offline / no VPS):
 *  - pdf-lib for merge / split / page-select (browser + Node, pure JS).
 *  - pdfjs-dist for rendering to images and text extraction.
 *      Browser: modern build + native <canvas> + Vite-resolved worker.
 *      Node:    legacy build + @napi-rs/canvas (prebuilt, headless).
 */

import { registry, type ConversionContext } from "@codb/core";
import type { CODBInput, CODBOutput } from "@codb/core";
import { normalizeInput } from "@codb/core";
import { PDFDocument } from "pdf-lib";

function isNode(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

function bytesToU8(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

/** Merge multiple PDFs into a single PDF (pdf-lib). */
async function merge(inputs: CODBInput[], ctx: ConversionContext): Promise<CODBOutput> {
  const out = await PDFDocument.create();
  for (let i = 0; i < inputs.length; i++) {
    ctx.progress(`merging document ${i + 1}/${inputs.length}`, Math.round((i / inputs.length) * 100));
    const norm = await normalizeInput(inputs[i]);
    const src = await PDFDocument.load(norm.bytes as unknown as Uint8Array);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  ctx.progress("finalizing", 100);
  return bytesToU8(await out.save({ useObjectStreams: true }));
}

/** Split a PDF into one PDF per page (framed so a caller can recover each). */
async function split(input: CODBInput, ctx: ConversionContext): Promise<CODBOutput> {
  const norm = await normalizeInput(input);
  const src = await PDFDocument.load(norm.bytes as unknown as Uint8Array);
  const count = src.getPageCount();
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    ctx.progress(`splitting page ${i + 1}/${count}`, Math.round(((i + 1) / count) * 100));
    const one = await PDFDocument.create();
    const [copied] = await one.copyPages(src, [i]);
    one.addPage(copied);
    parts.push(bytesToU8(await one.save()));
  }
  return framePages(parts);
}

/** Reorder/select pages by index list. */
async function selectPages(input: CODBInput, indices: number[]): Promise<CODBOutput> {
  const norm = await normalizeInput(input);
  const src = await PDFDocument.load(norm.bytes as unknown as Uint8Array);
  for (const idx of indices) {
    if (idx < 0 || idx >= src.getPageCount()) throw new Error(`Page index ${idx} out of range.`);
  }
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return bytesToU8(await out.save());
}

/** Frame multiple PDF byte blobs with 4-byte length headers. */
function framePages(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, b) => a + b.byteLength, 0) + parts.length * 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.byteLength, true);
    offset += 4;
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Split framed output back into individual PDF byte arrays. */
export function deframePages(framed: Uint8Array): Uint8Array[] {
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= framed.byteLength) {
    const len = view.getUint32(offset, true);
    offset += 4;
    out.push(framed.slice(offset, offset + len));
    offset += len;
  }
  return out;
}

// ---- PDF.js operations (render to images / extract text) ----

type PdfjsApi = typeof import("pdfjs-dist"); // structural
interface PdfjsDocLike {
  numPages: number;
  getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number }; render(o: unknown): { promise: Promise<void> }; getTextContent(): Promise<{ items: Array<{ str?: string }> }> }>;
  destroy(): Promise<void>;
}

async function loadPdfJs() {
  if (isNode()) {
    // Legacy build auto-polyfills Path2D/DOMMatrix/ImageData from @napi-rs/canvas.
    const m = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return m as unknown as PdfjsApi;
  }
  const m = await import("pdfjs-dist");
  const workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
  if (!(globalThis as { PDFJS_EXISTS?: boolean }).PDFJS_EXISTS) {
    m.GlobalWorkerOptions.workerSrc = workerSrc;
    (globalThis as { PDFJS_EXISTS?: boolean }).PDFJS_EXISTS = true;
  }
  return m as unknown as PdfjsApi;
}

/** Locate the pdfjs-dist standard_fonts directory (Node only). */
function resolveStandardFontPath(): string | null {
  if (!isNode()) return null;
  try {
    const { createRequire } = process.getBuiltinModule("module");
    const req = createRequire(import.meta.url);
    const legacyPath = req.resolve("pdfjs-dist/legacy/build/pdf.mjs");
    const parts = legacyPath.split(/[\\/]/);
    const { readdirSync } = process.getBuiltinModule("fs");
    while (parts.length) {
      parts.pop();
      const candidate = [...parts, "standard_fonts"].join("/");
      try {
        if (readdirSync(candidate, { withFileTypes: true }).some((d: { name: string }) => d.name === "LiberationSans-Regular.ttf")) {
          return candidate + "/";
        }
      } catch {
        /* keep walking up the ancestor chain */
      }
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

interface RenderablePage {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: unknown): { promise: Promise<void> };
}

/** Render one PDF page to encoded image bytes. Runtime dispatched. */
async function renderPageToImage(
  page: RenderablePage,
  opts: { scale: number; format: string; quality: number },
): Promise<Uint8Array> {
  const viewport = page.getViewport({ scale: opts.scale });
  const w = Math.floor(viewport.width);
  const h = Math.floor(viewport.height);
  const format = opts.format ?? "webp";
  const mime = `image/${format === "jpg" ? "jpeg" : format}`;

  if (isNode()) {
    const nc = await import("@napi-rs/canvas");
    const canvas = nc.createCanvas(w, h);
    const g = canvas.getContext("2d");
    await page.render({ canvasContext: g, viewport } as never).promise;
    return encodeNodeCanvas(canvas, format, opts.quality);
  }

  const doc = (globalThis as { document?: Document }).document;
  if (!doc) throw new Error("PDF→image requires a browser canvas (or run in Node).");
  const canvas = doc.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  await page.render({ canvasContext: g, viewport }).promise;
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), mime, opts.quality);
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function encodeNodeCanvas(canvas: { toBuffer(mime: string, q?: number): Uint8Array }, format: string, quality: number): Uint8Array {
  if (format === "png") return new Uint8Array(canvas.toBuffer("image/png"));
  if (format === "jpeg" || format === "jpg") return new Uint8Array(canvas.toBuffer("image/jpeg", quality));
  if (format === "webp") return new Uint8Array(canvas.toBuffer("image/webp", quality));
  throw new Error(`Cannot encode PDF page as "${format}" in Node; supported: png, jpeg, webp.`);
}

/** Render every page to images. Returns one encoded image per page. */
async function toImages(
  input: CODBInput,
  ctx: ConversionContext,
  opts: { format?: string; scale?: number; quality?: number },
): Promise<Uint8Array[]> {
  const norm = await normalizeInput(input);
  const pdfjs = await loadPdfJs();
  const doc = (await pdfjs.getDocument({
    data: norm.bytes,
    standardFontDataUrl: resolveStandardFontPath() ?? undefined,
  }).promise) as unknown as PdfjsDocLike;
  const count = doc.numPages;
  const results: Uint8Array[] = [];
  for (let i = 1; i <= count; i++) {
    ctx.progress(`rendering page ${i}/${count}`, Math.round((i / count) * 100));
    const page = (await doc.getPage(i)) as unknown as RenderablePage;
    results.push(await renderPageToImage(page, {
      scale: opts.scale ?? 2,
      format: opts.format ?? "png",
      quality: opts.quality ?? 0.9,
    }));
  }
  await doc.destroy();
  return results;
}

/** Extract plain text with PDF.js. */
async function extractText(input: CODBInput, ctx: ConversionContext): Promise<CODBOutput> {
  const norm = await normalizeInput(input);
  const pdfjs = await loadPdfJs();
  const doc = (await pdfjs.getDocument({ data: norm.bytes }).promise) as unknown as PdfjsDocLike;
  const count = doc.numPages;
  const texts: string[] = [];
  for (let i = 1; i <= count; i++) {
    ctx.progress(`extracting text page ${i}/${count}`, Math.round((i / count) * 100));
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items.map((it) => it.str ?? "").join(" ");
    texts.push(line);
  }
  await doc.destroy();
  return new TextEncoder().encode(texts.join("\n"));
}

export function register() {
  const one = (v: unknown) => v as unknown as CODBInput;

  registry.register(
    { category: "pdf", op: "pdf" },
    { backends: ["local"], run: async (input, _o) => normalizeInput(one(input)).then((n) => n.bytes) },
  );

  registry.register(
    { category: "pdf", op: "txt" },
    { backends: ["local"], run: async (input, _o, ctx) => extractText(one(input), ctx) },
  );

  registry.register(
    { category: "pdf", op: "html" },
    { backends: ["local"], run: async (input, _o, ctx) => pdfToHtml(one(input), ctx) },
  );

  registry.register(
    { category: "pdf", op: "json" },
    { backends: ["local"], run: async (input, _o, ctx) => analyzeToJson(one(input), ctx) },
  );

  registry.register(
    { category: "pdf", op: "convert" },
    {
      backends: ["local"],
      run: async (input, options, ctx) => {
        const out = options.to;
        if (out === "json") return analyzeToJson(one(input), ctx);
        if (out === "txt") return extractText(one(input), ctx);
        throw new Error(`@codb/pdf cannot convert PDF to "${out}".`);
      },
    },
  );

  registry.register(
    { category: "pdf", op: "merge" },
    { backends: ["local"], run: async (inputs, _o, ctx) => merge(inputs as unknown as CODBInput[], ctx) },
  );

  registry.register(
    { category: "pdf", op: "split" },
    { backends: ["local"], run: async (input, _o, ctx) => split(one(input), ctx) },
  );

  registry.register(
    { category: "pdf", op: "extractText" },
    { backends: ["local"], run: async (input, _o, ctx) => extractText(one(input), ctx) },
  );

  registry.register(
    { category: "pdf", op: "toImages" },
    {
      backends: ["local"],
      run: async (input, options, ctx) => {
        const pages = await toImages(one(input), ctx, {
          format: (options.format as string) ?? "png",
          scale: options.scale ?? 2,
          quality: options.quality ?? 0.9,
        });
        return framePages(pages);
      },
    },
  );
}

async function pdfToHtml(input: CODBInput, ctx: ConversionContext): Promise<Uint8Array> {
  const text = new TextDecoder().decode((await extractText(input, ctx)) as Uint8Array);
  const body = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => `<p>${l}</p>`)
    .join("\n");
  return new TextEncoder().encode(
    `<!doctype html><html><head><meta charset="utf-8"><title>CODB PDF</title></head><body>${body}</body></html>`,
  );
}

async function analyzeToJson(input: CODBInput, ctx: ConversionContext): Promise<CODBOutput> {
  const text = (await extractText(input, ctx)) as unknown as Uint8Array;
  return new TextEncoder().encode(
    JSON.stringify({
      sourceType: "application/pdf",
      pages: [
        {
          page: 1,
          blocks: text.byteLength
            ? [{ type: "text", text: new TextDecoder().decode(text) }]
            : [],
        },
      ],
    }),
  );
}
