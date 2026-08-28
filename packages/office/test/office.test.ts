import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { TextEncoder } from "node:util";
import { CODBDocs } from "@codb/core";
import { register as registerOffice } from "@codb/office";

registerOffice();

/** Build a minimal valid ZIP archive (local file headers only). */
function buildZip(entries: Array<{ name: string; data: Uint8Array | string }>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const fh = new DataView(new ArrayBuffer(30));

  for (const entry of entries) {
    const raw = typeof entry.data === "string" ? enc.encode(entry.data) : entry.data;
    const comp = deflateRawSync(raw);
    const name = enc.encode(entry.name);

    fh.setUint32(0, 0x04034b50, true);
    fh.setUint16(4, 20, true); // version needed
    fh.setUint16(6, 0, true); // flags
    fh.setUint16(8, 8, true); // method: deflate
    fh.setUint16(10, 0, true);
    fh.setUint16(12, 0, true);
    fh.setUint32(14, crc32(raw) >>> 0, true);
    fh.setUint32(18, comp.byteLength, true);
    fh.setUint32(22, raw.byteLength, true);
    fh.setUint16(26, name.byteLength, true);
    fh.setUint16(28, 0, true);

    chunks.push(new Uint8Array(fh.buffer));
    chunks.push(name);
    chunks.push(comp);
  }

  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

test("office parses a minimal DOCX into the CODB document model", async () => {
  const docx = buildZip([
    {
      name: "word/document.xml",
      data: `<?xml version="1.0"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:r><w:t>Hello CODB world</w:t></w:r></w:p>
            <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
          </w:body>
        </w:document>`,
    },
  ]);

  const codb = new CODBDocs();
  const jsonBytes = (await codb.convert(docx, { to: "json" })) as Uint8Array;
  const parsed = JSON.parse(new TextDecoder().decode(jsonBytes));

  assert.equal(parsed.metadata.kind, "docx");
  const texts = parsed.pages[0].blocks.map((b: { text?: string }) => b.text);
  assert.ok(texts.includes("Hello CODB world"));
  assert.ok(texts.includes("Second paragraph"));
});

test("office renders model to HTML", async () => {
  const docx = buildZip([
    { name: "word/document.xml", data: `<w:document><w:body><w:p><w:r><w:t>Hi</w:t></w:r></w:p></w:body></w:document>` },
  ]);
  const codb = new CODBDocs();
  const html = new TextDecoder().decode((await codb.convert(docx, { to: "html" })) as Uint8Array);
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("Hi"));
});
