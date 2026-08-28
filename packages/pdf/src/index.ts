/**
 * @codb/pdf — merge, split, reorder, render to images, extract text.
 */

import { registry, type ConversionContext } from "@codb/core";
import type { CODBInput, CODBOutput } from "@codb/core";
import { normalizeInput } from "@codb/core";
import { PDFDocument } from "pdf-lib";

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
  const bytes = await out.save({ useObjectStreams: true });
  return bytesToU8(bytes);
}

/** Split a PDF into one PDF per page, wrapped in a single binary envelope. */
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
    parts.push(await one.save());
  }
  const separator = new TextEncoder().encode("\n");
  const total = parts.reduce((a, b) => a + b.byteLength, 0) + separator.length * (parts.length - 1);
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].byteLength;
    if (i < parts.length - 1) {
      out.set(separator, offset);
      offset += separator.length;
    }
  }
  return out;
}

/** Reorder/select pages by index list. */
async function selectPages(input: CODBInput, indices: number[]): Promise<CODBOutput> {
  const norm = await normalizeInput(input);
  const src = await PDFDocument.load(norm.bytes as unknown as Uint8Array);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return bytesToU8(await out.save());
}

// ---- PDF.js based operations (render to images / extract text) ----

async function loadPdfJs() {
  const m = await import("pdfjs-dist");
  const workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
  if (!(globalThis as { PDFJS_EXISTS?: boolean }).PDFJS_EXISTS) {
    m.GlobalWorkerOptions.workerSrc = workerSrc;
    (globalThis as { PDFJS_EXISTS?: boolean }).PDFJS_EXISTS = true;
  }
  return m;
}

/** Render every page of a PDF to images, returned as an array of blobs/bytes. */
async function toImages(
  input: CODBInput,
  ctx: ConversionContext,
  opts: { format?: string; scale?: number },
): Promise<CODBOutput> {
  const norm = await normalizeInput(input);
  const format = opts.format ?? "webp";
  const scale = opts.scale ?? 2;
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: norm.bytes }).promise;
  const count = doc.numPages;
  const results: Blob[] = [];
  for (let i = 1; i <= count; i++) {
    ctx.progress(`rendering page ${i}/${count}`, Math.round((i / count) * 100));
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const g = canvas.getContext("2d")!;
    await page.render({ canvasContext: g, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), `image/${format}`, 0.9);
    });
    results.push(blob);
  }
  // Encode as a length-prefixed binary sequence so the caller can split frames.
  return encodeFrames(results);
}

function encodeFrames(blobs: Blob[]): Uint8Array {
  const parts = blobs.map((b) => new Uint8Array(b.size));
  const headerSize = blobs.length * 4;
  const total = headerSize + blobs.reduce((a, b) => a + b.size, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (let i = 0; i < blobs.length; i++) {
    view.setUint32(offset, blobs[i].size, true);
    offset += 4;
  }
  return out;
}

/** Extract plain text with PDF.js. */
async function extractText(input: CODBInput, ctx: ConversionContext): Promise<CODBOutput> {
  const norm = await normalizeInput(input);
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: norm.bytes }).promise;
  const count = doc.numPages;
  const texts: string[] = [];
  for (let i = 1; i <= count; i++) {
    ctx.progress(`extracting text page ${i}/${count}`, Math.round((i / count) * 100));
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items.map((it) => (it as { str?: string }).str ?? "").join(" ");
    texts.push(line);
  }
  return new TextEncoder().encode(texts.join("\n"));
}

export function register() {
  const one = (v: unknown) => v as unknown as CODBInput;

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
    {
      backends: ["local"],
      run: async (inputs, options, ctx) => merge(inputs as unknown as CODBInput[], ctx),
    },
  );

  registry.register(
    { category: "pdf", op: "split" },
    {
      backends: ["local"],
      run: async (input, options, ctx) => split(one(input), ctx),
    },
  );

  registry.register(
    { category: "pdf", op: "extractText" },
    {
      backends: ["local"],
      run: async (input, options, ctx) => extractText(one(input), ctx),
    },
  );

  registry.register(
    { category: "pdf", op: "toImages" },
    {
      backends: ["local"],
      run: async (input, options, ctx) =>
        toImages(one(input), ctx, { format: options.to, scale: options.scale }),
    },
  );
}

async function analyzeToJson(input: CODBInput, ctx: ConversionContext): Promise<CODBOutput> {
  const text = await extractText(input, ctx);
  const u8 = text as unknown as Uint8Array;
  return new TextEncoder().encode(
    JSON.stringify({
      sourceType: "application/pdf",
      pages: [
        {
          page: 1,
          blocks: u8.byteLength
            ? [{ type: "text", text: new TextDecoder().decode(u8) }]
            : [],
        },
      ],
    }),
  );
}
