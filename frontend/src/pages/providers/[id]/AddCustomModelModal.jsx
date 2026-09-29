import { useState, useEffect, useMemo, useCallback } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import {
  MODEL_CAPABILITIES,
  CAPABILITY_SPECS,
  normalizeCapabilities,
  buildRegisteredId,
  splitRegisteredId,
} from "@/shared/constants/modelCapabilities";

// ── AddCustomModelModal ───────────────────────────────────────────
// The ONE Add Model dialog for every provider page.
//
// Changes from the previous version:
//   - capabilities are a SET, not a single type. A model that chats AND
//     embeds is representable, and each capability is tested on its own.
//   - the provider prefix is editable per model, so "ago/gemini-3.7-flash-low"
//     can be registered next to an existing "ag/gemini-3.7-flash-low" without
//     touching it.
//   - only the settings relevant to the SELECTED capabilities are shown.
//   - Test Model runs the real capability adapters; an unsupported capability
//     is reported as unsupported, never as a red failure.
//
// Prefixes of OTHER models are never read or written here — the modal only
// ever addresses the single id it is composing.

const KIND_LABELS = {
  chat: { label: "Chat", icon: "smart_toy", color: "text-blue-400" },
  image: { label: "Image gen", icon: "brush", color: "text-purple-400" },
  vision: { label: "Vision", icon: "visibility", color: "text-cyan-400" },
  video: { label: "Video gen", icon: "movie", color: "text-orange-400" },
  audio: { label: "Audio", icon: "graphic_eq", color: "text-teal-400" },
  stt: { label: "Speech→text", icon: "record_voice_over", color: "text-emerald-400" },
  tts: { label: "Text→speech", icon: "campaign", color: "text-amber-400" },
  embedding: { label: "Embeddings", icon: "data_array", color: "text-indigo-400" },
  rerank: { label: "Rerank", icon: "sort", color: "text-pink-400" },
  custom: { label: "Custom", icon: "extension", color: "text-text-muted" },
};

// Capabilities that can reasonably coexist on one model. Offering image+chat is
// legitimate; image+stt is not, and allowing it would register a model the
// router can never use.
const MUTUALLY_EXCLUSIVE = [
  ["image", "video"],
  ["stt", "tts"],
  ["embedding", "rerank"],
  ["embedding", "image"],
  ["embedding", "video"],
];

function conflictsWith(capability, selected) {
  return MUTUALLY_EXCLUSIVE.some(
    (pair) =>
      (pair[0] === capability && selected.includes(pair[1])) ||
      (pair[1] === capability && selected.includes(pair[0]))
  );
}

function StatusPill({ result }) {
  if (!result) return null;
  const { ok, status, capability, error, errorCode } = result;
  const unsupported = status === "unsupported" || errorCode === "unsupported";
  const tone = ok
    ? "border-green-500/40 text-green-500 bg-green-500/10"
    : unsupported
      ? "border-border text-text-muted bg-sidebar"
      : "border-red-500/40 text-red-500 bg-red-500/10";
  const label = ok
    ? "working"
    : unsupported
      ? "unsupported"
      : status === "testing"
        ? "testing"
        : status === "untested"
          ? "untested"
          : "error";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] ${tone}`}
      title={error || `${capability}: ${label}`}
    >
      {label}
      {error && !ok && !unsupported ? <span className="opacity-70">· {String(error).slice(0, 60)}</span> : null}
    </span>
  );
}

StatusPill.propTypes = { result: PropTypes.object };

export default function AddCustomModelModal({
  isOpen,
  providerAlias,
  providerDisplayAlias,
  allowedKinds,
  onSave,
  onClose,
}) {
  // A provider's serviceKinds gate what may be offered, but only as a
  // suggestion: a provider that declares ["llm"] can still be asked about
  // vision, because a chat model very often is one. Anything the user cannot
  // test is rejected server-side with a real reason.
  const suggested = useMemo(
    () => normalizeCapabilities(allowedKinds),
    [allowedKinds]
  );

  const [prefix, setPrefix] = useState("");
  const [modelId, setModelId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [capabilities, setCapabilities] = useState(["chat"]);
  const [endpoint, setEndpoint] = useState("");
  const [capabilitySettings, setCapabilitySettings] = useState({});
  const [results, setResults] = useState({});
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Default the prefix to the provider's own prefix/alias so the common case
  // needs no typing, but the user can change it for this model alone.
  useEffect(() => {
    if (!isOpen) return;
    setPrefix(providerAlias || "");
    setModelId("");
    setDisplayName("");
    setCapabilities(suggested.includes("chat") || suggested.length === 0 ? ["chat"] : [suggested[0]]);
    setEndpoint("");
    setCapabilitySettings({});
    setResults({});
    setTesting(false);
    setSaving(false);
    setError("");
  }, [isOpen, providerAlias, suggested]);

  const stripPrefix = useCallback(
    (raw) => {
      const value = String(raw || "").trim();
      if (!value) return "";
      const prefixToStrip = `${String(prefix || "").trim()}/`;
      return value.startsWith(prefixToStrip) ? value.slice(prefixToStrip.length) : value;
    },
    [prefix]
  );

  // The single source of truth for what gets registered. The modal shows this
  // exact string, and the server recomputes it with the same rule, so what the
  // user sees is what is stored.
  const registeredId = useMemo(() => {
    const cleanPrefix = String(prefix || "").trim();
    const cleanModel = stripPrefix(modelId);
    if (!cleanPrefix || !cleanModel) return "";
    return buildRegisteredId(cleanPrefix, cleanModel);
  }, [prefix, modelId, stripPrefix]);

  const toggleCapability = useCallback((id) => {
    setCapabilities((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((c) => c !== id);
        return next.length ? next : prev; // never allow an empty set
      }
      if (conflictsWith(id, prev)) return prev;
      return [...prev, id];
    });
  }, []);

  const selectedSpecs = useMemo(
    () => capabilities.map((id) => CAPABILITY_SPECS[id]).filter(Boolean),
    [capabilities]
  );
  const needsEndpoint = selectedSpecs.some((s) => s.requiresEndpointConfig);
  // Expensive operations deserve a warning before the user pays for them.
  const expensive = selectedSpecs.filter((s) => s.cheap === false);
  const canSubmit = registeredId && capabilities.length > 0 && !(needsEndpoint && !endpoint.trim());

  const handleTest = useCallback(async () => {
    if (!registeredId || testing) return;
    setError("");
    setTesting(true);
    setResults({});
    try {
      const targets = capabilities.length ? capabilities : ["chat"];
      for (const capability of targets) {
        setResults((prev) => ({ ...prev, [capability]: { status: "testing", capability } }));
        try {
          const res = await fetch("/api/models/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: registeredId,
              capability,
              persist: false,
              settings: {
                ...(capabilitySettings[capability] || {}),
                ...(capability === "custom" ? { endpoint } : {}),
              },
            }),
          });
          const data = await res.json().catch(() => ({}));
          setResults((prev) => ({
            ...prev,
            [capability]: {
              ok: !!data.ok,
              status: data.status || (data.ok ? "passed" : "error"),
              capability,
              error: data.error || null,
              errorCode: data.errorCode || null,
            },
          }));
        } catch (err) {
          setResults((prev) => ({
            ...prev,
            [capability]: {
              ok: false,
              status: "error",
              capability,
              error: err?.message || "Test failed",
            },
          }));
        }
      }
    } finally {
      setTesting(false);
    }
  }, [registeredId, capabilities, capabilitySettings, endpoint, testing]);

  const handleSave = useCallback(async () => {
    if (!canSubmit || saving) return;
    setError("");
    setSaving(true);
    try {
      await onSave({
        prefix: String(prefix || "").trim(),
        modelId: stripPrefix(modelId),
        capabilities,
        displayName: displayName.trim() || undefined,
        endpoint: needsEndpoint ? endpoint.trim() : undefined,
        settings: capabilitySettings,
        registeredId,
      });
    } catch (err) {
      setError(err?.message || "Could not add the model");
    } finally {
      setSaving(false);
    }
  }, [canSubmit, saving, prefix, modelId, capabilities, displayName, needsEndpoint, endpoint, capabilitySettings, registeredId, onSave, stripPrefix]);

  const cleanPrefix = String(prefix || "").trim();
  const prefixError = cleanPrefix && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(cleanPrefix)
    ? "Use letters, digits, dot, dash or underscore."
    : "";
  const modelIdError = stripPrefix(modelId) && /\s/.test(stripPrefix(modelId))
    ? "Model ids cannot contain spaces."
    : "";

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Model">
      <div className="flex flex-col gap-4">
        {/* ── Capabilities ─────────────────────────────────────────── */}
        <div>
          <label className="text-sm font-medium mb-1.5 block">
            Capabilities
            <span className="ml-1.5 text-[11px] font-normal text-text-muted">
              A model can support more than one.
            </span>
          </label>
          <div className="flex flex-wrap gap-1.5">
            {MODEL_CAPABILITIES.map((id) => {
              const meta = KIND_LABELS[id] || { label: id, icon: "category", color: "text-text-muted" };
              const active = capabilities.includes(id);
              const blocked = !active && conflictsWith(id, capabilities);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleCapability(id)}
                  disabled={blocked}
                  title={
                    blocked
                      ? `Not compatible with ${capabilities.filter((c) => conflictsWith(id, [c])).join(", ")}`
                      : CAPABILITY_SPECS[id]?.label || id
                  }
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-all disabled:opacity-40 ${
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-sidebar text-text-muted hover:border-primary/40 hover:text-text-main"
                  }`}
                >
                  <span className={`material-symbols-outlined text-sm ${active ? "text-primary" : meta.color}`}>
                    {meta.icon}
                  </span>
                  {meta.label}
                </button>
              );
            })}
          </div>
          {expensive.length > 0 && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1.5">
              {expensive.map((s) => s.label).join(", ")} may incur provider charges and take up to{" "}
              {Math.max(...expensive.map((s) => s.timeoutMs / 1000))}s per test.
            </p>
          )}
        </div>

        {/* ── Prefix + Model id ───────────────────────────────────── */}
        <div>
          <label className="text-sm font-medium mb-1.5 block">Model ID</label>
          <div className="flex gap-2">
            <div className="w-28 shrink-0">
              <input
                type="text"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="prefix"
                aria-label="Provider prefix for this model"
                className={`w-full px-2.5 py-2 text-sm border rounded-lg bg-background focus:outline-none ${
                  prefixError ? "border-red-500/40" : "border-border focus:border-primary"
                }`}
              />
              <p className="text-[10px] text-text-muted mt-0.5">prefix</p>
            </div>
            <div className="flex-1 min-w-0">
              <input
                type="text"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="gemini-3.7-flash-low"
                autoFocus
                className={`w-full px-3 py-2 text-sm border rounded-lg bg-background focus:outline-none ${
                  modelIdError ? "border-red-500/40" : "border-border focus:border-primary"
                }`}
              />
              <p className="text-[10px] text-text-muted mt-0.5">upstream model id</p>
            </div>
          </div>
          {(prefixError || modelIdError) && (
            <p className="text-[11px] text-red-500 mt-1">{prefixError || modelIdError}</p>
          )}
          <p className="text-xs text-text-muted mt-1.5">
            Will be registered as:{" "}
            <code className="font-mono bg-sidebar px-1 rounded text-text-main">
              {registeredId || `${cleanPrefix || "prefix"}/${stripPrefix(modelId) || "model-id"}`}
            </code>
            <span className="ml-1.5 text-[11px] opacity-80">
              Only this model uses this prefix.
            </span>
          </p>
        </div>

        {/* ── Display name ────────────────────────────────────────── */}
        <div>
          <label className="text-sm font-medium mb-1.5 block">
            Display name <span className="text-[11px] font-normal text-text-muted">(optional)</span>
          </label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={stripPrefix(modelId) || "Friendly name"}
            className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
          />
          <p className="text-[10px] text-text-muted mt-0.5">
            Shown in the dashboard only — requests always use the upstream id above.
          </p>
        </div>

        {/* ── Operation settings, only for the selected capabilities ─ */}
        {selectedSpecs.length > 0 && (
          <div>
            <label className="text-sm font-medium mb-1.5 block">Operation settings</label>
            <div className="flex flex-col gap-2">
              {selectedSpecs.map((spec) => (
                <div key={spec.id} className="rounded-lg border border-border px-2.5 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-sm text-text-muted">{spec.icon}</span>
                    <span className="text-xs font-medium">{spec.label}</span>
                    <code className="text-[10px] font-mono text-text-muted">{spec.endpoint || "custom path"}</code>
                    {spec.cheap === false && (
                      <span className="text-[10px] text-amber-500">may cost</span>
                    )}
                    <StatusPill result={results[spec.id]} />
                  </div>

                  {spec.requiresEndpointConfig && (
                    <input
                      type="text"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      placeholder="/v1/your-endpoint"
                      className="w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
                    />
                  )}

                  {spec.id === "tts" && (
                    <input
                      type="text"
                      value={capabilitySettings.tts?.input || ""}
                      onChange={(e) =>
                        setCapabilitySettings((s) => ({ ...s, tts: { ...s.tts, input: e.target.value } }))
                      }
                      placeholder="Text to speak (required to test TTS)"
                      className="w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
                    />
                  )}

                  {(spec.id === "stt" || spec.id === "audio") && (
                    <p className="text-[10px] text-text-muted">
                      A short silent clip is generated automatically for the test.{" "}
                      {spec.id === "stt"
                        ? "Empty audio returns no transcription, so expect a failure with silent input."
                        : ""}
                    </p>
                  )}

                  {spec.id === "rerank" && (
                    <input
                      type="text"
                      value={capabilitySettings.rerank?.query || ""}
                      onChange={(e) =>
                        setCapabilitySettings((s) => ({ ...s, rerank: { ...s.rerank, query: e.target.value } }))
                      }
                      placeholder="Query (optional — defaults to 'test')"
                      className="w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
                    />
                  )}

                  {spec.id === "vision" && (
                    <input
                      type="text"
                      value={capabilitySettings.vision?.imageUrl || ""}
                      onChange={(e) =>
                        setCapabilitySettings((s) => ({ ...s, vision: { ...s.vision, imageUrl: e.target.value } }))
                      }
                      placeholder="Image URL (optional — a 1×1 PNG is used by default)"
                      className="w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
                    />
                  )}

                  {spec.id === "image" && (
                    <select
                      value={capabilitySettings.image?.size || "1024x1024"}
                      onChange={(e) =>
                        setCapabilitySettings((s) => ({ ...s, image: { ...s.image, size: e.target.value } }))
                      }
                      className="w-full px-2.5 py-1.5 text-xs border border-border rounded-lg bg-background focus:outline-none focus:border-primary"
                    >
                      <option value="256x256">256×256 (cheapest)</option>
                      <option value="1024x1024">1024×1024</option>
                      <option value="1792x1024">1792×1024</option>
                    </select>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        <div className="flex gap-2 pt-1">
          <Button onClick={onClose} variant="ghost" fullWidth size="sm" disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={handleTest}
            disabled={!registeredId || testing || saving}
            fullWidth
            size="sm"
            icon="science"
            title={registeredId ? `Test ${capabilities.join(", ")} against the provider` : "Enter a model id first"}
          >
            {testing ? "Testing..." : "Test Model"}
          </Button>
          <Button onClick={handleSave} disabled={!canSubmit || saving || testing} fullWidth size="sm">
            {saving ? "Adding..." : "Add Model"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

AddCustomModelModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  providerAlias: PropTypes.string.isRequired,
  providerDisplayAlias: PropTypes.string,
  allowedKinds: PropTypes.arrayOf(PropTypes.string),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
