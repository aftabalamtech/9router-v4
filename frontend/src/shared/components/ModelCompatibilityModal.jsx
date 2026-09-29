import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { Modal } from "@/shared/components";

// ── Compatibility modal: connections + cooldown locks for one model ──
// Extracted from the Models page so the provider pages show the same dialog.
export default function ModelCompatibilityModal({ entry, onClose }) {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [connRes, availRes] = await Promise.all([
          fetch("/api/providers", { cache: "no-store" }),
          fetch("/api/models/availability", { cache: "no-store" }),
        ]);
        const conns = connRes.ok
          ? (await connRes.json().catch(() => ({}))).connections || []
          : [];
        const avail = availRes.ok ? await availRes.json().catch(() => ({})) : {};
        const locks = Array.isArray(avail.models)
          ? avail.models.filter(
              (l) =>
                l.provider === entry.providerId &&
                (l.model === entry.id ||
                  l.model === "__all" ||
                  l.model === entry.fullModel)
            )
          : [];
        if (!cancelled) {
          setInfo({
            connections: conns.filter((c) => c.provider === entry.providerId),
            locks,
          });
        }
      } catch {
        if (!cancelled) setInfo({ connections: [], locks: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry]);

  return (
    <Modal
      isOpen
      title={`Compatibility — ${entry.fullModel}`}
      onClose={onClose}
    >
      {!info && <p className="text-xs text-text-muted">Loading...</p>}
      {info && (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-semibold mb-1">
              Connections ({info.connections.length})
            </p>
            {info.connections.length === 0 && (
              <p className="text-xs text-text-muted">
                No connections for this provider.
              </p>
            )}
            {info.connections.map((c) => (
              <div
                key={c.id}
                className="text-xs text-text-muted border border-border rounded-lg px-2 py-1.5 mb-1"
              >
                <span className="font-mono">{c.name || c.email || c.id}</span>
                {" · "}status: {c.testStatus || "unknown"}
                {c.lastError && (
                  <span className="text-red-500 break-words">
                    {" · "}
                    {String(c.lastError).slice(0, 160)}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold mb-1">Cooldowns / locks</p>
            {info.locks.length === 0 && (
              <p className="text-xs text-text-muted">
                No active cooldowns for this model.
              </p>
            )}
            {info.locks.map((l, i) => (
              <div
                key={i}
                className="text-xs text-text-muted border border-border rounded-lg px-2 py-1.5 mb-1"
              >
                <span className="font-mono">{l.model}</span> · {l.status}
                {l.until && ` until ${l.until}`}
                {l.lastError && (
                  <span className="text-red-500 break-words">
                    {" · "}
                    {String(l.lastError).slice(0, 160)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

ModelCompatibilityModal.propTypes = {
  entry: PropTypes.shape({
    id: PropTypes.string.isRequired,
    fullModel: PropTypes.string.isRequired,
    providerId: PropTypes.string,
  }).isRequired,
  onClose: PropTypes.func.isRequired,
};
