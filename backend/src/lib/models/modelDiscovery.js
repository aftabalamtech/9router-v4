import { getApiKeys } from "../localDb.js";
import { getConsistentMachineId } from "../../shared/utils/machineId.js";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "../../shared/constants/providers.js";

const CLI_TOKEN_SALT = "9r-cli-auth";
const DISCOVERY_TIMEOUT_MS = 45000;

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((k) => k.isActive !== false)?.key || null;
  } catch {}
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

function baseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 3001}`;
}

function inferType(id) {
  const lower = String(id || "").toLowerCase();
  if (lower.includes("embed")) return "embedding";
  if (lower.includes("tts") || lower.includes("whisper") || lower.includes("transcri")) return "stt";
  if (lower.includes("image") || lower.includes("dall-e") || lower.includes("t2i") || lower.includes("i2i")) return "image";
  return "llm";
}

function inferApiFormat(provider) {
  if (isAnthropicCompatibleProvider(provider)) return "anthropic";
  if (isOpenAICompatibleProvider(provider)) return "openai-compatible";
  return "native";
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function inferFree(entry) {
  const pricing = entry?.pricing;
  if (pricing && typeof pricing === "object") {
    const prompt = toNumberOrNull(pricing.prompt ?? pricing.input);
    const completion = toNumberOrNull(pricing.completion ?? pricing.output);
    if (prompt !== null && completion !== null) return prompt === 0 && completion === 0;
  }
  if (typeof entry?.isFree === "boolean") return entry.isFree;
  return null;
}

export function normalizeDiscoveredModel(entry, { provider, connectionId }) {
  // Only explicit identifier fields — never invent an id from a display name.
  const id = entry?.id || entry?.model || entry?.slug;
  if (!id || typeof id !== "string") return null;
  return {
    id: id.trim().slice(0, 200),
    name: String(entry?.name || entry?.display_name || entry?.displayName || id).slice(0, 200),
    provider,
    connectionId,
    source: "upstream",
    apiFormat: inferApiFormat(provider),
    type: entry?.type || inferType(id),
    contextLength: toNumberOrNull(entry?.context_length ?? entry?.contextLength ?? entry?.context_window),
    maxOutputTokens: toNumberOrNull(entry?.max_output_tokens ?? entry?.maxOutputTokens),
    isFree: inferFree(entry),
    upstreamModelId: entry?.upstreamModelId || null,
    quotaFamily: entry?.quotaFamily || null,
  };
}

// Fetch upstream models for ONE connection via the existing discovery route.
// Never throws: returns { models, error, status }.
export async function fetchConnectionModels(connectionId, { fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const headers = await getInternalHeaders();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const res = await doFetch(
      `${baseUrl()}/api/providers/${encodeURIComponent(connectionId)}/models`,
      { headers, signal: controller.signal }
    );
    const text = await res.text().catch(() => "");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {
      return { models: [], error: "Upstream returned invalid JSON", status: res.status };
    }
    if (!res.ok) {
      const detail = data?.error;
      const message = typeof detail === "string" ? detail : `HTTP ${res.status}`;
      return { models: [], error: message.slice(0, 240), status: res.status };
    }
    const raw = Array.isArray(data) ? data : (data?.models || data?.data || []);
    if (!Array.isArray(raw)) return { models: [], error: "Upstream returned an unexpected shape", status: res.status };
    const provider = data?.provider || null;
    const models = [];
    for (const entry of raw) {
      const normalized = normalizeDiscoveredModel(entry, { provider, connectionId });
      if (normalized) models.push(normalized);
    }
    return { models, provider, error: data?.warning || null, status: res.status };
  } catch (err) {
    const message = err?.name === "AbortError" ? "Discovery timed out" : (err?.message || "Network error");
    return { models: [], error: String(message).slice(0, 240), status: null };
  } finally {
    clearTimeout(timer);
  }
}

// Multi-connection policy (documented):
// - Only active connections are eligible.
// - Union of models across connections, deduped by model id (first-seen wins,
//   all contributing connectionIds recorded). Never rely on array order.
// - Per-model connectionIds preserved for routing visibility.
export function mergeConnectionModels(perConnection) {
  const byId = new Map();
  for (const { connectionId, models } of perConnection) {
    for (const m of models || []) {
      if (!m?.id) continue;
      const existing = byId.get(m.id);
      if (existing) {
        if (!existing.connectionIds.includes(connectionId)) existing.connectionIds.push(connectionId);
      } else {
        byId.set(m.id, { ...m, connectionIds: [connectionId] });
      }
    }
  }
  return [...byId.values()];
}
