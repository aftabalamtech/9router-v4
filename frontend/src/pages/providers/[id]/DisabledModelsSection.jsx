import { useMemo } from "react";
import PropTypes from "prop-types";
import { Button } from "@/shared/components";

// ── DisabledModelsSection ───────────────────────────────────────
// Dedicated, provider-scoped view of the Disabled models system.
//
// Disabled state lives in the shared `disabledModels` kv store keyed by the
// provider's storage alias (backend/src/lib/db/repos/disabledModelsRepo.js),
// so this section reflects the same data the Models page, the router and the
// playground all read. It is intentionally separate from the Added models list
// so a model never appears in both places.
//
// Each row shows the model name, the exact upstream model id (what the request
// will send), the provider label, and the latest known test status.

function testBadge(testResults, modelId) {
  const status = testResults?.[modelId];
  if (status === "ok") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
        working
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-500">
        error
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sidebar text-text-muted">
      untested
    </span>
  );
}

export default function DisabledModelsSection({
  disabledIds = [],
  providerName,
  catalog = [],
  testResults = {},
  testErrors = {},
  modelAliases = {},
  onEnable,
  onEnableAll,
  onRetest,
  busy = false,
}) {
  const providerLabel = providerName || "this provider";

  // Prefer the discovered catalog (real model name + upstream id), then the
  // added-model aliases, then the bare disabled id. All three sources are
  // keyed by the same model id, so a disabled model is always rendered once.
  const rows = useMemo(() => {
    const catalogById = new Map(catalog.filter((m) => m?.id).map((m) => [m.id, m]));
    const aliasNames = new Map();
    for (const [alias, fullModel] of Object.entries(modelAliases || {})) {
      if (typeof fullModel !== "string") continue;
      const slash = fullModel.indexOf("/");
      if (slash <= 0) continue;
      const id = fullModel.slice(slash + 1);
      if (!aliasNames.has(id)) aliasNames.set(id, alias);
    }
    return (disabledIds || []).map((id) => {
      const entry = catalogById.get(id);
      return {
        id,
        // The exact upstream id is `id`; `name` is display-only and is never
        // sent upstream.
        name: entry?.name || aliasNames.get(id) || id,
        type: entry?.type || "llm",
        isFree: entry?.isFree ?? null,
        testStatus: testResults?.[id],
        // Last failure detail, when the batch/single test recorded one.
        error: testErrors?.[id] || entry?.error || "",
        kind: entry?.kind || "llm",
      };
    });
  }, [disabledIds, catalog, modelAliases, testResults, testErrors]);

  if (rows.length === 0) return null;

  return (
    <div className="mt-6 rounded-xl border border-border bg-sidebar/20 px-3 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="material-symbols-outlined text-base text-text-muted">block</span>
        <h3 className="text-sm font-semibold">Disabled Models</h3>
        <span className="text-[10px] text-text-muted bg-sidebar px-1.5 py-0.5 rounded-full">
          {rows.length}
        </span>
        <span className="text-[11px] text-text-muted">
          Excluded from routing, the Playground and the model lists.
        </span>
        {onEnableAll && rows.length > 1 && (
          <Button
            size="sm"
            variant="ghost"
            icon="restart_alt"
            onClick={onEnableAll}
            disabled={busy}
            className="ml-auto"
            title={`Enable every disabled model of ${providerLabel}`}
          >
            Enable all
          </Button>
        )}
      </div>

      <div className="flex flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03]">
        {rows.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center gap-2 py-2"
            title={`${row.name} — upstream model id: ${row.id}`}
          >
            {testBadge(testResults, row.id)}
            <div className="flex min-w-0 flex-col">
              <span className="text-sm truncate max-w-[280px]">{row.name}</span>
              {/* The exact upstream id is always shown: it is what a request
                  sends, and it is what the user pastes back into Add Model. */}
              <code className="text-[11px] font-mono text-text-muted">
                {providerLabel}/{row.id}
              </code>
            </div>
            <span className="text-[11px] text-text-muted truncate">
              {providerLabel}
            </span>
            {row.error && (
              <span
                className="text-[11px] text-red-500 break-words min-w-0 flex-1"
                title={row.error}
              >
                {row.error.length > 140
                  ? `${row.error.slice(0, 140)}…`
                  : row.error}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {onRetest && (
                <button
                  onClick={() => onRetest(row.id)}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40"
                  title={`Test ${row.id} — enabling does not prove it works, so test it before treating it as verified`}
                >
                  <span className="material-symbols-outlined text-[13px]">
                    science
                  </span>
                  Test
                </button>
              )}
              {onEnable && (
                <button
                  onClick={() => onEnable(row.id)}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] text-text-muted transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-40"
                  title={`Enable ${row.id} again. It stays unverified until a test passes.`}
                >
                  <span className="material-symbols-outlined text-[13px]">
                    restart_alt
                  </span>
                  Enable
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

DisabledModelsSection.propTypes = {
  disabledIds: PropTypes.arrayOf(PropTypes.string),
  providerName: PropTypes.string,
  catalog: PropTypes.array,
  testResults: PropTypes.object,
  testErrors: PropTypes.object,
  modelAliases: PropTypes.object,
  onEnable: PropTypes.func,
  onEnableAll: PropTypes.func,
  onRetest: PropTypes.func,
  busy: PropTypes.bool,
};
