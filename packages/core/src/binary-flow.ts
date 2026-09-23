import { normalizeInput } from "./io";
import type { CODBConvertOptions, CODBInput, CODBOutput } from "./types";

export type BinaryFlowStorage = "auto" | "memory" | "opfs";
export type BinaryFlowJobState =
  | "queued"
  | "staging"
  | "converting"
  | "verifying"
  | "completed"
  | "cancelled"
  | "failed";

export interface BinaryFlowOptions extends CODBConvertOptions {
  /** Binary chunk size. Defaults to 4 MiB. */
  chunkSize?: number;
  /** Maximum number of staging tasks running together. */
  concurrency?: number;
  /** Scheduler working-memory ceiling. Defaults to 256 MiB. */
  memoryBudgetMB?: number;
  /** Prefer OPFS, force OPFS, or keep chunks in memory. */
  storage?: BinaryFlowStorage;
  /** Preserve staged chunks after an interrupted job so its id can resume. */
  checkpoint?: boolean;
  /** Reuse this id to resume a compatible interrupted job. */
  jobId?: string;
  /** Run lightweight output signature checks. Defaults to true. */
  verify?: boolean;
}

export interface BinaryFlowEvent {
  type: "state" | "progress" | "chunk" | "verification" | "warning";
  jobId: string;
  state: BinaryFlowJobState;
  phase: string;
  percent: number;
  message?: string;
  processedBytes?: number;
  totalBytes?: number;
  chunkIndex?: number;
}

export interface ConversionVerification {
  passed: boolean;
  outputBytes: number;
  format: string;
  checks: Array<{ name: string; passed: boolean; message: string }>;
}

export interface BinaryFlowTaskContext {
  signal: AbortSignal;
  results: ReadonlyMap<string, unknown>;
}

export interface BinaryFlowTask<T = unknown> {
  id: string;
  dependencies?: string[];
  priority?: number;
  memoryCost?: number;
  run(context: BinaryFlowTaskContext): Promise<T> | T;
}

export interface BinaryFlowQueueOptions {
  concurrency?: number;
  memoryBudgetBytes?: number;
}

/** Dependency-aware, memory-budgeted task scheduler used by BinaryFlow jobs. */
export class BinaryFlowQueue {
  private readonly tasks = new Map<string, BinaryFlowTask>();
  private readonly concurrency: number;
  private readonly memoryBudgetBytes: number;

  constructor(options: BinaryFlowQueueOptions = {}) {
    this.concurrency = positiveInteger(options.concurrency ?? defaultConcurrency(), "concurrency");
    this.memoryBudgetBytes = positiveInteger(
      options.memoryBudgetBytes ?? 256 * 1024 * 1024,
      "memoryBudgetBytes",
    );
  }

  add<T>(task: BinaryFlowTask<T>): this {
    if (!task.id) throw new Error("BinaryFlow task id cannot be empty.");
    if (this.tasks.has(task.id)) throw new Error(`Duplicate BinaryFlow task id: ${task.id}`);
    this.tasks.set(task.id, task);
    return this;
  }

  async run(signal?: AbortSignal): Promise<Map<string, unknown>> {
    const controller = new AbortController();
    const unlink = linkAbortSignal(signal, controller);
    const pending = new Set(this.tasks.keys());
    const results = new Map<string, unknown>();
    const running = new Map<string, { memoryCost: number; promise: Promise<void> }>();
    let memoryInUse = 0;

    try {
      this.validateDependencies();

      while (pending.size > 0 || running.size > 0) {
        throwIfAborted(controller.signal);
        let started = false;
        const ready = [...pending]
          .map((id) => this.tasks.get(id)!)
          .filter((task) => (task.dependencies ?? []).every((id) => results.has(id)))
          .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));

        for (const task of ready) {
          if (running.size >= this.concurrency) break;
          const memoryCost = Math.max(0, task.memoryCost ?? 0);
          const fits = memoryInUse + memoryCost <= this.memoryBudgetBytes;
          if (!fits && running.size > 0) continue;

          pending.delete(task.id);
          memoryInUse += memoryCost;
          started = true;
          const promise = Promise.resolve()
            .then(() => task.run({ signal: controller.signal, results }))
            .then((value) => {
              results.set(task.id, value);
            })
            .catch((error) => {
              controller.abort(error);
              throw error;
            })
            .finally(() => {
              memoryInUse -= memoryCost;
              running.delete(task.id);
            });
          running.set(task.id, { memoryCost, promise });
        }

        if (running.size === 0) {
          if (pending.size === 0) break;
          const blocked = [...pending].join(", ");
          throw new Error(`BinaryFlow dependency cycle or blocked tasks: ${blocked}`);
        }

        if (!started || running.size >= this.concurrency || ready.length === 0) {
          await Promise.race([...running.values()].map((entry) => entry.promise));
        }
      }
      return results;
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      await Promise.allSettled([...running.values()].map((entry) => entry.promise));
      throw error;
    } finally {
      unlink();
    }
  }

  private validateDependencies(): void {
    for (const task of this.tasks.values()) {
      for (const dependency of task.dependencies ?? []) {
        if (!this.tasks.has(dependency)) {
          throw new Error(`BinaryFlow task "${task.id}" depends on missing task "${dependency}".`);
        }
      }
    }
  }
}

interface ChunkManifest {
  version: 1;
  source: SourceDescriptor;
  chunkSize: number;
  chunkCount: number;
  target: string;
}

interface SourceDescriptor {
  name?: string;
  type?: string;
  size: number;
  lastModified?: number;
  fingerprint?: string;
}

interface BinaryChunkStore {
  readonly kind: "memory" | "opfs";
  has(jobId: string, index: number): Promise<boolean>;
  put(jobId: string, index: number, bytes: Uint8Array): Promise<void>;
  get(jobId: string, index: number): Promise<BlobPart>;
  readManifest(jobId: string): Promise<ChunkManifest | undefined>;
  writeManifest(jobId: string, manifest: ChunkManifest): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
}

class MemoryChunkStore implements BinaryChunkStore {
  readonly kind = "memory" as const;
  private readonly chunks = new Map<string, ArrayBuffer>();
  private readonly manifests = new Map<string, ChunkManifest>();

  async has(jobId: string, index: number): Promise<boolean> {
    return this.chunks.has(chunkKey(jobId, index));
  }

  async put(jobId: string, index: number, bytes: Uint8Array): Promise<void> {
    this.chunks.set(chunkKey(jobId, index), copyArrayBuffer(bytes));
  }

  async get(jobId: string, index: number): Promise<BlobPart> {
    const bytes = this.chunks.get(chunkKey(jobId, index));
    if (!bytes) throw new Error(`Missing staged chunk ${index} for job ${jobId}.`);
    return bytes;
  }

  async readManifest(jobId: string): Promise<ChunkManifest | undefined> {
    return this.manifests.get(jobId);
  }

  async writeManifest(jobId: string, manifest: ChunkManifest): Promise<void> {
    this.manifests.set(jobId, manifest);
  }

  async deleteJob(jobId: string): Promise<void> {
    this.manifests.delete(jobId);
    const prefix = `${jobId}:`;
    for (const key of this.chunks.keys()) {
      if (key.startsWith(prefix)) this.chunks.delete(key);
    }
  }
}

class OpfsChunkStore implements BinaryChunkStore {
  readonly kind = "opfs" as const;

  async has(jobId: string, index: number): Promise<boolean> {
    try {
      await (await this.jobDirectory(jobId, false)).getFileHandle(chunkName(index));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async put(jobId: string, index: number, bytes: Uint8Array): Promise<void> {
    const directory = await this.jobDirectory(jobId, true);
    const handle = await directory.getFileHandle(chunkName(index), { create: true });
    const writable = await handle.createWritable();
    await writable.write(copyArrayBuffer(bytes));
    await writable.close();
  }

  async get(jobId: string, index: number): Promise<BlobPart> {
    const directory = await this.jobDirectory(jobId, false);
    return (await directory.getFileHandle(chunkName(index))).getFile();
  }

  async readManifest(jobId: string): Promise<ChunkManifest | undefined> {
    try {
      const directory = await this.jobDirectory(jobId, false);
      const file = await (await directory.getFileHandle("manifest.json")).getFile();
      return JSON.parse(await file.text()) as ChunkManifest;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async writeManifest(jobId: string, manifest: ChunkManifest): Promise<void> {
    const directory = await this.jobDirectory(jobId, true);
    const handle = await directory.getFileHandle("manifest.json", { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(manifest));
    await writable.close();
  }

  async deleteJob(jobId: string): Promise<void> {
    const root = await opfsRoot();
    const base = await root.getDirectoryHandle("codb-binary-flow", { create: true });
    try {
      await base.removeEntry(validateJobId(jobId), { recursive: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async jobDirectory(jobId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    const root = await opfsRoot();
    const base = await root.getDirectoryHandle("codb-binary-flow", { create: true });
    return base.getDirectoryHandle(validateJobId(jobId), { create });
  }
}

/** A cancellable conversion with progress events and resumable binary staging. */
export class BinaryFlowJob implements AsyncIterable<BinaryFlowEvent> {
  readonly id: string;
  readonly events: AsyncIterable<BinaryFlowEvent>;
  state: BinaryFlowJobState = "queued";
  verification?: ConversionVerification;

  private readonly controller = new AbortController();
  private readonly eventBuffer = new AsyncEventBuffer<BinaryFlowEvent>();
  private readonly resultPromise: Promise<CODBOutput>;

  constructor(
    id: string,
    externalSignal: AbortSignal | undefined,
    executor: (job: BinaryFlowJob, signal: AbortSignal) => Promise<CODBOutput>,
  ) {
    this.id = id;
    this.events = this;
    const unlink = linkAbortSignal(externalSignal, this.controller);
    this.resultPromise = Promise.resolve()
      .then(() => executor(this, this.controller.signal))
      .then((output) => {
        this.setState("completed", "complete", 100, "Conversion complete.");
        return output;
      })
      .catch((error) => {
        if (isAbortError(error) || this.controller.signal.aborted) {
          this.setState("cancelled", "cancelled", this.latestPercent, "Conversion cancelled.");
        } else {
          this.setState("failed", "failed", this.latestPercent, errorMessage(error));
        }
        throw error;
      })
      .finally(() => {
        unlink();
        this.eventBuffer.close();
      });
  }

  private latestPercent = 0;

  result(): Promise<CODBOutput> {
    return this.resultPromise;
  }

  cancel(reason = "Conversion cancelled by caller."): void {
    if (!this.controller.signal.aborted) this.controller.abort(abortError(reason));
  }

  [Symbol.asyncIterator](): AsyncIterator<BinaryFlowEvent> {
    return this.eventBuffer[Symbol.asyncIterator]();
  }

  emit(event: Omit<BinaryFlowEvent, "jobId" | "state">): void {
    this.latestPercent = Math.max(this.latestPercent, clampPercent(event.percent));
    this.eventBuffer.push({
      ...event,
      jobId: this.id,
      state: this.state,
      percent: clampPercent(event.percent),
    });
  }

  setState(state: BinaryFlowJobState, phase: string, percent: number, message?: string): void {
    this.state = state;
    this.emit({ type: "state", phase, percent, message });
  }
}

export type BinaryFlowConverter = (
  input: CODBInput,
  options: CODBConvertOptions,
) => Promise<CODBOutput>;

/** Browser-first staging runtime. It never converts binary data to base64. */
export class BinaryFlowRuntime {
  private readonly memoryStore = new MemoryChunkStore();

  createJob(input: CODBInput, options: BinaryFlowOptions, convert: BinaryFlowConverter): BinaryFlowJob {
    const jobId = validateJobId(options.jobId ?? createJobId());
    return new BinaryFlowJob(jobId, options.signal, async (job, signal) => {
      const store = await this.pickStore(options.storage ?? "auto", job);
      let succeeded = false;
      try {
        job.setState("staging", "staging", 0, `Staging binary chunks in ${store.kind}.`);
        const staged = await this.stageInput(input, options, store, job, signal);
        throwIfAborted(signal);

        job.setState("converting", "converting", 35, "Running local converter.");
        const callerProgress = options.onProgress;
        const output = await convert(staged, {
          ...options,
          signal,
          onProgress: (progress) => {
            const mapped = 35 + clampPercent(progress.percent) * 0.55;
            job.emit({
              type: "progress",
              phase: progress.phase,
              percent: mapped,
              message: progress.message,
            });
            callerProgress?.(progress);
          },
        });
        throwIfAborted(signal);

        if (options.verify !== false) {
          job.setState("verifying", "verifying", 90, "Checking output signature.");
          job.verification = await verifyOutput(output, options.to);
          job.emit({
            type: "verification",
            phase: "verification",
            percent: 99,
            message: job.verification.passed
              ? "Output checks passed."
              : "Output checks completed with warnings.",
          });
        }

        succeeded = true;
        return output;
      } finally {
        if (succeeded || !options.checkpoint) {
          await store.deleteJob(jobId);
        }
      }
    });
  }

  private async pickStore(storage: BinaryFlowStorage, job: BinaryFlowJob): Promise<BinaryChunkStore> {
    if (storage === "memory") return this.memoryStore;
    if (canUseOpfs()) return new OpfsChunkStore();
    if (storage === "opfs") throw new Error("OPFS storage was requested but is not available in this environment.");
    job.emit({
      type: "warning",
      phase: "storage",
      percent: 0,
      message: "OPFS is unavailable; BinaryFlow is using memory-backed chunks.",
    });
    return this.memoryStore;
  }

  private async stageInput(
    input: CODBInput,
    options: BinaryFlowOptions,
    store: BinaryChunkStore,
    job: BinaryFlowJob,
    signal: AbortSignal,
  ): Promise<CODBInput> {
    const chunkSize = positiveInteger(options.chunkSize ?? 4 * 1024 * 1024, "chunkSize");
    const source = await toRandomAccessSource(input);
    source.descriptor.fingerprint = await fingerprintSource(source, signal);
    const chunkCount = Math.max(1, Math.ceil(source.descriptor.size / chunkSize));
    const manifest: ChunkManifest = {
      version: 1,
      source: source.descriptor,
      chunkSize,
      chunkCount,
      target: options.to,
    };
    const previous = options.checkpoint ? await store.readManifest(job.id) : undefined;
    if (!sameManifest(previous, manifest)) await store.deleteJob(job.id);
    await store.writeManifest(job.id, manifest);

    let processedBytes = 0;
    const taskWindow = 256;
    for (let windowStart = 0; windowStart < chunkCount; windowStart += taskWindow) {
      const queue = new BinaryFlowQueue({
        concurrency: options.concurrency,
        memoryBudgetBytes: Math.round((options.memoryBudgetMB ?? 256) * 1024 * 1024),
      });
      const windowEnd = Math.min(chunkCount, windowStart + taskWindow);
      for (let index = windowStart; index < windowEnd; index++) {
        const start = index * chunkSize;
        const end = Math.min(start + chunkSize, source.descriptor.size);
        const byteLength = Math.max(0, end - start);
        queue.add({
          id: `chunk-${index}`,
          priority: index === 0 ? Number.MAX_SAFE_INTEGER : -index,
          memoryCost: Math.max(1, byteLength),
          run: async ({ signal: taskSignal }) => {
            throwIfAborted(taskSignal);
            const resumed = options.checkpoint === true && await store.has(job.id, index);
            if (!resumed) await store.put(job.id, index, await source.read(start, end));
            processedBytes += byteLength;
            const percent = source.descriptor.size === 0
              ? 35
              : Math.min(35, (processedBytes / source.descriptor.size) * 35);
            job.emit({
              type: "chunk",
              phase: resumed ? "resuming" : "staging",
              percent,
              message: `${resumed ? "Reused" : "Staged"} chunk ${index + 1}/${chunkCount}.`,
              processedBytes,
              totalBytes: source.descriptor.size,
              chunkIndex: index,
            });
          },
        });
      }

      await queue.run(signal);
    }
    const parts: BlobPart[] = [];
    for (let index = 0; index < chunkCount; index++) parts.push(await store.get(job.id, index));
    return replayableInput(parts, source.descriptor);
  }
}

interface RandomAccessSource {
  descriptor: SourceDescriptor;
  read(start: number, end: number): Promise<Uint8Array>;
}

async function toRandomAccessSource(input: CODBInput): Promise<RandomAccessSource> {
  if (input instanceof Blob) {
    const file = input as File;
    return {
      descriptor: {
        name: typeof file.name === "string" && file.name ? file.name : undefined,
        type: input.type || undefined,
        size: input.size,
        lastModified: typeof file.lastModified === "number" ? file.lastModified : undefined,
      },
      read: async (start, end) => new Uint8Array(await input.slice(start, end).arrayBuffer()),
    };
  }

  if (input instanceof ArrayBuffer) {
    return arraySource(new Uint8Array(input));
  }

  if (ArrayBuffer.isView(input)) {
    return arraySource(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  }

  if (typeof input !== "string" && "buffer" in input) {
    return {
      ...arraySource(new Uint8Array(input.buffer)),
      descriptor: {
        name: input.name,
        type: input.type,
        size: input.buffer.byteLength,
      },
    };
  }

  // Streams and path/URL inputs currently require one normalization pass before
  // they can be checkpointed and read randomly by the scheduler.
  const normalized = await normalizeInput(input);
  return {
    ...arraySource(normalized.bytes),
    descriptor: {
      name: normalized.name,
      type: normalized.type,
      size: normalized.size,
    },
  };
}

function arraySource(bytes: Uint8Array): RandomAccessSource {
  return {
    descriptor: { size: bytes.byteLength },
    read: async (start, end) => bytes.slice(start, end),
  };
}

async function fingerprintSource(source: RandomAccessSource, signal: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const sampleSize = 64 * 1024;
  const headEnd = Math.min(sampleSize, source.descriptor.size);
  const head = await source.read(0, headEnd);
  const tailStart = Math.max(headEnd, source.descriptor.size - sampleSize);
  const tail = tailStart < source.descriptor.size
    ? await source.read(tailStart, source.descriptor.size)
    : new Uint8Array();
  const metadata = new TextEncoder().encode([
    source.descriptor.size,
    source.descriptor.name ?? "",
    source.descriptor.type ?? "",
    source.descriptor.lastModified ?? "",
  ].join(":"));
  const payload = new Uint8Array(head.byteLength + tail.byteLength + metadata.byteLength);
  payload.set(head, 0);
  payload.set(tail, head.byteLength);
  payload.set(metadata, head.byteLength + tail.byteLength);
  throwIfAborted(signal);

  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", copyArrayBuffer(payload));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  let hash = 0x811c9dc5;
  for (const byte of payload) hash = Math.imul(hash ^ byte, 0x01000193);
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function replayableInput(parts: BlobPart[], descriptor: SourceDescriptor): CODBInput {
  if (descriptor.name && typeof File !== "undefined") {
    return new File(parts, descriptor.name, {
      type: descriptor.type,
      lastModified: descriptor.lastModified,
    });
  }
  return new Blob(parts, { type: descriptor.type });
}

async function verifyOutput(output: CODBOutput, format: string): Promise<ConversionVerification> {
  const size = output instanceof Blob ? output.size : output.byteLength;
  const head = output instanceof Blob
    ? new Uint8Array(await output.slice(0, 16).arrayBuffer())
    : output instanceof ArrayBuffer
      ? new Uint8Array(output, 0, Math.min(16, output.byteLength))
      : output.subarray(0, 16);
  const checks = [{
    name: "non-empty",
    passed: size > 0,
    message: size > 0 ? `Output contains ${size} bytes.` : "Output is empty.",
  }];
  const signature = expectedSignature(format, head);
  if (signature) checks.push(signature);
  return {
    passed: checks.every((check) => check.passed),
    outputBytes: size,
    format,
    checks,
  };
}

function expectedSignature(
  format: string,
  head: Uint8Array,
): { name: string; passed: boolean; message: string } | undefined {
  let passed: boolean | undefined;
  if (format === "pdf") passed = ascii(head, 0, 4) === "%PDF";
  else if (format === "png") passed = head[0] === 0x89 && ascii(head, 1, 3) === "PNG";
  else if (format === "jpg" || format === "jpeg") passed = head[0] === 0xff && head[1] === 0xd8;
  else if (format === "webp") passed = ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP";
  if (passed === undefined) return undefined;
  return {
    name: "format-signature",
    passed,
    message: passed ? `${format} signature is valid.` : `Output does not have a ${format} signature.`,
  };
}

class AsyncEventBuffer<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

function sameManifest(left: ChunkManifest | undefined, right: ChunkManifest): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function chunkKey(jobId: string, index: number): string {
  return `${jobId}:${index}`;
}

function chunkName(index: number): string {
  return `chunk-${index.toString().padStart(8, "0")}.bin`;
}

function createJobId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `job-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function validateJobId(jobId: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(jobId)) {
    throw new Error("BinaryFlow jobId must contain only letters, numbers, dot, underscore, or hyphen.");
  }
  return jobId;
}

function defaultConcurrency(): number {
  const count = (globalThis.navigator as Navigator | undefined)?.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(4, count));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function canUseOpfs(): boolean {
  const nav = globalThis.navigator as Navigator & { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } };
  return typeof nav?.storage?.getDirectory === "function";
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const nav = globalThis.navigator as Navigator & { storage?: { getDirectory?: () => Promise<FileSystemDirectoryHandle> } };
  if (!nav?.storage?.getDirectory) throw new Error("OPFS is not available.");
  return nav.storage.getDirectory();
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw abortError(typeof signal.reason === "string" ? signal.reason : "Operation was aborted.");
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
