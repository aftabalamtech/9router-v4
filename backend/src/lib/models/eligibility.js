import { getBlockedModels } from "../db/index.js";

/**
 * Centralized server-side model eligibility.
 *
 * Two independent flags (both keyed `{providerAliasOrId: [modelId]}`):
 * - hidden  (disabledModels kv scope): removed from lists, requests still allowed.
 * - blocked (modelBlocks kv scope): removed from lists AND rejected at request time.
 *
 * Test status comes from modelTestRepo keyed by full "alias/model" string:
 * ok (passed) | error (failed/timeout) | untested (no record).
 */

export function splitModelRef(fullModel) {
  const s = String(fullModel || "");
  const slash = s.indexOf("/");
  if (slash <= 0) return { alias: "", id: s };
  return { alias: s.slice(0, slash), id: s.slice(slash + 1) };
}

export function isModelBlocked(provider, modelId, alias, blocks) {
  if (!blocks) return false;
  const keys = new Set([provider, alias].filter(Boolean));
  for (const key of keys) {
    const list = blocks[key];
    if (Array.isArray(list) && list.includes(modelId)) return true;
  }
  return false;
}

export function isModelHidden(provider, modelId, alias, hidden) {
  if (!hidden) return false;
  const keys = new Set([provider, alias].filter(Boolean));
  for (const key of keys) {
    const list = hidden[key];
    if (Array.isArray(list) && list.includes(modelId)) return true;
  }
  return false;
}

export async function loadBlocks() {
  try {
    return await getBlockedModels();
  } catch {
    return {};
  }
}

/**
 * Filter combo member model strings, dropping blocked ones.
 * @returns {{ eligible: string[], blocked: string[] }}
 */
export function partitionComboModels(models, blocks) {
  const eligible = [];
  const blocked = [];
  for (const m of models || []) {
    const { alias, id } = splitModelRef(m);
    if (isModelBlocked(alias, id, alias, blocks)) blocked.push(m);
    else eligible.push(m);
  }
  return { eligible, blocked };
}
