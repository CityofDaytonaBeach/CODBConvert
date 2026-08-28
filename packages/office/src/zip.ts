/**
 * Minimal ZIP archive reader. Office files (DOCX/XLSX/PPTX) are ZIP packages.
 *
 * Uses native raw-deflate inflate:
 *  - Browser: DecompressionStream("deflate-raw")
 *  - Node:    node:zlib.inflateRawSync
 */

export interface ZipEntry {
  name: string;
  /** True if this entry is a directory marker. */
  isDirectory: boolean;
  data: Uint8Array;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIR_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIR = 0x06054b50;

export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (bytes.length < 4) throw new Error("Not a zip file.");
  if (new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) !== LOCAL_FILE_HEADER) {
    throw new Error("Not a zip file (bad signature).");
  }
  const isNode = typeof process !== "undefined" && !!process.versions?.node;

  let inflateRaw: (data: Uint8Array) => Promise<Uint8Array>;
  if (isNode) {
    const zlib = await import("node:zlib");
    inflateRaw = (data) => Promise.resolve(zlib.inflateRawSync(data));
  } else {
    inflateRaw = async (data) => {
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
      const buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    };
  }

  const entries: ZipEntry[] = [];
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Walk local file headers until we run out of valid ones.
  while (offset + 30 <= bytes.byteLength) {
    if (view.getUint32(offset, true) !== LOCAL_FILE_HEADER) break;

    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const uncompSize = view.getUint32(offset + 22, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);

    const nameBytes = bytes.subarray(offset + 30, offset + 30 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    const dataStart = offset + 30 + nameLen + extraLen;
    const isDirectory = name.endsWith("/") || uncompSize === 0 && (compSize === 0);

    if (!isDirectory && compSize > 0) {
      const comp = bytes.subarray(dataStart, dataStart + compSize);
      try {
        const data = method === 8 ? await inflateRaw(comp) : comp;
        entries.push({ name, isDirectory: false, data });
      } catch {
        // Skip entries we cannot inflate.
      }
    } else {
      entries.push({ name, isDirectory, data: new Uint8Array(0) });
    }

    offset = dataStart + compSize;
  }

  return entries;
}

/** Look up a single entry by exact path (case-insensitive per zip spec). */
export function getEntry(entries: ZipEntry[], path: string): Uint8Array | undefined {
  const target = path.replace(/\\/g, "/");
  const hit = entries.find((e) => e.name.replace(/\\/g, "/").toLowerCase() === target.toLowerCase());
  return hit?.data;
}
