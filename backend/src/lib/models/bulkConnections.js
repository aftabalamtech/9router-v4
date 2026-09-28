// Bulk connection creation (shared, pure planning layer).
//
// POST /api/providers accepts one connection at a time. Bulk import of many
// keys therefore needed N sequential HTTP round-trips from the browser, with
// per-request auth headers, and any network hiccup lost the whole batch's
// progress. This module is the pure core used by the route: it validates
// entries, resolves names and reports per-entry outcomes without ever
// persisting anything itself.
//
// Security: error strings are built from names/positions only. API keys are
// returned to the caller solely so it can write them through the existing
// createProviderConnection path — they are never logged, never echoed in a
// response body and never included in an error message.

import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "../../shared/constants/providers.js";

export const MAX_BULK_CONNECTIONS = 500;
const MAX_KEY_LENGTH = 512;
const MIN_KEY_LENGTH = 4;

export function isCustomProviderId(providerId) {
  return isOpenAICompatibleProvider(providerId)
    || isAnthropicCompatibleProvider(providerId)
    || isCustomEmbeddingProvider(providerId);
}

function validateKeyShape(key) {
  if (typeof key !== "string") return "missing key";
  if (!key.trim()) return "missing key";
  if (key.length > MAX_KEY_LENGTH) return "key too long";
  if (key.length < MIN_KEY_LENGTH) return "key too short";
  if (/\s/.test(key)) return "key contains whitespace";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return "key contains control characters";
  return null;
}

/**
 * Validate a batch of `{ name?, apiKey, priority?, isActive? }` entries.
 *
 * @param {Array} entries
 * @param {object} [options]
 * @param {Array<{name?:string,apiKey?:string}>} [options.existingConnections]
 *        existing connections of this provider, for duplicate detection
 * @param {string} [options.defaultNamePrefix] provider name used to auto-name
 * @returns {{ valid: Array, invalid: Array<{index:number,error:string,name?:string}>,
 *             duplicates: Array<{index:number,error:string,name?:string}> }}
 */
export function planBulkConnections(entries, { existingConnections = [], defaultNamePrefix = "Key" } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const valid = [];
  const invalid = [];
  const duplicates = [];

  // Duplicate detection uses the exact key value in a Set. The value is never
  // emitted in any result object.
  const existingKeys = new Set(
    (existingConnections || [])
      .map((c) => c?.apiKey)
      .filter((k) => typeof k === "string" && k)
  );
  const existingNames = new Set(
    (existingConnections || [])
      .map((c) => c?.name)
      .filter((n) => typeof n === "string" && n)
  );
  const seenKeys = new Set();
  const usedNames = new Set(existingNames);

  if (list.length > MAX_BULK_CONNECTIONS) {
    invalid.push({ index: 0, error: `Too many connections (max ${MAX_BULK_CONNECTIONS})` });
    return { valid, invalid, duplicates };
  }

  list.forEach((entry, index) => {
    const apiKey = typeof entry?.apiKey === "string" ? entry.apiKey.trim() : "";
    const requestedName = typeof entry?.name === "string" ? entry.name.trim() : "";

    const shapeError = validateKeyShape(apiKey);
    if (shapeError) {
      invalid.push({
        index,
        name: requestedName || undefined,
        error: `Invalid entry: ${shapeError}`,
      });
      return;
    }

    // Key already configured for this provider, or repeated in this batch.
    if (existingKeys.has(apiKey) || seenKeys.has(apiKey)) {
      duplicates.push({
        index,
        name: requestedName || undefined,
        error: existingKeys.has(apiKey)
          ? "Duplicate key (already configured for this provider)"
          : "Duplicate key in this paste",
      });
      return;
    }
    seenKeys.add(apiKey);

    // The connections table dedups API-key connections on (authType, name), so
    // reusing a name would silently UPDATE the existing connection and replace
    // its credential. Disambiguate instead of losing the key.
    let name = requestedName || `${defaultNamePrefix} ${index + 1}`;
    if (usedNames.has(name)) {
      let n = 2;
      while (usedNames.has(`${name} ${n}`)) n += 1;
      name = `${name} ${n}`;
    }
    usedNames.add(name);

    valid.push({
      index,
      name,
      apiKey,
      priority: Number.isFinite(entry?.priority) ? entry.priority : index + 1,
      isActive: entry?.isActive !== false,
    });
  });

  return { valid, invalid, duplicates };
}

/** Public summary for the client — contains counts and reasons, never keys. */
export function summarizeBulkPlan({ valid = [], invalid = [], duplicates = [] }) {
  return {
    total: valid.length + invalid.length + duplicates.length,
    valid: valid.length,
    invalid: invalid.length,
    duplicates: duplicates.length,
    errors: [...invalid, ...duplicates],
  };
}
