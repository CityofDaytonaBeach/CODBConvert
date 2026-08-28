/**
 * Lightweight helpers to pull text content out of OOXML (DOCX/XLSX/PPTX).
 * OOXML is XML; we extract the meaningful text via targeted regex scanning
 * without pulling in a full XML DOM dependency.
 */

import type { CODBContentBlock, CODBDocument } from "@codb/core";

const XML_DECL = /<\?xml[^>]*\?>/;
const NS_STRIP = /<\/?[a-zA-Z0-9]+:/g;

/** Decode a handful of XML entities into plain text. */
export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/** Extract visible text nodes from a DOCX/PPTX XML body. */
export function extractTextNodes(xml: string): string[] {
  const clean = xml.replace(XML_DECL, "");
  // OOXML uses <w:t>, <a:t>, <w:tab/>, <w:br/> etc. Grab element text generically.
  const paragraphs: string[] = [];
  // Match every element that directly holds text content.
  const re = /<([\w:]+)([^>]*)>([^<>]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const tag = m[1];
    const inner = m[3];
    if (!/^[\w:]+$/.test(tag)) continue;
    if (inner.trim().length === 0) continue;
    // Only collect leaf text containers for office namespaces.
    if (/^(w:t|a:t|m:t|v:t|t)$/.test(tag)) {
      paragraphs.push(decodeXml(inner));
    }
  }
  return paragraphs;
}

/** Build a CODB document from an OOXML text fragment. */
export function blocksFromParagraphs(paragraphs: string[]): CODBContentBlock[] {
  const blocks: CODBContentBlock[] = [];
  for (const text of paragraphs) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    blocks.push(trimmed.startsWith("#")
      ? { type: "text", text: trimmed, style: { bold: true } }
      : { type: "text", text: trimmed });
  }
  return blocks;
}
