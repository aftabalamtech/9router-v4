import { getProviderAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "../../../../shared/constants/providers.js";
import {
  createSyncJob,
  getSyncSettings,
  updateSyncSettings,
  getSyncedModels,
  clearSyncedModels,
} from "../../../../lib/models/modelSync.js";

function resolveStorageAlias(providerId, override) {
  if (typeof override === "string" && override && override.length <= 120) return override;
  if (isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId)) return providerId;
  return getProviderAlias(providerId);
}

// GET /api/providers/[id]/sync-models - Sync settings + synced catalog summary.
export async function GET_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL("http://localhost" + req.originalUrl);
    const storageAlias = resolveStorageAlias(id, searchParams.get("storageAlias"));
    const [settings, synced] = await Promise.all([
      getSyncSettings(id),
      getSyncedModels(storageAlias),
    ]);
    const values = Object.values(synced);
    const payload = {
      providerId: id,
      storageAlias,
      settings,
      syncedCount: values.length,
      staleCount: values.filter((v) => v?.stale).length,
    };
    if (searchParams.get("include") === "catalog") {
      payload.catalog = values
        .map((v) => ({
          id: v.id,
          name: v.name,
          type: v.type,
          contextLength: v.contextLength,
          isFree: v.isFree,
          stale: !!v.stale,
          manual: !!v.manual,
          syncedAt: v.syncedAt,
          connectionIds: v.connectionIds || [],
        }))
        .slice(0, 2000);
    }
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch sync status" });
  }
}

// POST /api/providers/[id]/sync-models - Start a sync job.
// Body: { connectionIds?: string[], manualIds?: string[], storageAlias? }
export async function POST_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const { connectionIds, manualIds, storageAlias } = req.body || {};
    if (connectionIds !== undefined && !Array.isArray(connectionIds)) {
      return res.status(400).json({ error: "connectionIds must be an array" });
    }
    const job = await createSyncJob({
      providerId: id,
      storageAlias: resolveStorageAlias(id, storageAlias),
      connectionIds,
      manualIds,
    });
    return res.status(202).json({
      jobId: job.id,
      status: job.status,
      streamUrl: `/api/providers/${encodeURIComponent(id)}/sync-models/jobs/${job.id}/stream`,
    });
  } catch (error) {
    const statusCode = error?.statusCode === 400 ? 400 : error?.statusCode === 409 ? 409 : 500;
    return res.status(statusCode).json({ error: statusCode === 500 ? "Failed to start sync" : error.message });
  }
}

// PUT /api/providers/[id]/sync-models - Update { autoFetch, autoSync }.
export async function PUT_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const { autoFetch, autoSync } = req.body || {};
    if (autoFetch !== undefined && typeof autoFetch !== "boolean") {
      return res.status(400).json({ error: "autoFetch must be a boolean" });
    }
    if (autoSync !== undefined && typeof autoSync !== "boolean") {
      return res.status(400).json({ error: "autoSync must be a boolean" });
    }
    const settings = await updateSyncSettings(id, { autoFetch, autoSync });
    return res.json({ providerId: id, settings });
  } catch (error) {
    return res.status(500).json({ error: "Failed to update sync settings" });
  }
}

// DELETE /api/providers/[id]/sync-models - Clear synced catalog (manual models preserved).
export async function DELETE_handler(req, res, { params }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL("http://localhost" + req.originalUrl);
    const storageAlias = resolveStorageAlias(id, searchParams.get("storageAlias"));
    const removed = await clearSyncedModels(storageAlias);
    return res.json({ providerId: id, storageAlias, removed });
  } catch (error) {
    return res.status(500).json({ error: "Failed to clear synced models" });
  }
}
