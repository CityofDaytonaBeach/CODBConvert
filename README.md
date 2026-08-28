# CODBConvert

A browser-first document & media conversion runtime, built as a monorepo of
TypeScript packages. Everything follows the architecture in [`start.md`](./start.md):
a single universal [CODB Document Model](packages/core/src/model.ts) plus a
capability dispatcher that chooses **LOCAL / WORKER / WEBGPU / WASM / SERVER**
backends automatically.

## Packages

| Package | Purpose |
| --- | --- |
| [`@codb/core`](packages/core) | Universal conversion API (`CODBDocs`), CODB Document Model, capability detection, converter registry, input normalization (Blob/ArrayBuffer/Uint8Array/stream/path). |
| [`@codb/pdf`](packages/pdf) | PDF engine: merge, split, page selection (pdf-lib); render-to-images & text extraction (pdfjs-dist). |
| [`@codb/image`](packages/image) | Image format conversion + resize via Canvas. |
| [`@codb/office`](packages/office) | Custom ZIP reader + DOCX/XLSX/PPTX → CODB Document Model; JSON/HTML renderers. |
| [`@codb/react`](packages/react) | Vite + React demo app wiring all converters into a drag-and-drop UI. |

## Universal API

```ts
import { CODBDocs, checkCapabilities } from "@codb/core";
import { register as registerPdf } from "@codb/pdf";
import { register as registerImage } from "@codb/image";
import { register as registerOffice } from "@codb/office";

registerPdf(); registerImage(); registerOffice();

const codb = new CODBDocs(checkCapabilities());

const pdf      = await codb.convert(file, { to: "pdf" });
const pages    = await codb.pdf.toImages(file, { format: "webp", scale: 2 });
const merged   = await codb.pdf.merge([f1, f2, f3]);
const image    = await codb.image.convert(file, { format: "webp", quality: 0.85, width: 1920 });
const docModel = await codb.convert(docx, { to: "json" });   // CODB Document Model
```

The CODB Document Model is the intermediate representation start.md proposes:
every input parses into `CODBDocument { pages, images, tables, links, headings, metadata }`
so one parser feeds many renderers, and conversion naturally produces an
AI/RAG-ready representation.

## Requirements

- Node.js 20+ (the toolchain used here is a portable Node 24 with bundled npm).
- The sandbox clock uses a portable Node at `C:\Users\AV\.codb-tools\node-v24.19.0-win-x64` —
  add it to `PATH` if `node`/`npm` aren't globally available.

## Commands

```bash
npm install          # install workspace deps (approve esbuild/vite scripts)
npm run build        # build all library packages (+ react demo)
npm test             # run unit/integration tests across workspaces
npm run typecheck    # strict typecheck across all workspaces
npm run dev          # start the Vite React demo
```

### Tests

- `@codb/core` — capabilities, magic-byte sniffing, input normalization, model.
- `@codb/pdf` — merge, split (real PDFs generated with pdf-lib).
- `@codb/office` — minimal DOCX built in-flight, parsed into the model / HTML.

## Notes

- stdin/base64 is only used at API boundaries; internal storage uses
  `Blob` / `ArrayBuffer` / `Uint8Array` / `ReadableStream` per start.md.
- `@codb/image` needs a browser canvas (or a canvas polyfill in Node); Node-only
  callers should register a WASM/server image backend via the capability dispatch.
- PDF.js worker is served as a static asset by Vite in the demo.
