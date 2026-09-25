/**
 * Tests for the shared GET cache used by the dashboard pages.
 *
 * The cache is what makes tab switches cheap, so the important properties are:
 *  - a second read inside the TTL does not refetch
 *  - concurrent reads of the same URL share one in-flight request
 *  - errors are never cached (a failed provider read must be retryable)
 *  - mutations can invalidate a prefix
 */
import test from "node:test";
import assert from "node:assert/strict";

function withMockFetch(impl) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init, calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

async function loadFresh() {
  // Cache module holds state in module scope; re-import to get a clean slate.
  const mod = await import(`../src/shared/utils/cachedJson.js?v=${Math.random()}`);
  return mod;
}

test("cachedJson caches a successful read within the TTL", async () => {
  const { cachedJson } = await loadFresh();
  const mock = withMockFetch(() => jsonResponse({ connections: [{ id: 1 }] }));
  try {
    const a = await cachedJson("/api/providers");
    const b = await cachedJson("/api/providers");
    assert.equal(mock.calls.length, 1, "second read should be served from cache");
    assert.deepEqual(a.data, b.data);
  } finally {
    mock.restore();
  }
});

test("cachedJson dedupes concurrent in-flight requests", async () => {
  const { cachedJson } = await loadFresh();
  let release;
  const gate = new Promise((r) => { release = r; });
  const mock = withMockFetch(async () => {
    await gate;
    return jsonResponse({ nodes: [] });
  });
  try {
    const p1 = cachedJson("/api/provider-nodes");
    const p2 = cachedJson("/api/provider-nodes");
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(mock.calls.length, 1, "in-flight request should be shared");
    assert.deepEqual(r1.data, r2.data);
  } finally {
    mock.restore();
  }
});

test("cachedJson does not cache errors", async () => {
  const { cachedJson } = await loadFresh();
  let n = 0;
  const mock = withMockFetch(() => {
    n += 1;
    return n === 1 ? jsonResponse({ error: "boom" }, false, 500) : jsonResponse({ ok: true });
  });
  try {
    const first = await cachedJson("/api/models/blocks");
    assert.equal(first.ok, false);
    const second = await cachedJson("/api/models/blocks");
    assert.equal(second.ok, true, "a failed read must be retried, not cached");
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test("cachedJson force bypasses a fresh cache entry", async () => {
  const { cachedJson } = await loadFresh();
  const mock = withMockFetch(() => jsonResponse({ v: 1 }));
  try {
    await cachedJson("/api/providers");
    await cachedJson("/api/providers", { force: true });
    assert.equal(mock.calls.length, 2, "force must refetch");
  } finally {
    mock.restore();
  }
});

test("invalidateCache drops matching entries only", async () => {
  const { cachedJson, invalidateCache } = await loadFresh();
  const mock = withMockFetch((url) => jsonResponse({ url }));
  try {
    await cachedJson("/api/models/disabled");
    await cachedJson("/api/models/blocks");
    await cachedJson("/api/providers");
    invalidateCache("/api/models/");
    await cachedJson("/api/models/disabled");
    await cachedJson("/api/models/blocks");
    await cachedJson("/api/providers");
    assert.equal(mock.calls.length, 5, "only the two model entries should refetch");
  } finally {
    mock.restore();
  }
});

test("clearAllCache empties the cache", async () => {
  const { cachedJson, clearAllCache } = await loadFresh();
  const mock = withMockFetch(() => jsonResponse({ v: 1 }));
  try {
    await cachedJson("/api/providers");
    clearAllCache();
    await cachedJson("/api/providers");
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});
