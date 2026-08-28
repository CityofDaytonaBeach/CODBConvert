import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { CODBDocs } from "@codb/core";
import { register as registerPdf, deframePages } from "@codb/pdf";

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

  const frames = deframePages(out);
  assert.equal(frames.length, 3);
  for (const frame of frames) {
    const parsed = await PDFDocument.load(frame as unknown as Uint8Array);
    assert.equal(parsed.getPageCount(), 1);
  }
});

test("pdf.split frames round-trip through deframePages", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  doc.addPage([100, 100]);
  const bytes = await doc.save();
  const codb = new CODBDocs();
  const out = (await codb.pdf.split(bytes)) as Uint8Array;
  const frames = deframePages(out);
  assert.equal(frames.length, 2);
});

test("pdf.toImages renders pages offline (Node @napi-rs/canvas)", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([120, 120]);
  page.drawText("CODB", { x: 20, y: 60, font, size: 14 });
  const bytes = await doc.save();

  const codb = new CODBDocs();
  const out = (await codb.pdf.toImages(bytes, { format: "png", scale: 1 })) as Uint8Array;

  const pages = deframePages(out);
  assert.equal(pages.length, 1);
  const png = pages[0];
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  assert.deepEqual(Array.from(png.slice(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(png.byteLength > 100);
});
