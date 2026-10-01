
import { createProxyPool, getProviderConnections, getProxyPools } from "../../models/index.js";
import { validateProxyEndpoint } from "../../lib/net/egressPolicy.js";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

const VALID_PROXY_TYPES = ["http", "vercel", "cloudflare", "deno"];

function normalizeProxyPoolInput(body = {}) {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const proxyUrl = typeof body?.proxyUrl === "string" ? body.proxyUrl.trim() : "";
  const noProxy = typeof body?.noProxy === "string" ? body.noProxy.trim() : "";
  const isActive = body?.isActive === undefined ? true : body.isActive === true;
  const strictProxy = body?.strictProxy === true;
  const type = VALID_PROXY_TYPES.includes(body?.type) ? body.type : "http";

  if (!name) {
    return { error: "Name is required" };
  }

  if (!proxyUrl) {
    return { error: "Proxy URL is required" };
  }

  // Relay types carry their own deployment (the Worker fetches an
  // `x-relay-target` header), so the destination rules differ.
  if (type === "http") {
    const check = validateProxyEndpoint(proxyUrl);
    if (!check.ok) {
      // Reject rather than normalize: an unvalidated proxy destination turns
      // 9Router into a request-forgery primitive against whatever the service
      // can already reach.
      return { error: `Invalid proxy URL: ${check.reason}` };
    }
    return { name, proxyUrl: check.url.toString(), noProxy, isActive, strictProxy, type };
  }

  return { name, proxyUrl, noProxy, isActive, strictProxy, type };
}

function buildUsageMap(connections = []) {
  const usageMap = new Map();

  for (const connection of connections) {
    const proxyPoolId = connection?.providerSpecificData?.proxyPoolId;
    if (!proxyPoolId) continue;

    usageMap.set(proxyPoolId, (usageMap.get(proxyPoolId) || 0) + 1);
  }

  return usageMap;
}

// GET /api/proxy-pools - List proxy pools
export async function GET_handler(req, res) {
  try {
    const { searchParams } = new URL('http://localhost' + req.originalUrl);
    const isActive = toBoolean(searchParams.get("isActive"));
    const includeUsage = searchParams.get("includeUsage") === "true";

    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    const proxyPools = await getProxyPools(filter);

    if (!includeUsage) {
      return res.json({ proxyPools });
    }

    const connections = await getProviderConnections();
    const usageMap = buildUsageMap(connections);

    const enrichedProxyPools = proxyPools.map((pool) => ({
      ...pool,
      boundConnectionCount: usageMap.get(pool.id) || 0,
    }));

    return res.json({ proxyPools: enrichedProxyPools });
  } catch (error) {
    console.log("Error fetching proxy pools:", error);
    return res.status(500).json({ error: "Failed to fetch proxy pools" });
  }
}

// POST /api/proxy-pools - Create proxy pool
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const normalized = normalizeProxyPoolInput(body);

    if (normalized.error) {
      return res.status(400).json({ error: normalized.error });
    }

    const proxyPool = await createProxyPool(normalized);
    return res.status(201).json({ proxyPool });
  } catch (error) {
    console.log("Error creating proxy pool:", error);
    return res.status(500).json({ error: "Failed to create proxy pool" });
  }
}
