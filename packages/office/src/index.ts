/**
 * @codb/office — parse DOCX / XLSX / PPTX into the CODB Document Model.
 *
 * Conversion goes through the universal model (start.md), so one parser can
 * feed every renderer (PDF / HTML / JSON).
 */

import { registry } from "@codb/core";
import type { CODBDocument, CODBInput, CODBOutput } from "@codb/core";
import { normalizeInput } from "@codb/core";
import { getEntry, unzip } from "./zip";
import { blocksFromParagraphs, extractTextNodes } from "./xml";
import { PDFDocument, StandardFonts } from "pdf-lib";

function isNode(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

export type OfficeKind = "docx" | "xlsx" | "pptx";

function detectKind(entries: { name: string }[]): OfficeKind {
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  if ([...names].some((n) => n.startsWith("xl/"))) return "xlsx";
  if ([...names].some((n) => n.startsWith("ppt/"))) return "pptx";
  return "docx";
}

/** Parse office file bytes into a CODBDocument. */
export async function parseOffice(bytes: Uint8Array): Promise<{ document: CODBDocument; kind: OfficeKind }> {
  const entries = await unzip(bytes);
  const kind = detectKind(entries);
  let paragraphs: string[] = [];

  if (kind === "docx") {
    const doc = getEntry(entries, "word/document.xml");
    if (doc) paragraphs = extractTextNodes(new TextDecoder().decode(doc));
  } else if (kind === "pptx") {
    const slides = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
      .sort((a, b) => {
        const na = parseInt(/slide(\d+)/.exec(a.name)![1], 10);
        const nb = parseInt(/slide(\d+)/.exec(b.name)![1], 10);
        return na - nb;
      });
    for (const s of slides) {
      paragraphs.push(...extractTextNodes(new TextDecoder().decode(s.data)));
      paragraphs.push("\n--- slide break ---\n");
    }
  } else {
    // xlsx: iterate sheets in workbook order.
    const wb = getEntry(entries, "xl/workbook.xml");
    const shared = getEntry(entries, "xl/sharedStrings.xml");
    let strings: string[] = [];
    if (shared) {
      const sharedXml = new TextDecoder().decode(shared);
      const siBlocks = sharedXml.split(/<si>|<\/si>/g).filter((_, i) => i % 2 === 1);
      strings = siBlocks.map((block) =>
        [...block.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1]).join(""),
      );
    }
    if (wb) {
      const wbXml = new TextDecoder().decode(wb);
      const sheetNames = [...wbXml.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]);
      const sheetFiles = [...wbXml.matchAll(/r:id="rId(\d+)"/g)].map((m) => m[1]);
      const rels = getEntry(entries, "xl/_rels/workbook.xml.rels");
      const relMap = new Map<string, string>();
      if (rels) {
        const relXml = new TextDecoder().decode(rels);
        for (const m of relXml.matchAll(/Id="([^"]*)"[^>]*Target="([^"]*)"/g)) {
          relMap.set(m[1], m[2]);
        }
      }
      for (let i = 0; i < sheetNames.length; i++) {
        const relId = sheetFiles[i];
        const target = relMap.get(relId ? `rId${relId}` : `rId${i + 1}`) ?? (i > 0 ? `worksheets/sheet${i + 1}.xml` : "worksheets/sheet1.xml");
        const sheetPath = "xl/" + target.replace(/^\/+/, "");
        const sheet = getEntry(entries, sheetPath);
        if (sheet) {
          paragraphs.push(`[Sheet: ${sheetNames[i]}]`);
          const sheetXml = new TextDecoder().decode(sheet);
          for (const row of extractTextNodes(sheetXml)) {
            paragraphs.push(row);
          }
        }
      }
    }
  }

  const clean = paragraphs.map((p) => p.trim()).filter(Boolean);
  const blocks = blocksFromParagraphs(clean);

  const document: CODBDocument = {
    sourceType: `application/vnd.openxmlformats-officedocument.${kind === "docx" ? "wordprocessingml" : kind === "xlsx" ? "spreadsheetml" : "presentationml"}.document`,
    pages: [{ page: 1, blocks }],
    images: [],
    tables: [],
    links: [],
    headings: clean.filter((p) => /^#/.test(p)).map((p) => ({ type: "text", text: p })),
    metadata: { kind },
  };

  return { document, kind };
}

/** Render the CODB Document Model as JSON bytes. */
function documentToJsonBytes(document: CODBDocument): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document, null, 2));
}

/** Minimal HTML renderer from the model. */
function documentToHtmlBytes(document: CODBDocument): Uint8Array {
  const body = document.pages
    .map(
      (page) =>
        `<section class="page">
          ${page.blocks
            .map((b) => (b.type === "text" ? `<p>${escapeHtml(b.text ?? "")}</p>` : ""))
            .join("")}
        </section>`,
    )
    .join("\n");
  return new TextEncoder().encode(
    `<!doctype html><html><head><meta charset="utf-8"><title>CODB convert</title></head><body>${body}</body></html>`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Extract plain text lines from any input (office file or raw text). */
async function textLinesOf(input: CODBInput): Promise<string[]> {
  const norm = await normalizeInput(input);
  try {
    if (norm.type === "text/plain" || norm.name?.toLowerCase().match(/\.(txt|md|text)$/)) {
      return decodeText(norm.bytes).split(/\r?\n/);
    }
    const { document } = await parseOffice(norm.bytes);
    return document.pages.flatMap((p) => p.blocks.map((b) => b.text ?? "").filter(Boolean));
  } catch {
    // Not an office ZIP or failed parse => treat as plain text.
    return decodeText(norm.bytes).split(/\r?\n/);
  }
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const PAGE_W = 595.28; // A4 pt
const PAGE_H = 841.89;
const PDF_MARGIN = 50;
const LINE_H = 14;

/** Render plain text to a PDF (A4, one page at a time, wrapped). */
async function textToPdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontSize = 11;
  const maxWidth = PAGE_W - PDF_MARGIN * 2;
  const lines = wrapText(text, Math.floor(maxWidth / (fontSize * 0.55)));
  const usable = PAGE_H - PDF_MARGIN * 2;
  const perPage = Math.floor(usable / LINE_H);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - PDF_MARGIN;
  for (const line of lines) {
    if (y < PDF_MARGIN + LINE_H) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - PDF_MARGIN;
    }
    page.drawText(line || " ", { x: PDF_MARGIN, y, size: fontSize, font });
    y -= LINE_H;
  }
  return new Uint8Array(await doc.save({ useObjectStreams: true }));
}

function wrapText(text: string, cols: number): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.length === 0) {
      out.push("");
      continue;
    }
    let rest = raw;
    while (rest.length > cols) {
      let idx = rest.lastIndexOf(" ", cols);
      if (idx <= 0) idx = cols;
      out.push(rest.slice(0, idx));
      rest = rest.slice(idx).replace(/^ /, "");
    }
    out.push(rest);
  }
  return out;
}

interface TextImageArgs {
  scale?: number;
  width?: number;
  bg?: string;
  fg?: string;
}

/** Render plain text to a PNG/JPEG/WebP image. Runtime dispatched (Node/browser). */
async function renderTextToImage(text: string, format: string, quality: number, args: TextImageArgs = {}): Promise<CODBOutput> {
  const bg = args.bg ?? "#ffffff";
  const fg = args.fg ?? "#111111";
  const pt = 14;
  const cols = Math.max(20, Math.floor((args.width ?? 900) / (pt * 0.6)));
  const wrapped = wrapText(text, cols);
  const lineH = pt * 1.5;
  const width = args.width ?? 900;
  const height = Math.max(120, wrapped.length * lineH + 40);

  if (isNode()) {
    const nc = await import("@napi-rs/canvas");
    const canvas = nc.createCanvas(width, height);
    const g = canvas.getContext("2d");
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);
    g.fillStyle = fg;
    g.font = `${pt}px sans-serif`;
    let y = 24;
    for (const line of wrapped) {
      g.fillText(line, 16, y);
      y += lineH;
    }
    let mime: "image/png" | "image/jpeg" | "image/webp";
    if (format === "jpeg" || format === "jpg") mime = "image/jpeg";
    else if (format === "webp") mime = "image/webp";
    else mime = "image/png";
    if (mime === "image/png") return new Uint8Array(canvas.toBuffer("image/png"));
    return new Uint8Array(canvas.toBuffer(mime, quality));
  }

  const doc = (globalThis as { document?: Document }).document;
  if (!doc) throw new Error("Text→image requires a browser canvas (or run in Node).");
  const canvas = doc.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  g.fillStyle = bg;
  g.fillRect(0, 0, width, height);
  g.fillStyle = fg;
  g.font = `${pt}px sans-serif`;
  let y = 24;
  for (const line of wrapped) {
    g.fillText(line, 16, y);
    y += lineH;
  }
  const mime = `image/${format === "jpg" ? "jpeg" : format}`;
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), mime, quality),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

export function register() {
  registry.register(
    { category: "office", op: "convert" },
    {
      backends: ["local"],
      run: async (input, options) => {
        const norm = await normalizeInput(input as unknown as CODBInput);
        const { document } = await parseOffice(norm.bytes);
        const to = options.to;
        if (to === "json") return documentToJsonBytes(document);
        if (to === "html") return documentToHtmlBytes(document);
        throw new Error(`@codb/office cannot render to "${to}".`);
      },
    },
  );

  // convert("pdf") normalizes to category "pdf"; office also needs a general
  // "convert" entry for docx/html. Register under "core" too for txt.
  registry.register(
    { category: "core", op: "convert" },
    {
      backends: ["local"],
      run: async (input, options) => {
        const norm = await normalizeInput(input as unknown as CODBInput);
        const { document } = await parseOffice(norm.bytes);
        const to = options.to;
        if (to === "json") return documentToJsonBytes(document);
        if (to === "html") return documentToHtmlBytes(document);
        if (to === "txt") {
          return new TextEncoder().encode(document.pages.flatMap((p) => p.blocks).map((b) => b.text ?? "").join("\n"));
        }
        throw new Error(`Unsupported core convert target "${to}".`);
      },
    },
  );

  // Document / text → PDF
  registry.register(
    { category: "office", op: "pdf" },
    {
      backends: ["local"],
      run: async (input) => {
        const lines = await textLinesOf(input as unknown as CODBInput);
        return textToPdf(lines.join("\n"));
      },
    },
  );
  registry.register(
    { category: "text", op: "pdf" },
    {
      backends: ["local"],
      run: async (input) => {
        const lines = await textLinesOf(input as unknown as CODBInput);
        return textToPdf(lines.join("\n"));
      },
    },
  );

  // Document / text → image
  registry.register(
    { category: "office", op: "toImage" },
    {
      backends: ["local"],
      run: async (input, options) => {
        const lines = await textLinesOf(input as unknown as CODBInput);
        return renderTextToImage(lines.join("\n"), (options.to as string) ?? "png", options.quality ?? 0.9, {
          width: options.width,
        });
      },
    },
  );
  registry.register(
    { category: "text", op: "toImage" },
    {
      backends: ["local"],
      run: async (input, options) => {
        const lines = await textLinesOf(input as unknown as CODBInput);
        return renderTextToImage(lines.join("\n"), (options.to as string) ?? "png", options.quality ?? 0.9, {
          width: options.width,
        });
      },
    },
  );

  // Text → json/html/txt (plain text source)
  registry.register(
    { category: "text", op: "convert" },
    {
      backends: ["local"],
      run: async (input, options) => {
        const lines = await textLinesOf(input as unknown as CODBInput);
        const text = lines.join("\n");
        const to = options.to;
        if (to === "txt") return new TextEncoder().encode(text);
        if (to === "html") {
          return new TextEncoder().encode(`<!doctype html><html><head><meta charset="utf-8"><title>CODB text</title></head><body>${text.split("\n").map((l) => `<p>${escapeHtml(l)}</p>`).join("")}</body></html>`);
        }
        if (to === "json") {
          return new TextEncoder().encode(JSON.stringify({ sourceType: "text/plain", pages: [{ page: 1, blocks: [{ type: "text", text }] }] }, null, 2));
        }
        throw new Error(`Unsupported text convert target "${to}".`);
      },
    },
  );
}
