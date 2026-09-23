/**
 * Capability model. CODBDocs decides at runtime which backend to use:
 *
 * LOCAL / WORKER / WEBGPU / WASM
 *
 * Detection is coarse and defensive: everything is gated so a missing
 * capability degrades gracefully to a fallback backend.
 */

export type Capability =
  | "pdf"
  | "image"
  | "office"
  | "media"
  | "ocr"
  | "webgpu"
  | "wasm"
  | "webcodecs"
  | "opfs"
  | "worker"
  | "canvas"
  | "streams";

export type ExecutionBackend =
  | "local"
  | "worker"
  | "webgpu"
  | "wasm";

export interface CapabilityReport {
  available: Record<Capability, boolean>;
  env: "browser" | "node" | "worker" | "unknown";
}

function isNode(): boolean {
  return typeof process !== "undefined" && !!process.versions?.node;
}

function isWorker(): boolean {
  return (
    typeof self !== "undefined" &&
    typeof window === "undefined" &&
    isNode() === false
  );
}

function hasCanvas(): boolean {
  if (isNode()) return false;
  return typeof document !== "undefined" && !!document.createElement("canvas");
}

/** Best-effort WebGPU detection. A real check requires an adapter request. */
function hasWebGPU(): boolean {
  if (isNode()) return false;
  const nav = (globalThis as unknown as { navigator?: { gpu?: unknown } }).navigator;
  const gpu = nav?.gpu ?? undefined;
  return !!gpu;
}

function hasWebCodecs(): boolean {
  if (isNode()) return false;
  return typeof (globalThis as Record<string, unknown>)["VideoEncoder"] === "function";
}

function hasWasm(): boolean {
  return typeof WebAssembly !== "undefined" && typeof WebAssembly.instantiate === "function";
}

function hasOpfs(): boolean {
  if (isNode() || isWorker()) return false;
  const nav = (globalThis as unknown as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator;
  return !!nav?.storage?.getDirectory;
}

function hasStreams(): boolean {
  return typeof ReadableStream !== "undefined";
}

/**
 * Synchronously produce a coarse capability report.
 *
 * WebGPU availability can be refined asynchronously with
 * `requestWebGpuAdapter` before dispatching GPU work.
 */
export function checkCapabilities(): CapabilityReport {
  const env = isNode() ? "node" : isWorker() ? "worker" : "browser";

  return {
    env,
    available: {
      pdf: true,
      image: true,
      office: true,
      media: false,
      ocr: false,
      webgpu: hasWebGPU(),
      wasm: hasWasm(),
      webcodecs: hasWebCodecs(),
      opfs: hasOpfs(),
      worker: typeof Worker !== "undefined",
      canvas: hasCanvas(),
      streams: hasStreams(),
    },
  };
}

/**
 * Async, more accurate WebGPU probe. Returns the adapter or null.
 */
export async function requestWebGpuAdapter(): Promise<unknown> {
  const has = checkCapabilities();
  if (!has.available.webgpu) return null;
  const nav = (globalThis as unknown as { navigator?: { gpu?: { requestAdapter: () => Promise<unknown> } } }).navigator;
  try {
    return await nav?.gpu?.requestAdapter() ?? null;
  } catch {
    return null;
  }
}
