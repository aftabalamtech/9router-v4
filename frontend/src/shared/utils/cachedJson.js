// Shared GET-JSON cache for dashboard data: short TTL + in-flight dedupe.
// Tab switches remount pages; without this every visit refires the same
// half-dozen requests. Mutations explicitly invalidate their endpoints.

const entries = new Map(); // url -> { data, expires }
const inflight = new Map(); // url -> Promise

export const CACHE_TTLS = {
  providers: 30000,
  models: 30000,
  settings: 60000,
  default: 30000,
};

function ttlFor(url) {
  if (url.includes("/api/providers")) return CACHE_TTLS.providers;
  if (url.includes("/api/models/")) return CACHE_TTLS.models;
  if (url.includes("/api/settings") || url.includes("/api/version")) return CACHE_TTLS.settings;
  return CACHE_TTLS.default;
}

export async function cachedJson(url, { ttl, force = false } = {}) {
  const now = Date.now();
  if (!force) {
    const hit = entries.get(url);
    if (hit && hit.expires > now) return hit.data;
    const pending = inflight.get(url);
    if (pending) return pending;
  }
  const p = fetch(url, { cache: "no-store" })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    })
    .then((result) => {
      // Cache successful reads only; errors always refetch.
      if (result.ok) {
        entries.set(url, { data: result, expires: Date.now() + (ttl ?? ttlFor(url)) });
      }
      return result;
    })
    .finally(() => {
      if (inflight.get(url) === p) inflight.delete(url);
    });
  inflight.set(url, p);
  return p;
}

export function invalidateCache(prefix) {
  for (const key of entries.keys()) {
    if (!prefix || key.includes(prefix)) entries.delete(key);
  }
}

export function clearAllCache() {
  entries.clear();
}
