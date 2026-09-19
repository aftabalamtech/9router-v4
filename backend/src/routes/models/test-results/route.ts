import { getModelTestResults } from "../../../lib/models/modelTestRepo.js";

// GET /api/models/test-results?providerAlias=xxx - Last persisted test result per model.
export async function GET_handler(req, res) {
  try {
    const { searchParams } = new URL("http://localhost" + req.originalUrl);
    const providerAlias = (searchParams.get("providerAlias") || "").slice(0, 120);
    if (providerAlias && !/^[A-Za-z0-9_.-]+$/.test(providerAlias)) {
      return res.status(400).json({ error: "Invalid providerAlias" });
    }
    const results = await getModelTestResults(providerAlias || undefined);
    return res.json({ results });
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch test results" });
  }
}
