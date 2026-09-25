import { getSyncedModels } from "../../../lib/models/modelSync.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/models/synced[?storageAlias=xxx]
 *
 * Models discovered by provider sync (ModelSyncPanel / persistDiscovered).
 *
 * These are provider-owned records that live in the synced catalog, not in the
 * static PROVIDER_MODELS table and not in /api/models/custom. The global Models
 * page previously read only those two sources, so every dynamically discovered
 * model was invisible there even though the provider page displayed it.
 *
 * Stale entries (upstream dropped them) are excluded — they are no longer
 * offered. Manual rows are kept, matching how persistDiscribed treats them.
 */
export async function GET_handler(req, res) {
  try {
    const { searchParams } = new URL("http://localhost" + req.originalUrl);
    const storageAlias = searchParams.get("storageAlias") || null;
    const synced = await getSyncedModels(storageAlias);

    const models = Object.values(synced)
      .filter((m) => m && m.id && !m.stale)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        type: m.type || "llm",
        storageAlias: m.storageAlias,
        providerAlias: m.storageAlias,
        fullModel: m.fullModel || `${m.storageAlias}/${m.id}`,
        isFree: !!m.isFree,
        contextLength: m.contextLength ?? null,
        manual: !!m.manual,
        source: m.source || "synced",
        syncedAt: m.syncedAt || null,
      }));

    return res.json({ models });
  } catch (error) {
    console.log("Error fetching synced models:", error);
    return res.status(500).json({ error: "Failed to fetch synced models" });
  }
}
