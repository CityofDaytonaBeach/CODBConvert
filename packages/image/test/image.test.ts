import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { CODBDocs } from "@codb/core";
import { register as registerImage } from "@codb/image";

registerImage();

async function makePng(width = 64, height = 48, color = "rgb(200,30,30)"): Promise<Uint8Array> {
  const c = createCanvas(width, height);
  const g = c.getContext("2d");
  g.fillStyle = color;
  g.fillRect(0, 0, width, height);
  return new Uint8Array(c.toBuffer("image/png"));
}

function magic(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "webp";
  return "unknown";
}

test("image convert PNG -> WebP", async () => {
  const src = await makePng();
  const codb = new CODBDocs();
  const out = (await codb.image.convert(src, { format: "webp", quality: 0.9 })) as Uint8Array;
  assert.equal(magic(out), "webp");
});

test("image convert PNG -> JPEG", async () => {
  const src = await makePng();
  const codb = new CODBDocs();
  const out = (await codb.image.convert(src, { format: "jpeg", quality: 0.85 })) as Uint8Array;
  assert.equal(magic(out), "jpg");
});

test("image resize downscales and preserves aspect ratio", async () => {
  const src = await makePng(200, 100);
  const codb = new CODBDocs();
  const out = (await codb.image.convert(src, { format: "png", width: 50 })) as Uint8Array;
  assert.equal(magic(out), "png");

  const img = await loadImage(out as unknown as Buffer);
  assert.equal(img.width, 50);
  assert.equal(img.height, 25);
});

test("image -> PDF (universal convert), starts with %PDF", async () => {
  const src = await makePng();
  const codb = new CODBDocs();
  const out = (await codb.convert(src, { to: "pdf" })) as Uint8Array;
  assert.ok(out.length > 4);
  assert.equal(String.fromCharCode(out[0], out[1], out[2], out[3]), "%PDF");
});
