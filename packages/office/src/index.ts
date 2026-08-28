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
}
