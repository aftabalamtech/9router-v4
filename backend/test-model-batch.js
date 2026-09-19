import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTestError,
  sanitizeErrorMessage,
  normalizeModels,
  clampConcurrency,
  clampTimeoutMs,
  summarizeResults,
  createTestJob,
  cancelTestJob,
  getJob,
  isRetriableCode,
  MAX_MODELS_PER_JOB,
} from "./src/lib/models/testBatch.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const noopPersist = async () => {};

describe("classifyTestError", () => {
  it("detects timeouts", () => {
    assert.equal(classifyTestError({ status: null, error: "TimeoutError: signal timed out" }), "timeout");
    assert.equal(classifyTestError({ status: 200, error: "request aborted" }), "timeout");
  });
  it("detects auth failures and never retries them", () => {
    assert.equal(classifyTestError({ status: 401, error: "x" }), "auth");
    assert.equal(classifyTestError({ status: 403, error: "x" }), "auth");
    assert.equal(isRetriableCode("auth"), false);
  });
  it("detects rate limits", () => {
    assert.equal(classifyTestError({ status: 429, error: "slow down" }), "rate_limited");
    assert.equal(isRetriableCode("rate_limited"), false);
  });
  it("detects missing models", () => {
    assert.equal(classifyTestError({ status: 404, error: "unknown model" }), "not_found");
  });
  it("detects network errors and retries them", () => {
    assert.equal(classifyTestError({ status: null, error: "fetch failed ECONNREFUSED" }), "network");
    assert.equal(isRetriableCode("network"), true);
    assert.equal(isRetriableCode("timeout"), true);
  });
});

describe("sanitizeErrorMessage", () => {
  it("redacts secrets", () => {
    const out = sanitizeErrorMessage("failed sk-abcdefgh12345678 with Bearer abcdefgh1234 token=x apiKey: hunter2secret");
    assert.ok(!out.includes("sk-abcdefgh"), out);
    assert.ok(out.includes("[redacted]"), out);
  });
  it("truncates long messages", () => {
    assert.ok(sanitizeErrorMessage("x".repeat(500)).length <= 240);
  });
});

describe("normalizeModels", () => {
  it("dedupes and validates", () => {
    const out = normalizeModels(["a/m1", { model: "a/m1" }, { model: " a/m2 ", kind: "image" }, "", null, 42]);
    assert.deepEqual(out, [{ model: "a/m1", kind: "llm" }, { model: "a/m2", kind: "image" }]);
  });
  it("returns [] for non-arrays", () => {
    assert.deepEqual(normalizeModels(null), []);
    assert.deepEqual(normalizeModels("x"), []);
  });
});

describe("clamps", () => {
  it("concurrency defaults 4, range 1-10", () => {
    assert.equal(clampConcurrency(undefined), 4);
    assert.equal(clampConcurrency(0), 1);
    assert.equal(clampConcurrency(99), 10);
    assert.equal(clampConcurrency(3), 3);
  });
  it("timeout defaults 15000, range 5000-120000", () => {
    assert.equal(clampTimeoutMs(undefined), 15000);
    assert.equal(clampTimeoutMs(100), 5000);
    assert.equal(clampTimeoutMs(1e9), 120000);
  });
});

describe("summarizeResults", () => {
  it("counts timeouts as failed too", () => {
    const s = summarizeResults([
      { status: "passed" }, { status: "failed" }, { status: "timeout" },
      { status: "pending" }, { status: "testing" }, { status: "skipped" }, { status: "cancelled" },
    ]);
    assert.deepEqual(s, { total: 7, pending: 1, testing: 1, passed: 1, failed: 2, skipped: 1, cancelled: 1, timeout: 1 });
  });
});

describe("createTestJob validation", () => {
  it("rejects empty model lists", async () => {
    await assert.rejects(() => createTestJob({ models: [] }), /At least one model/);
  });
  it("rejects oversized batches", async () => {
    const models = Array.from({ length: MAX_MODELS_PER_JOB + 1 }, (_, i) => `a/m${i}`);
    await assert.rejects(() => createTestJob({ models }), /Too many models/);
  });
});

describe("job execution", () => {
  it("respects the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const pingFn = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(20);
      active -= 1;
      return { ok: true, latencyMs: 20 };
    };
    const models = Array.from({ length: 9 }, (_, i) => `a/m${i}`);
    const job = await createTestJob({ models, concurrency: 3, pingFn, persistFn: noopPersist });
    while (getJob(job.id)?.status === "running") await tick(10);
    assert.ok(maxActive <= 3, `maxActive=${maxActive}`);
    assert.ok(maxActive > 1, `expected parallelism, got ${maxActive}`);
    const snap = getJob(job.id);
    assert.equal(snap.status, "done");
    assert.equal(snap.results.filter((r) => r.status === "passed").length, 9);
  });

  it("retries timeouts once but not auth failures", async () => {
    const calls = {};
    const pingFn = async (model) => {
      calls[model] = (calls[model] || 0) + 1;
      if (model === "a/flaky") return calls[model] === 1 ? { ok: false, error: "TimeoutError" } : { ok: true, latencyMs: 5 };
      return { ok: false, error: "Invalid API key", status: 401 };
    };
    const job = await createTestJob({ models: ["a/flaky", "a/bad"], concurrency: 2, pingFn, persistFn: noopPersist });
    while (getJob(job.id)?.status === "running") await tick(10);
    assert.equal(calls["a/flaky"], 2);
    assert.equal(calls["a/bad"], 1);
    const byId = Object.fromEntries(getJob(job.id).results.map((r) => [r.modelId, r]));
    assert.equal(byId["a/flaky"].status, "passed");
    assert.equal(byId["a/bad"].status, "failed");
    assert.equal(byId["a/bad"].errorCode, "auth");
  });

  it("one failure does not stop the batch", async () => {
    const pingFn = async (model) => {
      if (model === "a/boom") throw new Error("kaboom");
      return { ok: true, latencyMs: 1 };
    };
    const job = await createTestJob({ models: ["a/boom", "a/ok"], concurrency: 2, pingFn, persistFn: noopPersist });
    while (getJob(job.id)?.status === "running") await tick(10);
    const byId = Object.fromEntries(getJob(job.id).results.map((r) => [r.modelId, r]));
    assert.equal(byId["a/boom"].status, "failed");
    assert.equal(byId["a/ok"].status, "passed");
  });

  it("cancel stops scheduling and marks the rest cancelled", async () => {
    const pingFn = async () => {
      await tick(30);
      return { ok: true, latencyMs: 30 };
    };
    const models = Array.from({ length: 8 }, (_, i) => `a/m${i}`);
    const job = await createTestJob({ models, concurrency: 1, pingFn, persistFn: noopPersist });
    await tick(15);
    cancelTestJob(job.id);
    while (getJob(job.id)?.status === "running") await tick(10);
    const snap = getJob(job.id);
    assert.equal(snap.status, "cancelled");
    assert.ok(snap.results.some((r) => r.status === "cancelled"), JSON.stringify(snap.summary));
    assert.ok(!snap.results.some((r) => r.status === "pending" || r.status === "testing"));
  });

  it("persists terminal results without secrets", async () => {
    const saved = {};
    const persistFn = async (model, record) => { saved[model] = record; };
    const pingFn = async () => ({ ok: false, error: "bad key sk-abcdefgh12345678", status: 401, latencyMs: 3 });
    const job = await createTestJob({ models: ["a/x"], pingFn, persistFn });
    while (getJob(job.id)?.status === "running") await tick(10);
    assert.ok(!saved["a/x"].errorMessage.includes("sk-abcdefgh"), saved["a/x"].errorMessage);
    assert.equal(saved["a/x"].errorCode, "auth");
  });
});
