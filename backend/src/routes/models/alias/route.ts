
import { getModelAliases, setModelAlias, deleteModelAlias } from "../../../models/index.js";
import { resolveBulkAliasEntries } from "../../../lib/models/autoAdd.js";

export const dynamic = "force-dynamic";

// GET /api/models/alias - Get all aliases
export async function GET(req, res) {
  try {
    const aliases = await getModelAliases();
    return res.json({ aliases });
  } catch (error) {
    console.log("Error fetching aliases:", error);
    return res.status(500).json({ error: "Failed to fetch aliases" });
  }
}

// PUT /api/models/alias - Set model alias
export async function PUT_handler(req, res) {
  try {
    const body = req.body;
    const { model, alias } = body;

    if (!model || !alias) {
      return res.status(400).json({ error: "Model and alias required" });
    }

    await setModelAlias(alias, model);

    return res.json({ success: true, model, alias });
  } catch (error) {
    console.log("Error updating alias:", error);
    return res.status(500).json({ error: "Failed to update alias" });
  }
}

// POST /api/models/alias - Bulk-add models (the "Add All Models" target).
// Body: { models: [{ model, alias }] }. Idempotent: entries whose alias or
// full-model value already exists are skipped, never overwritten, so manual
// configuration is preserved and repeated calls are safe. Alias collisions
// (same alias, different model) are reported as failed, not silently resolved.
export async function POST_handler(req, res) {
  try {
    const { models } = req.body || {};
    if (!Array.isArray(models)) {
      return res.status(400).json({ error: "models must be an array" });
    }
    if (models.length > 2000) {
      return res.status(400).json({ error: "Too many models (max 2000)" });
    }
    const existing = await getModelAliases();
    const { toAdd, skipped, failed: preFailed } = resolveBulkAliasEntries(models, existing || {});
    let added = 0;
    let failed = preFailed;
    for (const { model, alias } of toAdd) {
      try {
        await setModelAlias(alias, model);
        added += 1;
      } catch {
        failed += 1;
      }
    }
    return res.json({ success: true, added, skipped, failed });
  } catch (error) {
    console.log("Error bulk-adding aliases:", error);
    return res.status(500).json({ error: "Failed to bulk-add models" });
  }
}

// DELETE /api/models/alias?alias=xxx - Delete alias
export async function DELETE_handler(req, res) {
  try {
    const { searchParams } = new URL('http://localhost' + req.originalUrl);
    const alias = searchParams.get("alias");

    if (!alias) {
      return res.status(400).json({ error: "Alias required" });
    }

    await deleteModelAlias(alias);

    return res.json({ success: true });
  } catch (error) {
    console.log("Error deleting alias:", error);
    return res.status(500).json({ error: "Failed to delete alias" });
  }
}
