/**
 * CODBDocs — the universal conversion API.
 *
 * const codb = new CODBDocs();
 * const pdf = await codb.convert(file, { to: "pdf" });
 * const pages = await codb.pdf.toImages(file, { format: "webp", scale: 2 });
 * const merged = await codb.pdf.merge([f1, f2, f3]);
 * const img = await codb.image.convert(file, { format: "webp", quality: 0.85, width: 1920 });
 *
 * Backends (LOCAL / WORKER / WEBGPU / WASM / SERVER) are chosen automatically
 * unless overridden via `options.backend`.
 */

import { checkCapabilities, type CapabilityReport, type ExecutionBackend } from "./capabilities";
import { sniffType, sniffCategory, normalizeInput, type NormalizedInput, type CODBInputCategory } from "./io";
import { registry, type ConversionContext, type ConverterKey } from "./registry";
import type {
  CODBConvertOptions,
  CODBInput,
  CODBInputFormat,
  CODBMergeOptions,
  CODBOutput,
  CODBOutputFormat,
  ConversionProgress,
} from "./types";

export type { CODBConvertOptions, CODBOutput, CODBOutputFormat, CODBInput, CODBInputFormat };

export {
  registry,
  ConverterRegistry,
  type ConverterRegistration,
  type ConverterFn,
  type ConversionContext,
  type ConverterKey,
} from "./registry";
export {
  normalizeInput,
  sniffType,
  sniffCategory,
  type NormalizedInput,
  type CODBInputCategory,
} from "./io";
export {
  checkCapabilities,
  requestWebGpuAdapter,
  type CapabilityReport,
  type Capability,
  type ExecutionBackend,
} from "./capabilities";

// CODB Document Model
export {
  createDocument,
  documentToText,
  type CODBDocument,
  type CODBPage,
  type CODBNodeType,
  type CODBContentBlock,
  type CODBImage,
  type CODBLink,
  type CODBNodeType as NodeType,
  type TextStyle,
  type BoundingBox,
} from "./model";

export class CODBDocs {
  readonly report: CapabilityReport;
  private usedBackend: ExecutionBackend = "local";

  constructor(report: CapabilityReport = checkCapabilities()) {
    this.report = report;
  }

  private pickBackend(preferred?: ExecutionBackend): ExecutionBackend {
    if (preferred) return preferred;
    return "local";
  }

  private context(options: CODBConvertOptions, backend: ExecutionBackend): ConversionContext {
    return {
      report: this.report,
      backend,
      options,
      progress: (message, percent) => options.onProgress?.({
        phase: message,
        percent,
        message,
      } as ConversionProgress),
    };
  }

  private async run(key: ConverterKey, input: CODBInput | CODBInput[], options: CODBConvertOptions): Promise<CODBOutput> {
    const impls = registry.get(key);
    if (impls.length === 0) {
      throw new Error(`No converter registered for ${key.category}.${key.op}. Did you import the matching @codb package?`);
    }
    const backend = this.pickBackend(options.backend);
    this.usedBackend = backend;
    const impl =
      impls.find((i) => i.backends.includes(backend)) ??
      impls.find((i) => i.backends.includes("local")) ??
      impls[0];
    return impl.run(input, options, this.context(options, backend));
  }

  /** The backend actually used by the most recent call. */
  get lastBackend(): ExecutionBackend {
    return this.usedBackend;
  }

  /**
   * Universal single-call converter — anything → anything, entirely offline.
   *
   * const pdf = await codb.convert(file, { to: "pdf" });
   * const img = await codb.convert(docx, { to: "png" });
   * const txt = await codb.convert(pdf, { to: "txt" });
   *
   * Dispatches by BOTH input category (sniffed from bytes) and target format,
   * so cross-domain conversions (office → pdf, text → image, etc.) resolve to
   * the right registered converter.
   */
  async convert(input: CODBInput, options: CODBConvertOptions): Promise<CODBOutput> {
    const to = options.to;
    // PDF target: route by source category.
    if (to === "pdf") {
      const src = await this.sourceCategory(input);
      if (src === "pdf") return this.run({ category: "pdf", op: "pdf" }, input, options);
      if (src === "image" || src === "office" || src === "text") {
        return this.run({ category: src, op: "pdf" }, input, options);
      }
      throw new Error(`Cannot convert unknown input to PDF. Hint: pass a supported input.`);
    }

    // Image target.
    if (isImageOutput(to)) {
      const src = await this.sourceCategory(input);
      if (src === "image") return this.run({ category: "image", op: "convert" }, input, { ...options, to: to as CODBOutputFormat });
      if (src === "pdf") {
        return this.run({ category: "pdf", op: "toImages" }, input, { ...options, format: imageFormat(to), to: "pdf" });
      }
      if (src === "office" || src === "text") {
        return this.run({ category: src, op: "toImage" }, input, { ...options, to });
      }
      throw new Error(`Cannot convert unknown input to image. Hint: pass a supported input.`);
    }

    // Text/structured targets (json/html/txt).
    const src = await this.sourceCategory(input);
    if (src === "pdf") {
      if (to === "txt" || to === "html" || to === "json") {
        return this.run({ category: "pdf", op: to }, input, options);
      }
      throw new Error(`PDF cannot convert to "${to}".`);
    }
    if (src === "office") {
      return this.run({ category: "core", op: "convert" }, input, options);
    }
    if (src === "text") {
      return this.run({ category: "text", op: "convert" }, input, options);
    }
    if (src === "image") {
      throw new Error(`Image cannot convert to "${to}". Use to: png/jpeg/webp.`);
    }
    throw new Error(`Unsupported conversion to "${to}".`);
  }

  /** Resolve the coarse input category (pdf/image/office/text/unknown). */
  private async sourceCategory(input: CODBInput): Promise<CODBInputCategory> {
    const norm = await normalizeInput(input);
    return sniffCategory(norm.bytes, norm.type, norm.name);
  }

  /** Parse any input into the CODB Document Model (as JSON bytes). */
  async analyze(input: CODBInput, options: Partial<CODBConvertOptions> = {}): Promise<CODBOutput> {
    return this.run({ category: "core", op: "analyze" }, input, {
      to: "json",
      ...options,
    });
  }

  /** Extract raw text (PDF.js) from a PDF. */
  async extractText(input: CODBInput, options: Partial<CODBConvertOptions> = {}): Promise<string> {
    const bytes = (await this.run({ category: "pdf", op: "extractText" }, input, { to: "txt", ...options })) as Uint8Array;
    return new TextDecoder().decode(bytes);
  }

  readonly pdf = {
    merge: (
      inputs: CODBInput[],
      options: CODBMergeOptions = {},
    ): Promise<CODBOutput> => this.run({ category: "pdf", op: "merge" }, inputs, {
      to: "pdf",
      ...options,
    }),
    split: (input: CODBInput, options: CODBMergeOptions = {}): Promise<CODBOutput> =>
      this.run({ category: "pdf", op: "split" }, input, { to: "pdf", ...options }),
    toImages: (
      input: CODBInput,
      options: { format?: "png" | "webp" | "jpeg" | "bmp" | "gif" | "svg" | "tiff"; scale?: number } & Partial<CODBConvertOptions> = {},
    ): Promise<CODBOutput> =>
      this.run({ category: "pdf", op: "toImages" }, input, {
        to: (options.format ?? "webp") as CODBOutputFormat,
        scale: options.scale,
        ...options,
      }),
  };

  readonly image = {
    convert: (
      input: CODBInput,
      options: { format: "png" | "webp" | "jpeg" | "avif" | "bmp" | "gif" | "svg" | "tiff" } & Partial<CODBConvertOptions>,
    ): Promise<CODBOutput> =>
      this.run({ category: "image", op: "convert" }, input, {
        to: options.format,
        ...options,
      }),
  };

  /**
   * Convert anything and return the result as a base64 string.
   * Pass the inner target format via {@link options.to} (e.g. { to: "png" }).
   */
  async toBase64(input: CODBInput, options: Omit<CODBConvertOptions, "to"> & { to: Exclude<CODBOutputFormat, "base64"> }): Promise<string> {
    const inner = { ...options, to: options.to };
    const raw = await this.convert(input, inner);
    return bytesToBase64(await toBytes(raw));
  }
}

/** Convert any CODBOutput to a Uint8Array. */
export async function toBytes(output: CODBOutput): Promise<Uint8Array> {
  if (output instanceof Uint8Array) return output;
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (output instanceof Blob) return new Uint8Array(await output.arrayBuffer());
  throw new Error("Unsupported output type.");
}

/** Encode raw bytes to a base64 string (no data: prefix). */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    return btoa(bin);
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return buf.toString("base64");
}

/** Decode a base64 string (with or without data: URL prefix) to raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]*;base64,/, "").replace(/\s+/g, "");
  if (typeof atob === "function") {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return Uint8Array.from(Buffer.from(clean, "base64"));
}

/** Is the target an image output format? */
function isImageOutput(to: CODBOutputFormat): boolean {
  return ["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp", "svg", "tiff"].includes(to);
}

function imageFormat(to: CODBOutputFormat): string {
  if (to === "jpeg") return "jpg";
  return to;
}

/** Infer the source category from format hint, name, or magic bytes. */
export async function inferCategory(input: CODBInput, hint?: CODBInputFormat): Promise<string> {
  if (hint) {
    if (hint === "pdf" || hint === "html") return "pdf";
    if (["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif", "bmp", "svg", "tiff", "tif"].includes(hint)) return "image";
    if (["docx", "xlsx", "pptx"].includes(hint)) return "office";
    return "core";
  }
  // sniff bytes
  const norm: NormalizedInput = await import("./io").then((m) => m.normalizeInput(input));
  const type = norm.type ?? sniffType(norm.bytes);
  if (!type) return "core";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type === "application/zip") return "office";
  return "core";
}
