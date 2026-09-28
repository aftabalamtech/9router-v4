// OpenAI/Anthropic-compatible base-URL normalization.
//
// Custom ("compatible") providers are third-party OpenAI-compatible services,
// so users paste whatever their vendor shows them: sometimes
// `https://host/v1`, sometimes the full `https://host/v1/chat/completions`,
// sometimes with a trailing slash. Every code path that builds a URL for such a
// provider (chat execution, /models discovery, connection test, node
// validation) previously normalized independently and inconsistently, which
// produced doubled paths like `.../v1/chat/completions/chat/completions` and
// `.../models/models`.
//
// This module is the single source of truth. It is pure so it is testable and
// identical on every deployment (SQLite/PostgreSQL do not matter here).

export const COMPATIBLE_KIND = Object.freeze({
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  EMBEDDING: "embedding",
});

const ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/responses",
  "/models",
  "/messages",
  "/embeddings",
  "/v1/models",
];

function kindOf(providerId = "") {
  const id = String(providerId || "");
  if (id.startsWith("anthropic-compatible-")) return COMPATIBLE_KIND.ANTHROPIC;
  if (id.startsWith("custom-embedding-")) return COMPATIBLE_KIND.EMBEDDING;
  return COMPATIBLE_KIND.OPENAI;
}

// `openai-compatible-chat-<uuid>` / `openai-compatible-responses-<uuid>` carry
// the API type inside the node id (see routes/provider-nodes/route.ts).
export function apiTypeOf(providerId = "") {
  const id = String(providerId || "");
  if (id.startsWith("openai-compatible-responses-") || id.startsWith("openai-compatible-chat-")) {
    return id.includes("-responses-") ? "responses" : "chat";
  }
  return null;
}

/**
 * Normalize a configured base URL into a prefix that endpoints can be
 * appended to. Never appends `/v1` — self-hosted gateways legitimately live at
 * the root, and the user is responsible for the version segment.
 *
 * - trims whitespace and trailing slashes
 * - strips a pasted endpoint suffix (repeatedly, e.g. `.../v1/chat/completions`)
 * - rejects non-http(s) URLs and anything with credentials embedded
 */
export function normalizeCompatibleBaseUrl(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(value)) value = `https://${value}`;
    else return "";
  }
  // Strip userinfo entirely — credentials must never travel inside a base URL
  // (they would end up in logs, error text and the /v1/models output).
  value = value.replace(/^(https?:\/\/)[^/@]*@/i, "$1");
  let changed = true;
  while (changed) {
    changed = false;
    const trimmed = value.replace(/\/+$/, "");
    for (const suffix of ENDPOINT_SUFFIXES) {
      if (trimmed.toLowerCase().endsWith(suffix)) {
        value = trimmed.slice(0, trimmed.length - suffix.length).replace(/\/+$/, "");
        changed = true;
        break;
      }
    }
    if (!changed) value = trimmed;
  }
  return value;
}

export function isValidCompatibleBaseUrl(raw) {
  const normalized = normalizeCompatibleBaseUrl(raw);
  if (!normalized) return false;
  try {
    const url = new URL(normalized);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Chat/Responses/Messages endpoint for a compatible provider. */
export function buildCompatibleChatUrl(rawBaseUrl, providerId = "") {
  const base = normalizeCompatibleBaseUrl(rawBaseUrl);
  if (!base) return "";
  const kind = kindOf(providerId);
  if (kind === COMPATIBLE_KIND.ANTHROPIC) return `${base}/messages`;
  return apiTypeOf(providerId) === "responses" ? `${base}/responses` : `${base}/chat/completions`;
}

/** Model-catalog endpoint for a compatible provider. */
export function buildCompatibleModelsUrl(rawBaseUrl, providerId = "") {
  const base = normalizeCompatibleBaseUrl(rawBaseUrl);
  if (!base) return "";
  return kindOf(providerId) === COMPATIBLE_KIND.ANTHROPIC ? `${base}/models` : `${base}/models`;
}

/** Embeddings endpoint for a custom-embedding node. */
export function buildCompatibleEmbeddingsUrl(rawBaseUrl) {
  const base = normalizeCompatibleBaseUrl(rawBaseUrl);
  return base ? `${base}/embeddings` : "";
}
