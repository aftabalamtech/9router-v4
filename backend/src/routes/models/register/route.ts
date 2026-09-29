
import { getModelAliases, setModelAlias, addCustomModel } from "../../../lib/localDb.js";
import { resolveBulkAliasEntries } from "../../../lib/models/autoAdd.js";
import {
  registerModelCapabilities,
  isValidPrefix,
  isValidModelId,
  buildRegisteredId,
  splitRegisteredId,
  getModelCapabilitiesRecord,
  listModelCapabilities,
  resolveCapabilities,
} from "../../../lib/models/capabilityRegistry.js";
import { sanitizeErrorMessage } from "../../../lib/models/capabilityRegistry.js";
import {
  normalizeCapabilities,
  getCapabilitySpec,
} from "../../../shared/constants/modelCapabilities.js";

export const dynamic = "force-dynamic";

// POST /api/models/register
// Register ONE model with explicit capabilities and a caller-chosen prefix.
//
//   { prefix, modelId, capabilities, displayName?, endpoint?, settings?, kind? }
//
// PREFIX SEMANTICS
// The prefix becomes the provider segment of the registered id, so
// prefix "ago" + modelId "gemini-3.7-flash-low" registers exactly
// "ago/gemini-3.7-flash-low". It affects ONLY this model: no other model, alias
// or routing record is touched, and the upstream model id is passed through
// verbatim (never rewritten for display).
//
// IDEMPOTENCY
// Re-adding a model that already exists is a NO-OP for configuration: existing
// capabilities are merged, the display name/endpoint/test history are kept, and
// the response reports `created: false`. This is what prevents a duplicate
// record and preserves manual configuration.
export async function POST_handler(req, res) {
  try {
    const {
      prefix,
      modelId: rawModelId,
      capabilities,
      displayName,
      endpoint,
      settings,
      kind,
      alias: requestedAlias,
    } = req.body || {};

    if (!rawModelId) return res.status(400).json({ error: "modelId required" });

    // Accept a fully-qualified id too. The embedded prefix is only stripped
    // when it MATCHES the supplied prefix (i.e. the user just wrote it out
    // redundantly). Stripping unconditionally would silently delete a leading
    // path segment of a genuine upstream id: prefix "openrouter" + modelId
    // "anthropic/claude-3" must stay "openrouter/anthropic/claude-3", not
    // become "openrouter/claude-3".
    let effectivePrefix = String(prefix || "").trim();
    let effectiveModelId = String(rawModelId).trim();
    if (effectiveModelId.includes("/")) {
      const split = splitRegisteredId(effectiveModelId);
      if (!split.valid) {
        return res.status(400).json({ error: "modelId must be \"<modelId>\" or \"<prefix>/<modelId>\"" });
      }
      const embeddedPrefix = split.prefix;
      if (effectivePrefix && embeddedPrefix === effectivePrefix) {
        // Same prefix written twice — drop the redundant copy.
        effectiveModelId = split.modelId;
      } else if (!effectivePrefix) {
        effectivePrefix = embeddedPrefix;
        effectiveModelId = split.modelId;
      }
      // Otherwise the embedded segment is part of the real upstream id and is
      // deliberately preserved.
    }

    if (!effectivePrefix) {
      return res.status(400).json({ error: "prefix required (or supply a fully-qualified model id)" });
    }
    if (!isValidPrefix(effectivePrefix)) {
      return res.status(400).json({
        error: `Invalid prefix "${effectivePrefix}". Use letters, digits, dot, dash or underscore (max 64 chars).`,
      });
    }
    if (!isValidModelId(effectiveModelId)) {
      return res.status(400).json({ error: "Invalid model id: it must be non-empty, under 200 characters and contain no spaces" });
    }

    const registeredId = buildRegisteredId(effectivePrefix, effectiveModelId);

    // Every declared capability must be one the registry knows. Rejecting an
    // unknown one (rather than silently dropping it) is what stops a model
    // being registered as "chat" because a typo fell through.
    const requested = normalizeCapabilities(capabilities);
    const rawList = Array.isArray(capabilities) ? capabilities : capabilities ? [capabilities] : [];
    const unknown = rawList.filter((c) => typeof c === "string" && !normalizeCapabilities([c]).length);
    if (unknown.length > 0) {
      return res.status(400).json({ error: `Unknown capability: ${unknown.join(", ")}` });
    }

    // A `custom` operation with no endpoint could never be routed, so refuse it
    // up front rather than registering an unusable model.
    if (requested.includes("custom") && !endpoint) {
      return res.status(400).json({ error: "A custom operation requires an endpoint path" });
    }

    const registration = await registerModelCapabilities(registeredId, requested, {
      displayName,
      endpoint,
      settings,
      type: kind,
    });

    // Register in the alias store too, so the model becomes selectable and
    // routable everywhere the global catalogue reads it. The alias is the last
    // path segment, so an upstream id containing slashes stays addressable.
    const alias = requestedAlias
      ? String(requestedAlias).trim()
      : effectiveModelId.split("/").pop() || effectiveModelId;

    const existingAliases = await getModelAliases();
    const alreadyRouted = existingAliases?.[alias] === registeredId
      || Object.values(existingAliases || {}).includes(registeredId);
    let routed = alreadyRouted;
    let effectiveAlias = alias;
    if (!alreadyRouted) {
      // The short alias is a DISPLAY name; the prefix-qualified registered id
      // is the real identity. Two prefixes may legitimately expose the same
      // upstream model ("ag/x" and "ago/x"), so a collision here must NOT block
      // the second registration — that is exactly the per-model prefix change
      // this endpoint exists for. The existing alias is never stolen; the new
      // one gets a provider-scoped name instead.
      if (existingAliases?.[alias] && existingAliases[alias] !== registeredId) {
        const scoped = `${effectivePrefix}/${alias}`;
        if (existingAliases?.[scoped] && existingAliases[scoped] !== registeredId) {
          // Even the scoped name is taken — surface it rather than overwriting.
          return res.status(409).json({
            error: `Alias "${scoped}" is already used by ${existingAliases[scoped]}`,
            alias: scoped,
            registeredId,
          });
        }
        effectiveAlias = scoped;
      }
      await setModelAlias(effectiveAlias, registeredId);
      routed = true;
    }

    // A custom model row gives the model a display name and a kind in the
    // global catalogue. addCustomModel is itself idempotent (check-then-insert
    // in a transaction).
    let customAdded = false;
    if (requested.length > 0) {
      customAdded = await addCustomModel({
        providerAlias: effectivePrefix,
        id: effectiveModelId,
        // The catalogue stores one `type`; chat is the conventional value for
        // a model that can chat, and the full set lives in the capabilities
        // record. The catalogue is a view, the capability record is the truth.
        type: requested.includes("chat") ? "llm" : requested[0],
        name: displayName || effectiveModelId,
      });
    }

    const record = await getModelCapabilitiesRecord(registeredId);
    return res.json({
      success: true,
      registeredId,
      prefix: effectivePrefix,
      modelId: effectiveModelId,
      alias: effectiveAlias,
      capabilities: resolveCapabilities(record, kind),
      created: registration.created,
      routed,
      // A duplicate add is a success, not an error — but the caller is told so
      // it can surface "already registered" rather than "added".
      duplicate: !registration.created,
      customModelAdded: customAdded,
    });
  } catch (error) {
    return res.status(500).json({
      error: sanitizeErrorMessage(error?.message || "Failed to register model"),
    });
  }
}

// GET /api/models/register?prefix=xxx
// List capability registrations, optionally scoped to one prefix.
export async function GET_handler(req, res) {
  try {
    const { searchParams } = new URL("http://localhost" + req.originalUrl);
    const prefix = searchParams.get("prefix") || null;
    const all = await listModelCapabilities(prefix);
    const models = Object.entries(all || {}).map(([registeredId, record]) => {
      const { prefix: p, modelId } = splitRegisteredId(registeredId);
      return {
        registeredId,
        prefix: p,
        modelId,
        displayName: record.displayName || "",
        endpoint: record.endpoint || "",
        settings: record.settings || null,
        capabilities: resolveCapabilities(record),
        createdAt: record.createdAt || null,
        updatedAt: record.updatedAt || null,
      };
    });
    return res.json({ models });
  } catch (error) {
    return res.status(500).json({ error: "Failed to list model registrations" });
  }
}

// DELETE /api/models/register?registeredId=prefix/modelId
// Remove ONLY the capability record. The alias and test history are left
// alone: disabling a capability must never destroy unrelated configuration.
export async function DELETE_handler(req, res) {
  try {
    const { searchParams } = new URL("http://localhost" + req.originalUrl);
    const registeredId = searchParams.get("registeredId");
    if (!registeredId) return res.status(400).json({ error: "registeredId required" });
    const { removeModelCapabilities } = await import("../../../lib/models/capabilityRegistry.js");
    const removed = await removeModelCapabilities(registeredId);
    return res.json({ success: true, removed });
  } catch (error) {
    return res.status(500).json({ error: "Failed to remove model registration" });
  }
}

// GET /api/models/register/specs
// The capability registry, for clients that need endpoint/timeout details.
export async function SPECS_handler(req, res) {
  const { MODEL_CAPABILITIES, CAPABILITY_SPECS, TEST_STATUSES } = await import(
    "../../../shared/constants/modelCapabilities.js"
  );
  return res.json({
    capabilities: MODEL_CAPABILITIES,
    specs: Object.fromEntries(
      MODEL_CAPABILITIES.map((id) => [id, { ...CAPABILITY_SPECS[id], validate: undefined }])
    ),
    statuses: TEST_STATUSES,
  });
}
