import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Input, Spinner } from "@/shared/components";
import { getModelsByProviderId } from "@/shared/constants/models";
import { AI_PROVIDERS, FREE_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { isModelBlocked, isModelHidden } from "@/shared/utils/modelEligibility";

function textValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if (typeof value.message === "string") return value.message;
    if (typeof value.error === "string") return value.error;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function isChatModel(model) {
  const kind = model?.type || model?.kinds?.[0] || "llm";
  if (kind !== "llm") return false;
  const id = String(model?.id || "").toLowerCase();
  return !id.includes("embed") && !id.includes("tts") && !id.includes("stt");
}

function readAssistantText(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const choice = chunk.choices?.[0];
  const delta = choice?.delta || {};
  const pieces = [delta.content, choice?.message?.content, chunk.output_text, chunk.text]
    .map(textValue)
    .filter(Boolean);
  return pieces[0] || "";
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `pg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// Resolve a manually entered model id against the selected provider.
// An explicitly provider-qualified id (any known provider id/alias prefix)
// is sent as-is — explicit user intent always wins and is shown verbatim in
// the "Sends as" preview, so it can never silently route elsewhere.
function resolveCustomRequest(raw, selectedAlias, knownPrefixes) {
  const id = String(raw || "").trim();
  if (!id) return "";
  const slash = id.indexOf("/");
  // An explicitly provider-qualified id is sent as-is (shown verbatim).
  if (slash > 0 && knownPrefixes.has(id.slice(0, slash).toLowerCase())) return id;
  // Bare ids need a selected provider to resolve against.
  if (!selectedAlias) return "";
  return `${selectedAlias}/${id}`;
}

const ALL_PROVIDERS = "__all__";

// Live resolvers that already return dashboard-routed full ids
// ("alias/upstream") instead of raw upstream ids. Every other resolver
// returns raw upstream ids that must be prefixed (see loader).
const LIVE_IDS_ALREADY_ROUTED = new Set(["qoder"]);

// Searchable dropdown (button + popover with filter input), theme-matched.
function SearchableDropdown({ label, placeholder, searchPlaceholder, value, options, onPick, disabled, hint }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open ]);
  const selected = options.find((o) => o.value === value) || null;
  const q = query.trim().toLowerCase();
  const filtered = (q
    ? options.filter((o) => `${o.label} ${o.sub || ""} ${o.value}`.toLowerCase().includes(q))
    : options
  ).slice(0, 150);
  return (
    <div className="flex flex-col gap-1.5" ref={ref}>
      {label && <span className="text-sm font-medium text-text-main">{label}</span>}
      <div className="relative">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          className="w-full py-2.5 px-3 pr-10 text-sm text-left text-text-main bg-surface-2 border border-transparent rounded-[10px] appearance-none focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed text-[16px] sm:text-sm"
        >
          <span className={selected ? "" : "text-text-muted"}>{selected ? selected.label : placeholder}</span>
        </button>
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-text-muted">
          <span className="material-symbols-outlined text-[20px]">expand_more</span>
        </div>
        {open && !disabled ? (
          <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-[12px] border border-border bg-surface shadow-2xl">
            <div className="p-2 border-b border-border">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder || "Search..."}
                className="w-full py-2 px-3 text-sm text-text-main bg-surface-2 rounded-[8px] outline-none placeholder:text-text-muted focus:ring-2 focus:ring-brand-500/30"
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-xs text-text-muted">No matches.</p>
              ) : filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => { onPick(o.value); setOpen(false); setQuery(""); }}
                  className={`w-full text-left px-3 py-2 rounded-[8px] transition ${o.value === value ? "bg-brand-500/15 text-text-main" : "hover:bg-surface-2 text-text-main"}`}
                >
                  <span className="block text-sm truncate">{o.label}</span>
                  {o.sub ? <span className="block text-[11px] text-text-muted truncate font-mono">{o.sub}</span> : null}
                </button>
              ))}
              {options.length > filtered.length ? (
                <p className="px-3 py-1.5 text-[11px] text-text-muted">Showing {filtered.length} of {options.length} — refine your search.</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

export default function PlaygroundPage() {
  const [providers, setProviders] = useState([]);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [modelMode, setModelMode] = useState("select"); // "select" | "custom"
  const [customModelId, setCustomModelId] = useState("");
  const [workingOnly, setWorkingOnly] = useState(false);
  const [workingList, setWorkingList] = useState(null); // canonical GET /api/models/working or null
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState("");
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  // Load configured providers + their models (connections, live discovery, static lists).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingProviders(true);
      setLoadError("");
      try {
        const res = await fetch("/api/providers", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(textValue(data.error) || `Failed to load providers (${res.status})`);
        const connections = (Array.isArray(data.connections) ? data.connections : [])
          .filter((c) => c?.isActive !== false);

        // Visibility (hide), hard-disable (blocks), and latest test results.
        const [disRes, blockRes, resRes] = await Promise.all([
          fetch("/api/models/disabled", { cache: "no-store" }).catch(() => null),
          fetch("/api/models/blocks", { cache: "no-store" }).catch(() => null),
          fetch("/api/models/test-results", { cache: "no-store" }).catch(() => null),
        ]);
        const hiddenMap = disRes?.ok ? (await disRes.json().catch(() => ({}))).disabled || {} : {};
        const blocksMap = blockRes?.ok ? (await blockRes.json().catch(() => ({}))).blocked || {} : {};
        const testMap = {};
        if (resRes?.ok) {
          const all = (await resRes.json().catch(() => ({}))).results || {};
          for (const [fullModel, r] of Object.entries(all)) {
            if (r?.status === "passed") testMap[fullModel] = "ok";
            else if (r?.status === "failed" || r?.status === "timeout") testMap[fullModel] = "error";
          }
        }

        const groups = new Map();
        const ensureGroup = (id) => {
          if (!groups.has(id)) {
            const def = AI_PROVIDERS[id] || {};
            groups.set(id, {
              id,
              name: def.name || id,
              noAuth: !!def.noAuth,
              models: new Map(),
            });
          }
          return groups.get(id);
        };
        const addModel = (group, id, name, request) => {
          if (!id) return;
          const key = request || id;
          if (!group.models.has(key)) group.models.set(key, { id: key, name: name || id, request: key });
        };

        // Static catalog models for every configured (or no-auth) provider.
        const withConnections = new Set(connections.map((c) => c.provider || c.id));
        for (const pid of withConnections) ensureGroup(pid);
        for (const [pid, def] of Object.entries(FREE_PROVIDERS)) {
          if (def?.noAuth) ensureGroup(pid);
        }
        for (const group of groups.values()) {
          const alias = getProviderAlias(group.id) || group.id;
          for (const m of getModelsByProviderId(group.id)) {
            if (!isChatModel(m)) continue;
            addModel(group, m.id, m.name || m.id, `${alias}/${m.id}`);
          }
        }

        // Live discovered models per connection.
        await Promise.all(connections.map(async (conn) => {
          const pid = conn.provider || conn.id;
          const group = ensureGroup(pid);
          try {
            const r = await fetch(`/api/providers/${conn.id}/models`, { cache: "no-store" });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return;
            const list = Array.isArray(d?.models) ? d.models : Array.isArray(d?.data) ? d.data : [];
            const alias = getProviderAlias(pid) || pid;
            for (const m of list) {
              const rawId = typeof m === "string" ? m : m?.id || m?.model || "";
              if (!rawId || !isChatModel(typeof m === "string" ? { id: rawId } : m)) continue;
              const name = typeof m === "string" ? rawId : m?.name || m?.displayName || rawId;
              // Always prefix with the provider alias — exactly like the Models
              // page `fullModel`. Upstream ids may themselves contain a slash
              // (e.g. NVIDIA first-party ids like "nvidia/ising-..."), and the
              // router + test records both use the doubled form
              // ("nvidia/nvidia/ising-..."). Sending them bare would route to a
              // nonexistent provider or 404 upstream.
              // Exception: resolvers that already return dashboard-routed full
              // ids (currently only qoder) are kept as-is.
              const alreadyRouted = LIVE_IDS_ALREADY_ROUTED.has(pid) && rawId.startsWith(`${alias}/`);
              addModel(group, rawId, name, alreadyRouted ? rawId : `${alias}/${rawId}`);
            }
          } catch {
            // Live discovery is best-effort; static models still work.
          }
        }));

        // Canonical eligible-working-models list (shared definition with the
        // Models Working filter). Used for working-only mode so header count
        // and dropdown always match. Falls back to client-side filtering.
        let working = null;
        try {
          const wRes = await fetch("/api/models/working", { cache: "no-store" });
          if (wRes?.ok) working = (await wRes.json().catch(() => ({}))).models || null;
        } catch { /* fallback below */ }

        const normalized = Array.from(groups.values())
          .map((g) => {
            const alias = getProviderAlias(g.id) || g.id;
            const models = Array.from(g.models.values()).map((m) => {
              const slash = m.request.indexOf("/");
              const mid = slash >= 0 ? m.request.slice(slash + 1) : m.request;
              return {
                ...m,
                providerId: g.id,
                providerName: g.name,
                hidden: isModelHidden(g.id, alias, mid, hiddenMap),
                blocked: isModelBlocked(g.id, alias, mid, blocksMap),
                test: testMap[m.request] || "untested",
              };
            }).sort((a, b) => a.name.localeCompare(b.name));
            return { ...g, models };
          })
          .filter((g) => g.models.length > 0)
          .sort((a, b) => a.name.localeCompare(b.name));

        if (cancelled) return;
        setProviders(normalized);
        if (!cancelled && Array.isArray(working)) setWorkingList(working);
        if (normalized.length === 0) {
          setLoadError("No providers with chat models found. Connect a provider first.");
        } else {
          const firstEligible = normalized.find((g) => g.models.some((m) => !m.hidden && !m.blocked));
          const fallback = firstEligible || normalized[0];
          const firstModel = fallback.models.find((m) => !m.hidden && !m.blocked) || fallback.models[0];
          setProviderId((prev) => prev || fallback.id);
          setModelId((prev) => prev || firstModel?.request || "");
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(textValue(e?.message) || "Failed to load providers.");
          setProviders([]);
        }
      } finally {
        if (!cancelled) setLoadingProviders(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Providers with at least one selectable model (hidden + blocked excluded).
  const eligibleProviders = useMemo(
    () => providers
      .map((p) => ({ ...p, models: p.models.filter((m) => !m.hidden && !m.blocked) }))
      .filter((p) => p.models.length > 0),
    [providers]
  );
  const activeProvider = useMemo(
    () => (providerId === ALL_PROVIDERS ? null : eligibleProviders.find((p) => p.id === providerId) || null),
    [eligibleProviders, providerId]
  );

  // Model options for the current scope. In working-only mode the options
  // come from the canonical GET /api/models/working list (same definition
  // as the Models Working filter), so header count and dropdown always
  // match. Each option carries its provider so selection auto-resolves
  // unambiguously (duplicates appear once per provider).
  const modelOptions = useMemo(() => {
    if (workingOnly && Array.isArray(workingList)) {
      const scope = providerId === ALL_PROVIDERS
        ? workingList
        : workingList.filter((w) => w.provider === providerId);
      return scope.map((w) => ({
        value: w.fullModel,
        label: providerId === ALL_PROVIDERS
          ? `${w.name} (${AI_PROVIDERS[w.provider]?.name || w.provider})`
          : w.name,
        sub: w.fullModel,
        request: w.fullModel,
        providerId: w.provider,
        providerName: AI_PROVIDERS[w.provider]?.name || w.provider,
      })).sort((a, b) => a.label.localeCompare(b.label));
    }
    const scope = workingOnly
      ? (providerId === ALL_PROVIDERS ? eligibleProviders : eligibleProviders.filter((p) => p.id === providerId))
      : (activeProvider ? [activeProvider] : []);
    const out = [];
    for (const p of scope) {
      for (const m of p.models) {
        if (workingOnly && m.test !== "ok") continue;
        out.push({
          value: m.request,
          label: workingOnly && providerId === ALL_PROVIDERS ? `${m.name} (${p.name})` : m.name,
          sub: m.request,
          request: m.request,
          providerId: p.id,
          providerName: p.name,
        });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [workingOnly, providerId, eligibleProviders, activeProvider, workingList]);

  const activeModel = useMemo(
    () => modelOptions.find((o) => o.value === modelId) || null,
    [modelOptions, modelId]
  );

  // In working-only mode the provider dropdown lists only providers that
  // actually have working models.
  const workingProviderIds = useMemo(() => {
    if (Array.isArray(workingList)) return [...new Set(workingList.map((w) => w.provider))];
    const set = new Set();
    for (const p of eligibleProviders) {
      if (p.models.some((m) => m.test === "ok")) set.add(p.id);
    }
    return [...set];
  }, [workingList, eligibleProviders]);
  const providerOptions = workingOnly
    ? eligibleProviders.filter((p) => workingProviderIds.includes(p.id))
    : eligibleProviders;

  // The exact model string sent to /api/v1/chat/completions, always in
  // "<provider-alias>/<upstream-id>" form so the backend routes to the
  // selected provider (never to a stray prefix inside the upstream id).
  const knownPrefixes = useMemo(() => {
    const set = new Set();
    for (const [id, def] of Object.entries(AI_PROVIDERS)) {
      set.add(String(id).toLowerCase());
      if (def?.alias) set.add(String(def.alias).toLowerCase());
    }
    return set;
  }, []);
  const resolvedRequest = useMemo(() => {
    if (modelMode === "custom") {
      const alias = activeProvider ? getProviderAlias(activeProvider.id) || activeProvider.id : "";
      return resolveCustomRequest(customModelId, alias, knownPrefixes);
    }
    return activeModel?.request || "";
  }, [modelMode, customModelId, activeProvider, activeModel, knownPrefixes]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const pickFirstModel = (pid, list) => {
    if (workingOnly && Array.isArray(workingList)) {
      const scope = pid === ALL_PROVIDERS ? workingList : workingList.filter((w) => w.provider === pid);
      const first = scope[0];
      return first ? { providerId: first.provider, modelId: first.fullModel } : { providerId: pid, modelId: "" };
    }
    const scope = pid === ALL_PROVIDERS ? list : list.filter((p) => p.id === pid);
    for (const p of scope) {
      const m = p.models.find((m) => !workingOnly || m.test === "ok");
      if (m) return { providerId: p.id, modelId: m.request };
    }
    return { providerId: pid, modelId: "" };
  };

  const handleProviderChange = (pid) => {
    const pick = pickFirstModel(pid, eligibleProviders);
    setProviderId(pick.providerId);
    setModelId(pick.modelId);
    setChatError("");
  };

  const handleSelectModel = (value) => {
    const opt = modelOptions.find((o) => o.value === value);
    if (!opt) return;
    // Auto-resolve the provider from the selected option (unambiguous —
    // every option carries its own provider).
    setProviderId(opt.providerId);
    setModelId(opt.value);
    setChatError("");
  };

  const handleWorkingToggle = (on) => {
    setWorkingOnly(on);
    setChatError("");
    if (on) {
      setProviderId(ALL_PROVIDERS);
      setModelId("");
    } else if (eligibleProviders.length > 0) {
      const first = eligibleProviders[0];
      setProviderId(first.id);
      setModelId(first.models[0]?.request || "");
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    const requestModel = resolvedRequest;
    if (!text || sending || !requestModel) return;

    const userMsg = { id: createId(), role: "user", content: text, status: "done" };
    const assistantMsg = { id: createId(), role: "assistant", content: "", status: "streaming", request: requestModel };
    const history = [...messages, userMsg];
    setMessages([...history, assistantMsg]);
    setInput("");
    setChatError("");
    setSending(true);
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const response = await fetch("/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          model: requestModel,
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(textValue(errData?.error?.message || errData?.error || `Request failed (${response.status})`));
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const data = await response.json().catch(() => ({}));
        const fallback = textValue(data?.choices?.[0]?.message?.content);
        if (!fallback) throw new Error("Provider returned an empty response.");
        setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: fallback, status: "done" } : m)));
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let acc = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const text = readAssistantText(JSON.parse(payload));
            if (!text) continue;
            acc += text;
            const snapshot = acc;
            setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: snapshot } : m)));
          } catch {
            // Ignore malformed chunks.
          }
        }
      }
      if (!acc) throw new Error("Provider returned an empty response.");
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: acc, status: "done" } : m)));
    } catch (e) {
      if (e?.name === "AbortError") {
        setMessages((prev) => prev
          .map((m) => (m.id === assistantMsg.id ? { ...m, status: "done" } : m))
          .filter((m) => m.role !== "assistant" || m.content));
        return;
      }
      const msg = textValue(e?.message) || "Failed to send message.";
      setChatError(msg);
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content || `Error: ${msg}`, status: "error" } : m)));
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const canSend = !sending && !!resolvedRequest && input.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold mr-auto text-text-main">Playground</h1>
        {modelMode === "select" ? (
          <span className="text-xs text-text-muted">{modelOptions.length} model{modelOptions.length === 1 ? "" : "s"}{workingOnly ? " working" : ""}</span>
        ) : null}
      </div>

      <Card className="p-4">
        {loadingProviders ? (
          <div className="flex items-center gap-2 text-sm text-text-muted"><Spinner /> Loading providers…</div>
        ) : loadError && providers.length === 0 ? (
          <p className="text-sm text-red-500">{loadError}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-xs text-text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={workingOnly}
                disabled={sending}
                onChange={(e) => handleWorkingToggle(e.target.checked)}
                className="accent-green-600"
              />
              Working models only (latest test passed)
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <SearchableDropdown
                label="Provider"
                placeholder="Select provider"
                searchPlaceholder="Search providers by name or id..."
                value={providerId}
                disabled={sending}
                onPick={handleProviderChange}
                options={[
                  ...(workingOnly ? [{ value: ALL_PROVIDERS, label: "All providers", sub: `${modelOptions.length} working models` }] : []),
                  ...providerOptions.map((p) => ({
                    value: p.id,
                    label: `${p.name}${p.noAuth ? " (no key needed)" : ""}`,
                    sub: `${p.models.length} models`,
                  })),
                ]}
              />
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1 rounded-[10px] bg-surface-2 p-1 text-xs font-semibold">
                  {(["select", "custom"]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      disabled={sending}
                      onClick={() => { setModelMode(mode); setChatError(""); }}
                      className={`flex-1 rounded-[7px] px-2 py-1.5 transition ${modelMode === mode ? "bg-brand-500 text-white" : "text-text-muted hover:text-text-main"} disabled:opacity-50`}
                    >
                      {mode === "select" ? "Select Model" : "Enter Model ID"}
                    </button>
                  ))}
                </div>
                {modelMode === "select" ? (
                  <SearchableDropdown
                    placeholder="Select model"
                    searchPlaceholder="Search models by id or name..."
                    value={modelId}
                    disabled={sending || modelOptions.length === 0}
                    onPick={handleSelectModel}
                    options={modelOptions}
                  />
                ) : (
                  <Input
                    placeholder="e.g. meta/llama-3.1-405b-instruct"
                    value={customModelId}
                    disabled={sending || (providerId !== ALL_PROVIDERS && !activeProvider)}
                    onChange={(e) => { setCustomModelId(e.target.value); setChatError(""); }}
                    error={!customModelId.trim() ? "Enter a model ID to send." : undefined}
                    hint={providerId === ALL_PROVIDERS ? "Tip: include the provider prefix (e.g. nvidia/...) or pick a provider first." : undefined}
                  />
                )}
                <p className="text-xs text-text-muted">
                  {resolvedRequest ? (
                    <>Sends as <span className="font-mono text-text-main">{resolvedRequest}</span></>
                  ) : (
                    "Select a provider and model (or enter a model ID)."
                  )}
                </p>
              </div>
            </div>
          </div>
        )}
      </Card>

      {chatError ? (
        <div className="rounded-[12px] border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-500 flex items-start gap-2">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span className="break-words">{chatError}</span>
        </div>
      ) : null}

      <Card className="p-0 overflow-hidden">
        <div ref={scrollRef} className="h-[52vh] min-h-[320px] overflow-y-auto p-4 flex flex-col gap-3">
          {messages.length === 0 ? (
            <div className="m-auto text-center max-w-md">
              <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl bg-surface-2 text-text-muted">
                <span className="material-symbols-outlined text-[26px]">science</span>
              </div>
              <p className="text-sm font-semibold text-text-main">Test any configured model</p>
              <p className="mt-1 text-xs text-text-muted">Pick a provider and model above, then send a message. Requests go through the normal 9Router routing.</p>
            </div>
          ) : messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 break-words whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-brand-500 text-white"
                  : m.status === "error"
                    ? "bg-red-500/10 text-red-500 border border-red-500/30"
                    : "bg-surface-2 text-text-main"
              }`}>
                {m.content || (m.status === "streaming" ? <span className="animate-pulse">▋</span> : "")}
                {m.role === "assistant" && m.request ? (
                  <p className="mt-1.5 font-mono text-[10px] opacity-60">via {m.request}</p>
                ) : null}
              </div>
            </div>
          ))}
          {sending && messages[messages.length - 1]?.status !== "streaming" ? (
            <div className="flex justify-start">
              <div className="bg-surface-2 rounded-2xl px-4 py-2.5 text-text-muted"><Spinner /></div>
            </div>
          ) : null}
        </div>

        <div className="border-t border-border p-3 flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={resolvedRequest ? `Message ${resolvedRequest}…` : "Select a model first…"}
            rows={2}
            disabled={!resolvedRequest || loadingProviders}
            className="flex-1 resize-none rounded-[10px] bg-surface-2 px-3 py-2.5 text-sm text-text-main outline-none placeholder:text-text-muted focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50 max-h-[30vh]"
          />
          {sending ? (
            <Button variant="secondary" icon="stop" onClick={() => abortRef.current?.abort()}>Stop</Button>
          ) : (
            <Button icon="arrow_upward" onClick={sendMessage} disabled={!canSend} loading={false}>Send</Button>
          )}
          <Button variant="ghost" icon="delete" onClick={() => { setMessages([]); setChatError(""); }} disabled={messages.length === 0 || sending}>Clear</Button>
        </div>
      </Card>
    </div>
  );
}
