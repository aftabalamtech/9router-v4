import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import PropTypes from "prop-types";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { ConfirmModal } from "@/shared/components";
import {
  isModelBlocked,
  matchesStatusFilter,
} from "@/shared/utils/modelEligibility";
import {
  modelPrimaryLabel,
  hasDistinctDisplayName,
} from "@/shared/utils/modelDisplay";
import { cachedJson, invalidateCache } from "@/shared/utils/cachedJson";
import {
  buildModelEntries,
  buildProviderOptions,
  providerIdsForAlias,
  mapPersistedTestResults,
  mapCapabilityResults,
  aggregateCapabilityRecords,
} from "@/shared/utils/modelCatalog";
import { normalizeCapability } from "@/shared/constants/modelCapabilities";
import ModelBatchTest from "@/pages/providers/components/ModelBatchTest";
import ModelCompatibilityModal from "./ModelCompatibilityModal";

const PAGE_SIZE = 100;

// ── AvailableModelsSection ────────────────────────────────────────
// ONE model-management surface, used by the global Models page and by every
// provider detail page. Extracted from the Models page so both render the same
// cards, run the same filters and hit the same endpoints — a provider page no
// longer has its own model list that can drift from the global one.
//
// `storageAlias` scopes the section to a single provider (provider pages). When
// set, the provider <select> is hidden and the "All / Hide all" bulk actions
// only ever touch that provider.
//
// The component owns its data fetching so both callers behave identically; the
// shared `cachedJson` cache means mounting it on a provider page does not
// refire the same GETs the Models page already made.
export default function AvailableModelsSection({
  storageAlias = null,
  onAddModelClick = null,
  addModelLabel = "Add Model",
  headerTitle = "Available Models",
  onDataChange = null,
}) {
  const { copied, copy } = useCopyToClipboard();
  const [connections, setConnections] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [syncedModels, setSyncedModels] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [disabledMap, setDisabledMap] = useState({});
  const [blocksMap, setBlocksMap] = useState({});
  const [testResults, setTestResults] = useState({});
  // Per-capability results, keyed "<fullModel>#<capability>". Kept apart from
  // the legacy model-level map so a chat pass never marks embeddings working.
  const [capabilityResults, setCapabilityResults] = useState({});
  const [testingIds, setTestingIds] = useState([]);
  const [singleTestingIds, setSingleTestingIds] = useState([]);
  const inflightSingleRef = useRef(null);
  if (inflightSingleRef.current === null) inflightSingleRef.current = new Set();
  const [compatEntry, setCompatEntry] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(null);
  const [notice, setNotice] = useState(null); // { type, text }

  const [providerFilter, setProviderFilter] = useState("connected");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [visibility, setVisibility] = useState("all"); // all | visible | hidden
  const [statusFilter, setStatusFilter] = useState("all"); // all|working|error|hidden|disabled
  const [price, setPrice] = useState("all"); // all | free | paid
  const [freeFirst, setFreeFirst] = useState(false);
  const [autoHideFailed, setAutoHideFailed] = useState(false);

  const showNotice = useCallback((type, text) => setNotice({ type, text }), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const providerIds = useMemo(() => Object.keys(AI_PROVIDERS || {}), []);

  const refresh = useCallback(async ({ force = false } = {}) => {
    // cachedJson dedupes in-flight requests and reuses recent reads, so
    // remounting (every tab switch) does not refire all seven GETs.
    const read = (url) => cachedJson(url, { force });
    try {
      const [connRes, customRes, disRes, blockRes, resRes, aliasRes, syncRes] =
        await Promise.all([
          read("/api/providers"),
          read("/api/models/custom"),
          read("/api/models/disabled"),
          read("/api/models/blocks"),
          read("/api/models/test-results"),
          read("/api/models/alias"),
          read("/api/models/synced"),
        ]);
      if (connRes.ok) setConnections(connRes.data.connections || []);
      if (customRes.ok) setCustomModels(customRes.data.models || []);
      if (syncRes.ok) setSyncedModels(syncRes.data.models || []);
      if (aliasRes.ok) setModelAliases(aliasRes.data.aliases || {});
      if (disRes.ok) setDisabledMap(disRes.data.disabled || {});
      if (blockRes.ok) setBlocksMap(blockRes.data.blocked || {});
      if (resRes.ok) {
        const raw = resRes.data.results || {};
        setTestResults(mapPersistedTestResults(raw));
        setCapabilityResults(mapCapabilityResults(raw));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Tell the parent when our data changed so it can invalidate its own caches
  // (provider page keeps its own alias/synced/disabled snapshots in sync).
  useEffect(() => {
    if (!onDataChange) return;
    onDataChange({ modelAliases, syncedModels, disabledMap, testResults });
  }, [onDataChange, modelAliases, syncedModels, disabledMap, testResults]);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [providerFilter, visibility, statusFilter, price, freeFirst]);

  // When scoped to one provider, "connected" means that provider specifically —
  // including compatible nodes, which have no entry in AI_PROVIDERS at all.
  const effectiveFilter = storageAlias
    ? "__scoped__"
    : providerFilter;

  const noAuthProviderIds = useMemo(
    () =>
      new Set(
        Object.entries(AI_PROVIDERS)
          .filter(([, p]) => p.noAuth)
          .map(([id]) => id)
      ),
    []
  );

  const connectedProviders = useMemo(() => {
    const set = new Set(
      connections.filter((c) => c.isActive !== false).map((c) => c.provider)
    );
    for (const id of noAuthProviderIds) set.add(id);
    return set;
  }, [connections, noAuthProviderIds]);

  const allEntries = useMemo(() => {
    if (storageAlias) {
      // A provider page is scoped to one provider. The candidate list MUST
      // still contain that provider's id, otherwise the static (code-defined)
      // catalogue loop has nothing to iterate and the page renders zero
      // built-in models. Compatible nodes resolve to no ids, which is correct:
      // they have no built-in catalogue.
      const scopedProviderIds = providerIdsForAlias(storageAlias, providerIds);
      return buildModelEntries({
        connections,
        customModels,
        syncedModels,
        modelAliases,
        disabledMap,
        providerFilter: "all",
        providerIds: scopedProviderIds,
      }).filter((e) => e.providerAlias === storageAlias);
    }
    return buildModelEntries({
      connections,
      customModels,
      syncedModels,
      modelAliases,
      disabledMap,
      providerFilter: effectiveFilter,
      providerIds,
      noAuthProviderIds,
    });
  }, [
    storageAlias,
    connections,
    customModels,
    syncedModels,
    modelAliases,
    disabledMap,
    effectiveFilter,
    providerIds,
    noAuthProviderIds,
  ]);

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    let list = allEntries
      .map((e) => {
        const ts = testResults[e.key];
        const perCapability = capabilityResults[e.key];
        // Per-capability records take precedence when present: a model whose
        // embeddings failed must not show green just because chat passed.
        const aggregate = perCapability
          ? aggregateCapabilityRecords(perCapability)
          : null;
        const status = aggregate?.tested
          ? aggregate.status
          : ts === "ok"
            ? "passed"
            : ts === "error"
              ? "failed"
              : "untested";
        return {
          ...e,
          disabled: isModelBlocked(
            e.providerId,
            e.providerAlias,
            e.id,
            blocksMap
          ),
          // "unsupported" is surfaced as untested rather than error: the
          // provider does not offer the operation, which is not a failure.
          testStatus:
            status === "unsupported"
              ? "untested"
              : status === "passed"
                ? "ok"
                : status === "failed" || status === "timeout"
                  ? "error"
                  : "untested",
          capabilityStatus: status,
          capabilities: perCapability ? Object.keys(perCapability) : [],
        };
      })
      .filter((e) => {
        if (statusFilter === "disabled") {
          // Disabled filter shows blocked models even when they are also hidden.
          if (!e.disabled) return false;
        } else {
          if (visibility === "visible" && e.hidden) return false;
          if (visibility === "hidden" && !e.hidden) return false;
        }
        if (
          !matchesStatusFilter(
            { testStatus: e.testStatus, hidden: e.hidden, blocked: e.disabled },
            statusFilter
          )
        ) {
          return false;
        }
        if (price === "free" && !e.isFree) return false;
        if (price === "paid" && e.isFree) return false;
        // Search by model NAME and by model ID (the upstream id is what the
        // user actually types; the fullModel is always a superset of the id).
        if (q && !`${e.fullModel} ${e.name}`.toLowerCase().includes(q)) {
          return false;
        }
        return true;
      });
    if (freeFirst) {
      list = [...list].sort((a, b) => Number(b.isFree) - Number(a.isFree));
    }
    return list;
  }, [
    allEntries,
    debouncedSearch,
    visibility,
    statusFilter,
    price,
    freeFirst,
    blocksMap,
    testResults,
    capabilityResults,
  ]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );
  const visibleCount = allEntries.filter((e) => !e.hidden).length;

  const handleBatchResult = useCallback((fullModel, status) => {
    if (status === "testing") {
      setTestingIds((prev) =>
        prev.includes(fullModel) ? prev : [...prev, fullModel]
      );
      return;
    }
    setTestingIds((prev) => prev.filter((k) => k !== fullModel));
    setTestResults((prev) => ({ ...prev, [fullModel]: status }));
  }, []);

  const setHidden = useCallback(async (entry, hide) => {
    try {
      if (hide) {
        await fetch("/api/models/disabled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerAlias: entry.providerAlias,
            ids: [entry.id],
          }),
        });
      } else {
        await fetch(
          `/api/models/disabled?providerAlias=${encodeURIComponent(entry.providerAlias)}&id=${encodeURIComponent(entry.id)}`,
          { method: "DELETE" }
        );
      }
      setDisabledMap((prev) => {
        const cur = new Set(prev[entry.providerAlias] || []);
        if (hide) cur.add(entry.id);
        else cur.delete(entry.id);
        return { ...prev, [entry.providerAlias]: [...cur] };
      });
      invalidateCache("/api/models/disabled");
    } catch {
      /* ignore */
    }
  }, []);

  const handleDisable = useCallback(
    async (entry) => {
      try {
        const res = await fetch("/api/models/blocks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerAlias: entry.providerAlias,
            ids: [entry.id],
          }),
        });
        if (!res.ok) throw new Error("Disable failed");
        setBlocksMap((prev) => {
          const cur = new Set(prev[entry.providerAlias] || []);
          cur.add(entry.id);
          return { ...prev, [entry.providerAlias]: [...cur] };
        });
        invalidateCache("/api/models/blocks");
        showNotice(
          "success",
          `Disabled ${entry.fullModel}. It will no longer receive requests.`
        );
      } catch {
        showNotice("error", `Could not disable ${entry.fullModel}.`);
      } finally {
        setConfirmDisable(null);
      }
    },
    [showNotice]
  );

  const handleEnable = useCallback(
    async (entry) => {
      try {
        const res = await fetch(
          `/api/models/blocks?providerAlias=${encodeURIComponent(entry.providerAlias)}&id=${encodeURIComponent(entry.id)}`,
          { method: "DELETE" }
        );
        if (!res.ok) throw new Error("Enable failed");
        setBlocksMap((prev) => {
          const cur = new Set(prev[entry.providerAlias] || []);
          cur.delete(entry.id);
          return { ...prev, [entry.providerAlias]: [...cur] };
        });
        invalidateCache("/api/models/blocks");
        // Enabling restores routability but does NOT prove the model works: the
        // previous failure record stays until the model is re-tested, so it is
        // NOT counted as verified working until a test passes.
        showNotice(
          "success",
          `Re-enabled ${entry.fullModel}. Test it to confirm it works.`
        );
      } catch {
        showNotice("error", `Could not re-enable ${entry.fullModel}.`);
      }
    },
    [showNotice]
  );

  const handleHideAll = useCallback(async () => {
    const byAlias = {};
    for (const e of filtered.filter((e) => !e.hidden)) {
      (byAlias[e.providerAlias] = byAlias[e.providerAlias] || []).push(e.id);
    }
    await Promise.all(
      Object.entries(byAlias).map(([alias, ids]) =>
        fetch("/api/models/disabled", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerAlias: alias, ids }),
        }).catch(() => {})
      )
    );
    refresh({ force: true });
  }, [filtered, refresh]);

  const handleShowAll = useCallback(async () => {
    const hidden = allEntries.filter((e) => e.hidden);
    await Promise.all(
      hidden.map((e) =>
        fetch(
          `/api/models/disabled?providerAlias=${encodeURIComponent(e.providerAlias)}&id=${encodeURIComponent(e.id)}`,
          { method: "DELETE" }
        ).catch(() => {})
      )
    );
    refresh({ force: true });
  }, [allEntries, refresh]);

  const handleBatchEnd = useCallback(
    async (snapshot) => {
      refresh({ force: true });
      if (!autoHideFailed || !snapshot) return;
      const failed = (snapshot.results || []).filter(
        (r) => r.status === "failed" || r.status === "timeout"
      );
      if (failed.length === 0) return;
      const byAlias = {};
      for (const r of failed) {
        const slash = r.modelId.indexOf("/");
        if (slash < 0) continue;
        const alias = r.modelId.slice(0, slash);
        const id = r.modelId.slice(slash + 1);
        (byAlias[alias] = byAlias[alias] || []).push(id);
      }
      await Promise.all(
        Object.entries(byAlias).map(([alias, ids]) =>
          fetch("/api/models/disabled", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ providerAlias: alias, ids }),
          }).catch(() => {})
        )
      );
      refresh({ force: true });
    },
    [autoHideFailed, refresh]
  );

  const handleSingleTest = useCallback(async (entry) => {
    if (entry.disabled) return;
    if (inflightSingleRef.current.has(entry.key)) return; // no duplicate tests
    inflightSingleRef.current.add(entry.key);
    setSingleTestingIds((prev) =>
      prev.includes(entry.key) ? prev : [...prev, entry.key]
    );
    // Test the capability the card represents. Sending no capability would
    // fall back to chat, which is how an image-only model could be reported as
    // broken when its chat endpoint simply does not exist.
    const capability = normalizeCapability(entry.kind) || "chat";
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: entry.fullModel, capability }),
      });
      const data = await res.json().catch(() => ({}));
      setTestResults((prev) => ({
        ...prev,
        [entry.key]: data.ok ? "ok" : "error",
      }));
      setCapabilityResults((prev) => ({
        ...prev,
        [entry.key]: {
          ...(prev[entry.key] || {}),
          [capability]: {
            status: data.status || (data.ok ? "passed" : "failed"),
            error: data.error || null,
            errorCode: data.errorCode || null,
            testedAt: data.testedAt || new Date().toISOString(),
          },
        },
      }));
    } catch {
      setTestResults((prev) => ({ ...prev, [entry.key]: "error" }));
    } finally {
      inflightSingleRef.current.delete(entry.key);
      setSingleTestingIds((prev) => prev.filter((k) => k !== entry.key));
    }
  }, []);

  const batchModels = useMemo(
    () =>
      filtered
        .filter((e) => !e.hidden && !e.disabled && e.hasConnection)
        .map((e) => ({
          id: e.key,
          fullModel: e.fullModel,
          kind: e.kind,
          isFree: e.isFree,
        })),
    [filtered]
  );

  const providerOptions = useMemo(
    () =>
      buildProviderOptions({
        providerIds,
        connectedProviders,
        syncedModels,
        customModels,
        modelAliases,
      }),
    [providerIds, connectedProviders, syncedModels, customModels, modelAliases]
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold mr-auto">{headerTitle}</h2>
        <span className="text-xs text-text-muted">
          {visibleCount}/{allEntries.length} active
        </span>
        <button
          onClick={handleShowAll}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-muted hover:text-primary hover:border-primary/40 transition-colors"
          title="Show all models"
        >
          <span className="material-symbols-outlined text-sm">visibility</span>{" "}
          All
        </button>
        <button
          onClick={handleHideAll}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-muted hover:text-red-500 hover:border-red-500/40 transition-colors"
          title="Hide all listed models"
        >
          <span className="material-symbols-outlined text-sm">
            visibility_off
          </span>{" "}
          Hide all
        </button>
      </div>

      {notice ? (
        <div
          className={`rounded-lg border px-3 py-2 text-xs flex items-center gap-2 ${
            notice.type === "success"
              ? "border-green-500/40 bg-green-500/10 text-green-500"
              : "border-red-500/40 bg-red-500/10 text-red-500"
          }`}
        >
          <span className="material-symbols-outlined text-sm">
            {notice.type === "success" ? "check_circle" : "error"}
          </span>
          {notice.text}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-sm text-text-muted">
            search
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter models..."
            aria-label="Search models by name or id"
            className="pl-8 pr-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none focus:border-primary w-48"
          />
        </div>
        {!storageAlias && (
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.target.value)}
            aria-label="Filter by provider"
            className="text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:border-primary"
          >
            <option value="connected">Connected providers</option>
            <option value="all">All providers</option>
            {providerOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.alias} ({p.count})
                {p.connected ? "" : " — no connection"}
              </option>
            ))}
          </select>
        )}
        {[
          ["all", "All"],
          ["visible", "Visible only"],
          ["hidden", "Hidden only"],
        ].map(([v, label]) => (
          <button
            key={v}
            onClick={() => setVisibility(v)}
            className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              visibility === v
                ? "bg-red-500 text-white border-red-500"
                : "border-border text-text-muted hover:text-primary"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="text-text-muted/40 text-xs select-none">|</span>
        {[
          ["all", "All statuses"],
          ["working", "Working"],
          ["error", "Error"],
          ["hidden", "Hidden"],
          ["disabled", "Disabled"],
        ].map(([v, label]) => (
          <button
            key={`status-${v}`}
            onClick={() => setStatusFilter(v)}
            title={
              v === "all" ? "Show all statuses" : `Show ${label.toLowerCase()} models`
            }
            className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              statusFilter === v
                ? "bg-red-500 text-white border-red-500"
                : "border-border text-text-muted hover:text-primary"
            }`}
          >
            {label}
          </button>
        ))}
        {[
          ["all", "All"],
          ["free", "Free only"],
          ["paid", "Paid only"],
        ].map(([v, label]) => (
          <button
            key={`price-${v}`}
            onClick={() => setPrice(v)}
            className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              price === v
                ? "bg-red-500 text-white border-red-500"
                : "border-border text-text-muted hover:text-primary"
            }`}
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => setFreeFirst((v) => !v)}
          className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
            freeFirst ? "border-primary text-primary" : "border-border text-text-muted"
          }`}
        >
          <span className="material-symbols-outlined text-sm">sort</span> Free
          first
        </button>
        <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
          <input
            type="checkbox"
            checked={autoHideFailed}
            onChange={(e) => setAutoHideFailed(e.target.checked)}
            className="accent-red-500"
          />
          Auto-hide failed models
        </label>
      </div>

      <ModelBatchTest
        models={batchModels}
        disabled={batchModels.length === 0}
        testResults={Object.fromEntries(
          batchModels.map((m) => [m.id, testResults[m.fullModel]])
        )}
        onResult={handleBatchResult}
        onBatchEnd={handleBatchEnd}
        scopeLocked
        extraActions={
          onAddModelClick ? (
            <button
              onClick={onAddModelClick}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-primary/40 text-primary transition-colors hover:border-primary hover:bg-primary/5"
              title={`${addModelLabel} — opens the common Add Model dialog`}
            >
              <span className="material-symbols-outlined text-sm">add</span>
              {addModelLabel}
            </button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {paged.map((entry) => {
          const status = entry.testStatus;
          const testing =
            testingIds.includes(entry.key) || singleTestingIds.includes(entry.key);
          const primaryLabel = modelPrimaryLabel(entry);
          const secondaryName = hasDistinctDisplayName(entry.name, {
            id: entry.id,
            fullModel: entry.fullModel,
          })
            ? entry.name
            : "";
          return (
            <div
              key={entry.key}
              className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border bg-card ${
                entry.disabled
                  ? "border-amber-500/40 opacity-80"
                  : status === "ok"
                    ? "border-green-500/40"
                    : status === "error"
                      ? "border-red-500/40"
                      : "border-border"
              }`}
            >
              <span
                className="material-symbols-outlined text-lg shrink-0"
                style={
                  status === "ok"
                    ? { color: "#22c55e" }
                    : status === "error"
                      ? { color: "#ef4444" }
                      : undefined
                }
              >
                smart_toy
              </span>
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <span
                  className="text-xs text-text-muted font-mono truncate"
                  title={`${entry.fullModel}${
                    secondaryName && secondaryName !== primaryLabel
                      ? ` — ${secondaryName}`
                      : ""
                  }`}
                >
                  {primaryLabel}
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sidebar text-text-muted">
                    {entry.isCustom ? "CUSTOM" : "BUILT-IN"}
                  </span>
                  {entry.isFree && (
                    <span className="text-[9px] font-bold text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">
                      FREE
                    </span>
                  )}
                  {entry.disabled && (
                    <span className="text-[9px] font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">
                      DISABLED
                    </span>
                  )}
                  {entry.hidden && !entry.disabled && (
                    <span className="text-[9px] font-bold text-text-muted bg-sidebar px-1.5 py-0.5 rounded">
                      HIDDEN
                    </span>
                  )}
                  {/* Multi-capability models are labelled explicitly, so a card
                      that was tested for embeddings is not mistaken for a chat
                      model that happens to pass. */}
                  {entry.capabilities?.length > 0 && (
                    <span
                      className="text-[9px] font-bold text-indigo-500 bg-indigo-500/10 px-1.5 py-0.5 rounded"
                      title={`Tested capabilities: ${entry.capabilities.join(", ")}`}
                    >
                      {entry.capabilities.length} CAP
                    </span>
                  )}
                  {secondaryName && (
                    <span className="text-[10px] text-text-muted/70 italic truncate">
                      {secondaryName}
                    </span>
                  )}
                  {status === "ok" && (
                    <span
                      className="material-symbols-outlined text-sm"
                      style={{ color: "#22c55e" }}
                    >
                      check_circle
                    </span>
                  )}
                  {status === "error" && (
                    <span
                      className="material-symbols-outlined text-sm"
                      style={{ color: "#ef4444" }}
                    >
                      cancel
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleSingleTest(entry)}
                disabled={testing || !entry.hasConnection || entry.disabled}
                title={
                  entry.disabled
                    ? "Disabled — re-enable to test"
                    : entry.hasConnection
                      ? "Test model"
                      : "No connection"
                }
                className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar disabled:opacity-40"
              >
                <span
                  className="material-symbols-outlined text-base"
                  style={testing ? { animation: "spin 1s linear infinite" } : undefined}
                >
                  {testing ? "progress_activity" : "play_arrow"}
                </span>
              </button>
              <button
                onClick={() => setHidden(entry, !entry.hidden)}
                title={entry.hidden ? "Show model" : "Hide model"}
                className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar"
              >
                <span className="material-symbols-outlined text-base">
                  {entry.hidden ? "visibility_off" : "visibility"}
                </span>
              </button>
              {entry.disabled ? (
                <button
                  onClick={() => handleEnable(entry)}
                  title="Enable — allow this model again"
                  className="p-1 rounded text-amber-500 hover:text-green-500 hover:bg-sidebar"
                >
                  <span className="material-symbols-outlined text-base">
                    undo
                  </span>
                </button>
              ) : (
                <button
                  onClick={() => setConfirmDisable(entry)}
                  title="Disable — block this model from all requests"
                  className="p-1 rounded text-text-muted hover:text-amber-500 hover:bg-sidebar"
                >
                  <span className="material-symbols-outlined text-base">
                    block
                  </span>
                </button>
              )}
              <button
                onClick={() => copy(entry.fullModel, `avail-${entry.key}`)}
                title={`Copy full id: ${entry.fullModel}`}
                className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar"
              >
                <span className="material-symbols-outlined text-base">
                  {copied === `avail-${entry.key}` ? "check" : "content_copy"}
                </span>
              </button>
              <button
                onClick={() => setCompatEntry(entry)}
                title="Compatibility"
                className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-primary hover:border-primary/40 whitespace-nowrap"
              >
                <span className="material-symbols-outlined text-sm">tune</span>{" "}
                Compatibility
              </button>
            </div>
          );
        })}
      </div>
      {filtered.length === 0 && (
        <p className="text-xs text-text-muted">
          No models match the current filters.
        </p>
      )}
      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-2 text-xs text-text-muted">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
            className="px-2.5 py-1.5 rounded-lg border border-border disabled:opacity-40 hover:text-primary"
          >
            Prev
          </button>
          <span>
            Page {safePage} of {pageCount} ({filtered.length} models)
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={safePage >= pageCount}
            className="px-2.5 py-1.5 rounded-lg border border-border disabled:opacity-40 hover:text-primary"
          >
            Next
          </button>
        </div>
      )}

      {compatEntry && (
        <ModelCompatibilityModal
          entry={compatEntry}
          onClose={() => setCompatEntry(null)}
        />
      )}
      {confirmDisable && (
        <ConfirmModal
          isOpen
          title="Disable model?"
          message={`${confirmDisable.fullModel} will stop receiving requests everywhere (API, Playground, Combos, tests). It stays stored and can be re-enabled later.`}
          confirmText="Disable"
          onClose={() => setConfirmDisable(null)}
          onConfirm={() => handleDisable(confirmDisable)}
        />
      )}
    </div>
  );
}

AvailableModelsSection.propTypes = {
  storageAlias: PropTypes.string,
  onAddModelClick: PropTypes.func,
  addModelLabel: PropTypes.string,
  headerTitle: PropTypes.string,
  onDataChange: PropTypes.func,
};

export { getProviderAlias };
