# CODBConvert

A browser-first document & media conversion runtime, built as a monorepo of
TypeScript packages. Everything follows the architecture in [`start.md`](./start.md):
a single universal [CODB Document Model](packages/core/src/model.ts) plus a
capability dispatcher that chooses **LOCAL / WORKER / WEBGPU / WASM** backends.
Conversion never falls back to an upload or remote processing server.

## Packages

| Package | Purpose |
| --- | --- |
| [`@codb/core`](packages/core) | Universal conversion API (`CODBDocs`), BinaryFlow queue, CODB Document Model, capability detection, converter registry, and binary input handling. |
| [`@codb/pdf`](packages/pdf) | PDF engine: merge, split, page selection (pdf-lib); render-to-images & text extraction (pdfjs-dist). |
| [`@codb/image`](packages/image) | Image format conversion + resize via Canvas. |
| [`@codb/office`](packages/office) | Custom ZIP reader + DOCX/XLSX/PPTX → CODB Document Model; JSON/HTML renderers. |
| [`@codb/react`](packages/react) | Vite + React demo app wiring all converters into a drag-and-drop UI. |

## Universal API

Install only the engines you need:

```bash
npm install @codb/core @codb/pdf @codb/image @codb/office
```

Use the same SDK from React, Next.js, plain browser JavaScript, or Node/serverless
functions. Registering a package makes its converters available to the universal
dispatcher.

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

## BinaryFlow large-file jobs

`convertJob()` stages files as binary chunks, preferably in the browser's
Origin Private File System. Jobs expose an async progress stream, cancellation,
lightweight output verification, and resumable staging after interruption.
Base64 is never used internally.

```ts
const job = codb.convertJob(file, {
  to: "pdf",
  storage: "auto",
  checkpoint: true,
  chunkSize: 4 * 1024 * 1024,
  memoryBudgetMB: 256,
});

for await (const event of job.events) {
  console.log(event.phase, event.percent, event.processedBytes);
}

const output = await job.result();
console.log(job.verification);
```

If a job is interrupted, pass its `job.id` back as `jobId` with the same input
and options to reuse completed chunks. Current PDF and Office engines still
materialize their final parser input; BinaryFlow establishes the streaming and
checkpointing runtime that format-specific incremental parsers can adopt next.

Plain strings are treated as filesystem paths in Node. To convert raw text
content, pass bytes or a `Blob` with `type: "text/plain"`:

```ts
const textBytes = new TextEncoder().encode("Hello CODBConvert");
const pdfFromText = await codb.convert(textBytes, { to: "pdf" });
```

## React / Next.js

Browser apps can use the same imports. Some heavy Node-only rendering paths use
`@napi-rs/canvas` behind runtime guards, so app bundlers should not try to bundle
native `.node` files into client code. The Vite demo externalizes
`@napi-rs/canvas` in [`packages/react/vite.config.ts`](packages/react/vite.config.ts).

For Next.js, import converters in client components only for browser-supported
conversions, and run Node/serverless conversions from route handlers or server
actions.

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
- `@codb/image`, text-to-image, and PDF-to-image are local in Node via
  `@napi-rs/canvas`, and local in browsers through canvas APIs where supported.
- PDF.js worker/static handling is wired by the Vite demo.

## Publishing

Public packages publish to npmjs.com from GitHub Actions when a version tag is
pushed, for example `v0.1.0`. The workflow expects an `NPM_TOKEN` repository
secret with publish access.
