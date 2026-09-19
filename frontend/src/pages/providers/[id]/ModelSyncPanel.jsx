import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";

const POLL_INTERVAL_MS = 2500;
const AUTO_SYNC_COOLDOWN_MS = 60 * 60 * 1000;

function formatTime(iso) {
  if (!iso) return "never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── ModelSyncPanel ─────────────────────────────────────────────
// Upstream discovery + sync controls for one provider.
// Props:
//   providerId, providerStorageAlias, providerLabel
//   connections: provider connections (active ones are eligible)
//   modelAliases: { alias: fullModel } (manual store — never modified here)
//   hardcodedIds: built-in model ids for this provider
//   onAddModel(modelId): add a discovered model (creates alias)
//   onCatalogChanged(): refresh parent lists after sync/clear
export default function ModelSyncPanel({
  providerId, providerStorageAlias, providerLabel,
  connections, modelAliases, hardcodedIds, onAddModel, onCatalogChanged,
}) {
  const [settings, setSettings] = useState({ autoFetch: false, autoSync: false, lastSyncAt: null });
  const [status, setStatus] = useState({ syncedCount: 0, staleCount: 0 });
  const [catalog, setCatalog] = useState([]);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [importing, setImporting] = useState(false);
  const esRef = useRef(null);
  const pollRef = useRef(null);
  const activeRef = useRef(false);
  const autoRanRef = useRef({ fetch: false, sync: false });
  const onCatalogChangedRef = useRef(onCatalogChanged);
  onCatalogChangedRef.current = onCatalogChanged;

  const base = `/api/providers/${encodeURIComponent(providerId)}/sync-models`;
  const storageQuery = `?storageAlias=${encodeURIComponent(providerStorageAlias)}`;

  const stopTransports = useCallback(() => {
    if (esRef.current) { try { esRef.current.close(); } catch {} esRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  useEffect(() => () => stopTransports(), [stopTransports]);

  const refreshStatus = useCallback(async (withCatalog) => {
    try {
      const url = withCatalog ? `${base}${storageQuery}&include=catalog` : `${base}${storageQuery}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.settings) setSettings(data.settings);
      setStatus({ syncedCount: data.syncedCount || 0, staleCount: data.staleCount || 0 });
      if (Array.isArray(data.catalog)) setCatalog(data.catalog);
    } catch { /* ignore */ }
  }, [base, storageQuery]);

  useEffect(() => { refreshStatus(true); }, [refreshStatus]);

  const applySnapshot = useCallback((snapshot) => {
    if (!snapshot) return;
    setJob((j) => (j ? { ...j, ...snapshot, finished: snapshot.status !== "running" } : j));
    if (snapshot.status !== "running") {
      activeRef.current = false;
      setImporting(false);
      stopTransports();
      refreshStatus(true);
      onCatalogChangedRef.current?.();
    }
  }, [refreshStatus, stopTransports]);

  const pollSnapshot = useCallback(async (jobId) => {
    try {
      const res = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (!res.ok) return;
      applySnapshot(await res.json());
    } catch { /* keep polling */ }
  }, [applySnapshot, base]);

  const startPolling = useCallback((jobId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      if (!activeRef.current) { clearInterval(pollRef.current); pollRef.current = null; return; }
      pollSnapshot(jobId);
    }, POLL_INTERVAL_MS);
  }, [pollSnapshot]);

  const subscribe = useCallback((jobId) => {
    stopTransports();
    let sseFailed = false;
    try {
      const es = new EventSource(`${base}/jobs/${encodeURIComponent(jobId)}/stream`);
      esRef.current = es;
      es.addEventListener("update", (e) => { try { applySnapshot(JSON.parse(e.data)); } catch {} });
      es.addEventListener("done", (e) => { try { applySnapshot(JSON.parse(e.data)); } catch {} stopTransports(); });
      es.onerror = () => {
        if (sseFailed) return;
        sseFailed = true;
        try { es.close(); } catch {}
        esRef.current = null;
        startPolling(jobId);
      };
    } catch {
      startPolling(jobId);
    }
  }, [applySnapshot, startPolling, stopTransports, base]);

  const manualIds = useManualIds(modelAliases, providerStorageAlias);

  const startSync = useCallback(async ({ importAll } = {}) => {
    if (activeRef.current) return null;
    setError("");
    activeRef.current = true;
    if (importAll) setImporting(true);
    setJob({ status: "running", summary: null, connections: [], current: null, startedAt: Date.now(), finished: false, importAll: !!importAll });
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageAlias: providerStorageAlias, manualIds }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Sync failed (HTTP ${res.status})`);
      setJob((j) => ({ ...j, jobId: data.jobId }));
      subscribe(data.jobId);
      pollSnapshot(data.jobId);
      return data.jobId;
    } catch (e) {
      setError(e.message);
      activeRef.current = false;
      setImporting(false);
      setJob(null);
      return null;
    }
  }, [base, providerStorageAlias, manualIds, subscribe, pollSnapshot]);

  // Import from /models: sync, then add every discovered model as an alias.
  const handleImport = useCallback(async () => {
    if (activeRef.current || importing) return;
    const jobId = await startSync({ importAll: true });
    if (!jobId) return;
    // Wait for completion, then add all fresh discoveries.
    const wait = async () => {
      for (let i = 0; i < 120; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const res = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
          if (!res.ok) continue;
          const snap = await res.json();
          if (snap.status !== "running") {
            await refreshStatus(true);
            try {
              const cat = await (await fetch(`${base}${storageQuery}&include=catalog`, { cache: "no-store" })).json();
              const added = new Set(Object.values(modelAliasesRef.current || {}));
              let n = 0;
              for (const m of cat.catalog || []) {
                if (m.stale) continue;
                const full = `${providerStorageAlias}/${m.id}`;
                if (added.has(full)) continue;
                await onAddModelRef.current?.(m.id);
                added.add(full);
                n += 1;
              }
              if (n === 0) setError("No new models were added.");
            } catch (e) {
              setError(e.message);
            }
            onCatalogChangedRef.current?.();
            return;
          }
        } catch { /* keep waiting */ }
      }
      setError("Import timed out waiting for sync.");
    };
    wait();
  }, [base, storageQuery, providerStorageAlias, startSync, importing, refreshStatus]);

  const modelAliasesRef = useRef(modelAliases);
  modelAliasesRef.current = modelAliases;
  const onAddModelRef = useRef(onAddModel);
  onAddModelRef.current = onAddModel;

  const handleCancel = useCallback(async () => {
    const jobId = job?.jobId;
    if (!jobId) return;
    try {
      await fetch(`${base}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
    } catch {}
    pollSnapshot(jobId);
  }, [base, job?.jobId, pollSnapshot]);

  const handleClear = useCallback(async () => {
    if (activeRef.current) return;
    if (typeof window !== "undefined" && !window.confirm("Remove all synced models for this provider? Manually added models are kept.")) return;
    try {
      const res = await fetch(`${base}${storageQuery}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Clear failed");
      refreshStatus(true);
      onCatalogChangedRef.current?.();
    } catch (e) {
      setError(e.message);
    }
  }, [base, storageQuery, refreshStatus]);

  const toggleSetting = useCallback(async (key) => {
    const next = !settings[key];
    setSettings((s) => ({ ...s, [key]: next }));
    try {
      const res = await fetch(base, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.settings) setSettings(data.settings);
    } catch {
      setSettings((s) => ({ ...s, [key]: !next }));
    }
  }, [base, settings]);

  const addedFullModels = useAddedSet(modelAliases);
  const hardcodedSet = useMemo(() => new Set(hardcodedIds || []), [hardcodedIds]);
  const addable = catalog.filter((m) => !m.stale
    && !addedFullModels.has(`${providerStorageAlias}/${m.id}`)
    && !hardcodedSet.has(m.id));

  const activeConnections = (connections || []).filter((c) => c.isActive !== false);
  const canSync = activeConnections.length > 0 && !job?.jobId;
  const running = !!job && !job.finished;
  const summary = job?.summary;

  // Auto-fetch: catalog empty + nothing added yet → sync once (opt-in only).
  useEffect(() => {
    if (!settings.autoFetch || autoRanRef.current.fetch || activeRef.current) return;
    if (activeConnections.length === 0) return;
    if (status.syncedCount > 0) return;
    const prefix = `${providerStorageAlias}/`;
    const hasAdded = Object.values(modelAliases || {}).some((f) => typeof f === "string" && f.startsWith(prefix));
    if (hasAdded) return;
    autoRanRef.current.fetch = true;
    startSync();
  }, [settings.autoFetch, activeConnections.length, status.syncedCount, modelAliases, providerStorageAlias, startSync]);

  // Auto-sync: refresh when never synced or cooldown elapsed (opt-in only).
  useEffect(() => {
    if (!settings.autoSync || autoRanRef.current.sync || activeRef.current) return;
    if (activeConnections.length === 0) return;
    const last = settings.lastSyncAt ? new Date(settings.lastSyncAt).getTime() : 0;
    if (Date.now() - last < AUTO_SYNC_COOLDOWN_MS) return;
    autoRanRef.current.sync = true;
    startSync();
  }, [settings.autoSync, settings.lastSyncAt, activeConnections.length, startSync]);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-sidebar/30 px-3 py-2.5 mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => toggleSetting("autoFetch")}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${settings.autoFetch ? "border-primary text-primary" : "border-border text-text-muted"}`}
          title="Automatically discover upstream models when the catalog is empty"
        >
          <span className={`w-6 h-3.5 rounded-full relative transition-colors ${settings.autoFetch ? "bg-primary" : "bg-border"}`}>
            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${settings.autoFetch ? "left-3" : "left-0.5"}`} />
          </span>
          Auto-fetch upstream models
        </button>
        <button
          onClick={() => toggleSetting("autoSync")}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${settings.autoSync ? "border-primary text-primary" : "border-border text-text-muted"}`}
          title="Refresh upstream models automatically (at most once per hour)"
        >
          <span className={`w-6 h-3.5 rounded-full relative transition-colors ${settings.autoSync ? "bg-primary" : "bg-border"}`}>
            <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white transition-all ${settings.autoSync ? "left-3" : "left-0.5"}`} />
          </span>
          Auto-Sync
        </button>
        <button
          onClick={handleClear}
          disabled={running}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40"
          title="Remove synced models (manual models are kept)"
        >
          <span className="material-symbols-outlined text-sm">delete</span>
          Clear All Models
        </button>
        <span className="text-[11px] text-text-muted ml-auto">
          Synced: {status.syncedCount}{status.staleCount > 0 && ` (${status.staleCount} stale)`} · Last sync: {formatTime(settings.lastSyncAt)}
        </span>
      </div>

      <p className="text-[11px] text-text-muted">
        {providerLabel || providerId} — sync upstream models, then add the ones you need. Manual models are never removed by sync.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" icon="sync" onClick={() => startSync()} disabled={!canSync || running}>
          {running ? "Syncing..." : "Sync now"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canSync || running || importing}>
          {importing ? "Importing..." : "Import from /models"}
        </Button>
        {running && (
          <Button size="sm" variant="ghost" onClick={handleCancel}>Cancel</Button>
        )}
        {running && job?.current && (
          <span className="text-[11px] text-text-muted truncate">Current: <code className="font-mono">{job.current}</code></span>
        )}
      </div>

      {running && job?.connections?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {job.connections.map((c) => (
            <span key={c.connectionId} className="text-[10px] px-1.5 py-0.5 rounded bg-background border border-border text-text-muted">
              {c.name}: {c.status}{c.discovered > 0 && ` (${c.discovered})`}
            </span>
          ))}
        </div>
      )}

      {job?.finished && summary && (
        <p className="text-[11px] text-text-muted">
          Finished in {formatElapsed(job.elapsedMs)} — {summary.discovered} discovered, {summary.added} added, {summary.updated} updated
          {summary.stale > 0 && `, ${summary.stale} stale`}{summary.failed > 0 && `, ${summary.failed} failed`}.
        </p>
      )}
      {job?.error && <p className="text-[11px] text-amber-500 break-words">{job.error}</p>}
      {error && (
        <div className="flex items-center gap-2">
          <p className="text-xs text-red-500 break-words flex-1">{error}</p>
          <Button size="sm" variant="ghost" onClick={() => startSync()}>Retry</Button>
        </div>
      )}

      {addable.length > 0 && (
        <div className="w-full mt-1">
          <p className="text-[11px] text-text-muted mb-1.5">Discovered upstream ({addable.length}):</p>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
            {addable.slice(0, 200).map((m) => (
              <button
                key={m.id}
                onClick={() => onAddModel(m.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg border border-black/10 dark:border-white/10 text-[11px] text-text-muted hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors"
                title={[m.name, m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : null, m.isFree ? "free" : null].filter(Boolean).join(" · ")}
              >
                <span className="material-symbols-outlined text-[12px]">add</span>
                {m.id}
              </button>
            ))}
          </div>
          {addable.length > 200 && <p className="text-[10px] text-text-muted mt-1">Showing first 200 of {addable.length}.</p>}
        </div>
      )}
    </div>
  );
}

function useManualIds(modelAliases, providerStorageAlias) {
  // Manual ids under this storage alias (for preservation during sync).
  return useMemo(() => {
    const prefix = `${providerStorageAlias}/`;
    const out = [];
    for (const full of Object.values(modelAliases || {})) {
      if (typeof full === "string" && full.startsWith(prefix)) {
        const id = full.slice(prefix.length);
        if (id && !out.includes(id)) out.push(id);
      }
    }
    return out;
  }, [modelAliases, providerStorageAlias]);
}

function useAddedSet(modelAliases) {
  return useMemo(
    () => new Set(Object.values(modelAliases || {}).filter((f) => typeof f === "string")),
    [modelAliases]
  );
}

ModelSyncPanel.propTypes = {
  providerId: PropTypes.string.isRequired,
  providerStorageAlias: PropTypes.string.isRequired,
  providerLabel: PropTypes.string,
  connections: PropTypes.array,
  modelAliases: PropTypes.object,
  hardcodedIds: PropTypes.array,
  onAddModel: PropTypes.func.isRequired,
  onCatalogChanged: PropTypes.func,
};
