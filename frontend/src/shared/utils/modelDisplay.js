// Display helpers for model entries whose identity is "provider/modelId".
//
// Root cause of the "openai-compatible-chat-afecb65-10bf-4bba-8…" label bug:
// the Models page rendered `entry.fullModel` (e.g.
// `openai-compatible-chat-<uuid>/qwen/qwen3.5-plus:free`) as the PRIMARY row
// label. For custom providers the prefix is the opaque node id, so users saw
// a truncated UUID-ish string instead of the actual upstream model id.
//
// The upstream model id — never the provider prefix — is the meaningful part
// of a model's display label. The provider is already shown next to it
// (CUSTOM badge, provider filter, owned_by in /v1/models). Two custom
// providers can expose the same model id; the full identity stays available
// via tooltip + copy on the full `provider/model` string, so nothing is lost.

/**
 * Strip a known provider prefix from a full "provider/modelId" string.
 * Returns the bare model id. Only strips the EXACT prefix followed by "/" —
 * a model id that merely contains the provider text is left untouched.
 */
export function stripProviderPrefix(fullModel, providerAlias) {
  const full = String(fullModel || "");
  const prefix = String(providerAlias || "");
  if (!prefix) return full;
  return full.startsWith(`${prefix}/`) ? full.slice(prefix.length + 1) : full;
}

/**
 * Primary display label for a model row.
 * - a CUSTOM display name wins when it is meaningful (not just the id)
 * - otherwise the BARE upstream model id (provider prefix removed)
 * - falls back to the full id when no provider alias is known
 * Never returns a UUID-provider-prefixed string when a bare id is available.
 */
export function modelPrimaryLabel({ id, fullModel, providerAlias, name }) {
  const bare = providerAlias
    ? stripProviderPrefix(fullModel ?? id, providerAlias)
    : String(fullModel ?? id ?? "");
  const bareTrimmed = String(bare || "").trim();
  if (hasDistinctDisplayName(name, { id, fullModel })) return String(name).trim();
  if (bareTrimmed) return bareTrimmed;
  return String(fullModel || id || "");
}

/**
 * True when a stored model `name` is a real label worth showing instead of
 * the id. Guards against the historic bug of names that were just the id or
 * the full "provider/model" string duplicated into the name field.
 */
export function hasDistinctDisplayName(name, { id, fullModel } = {}) {
  const n = String(name || "").trim();
  if (!n) return false;
  const candidates = [id, fullModel].map((v) => String(v || "").trim()).filter(Boolean);
  return !candidates.includes(n);
}
