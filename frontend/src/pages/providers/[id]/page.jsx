
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useParams, useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
// next/image replaced with native img;
import { Card, Button, Badge, Input, Modal, CardSkeleton, OAuthModal, KiroOAuthWrapper, CursorAuthModal, IFlowCookieModal, GitLabAuthModal, Toggle, Select, EditConnectionModal, NoAuthProxyCard, ConfirmModal } from "@/shared/components";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, FREE_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS, THINKING_CONFIG } from "@/shared/constants/providers";
import { getModelsByProviderId } from "@/shared/constants/models";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { translate } from "@/i18n/runtime";
import { fetchSuggestedModels } from "@/shared/utils/providerModelsFetcher";
import { cachedJson, invalidateCache } from "@/shared/utils/cachedJson";
import useConnectionEvents from "@/shared/hooks/useConnectionEvents";
import ConnectionRow from "./ConnectionRow";
import AddApiKeyModal from "./AddApiKeyModal";
import EditCompatibleNodeModal from "./EditCompatibleNodeModal";
import AddCustomModelModal from "./AddCustomModelModal";
import LeonardoAdminPanel from "./LeonardoAdminPanel";
import ModelSyncPanel from "./ModelSyncPanel";
import DisabledModelsSection from "./DisabledModelsSection";
import AvailableModelsSection from "@/shared/components/AvailableModelsSection";
import BulkAddConnectionsModal from "./BulkAddConnectionsModal";
import { getProviderDisplayName, getCustomProviderVisuals } from "@/shared/utils/providerNaming";

const ONE_BY_ONE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function ProviderDetailPage() {
  const params = useParams();
  const navigate = useNavigate();
  const providerId = params.id;
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [providerNode, setProviderNode] = useState(null);
  const [proxyPools, setProxyPools] = useState([]);
  const [showOAuthModal, setShowOAuthModal] = useState(false);
  const [showIFlowCookieModal, setShowIFlowCookieModal] = useState(false);
  const [showAddApiKeyModal, setShowAddApiKeyModal] = useState(false);
  const [addConnectionError, setAddConnectionError] = useState("");
  const [showEditModal, setShowEditModal] = useState(false);
  const [showEditNodeModal, setShowEditNodeModal] = useState(false);
  const [showBulkProxyModal, setShowBulkProxyModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [modelAliases, setModelAliases] = useState({});
  const [headerImgError, setHeaderImgError] = useState(false);
  const [modelTestResults, setModelTestResults] = useState({});
  // Last failure message per model, kept separately from the ok/error status so
  // the Disabled section can show WHY a model is disabled. Records are cleared
  // on a successful test, and preserved otherwise (test history is never lost).
  const [modelTestErrors, setModelTestErrors] = useState({});
  const [modelsTestError, setModelsTestError] = useState("");
  const [testingModelIds, setTestingModelIds] = useState([]);
  const inflightTestRef = useRef(null);
  if (inflightTestRef.current === null) inflightTestRef.current = new Set();
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);
  const [modelRegistrationNotice, setModelRegistrationNotice] = useState("");
  const [selectedConnectionIds, setSelectedConnectionIds] = useState([]);
  const [bulkProxyPoolId, setBulkProxyPoolId] = useState("__none__");
  const [bulkUpdatingProxy, setBulkUpdatingProxy] = useState(false);
  const [providerStrategy, setProviderStrategy] = useState(null);
  const [providerStickyLimit, setProviderStickyLimit] = useState("");
  const [thinkingMode, setThinkingMode] = useState("auto");
  const [suggestedModels, setSuggestedModels] = useState([]);
  const [kiloFreeModels, setKiloFreeModels] = useState([]);
  const [syncedModels, setSyncedModels] = useState([]);
  const [disabledModelIds, setDisabledModelIds] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const [showAgRiskModal, setShowAgRiskModal] = useState(false);
  const [oneByOneRunning, setOneByOneRunning] = useState(false);
  const [oneByOneStopping, setOneByOneStopping] = useState(false);
  const [oneByOneCurrentConnectionId, setOneByOneCurrentConnectionId] = useState(null);
  const [oneByOneResults, setOneByOneResults] = useState({});
  const [oneByOneSummary, setOneByOneSummary] = useState(null);
  const stopOneByOneRef = useRef(false);
  const [providerTab, setProviderTab] = useState("overview"); // overview | admin
  const [showBulkAddModal, setShowBulkAddModal] = useState(false);
  const { copied, copy } = useCopyToClipboard();

  const AG_RISK_STORAGE_KEY = "ag_risk_confirmed";

  const openOAuthConnection = () => {
    setShowOAuthModal(true);
  };

  const triggerOAuthConnection = () => {
    if (providerId === "antigravity" && typeof window !== "undefined") {
      const confirmed = window.localStorage.getItem(AG_RISK_STORAGE_KEY) === "true";
      if (!confirmed) {
        setShowAgRiskModal(true);
        return;
      }
    }
    if (isOAuth) {
      openOAuthConnection();
      return;
    }
    setAddConnectionError("");
    setShowAddApiKeyModal(true);
  };

  const triggerApiKeyConnection = () => {
    setAddConnectionError("");
    setShowAddApiKeyModal(true);
  };

  const triggerAddConnection = () => {
    if (isOAuth) {
      triggerOAuthConnection();
      return;
    }
    triggerApiKeyConnection();
  };

  const handleAgRiskConfirm = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(AG_RISK_STORAGE_KEY, "true");
    }
    setShowAgRiskModal(false);
    if (isOAuth) {
      openOAuthConnection();
      return;
    }
    triggerApiKeyConnection();
  };

  // Custom-provider label: the CONFIGURED node name ("Xkiro"). Falls through
  // the node record, then a connection's nodeName, then a generic type label —
  // never the opaque `openai-compatible-chat-<uuid>` node id.
  const customProviderName = getProviderDisplayName(providerId, { node: providerNode });
  const providerInfo = providerNode
    ? {
        ...getCustomProviderVisuals(providerId, providerNode),
        id: providerNode.id,
        name: customProviderName,
        apiType: providerNode.apiType,
        baseUrl: providerNode.baseUrl,
        prefix: providerNode.prefix,
        type: providerNode.type,
      }
    : (OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId] || FREE_PROVIDERS[providerId] || FREE_TIER_PROVIDERS[providerId] || WEB_COOKIE_PROVIDERS[providerId]);
  const authModes = providerInfo?.authModes || [];
  const isOAuth = !!OAUTH_PROVIDERS[providerId] || !!FREE_PROVIDERS[providerId] || authModes.includes("oauth");
  const supportsApiKeyAuth = !!APIKEY_PROVIDERS[providerId] || authModes.includes("apikey");
  const isFreeNoAuth = !!FREE_PROVIDERS[providerId]?.noAuth;
  const models = getModelsByProviderId(providerId);
  const providerAlias = getProviderAlias(providerId);
  
  const isOpenAICompatible = isOpenAICompatibleProvider(providerId);
  const isAnthropicCompatible = isAnthropicCompatibleProvider(providerId);
  const isCompatible = isOpenAICompatible || isAnthropicCompatible;
  const hasDualAuthModes = !isCompatible && isOAuth && supportsApiKeyAuth;
  const oauthConnectionLabel = providerId === "xai" ? "Grok Build OAuth" : "OAuth";
  const apiKeyConnectionLabel = providerId === "xai" ? "xAI API Key" : "API Key";
  const thinkingConfig = AI_PROVIDERS[providerId]?.thinkingConfig || THINKING_CONFIG.extended;
  
  const providerStorageAlias = isCompatible ? providerId : providerAlias;
  const providerDisplayAlias = isCompatible
    ? (providerNode?.prefix || providerId)
    : providerAlias;

  const fetchDisabledModels = useCallback(async () => {
    try {
      const res = await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerStorageAlias)}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setDisabledModelIds(data.ids || []);
    } catch (error) {
      console.log("Error fetching disabled models:", error);
    }
  }, [providerStorageAlias]);

  // NOTE: the per-row "disable" handler moved to the shared Available Models
  // section (its hide/show and block/unblock buttons write to the same two
  // stores). Only the enable action is still needed here, for the single
  // Disabled models section.
  const handleEnableModel = async (modelId) => {
    try {
      const res = await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerStorageAlias)}&id=${encodeURIComponent(modelId)}`, { method: "DELETE" });
      if (res.ok) await fetchDisabledModels();
    } catch (error) {
      console.log("Error enabling model:", error);
    }
  };

  // NOTE: the old "Disable All" bulk action was removed with the per-provider
  // model list. The shared Available Models section owns bulk visibility now
  // ("Hide all" / "All" in its header), and per-model disable/enable lives on
  // each card — so there is exactly one place for each action.

  const handleEnableAll = async () => {
    try {
      const res = await fetch(`/api/models/disabled?providerAlias=${encodeURIComponent(providerStorageAlias)}`, { method: "DELETE" });
      if (res.ok) await fetchDisabledModels();
    } catch (error) {
      console.log("Error enabling all models:", error);
    }
  };

  // Define callbacks BEFORE the useEffect that uses them
  const fetchAliases = useCallback(async () => {
    try {
      const res = await fetch("/api/models/alias");
      const data = await res.json();
      if (res.ok) {
        setModelAliases(data.aliases || {});
      }
    } catch (error) {
      console.log("Error fetching aliases:", error);
    }
  }, []);

  // Persisted test results (survive reloads). In-session results set by
  // single/batch tests below always win over these when both exist.
  const fetchPersistedTestResults = useCallback(async (alias) => {
    if (!alias) return;
    try {
      const res = await fetch(`/api/models/test-results?providerAlias=${encodeURIComponent(alias)}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const prefix = `${alias}/`;
      const mapped = {};
      for (const [full, rec] of Object.entries(data?.results || {})) {
        if (typeof full !== "string" || !full.startsWith(prefix)) continue;
        const id = full.slice(prefix.length);
        const st = typeof rec === "string" ? rec : rec?.status;
        if (st === "passed" || st === "ok") mapped[id] = "ok";
        else if (st === "failed" || st === "timeout" || st === "error") mapped[id] = "error";
      }
      if (Object.keys(mapped).length > 0) {
        setModelTestResults((prev) => ({ ...mapped, ...prev }));
      }
    } catch (error) {
      console.log("Error fetching persisted test results:", error);
    }
  }, []);

  // Models discovered by provider sync. The Discovered section inside
  // ModelSyncPanel owns these; the Added list below must NOT merge them in,
  // otherwise added models render twice and sync looks like it duplicates.
  const fetchSyncedModels = useCallback(async (alias) => {
    if (!alias) { setSyncedModels([]); return; }
    try {
      const res = await fetch(`/api/models/synced?storageAlias=${encodeURIComponent(alias)}`);
      const data = await res.json();
      if (res.ok) setSyncedModels(data.models || []);
      else setSyncedModels([]);
    } catch (error) {
      console.log("Error fetching synced models:", error);
      setSyncedModels([]);
    }
  }, []);

  // model id -> service kind, so re-testing a disabled model from the Disabled
  // section sends the right `kind` (an image model must not be probed as a
  // chat model, which would fail for the wrong reason).
  const modelKindsById = useMemo(() => {
    const map = new Map();
    for (const m of models) map.set(m.id, m.type || "llm");
    for (const fm of kiloFreeModels) {
      if (!map.has(fm.id)) map.set(fm.id, fm.type || "llm");
    }
    for (const m of syncedModels) {
      if (m?.id && !map.has(m.id)) map.set(m.id, m.type || "llm");
    }
    return map;
  }, [models, kiloFreeModels, syncedModels]);

  // Fetch free models from Kilo API for kilocode provider
  useEffect(() => {
    if (providerId !== "kilocode") return;
    fetch("/api/providers/kilo/free-models")
      .then((res) => res.json())
      .then((data) => { if (data.models?.length) setKiloFreeModels(data.models); })
      .catch(() => {});
  }, [providerId]);

  const fetchConnections = useCallback(async () => {
    try {
      const [connectionsRes, nodesRes, proxyPoolsRes, settingsRes] = await Promise.all([
        cachedJson("/api/providers"),
        cachedJson("/api/provider-nodes"),
        cachedJson("/api/proxy-pools?isActive=true"),
        cachedJson("/api/settings"),
      ]);
      const connectionsData = connectionsRes.data;
      const nodesData = nodesRes.data;
      const proxyPoolsData = proxyPoolsRes.data;
      const settingsData = settingsRes.data || {};
      if (connectionsRes.ok) {
        const filtered = (connectionsData.connections || []).filter(c => c.provider === providerId);
        setConnections(filtered);
      }
      if (proxyPoolsRes.ok) {
        setProxyPools(proxyPoolsData.proxyPools || []);
      }
      // Load per-provider strategy override
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProviderStrategy(override.fallbackStrategy || null);
      setProviderStickyLimit(override.stickyRoundRobinLimit != null ? String(override.stickyRoundRobinLimit) : "1");
      // Load per-provider thinking config
      const thinkingCfg = (settingsData.providerThinking || {})[providerId] || {};
      setThinkingMode(thinkingCfg.mode || "auto");
      if (nodesRes.ok) {
        let node = (nodesData.nodes || []).find((entry) => entry.id === providerId) || null;

        // Newly created compatible nodes can be briefly unavailable on one worker.
        // Retry a few times before showing "Provider not found".
        if (!node && isCompatible) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            const retryRes = await cachedJson("/api/provider-nodes", { force: true });
            if (!retryRes.ok) continue;
            const retryData = retryRes.data;
            node = (retryData.nodes || []).find((entry) => entry.id === providerId) || null;
            if (node) break;
          }
        }

        setProviderNode(node);
      }
    } catch (error) {
      console.log("Error fetching connections:", error);
    } finally {
      setLoading(false);
    }
  }, [providerId, isCompatible]);

  // Live status: connection tests, runtime errors, OAuth refreshes and CRUD
  // arrive as SSE events; refetch connections without a page reload.
  const refetchTimer = useRef(null);
  const refetchConnectionsSoon = useCallback(() => {
    clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(fetchConnections, 150); // coalesce bursts
  }, [fetchConnections]);
  useEffect(() => () => clearTimeout(refetchTimer.current), []);
  useConnectionEvents({
    onEvent: useCallback((event) => {
      if (!event) return;
      const affectsThisProvider = event.provider === providerId || event.id === "*";
      if (!affectsThisProvider) return;
      if (event.type === "created" || event.type === "deleted" || event.id === "*") {
        invalidateCache("/api/providers");
      }
      refetchConnectionsSoon();
    }, [providerId, refetchConnectionsSoon]),
    onRevision: refetchConnectionsSoon,
  });

  const handleUpdateNode = async (formData) => {
    try {
      const res = await fetch(`/api/provider-nodes/${providerId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (res.ok) {
        setProviderNode(data.node);
        await fetchConnections();
        setShowEditNodeModal(false);
      }
    } catch (error) {
      console.log("Error updating provider node:", error);
    }
  };

  const saveProviderStrategy = async (strategy, stickyLimit) => {
    try {
      const settingsRes = await fetch("/api/settings", { cache: "no-store" });
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const current = settingsData.providerStrategies || {};

      // Build override: null strategy means remove override, use global
      const override = {};
      if (strategy) override.fallbackStrategy = strategy;
      if (strategy === "round-robin" && stickyLimit !== "") {
        override.stickyRoundRobinLimit = Number(stickyLimit) || 3;
      }

      const updated = { ...current };
      if (Object.keys(override).length === 0) {
        delete updated[providerId];
      } else {
        updated[providerId] = override;
      }

      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
    } catch (error) {
      console.log("Error saving provider strategy:", error);
    }
  };

  const handleRoundRobinToggle = (enabled) => {
    const strategy = enabled ? "round-robin" : null;
    const sticky = enabled ? (providerStickyLimit || "1") : providerStickyLimit;
    if (enabled && !providerStickyLimit) setProviderStickyLimit("1");
    setProviderStrategy(strategy);
    saveProviderStrategy(strategy, sticky);
  };

  const handleStickyLimitChange = (value) => {
    setProviderStickyLimit(value);
    saveProviderStrategy("round-robin", value);
  };

  const saveThinkingConfig = async (mode) => {
    try {
      const settingsRes = await fetch("/api/settings", { cache: "no-store" });
      const settingsData = settingsRes.ok ? await settingsRes.json() : {};
      const current = settingsData.providerThinking || {};
      const updated = { ...current };
      if (!mode || mode === "auto") {
        delete updated[providerId];
      } else {
        updated[providerId] = { mode };
      }
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerThinking: updated }),
      });
    } catch (error) {
      console.log("Error saving thinking config:", error);
    }
  };

  const handleThinkingModeChange = (mode) => {
    setThinkingMode(mode);
    saveThinkingConfig(mode);
  };

  useEffect(() => {
    fetchConnections();
    fetchAliases();
    fetchDisabledModels();
    fetchSyncedModels(providerStorageAlias);
    fetchPersistedTestResults(providerStorageAlias);
  }, [fetchConnections, fetchAliases, fetchDisabledModels, fetchSyncedModels, fetchPersistedTestResults, providerStorageAlias]);

  // Fetch suggested models from provider's public API (if configured)
  useEffect(() => {
    const fetcher = (OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId] || FREE_PROVIDERS[providerId] || FREE_TIER_PROVIDERS[providerId])?.modelsFetcher;
    if (!fetcher) return;
    fetchSuggestedModels(fetcher).then(setSuggestedModels);
  }, [providerId]);

  const handleSetAlias = async (modelId, alias, providerAliasOverride = providerAlias) => {
    const fullModel = `${providerAliasOverride}/${modelId}`;
    try {
      const res = await fetch("/api/models/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: fullModel, alias }),
      });
      if (res.ok) {
        await fetchAliases();
      } else {
        const data = await res.json();
        alert(data.error || "Failed to set alias");
      }
    } catch (error) {
      console.log("Error setting alias:", error);
    }
  };

  // NOTE: the Qoder-only "Fetch Qoder Models" importer was removed. It was a
  // third route to the same outcome as the sync panel's "Import from /models"
  // and Add Model, it stripped a "qoder/" prefix that the shared importer keeps
  // intact, and it registered models one-by-one instead of through the
  // duplicate-safe bulk alias endpoint. "Import from /models" covers it and is
  // available on every provider that exposes the endpoint.

  const handleRunOneByOneTest = async () => {
    if (oneByOneRunning || connections.length === 0) return;

    const queuedState = Object.fromEntries(
      connections.map((connection) => [connection.id, { state: "queued", error: null }]),
    );

    stopOneByOneRef.current = false;
    setOneByOneRunning(true);
    setOneByOneStopping(false);
    setOneByOneCurrentConnectionId(null);
    setOneByOneResults(queuedState);
    setOneByOneSummary({ total: connections.length, completed: 0, passed: 0, failed: 0, stopped: false });

    let passed = 0;
    let failed = 0;

    try {
      for (let index = 0; index < connections.length; index += 1) {
        if (stopOneByOneRef.current) {
          setOneByOneSummary({
            total: connections.length,
            completed: index,
            passed,
            failed,
            stopped: true,
          });
          break;
        }

        const connection = connections[index];
        setOneByOneCurrentConnectionId(connection.id);
        setOneByOneResults((prev) => ({
          ...prev,
          [connection.id]: { state: "testing", error: null },
        }));

        try {
          const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
          const data = await res.json();
          const valid = !!data.valid;

          if (valid) {
            passed += 1;
          } else {
            failed += 1;
          }

          setOneByOneResults((prev) => ({
            ...prev,
            [connection.id]: {
              state: valid ? "success" : "failed",
              error: valid ? null : (data.error || null),
            },
          }));
        } catch (error) {
          failed += 1;
          setOneByOneResults((prev) => ({
            ...prev,
            [connection.id]: {
              state: "failed",
              error: error.message || "Test failed",
            },
          }));
        }

        setOneByOneSummary({
          total: connections.length,
          completed: index + 1,
          passed,
          failed,
          stopped: false,
        });

        if (index < connections.length - 1) {
          await sleep(ONE_BY_ONE_DELAY_MS);
        }
      }
    } finally {
      setOneByOneCurrentConnectionId(null);
      setOneByOneRunning(false);
      setOneByOneStopping(false);
      stopOneByOneRef.current = false;
    }
  };

  const handleStopOneByOneTest = () => {
    if (!oneByOneRunning) return;
    stopOneByOneRef.current = true;
    setOneByOneStopping(true);
  };

  const handleDelete = async (id) => {
    setConfirmState({
      title: "Delete Connection",
      message: "Delete this connection?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
          if (res.ok) {
            setConnections(connections.filter(c => c.id !== id));
          }
        } catch (error) {
          console.log("Error deleting connection:", error);
        }
      }
    });
  };

  const handleOAuthSuccess = () => {
    fetchConnections();
    setShowOAuthModal(false);
  };

  const handleIFlowCookieSuccess = () => {
    fetchConnections();
    setShowIFlowCookieModal(false);
  };

  const handleSaveApiKey = async (formData) => {
    setAddConnectionError("");
    try {
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: providerId, ...formData }),
      });

      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (res.ok) {
        await fetchConnections();
        setShowAddApiKeyModal(false);
        return;
      }

      setAddConnectionError(data?.error || "Failed to save connection");
    } catch (error) {
      console.log("Error saving connection:", error);
      setAddConnectionError("Failed to save connection");
    }
  };

  const handleUpdateConnection = async (formData) => {
    try {
      const res = await fetch(`/api/providers/${selectedConnection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      if (res.ok) {
        await fetchConnections();
        setShowEditModal(false);
      }
    } catch (error) {
      console.log("Error updating connection:", error);
    }
  };

  const handleUpdateConnectionStatus = async (id, isActive) => {
    try {
      const res = await fetch(`/api/providers/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setConnections(prev => prev.map(c => c.id === id ? { ...c, isActive } : c));
      }
    } catch (error) {
      console.log("Error updating connection status:", error);
    }
  };

  const handleSwapPriority = async (index1, index2) => {
    // Optimistic update state
    const newConnections = [...connections];
    [newConnections[index1], newConnections[index2]] = [newConnections[index2], newConnections[index1]];
    setConnections(newConnections);

    try {
      await Promise.all([
        fetch(`/api/providers/${newConnections[index1].id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: index1 }),
        }),
        fetch(`/api/providers/${newConnections[index2].id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priority: index2 }),
        }),
      ]);
    } catch (error) {
      console.log("Error swapping priority:", error);
      await fetchConnections();
    }
  };

  const selectedConnections = connections.filter((conn) => selectedConnectionIds.includes(conn.id));
  const allSelected = connections.length > 0 && selectedConnectionIds.length === connections.length;

  const toggleSelectConnection = (connectionId) => {
    setSelectedConnectionIds((prev) => (
      prev.includes(connectionId)
        ? prev.filter((id) => id !== connectionId)
        : [...prev, connectionId]
    ));
  };

  const toggleSelectAllConnections = () => {
    if (allSelected) {
      setSelectedConnectionIds([]);
      return;
    }
    setSelectedConnectionIds(connections.map((conn) => conn.id));
  };

  const clearSelection = () => {
    setSelectedConnectionIds([]);
    setBulkProxyPoolId("__none__");
  };

  useEffect(() => {
    setSelectedConnectionIds((prev) => prev.filter((id) => connections.some((conn) => conn.id === id)));
  }, [connections]);

  const selectedProxySummary = (() => {
    if (selectedConnections.length === 0) return "";
    const poolIds = new Set(selectedConnections.map((conn) => conn.providerSpecificData?.proxyPoolId || "__none__"));
    if (poolIds.size === 1) {
      const onlyId = [...poolIds][0];
      if (onlyId === "__none__") return "All selected currently unbound";
      const pool = proxyPools.find((p) => p.id === onlyId);
      return `All selected currently bound to ${pool?.name || onlyId}`;
    }
    return "Selected connections have mixed proxy bindings";
  })();

  const openBulkProxyModal = () => {
    if (selectedConnections.length === 0) return;
    const uniquePoolIds = [...new Set(selectedConnections.map((conn) => conn.providerSpecificData?.proxyPoolId || "__none__"))];
    setBulkProxyPoolId(uniquePoolIds.length === 1 ? uniquePoolIds[0] : "__none__");
    setShowBulkProxyModal(true);
  };

  const closeBulkProxyModal = () => {
    if (bulkUpdatingProxy) return;
    setShowBulkProxyModal(false);
  };

  const applyProxyAssignments = async (assignments) => {
    setBulkUpdatingProxy(true);
    try {
      let failed = 0;
      for (const { connectionId, proxyPoolId } of assignments) {
        try {
          const res = await fetch(`/api/providers/${connectionId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ proxyPoolId }),
          });
          if (!res.ok) failed += 1;
        } catch (e) {
          console.log("Error applying proxy for", connectionId, e);
          failed += 1;
        }
      }
      if (failed > 0) alert(`Updated with ${failed} failed request(s).`);
      await fetchConnections();
      setShowBulkProxyModal(false);
    } finally {
      setBulkUpdatingProxy(false);
    }
  };

  const handleApplySinglePool = (proxyPoolId) => {
    const targets = connections.map((c) => ({ connectionId: c.id, proxyPoolId }));
    return applyProxyAssignments(targets);
  };

  const handleApplyOneToOne = () => {
    const activePools = proxyPools.filter((p) => p.isActive === true);
    if (activePools.length === 0) {
      alert("No active proxy pools available.");
      return;
    }
    const targets = connections.map((c, i) => ({
      connectionId: c.id,
      proxyPoolId: activePools[i % activePools.length].id,
    }));
    return applyProxyAssignments(targets);
  };


  const isSelected = (connectionId) => selectedConnectionIds.includes(connectionId);

  const connectionsList = (
    <div className="flex min-w-0 flex-col divide-y divide-black/[0.03] dark:divide-white/[0.03]">
      {connections
        .map((conn, index) => (
          <div key={conn.id} className="flex min-w-0 items-stretch">
            <div className="flex-1 min-w-0">
              <ConnectionRow
                connection={conn}
                proxyPools={proxyPools}
                isOAuth={isOAuth}
                isFirst={index === 0}
                isLast={index === connections.length - 1}
                onMoveUp={() => handleSwapPriority(index, index - 1)}
                onMoveDown={() => handleSwapPriority(index, index + 1)}
                onToggleActive={(isActive) => handleUpdateConnectionStatus(conn.id, isActive)}
                onUpdateProxy={async (proxyPoolId) => {
                  try {
                    const res = await fetch(`/api/providers/${conn.id}`, {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ proxyPoolId: proxyPoolId || null }),
                    });
                    if (res.ok) {
                      setConnections(prev => prev.map(c =>
                        c.id === conn.id
                          ? { ...c, providerSpecificData: { ...c.providerSpecificData, proxyPoolId: proxyPoolId || null } }
                          : c
                      ));
                    }
                  } catch (error) {
                    console.log("Error updating proxy:", error);
                  }
                }}
                onEdit={() => {
                  setSelectedConnection(conn);
                  setShowEditModal(true);
                }}
                onDelete={() => handleDelete(conn.id)}
                oneByOneStatus={oneByOneResults[conn.id] || null}
                isSelected={isSelected(conn.id)}
                onSelect={() => toggleSelectConnection(conn.id)}
              />
            </div>
          </div>
        ))}
    </div>
  );

  const activePools = proxyPools.filter((p) => p.isActive === true);

  const bulkActionModal = (
    <Modal
      isOpen={showBulkProxyModal}
      onClose={closeBulkProxyModal}
      title={`Apply Proxy (${connections.length} connections)`}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col">
          <button
            onClick={handleApplyOneToOne}
            disabled={bulkUpdatingProxy || activePools.length === 0}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-text-muted text-[18px]">sync_alt</span>
            <span className="text-sm text-text-main">One-to-one (rotate)</span>
          </button>
          <button
            onClick={() => handleApplySinglePool(null)}
            disabled={bulkUpdatingProxy}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-text-muted text-[18px]">link_off</span>
            <span className="text-sm text-text-main">None (unbind all)</span>
          </button>
          {proxyPools.map((pool) => (
            <button
              key={pool.id}
              onClick={() => handleApplySinglePool(pool.id)}
              disabled={bulkUpdatingProxy || pool.isActive !== true}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-text-muted text-[18px]">lan</span>
              <span className="truncate text-sm text-text-main">{pool.name}</span>
              {pool.isActive !== true && (
                <span className="text-[10px] text-text-muted">(inactive)</span>
              )}
            </button>
          ))}
        </div>

        {bulkUpdatingProxy && <p className="text-xs text-text-muted">Applying...</p>}

        <Button onClick={closeBulkProxyModal} variant="ghost" fullWidth disabled={bulkUpdatingProxy}>
          Cancel
        </Button>
      </div>
    </Modal>
  );

  const handleTestModel = async (modelId, kind = "llm") => {
    if (inflightTestRef.current.has(modelId)) return;
    inflightTestRef.current.add(modelId);
    setTestingModelIds((prev) => (prev.includes(modelId) ? prev : [...prev, modelId]));
    try {
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: `${providerStorageAlias}/${modelId}`, kind }),
      });
      const data = await res.json();
      setModelTestResults((prev) => ({ ...prev, [modelId]: data.ok ? "ok" : "error" }));
      // A passing test clears the stored failure detail; a failure records it so
      // the Disabled section can explain why, without discarding history.
      setModelTestErrors((prev) => {
        if (data.ok) {
          if (!(modelId in prev)) return prev;
          const { [modelId]: _dropped, ...rest } = prev;
          return rest;
        }
        return { ...prev, [modelId]: data.error || "Model not reachable" };
      });
      setModelsTestError(data.ok ? "" : (data.error || "Model not reachable"));
    } catch {
      setModelTestResults((prev) => ({ ...prev, [modelId]: "error" }));
      setModelTestErrors((prev) => ({ ...prev, [modelId]: "Network error" }));
      setModelsTestError("Network error");
    } finally {
      inflightTestRef.current.delete(modelId);
      setTestingModelIds((prev) => prev.filter((id) => id !== modelId));
    }
  };

  // NOTE: the provider page's own batch-result handler was removed. Batch
  // testing now lives in the shared AvailableModelsSection, which owns the
  // testing state and the per-model results. The dead copy left a call to a
  // `setBatchTestingIds` setter whose state no longer existed — a latent
  // ReferenceError that would have blanked the page the moment anything
  // invoked it.

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
}

  if (!providerInfo) {
    return (
      <div className="text-center py-20">
        <p className="text-text-muted">Provider not found</p>
        <Link to="/dashboard/providers" className="text-primary mt-4 inline-block">
          Back to Providers
        </Link>
      </div>
    );
  }

  // Determine icon path: OpenAI Compatible providers use specialized icons
  const getHeaderIconPath = () => {
    if (providerId === "codebuddy" || providerId === "cb") {
      return "/providers/codebuddy.svg";
    }
    if (isOpenAICompatible && providerInfo.apiType) {
      return providerInfo.apiType === "responses" ? "/providers/oai-r.png" : "/providers/oai-cc.png";
    }
    if (isAnthropicCompatible) {
      return "/providers/anthropic-m.png";
    }
    if (providerId === "weavy") {
      return "/providers/weavy.jpeg";
    }
    return `/providers/${providerInfo.id}.png`;
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:gap-8 sm:px-0">
      {/* Header */}
      <div className="min-w-0">
        <Link
          to="/dashboard/providers"
          className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary transition-colors mb-4"
        >
          <span className="material-symbols-outlined text-lg">arrow_back</span>
          Back to Providers
        </Link>
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <div
            className="flex size-12 shrink-0 items-center justify-center rounded-lg"
            style={{ backgroundColor: `${providerInfo.color}15` }}
          >
            {headerImgError ? (
              <span className="text-sm font-bold" style={{ color: providerInfo.color }}>
                {providerInfo.textIcon || providerInfo.id.slice(0, 2).toUpperCase()}
              </span>
            ) : (
              <img
                src={getHeaderIconPath()}
                alt={providerInfo.name}
                width={48}
                height={48}
                className="max-h-12 max-w-12 rounded-lg object-contain"
                onError={() => setHeaderImgError(true)}
              />
            )}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{providerInfo.name}</h1>
              {(providerInfo.notice?.apiKeyUrl || providerInfo.notice?.signupUrl || providerInfo.website) && (
                <a
                  href={providerInfo.notice?.apiKeyUrl || providerInfo.notice?.signupUrl || providerInfo.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                >
                  <span className="material-symbols-outlined text-sm">open_in_new</span>
                  {providerInfo.notice?.apiKeyUrl ? "Get API Key" : "Sign up / Learn more"}
                </a>
              )}
            </div>
            <p className="text-text-muted">
              {connections.length} connection{connections.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
      </div>

      {providerInfo.deprecated && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
          <span className="material-symbols-outlined text-[16px] text-yellow-500 mt-0.5 shrink-0">warning</span>
          <p className="text-xs text-red-600 dark:text-yellow-400 leading-relaxed">{providerInfo.deprecationNotice}</p>
        </div>
      )}

      {providerInfo.notice?.text && !providerInfo.deprecated && (
        <div className="flex flex-col gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 sm:flex-row sm:items-center">
          <span className="material-symbols-outlined text-[16px] text-blue-500 shrink-0">info</span>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-blue-600 dark:text-blue-400">{providerInfo.notice.text}</p>
          {providerInfo.notice.apiKeyUrl && (
            <a
              href={providerInfo.notice.apiKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex justify-center rounded bg-blue-500 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-600 sm:py-0.5"
            >
              Get API Key →
            </a>
          )}
        </div>
      )}

      {/* Tab switcher for Leonardo provider */}
      {providerId === "leonardo" && (
        <div className="flex border-b border-border-subtle pb-px gap-6">
          {[{id: "overview", icon: "dashboard", label: "Overview", useImage: false}, {id: "admin", icon: "tune", label: "Leonardo Admin", useImage: true}].map(t => (
            <button
              key={t.id}
              onClick={() => setProviderTab(t.id)}
              className={`flex items-center gap-2 pb-3 text-sm font-semibold transition-all border-b-2 cursor-pointer ${
                providerTab === t.id
                  ? "border-primary text-primary"
                  : "border-transparent text-text-muted hover:text-text-main"
              }`}
            >
              {t.useImage ? (
                <img src="/providers/leonardo.png" alt="Leonardo" className="size-[18px] rounded object-contain" />
              ) : (
                <span className="material-symbols-outlined text-[18px]">{t.icon}</span>
              )}
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* Leonardo Admin Tab */}
      {providerId === "leonardo" && providerTab === "admin" && (
        <LeonardoAdminPanel />
      )}

      {/* Weavy Token Pool shortcut */}
      {providerId === "weavy" && (
        <div style={{ marginBottom: 16, padding: "12px 16px", background: "#0c1a2e", border: "1px solid #1e3a5f", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: "#60a5fa" }}>🪄 Weavy Token Pool</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Copy firebase_refresh_token, firebase_api_key, and JWT for use in other systems (Kliperspro, etc.).</div>
          </div>
          <a
            href="/dashboard/providers/weavy/pool"
            style={{ padding: "7px 16px", borderRadius: 6, background: "#1e3a5f", border: "1px solid #2563eb", color: "#93c5fd", fontSize: 13, fontWeight: 600, textDecoration: "none", whiteSpace: "nowrap" }}
          >
            Open Token Pool →
          </a>
        </div>
      )}

      {/* Overview Tab (or always for non-Leonardo) */}
      {(providerId !== "leonardo" || providerTab === "overview") && (
      <>
      {/* Models: header + configuration */}
      {isCompatible && providerNode && (
        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">Provider Configuration</h2>
              {/* The configured name, not the generic type label. */}
              <p className="break-all text-sm text-text-muted">
                {providerInfo.name} ·{" "}
                <span className="opacity-80">
                  {isAnthropicCompatible
                    ? "Anthropic-compatible · Messages API"
                    : `OpenAI-compatible · ${providerNode.apiType === "responses" ? "Responses API" : "Chat Completions"}`}
                </span>
              </p>
              <p className="mt-1 break-all text-xs text-text-muted/80">
                <span className="opacity-70">Base URL</span>{" "}
                <code className="font-mono">{providerNode.baseUrl || "—"}</code>
                {providerNode.prefix && (
                  <>
                    {" · "}
                    <span className="opacity-70">Prefix</span>{" "}
                    <code className="font-mono">{providerNode.prefix}</code>
                  </>
                )}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:flex sm:items-center">
              <Button
                size="sm"
                icon="add"
                onClick={() => {
                  setAddConnectionError("");
                  setShowAddApiKeyModal(true);
                }}
                className="w-full sm:w-auto"
              >
                Add Connection
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="download"
                onClick={() => { setAddConnectionError(""); setShowBulkAddModal(true); }}
                title="Paste many API keys and create one connection per key"
                className="w-full sm:w-auto"
              >
                Bulk Add
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="edit"
                onClick={() => setShowEditNodeModal(true)}
                className="w-full sm:w-auto"
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon="delete"
                onClick={() => {
                  setConfirmState({
                    title: "Delete Provider",
                    message: `Delete "${providerInfo.name}" and all of its connections and models?`,
                    onConfirm: async () => {
                      setConfirmState(null);
                      try {
                        const res = await fetch(`/api/provider-nodes/${providerId}`, { method: "DELETE" });
                        if (res.ok) {
                          navigate("/dashboard/providers");
                        }
                      } catch (error) {
                        console.log("Error deleting provider node:", error);
                      }
                    }
                  });
                }}
                className="w-full sm:w-auto"
              >
                Delete
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Connections */}
      {isFreeNoAuth ? (
        <NoAuthProxyCard providerId={providerId} />
      ) : (
        <Card>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold">
              Connections
              {connections.length > 0 && (
                <span className="ml-2 text-[11px] font-normal text-text-muted">{connections.length}</span>
              )}
            </h2>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-2">
              {connections.length > 0 && proxyPools.length > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon="lan"
                  onClick={() => setShowBulkProxyModal(true)}
                >
                  Apply Proxy
                </Button>
              )}
              {connections.length > 0 && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="sync"
                    onClick={handleRunOneByOneTest}
                    disabled={oneByOneRunning}
                    title="Test every connection sequentially and record the result on each"
                  >
                    {oneByOneRunning ? "Testing One-by-One..." : "Test One-by-One"}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="download"
                    onClick={() => { setAddConnectionError(""); setShowBulkAddModal(true); }}
                    title="Paste many API keys and create one connection per key"
                  >
                    Bulk Add
                  </Button>
                  {oneByOneRunning && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="stop"
                      onClick={handleStopOneByOneTest}
                      disabled={oneByOneStopping}
                    >
                      {oneByOneStopping ? "Stopping..." : "Stop"}
                    </Button>
                  )}
                </>
              )}
              {/* Thinking config */}
              {/* {thinkingConfig && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-muted font-medium">Thinking</span>
                  <select
                    value={thinkingMode}
                    onChange={(e) => handleThinkingModeChange(e.target.value)}
                    className="text-xs px-2 py-1 border border-border rounded-md bg-background focus:outline-none focus:border-primary"
                  >
                    {thinkingConfig.options.map((opt) => (
                      <option key={opt} value={opt}>{opt.charAt(0).toUpperCase() + opt.slice(1)}</option>
                    ))}
                  </select>
                </div>
              )} */}
              {/* Round Robin toggle */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-text-muted font-medium">Round Robin</span>
                <Toggle
                  checked={providerStrategy === "round-robin"}
                  onChange={handleRoundRobinToggle}
                />
                {providerStrategy === "round-robin" && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-text-muted">Sticky:</span>
                    <input
                      type="number"
                      min={1}
                      value={providerStickyLimit}
                      onChange={(e) => handleStickyLimitChange(e.target.value)}
                      placeholder="1"
                      className="w-14 px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:border-primary"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {connections.length === 0 ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 text-primary shrink-0">
                  <span className="material-symbols-outlined text-[18px]">{isOAuth ? "lock" : "key"}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-text-muted">No connections yet</p>
                  {hasDualAuthModes && (
                    <p className="text-xs text-text-muted">
                      Choose {oauthConnectionLabel} or {apiKeyConnectionLabel}.
                    </p>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {hasDualAuthModes ? (
                  <>
                    <Button size="sm" icon="lock" variant="secondary" onClick={triggerOAuthConnection}>
                      {oauthConnectionLabel}
                    </Button>
                    <Button size="sm" icon="key" onClick={triggerApiKeyConnection}>
                      {apiKeyConnectionLabel}
                    </Button>
                  </>
                ) : (
                  <>
                    {!isCompatible && providerId === "iflow" && (
                      <Button size="sm" icon="cookie" variant="secondary" onClick={() => setShowIFlowCookieModal(true)}>
                        Cookie
                      </Button>
                    )}
                    <Button
                      size="sm"
                      icon="add"
                      onClick={triggerAddConnection}
                    >
                      {isCompatible ? "Add Connection" : (providerId === "iflow" ? "OAuth" : "Add Connection")}
                    </Button>
                    <Button
                      size="sm"
                      icon="download"
                      variant="secondary"
                      onClick={() => { setAddConnectionError(""); setShowBulkAddModal(true); }}
                      title="Paste many API keys and create one connection per key"
                    >
                      Bulk Add
                    </Button>
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              {oneByOneSummary && (
                <div className="mb-4 rounded-lg border border-black/10 bg-black/[0.02] px-3 py-2 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                  <div className="flex flex-wrap items-center gap-3">
                    <span>Total: {oneByOneSummary.total}</span>
                    <span>Completed: {oneByOneSummary.completed}</span>
                    <span>Passed: {oneByOneSummary.passed}</span>
                    <span>Failed: {oneByOneSummary.failed}</span>
                    {oneByOneSummary.stopped && (
                      <span className="text-amber-600 dark:text-amber-400">Stopped</span>
                    )}
                    {oneByOneRunning && oneByOneCurrentConnectionId && (
                      <span>Running: {connections.find((conn) => conn.id === oneByOneCurrentConnectionId)?.name || oneByOneCurrentConnectionId}</span>
                    )}
                  </div>
                </div>
              )}
              
              {/* Select All / Bulk Actions Header */}
              {connections.length > 0 && (
                <div className="mb-2 flex items-center justify-between rounded-lg border border-black/5 bg-black/[0.02] px-3 py-2 dark:border-white/5 dark:bg-white/[0.02]">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAllConnections}
                      className="h-4 w-4 rounded border-black/20 text-primary focus:ring-primary dark:border-white/20 dark:bg-black"
                    />
                    <span className="text-sm font-medium">Select All ({selectedConnectionIds.length}/{connections.length})</span>
                  </div>
                  {selectedConnectionIds.length > 0 && (
                    <div className="flex items-center gap-2">
                      {proxyPools.length > 0 && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="lan"
                          onClick={() => setShowBulkProxyModal(true)}
                        >
                          Apply Proxy
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="danger"
                        icon="delete"
                        onClick={() => {
                          if (selectedConnectionIds.length === 0) return;
                          setConfirmState({
                            title: "Delete Connections",
                            message: `Delete ${selectedConnectionIds.length} selected connection(s)?`,
                            onConfirm: async () => {
                              setConfirmState(null);
                              try {
                                await Promise.all(
                                  selectedConnectionIds.map((id) =>
                                    fetch(`/api/providers/${id}`, { method: "DELETE" })
                                  )
                                );
                                setConnections(connections.filter(c => !selectedConnectionIds.includes(c.id)));
                                clearSelection();
                              } catch (error) {
                                console.log("Error deleting connections:", error);
                              }
                            }
                          });
                        }}
                      >
                        Delete Selected
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {connectionsList}
              <div className="mt-4 grid grid-cols-1 gap-2 sm:flex">
                {providerId === "iflow" && !isCompatible && (
                  <Button
                    size="sm"
                    icon="cookie"
                    variant="secondary"
                    onClick={() => setShowIFlowCookieModal(true)}
                    title="Add connection using browser cookie"
                    className="w-full sm:w-auto"
                  >
                    Cookie
                  </Button>
                )}
                {hasDualAuthModes ? (
                  <>
                    <Button
                      size="sm"
                      icon="lock"
                      variant="secondary"
                      onClick={triggerOAuthConnection}
                      className="w-full sm:w-auto"
                    >
                      {oauthConnectionLabel}
                    </Button>
                    <Button
                      size="sm"
                      icon="key"
                      onClick={triggerApiKeyConnection}
                      className="w-full sm:w-auto"
                    >
                      {apiKeyConnectionLabel}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      icon="add"
                      onClick={triggerAddConnection}
                      className="w-full sm:w-auto"
                    >
                      Add Connection
                    </Button>
                    <Button
                      size="sm"
                      icon="download"
                      variant="secondary"
                      onClick={() => { setAddConnectionError(""); setShowBulkAddModal(true); }}
                      title="Paste many API keys and create one connection per key"
                      className="w-full sm:w-auto"
                    >
                      Bulk Add
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </Card>
      )}


      {/* ── Models ─────────────────────────────────────────────────────
          One layout for every provider type (built-in, OAuth, custom,
          OpenAI-compatible):
            1. the collapsible model synchronization panel
            2. the shared Available Models section (same filters, cards and
               actions as the global Models page, scoped to this provider)
            3. the single Disabled Models section
          Provider configuration and connections above are untouched. */}
      <Card>
        <ModelSyncPanel
          providerId={providerId}
          providerStorageAlias={providerStorageAlias}
          providerLabel={providerNode?.name || providerInfo?.name}
          connections={connections}
          modelAliases={modelAliases}
          hardcodedIds={models.map((m) => m.id)}
          testResults={modelTestResults}
          disabledIds={disabledModelIds}
          isCustomProvider={isCompatible}
          onAddModel={(modelId) => handleSetAlias(modelId, modelId.split("/").pop(), providerStorageAlias)}
          onTestResult={(modelId, status) =>
            setModelTestResults((prev) => (prev[modelId] === status ? prev : { ...prev, [modelId]: status }))
          }
          onCatalogChanged={() => { fetchAliases(); fetchSyncedModels(providerStorageAlias); fetchDisabledModels(); }}
        />

        {/* Suggested models — provider-specific catalogue of free models with
            a large context window. Kept above the model list; it only offers
            models that are not registered yet, so it never duplicates a card. */}
        {suggestedModels.length > 0 && (() => {
          const addedFullModels = new Set(Object.values(modelAliases));
          const hardcodedIds = new Set(models.map((m) => m.id));
          const notAdded = suggestedModels.filter(
            (m) => !addedFullModels.has(`${providerStorageAlias}/${m.id}`) && !hardcodedIds.has(m.id)
          );
          if (notAdded.length === 0) return null;
          return (
            <div className="w-full mb-3">
              <p className="text-xs text-text-muted mb-2">Suggested free models (≥200k context):</p>
              <div className="flex flex-wrap gap-2">
                {notAdded.map((m) => (
                  <button
                    key={m.id}
                    onClick={async () => {
                      const alias = m.id.split("/").pop();
                      await handleSetAlias(m.id, alias, providerStorageAlias);
                    }}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-black/10 dark:border-white/10 text-xs text-text-muted hover:text-primary hover:border-primary/40 hover:bg-primary/5 transition-colors"
                    title={`${m.name} · ${(m.contextLength / 1000).toFixed(0)}k ctx`}
                  >
                    <span className="material-symbols-outlined text-[13px]">add</span>
                    {m.id.split("/").pop()}
                  </button>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="border-t border-border/60 pt-4">
          {modelRegistrationNotice && (
            <div className="mb-3 rounded-lg border border-border bg-sidebar/40 px-3 py-2 text-xs text-text-muted flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">check_circle</span>
              <span className="flex-1">{modelRegistrationNotice}</span>
              <button
                onClick={() => setModelRegistrationNotice("")}
                className="text-text-muted hover:text-text-main"
                aria-label="Dismiss"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>
          )}
          <AvailableModelsSection
            storageAlias={providerStorageAlias}
            headerTitle="Available Models"
            onAddModelClick={() => setShowAddCustomModel(true)}
            addModelLabel="Add Model"
          />
        </div>

        {!!modelsTestError && (
          <p className="text-xs text-red-500 mt-3 break-words">{modelsTestError}</p>
        )}

        {/* The ONE Disabled models section. State lives in the shared
            disabledModels store keyed by the provider's storage alias, so this
            list and the Available Models list never show the same model twice:
            hidden models are filtered out of the default Available view. */}
        <DisabledModelsSection
          disabledIds={disabledModelIds}
          providerName={customProviderName}
          catalog={syncedModels}
          testResults={modelTestResults}
          testErrors={modelTestErrors}
          modelAliases={modelAliases}
          onEnable={handleEnableModel}
          onEnableAll={handleEnableAll}
          onRetest={(modelId) => handleTestModel(modelId, modelKindsById.get(modelId) || "llm")}
        />
      </Card>

      <BulkAddConnectionsModal
        isOpen={showBulkAddModal}
        provider={providerId}
        providerName={customProviderName}
        onClose={() => setShowBulkAddModal(false)}
        onDone={async () => { await fetchConnections(); invalidateCache("/api/providers"); }}
      />

      {bulkActionModal}
      </>
      )}

      {/* Modals */}
      {providerId === "kiro" ? (
        <KiroOAuthWrapper
          isOpen={showOAuthModal}
          providerInfo={providerInfo}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowOAuthModal(false)}
        />
      ) : providerId === "cursor" ? (
        <CursorAuthModal
          isOpen={showOAuthModal}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowOAuthModal(false)}
        />
      ) : providerId === "gitlab" ? (
        <GitLabAuthModal
          isOpen={showOAuthModal}
          providerInfo={providerInfo}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowOAuthModal(false)}
        />
      ) : (
        <OAuthModal
          isOpen={showOAuthModal}
          provider={providerId}
          providerInfo={providerInfo}
          onSuccess={handleOAuthSuccess}
          onClose={() => setShowOAuthModal(false)}
        />
      )}
      {providerId === "iflow" && (
        <IFlowCookieModal
          isOpen={showIFlowCookieModal}
          onSuccess={handleIFlowCookieSuccess}
          onClose={() => setShowIFlowCookieModal(false)}
        />
      )}
      <AddApiKeyModal
        isOpen={showAddApiKeyModal}
        provider={providerId}
        providerName={providerInfo.name}
        isCompatible={isCompatible}
        isAnthropic={isAnthropicCompatible}
        authType={providerInfo?.authType}
        authHint={providerInfo?.authHint}
        website={providerInfo?.website}
        proxyPools={proxyPools}
        error={addConnectionError}
        onSave={handleSaveApiKey}
        onBulkDone={fetchConnections}
        onClose={() => {
          setAddConnectionError("");
          setShowAddApiKeyModal(false);
        }}
      />
      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => setShowEditModal(false)}
      />
      {isCompatible && (
        <EditCompatibleNodeModal
          isOpen={showEditNodeModal}
          node={providerNode}
          onSave={handleUpdateNode}
          onClose={() => setShowEditNodeModal(false)}
          isAnthropic={isAnthropicCompatible}
        />
      )}
      {/* The ONE Add Model dialog. It is opened by the Add Model button in the
          shared Available Models section, next to Retry failed — there is no
          second inline input anywhere on the provider page. Compatible
          (OpenAI/Anthropic) providers use it too, so every provider type adds
          models the same way.

          Registration goes through POST /api/models/register, which records the
          capability set and is idempotent: re-adding an existing model merges
          capabilities and keeps its configuration and test history instead of
          creating a second record. */}
      <AddCustomModelModal
        isOpen={showAddCustomModel}
        providerAlias={providerStorageAlias}
        providerDisplayAlias={providerDisplayAlias}
        allowedKinds={
          isCompatible
            ? ["llm"]
            : AI_PROVIDERS[providerId]?.serviceKinds || ["llm"]
        }
        onSave={async (payload) => {
          const res = await fetch("/api/models/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prefix: payload.prefix,
              modelId: payload.modelId,
              capabilities: payload.capabilities,
              displayName: payload.displayName,
              endpoint: payload.endpoint,
              settings: payload.settings,
              // Passthrough providers (OpenRouter, Vercel gateway) expose ids
              // containing slashes; the alias is the last segment so it stays
              // addressable.
              alias: providerInfo?.passthroughModels
                ? payload.modelId.split("/").pop()
                : undefined,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(data.error || "Could not register the model");
          }
          // Refresh every model view: the alias and custom-model stores both
          // changed, and a duplicate add must not leave a stale list behind.
          await Promise.all([
            fetchAliases(),
            fetchSyncedModels(providerStorageAlias),
            fetchDisabledModels(),
          ]);
          invalidateCache("/api/models/alias");
          invalidateCache("/api/models/custom");
          setModelRegistrationNotice(
            data.duplicate
              ? `${data.registeredId} is already registered — its capabilities were merged, nothing was duplicated.`
              : `Added ${data.registeredId}`
          );
          setShowAddCustomModel(false);
        }}
        onClose={() => setShowAddCustomModel(false)}
      />

      {/* AG Risk Confirmation Modal */}
      <ConfirmModal
        isOpen={showAgRiskModal}
        onClose={() => setShowAgRiskModal(false)}
        onConfirm={handleAgRiskConfirm}
        title="Risk Notice"
        message={providerInfo?.deprecationNotice}
        confirmText="I Understand, Continue"
        cancelText="Cancel"
        variant="danger"
      />

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
