/**
 * Credential-free (noAuth) provider model discovery.
 *
 * Providers flagged `noAuth: true` (OpenCode Zen free tier, local-device, the
 * local TTS engines, searxng) are usable with zero connections, so the
 * connection-driven sync path in modelSync.js can never run for them — it bails
 * out with "No active connections for this provider" and their models never
 * reach the synced catalog (and therefore never reach the global Models page).
 *
 * This module performs the same discovery using the provider's declared
 * public `modelsFetcher` URL plus the matching entry in the suggested-models
 * filter table, so the exact upstream ids are preserved and filtered by the
 * same rules the UI already uses.
 */
import { AI_PROVIDERS } from "../../shared/constants/providers.js";
import { FILTERS } from "../../routes/providers/suggested-models/filters.js";
import { fetchWithTimeout } from "../net/fetchWithTimeout.js";

const DISCOVERY_TIMEOUT_MS = 15000;

/** Normalize the several shapes OpenAI-compatible catalogs come in. */
function parseCatalog(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && Array.isArray(payload.models)) return payload.models;
  if (payload && Array.isArray(payload.results)) return payload.results;
  return [];
}

/**
 * Fetch the public catalog for a noAuth provider.
 * @param {string} providerId
 * @returns {Promise<{models: Array, error: string|null, source: string|null}>}
 */
export async function discoverNoAuthProviderModels(providerId) {
  const provider = AI_PROVIDERS[providerId] || null;
  const fetcher = provider?.modelsFetcher;
  if (!fetcher?.url || !fetcher?.type) {
    return { models: [], error: `Provider ${providerId} has no public model fetcher configured`, source: null };
  }

  const filter = FILTERS[fetcher.type];
  if (typeof filter !== "function") {
    return { models: [], error: `Unknown filter type: ${fetcher.type}`, source: fetcher.url };
  }

  let payload;
  try {
    const res = await fetchWithTimeout(fetcher.url, {
      method: "GET",
      headers: { Accept: "application/json" },
      timeoutMs: DISCOVERY_TIMEOUT_MS,
    });
    if (!res.ok) {
      return { models: [], error: `Upstream returned HTTP ${res.status}`, source: fetcher.url };
    }
    payload = await res.json();
  } catch (err) {
    const msg = err?.name === "TimeoutError"
      ? `Upstream timed out after ${DISCOVERY_TIMEOUT_MS}ms`
      : String(err?.message || err);
    return { models: [], error: msg, source: fetcher.url };
  }

  const raw = parseCatalog(payload);
  if (raw.length === 0) {
    return { models: [], error: "Upstream returned an empty catalog", source: fetcher.url };
  }

  let models;
  try {
    models = filter(raw);
  } catch (err) {
    return { models: [], error: `Filter failed: ${String(err?.message || err)}`, source: fetcher.url };
  }

  // Preserve the exact upstream id; only fill in a display name when absent.
  const normalized = models
    .map((m) => (typeof m === "string" ? { id: m, name: m } : m))
    .filter((m) => m && typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      type: m.type || "llm",
      isFree: true,
      ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
    }));

  return { models: normalized, error: null, source: fetcher.url };
}
