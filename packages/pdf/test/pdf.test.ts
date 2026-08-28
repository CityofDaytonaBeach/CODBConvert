import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { CODBDocs } from "@codb/core";
import { register as registerPdf } from "@codb/pdf";

async function makePdf(label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.getPage(0).drawText(label);
  return doc.save();
}

registerPdf();

test("pdf merge combines two PDFs into one with correct page count", async () => {
  const a = await makePdf("AAA");
  const b = await makePdf("BBB");

  const codb = new CODBDocs();
  const merged = (await codb.pdf.merge([a, b])) as Uint8Array;

  const parsed = await PDFDocument.load(merged as unknown as Uint8Array);
  assert.equal(parsed.getPageCount(), 2);
});

test("pdf merge of a single pdf keeps one page", async () => {
  const a = await makePdf("single");
  const codb = new CODBDocs();
  const merged = (await codb.pdf.merge([a])) as Uint8Array;
  const parsed = await PDFDocument.load(merged as unknown as Uint8Array);
  assert.equal(parsed.getPageCount(), 1);
});

test("pdf split produces per-page envelopes", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  doc.addPage([100, 100]);
  doc.addPage([100, 100]);
  const bytes = await doc.save();

  const codb = new CODBDocs();
  const out = (await codb.pdf.split(bytes)) as Uint8Array;

  // Manual frames: each frame is a valid PDF, split on newline separators.
  const frames = splitFrames(out);
  assert.equal(frames.length, 3);
  for (const frame of frames) {
    const parsed = await PDFDocument.load(frame as unknown as Uint8Array);
    assert.equal(parsed.getPageCount(), 1);
  }
});

function splitFrames(bytes: Uint8Array): Uint8Array[] {
  // %PDF magic embedded within envelope; newlines delimit frames.
  const frames: Uint8Array[] = [];
  let start = findSig(bytes, 0);
  while (start !== -1) {
    let next = findSig(bytes, start + 1);
    let end = bytes.byteLength;
    if (next !== -1) {
      // Trim trailing newline before next %PDF.
      let k = next - 1;
      while (k > start && (bytes[k] === 10 || bytes[k] === 13)) k--;
      end = k + 1;
    }
    frames.push(bytes.slice(start, end));
    if (next === -1) break;
    start = next;
  }
  return frames;
}

function findSig(bytes: Uint8Array, from: number): number {
  const sig = new TextEncoder().encode("%PDF-");
  for (let i = from; i <= bytes.length - sig.length; i++) {
    let ok = true;
    for (let j = 0; j < sig.length; j++) {
      if (bytes[i + j] !== sig[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}
