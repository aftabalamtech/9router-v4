import { useState, useRef } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";
import ModelBatchTest from "@/pages/providers/components/ModelBatchTest";
function CompatibleModelRow({ modelId, fullModel, copied, onCopy, onDeleteAlias, onTest, testStatus, isTesting, isSynced }) {
  const borderColor = testStatus === "ok"
    ? "border-green-500/40"
    : testStatus === "error"
    ? "border-red-500/40"
    : "border-border";

  const iconColor = testStatus === "ok"
    ? "#22c55e"
    : testStatus === "error"
    ? "#ef4444"
    : undefined;

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${borderColor} hover:bg-sidebar/50`}>
      <span
        className="material-symbols-outlined text-base text-text-muted"
        style={iconColor ? { color: iconColor } : undefined}
      >
        {testStatus === "ok" ? "check_circle" : testStatus === "error" ? "cancel" : "smart_toy"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          {modelId}
          {isSynced && (
            <span className="ml-2 text-[10px] uppercase tracking-wider text-text-muted/70 bg-sidebar px-1.5 py-0.5 rounded-full align-middle">
              synced
            </span>
          )}
        </p>
        <div className="flex items-center gap-1 mt-1">
          <code className="text-xs text-text-muted font-mono bg-sidebar px-1.5 py-0.5 rounded">{fullModel}</code>
          <div className="relative group/btn">
            <button
              onClick={() => onCopy(fullModel, `model-${modelId}`)}
              className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary"
            >
              <span className="material-symbols-outlined text-sm">
                {copied === `model-${modelId}` ? "check" : "content_copy"}
              </span>
            </button>
            <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
              {copied === `model-${modelId}` ? "Copied!" : "Copy"}
            </span>
          </div>
          {onTest && (
            <div className="relative group/btn">
              <button
                onClick={onTest}
                disabled={isTesting}
                className="p-0.5 hover:bg-sidebar rounded text-text-muted hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-sm" style={isTesting ? { animation: "spin 1s linear infinite" } : undefined}>
                  {isTesting ? "progress_activity" : "science"}
                </span>
              </button>
              <span className="pointer-events-none absolute top-5 left-1/2 -translate-x-1/2 text-[10px] text-text-muted whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity">
                {isTesting ? "Testing..." : "Test"}
              </span>
            </div>
          )}
        </div>
      </div>
      <button
        onClick={onDeleteAlias}
        className="p-1 hover:bg-red-50 rounded text-red-500"
        title="Remove model"
      >
        <span className="material-symbols-outlined text-sm">delete</span>
      </button>
    </div>
  );
}

CompatibleModelRow.propTypes = {
  modelId: PropTypes.string.isRequired,
  fullModel: PropTypes.string.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func,
  onTest: PropTypes.func,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isTesting: PropTypes.bool,
  isSynced: PropTypes.bool,
};

export default function CompatibleModelsSection({
  providerStorageAlias, providerDisplayAlias, modelAliases, copied, onCopy,
  onSetAlias, onDeleteAlias, connections, isAnthropic,
  syncedModels = [], testResults = {}, onTestModel, batchTestingIds = [],
  isFreeNoAuth = false,
}) {
  const [newModel, setNewModel] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [testingModelIds, setTestingModelIds] = useState([]);
  const [importSummary, setImportSummary] = useState(null);
  const inflightTestRef = useRef(null);
  if (inflightTestRef.current === null) inflightTestRef.current = new Set();
  const [modelTestResults, setModelTestResults] = useState({});

  // Test status: prefer the parent's results (shared with the Models page and
  // the Discovered section), fall back to this component's in-session results.
  // Parent keys are bare ids; older callers may pass full "alias/id" keys.
  const statusFor = (modelId) =>
    testResults[`${providerStorageAlias}/${modelId}`]
    || testResults[modelId]
    || modelTestResults[modelId];
  const isTesting = (modelId) =>
    testingModelIds.includes(modelId) || batchTestingIds.includes(modelId);

  const handleTestModel = async (modelId) => {
    // Shared single-test path: the parent writes the result into the shared
    // testResults map (visible to filters), this component mirrors it locally
    // so the row updates even if the parent state lags a render.
    if (typeof onTestModel === "function") {
      try {
        await onTestModel(modelId);
      } catch {
        setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
      }
      return;
    }
    if (inflightTestRef.current.has(modelId)) return;
    inflightTestRef.current.add(modelId);
    setTestingModelIds((prev) => (prev.includes(modelId) ? prev : [...prev, modelId]));
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}` }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
    } finally {
      inflightTestRef.current.delete(modelId);
      setTestingModelIds((prev) => prev.filter((id) => id !== modelId));
    }
  };

  const providerAliases = Object.entries(modelAliases || {}).filter(
    ([, model]) => typeof model === "string" && model.startsWith(`${providerStorageAlias}/`)
  );

  // Added models only (manual aliases). Sync-discovered models that have NOT
  // been added live exclusively in the Discovered section of the sync panel —
  // rendering them here too duplicated every added model (manual wins).
  const syncedIdSet = new Set(
    (syncedModels || []).filter((m) => m && m.id && !m.stale).map((m) => m.id)
  );
  const manualModels = providerAliases.map(([alias, fullModel]) => ({
    modelId: fullModel.replace(`${providerStorageAlias}/`, ""),
    fullModel,
    alias,
    isSynced: syncedIdSet.has(fullModel.replace(`${providerStorageAlias}/`, "")),
  }));

  const allRows = manualModels.map((m) => ({ ...m }));

  // Everything shown here is testable through the shared batch-test backend.
  const testableModels = allRows.map(({ modelId, isSynced }) => ({
    id: modelId,
    fullModel: `${providerStorageAlias}/${modelId}`,
    kind: "llm",
    isFree: false,
  }));

  const canTest = connections.length > 0 || isFreeNoAuth;

  const generateDefaultAlias = (modelId) => {
    const parts = modelId.split("/");
    return parts[parts.length - 1];
  };

  const resolveAlias = (modelId) => {
    const fullModel = `${providerStorageAlias}/${modelId}`;
    // Skip if this exact model already has an alias
    if (Object.values(modelAliases).includes(fullModel)) return null;
    const baseAlias = generateDefaultAlias(modelId);
    if (!modelAliases[baseAlias]) return baseAlias;
    const prefixedAlias = `${providerDisplayAlias}-${baseAlias}`;
    if (!modelAliases[prefixedAlias]) return prefixedAlias;
    return null;
  };

  const handleAdd = async () => {
    if (!newModel.trim() || adding) return;
    const modelId = newModel.trim();
    const resolvedAlias = resolveAlias(modelId);
    if (!resolvedAlias) {
      alert("All suggested aliases already exist. Please choose a different model or remove conflicting aliases.");
      return;
    }

    setAdding(true);
    try {
      await onSetAlias(modelId, resolvedAlias, providerStorageAlias);
      setNewModel("");
    } catch (error) {
      console.log("Error adding model:", error);
    } finally {
      setAdding(false);
    }
  };

  // Import every model from the upstream /models endpoint. Manual models and
  // already-known ids are never duplicated — resolveAlias returns null for them.
  const handleImport = async () => {
    if (importing) return;
    const activeConnection = connections.find((conn) => conn.isActive !== false);
    if (!activeConnection) return;

    setImporting(true);
    setImportSummary(null);
    try {
      const res = await fetch(`/api/providers/${activeConnection.id}/models`);
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Failed to import models");
        return;
      }
      const models = data.models || [];
      if (models.length === 0) {
        alert("No models returned from /models.");
        return;
      }
      let importedCount = 0;
      let skippedCount = 0;
      for (const model of models) {
        const modelId = model.id || model.name || model.model;
        if (!modelId) continue;
        const resolvedAlias = resolveAlias(modelId);
        if (!resolvedAlias) { skippedCount += 1; continue; }
        await onSetAlias(modelId, resolvedAlias, providerStorageAlias);
        importedCount += 1;
      }
      if (importedCount === 0) {
        setImportSummary({ imported: 0, total: models.length });
      } else {
        setImportSummary({ imported: importedCount, total: models.length, skipped: skippedCount });
      }
    } catch (error) {
      console.log("Error importing models:", error);
      alert("Failed to import models.");
    } finally {
      setImporting(false);
    }
  };

  const canImport = connections.some((conn) => conn.isActive !== false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        Add {isAnthropic ? "Anthropic" : "OpenAI"}-compatible models manually, sync them from the upstream catalog, or import them from the /models endpoint.
      </p>

      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <label htmlFor="new-compatible-model-input" className="text-xs text-text-muted mb-1 block">Model ID</label>
          <input
            id="new-compatible-model-input"
            type="text"
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder={isAnthropic ? "claude-3-opus-20240229" : "gpt-4o"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
        </div>
        <Button size="sm" icon="add" onClick={handleAdd} disabled={!newModel.trim() || adding}>
          {adding ? "Adding..." : "Add"}
        </Button>
        <Button size="sm" variant="secondary" icon="download" onClick={handleImport} disabled={!canImport || importing}>
          {importing ? "Importing..." : "Import from /models"}
        </Button>
      </div>

      {importSummary && (
        <p className="text-xs text-text-muted">
          {importSummary.imported > 0
            ? `Imported ${importSummary.imported} of ${importSummary.total} models${importSummary.skipped ? ` (${importSummary.skipped} already known)` : ""}.`
            : `No new models — all ${importSummary.total} were already known.`}
        </p>
      )}

      {!canImport && (
        <p className="text-xs text-text-muted">
          Add a connection to enable importing models.
        </p>
      )}

      {allRows.length > 0 && (
        <div className="flex flex-col gap-3">
          {canTest && testableModels.length > 0 && (
            <ModelBatchTest
              models={testableModels}
              disabled={false}
              testResults={(() => {
                // ModelBatchTest looks up results by bare model id, while the
                // parent page keys them by full "alias/id" — expose both so
                // "Retry failed" counts stay accurate.
                const merged = {
                  ...testResults,
                  ...Object.fromEntries(
                    Object.entries(modelTestResults).map(([id, v]) => [`${providerStorageAlias}/${id}`, v])
                  ),
                };
                const byBare = {};
                for (const [k, v] of Object.entries(merged)) {
                  byBare[k] = v;
                  const bare = String(k).startsWith(`${providerStorageAlias}/`)
                    ? String(k).slice(providerStorageAlias.length + 1)
                    : k;
                  byBare[bare] = v;
                }
                return byBare;
              })()}
              onResult={(fullModel, status) => setModelTestResults((prev) => ({ ...prev, [fullModel.split("/").slice(1).join("/")]: status }))}
              scopeLocked
            />
          )}
          {allRows.map(({ modelId, isSynced }) => (
            <CompatibleModelRow
              key={`${isSynced ? "synced" : "manual"}-${modelId}`}
              modelId={modelId}
              fullModel={`${providerDisplayAlias}/${modelId}`}
              copied={copied}
              onCopy={onCopy}
              onDeleteAlias={isSynced ? undefined : () => onDeleteAlias(manualModels.find((m) => m.modelId === modelId)?.alias)}
              onTest={canTest ? () => handleTestModel(modelId) : undefined}
              testStatus={statusFor(modelId)}
              isTesting={isTesting(modelId)}
              isSynced={isSynced}
            />
          ))}
        </div>
      )}
      {allRows.length === 0 && (
        <p className="text-xs text-text-muted">
          No models yet. Add one manually above, run Sync Now in the panel, or import from /models.
        </p>
      )}
    </div>
  );
}

CompatibleModelsSection.propTypes = {
  providerStorageAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string.isRequired,
  modelAliases: PropTypes.object.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onSetAlias: PropTypes.func.isRequired,
  onDeleteAlias: PropTypes.func.isRequired,
  connections: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    isActive: PropTypes.bool,
  })).isRequired,
  isAnthropic: PropTypes.bool,
  syncedModels: PropTypes.array,
  testResults: PropTypes.object,
  onTestModel: PropTypes.func,
  batchTestingIds: PropTypes.array,
  isFreeNoAuth: PropTypes.bool,
};
