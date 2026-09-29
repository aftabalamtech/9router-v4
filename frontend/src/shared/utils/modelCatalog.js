// Shared model catalog builder.
//
// Single source of truth for the model-entry list rendered by the global Models
// page AND every provider detail page. Extracted from the Models page verbatim so
// the two can never disagree about which models exist or how they are keyed.
//
// The four sources, in the order they are consumed:
//   1. static catalog  (shared/constants/models)   — built-in models
//   2. synced catalog  (/api/models/synced)        — provider-sync discoveries
//   3. custom models   (/api/models/custom)        — user-defined
//   4. aliases         (/api/models/alias)         — models added via Add Model
//
// Dedupe rules (load-bearing — a duplicate here renders the same model twice and
// makes sync look like it creates duplicates):
//   - a synced entry that matches a static id is dropped
//   - a custom entry that matches a synced full-model is dropped
//   - an alias entry matching a static id, a synced full-model, or an already
//     emitted key is dropped
// First source to claim a key wins, which keeps stable, built-in entries from
// being shadowed by a synced row.
import { getModelsByProviderId } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  getProviderAlias,
  getProviderByAlias,
} from "@/shared/constants/providers";

export function kindOf(m) {
  return m.type || m.kinds?.[0] || "llm";
}

function idsIn(map, key) {
  const list = map?.[key];
  return Array.isArray(list) ? list : [];
}

function staticModelsFor(providerId) {
  try {
    return getModelsByProviderId(providerId) || [];
  } catch {
    return [];
  }
}

/**
 * Resolve the provider ids whose built-in catalogue is stored under
 * `storageAlias`.
 *
 * The provider detail page scopes the shared section to ONE provider by its
 * storage alias, and the catalogue is keyed by that alias ("ag" for
 * antigravity), not by provider id. Passing an empty provider list instead
 * silently produced ZERO built-in models on every provider page — only synced
 * and manually added models showed up, because the static-catalog loop has
 * nothing to iterate. This helper is what keeps the code-defined catalogue on
 * the provider page.
 *
 * A compatible node's storage alias IS its node id and is not in AI_PROVIDERS,
 * so it legitimately has no static catalogue and returns no ids.
 */
export function providerIdsForAlias(storageAlias, allIds) {
  const alias = String(storageAlias || "");
  if (!alias) return [];
  const ids = allIds || Object.keys(AI_PROVIDERS || {});
  const matched = ids.filter((id) => getProviderAlias(id) === alias);
  // The alias may itself be a provider id (many providers use id === alias).
  if (!matched.includes(alias) && AI_PROVIDERS?.[alias]) matched.push(alias);
  return matched;
}

/**
 * Build the flat model-entry list.
 *
 * @param {object} input
 * @param {object} input.connections  active/all connections from /api/providers
 * @param {Array}  input.customModels
 * @param {Array}  input.syncedModels
 * @param {object} input.modelAliases  { aliasName: fullModel }
 * @param {object} input.disabledMap   { providerAlias: [modelId] } (hidden)
 * @param {string} [input.providerFilter] "all" | "connected" | <providerId>
 * @param {string[]} [input.providerIds] restrict the candidate provider set
 * @returns {Array<object>} deduped model entries
 */
export function buildModelEntries({
  connections = [],
  customModels = [],
  syncedModels = [],
  modelAliases = {},
  disabledMap = {},
  providerFilter = "connected",
  providerIds,
  noAuthProviderIds,
}) {
  const allProviderIds =
    providerIds || Object.keys(AI_PROVIDERS || {});
  // Providers that need no credentials (opencode, the local TTS engines,
  // searxng) are usable with zero connections, so they must count as
  // "connected" — otherwise the default filter hides every one of their models.
  const noAuth = noAuthProviderIds || defaultNoAuthProviderIds();
  const connected = new Set(
    connections.filter((c) => c.isActive !== false).map((c) => c.provider)
  );
  for (const id of noAuth) connected.add(id);
  const connectedAliases = new Set(
    [...connected].map((id) => getProviderAlias(id))
  );

  const out = [];
  const seenKeys = new Set();
  const claim = (entry) => {
    if (seenKeys.has(entry.key)) return false;
    seenKeys.add(entry.key);
    out.push(entry);
    return true;
  };
  const isHidden = (alias, id) => idsIn(disabledMap, alias).includes(id);

  const candidates =
    providerFilter === "all"
      ? allProviderIds
      : providerFilter === "connected"
        ? allProviderIds.filter((id) => connected.has(id))
        : [providerFilter];
  const candidateAliases = new Set(candidates.map((id) => getProviderAlias(id)));
  // Accept a provider's entries when it is in the candidate set, either by
  // provider id or by storage alias (compatible nodes are keyed by node id).
  const admits = (storageAlias) =>
    providerFilter === "all" ||
    (providerFilter === "connected"
      ? connectedAliases.has(storageAlias)
      : candidateAliases.has(storageAlias) ||
        candidates.includes(storageAlias));

  // ── 1. Static catalog ───────────────────────────────────────────
  for (const providerId of candidates) {
    const alias = getProviderAlias(providerId);
    for (const m of staticModelsFor(providerId)) {
      claim({
        key: `${alias}/${m.id}`,
        providerId,
        providerAlias: alias,
        id: m.id,
        fullModel: `${alias}/${m.id}`,
        name: m.name || "",
        kind: kindOf(m),
        isFree: !!m.isFree,
        isCustom: false,
        isSynced: false,
        hidden: isHidden(alias, m.id),
        hasConnection: connected.has(providerId),
      });
    }
  }

  // Static ids per storage alias, used to dedupe the later sources.
  const hardcodedByAlias = {};
  for (const pid of allProviderIds) {
    hardcodedByAlias[getProviderAlias(pid)] = new Set(
      staticModelsFor(pid).map((m) => m.id)
    );
  }

  // ── 2. Provider-sync discovered models ──────────────────────────
  for (const m of syncedModels || []) {
    const storageAlias = m.storageAlias || m.providerAlias;
    if (!storageAlias || !m.id) continue;
    if (m.stale) continue; // upstream drops are never offered
    const fullModel = m.fullModel || `${storageAlias}/${m.id}`;
    if (!admits(storageAlias)) continue;
    if (hardcodedByAlias[storageAlias]?.has(m.id)) continue;
    const provider = getProviderByAlias(storageAlias);
    const providerId = provider?.id || storageAlias;
    claim({
      key: fullModel,
      providerId,
      providerAlias: storageAlias,
      id: m.id,
      fullModel,
      name: m.name || m.id,
      kind: kindOf(m),
      isFree: !!m.isFree,
      isCustom: true,
      isSynced: true,
      hidden: isHidden(storageAlias, m.id),
      hasConnection: provider ? connected.has(providerId) : true,
    });
  }

  // ── 3. Custom models ────────────────────────────────────────────
  for (const m of customModels || []) {
    if (!m.providerAlias || !m.id) continue;
    if (!admits(m.providerAlias)) continue;
    claim({
      key: `${m.providerAlias}/${m.id}`,
      providerId: m.providerAlias,
      providerAlias: m.providerAlias,
      id: m.id,
      fullModel: `${m.providerAlias}/${m.id}`,
      name: m.name || "",
      kind: m.type || "llm",
      isFree: false,
      isCustom: true,
      isSynced: false,
      hidden: isHidden(m.providerAlias, m.id),
      hasConnection: true,
    });
  }

  // ── 4. Alias-added models ───────────────────────────────────────
  const aliasNameOwner = new Map(); // alias name → fullModel (first wins)
  for (const [aliasName, fullModel] of Object.entries(modelAliases || {})) {
    if (typeof fullModel !== "string" || !fullModel.includes("/")) continue;
    const slash = fullModel.indexOf("/");
    const storageAlias = fullModel.slice(0, slash);
    const modelId = fullModel.slice(slash + 1);
    if (!modelId) continue;
    if (!admits(storageAlias)) continue;
    if (hardcodedByAlias[storageAlias]?.has(modelId)) continue;
    // Cross-provider alias collision: two providers may legitimately expose the
    // same short alias (e.g. both "qwen3.5-plus"). The FIRST alias record keeps
    // the name; later ones get a provider-scoped unique name so selecting the
    // short label never routes to the wrong provider.
    const key = aliasNameOwner.has(aliasName)
      ? `${storageAlias}/${aliasName}`
      : aliasName;
    aliasNameOwner.set(key, fullModel);
    const provider = getProviderByAlias(storageAlias);
    const providerId = provider?.id || storageAlias;
    claim({
      key: fullModel,
      providerId,
      providerAlias: storageAlias,
      id: modelId,
      fullModel,
      name: key,
      kind: "llm",
      isFree: /free/i.test(modelId),
      isCustom: true,
      isSynced: false,
      hidden: isHidden(storageAlias, modelId),
      hasConnection: provider ? connected.has(providerId) : true,
    });
  }

  return out;
}

function defaultNoAuthProviderIds() {
  return Object.entries(AI_PROVIDERS || {})
    .filter(([, p]) => p.noAuth)
    .map(([id]) => id);
}

/** Count what each provider option would actually show, for the filter select. */
export function buildProviderOptions({
  providerIds,
  connectedProviders,
  syncedModels = [],
  customModels = [],
  modelAliases = {},
}) {
  const extraByAlias = new Map();
  const bump = (alias) => {
    if (alias) extraByAlias.set(alias, (extraByAlias.get(alias) || 0) + 1);
  };
  for (const m of syncedModels) bump(m.storageAlias || m.providerAlias);
  for (const m of customModels) bump(m.providerAlias);
  for (const fullModel of Object.values(modelAliases)) {
    if (typeof fullModel === "string" && fullModel.includes("/")) {
      bump(fullModel.slice(0, fullModel.indexOf("/")));
    }
  }
  return (providerIds || [])
    .map((id) => {
      const alias = getProviderAlias(id);
      const n = staticModelsFor(id).length;
      return {
        id,
        alias,
        count: n + (extraByAlias.get(alias) || 0),
        connected: connectedProviders.has(id),
      };
    })
    .filter((p) => p.count > 0);
}

/** Map persisted test records ({ "alias/model": {status} }) to "ok"|"error". */
export function mapPersistedTestResults(results = {}) {
  const out = {};
  for (const [fullModel, r] of Object.entries(results || {})) {
    if (r?.status === "passed") out[fullModel] = "ok";
    else if (r?.status === "failed" || r?.status === "timeout")
      out[fullModel] = "error";
  }
  return out;
}

/**
 * Split capability-keyed test records ("<fullModel>#<capability>") out of the
 * flat map, returning { modelId, capabilities: { chat: { status, ... } } }.
 *
 * Without this the "#chat" keys would be treated as model ids, producing cards
 * for models that do not exist. A model's overall status is the WORST of its
 * tested capabilities, so a model that chats but fails embeddings does not
 * read as working.
 */
export function mapCapabilityResults(results = {}) {
  const out = {};
  for (const [key, record] of Object.entries(results || {})) {
    if (!key.includes("#")) continue;
    const hash = key.lastIndexOf("#");
    const fullModel = key.slice(0, hash);
    const capability = key.slice(hash + 1);
    if (!fullModel || !capability) continue;
    (out[fullModel] ||= {})[capability] = record;
  }
  return out;
}

/** Worst-of aggregation over per-capability records; mirrors the backend. */
export function aggregateCapabilityRecords(records) {
  const entries = Object.values(records || {});
  if (entries.length === 0) return { status: "untested", tested: false };
  const rank = { passed: 0, untested: 1, unsupported: 2, failed: 3, timeout: 3 };
  let worst = "passed";
  for (const record of entries) {
    const status = record?.status || "untested";
    if ((rank[status] ?? 1) > (rank[worst] ?? 1)) worst = status;
  }
  return { status: worst, tested: true };
}

/**
 * Map a provider's test results to BARE ids ({ "gpt-4o": "ok" }), which is what
 * the provider-page components (sync panel, disabled section, discovered list)
 * key on. Model ids may themselves contain slashes, so only the known storage
 * alias prefix is stripped.
 */
export function mapBareTestResults(results = {}, storageAlias) {
  const out = {};
  if (!storageAlias) return out;
  const prefix = `${storageAlias}/`;
  for (const [full, rec] of Object.entries(results || {})) {
    if (typeof full !== "string" || !full.startsWith(prefix)) continue;
    const status = typeof rec === "string" ? rec : rec?.status;
    const id = full.slice(prefix.length);
    if (status === "passed" || status === "ok") out[id] = "ok";
    else if (status === "failed" || status === "timeout" || status === "error")
      out[id] = "error";
  }
  return out;
}
