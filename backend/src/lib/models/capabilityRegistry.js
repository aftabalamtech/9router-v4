// Per-model capability testing + registration.
//
// A model may support SEVERAL capabilities, and each capability has its own
// result. Storing one status per model (the previous design) meant a passing
// chat test marked an untested embedding model as working. Results are
// therefore keyed "<fullModel>#<capability>", with the model's declared
// capability set alongside.
//
// STORAGE
//   modelCapabilities kv : "<fullModel>" -> { capabilities, prefix, ... }
//   modelTestResults  kv : "<fullModel>#<capability>" -> { status, ... }
// Both are pre-existing kv scopes, so this adds no table and no migration, and
// behaves identically on SQLite and PostgreSQL.

import { makeKv } from "../db/helpers/kvStore.js";
import { saveModelTestResult, getModelTestResults, clearModelTestResults } from "./modelTestRepo.js";
import { runCapabilityTest, ERROR_CODES } from "./capabilityTest.js";
import {
  normalizeCapabilities,
  normalizeCapability,
  capabilitiesFromType,
  TEST_STATUS,
  CAPABILITY_KEY_SEP,
  splitRegisteredId,
  buildRegisteredId,
  isValidPrefix,
  isValidModelId,
} from "../../shared/constants/modelCapabilities.js";

// The registered-id helpers live in the shared constants module so the Add
// Model modal, the registration route and the router all compose and validate
// ids with ONE implementation. Re-exported here because this module is the
// backend entry point for them.
export {
  CAPABILITY_KEY_SEP,
  splitRegisteredId,
  buildRegisteredId,
  isValidPrefix,
  isValidModelId,
};

const capabilitiesKv = makeKv("modelCapabilities");

// ── Capability declarations ──────────────────────────────────────

/**
 * Record the capabilities a model supports. Idempotent: re-adding the same
 * model never overwrites a configuration the user made by hand, and never
 * wipes test history.
 *
 * @returns {Promise<{registeredId, created, capabilities, reason?}>}
 */
export async function registerModelCapabilities(registeredId, capabilities, extra = {}) {
  const id = String(registeredId || "").trim();
  if (!id) return { registeredId: id, created: false, capabilities: [], reason: "Registered id required" };
  const { prefix, modelId, valid } = splitRegisteredId(id);
  if (!valid) return { registeredId: id, created: false, capabilities: [], reason: "Registered id must be \"<prefix>/<modelId>\"" };
  if (!isValidPrefix(prefix)) return { registeredId: id, created: false, capabilities: [], reason: `Invalid prefix "${prefix}"` };
  if (!isValidModelId(modelId)) return { registeredId: id, created: false, capabilities: [], reason: "Invalid model id" };

  const normalized = normalizeCapabilities(capabilities);
  const existing = await capabilitiesKv.get(id, null);

  if (existing) {
    // Merge, never replace: a model re-added without capabilities keeps the
    // ones it had. This is what makes a duplicate add non-destructive.
    const merged = normalizeCapabilities([...(existing.capabilities || []), ...normalized]);
    const patch = {};
    if (merged.length > 0 && merged.join("|") !== (existing.capabilities || []).join("|")) {
      patch.capabilities = merged;
    }
    if (extra.displayName && !existing.displayName) patch.displayName = extra.displayName;
    if (extra.endpoint && !existing.endpoint) patch.endpoint = extra.endpoint;
    if (extra.settings && !existing.settings) patch.settings = extra.settings;
    if (Object.keys(patch).length > 0) {
      await capabilitiesKv.set(id, { ...existing, ...patch, updatedAt: new Date().toISOString() });
    }
    return { registeredId: id, created: false, capabilities: merged.length ? merged : (existing.capabilities || []) };
  }

  await capabilitiesKv.set(id, {
    capabilities: normalized,
    // A model with no declared capability is treated as chat, matching the
    // legacy single-`type` catalogue, rather than as having no capabilities.
    types: normalized.length ? normalized : capabilitiesFromType(extra.type),
    displayName: extra.displayName || "",
    endpoint: extra.endpoint || "",
    settings: extra.settings || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { registeredId: id, created: true, capabilities: normalized };
}

export async function getModelCapabilitiesRecord(registeredId) {
  if (!registeredId) return null;
  return capabilitiesKv.get(registeredId, null);
}

/** Remove ONE capability record. Never touches the alias or test history. */
export async function removeModelCapabilities(registeredId) {
  if (!registeredId) return false;
  const existing = await capabilitiesKv.get(registeredId, null);
  if (!existing) return false;
  await capabilitiesKv.remove(registeredId);
  return true;
}

/** All registered models, optionally scoped to one prefix. */
export async function listModelCapabilities(prefix = null) {
  const all = await capabilitiesKv.getAll();
  if (!prefix) return all;
  const scoped = {};
  for (const [id, value] of Object.entries(all || {})) {
    if (splitRegisteredId(id).prefix === prefix) scoped[id] = value;
  }
  return scoped;
}

/**
 * Declared capabilities for a model, falling back to its legacy `type` so
 * models that predate this system still report something sensible.
 */
export function resolveCapabilities(record, fallbackType) {
  const declared = normalizeCapabilities(record?.capabilities);
  if (declared.length > 0) return declared;
  return capabilitiesFromType(record?.types?.[0] || fallbackType);
}

// ── Per-capability test results ──────────────────────────────────

export function capabilityResultKey(registeredId, capability) {
  return `${registeredId}${CAPABILITY_KEY_SEP}${normalizeCapability(capability) || "unknown"}`;
}

/**
 * Persist a result for ONE capability of a model.
 *
 * Storing per capability is the fix for "a successful test for one capability
 * must not mark every other capability as working". A record is only written
 * for the capability actually tested.
 */
export async function saveCapabilityTestResult(registeredId, capability, result) {
  const key = capabilityResultKey(registeredId, capability);
  const capabilityId = normalizeCapability(capability);
  // "unsupported" is a real, distinct outcome: the provider does not offer
  // this operation. It must not be recorded as an error.
  const status = result.status === TEST_STATUS.UNSUPPORTED
    ? "unsupported"
    : result.ok
      ? "passed"
      : result.status === "timeout"
        ? "timeout"
        : "failed";
  await saveModelTestResult(key, {
    status,
    latencyMs: result.latencyMs ?? null,
    errorCode: result.errorCode ?? null,
    // Sanitize before persisting: never store an Authorization header or a raw
    // upstream page that may reflect credentials back.
    errorMessage: result.error ? sanitizeErrorMessage(result.error) : null,
    testedAt: result.testedAt || new Date().toISOString(),
    capability: capabilityId,
    // Retained so existing consumers that read model-level records keep working.
    registeredId,
  });
  return { key, status };
}

const REDACTIONS = [
  // Authorization headers and bearer tokens, in any casing, are the main risk.
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // Common key shapes, so a key echoed in an upstream body never lands in the DB.
  /\b(sk|pk|rk|api|key)[-_][A-Za-z0-9._-]{16,}\b/gi,
  /\b[A-Za-z0-9._-]*(secret|token|password|apiKey|api_key)[A-Za-z0-9._-]*\s*[:=]\s*[^\s,;"']{6,}/gi,
];

/** Strip credentials from an error message before it is stored or displayed. */
export function sanitizeErrorMessage(message) {
  if (typeof message !== "string" || !message) return message ?? null;
  let out = message;
  for (const re of REDACTIONS) out = out.replace(re, "$1[redacted]");
  return out.slice(0, 500);
}

/**
 * Aggregate per-capability records into a per-model view.
 *
 * The model's overall status is the WORST of its tested capabilities — a model
 * that chats fine but fails embeddings is not "working" as a whole. A model
 * with only untested capabilities stays "untested"; it is never promoted to
 * working by default.
 */
export function aggregateCapabilityStatus(records) {
  const byCapability = {};
  for (const record of records || []) {
    const capability = normalizeCapability(record?.capability);
    if (!capability) continue;
    byCapability[capability] = record;
  }
  const entries = Object.entries(byCapability);
  if (entries.length === 0) {
    return { status: TEST_STATUS.UNTESTED, capabilities: {}, worst: TEST_STATUS.UNTESTED };
  }
  const rank = {
    [TEST_STATUS.WORKING]: 0,
    [TEST_STATUS.UNTESTED]: 1,
    [TEST_STATUS.UNSUPPORTED]: 2,
    [TEST_STATUS.ERROR]: 3,
  };
  const fromStatus = (s) => (s === "passed" ? TEST_STATUS.WORKING
    : s === "unsupported" ? TEST_STATUS.UNSUPPORTED
      : s === "failed" || s === "timeout" ? TEST_STATUS.ERROR
        : TEST_STATUS.UNTESTED);

  let worst = TEST_STATUS.WORKING;
  for (const [capability, record] of entries) {
    const status = fromStatus(record.status);
    if ((rank[status] ?? 1) > (rank[worst] ?? 1)) worst = status;
  }
  return { status: worst, capabilities: byCapability, worst };
}

/** All capability test records, grouped by model id. */
export async function getCapabilityTestResults(prefix = null) {
  const raw = await getModelTestResults();
  const grouped = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (!key.includes(CAPABILITY_KEY_SEP)) continue; // legacy model-level record
    const hash = key.lastIndexOf(CAPABILITY_KEY_SEP);
    const registeredId = key.slice(0, hash);
    if (prefix && splitRegisteredId(registeredId).prefix !== prefix) continue;
    (grouped[registeredId] ||= []).push(value);
  }
  return grouped;
}

// ── Test orchestration ───────────────────────────────────────────

/**
 * Test one model for one capability (or every declared capability).
 *
 * @returns {Promise<{registeredId, capability, ok, status, error, errorCode, latencyMs, results}>}
 */
export async function testModelCapability(registeredId, capability, options = {}) {
  const id = String(registeredId || "").trim();
  const { valid } = splitRegisteredId(id);
  if (!valid) {
    return { registeredId: id, ok: false, status: "error", error: "Registered id must be \"<prefix>/<modelId>\"", errorCode: ERROR_CODES.INVALID_REQUEST };
  }

  const record = await getModelCapabilitiesRecord(id);
  const declared = resolveCapabilities(record, options.type);
  const target = capability ? normalizeCapability(capability) : (declared[0] || "chat");
  if (!target) {
    return { registeredId: id, ok: false, status: "error", error: "No capability to test", errorCode: ERROR_CODES.INVALID_REQUEST };
  }

  const settings = { ...(record?.settings || {}), ...(options.settings || {}) };
  const result = await runCapabilityTest(id, target, { ...options, settings });

  // An unsupported operation is recorded as unsupported, NOT as an error: a
  // provider that has no /v1/rerank has not "failed" anything.
  if (!result.ok && result.errorCode === ERROR_CODES.UNSUPPORTED) {
    result.status = TEST_STATUS.UNSUPPORTED;
  }

  if (options.persist !== false) {
    await saveCapabilityTestResult(id, target, result);
  }
  return { ...result, registeredId: id, status: result.status || (result.ok ? "passed" : "error") };
}

/** Test every declared capability of a model, sequentially (they may be slow). */
export async function testModelAllCapabilities(registeredId, options = {}) {
  const record = await getModelCapabilitiesRecord(registeredId);
  const declared = resolveCapabilities(record, options.type);
  const targets = declared.length ? declared : ["chat"];
  const results = [];
  for (const capability of targets) {
    if (options.isCancelled?.()) break;
    results.push(await testModelCapability(registeredId, capability, { ...options, persist: true }));
  }
  const aggregate = aggregateCapabilityStatus(results);
  return { registeredId, results, status: aggregate.status };
}
