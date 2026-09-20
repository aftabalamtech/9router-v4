import { useState, useEffect, useMemo, useCallback } from "react";
import { AI_PROVIDERS, getProviderAlias, getProviderByAlias } from "@/shared/constants/providers";
import { getModelsByProviderId } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { ConfirmModal, Modal } from "@/shared/components";
import { isModelBlocked, isModelHidden, matchesStatusFilter } from "@/shared/utils/modelEligibility";
import ModelBatchTest from "../providers/components/ModelBatchTest";

function kindOf(m) {
  return m.type || m.kinds?.[0] || "llm";
}

// ── Compatibility modal: connections + cooldown locks for one model ──
function CompatibilityModal({ entry, onClose }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [connRes, availRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/models/availability", { cache: "no-store" }),
        ]);
        const conns = connRes.ok ? (await connRes.json().catch(() => ({}))).connections || [] : [];
        const avail = availRes.ok ? await availRes.json().catch(() => ({})) : {};
        const locks = Array.isArray(avail.models)
          ? avail.models.filter((l) => l.provider === entry.providerId
            && (l.model === entry.id || l.model === "__all" || l.model === entry.fullModel))
          : [];
        if (!cancelled) setInfo({
          connections: conns.filter((c) => c.provider === entry.providerId),
          locks,
        });
      } catch {
        if (!cancelled) setInfo({ connections: [], locks: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [entry]);

  return (
    <Modal isOpen title={`Compatibility — ${entry.fullModel}`} onClose={onClose}>
      {!info && <p className="text-xs text-text-muted">Loading...</p>}
      {info && (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-semibold mb-1">Connections ({info.connections.length})</p>
            {info.connections.length === 0 && <p className="text-xs text-text-muted">No connections for this provider.</p>}
            {info.connections.map((c) => (
              <div key={c.id} className="text-xs text-text-muted border border-border rounded-lg px-2 py-1.5 mb-1">
                <span className="font-mono">{c.name || c.email || c.id}</span>
                {" · "}status: {c.testStatus || "unknown"}
                {c.lastError && <span className="text-red-500 break-words"> · {String(c.lastError).slice(0, 160)}</span>}
              </div>
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold mb-1">Cooldowns / locks</p>
            {info.locks.length === 0 && <p className="text-xs text-text-muted">No active cooldowns for this model.</p>}
            {info.locks.map((l, i) => (
              <div key={i} className="text-xs text-text-muted border border-border rounded-lg px-2 py-1.5 mb-1">
                <span className="font-mono">{l.model}</span> · {l.status}
                {l.until && ` until ${l.until}`}
                {l.lastError && <span className="text-red-500 break-words"> · {String(l.lastError).slice(0, 160)}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Available Models page ────────────────────────────────────
export default function ModelsPage() {
  const { copied, copy } = useCopyToClipboard();
  const [connections, setConnections] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [disabledMap, setDisabledMap] = useState({});
  const [blocksMap, setBlocksMap] = useState({});
  const [testResults, setTestResults] = useState({});
  const [testingIds, setTestingIds] = useState([]);
  const [singleTesting, setSingleTesting] = useState(null);
  const [compatEntry, setCompatEntry] = useState(null);
  const [confirmDisable, setConfirmDisable] = useState(null);
  const [notice, setNotice] = useState(null); // { type: "success" | "error", text }

  const [providerFilter, setProviderFilter] = useState("connected");
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState("all"); // all | visible | hidden
  const [statusFilter, setStatusFilter] = useState("all"); // all | working | error | hidden | disabled
  const [price, setPrice] = useState("all"); // all | free | paid
  const [freeFirst, setFreeFirst] = useState(false);
  const [autoHideFailed, setAutoHideFailed] = useState(false);

  const showNotice = useCallback((type, text) => {
    setNotice({ type, text });
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const providerIds = useMemo(() => Object.keys(AI_PROVIDERS || {}), []);

  const refresh = useCallback(async () => {
    try {
      const [connRes, customRes, disRes, blockRes, resRes, aliasRes] = await Promise.all([
        fetch("/api/providers", { cache: "no-store" }),
        fetch("/api/models/custom", { cache: "no-store" }),
        fetch("/api/models/disabled", { cache: "no-store" }),
        fetch("/api/models/blocks", { cache: "no-store" }),
        fetch("/api/models/test-results", { cache: "no-store" }),
        fetch("/api/models/alias", { cache: "no-store" }),
      ]);
      if (connRes.ok) setConnections((await connRes.json().catch(() => ({}))).connections || []);
      if (customRes.ok) setCustomModels((await customRes.json().catch(() => ({}))).models || []);
      if (aliasRes.ok) setModelAliases((await aliasRes.json().catch(() => ({}))).aliases || {});
      if (disRes.ok) setDisabledMap((await disRes.json().catch(() => ({}))).disabled || {});
      if (blockRes.ok) setBlocksMap((await blockRes.json().catch(() => ({}))).blocked || {});
      if (resRes.ok) {
        const all = (await resRes.json().catch(() => ({}))).results || {};
        const mapped = {};
        for (const [fullModel, r] of Object.entries(all)) {
          if (r?.status === "passed") mapped[fullModel] = "ok";
          else if (r?.status === "failed" || r?.status === "timeout") mapped[fullModel] = "error";
        }
        setTestResults(mapped);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const connectedProviders = useMemo(() => {
    const set = new Set(connections.filter((c) => c.isActive !== false).map((c) => c.provider));
    return set;
  }, [connections]);

  const allEntries = useMemo(() => {
    const out = [];
    const ids = providerFilter === "all" ? providerIds
      : providerFilter === "connected" ? providerIds.filter((id) => connectedProviders.has(id))
      : [providerFilter];
    for (const providerId of ids) {
      let builtIn = [];
      try { builtIn = getModelsByProviderId(providerId) || []; } catch { builtIn = []; }
      const alias = getProviderAlias(providerId);
      const hiddenIds = new Set(disabledMap[alias] || []);
      for (const m of builtIn) {
        out.push({
          key: `${alias}/${m.id}`,
          providerId,
          providerAlias: alias,
          id: m.id,
          fullModel: `${alias}/${m.id}`,
          name: m.name || "",
          kind: kindOf(m),
          isFree: !!m.isFree,
          isCustom: false,
          hidden: hiddenIds.has(m.id),
          hasConnection: connectedProviders.has(providerId),
        });
      }
    }
    const hiddenByAlias = (a) => new Set(disabledMap[a] || []);
    for (const m of customModels) {
      if (providerFilter !== "all" && providerFilter !== "connected") {
        if (m.providerAlias !== getProviderAlias(providerFilter)) continue;
      }
      if (providerFilter === "connected" && ![...connectedProviders].some((id) => getProviderAlias(id) === m.providerAlias)) continue;
      out.push({
        key: `${m.providerAlias}/${m.id}`,
        providerId: m.providerAlias,
        providerAlias: m.providerAlias,
        id: m.id,
        fullModel: `${m.providerAlias}/${m.id}`,
        name: m.name || "",
        kind: m.type || "llm",
        isFree: false,
        isCustom: true,
        hidden: hiddenByAlias(m.providerAlias).has(m.id),
        hasConnection: true,
      });
    }
    // Alias-added models (provider "Add Model" stores aliases like openrouter/deepseek/...).
    // These are NOT in /api/models/custom, so derive them here per provider.
    const hardcodedByAlias = {};
    try {
      for (const pid of providerIds) {
        const a = getProviderAlias(pid);
        hardcodedByAlias[a] = new Set((getModelsByProviderId(pid) || []).map((m) => m.id));
      }
    } catch { /* ignore */ }
    const aliasEntries = [];
    for (const [aliasName, fullModel] of Object.entries(modelAliases)) {
      if (typeof fullModel !== "string" || !fullModel.includes("/")) continue;
      const slash = fullModel.indexOf("/");
      const storageAlias = fullModel.slice(0, slash);
      const modelId = fullModel.slice(slash + 1);
      if (!modelId) continue;
      if (hardcodedByAlias[storageAlias]?.has(modelId)) continue;
      const provider = getProviderByAlias(storageAlias);
      const providerId = provider?.id || storageAlias;
      if (providerFilter !== "all" && providerFilter !== "connected") {
        if (storageAlias !== getProviderAlias(providerFilter)) continue;
      }
      if (providerFilter === "connected"
        && ![...connectedProviders].some((id) => getProviderAlias(id) === storageAlias)) continue;
      aliasEntries.push({
        key: fullModel,
        providerId,
        providerAlias: storageAlias,
        id: modelId,
        fullModel,
        name: aliasName,
        kind: "llm",
        isFree: /free/i.test(modelId),
        isCustom: true,
        hidden: hiddenByAlias(storageAlias).has(modelId),
        hasConnection: provider ? connectedProviders.has(providerId) : true,
      });
    }
    const seenKeys = new Set(out.map((e) => e.key));
    for (const e of aliasEntries) {
      if (!seenKeys.has(e.key)) { seenKeys.add(e.key); out.push(e); }
    }
    return out;
  }, [providerIds, providerFilter, connectedProviders, customModels, disabledMap, modelAliases]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = allEntries.map((e) => {
      const ts = testResults[e.key];
      return {
        ...e,
        disabled: isModelBlocked(e.providerId, e.providerAlias, e.id, blocksMap),
        testStatus: ts === "ok" ? "ok" : ts === "error" ? "error" : "untested",
      };
    }).filter((e) => {
      if (statusFilter === "disabled") {
        // Disabled filter shows blocked models even when they are also hidden.
        if (!e.disabled) return false;
      } else {
        if (visibility === "visible" && e.hidden) return false;
        if (visibility === "hidden" && !e.hidden) return false;
      }
      if (!matchesStatusFilter({ testStatus: e.testStatus, hidden: e.hidden, blocked: e.disabled }, statusFilter)) return false;
      if (price === "free" && !e.isFree) return false;
      if (price === "paid" && e.isFree) return false;
      if (q && !`${e.fullModel} ${e.name}`.toLowerCase().includes(q)) return false;
      return true;
    });
    if (freeFirst) list = [...list].sort((a, b) => Number(b.isFree) - Number(a.isFree));
    return list;
  }, [allEntries, search, visibility, statusFilter, price, freeFirst, blocksMap, testResults]);

  const visibleCount = allEntries.filter((e) => !e.hidden).length;

  const handleBatchResult = useCallback((fullModel, status) => {
    if (status === "testing") {
      setTestingIds((prev) => (prev.includes(fullModel) ? prev : [...prev, fullModel]));
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
          body: JSON.stringify({ providerAlias: entry.providerAlias, ids: [entry.id] }),
        });
      } else {
        await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(entry.providerAlias)}&id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      }
      setDisabledMap((prev) => {
        const cur = new Set(prev[entry.providerAlias] || []);
        if (hide) cur.add(entry.id); else cur.delete(entry.id);
        return { ...prev, [entry.providerAlias]: [...cur] };
      });
    } catch { /* ignore */ }
  }, []);

  const handleDisable = useCallback(async (entry) => {
    try {
      const res = await fetch("/api/models/blocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: entry.providerAlias, ids: [entry.id] }),
      });
      if (!res.ok) throw new Error("Disable failed");
      setBlocksMap((prev) => {
        const cur = new Set(prev[entry.providerAlias] || []);
        cur.add(entry.id);
        return { ...prev, [entry.providerAlias]: [...cur] };
      });
      showNotice("success", `Disabled ${entry.fullModel}. It will no longer receive requests.`);
    } catch {
      showNotice("error", `Could not disable ${entry.fullModel}.`);
    } finally {
      setConfirmDisable(null);
    }
  }, [showNotice]);

  const handleEnable = useCallback(async (entry) => {
    try {
      const res = await fetch(`/api/models/blocks?providerAlias=${encodeURIComponent(entry.providerAlias)}&id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Enable failed");
      setBlocksMap((prev) => {
        const cur = new Set(prev[entry.providerAlias] || []);
        cur.delete(entry.id);
        return { ...prev, [entry.providerAlias]: [...cur] };
      });
      showNotice("success", `Re-enabled ${entry.fullModel}.`);
    } catch {
      showNotice("error", `Could not re-enable ${entry.fullModel}.`);
    }
  }, [showNotice]);

  const handleHideAll = useCallback(async () => {
    const byAlias = {};
    for (const e of filtered.filter((e) => !e.hidden)) {
      (byAlias[e.providerAlias] = byAlias[e.providerAlias] || []).push(e.id);
    }
    await Promise.all(Object.entries(byAlias).map(([alias, ids]) =>
      fetch("/api/models/disabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: alias, ids }),
      }).catch(() => {})
    ));
    refresh();
  }, [filtered, refresh]);

  const handleShowAll = useCallback(async () => {
    const hidden = allEntries.filter((e) => e.hidden);
    await Promise.all(hidden.map((e) =>
      fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(e.providerAlias)}&id=${encodeURIComponent(e.id)}`, { method: "DELETE" }).catch(() => {})
    ));
    refresh();
  }, [allEntries, refresh]);

  const handleBatchEnd = useCallback(async (snapshot) => {
    refresh();
    if (!autoHideFailed || !snapshot) return;
    const failed = (snapshot.results || []).filter((r) => r.status === "failed" || r.status === "timeout");
    if (failed.length === 0) return;
    const byAlias = {};
    for (const r of failed) {
      const slash = r.modelId.indexOf("/");
      if (slash < 0) continue;
      const alias = r.modelId.slice(0, slash);
      const id = r.modelId.slice(slash + 1);
      (byAlias[alias] = byAlias[alias] || []).push(id);
    }
    await Promise.all(Object.entries(byAlias).map(([alias, ids]) =>
      fetch("/api/models/disabled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerAlias: alias, ids }),
      }).catch(() => {})
    ));
    refresh();
  }, [autoHideFailed, refresh]);

  const handleSingleTest = useCallback(async (entry) => {
    if (singleTesting || entry.disabled) return;
    setSingleTesting(entry.key);
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: entry.fullModel, kind: entry.kind }),
      });
      const data = await res.json().catch(() => ({}));
      setTestResults((prev) => ({ ...prev, [entry.key]: data.ok ? "ok" : "error" }));
      refresh();
    } catch {
      setTestResults((prev) => ({ ...prev, [entry.key]: "error" }));
    } finally {
      setSingleTesting(null);
    }
  }, [singleTesting, refresh]);

  const batchModels = useMemo(() => filtered
    .filter((e) => !e.hidden && !e.disabled && e.hasConnection)
    .map((e) => ({ id: e.key, fullModel: e.fullModel, kind: e.kind, isFree: e.isFree })),
    [filtered]);

  const providerOptions = useMemo(() => {
    const withCounts = providerIds.map((id) => {
      let n = 0;
      try { n = (getModelsByProviderId(id) || []).length; } catch { n = 0; }
      return { id, alias: getProviderAlias(id), count: n, connected: connectedProviders.has(id) };
    }).filter((p) => p.count > 0);
    return withCounts;
  }, [providerIds, connectedProviders]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold mr-auto">Available Models</h1>
        <span className="text-xs text-text-muted">{visibleCount}/{allEntries.length} active</span>
        <button onClick={handleShowAll} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-muted hover:text-primary hover:border-primary/40 transition-colors" title="Show all models">
          <span className="material-symbols-outlined text-sm">visibility</span> All
        </button>
        <button onClick={handleHideAll} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-border text-text-muted hover:text-red-500 hover:border-red-500/40 transition-colors" title="Hide all listed models">
          <span className="material-symbols-outlined text-sm">visibility_off</span> Hide all
        </button>
      </div>

      {notice ? (
        <div className={`rounded-lg border px-3 py-2 text-xs flex items-center gap-2 ${notice.type === "success" ? "border-green-500/40 bg-green-500/10 text-green-500" : "border-red-500/40 bg-red-500/10 text-red-500"}`}>
          <span className="material-symbols-outlined text-sm">{notice.type === "success" ? "check_circle" : "error"}</span>
          {notice.text}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-sm text-text-muted">search</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter models..."
            className="pl-8 pr-3 py-1.5 text-xs bg-background border border-border rounded-lg focus:outline-none focus:border-primary w-48"
          />
        </div>
        <select value={providerFilter} onChange={(e) => setProviderFilter(e.target.value)} className="text-xs bg-background border border-border rounded-lg px-2 py-1.5 text-text-muted focus:outline-none focus:border-primary">
          <option value="connected">Connected providers</option>
          <option value="all">All providers</option>
          {providerOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.alias} ({p.count}){p.connected ? "" : " — no connection"}</option>
          ))}
        </select>
        {[
          ["all", "All"], ["visible", "Visible only"], ["hidden", "Hidden only"],
        ].map(([v, label]) => (
          <button key={v} onClick={() => setVisibility(v)} className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${visibility === v ? "bg-red-500 text-white border-red-500" : "border-border text-text-muted hover:text-primary"}`}>{label}</button>
        ))}
        <span className="text-text-muted/40 text-xs select-none">|</span>
        {[
          ["all", "All statuses"], ["working", "Working"], ["error", "Error"], ["hidden", "Hidden"], ["disabled", "Disabled"],
        ].map(([v, label]) => (
          <button key={`status-${v}`} onClick={() => setStatusFilter(v)} title={v === "all" ? "Show all statuses" : `Show ${label.toLowerCase()} models`} className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${statusFilter === v ? "bg-red-500 text-white border-red-500" : "border-border text-text-muted hover:text-primary"}`}>{label}</button>
        ))}
        {[
          ["all", "All"], ["free", "Free only"], ["paid", "Paid only"],
        ].map(([v, label]) => (
          <button key={v} onClick={() => setPrice(v)} className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${price === v ? "bg-red-500 text-white border-red-500" : "border-border text-text-muted hover:text-primary"}`}>{label}</button>
        ))}
        <button onClick={() => setFreeFirst((v) => !v)} className={`flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${freeFirst ? "border-primary text-primary" : "border-border text-text-muted"}`}>
          <span className="material-symbols-outlined text-sm">sort</span> Free first
        </button>
        <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
          <input type="checkbox" checked={autoHideFailed} onChange={(e) => setAutoHideFailed(e.target.checked)} className="accent-red-500" />
          Auto-hide failed models
        </label>
      </div>

      <ModelBatchTest
        models={batchModels}
        disabled={batchModels.length === 0}
        testResults={Object.fromEntries(batchModels.map((m) => [m.id, testResults[m.fullModel]]))}
        onResult={handleBatchResult}
        onBatchEnd={handleBatchEnd}
        scopeLocked
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {filtered.map((entry) => {
          const status = entry.testStatus;
          const testing = testingIds.includes(entry.key) || singleTesting === entry.key;
          return (
            <div key={entry.key} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border bg-card ${entry.disabled ? "border-amber-500/40 opacity-80" : status === "ok" ? "border-green-500/40" : status === "error" ? "border-red-500/40" : "border-border"}`}>
              <span className="material-symbols-outlined text-lg shrink-0" style={status === "ok" ? { color: "#22c55e" } : status === "error" ? { color: "#ef4444" } : undefined}>smart_toy</span>
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <code className="text-xs text-text-muted font-mono truncate">{entry.fullModel}</code>
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sidebar text-text-muted">{entry.isCustom ? "CUSTOM" : "BUILT-IN"}</span>
                  {entry.isFree && <span className="text-[9px] font-bold text-green-500 bg-green-500/10 px-1.5 py-0.5 rounded">FREE</span>}
                  {entry.disabled && <span className="text-[9px] font-bold text-amber-500 bg-amber-500/10 px-1.5 py-0.5 rounded">DISABLED</span>}
                  {entry.hidden && !entry.disabled && <span className="text-[9px] font-bold text-text-muted bg-sidebar px-1.5 py-0.5 rounded">HIDDEN</span>}
                  {entry.name && <span className="text-[10px] text-text-muted/70 italic truncate">{entry.name}</span>}
                  {status === "ok" && <span className="material-symbols-outlined text-sm" style={{ color: "#22c55e" }}>check_circle</span>}
                  {status === "error" && <span className="material-symbols-outlined text-sm" style={{ color: "#ef4444" }}>cancel</span>}
                </div>
              </div>
              <button onClick={() => handleSingleTest(entry)} disabled={testing || !entry.hasConnection || entry.disabled} title={entry.disabled ? "Disabled — re-enable to test" : entry.hasConnection ? "Test model" : "No connection"} className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar disabled:opacity-40">
                <span className="material-symbols-outlined text-base" style={testing ? { animation: "spin 1s linear infinite" } : undefined}>{testing ? "progress_activity" : "play_arrow"}</span>
              </button>
              <button onClick={() => setHidden(entry, !entry.hidden)} title={entry.hidden ? "Show" : "Hide"} className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar">
                <span className="material-symbols-outlined text-base">{entry.hidden ? "visibility_off" : "visibility"}</span>
              </button>
              {entry.disabled ? (
                <button onClick={() => handleEnable(entry)} title="Enable — allow this model again" className="p-1 rounded text-amber-500 hover:text-green-500 hover:bg-sidebar">
                  <span className="material-symbols-outlined text-base">undo</span>
                </button>
              ) : (
                <button onClick={() => setConfirmDisable(entry)} title="Disable — block this model from all requests" className="p-1 rounded text-text-muted hover:text-amber-500 hover:bg-sidebar">
                  <span className="material-symbols-outlined text-base">block</span>
                </button>
              )}
              <button onClick={() => copy(entry.fullModel, `avail-${entry.key}`)} title="Copy" className="p-1 rounded text-text-muted hover:text-primary hover:bg-sidebar">
                <span className="material-symbols-outlined text-base">{copied === `avail-${entry.key}` ? "check" : "content_copy"}</span>
              </button>
              <button onClick={() => setCompatEntry(entry)} title="Compatibility" className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border text-[11px] text-text-muted hover:text-primary hover:border-primary/40 whitespace-nowrap">
                <span className="material-symbols-outlined text-sm">tune</span> Compatibility
              </button>
            </div>
          );
        })}
      </div>
      {filtered.length === 0 && <p className="text-xs text-text-muted">No models match the current filters.</p>}

      {compatEntry && <CompatibilityModal entry={compatEntry} onClose={() => setCompatEntry(null)} />}
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
