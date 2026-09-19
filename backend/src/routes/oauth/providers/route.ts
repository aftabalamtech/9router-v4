import { listProviders, getManifest } from "../../../lib/oauth/registry.js";

// GET /api/oauth/providers - Registry manifest list (safe fields only, no secrets).
// GET /api/oauth/providers?id=xxx - Single provider manifest.
export async function GET_handler(req, res) {
  try {
    const { searchParams } = new URL("http://localhost" + req.originalUrl);
    const id = searchParams.get("id");
    if (id) {
      try {
        return res.json({ provider: getManifest(id) });
      } catch (err) {
        return res.status(404).json({ error: err.message });
      }
    }
    return res.json({ providers: listProviders() });
  } catch (error) {
    return res.status(500).json({ error: "Failed to load provider registry" });
  }
}
