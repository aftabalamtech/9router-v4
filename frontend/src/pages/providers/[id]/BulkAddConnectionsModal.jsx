import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import { parseBulkKeys, redactSecrets } from "@/shared/utils/bulkKeys";

const PLACEHOLDER = `sk-key-1
sk-key-2
Main | sk-key-3
Backup | sk-key-4`;

// ── BulkAddConnectionsModal ─────────────────────────────────────
// Paste many API keys, review the parsed result, then create them all in ONE
// request against POST /api/providers/bulk.
//
// Behavior required of this feature:
//  - one key per line; `Name | key` is also accepted
//  - auto-generates a name when none is given
//  - validates each entry independently — one bad line never discards the rest
//  - collapses duplicates WITHIN the paste client-side; duplicates against keys
//    already configured for this provider are detected server-side (the browser
//    never receives stored API keys, so it cannot check them itself) and
//    reported back in `result` without exposing any value
//  - reports added/failed counts and per-entry reasons, redacting anything
//    that looks like a credential
//  - does NOT trigger model tests (that stays an explicit action)
export default function BulkAddConnectionsModal({
  isOpen,
  provider,
  providerName,
  existingKeys = [],
  onClose,
  onDone,
}) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  // Parse + validate on every keystroke so the review list below the textarea
  // is always current. Pure and cheap (no network, no DB).
  const parsed = useMemo(
    () => parseBulkKeys(text, { existingKeys, namePrefix: "" }),
    [text, existingKeys]
  );

  const reset = () => {
    setText("");
    setResult(null);
    setError("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleAdd = async () => {
    if (saving || parsed.entries.length === 0) return;
    setSaving(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/providers/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          connections: parsed.entries.map((e) => ({ name: e.name, apiKey: e.apiKey })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && !data.added) {
        setError(redactSecrets(data.error || `Bulk add failed (HTTP ${res.status})`));
        return;
      }
      setResult({
        added: data.added || 0,
        invalid: data.invalid || 0,
        duplicates: data.duplicates || 0,
        // Redact on render: a server-side message could echo a pasted value.
        errors: (data.errors || []).map((e) => ({
          name: e.name,
          reason: redactSecrets(e.error || "Invalid entry"),
        })),
      });
      setText("");
      await onDone?.();
    } catch (e) {
      setError(redactSecrets(e?.message || "Network error"));
    } finally {
      setSaving(false);
    }
  };

  const duplicateErrors = parsed.errors.filter((e) => /duplicate/i.test(e.error));
  const invalidErrors = parsed.errors.filter((e) => !/duplicate/i.test(e.error));

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={`Bulk Add Connections${providerName ? ` — ${providerName}` : ""}`}
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">
          One key per line. Use <code>Name | key</code> to name a connection, or a bare{" "}
          <code>key</code> to auto-name it. Keys are saved through the same secure
          credential path as a single add and are never shown again.
        </p>

        <textarea
          aria-label="Bulk API keys"
          placeholder={PLACEHOLDER}
          value={text}
          onChange={(e) => { setText(e.target.value); setResult(null); setError(""); }}
          rows={7}
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-background p-2.5 font-mono text-xs resize-y focus:outline-none focus:border-primary"
        />

        {/* Live review — nothing is written until "Add N Connections". */}
        {parsed.total > 0 && (
          <div className="rounded-lg border border-border bg-sidebar/20 px-2.5 py-2">
            <p className="text-[11px] font-medium text-text-main mb-1">
              Review — {parsed.entries.length} connection{parsed.entries.length === 1 ? "" : "s"} to add
            </p>
            <ul className="max-h-32 overflow-y-auto flex flex-col gap-0.5">
              {parsed.entries.map((e) => (
                <li key={e.line} className="text-[11px] text-text-muted flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[13px] text-green-500">check</span>
                  <span className="truncate">{e.name}</span>
                  <span className="text-text-muted/60">· line {e.line}</span>
                </li>
              ))}
              {invalidErrors.map((e, i) => (
                <li key={`bad-${e.line}-${i}`} className="text-[11px] text-amber-500 flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[13px]">warning</span>
                  <span className="truncate">
                    {e.name ? `${e.name}: ` : "Line "}{e.line}: {redactSecrets(e.error)}
                  </span>
                </li>
              ))}
              {duplicateErrors.map((e, i) => (
                <li key={`dup-${e.line}-${i}`} className="text-[11px] text-text-muted flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[13px]">content_copy</span>
                  <span className="truncate">
                    {e.name ? `${e.name}: ` : "Line "}{e.line}: {redactSecrets(e.error)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {parsed.total > 0 && parsed.entries.length === 0 && (
          <p className="text-[11px] text-amber-500">
            No valid entries to add — fix the lines above.
          </p>
        )}

        {result && (
          <div className="rounded-lg border border-border px-2.5 py-2 text-[11px] text-text-muted">
            <p className="text-text-main font-medium">
              Added {result.added} connection{result.added === 1 ? "" : "s"}.
              {result.invalid > 0 && ` ${result.invalid} invalid.`}
              {result.duplicates > 0 && ` ${result.duplicates} duplicate(s) skipped.`}
            </p>
            {result.errors.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5">
                {result.errors.slice(0, 10).map((e, i) => (
                  <li key={i} className="text-amber-500 truncate">
                    {e.name ? `${e.name}: ` : ""}{e.reason}
                  </li>
                ))}
                {result.errors.length > 10 && (
                  <li className="text-text-muted">…and {result.errors.length - 10} more</li>
                )}
              </ul>
            )}
          </div>
        )}

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        <div className="flex flex-col gap-2">
          <Button
            onClick={handleAdd}
            fullWidth
            disabled={saving || parsed.entries.length === 0}
            icon="download"
          >
            {saving
              ? "Adding..."
              : `Add ${parsed.entries.length} Connection${parsed.entries.length === 1 ? "" : "s"}`}
          </Button>
          <Button onClick={handleClose} variant="ghost" fullWidth>
            Close
          </Button>
        </div>

        <p className="text-[11px] text-text-muted">
          Model tests are not run automatically — use “Test Connection One-by-One” or the
          discovery panel’s “Test All” afterwards.
        </p>
      </div>
    </Modal>
  );
}

BulkAddConnectionsModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  provider: PropTypes.string.isRequired,
  providerName: PropTypes.string,
  existingKeys: PropTypes.arrayOf(PropTypes.string),
  onClose: PropTypes.func.isRequired,
  onDone: PropTypes.func,
};
