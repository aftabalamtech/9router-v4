// Provider upstream-model capabilities.
//
// Single source of truth for "can this provider be discovered / imported from
// /models?". Previously this knowledge was implicit: the dashboard assumed every
// provider could be synced, and only found out at request time — clicking Sync
// on a provider with no catalog endpoint produced a confusing failure. The UI
// reads this map to omit or disable the controls with an explanation, and the
// /models route imports the same list so the two can never drift.
//
// This is about PROVIDERS. Per-MODEL capabilities (what one model can do) live
// in modelCapabilities.js — a different question, deliberately not merged.

export const MODEL_DISCOVERY_PROVIDERS = Object.freeze([
  // OAuth / session providers
  "claude",
  "antigravity",
  "codex",
  "github",
  "gemini-cli",
  "kiro",
  "qoder",
  // API-key providers
  "openai",
  "openrouter",
  "anthropic",
  "gemini",
  "qwen",
  "alicode",
  "alicode-intl",
  "volcengine-ark",
  "byteplus",
  "deepseek",
  "groq",
  "xai",
  "mistral",
  "perplexity",
  "together",
  "fireworks",
  "cerebras",
  "cohere",
  "nebius",
  "siliconflow",
  "hyperbolic",
  "ollama",
  "ollama-local",
  "nanobanana",
  "chutes",
  "nvidia",
  "assemblyai",
  "vercel-ai-gateway",
  "codebuddy",
  "cb",
]);

// Credential-free providers: their catalog is public, so they are synced from
// it without any connection. Kept separate from the map above because a
// no-auth provider is syncable even though /models is not routed per-connection.
export const NO_AUTH_DISCOVERY_PROVIDERS = Object.freeze(["opencode"]);

const discoverySet = new Set(MODEL_DISCOVERY_PROVIDERS);
const noAuthSet = new Set(NO_AUTH_DISCOVERY_PROVIDERS);

/**
 * @param {string} providerId
 * @param {object} [options]
 * @param {boolean} [options.isOpenAICompatible]
 * @param {boolean} [options.isAnthropicCompatible]
 * @returns {{ supportsDiscovery: boolean, supportsImport: boolean,
 *            reason: string|null }}
 *   supportsDiscovery — the sync engine can build a catalog for this provider.
 *   supportsImport    — GET /api/providers/<connectionId>/models is routed.
 */
export function getModelCapabilities(providerId, options = {}) {
  const { isOpenAICompatible, isAnthropicCompatible } = options || {};
  // A compatible node is a user-configured upstream, so it is probed directly.
  if (isOpenAICompatible || isAnthropicCompatible) {
    return { supportsDiscovery: true, supportsImport: true, reason: null };
  }
  if (noAuthSet.has(providerId)) {
    return { supportsDiscovery: true, supportsImport: false, reason: null };
  }
  if (discoverySet.has(providerId)) {
    return { supportsDiscovery: true, supportsImport: true, reason: null };
  }
  return {
    supportsDiscovery: false,
    supportsImport: false,
    reason:
      `${providerId} does not expose an upstream model catalog, so there is nothing to sync or import. Add models manually instead.`,
  };
}
