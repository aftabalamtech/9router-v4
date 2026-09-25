/**
 * Tests for the outbound fetch timeout helper.
 *
 * A provider that accepts a connection and then stalls would otherwise hold a
 * dashboard request open forever, so every outbound provider call must be
 * time-boxed. These assert the deadline actually fires and that a caller
 * supplied signal is still honoured.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { fetchWithTimeout, DEFAULT_PROVIDER_TIMEOUT_MS } from "../src/lib/net/fetchWithTimeout.js";

const withMockFetch = (impl) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return { restore: () => { globalThis.fetch = original; } };
};

test("default timeout is a finite, sane deadline", () => {
  assert.equal(typeof DEFAULT_PROVIDER_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_PROVIDER_TIMEOUT_MS > 0 && DEFAULT_PROVIDER_TIMEOUT_MS <= 60000);
});

test("passes through method, headers and body", async () => {
  let seen = null;
  const mock = withMockFetch(async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({}) };
  });
  try {
    await fetchWithTimeout("https://example.test/v1/models", {
      method: "POST",
      headers: { "x-test": "1" },
      body: JSON.stringify({ a: 1 }),
    });
    assert.equal(seen.url, "https://example.test/v1/models");
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers["x-test"], "1");
    assert.equal(seen.init.body, JSON.stringify({ a: 1 }));
    assert.ok(seen.init.signal, "a signal must be attached");
  } finally {
    mock.restore();
  }
});

// AbortSignal.timeout schedules an unref'd timer, so it will not by itself keep
// the event loop alive and the runner would tear down mid-test. Hold a ref'd
// timer open for the duration of any test that waits on an abort.
function keepLoopAlive(ms) {
  const t = setTimeout(() => {}, ms);
  return () => clearTimeout(t);
}

test("aborts a stalled request once the timeout elapses", async () => {
  // Never resolves on its own; only abort should end the promise.
  const release = keepLoopAlive(5000);
  const mock = withMockFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const err = new Error("The operation was aborted");
      err.name = "TimeoutError";
      reject(err);
    });
  }));
  try {
    const started = Date.now();
    await assert.rejects(
      fetchWithTimeout("https://example.test/hang", { timeoutMs: 60 }),
      (err) => err.name === "TimeoutError" || /abort/i.test(err.message),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 50, `should wait for the deadline, waited ${elapsed}ms`);
    assert.ok(elapsed < 3000, `should not overshoot badly, took ${elapsed}ms`);
  } finally {
    mock.restore();
    release();
  }
});

test("honours a caller-supplied abort signal", async () => {
  const release = keepLoopAlive(5000);
  const controller = new AbortController();
  const mock = withMockFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(new Error("caller aborted"));
    });
  }));
  try {
    const p = fetchWithTimeout("https://example.test/slow", {
      timeoutMs: 30000,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(p, /caller aborted/);
  } finally {
    mock.restore();
    release();
  }
});

test("does not mutate the caller's options object", async () => {
  const release = keepLoopAlive(5000);
  const mock = withMockFetch(async (url, init) => {
    assert.ok(init.signal);
    return { ok: true, json: async () => ({}) };
  });
  const originalSignal = AbortSignal.timeout(1234);
  const options = { method: "GET", signal: originalSignal, timeoutMs: 5000 };
  try {
    await fetchWithTimeout("https://example.test", options);
    assert.equal(options.signal, originalSignal, "caller options must be left intact");
    assert.equal("timeoutMs" in options, true, "timeoutMs must not be stripped from caller object");
  } finally {
    mock.restore();
    release();
  }
});
