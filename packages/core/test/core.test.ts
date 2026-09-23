import { test } from "node:test";
import assert from "node:assert/strict";
import { BinaryFlowQueue, BinaryFlowRuntime, CODBDocs, checkCapabilities, registry } from "@codb/core";
import { normalizeInput, sniffType, toBytes } from "@codb/core";
import { createDocument, documentToText } from "@codb/core";

test("capabilities report is well formed", () => {
  const r = checkCapabilities();
  assert.ok(r.env === "node" || r.env === "browser" || r.env === "worker");
  assert.equal(typeof r.available.pdf, "boolean");
  for (const c of ["image", "office", "media"] as const) {
    assert.equal(typeof r.available[c], "boolean");
  }
});

test("sniffType detects PNG magic bytes", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(sniffType(png), "image/png");
});

test("normalizeInput handles a Blob", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const n = await normalizeInput(blob);
  assert.deepEqual([...n.bytes], [1, 2, 3]);
  assert.equal(n.type, "image/png");
});

test("document model text extraction", () => {
  const doc = createDocument({
    pages: [
      {
        page: 1,
        blocks: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
          { type: "link", link: { text: "click", href: "https://x" } },
        ],
      },
    ],
  });
  assert.equal(documentToText(doc), "hello\nworld\nclick");
});

test("BinaryFlowQueue honors priority and dependencies", async () => {
  const order: string[] = [];
  const queue = new BinaryFlowQueue({ concurrency: 1, memoryBudgetBytes: 16 });
  queue.add({ id: "low", priority: 1, memoryCost: 8, run: () => order.push("low") });
  queue.add({ id: "high", priority: 10, memoryCost: 8, run: () => order.push("high") });
  queue.add({
    id: "final",
    dependencies: ["low", "high"],
    run: () => order.push("final"),
  });

  await queue.run();
  assert.deepEqual(order, ["high", "low", "final"]);
});

test("convertJob stages chunks and verifies local output", async () => {
  registry.register(
    { category: "text", op: "convert" },
    {
      backends: ["local"],
      run: async (input) => (await normalizeInput(input as Blob)).bytes,
    },
  );
  const codb = new CODBDocs();
  const input = new Blob([new TextEncoder().encode("binary-flow")], { type: "text/plain" });
  const job = codb.convertJob(input, {
    to: "txt",
    chunkSize: 4,
    concurrency: 2,
    memoryBudgetMB: 1,
    storage: "memory",
  });
  const events: string[] = [];
  const collect = (async () => {
    for await (const event of job.events) events.push(event.type);
  })();

  const output = await job.result();
  await collect;

  assert.equal(new TextDecoder().decode(await toBytes(output)), "binary-flow");
  assert.equal(job.state, "completed");
  assert.equal(job.verification?.passed, true);
  assert.ok(events.includes("chunk"));
  assert.ok(events.includes("verification"));
});

test("checkpointed BinaryFlow jobs reuse staged chunks", async () => {
  const runtime = new BinaryFlowRuntime();
  const input = new TextEncoder().encode("resume-me");
  const options = {
    to: "txt" as const,
    jobId: "resume-test",
    chunkSize: 3,
    checkpoint: true,
    storage: "memory" as const,
  };
  const failed = runtime.createJob(input, options, async () => {
    throw new Error("converter interrupted");
  });
  await assert.rejects(failed.result(), /converter interrupted/);

  const resumed = runtime.createJob(input, options, async (staged) => (await normalizeInput(staged)).bytes);
  const phases: string[] = [];
  const collect = (async () => {
    for await (const event of resumed) phases.push(event.phase);
  })();
  const output = await resumed.result();
  await collect;

  assert.equal(new TextDecoder().decode(await toBytes(output)), "resume-me");
  assert.ok(phases.includes("resuming"));
});

test("checkpoint fingerprints reject different same-size input", async () => {
  const runtime = new BinaryFlowRuntime();
  const options = {
    to: "txt" as const,
    jobId: "fingerprint-test",
    chunkSize: 2,
    checkpoint: true,
    storage: "memory" as const,
  };
  const failed = runtime.createJob(new TextEncoder().encode("first"), options, async () => {
    throw new Error("converter interrupted");
  });
  await assert.rejects(failed.result(), /converter interrupted/);

  const replacement = new TextEncoder().encode("other");
  const restarted = runtime.createJob(replacement, options, async (staged) => (await normalizeInput(staged)).bytes);
  const phases: string[] = [];
  const collect = (async () => {
    for await (const event of restarted) phases.push(event.phase);
  })();
  const output = await restarted.result();
  await collect;

  assert.equal(new TextDecoder().decode(await toBytes(output)), "other");
  assert.equal(phases.includes("resuming"), false);
});
