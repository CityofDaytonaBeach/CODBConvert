import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCapabilities } from "@codb/core";
import { normalizeInput, sniffType } from "@codb/core";
import { createDocument, documentToText } from "@codb/core";

test("capabilities report is well formed", () => {
  const r = checkCapabilities();
  assert.ok(r.env === "node" || r.env === "browser" || r.env === "worker");
  assert.equal(typeof r.available.pdf, "boolean");
  for (const c of ["image", "office", "media"] as const) {
    assert.equal(typeof r.available[c], "boolean");
  }
});

test("sniffType detects PNG magic bytes", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(sniffType(png), "image/png");
});

test("normalizeInput handles a Blob", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const n = await normalizeInput(blob);
  assert.deepEqual([...n.bytes], [1, 2, 3]);
  assert.equal(n.type, "image/png");
});

test("document model text extraction", () => {
  const doc = createDocument({
    pages: [
      {
        page: 1,
        blocks: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
          { type: "link", link: { text: "click", href: "https://x" } },
        ],
      },
    ],
  });
  assert.equal(documentToText(doc), "hello\nworld\nclick");
});
