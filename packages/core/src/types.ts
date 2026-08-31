/**
 * Input/output file primitives. start.md explicitly says: do NOT use base64
 * as an internal storage format. Prefer Blob / ArrayBuffer / Uint8Array /
 * ReadableStream / (OPFS in browser).
 */

import type { ExecutionBackend } from "./capabilities";

export type CODBInput =
  | Blob
  | File
  | ArrayBuffer
  | ArrayBufferView
  | string /** URL | path | data URL */
  | { buffer: ArrayBuffer; type?: string; name?: string }
  | { stream: ReadableStream<Uint8Array>; type?: string; name?: string };

export type CODBOutput = Blob | Uint8Array | ArrayBuffer;

export type CODBInputFormat =
  | "pdf"
  | "jpg"
  | "jpeg"
  | "png"
  | "webp"
  | "gif"
  | "avif"
  | "heic"
  | "heif"
  | "bmp"
  | "svg"
  | "tiff"
  | "docx"
  | "xlsx"
  | "pptx"
  | "html"
  | "txt";

export type CODBOutputFormat =
  | "pdf"
  | "jpg"
  | "jpeg"
  | "png"
  | "webp"
  | "gif"
  | "avif"
  | "bmp"
  | "svg"
  | "tiff"
  | "base64"
  | "html"
  | "txt"
  | "json";

export interface CODBConvertOptions {
  /** Target output format (e.g. "pdf", "webp", "json"). */
  to: CODBOutputFormat;
  /** Hint the input format when it cannot be inferred. */
  from?: CODBInputFormat;
  /** Qualitative quality 0..1 (images). */
  quality?: number;
  /** Target width (images). */
  width?: number;
  /** Target height (images). */
  height?: number;
  /** Render scale for PDF -> images. */
  scale?: number;
  /** Output image format when rendering to an image (e.g. pdf.toImages). */
  format?: string;
  /** Enable OCR / searchable output (requires ocr capability). */
  searchable?: boolean;
  /** Enable accessibility metadata. */
  accessibility?: boolean;
  /** Enable optimization passes. */
  optimize?: boolean;
  /** Force a specific execution backend. */
  backend?: ExecutionBackend;
  /** Call converter callbacks with progress. */
  onProgress?: (p: ConversionProgress) => void;
}

export interface ConversionProgress {
  phase: string;
  percent: number;
  message?: string;
}

export interface CODBMergeOptions {
  output?: CODBOutputFormat;
  onProgress?: (p: ConversionProgress) => void;
}
