
import {
  getProviderConnections,
  createProviderConnection,
  getProviderNodeById,
  getProviderNodes,
  getProxyPoolById,
} from "../../models/index.js";
import { APIKEY_PROVIDERS } from "../../shared/constants/config.js";
import { AI_PROVIDERS, FREE_TIER_PROVIDERS, WEB_COOKIE_PROVIDERS, isOpenAICompatibleProvider, isAnthropicCompatibleProvider, isCustomEmbeddingProvider } from "../../shared/constants/providers.js";
import { normalizeProviderId, normalizeProviderSpecificData } from "../../lib/providerNormalization.js";

export const dynamic = "force-dynamic";

function normalizeProxyConfig(body = {}) {
  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return { error: "Connection proxy URL is required when connection proxy is enabled" };
  }

  return {
    connectionProxyEnabled: enabled,
    connectionProxyUrl: url,
    connectionNoProxy: noProxy,
  };
}

async function normalizeProxyPoolId(proxyPoolId) {
  if (proxyPoolId === undefined || proxyPoolId === null || proxyPoolId === "" || proxyPoolId === "__none__") {
    return { proxyPoolId: null };
  }

  const normalizedId = String(proxyPoolId).trim();
  if (!normalizedId) {
    return { proxyPoolId: null };
  }

  const proxyPool = await getProxyPoolById(normalizedId);
  if (!proxyPool) {
    return { error: "Proxy pool not found" };
  }

  return { proxyPoolId: normalizedId };
}

// GET /api/providers - List all connections
export async function GET(req, res) {
  try {
    const connections = await getProviderConnections();

    // Build nodeNameMap for compatible providers (id → name)
    let nodeNameMap = {};
    try {
      const nodes = await getProviderNodes();
      for (const node of nodes) {
        if (node.id && node.name) nodeNameMap[node.id] = node.name;
      }
    } catch { }

    // Hide sensitive fields, enrich name for compatible providers.
    //
    // `providerName` is the CONFIGURED node name (e.g. "Xkiro") and is the
    // authoritative provider label for custom providers. `name` stays the
    // connection's own editable label, falling back to the node name and only
    // then to the raw node id. Previously the fall-through order meant an
    // unnamed connection surfaced the opaque `openai-compatible-chat-<uuid>`
    // id in the UI.
    const safeConnections = connections.map((c) => {
      const isCustom = isOpenAICompatibleProvider(c.provider)
        || isAnthropicCompatibleProvider(c.provider)
        || isCustomEmbeddingProvider(c.provider);
      const providerName = isCustom
        ? (nodeNameMap[c.provider] || c.providerSpecificData?.nodeName || null)
        : null;
      const name = isCustom
        ? (c.name || providerName || c.provider)
        : c.name;
      return {
        ...c,
        name,
        ...(isCustom ? { providerName: providerName || c.provider } : {}),
        apiKey: undefined,
        accessToken: undefined,
        refreshToken: undefined,
        idToken: undefined,
      };
    });

    return res.json({ connections: safeConnections });
  } catch (error) {
    console.log("Error fetching providers:", error);
    return res.status(500).json({ error: "Failed to fetch providers" });
  }
}

/**
 * Return a connection name not already used by another connection of the same
 * provider. API-key connections dedup on (authType, name) in
 * connectionsRepo.createProviderConnection, so a duplicate name would silently
 * UPDATE the existing row and replace its API key — losing that connection's
 * credentials. Disambiguating ("Main", "Main 2") keeps every key intact.
 */
async function uniqueConnectionName(provider, desired) {
  const existing = await getProviderConnections({ provider });
  const taken = new Set(
    existing.filter((c) => c.authType === "apikey" || c.authType === "cookie").map((c) => c.name).filter(Boolean)
  );
  if (!taken.has(desired)) return desired;
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${desired} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired} ${Date.now()}`;
}

// POST /api/providers - Create new connection (API Key only, OAuth via separate flow)
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const provider = normalizeProviderId(body.provider);
    const { apiKey, email, name, displayName, priority, globalPriority, defaultModel, testStatus } = body;
    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return res.status(400).json({ error: proxyConfig.error });
    }

    const proxyPoolResult = await normalizeProxyPoolId(body.proxyPoolId);
    if (proxyPoolResult.error) {
      return res.status(400).json({ error: proxyPoolResult.error });
    }
    const proxyPoolId = proxyPoolResult.proxyPoolId;

    // Validation
    const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
    const isValidProvider = APIKEY_PROVIDERS[provider] ||
      FREE_TIER_PROVIDERS[provider] ||
      isWebCookieProvider ||
      isOpenAICompatibleProvider(provider) ||
      isAnthropicCompatibleProvider(provider) ||
      isCustomEmbeddingProvider(provider) ||
      provider === "codebuddy";

    if (!provider || !isValidProvider) {
      return res.status(400).json({ error: "Invalid provider" });
    }
    if (!apiKey && provider !== "ollama-local") {
      return res.status(400).json({ error: `${isWebCookieProvider ? "Cookie value" : "API Key"} is required` });
    }
    const isCustomNode = isOpenAICompatibleProvider(provider)
      || isAnthropicCompatibleProvider(provider)
      || isCustomEmbeddingProvider(provider);

    // Resolve the custom node once: it supplies the provider's own name,
    // prefix, api type and base URL for every connection created against it.
    let node = null;
    if (isCustomNode) {
      node = await getProviderNodeById(provider);
      if (!node) {
        const label = isAnthropicCompatibleProvider(provider)
          ? "Anthropic Compatible"
          : isCustomEmbeddingProvider(provider) ? "Custom Embedding" : "OpenAI Compatible";
        return res.status(404).json({ error: `${label} provider not found` });
      }
    }

    // Custom nodes: the CONFIGURED node name is the provider's name and is the
    // default connection name. Previously a connection without an explicit
    // name fell through to the raw node id, so the UI showed
    // "openai-compatible-chat-<uuid>" in place of e.g. "Xkiro".
    const connectionName = (
      name || displayName || node?.name || AI_PROVIDERS[provider]?.name || ""
    ).trim();
    if (!connectionName) {
      return res.status(400).json({ error: "Name is required" });
    }
    // The connections table dedups API-key connections by (authType, name).
    // Bulk/duplicate names would silently UPDATE the existing connection and
    // overwrite its API key, so disambiguate instead.
    const finalName = isCustomNode
      ? await uniqueConnectionName(provider, connectionName)
      : connectionName;

    let providerSpecificData = normalizeProviderSpecificData(provider, body, body.providerSpecificData);

    // Merge the node config UNDER the caller's own settings. A connection may
    // legitimately override baseUrl (a different endpoint for one key), and the
    // previous wholesale assignment discarded per-connection keys such as the
    // proxy binding. Multiple connections per custom node are supported.
    if (node) {
      providerSpecificData = {
        prefix: node.prefix,
        ...(node.apiType ? { apiType: node.apiType } : {}),
        baseUrl: node.baseUrl,
        // nodeName is the provider's configured name. The key always mirrors
        // the node so a rename is reflected everywhere without re-writing
        // every connection.
        nodeName: node.name,
        ...(providerSpecificData || {}),
      };
    }

    const mergedProviderSpecificData = {
      ...(providerSpecificData || {}),
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled,
      connectionProxyUrl: proxyConfig.connectionProxyUrl,
      connectionNoProxy: proxyConfig.connectionNoProxy,
    };

    if (proxyPoolId !== null) {
      mergedProviderSpecificData.proxyPoolId = proxyPoolId;
    }

    const newConnection = await createProviderConnection({
      provider,
      authType: isWebCookieProvider ? "cookie" : "apikey",
      name: finalName,
      apiKey: apiKey || "",
      email: email || "",
      priority: priority || 1,
      globalPriority: globalPriority || null,
      defaultModel: defaultModel || null,
      providerSpecificData: mergedProviderSpecificData,
      isActive: true,
      testStatus: testStatus || "unknown",
    });

    // Hide sensitive fields
    const result = { ...newConnection };
    delete result.apiKey;

    return res.status(201).json({ connection: result });
  } catch (error) {
    console.log("Error creating provider:", error);
    return res.status(500).json({ error: "Failed to create provider" });
  }
}
