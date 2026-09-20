import { getBlockedModels, blockModels, unblockModels } from "../../../lib/modelBlocksDb.js";

export const dynamic = "force-dynamic";

// GET /api/models/blocks?providerAlias=xxx
export async function GET_handler(req, res) {
  try {
    const { searchParams } = new URL('http://localhost' + req.originalUrl);
    const providerAlias = searchParams.get("providerAlias");
    const all = await getBlockedModels();
    if (providerAlias) return res.json({ ids: all[providerAlias] || [] });
    return res.json({ blocked: all });
  } catch (error) {
    console.log("Error fetching blocked models:", error);
    return res.status(500).json({ error: "Failed to fetch blocked models" });
  }
}

// POST /api/models/blocks  body: { providerAlias, ids: [...] }
export async function POST_handler(req, res) {
  try {
    const { providerAlias, ids } = req.body;
    if (!providerAlias || !Array.isArray(ids)) {
      return res.status(400).json({ error: "providerAlias and ids[] required" });
    }
    await blockModels(providerAlias, ids);
    return res.json({ success: true });
  } catch (error) {
    console.log("Error blocking models:", error);
    return res.status(500).json({ error: "Failed to block models" });
  }
}

// DELETE /api/models/blocks?providerAlias=xxx[&id=yyy]
export async function DELETE_handler(req, res) {
  try {
    const { searchParams } = new URL('http://localhost' + req.originalUrl);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    if (!providerAlias) {
      return res.status(400).json({ error: "providerAlias required" });
    }
    await unblockModels(providerAlias, id ? [id] : []);
    return res.json({ success: true });
  } catch (error) {
    console.log("Error unblocking models:", error);
    return res.status(500).json({ error: "Failed to unblock models" });
  }
}
