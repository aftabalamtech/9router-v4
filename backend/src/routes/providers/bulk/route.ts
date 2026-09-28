// POST /api/providers/bulk - Create many API-key connections in one request.
//
// Why this exists: built-in providers always supported many connections, while
// custom (OpenAI/Anthropic-compatible) providers were capped at one. Pasting N
// keys therefore meant N sequential browser requests, each re-authenticated by
// the gateway, and a single failure lost the batch's progress.
//
// The whole batch is validated first (planBulkConnections) and only then written
// through the same createProviderConnection path, so storage, dedup, priority
// ordering and connection events behave identically to single adds.
//
// Security:
//  - The response contains only counts, names and reasons. API keys are never
//    echoed, logged or embedded in an error string.
//  - No model or inference test is triggered here: bulk import is a
//    configuration action, and tests stay an explicit user action.

import {
  getProviderConnections,
  getProviderNodeById,
  createProviderConnection,
  getProxyPoolById,
} from "../../../models/index.js";
import { APIKEY_PROVIDERS } from "../../../shared/constants/config.js";
import {
  AI_PROVIDERS,
  FREE_TIER_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
} from "../../../shared/constants/providers.js";
import { normalizeProviderId } from "../../../lib/providerNormalization.js";
import { planBulkConnections, summarizeBulkPlan } from "../../../lib/models/bulkConnections.js";

export const dynamic = "force-dynamic";

function normalizeProxyConfig(body = {}) {
  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";
  if (enabled && !url) {
    return { error: "Connection proxy URL is required when connection proxy is enabled" };
  }
  return { connectionProxyEnabled: enabled, connectionProxyUrl: url, connectionNoProxy: noProxy };
}

export async function POST_handler(req, res) {
  try {
    const body = req.body || {};
    const provider = normalizeProviderId(body.provider);
    const entries = Array.isArray(body.connections) ? body.connections : body.entries;

    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "connections[] is required" });
    }

    const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
    const isValidProvider = APIKEY_PROVIDERS[provider]
      || FREE_TIER_PROVIDERS[provider]
      || isWebCookieProvider
      || isOpenAICompatibleProvider(provider)
      || isAnthropicCompatibleProvider(provider)
      || isCustomEmbeddingProvider(provider);
    if (!provider || !isValidProvider) {
      return res.status(400).json({ error: "Invalid provider" });
    }

    const isCustomNode = isOpenAICompatibleProvider(provider)
      || isAnthropicCompatibleProvider(provider)
      || isCustomEmbeddingProvider(provider);

    let node = null;
    if (isCustomNode) {
      node = await getProviderNodeById(provider);
      if (!node) {
        return res.status(404).json({ error: "Custom provider node not found" });
      }
    }

    const existing = await getProviderConnections({ provider });
    const plan = planBulkConnections(entries, {
      existingConnections: existing,
      defaultNamePrefix: node?.name || AI_PROVIDERS[provider]?.name || "Key",
    });

    const proxyConfig = normalizeProxyConfig(body);
    if (proxyConfig.error) {
      return res.status(400).json({ error: proxyConfig.error });
    }
    let proxyPoolId = null;
    if (body.proxyPoolId && body.proxyPoolId !== "__none__") {
      const pool = await getProxyPoolById(body.proxyPoolId);
      if (!pool) return res.status(400).json({ error: "Proxy pool not found" });
      proxyPoolId = pool.id;
    }

    const baseProviderSpecificData = {
      ...(isCustomNode
        ? {
          prefix: node.prefix,
          ...(node.apiType ? { apiType: node.apiType } : {}),
          baseUrl: node.baseUrl,
          nodeName: node.name,
        }
        : {}),
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled,
      connectionProxyUrl: proxyConfig.connectionProxyUrl,
      connectionNoProxy: proxyConfig.connectionNoProxy,
      ...(proxyPoolId ? { proxyPoolId } : {}),
      ...(isWebCookieProvider ? {} : (body.providerSpecificData || {})),
    };

    const created = [];
    const failed = [];
    for (const entry of plan.valid) {
      try {
        const connection = await createProviderConnection({
          provider,
          authType: isWebCookieProvider ? "cookie" : "apikey",
          name: entry.name,
          apiKey: entry.apiKey,
          priority: entry.priority,
          defaultModel: body.defaultModel || null,
          providerSpecificData: { ...baseProviderSpecificData },
          isActive: entry.isActive,
          // Keep the row neutral: bulk import must not trigger expensive
          // model/inference tests. Testing stays an explicit user action.
          testStatus: "unknown",
        });
        created.push({ id: connection.id, name: connection.name, priority: connection.priority });
      } catch (err) {
        // Reason only — never the key.
        failed.push({ index: entry.index, name: entry.name, error: "Failed to save connection" });
        console.error("Bulk connection create failed:", err?.message || err);
      }
    }

    const summary = summarizeBulkPlan(plan);
    return res.status(created.length > 0 ? 201 : 400).json({
      provider,
      added: created.length,
      connections: created,
      failed,
      ...summary,
    });
  } catch (error) {
    console.log("Error bulk creating providers:", error);
    return res.status(500).json({ error: "Failed to bulk-create connections" });
  }
}
