
import {
  MODEL_CAPABILITIES,
  CAPABILITY_SPECS,
  TEST_STATUSES,
} from "../../../../shared/constants/modelCapabilities.js";

// GET /api/models/test/capabilities
// The capability registry, served so the Add Model modal, the capability filter
// and the status badges all read the SAME table the backend tests against. The
// validation-token list is omitted: it is an internal detail of the adapters.
export async function GET_handler(req, res) {
  try {
    return res.json({
      capabilities: MODEL_CAPABILITIES,
      specs: Object.fromEntries(
        MODEL_CAPABILITIES.map((id) => {
          const spec = CAPABILITY_SPECS[id];
          return [
            id,
            {
              id,
              label: spec.label,
              icon: spec.icon,
              endpoint: spec.endpoint,
              timeoutMs: spec.timeoutMs,
              cheap: spec.cheap,
              async: !!spec.async,
              requiresEndpointConfig: !!spec.requiresEndpointConfig,
              requiresImageInput: !!spec.requiresImageInput,
            },
          ];
        })
      ),
      statuses: TEST_STATUSES,
    });
  } catch (error) {
    return res.status(500).json({ error: "Failed to load capability specs" });
  }
}
