
import { createProviderNode, getProviderNodes } from "../../models/index.js";
import { OPENAI_COMPATIBLE_PREFIX, ANTHROPIC_COMPATIBLE_PREFIX, CUSTOM_EMBEDDING_PREFIX } from "../../shared/constants/providers.js";
import { generateId } from "../../shared/utils/index.js";
import { normalizeCompatibleBaseUrl } from "../../lib/net/compatibleUrl.js";

export const dynamic = "force-dynamic";

const OPENAI_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

const ANTHROPIC_COMPATIBLE_DEFAULTS = {
  baseUrl: "https://api.anthropic.com/v1",
};

const CUSTOM_EMBEDDING_DEFAULTS = {
  baseUrl: "https://api.openai.com/v1",
};

/**
 * Store a base URL in normalized form.
 *
 * Users routinely paste the FULL endpoint (`https://host/v1/chat/completions`,
 * `https://host/v1/models`, `https://host/v1/messages`) into the node form.
 * Previously only `/messages` and `/embeddings` were stripped and each kind
 * stripped a different amount, so a pasted `/v1/models` produced
 * `.../models/models` on discovery while chat produced
 * `.../models/chat/completions`. One normalizer for all three kinds is the
 * actual fix; the request-time builder is idempotent on top of it.
 */
function sanitizeBaseUrl(raw: string | undefined | null, fallback: string): string {
  const candidate = (raw ?? "").toString().trim() || fallback;
  return normalizeCompatibleBaseUrl(candidate) || fallback;
}

function validPrefix(prefix: unknown): prefix is string {
  return typeof prefix === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/i.test(prefix.trim());
}

async function prefixTaken(prefix: string): Promise<boolean> {
  const nodes = await getProviderNodes();
  return nodes.some((node) => String(node.prefix || "").toLowerCase() === prefix.trim().toLowerCase());
}

// GET /api/provider-nodes - List all provider nodes
export async function GET(req, res) {
  try {
    const nodes = await getProviderNodes();
    return res.json({ nodes });
  } catch (error) {
    console.log("Error fetching provider nodes:", error);
    return res.status(500).json({ error: "Failed to fetch provider nodes" });
  }
}

// POST /api/provider-nodes - Create provider node
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const { name, prefix, apiType, baseUrl, type } = body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    if (!validPrefix(prefix)) {
      return res.status(400).json({ error: "Prefix must use only letters, numbers, and dashes (maximum 40 characters)" });
    }
    if (await prefixTaken(prefix)) return res.status(409).json({ error: "Provider prefix is already in use" });

    // Determine type
    const nodeType = type || "openai-compatible";

    if (nodeType === "openai-compatible") {
      if (!apiType || !["chat", "responses"].includes(apiType)) {
        return res.status(400).json({ error: "Invalid OpenAI compatible API type" });
      }

      const node = await createProviderNode({
        id: `${OPENAI_COMPATIBLE_PREFIX}${apiType}-${generateId()}`,
        type: "openai-compatible",
        prefix: prefix.trim(),
        apiType,
        baseUrl: sanitizeBaseUrl(baseUrl, OPENAI_COMPATIBLE_DEFAULTS.baseUrl),
        name: name.trim(),
      });
      return res.status(201).json({ node });
    }

    if (nodeType === "custom-embedding") {
      const node = await createProviderNode({
        id: `${CUSTOM_EMBEDDING_PREFIX}${generateId()}`,
        type: "custom-embedding",
        prefix: prefix.trim(),
        baseUrl: sanitizeBaseUrl(baseUrl, CUSTOM_EMBEDDING_DEFAULTS.baseUrl),
        name: name.trim(),
      });
      return res.status(201).json({ node });
    }

    if (nodeType === "anthropic-compatible") {
      const node = await createProviderNode({
        id: `${ANTHROPIC_COMPATIBLE_PREFIX}${generateId()}`,
        type: "anthropic-compatible",
        prefix: prefix.trim(),
        baseUrl: sanitizeBaseUrl(baseUrl, ANTHROPIC_COMPATIBLE_DEFAULTS.baseUrl),
        name: name.trim(),
      });
      return res.status(201).json({ node });
    }

    return res.status(400).json({ error: "Invalid provider node type" });
  } catch (error) {
    console.log("Error creating provider node:", error);
    return res.status(500).json({ error: "Failed to create provider node" });
  }
}
