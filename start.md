Yes. You could build a browser-first React document/media conversion library that replaces a surprisingly large portion of what you currently use LibreOffice and FFmpeg for.

The important distinction is that WebGPU is not itself a PDF/Office/media converter. It is the accelerator. The bigger breakthrough comes from combining WebAssembly + Web Workers + WebGPU + OPFS/Streams so the browser becomes a fairly serious local processing environment. Humans somehow turned the browser into an operating system while still calling it a browser.

What could run entirely in-browser
Operation	Browser-only?	Best technology
Merge PDFs	✅ Excellent	WASM / pdf-lib / custom PDF engine
Split PDFs	✅ Excellent	WASM
Reorder/delete pages	✅	WASM
Rotate/crop pages	✅	WASM
Images → PDF	✅	Canvas/WebCodecs + PDF
PDF → images	✅	PDF.js / WASM
JPG ↔ PNG ↔ WebP	✅	Canvas / WebCodecs
AVIF conversions	✅	WebCodecs/WASM
Resize/compress images	✅	WebGPU + WebCodecs
OCR	✅	WASM/WebGPU models
PDF text extraction	✅	PDF.js
PDF images extraction	✅	PDF.js/custom parser
PDF page rendering	✅	PDF.js
DOCX → PDF	⚠️ Possible	custom DOCX renderer
XLSX → PDF	⚠️ Possible	custom spreadsheet renderer
PPTX → PDF	⚠️ Hard	custom OOXML renderer
HTML → PDF	✅	browser rendering + PDF engine
Video/audio conversion	✅/⚠️	WebCodecs + WASM
FFmpeg-like filters	✅	WebCodecs/WebGPU
Arbitrary legacy Office files	❌/⚠️	server fallback

So I would not try to literally port LibreOffice and FFmpeg into the browser.

I would build a new browser-native conversion engine.

Architecture I'd use
React Application
       │
       ▼
┌─────────────────────────────┐
│      Conversion API         │
│                             │
│ convert()                   │
│ merge()                     │
│ split()                     │
│ compress()                  │
│ extract()                   │
│ render()                    │
│ analyze()                   │
└──────────────┬──────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
 Web Worker Pool     GPU Worker
       │                │
       ▼                ▼
     WASM             WebGPU
       │                │
 ┌─────┴──────┐    ┌────┴──────┐
 │ PDF Engine │    │ Image Ops │
 │ ZIP/OOXML  │    │ OCR/AI    │
 │ Codecs     │    │ Filters   │
 └─────┬──────┘    └───────────┘
       │
       ▼
 WebCodecs / Canvas
       │
       ▼
 OPFS / Streams / Blob
1. Create your own universal API

The React application shouldn't care which underlying engine performs something.

For example:

const result = await codb.convert({
  input: file,
  output: "pdf"
});

Or:

const pdf = await codb.pdf.merge([
  file1,
  file2,
  file3
]);

Images:

const image = await codb.image.convert(file, {
  format: "webp",
  quality: 0.85,
  width: 1920
});

PDF pages:

const pages = await codb.pdf.toImages(file, {
  format: "webp",
  scale: 2
});

And eventually:

await codb.convert({
  input: file,
  output: "pdf",
  searchable: true,
  accessibility: true,
  optimize: true
});

That last API becomes considerably more interesting than merely cloning LibreOffice.

The browser engine

I'd divide your library into modules:

@codb/core
@codb/pdf
@codb/image
@codb/office
@codb/media
@codb/ocr
@codb/ai
@codb/accessibility
@codb/react

Then developers could do:

import { CODBDocs } from "@codb/core";

const docs = new CODBDocs();

const result = await docs.convert(file, {
  to: "pdf"
});

Or CDN:

<script type="module">
import { CODBDocs } from
  "https://cdn.jsdelivr.net/gh/CityofDaytonaBeach/codbdocs@main/packages/core/dist/codbdocs.js";
</script>

That fits extremely well with the library you've already been developing.

WebGPU's role

This is where I would not waste WebGPU on operations that CPUs already perform efficiently.

Merging PDFs doesn't really need a GPU.

Use WebGPU for computationally expensive parallel operations such as:

image resizing
image enhancement
denoising
deskewing
thresholding
background removal
OCR preprocessing
document classification
vision embeddings
image embeddings
page similarity
AI inference
compression analysis

A processing pipeline could become:

PDF
 ↓
PDF.js parser
 ↓
page objects
 ↓
text extraction ──────────────┐
 ↓                            │
image extraction              │
 ↓                            │
WebGPU preprocessing          │
 ↓                            │
OCR                           │
 ↓                            │
layout detection              │
 ↓                            │
embeddings                    │
 ↓                            │
semantic document model ◀─────┘

Now your library isn't simply a converter.

It becomes a document understanding runtime.

Replace FFmpeg differently

For browser media, I'd use:

WebCodecs
   +
WebGPU
   +
WASM codecs

rather than loading a gigantic FFmpeg WASM build for everything.

For example:

MP4
 ↓
demux
 ↓
VideoDecoder
 ↓
VideoFrame
 ↓
WebGPU processing
 ↓
VideoEncoder
 ↓
mux
 ↓
WebM / MP4

Modern browsers expose hardware acceleration through WebCodecs where available.

That can be dramatically better than:

React
 ↓
download ffmpeg.wasm
 ↓
allocate enormous WASM memory
 ↓
browser begins questioning its career choices

FFmpeg WASM could remain your compatibility fallback.

LibreOffice is the harder replacement

PDF and image processing are relatively straightforward.

Office rendering is the monster.

DOCX, XLSX and PPTX are ZIP packages containing XML, relationships, media, fonts, styles and other objects.

For example:

document.docx
    ↓
ZIP reader
    ↓
word/
 ├ document.xml
 ├ styles.xml
 ├ numbering.xml
 ├ settings.xml
 ├ media/
 └ _rels/

You can parse this entirely in JavaScript/WASM.

Then create your own intermediate representation:

interface DocumentNode {
  type:
    | "paragraph"
    | "text"
    | "image"
    | "table"
    | "heading"
    | "list"
    | "pageBreak";

  style?: Style;
  children?: DocumentNode[];
}

The key architectural decision is:

DOCX ───┐
XLSX ───┤
PPTX ───┤
HTML ───┼──> CODB Document Model
PDF ────┤             │
Images ─┘             │
                      ▼
              Rendering Engine
               /      |      \
             PDF     HTML    Images

That intermediate document model is what would make this project powerful.

Instead of implementing:

DOCX → PDF
DOCX → PNG
DOCX → HTML

XLSX → PDF
XLSX → PNG
XLSX → HTML

PPTX → PDF
PPTX → PNG
PPTX → HTML

you implement:

INPUT
 ↓
CODB Document Model
 ↓
OUTPUT

Suddenly dozens of conversion combinations become possible without writing dozens of converters.

And then your RAG work becomes part of it

This is where your existing direction gets particularly interesting.

The internal representation could contain:

{
  page: 12,

  text: "...",

  blocks: [...],

  images: [
    {
      bbox: [x, y, w, h],

      description:
        "Diagram showing proposed drainage system",

      embedding: [...]
    }
  ],

  tables: [...],

  links: [...],

  headings: [...],

  embedding: [...]
}

Then conversion automatically produces an AI-ready representation:

PDF
 ├ original.pdf
 ├ document.json
 ├ document.html
 ├ pages/
 │   ├ 001.webp
 │   ├ 002.webp
 │   └ ...
 ├ images/
 │   └ ...
 ├ chunks/
 │   └ ...
 └ embeddings/
     └ ...

That would be substantially more useful than merely converting a file.

One thing I would change from the base64 approach

Don't make base64 your internal storage format.

Use:

Blob
ArrayBuffer
Uint8Array
ReadableStream
OPFS

Use base64 only at an API boundary when necessary.

A 100 MB file represented as base64 becomes roughly 133 MB before JavaScript/runtime overhead. Copy that a few times and your innocent PDF utility has transformed into a RAM benchmark.

For large documents:

File
 ↓
ReadableStream
 ↓
Worker
 ↓
incremental processing
 ↓
OPFS temporary storage
 ↓
output stream

This would allow you to process much larger files without loading everything into React's main thread.

The hybrid approach would be strongest

I'd make the engine automatically choose:

                 File
                   │
             Capability Check
              /           \
             /             \
     Browser supported     Unsupported
           │                   │
       Local engine        VPS endpoint
           │                   │
       WASM/WebGPU       LibreOffice/
       WebCodecs          FFmpeg/etc.
             \              /
              \            /
               Same Result API

Developers still write:

await codb.convert(file, {
  to: "pdf"
});

CODBDocs determines whether it should execute:

LOCAL
WORKER
WEBGPU
WASM
SERVER

automatically.

That gives you something more practical than declaring war on LibreOffice on day one.

The bigger opportunity

I'd actually target this:

CODBDocs Browser Document Runtime

PDF processing
+
Office conversion
+
image processing
+
media conversion
+
OCR
+
accessibility
+
document understanding
+
embeddings
+
RAG chunk generation
+
WebGPU inference

And make it work from:

React
Vanilla JS
Lovable
Vite
Next.js
CDN <script>
Web Workers
Node where applicable

That could turn the work you're already doing into a genuine browser-side document platform rather than another wrapper around server utilities. The particularly valuable part isn't "LibreOffice in JavaScript." It's having one universal document representation and pipeline that can convert, understand, index, and render a document locally.
