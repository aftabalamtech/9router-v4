import { getWorkingModels } from "../../../lib/models/eligibility.js";

export const dynamic = "force-dynamic";

// GET /api/models/working[?providerAlias=xxx]
// Centralized eligible-working-models list shared by the Models Working
// filter, the Playground working list/count, and Combos eligibility.
// working = latest test passed AND NOT hidden AND NOT blocked.
export async function GET_handler(req, res) {
  try {
    const { searchParams } = new URL("http://localhost" + req.originalUrl);
    const providerAlias = searchParams.get("providerAlias") || null;
    const models = await getWorkingModels({ providerAlias });
    return res.json({ models });
  } catch (error) {
    console.log("Error fetching working models:", error);
    return res.status(500).json({ error: "Failed to fetch working models" });
  }
}
