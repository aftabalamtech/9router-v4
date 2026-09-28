
import { deleteProviderConnectionsByProvider, deleteProviderNode, getProviderConnections, getProviderNodeById, updateProviderConnection, updateProviderNode } from "../../../models/index.js";
import { normalizeCompatibleBaseUrl } from "../../../lib/net/compatibleUrl.js";

// PUT /api/provider-nodes/[id] - Update provider node
export async function PUT_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const body = req.body;
    const { name, prefix, apiType, baseUrl } = body;
    const node = await getProviderNodeById(id);

    if (!node) {
      return res.status(404).json({ error: "Provider node not found" });
    }

    if (!name?.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    if (!prefix?.trim()) {
      return res.status(400).json({ error: "Prefix is required" });
    }

    // Only validate apiType for OpenAI Compatible nodes
    if (node.type === "openai-compatible" && (!apiType || !["chat", "responses"].includes(apiType))) {
      return res.status(400).json({ error: "Invalid OpenAI compatible API type" });
    }

    if (!baseUrl?.trim()) {
      return res.status(400).json({ error: "Base URL is required" });
    }

    // One normalizer for every custom-provider kind: strips a pasted
    // `/chat/completions`, `/models`, `/messages` or `/embeddings` suffix.
    // Previously each kind stripped only its own suffix, so an OpenAI node
    // configured with a pasted `/v1/models` base produced
    // `.../models/chat/completions` at request time.
    const sanitizedBaseUrl = normalizeCompatibleBaseUrl(baseUrl);
    if (!sanitizedBaseUrl) {
      return res.status(400).json({ error: "Base URL is not a valid http(s) URL" });
    }

    const updates = {
      name: name.trim(),
      prefix: prefix.trim(),
      baseUrl: sanitizedBaseUrl,
    };

    if (node.type === "openai-compatible") {
      updates.apiType = apiType;
    }

    const updated = await updateProviderNode(id, updates);

    // Fan the new node config out to every connection. Custom providers now
    // support multiple connections, so this must MERGE into each connection's
    // own providerSpecificData (api key, proxy binding and per-connection
    // settings are untouched) instead of replacing it.
    const connections = await getProviderConnections({ provider: id });
    await Promise.all(connections.map((connection) => (
      updateProviderConnection(connection.id, {
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          prefix: prefix.trim(),
          ...(node.type === "openai-compatible" ? { apiType } : {}),
          baseUrl: sanitizedBaseUrl,
          nodeName: updated.name,
        }
      })
    )));

    return res.json({ node: updated });
  } catch (error) {
    console.log("Error updating provider node:", error);
    return res.status(500).json({ error: "Failed to update provider node" });
  }
}

// DELETE /api/provider-nodes/[id] - Delete provider node and its connections
export async function DELETE_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const node = await getProviderNodeById(id);

    if (!node) {
      return res.status(404).json({ error: "Provider node not found" });
    }

    await deleteProviderConnectionsByProvider(id);
    await deleteProviderNode(id);

    return res.json({ success: true });
  } catch (error) {
    console.log("Error deleting provider node:", error);
    return res.status(500).json({ error: "Failed to delete provider node" });
  }
}
