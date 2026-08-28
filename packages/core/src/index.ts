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
import { sniffType, type NormalizedInput } from "./io";
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
export { normalizeInput, sniffType, type NormalizedInput } from "./io";
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
   * Universal single-call converter:
   *
   * await codb.convert(file, { to: "pdf", searchable: true });
   */
  async convert(input: CODBInput, options: CODBConvertOptions): Promise<CODBOutput> {
    const to = options.to;
    const category = categoryForOutput(to);
    return this.run({ category, op: "convert" }, input, options);
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
      options: { format?: "png" | "webp" | "jpeg"; scale?: number } & Partial<CODBConvertOptions> = {},
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
      options: { format: "png" | "webp" | "jpeg" | "avif" | "bmp" } & Partial<CODBConvertOptions>,
    ): Promise<CODBOutput> =>
      this.run({ category: "image", op: "convert" }, input, {
        to: options.format,
        ...options,
      }),
  };
}

/** Map an output format to the converter category that owns it. */
function categoryForOutput(to: CODBOutputFormat): string {
  switch (to) {
    case "pdf":
      return "pdf";
    case "jpg":
    case "jpeg":
    case "png":
    case "webp":
    case "avif":
    case "gif":
    case "bmp":
    case "svg":
      return "image";
    case "html":
      return "office";
    case "txt":
    case "json":
      return "core";
    default:
      return "core";
  }
}

/** Infer the source category from format hint, name, or magic bytes. */
export async function inferCategory(input: CODBInput, hint?: CODBInputFormat): Promise<string> {
  if (hint) {
    if (hint === "pdf" || hint === "html") return "pdf";
    if (["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg"].includes(hint)) return "image";
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
