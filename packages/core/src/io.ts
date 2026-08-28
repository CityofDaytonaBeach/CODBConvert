/** Utilities for normalizing CODBInput into a standard in-memory buffer. */

import type { CODBInput } from "./types";

export interface NormalizedInput {
  /** Owned Uint8Array copy of the data. */
  bytes: Uint8Array;
  /** MIME type if known. */
  type?: string;
  /** File/stream name if known. */
  name?: string;
  size: number;
}

export function looksLikeDataUrl(value: string): boolean {
  return /^data:/i.test(value);
}

export function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Resolve a CODBInput to its bytes. In Node, a plain path string is read from
 * disk; a data URL / http URL is decoded/fetched.
 */
export async function normalizeInput(input: CODBInput): Promise<NormalizedInput> {
  if (typeof input === "string") {
    if (looksLikeDataUrl(input)) {
      const m = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(input);
      if (!m) throw new Error("Invalid data URL.");
      const type = m[1] || undefined;
      const base64 = m[2] === ";base64";
      const data = base64 ? fromBase64(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
      return { bytes: data, type, size: data.byteLength };
    }
    if (looksLikeHttpUrl(input)) {
      const res = await fetch(input);
      const buf = new Uint8Array(await res.arrayBuffer());
      return { bytes: buf, type: res.headers.get("content-type") ?? undefined, size: buf.byteLength };
    }
    // Treat as a filesystem path (Node).
    const fs = await import("node:fs/promises");
    const buf = await fs.readFile(input);
    const u8 = new Uint8Array(buf);
    return { bytes: u8, name: input.split(/[\\/]/).pop(), size: u8.byteLength };
  }

  if (input instanceof Blob) {
    const buf = new Uint8Array(await input.arrayBuffer());
    const name = (input as File).name;
    return { bytes: buf, type: input.type || undefined, name, size: buf.byteLength };
  }

  if (input instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(input), size: input.byteLength };
  }

  if (ArrayBuffer.isView(input)) {
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return { bytes: bytes.slice(), size: bytes.byteLength };
  }

  if ("buffer" in input && input.buffer) {
    const bytes = new Uint8Array(input.buffer);
    return { bytes, type: input.type, name: input.name, size: bytes.byteLength };
  }

  if ("stream" in input && input.stream) {
    const chunks: Uint8Array[] = [];
    const reader = input.stream.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { bytes, type: input.type, name: input.name, size: total };
  }

  throw new Error("Unsupported input type.");
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Coarse input category used for "anything → X" routing. */
export type CODBInputCategory = "pdf" | "image" | "office" | "text" | "unknown";

export function categoryFromType(type?: string): CODBInputCategory | undefined {
  if (!type) return undefined;
  const t = type.toLowerCase();
  if (t === "application/pdf") return "pdf";
  if (t === "text/plain" || t === "text/html") return "text";
  if (t.startsWith("image/")) return "image";
  const office = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/zip",
  ];
  if (office.includes(t)) return "office";
  return undefined;
}

export function categoryFromName(name?: string): CODBInputCategory | undefined {
  if (!name) return undefined;
  const ext = name.toLowerCase().split(".").pop() || "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "svg"].includes(ext)) return "image";
  if (["docx", "xlsx", "pptx"].includes(ext)) return "office";
  if (["txt", "md", "text", "html", "htm"].includes(ext)) return "text";
  return undefined;
}

/** Sniff MIME type from leading magic bytes. */
export function sniffType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
    return "application/pdf";
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)
    return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b)
    return "application/zip"; // zip-based office files
  return undefined;
}

/** Best-effort coarse category for "anything → X" routing. */
export function sniffCategory(
  bytes: Uint8Array,
  type?: string,
  name?: string,
): CODBInputCategory {
  const fromType = categoryFromType(type);
  if (fromType) return fromType;
  const fromName = categoryFromName(name);
  if (name && fromName) return fromName;
  const t = sniffType(bytes);
  if (t === "application/pdf") return "pdf";
  if (t === "application/zip") return "office";
  if (t?.startsWith("image/")) return "image";
  // No magic => heuristic: mostly-printable text.
  const head = bytes.slice(0, Math.min(4096, bytes.byteLength));
  if (head.byteLength > 0) {
    let printable = 0;
    for (let i = 0; i < head.byteLength; i++) {
      const b = head[i];
      if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
    }
    if (printable / head.byteLength > 0.9) return "text";
  }
  return "unknown";
}
