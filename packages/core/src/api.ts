import type { CapabilityReport, ExecutionBackend } from "./capabilities";
import type {
  BinaryFlowEvent,
  BinaryFlowJob,
  BinaryFlowOptions,
  ConversionVerification,
} from "./binary-flow";
import type {
  CODBConvertOptions,
  CODBInput,
  CODBInputFormat,
  CODBOutput,
  CODBOutputFormat,
} from "./types";

export interface CODBApiEngine {
  readonly report: CapabilityReport;
  readonly lastBackend: ExecutionBackend;
  convert(input: CODBInput, options: CODBConvertOptions): Promise<CODBOutput>;
  convertJob(input: CODBInput, options: BinaryFlowOptions): BinaryFlowJob;
}

export interface CODBApiOptions {
  /** URL prefix before `/v1`. Defaults to an empty prefix. */
  basePath?: string;
  /** Optional input ceiling for an HTTP deployment. Local use is unlimited. */
  maxInputBytes?: number;
  /** Keep completed job results for this long. Defaults to five minutes. */
  jobTtlMs?: number;
}

export interface CODBApiJobStatus {
  id: string;
  state: BinaryFlowJob["state"];
  phase: string;
  percent: number;
  createdAt: string;
  completedAt?: string;
  resultReady: boolean;
  error?: string;
  verification?: ConversionVerification;
  links: {
    self: string;
    result: string;
  };
}

interface ApiJobRecord {
  job: BinaryFlowJob;
  phase: string;
  percent: number;
  createdAt: Date;
  completedAt?: Date;
  output?: CODBOutput;
  error?: string;
  format: CODBOutputFormat;
  filename: string;
  staged: Promise<void>;
  resolveStaged: () => void;
  settled: Promise<void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const OUTPUT_FORMATS = new Set<CODBOutputFormat>([
  "pdf", "jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "svg", "tiff",
  "html", "txt", "json",
]);

const INPUT_FORMATS = new Set<CODBInputFormat>([
  "pdf", "jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif", "bmp",
  "svg", "tiff", "docx", "xlsx", "pptx", "html", "txt",
]);

/**
 * Fetch-compatible CODBConvert API. It performs no network I/O itself: callers
 * choose whether to invoke it directly, from a worker, or behind an HTTP host.
 */
export class CODBFetchApi {
  private readonly jobs = new Map<string, ApiJobRecord>();
  private readonly basePath: string;
  private readonly maxInputBytes?: number;
  private readonly jobTtlMs: number;

  constructor(private readonly engine: CODBApiEngine, options: CODBApiOptions = {}) {
    this.basePath = normalizeBasePath(options.basePath ?? "");
    this.maxInputBytes = options.maxInputBytes;
    this.jobTtlMs = options.jobTtlMs ?? 5 * 60 * 1000;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof InputLimitError) return problem(413, "Input too large", error.message);
      return problem(500, "Conversion API failure", errorMessage(error));
    }
  }

  dispose(): void {
    for (const record of this.jobs.values()) {
      if (record.cleanupTimer) clearTimeout(record.cleanupTimer);
      if (record.job.state !== "completed" && record.job.state !== "failed" && record.job.state !== "cancelled") {
        record.job.cancel("CODB API disposed.");
      }
    }
    this.jobs.clear();
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = this.stripBasePath(url.pathname);

    if (request.method === "GET" && path === "/v1/health") {
      return json({ ok: true, runtime: "codbconvert", serverless: true });
    }
    if (request.method === "GET" && path === "/v1/capabilities") {
      return json(this.engine.report);
    }
    if (request.method === "POST" && path === "/v1/convert") {
      return this.convertNow(request, url);
    }
    if (request.method === "POST" && path === "/v1/jobs") {
      return this.createJob(request, url);
    }

    const jobMatch = /^\/v1\/jobs\/([A-Za-z0-9._-]{1,128})(?:\/(result))?$/.exec(path);
    if (jobMatch) {
      const [, id, resource] = jobMatch;
      if (request.method === "GET" && resource === "result") return this.jobResult(id, url);
      if (request.method === "GET" && !resource) return this.jobStatus(id);
      if (request.method === "DELETE" && !resource) return this.cancelJob(id);
    }

    return problem(404, "Not found", `No CODB API route matches ${request.method} ${path}.`);
  }

  private async convertNow(request: Request, url: URL): Promise<Response> {
    const parsed = parseConvertRequest(url);
    if (parsed instanceof Response) return parsed;
    const input = await this.requestInput(request);
    if (input instanceof Response) return input;

    const job = this.engine.convertJob(input.value, parsed.options);
    const output = await job.result();
    return outputResponse(output, parsed.options.to, input.name, {
      "X-CODB-Job-Id": job.id,
      "X-CODB-Backend": this.engine.lastBackend,
      "X-CODB-Verified": String(job.verification?.passed ?? false),
    });
  }

  private async createJob(request: Request, url: URL): Promise<Response> {
    const parsed = parseConvertRequest(url);
    if (parsed instanceof Response) return parsed;
    const input = await this.requestInput(request);
    if (input instanceof Response) return input;

    const job = this.engine.convertJob(input.value, parsed.options);
    let resolveStaged = () => {};
    const staged = new Promise<void>((resolve) => {
      resolveStaged = resolve;
    });
    const record = {
      job,
      phase: "queued",
      percent: 0,
      createdAt: new Date(),
      format: parsed.options.to,
      filename: outputFilename(input.name, parsed.options.to),
      staged,
      resolveStaged,
    } as ApiJobRecord;
    record.settled = this.observeJob(record);
    this.jobs.set(job.id, record);
    await record.staged;

    return json(this.statusFor(record), 202, {
      Location: this.jobPath(job.id),
      "Retry-After": "1",
    });
  }

  private async observeJob(record: ApiJobRecord): Promise<void> {
    const collect = (async () => {
      for await (const event of record.job.events) this.applyEvent(record, event);
    })();
    try {
      record.output = await record.job.result();
    } catch (error) {
      record.error = errorMessage(error);
    } finally {
      await collect;
      record.resolveStaged();
      record.completedAt = new Date();
      record.cleanupTimer = setTimeout(() => this.jobs.delete(record.job.id), this.jobTtlMs);
      (record.cleanupTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    }
  }

  private applyEvent(record: ApiJobRecord, event: BinaryFlowEvent): void {
    record.phase = event.phase;
    record.percent = event.percent;
    if (event.state !== "queued" && event.state !== "staging") record.resolveStaged();
  }

  private async jobStatus(id: string): Promise<Response> {
    const record = this.jobs.get(id);
    if (!record) return problem(404, "Job not found", `No conversion job exists with id ${id}.`);
    return json(this.statusFor(record), record.output ? 200 : 202, record.output ? undefined : { "Retry-After": "1" });
  }

  private async jobResult(id: string, url: URL): Promise<Response> {
    const record = this.jobs.get(id);
    if (!record) return problem(404, "Job not found", `No conversion job exists with id ${id}.`);
    if (url.searchParams.get("wait") === "true") await record.settled;
    if (record.output) {
      return outputResponse(record.output, record.format, record.filename, {
        "X-CODB-Job-Id": id,
        "X-CODB-Backend": this.engine.lastBackend,
        "X-CODB-Verified": String(record.job.verification?.passed ?? false),
      });
    }
    if (record.job.state === "failed") return problem(500, "Conversion failed", record.error ?? "The conversion failed.");
    if (record.job.state === "cancelled") return problem(409, "Conversion cancelled", record.error ?? "The conversion was cancelled.");
    return json(this.statusFor(record), 202, { "Retry-After": "1" });
  }

  private async cancelJob(id: string): Promise<Response> {
    const record = this.jobs.get(id);
    if (!record) return problem(404, "Job not found", `No conversion job exists with id ${id}.`);
    record.job.cancel("Conversion cancelled through the CODB API.");
    return json(this.statusFor(record), 202);
  }

  private async requestInput(request: Request): Promise<{ value: CODBInput; name: string } | Response> {
    const lengthHeader = request.headers.get("content-length") ?? request.headers.get("X-CODB-Size");
    const declaredLength = lengthHeader === null ? undefined : Number(lengthHeader);
    if (this.maxInputBytes !== undefined && declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > this.maxInputBytes) {
      return problem(413, "Input too large", `Input exceeds the ${this.maxInputBytes}-byte API limit.`);
    }
    const name = sanitizeFilename(request.headers.get("X-CODB-Filename") ?? "input.bin");
    const type = request.headers.get("content-type") ?? undefined;
    if (!request.body) {
      return { value: new Blob([], { type }), name };
    }
    const stream = this.maxInputBytes === undefined
      ? request.body
      : limitStream(request.body, this.maxInputBytes);
    const value: CODBInput = {
      stream,
      name,
      type,
      size: declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength >= 0
        ? declaredLength
        : undefined,
    };
    return { value, name };
  }

  private statusFor(record: ApiJobRecord): CODBApiJobStatus {
    return {
      id: record.job.id,
      state: record.job.state,
      phase: record.phase,
      percent: record.percent,
      createdAt: record.createdAt.toISOString(),
      completedAt: record.completedAt?.toISOString(),
      resultReady: record.output !== undefined,
      error: record.error,
      verification: record.job.verification,
      links: {
        self: this.jobPath(record.job.id),
        result: `${this.jobPath(record.job.id)}/result`,
      },
    };
  }

  private jobPath(id: string): string {
    return `${this.basePath}/v1/jobs/${id}` || `/v1/jobs/${id}`;
  }

  private stripBasePath(pathname: string): string {
    if (!this.basePath) return pathname;
    if (!pathname.startsWith(`${this.basePath}/`) && pathname !== this.basePath) return pathname;
    return pathname.slice(this.basePath.length) || "/";
  }
}

export function createCODBApi(engine: CODBApiEngine, options: CODBApiOptions = {}): CODBFetchApi {
  return new CODBFetchApi(engine, options);
}

function parseConvertRequest(url: URL): { options: BinaryFlowOptions } | Response {
  const to = url.searchParams.get("to");
  if (!to || !OUTPUT_FORMATS.has(to as CODBOutputFormat)) {
    return problem(400, "Invalid target format", "Query parameter `to` must name a supported output format.");
  }
  const from = url.searchParams.get("from");
  if (from && !INPUT_FORMATS.has(from as CODBInputFormat)) {
    return problem(400, "Invalid source format", "Query parameter `from` must name a supported input format.");
  }

  const options: BinaryFlowOptions = {
    to: to as CODBOutputFormat,
    from: from as CODBInputFormat | undefined,
  };
  const invalid = assignNumber(url, "quality", options, 0, 1)
    ?? assignInteger(url, "width", options)
    ?? assignInteger(url, "height", options)
    ?? assignNumber(url, "scale", options, Number.EPSILON)
    ?? assignInteger(url, "chunkSize", options)
    ?? assignInteger(url, "concurrency", options)
    ?? assignNumber(url, "memoryBudgetMB", options, Number.EPSILON);
  if (invalid) return invalid;

  assignBoolean(url, "searchable", options);
  assignBoolean(url, "accessibility", options);
  assignBoolean(url, "optimize", options);
  assignBoolean(url, "checkpoint", options);
  assignBoolean(url, "verify", options);
  const storage = url.searchParams.get("storage");
  if (storage) {
    if (!new Set(["auto", "memory", "opfs"]).has(storage)) {
      return problem(400, "Invalid storage mode", "Storage must be auto, memory, or opfs.");
    }
    options.storage = storage as BinaryFlowOptions["storage"];
  }
  return { options };
}

function assignNumber(
  url: URL,
  key: "quality" | "scale" | "memoryBudgetMB",
  target: BinaryFlowOptions,
  min: number,
  max = Number.POSITIVE_INFINITY,
): Response | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    return problem(400, "Invalid numeric option", `${key} must be between ${min} and ${max}.`);
  }
  target[key] = value;
  return undefined;
}

function assignInteger(
  url: URL,
  key: "width" | "height" | "chunkSize" | "concurrency",
  target: BinaryFlowOptions,
): Response | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return problem(400, "Invalid integer option", `${key} must be a positive integer.`);
  }
  target[key] = value;
  return undefined;
}

function assignBoolean(
  url: URL,
  key: "searchable" | "accessibility" | "optimize" | "checkpoint" | "verify",
  target: BinaryFlowOptions,
): void {
  const raw = url.searchParams.get(key);
  if (raw !== null) target[key] = raw === "true" || raw === "1";
}

function outputResponse(
  output: CODBOutput,
  format: CODBOutputFormat,
  inputName: string,
  headers: HeadersInit,
): Response {
  const body = output instanceof Blob ? output : copyOutputBuffer(output);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": outputMime(format),
      "Content-Disposition": `attachment; filename="${outputFilename(inputName, format)}"`,
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function copyOutputBuffer(output: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (output instanceof ArrayBuffer) return output;
  const buffer = new ArrayBuffer(output.byteLength);
  new Uint8Array(buffer).set(output);
  return buffer;
}

function outputMime(format: CODBOutputFormat): string {
  const mime: Partial<Record<CODBOutputFormat, string>> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    tiff: "image/tiff",
    html: "text/html; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    json: "application/json",
    base64: "text/plain; charset=utf-8",
  };
  return mime[format] ?? "application/octet-stream";
}

function outputFilename(inputName: string, format: CODBOutputFormat): string {
  const base = sanitizeFilename(inputName).replace(/\.[^.]+$/, "") || "converted";
  const extension = format === "jpeg" ? "jpg" : format;
  return `${base}.${extension}`;
}

function sanitizeFilename(value: string): string {
  const cleaned = value.split(/[\\/]/).pop()?.replace(/[\0-\x1f<>:"|?*]/g, "_").trim();
  return cleaned || "input.bin";
}

function normalizeBasePath(value: string): string {
  if (!value || value === "/") return "";
  return `/${value.replace(/^\/+|\/+$/g, "")}`;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function problem(status: number, title: string, detail: string): Response {
  return new Response(JSON.stringify({ type: "about:blank", title, status, detail }), {
    status,
    headers: { "Content-Type": "application/problem+json; charset=utf-8" },
  });
}

class InputLimitError extends Error {
  constructor(maxInputBytes: number) {
    super(`Input exceeds the ${maxInputBytes}-byte API limit.`);
    this.name = "InputLimitError";
  }
}

function limitStream(
  source: ReadableStream<Uint8Array>,
  maxInputBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxInputBytes) throw new InputLimitError(maxInputBytes);
      controller.enqueue(chunk);
    },
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
