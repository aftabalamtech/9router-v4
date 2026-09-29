
import { ERROR_CODES } from "../../../lib/models/capabilityTest.js";
import {
  testModelCapability,
  testModelAllCapabilities,
  sanitizeErrorMessage,
} from "../../../lib/models/capabilityRegistry.js";
import {
  normalizeCapability,
  TEST_STATUS,
} from "../../../shared/constants/modelCapabilities.js";

// POST /api/models/test
//   { model, capability? }                     -> test one capability
//   { model, capability: "all" }               -> test every declared capability
//   { model, kind }                            -> legacy shape, mapped to a capability
//
// The legacy `kind` parameter is still honoured so existing callers (batch
// testing, the provider page, tests) keep working; it is translated to a
// capability and then run through the SAME adapter, so there is one testing
// path rather than the old chain plus a new one.
export async function POST_handler(req, res) {
  try {
    const { model, kind, capability, settings, persist } = req.body || {};
    if (!model) return res.status(400).json({ error: "Model required" });

    // An EXPLICIT capability that is not recognised must be rejected, not
    // quietly turned into a chat test. Falling through to chat here is the
    // original defect: an image model asked to be tested as "rerank" would be
    // probed with a chat request and the failure would be meaningless. Only an
    // ABSENT capability (legacy callers sending `kind` or nothing) defaults.
    if (capability !== undefined && capability !== null && capability !== "all"
        && !normalizeCapability(capability)) {
      return res.status(400).json({
        ok: false,
        status: "error",
        error: `Unknown capability "${capability}"`,
        errorCode: "invalid_request",
      });
    }
    if (kind !== undefined && kind !== null && !normalizeCapability(kind)) {
      return res.status(400).json({
        ok: false,
        status: "error",
        error: `Unknown model kind "${kind}"`,
        errorCode: "invalid_request",
      });
    }

    // "all" tests every capability the model declares.
    if (capability === "all") {
      const result = await testModelAllCapabilities(model, { settings, persist });
      return res.json({
        ok: result.results.every((r) => r.ok),
        status: result.status,
        results: result.results.map((r) => ({
          ok: r.ok,
          capability: r.capability,
          status: r.status,
          error: r.error ? sanitizeErrorMessage(r.error) : null,
          errorCode: r.errorCode,
          latencyMs: r.latencyMs,
        })),
      });
    }

    const target = normalizeCapability(capability) || normalizeCapability(kind) || "chat";
    const result = await testModelCapability(model, target, { settings, persist });

    // A capability the provider does not offer is NOT a failed test: report it
    // as such so the UI can grey it out instead of showing a red failure.
    const unsupported = result.status === TEST_STATUS.UNSUPPORTED;
    return res.json({
      ok: result.ok,
      // `status` is the per-model vocabulary; `kind` is kept for older clients.
      status: unsupported ? "unsupported" : (result.ok ? "passed" : "error"),
      kind: target,
      capability: target,
      latencyMs: result.latencyMs,
      error: result.error ? sanitizeErrorMessage(result.error) : null,
      errorCode: result.errorCode,
      testedAt: result.testedAt,
      // Legacy consumers read `error` and `status`; keep the shape they expect.
      ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      status: "error",
      error: sanitizeErrorMessage(err?.message || "Test failed"),
      errorCode: ERROR_CODES.UNKNOWN,
    });
  }
}

// GET /api/models/test/capabilities lives in its own route file — the router
// mounts one path per directory, so it cannot be a sub-path of this one.
