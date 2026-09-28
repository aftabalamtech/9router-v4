// Custom-provider display naming.
//
// ROOT CAUSE of the "shows `OpenAI Compatible` / `openai-compatible-chat-<uuid>`
// instead of `Xkiro`" bug: a custom provider's identity is its NODE record
// (providerNodes table), but `AI_PROVIDERS` is a static registry that knows
// nothing about nodes. Every consumer therefore had to re-implement a
// node-lookup fallback, and most of them skipped it.
//
// This module is the single place that answers "what is this provider called?".
// It is pure (no fetch, no DB) so it works identically in the list page, the
// detail page, the model selector, the playground and test-result views, and it
// is unit-testable.

import { AI_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "../constants/providers.js";

const TYPE_LABELS = {
  "openai-compatible": "OpenAI Compatible",
  "anthropic-compatible": "Anthropic Compatible",
  "custom-embedding": "Custom Embedding",
};

/** True for a provider id backed by a custom-provider node record. */
export function isCustomProviderId(providerId) {
  return isOpenAICompatibleProvider(providerId)
    || isAnthropicCompatibleProvider(providerId)
    || isCustomEmbeddingProvider(providerId);
}

/**
 * Build a lookup map from providerId → configured node name.
 * @param {Array<{id:string,name?:string,type?:string}>} providerNodes
 * @returns {Record<string,string>}
 */
export function buildNodeNameMap(providerNodes) {
  const out = {};
  for (const node of providerNodes || []) {
    if (!node?.id) continue;
    const label = typeof node.name === "string" ? node.name.trim() : "";
    if (label) out[node.id] = label;
  }
  return out;
}

/**
 * Resolve the display name for a provider.
 *
 * Precedence (custom providers):
 *   1. explicit `override` (e.g. a user-entered node name from the API)
 *   2. connection-level configured name (`connection.providerSpecificData.nodeName`)
 *   3. the node record's name from `nodeNames`
 *   4. the connection's own name when it is not the opaque node id
 *   5. the generic type label ("OpenAI Compatible") — never the raw id
 *
 * Built-in providers resolve from AI_PROVIDERS exactly as before, so this is a
 * drop-in for `AI_PROVIDERS[id]?.name`.
 */
export function getProviderDisplayName(providerId, {
  nodeNames = {},
  connection = null,
  node = null,
  override = null,
  providerNodes = null,
} = {}) {
  const id = String(providerId || "");

  // Allow callers to pass the node array directly.
  let names = nodeNames;
  if (!names || Object.keys(names).length === 0) {
    if (Array.isArray(providerNodes)) names = buildNodeNameMap(providerNodes);
  }
  const nodeName = node?.name ? String(node.name).trim() : "";
  const connectionNodeName = connection?.providerSpecificData?.nodeName
    ? String(connection.providerSpecificData.nodeName).trim()
    : "";
  const connectionName = connection?.name ? String(connection.name).trim() : "";

  if (override && String(override).trim()) return String(override).trim();

  if (isCustomProviderId(id)) {
    return nodeName
      || connectionNodeName
      || names[id]
      || (connectionName && connectionName !== id ? connectionName : "")
      || TYPE_LABELS[node?.type] || TYPE_LABELS[typeFromId(id)]
      || "Custom Provider";
  }

  // Built-in provider: keep the static registry as the source of truth, but
  // allow a node name to override a missing entry.
  const staticName = AI_PROVIDERS[id]?.name;
  if (staticName) return staticName;
  return nodeName || names[id] || connectionName || id;
}

function typeFromId(id) {
  if (isAnthropicCompatibleProvider(id)) return "anthropic-compatible";
  if (isCustomEmbeddingProvider(id)) return "custom-embedding";
  if (isOpenAICompatibleProvider(id)) return "openai-compatible";
  return null;
}

/** Color / text icon defaults for a custom provider node. */
export function getCustomProviderVisuals(providerId, node) {
  const isAnthropic = isAnthropicCompatibleProvider(providerId) || node?.type === "anthropic-compatible";
  const isEmbedding = isCustomEmbeddingProvider(providerId) || node?.type === "custom-embedding";
  return {
    color: isAnthropic ? "#D97757" : isEmbedding ? "#10A37F" : "#10A37F",
    textIcon: isAnthropic ? "AC" : isEmbedding ? "CE" : "OC",
  };
}

/**
 * Model label for display. Prefers a real model name, then the upstream id.
 * NEVER invents a name from the provider id — the whole point of this fix.
 */
export function getModelDisplayName(model, fallbackId) {
  if (!model) return fallbackId || "";
  if (typeof model === "string") return model;
  const name = model.name || model.displayName || model.display_name;
  if (typeof name === "string" && name.trim()) return name.trim();
  return model.id || fallbackId || "";
}
