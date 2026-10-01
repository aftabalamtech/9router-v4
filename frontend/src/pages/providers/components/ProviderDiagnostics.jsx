/**
 * Provider diagnostics panel.
 *
 * Renders the four independent checks returned by POST /api/provider-diagnostics
 * and keeps the three "good" outcomes visibly distinct:
 *
 *   ✓ reachable   — this server can complete a request to the provider
 *   ✓ credential  — the provider accepted the key
 *   ✓ models      — a catalog could be listed
 *   ✓ chat        — an inference actually completed
 *
 * A provider can pass some and fail others (no /models route but chat works; or
 * reachable but the key is rejected), so each row reports its own verdict rather
 * than collapsing into one pass/fail badge.
 */
import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Badge } from "@/shared/components";
import { readJsonResponse } from "@/shared/utils/safeJson";

/** Human labels for the backend's failure vocabulary. */
const CATEGORY_LABELS = {
  invalid_credentials: "Credential rejected",
  permission_denied: "Access denied",
  security_challenge: "Blocked by provider edge",
  rate_limited: "Rate limited",
  upstream_server_error: "Provider outage",
  invalid_endpoint: "Not an API endpoint",
  network_error: "Network unreachable",
  dns_error: "DNS failure",
  tls_error: "TLS failure",
  timeout: "Timed out",
  invalid_response: "Unusable response",
  unsupported_operation: "Not supported",
};

const CHECK_LABELS = {
  network: "Network reachability",
  credential: "Credential validation",
  models: "Model listing",
  chat: "Chat completion",
};

/** Categories that mean the provider itself is refusing this host. */
const EXTERNAL_BLOCK_CATEGORIES = new Set([
  "security_challenge",
  "permission_denied",
]);

function CheckRow({ check }) {
  const label = CATEGORY_LABELS[check.category] || check.category || "Unknown";
  const isExternalBlock = EXTERNAL_BLOCK_CATEGORIES.has(check.category);

  return (
    <div className="flex flex-col gap-1 border-b border-border/50 py-2 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-text-main">{CHECK_LABELS[check.name] || check.name}</span>
        <Badge variant={check.ok ? "success" : "error"} size="sm">
          {check.ok ? "Pass" : "Fail"}
        </Badge>
      </div>
      {!check.ok && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span className="font-medium">{label}</span>
            {check.httpStatus != null && <span>HTTP {check.httpStatus}</span>}
            {check.credentialRejected && <span>credential rejected</span>}
          </div>
          {check.message && (
            <p className="text-xs text-text-muted break-words">{check.message}</p>
          )}
          {check.remediation && (
            <p className="text-xs text-text-muted break-words">
              <span className="font-medium">Next step: </span>
              {check.remediation}
            </p>
          )}
          {isExternalBlock && (
            <p className="text-xs text-amber-500 break-words">
              This looks like an upstream/network restriction on this host, not a
              configuration problem. 9Router will not attempt to bypass a
              provider&apos;s access controls.
            </p>
          )}
          {check.responsePreview && (
            <details className="text-xs text-text-muted">
              <summary className="cursor-pointer">Upstream response (sanitized)</summary>
              <code className="block mt-1 break-all bg-black/5 dark:bg-white/5 rounded p-2">
                {check.responsePreview}
              </code>
            </details>
          )}
        </>
      )}
    </div>
  );
}

CheckRow.propTypes = {
  check: PropTypes.shape({
    name: PropTypes.string,
    ok: PropTypes.bool,
    category: PropTypes.string,
    httpStatus: PropTypes.number,
    message: PropTypes.string,
    remediation: PropTypes.string,
    responsePreview: PropTypes.string,
    credentialRejected: PropTypes.bool,
  }).isRequired,
};

export default function ProviderDiagnostics({ providerId, baseUrl, apiKey, apiType, modelId, onClose }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const run = async (includeChat) => {
    setRunning(true);
    setError("");
    try {
      const parsed = await readJsonResponse(
        await fetch("/api/provider-diagnostics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId,
            baseUrl,
            apiKey,
            apiType,
            modelId: includeChat ? modelId : undefined,
            includeChat,
          }),
        }),
        { label: "provider diagnostics" }
      );
      const data = parsed.data;
      if (parsed.ok && data) setResult(data);
      else setError(data?.error || parsed.error || "Diagnostics could not complete.");
    } catch {
      setError("Could not reach the 9Router API");
    } finally {
      setRunning(false);
    }
  };

  const checks = result?.checks || [];
  const results = result?.results || {};

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Connectivity diagnostics</h3>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={running || !apiKey}
            onClick={() => run(false)}
          >
            {running ? "Running…" : "Run free checks"}
          </Button>
          <Button
            size="sm"
            disabled={running || !apiKey || !modelId}
            onClick={() => run(true)}
            title={!modelId ? "Enter a model ID to include a chat test (costs 1 token)" : undefined}
          >
            {running ? "Running…" : "Run all (incl. chat)"}
          </Button>
        </div>
      </div>

      {!apiKey && (
        <p className="text-xs text-text-muted">
          Enter an API key to run credential checks.
        </p>
      )}
      {modelId ? null : (
        <p className="text-xs text-text-muted">
          The chat test costs one token, so it needs a model ID. Set one above to
          include it.
        </p>
      )}

      {error && <p className="text-sm text-red-500 break-words">{error}</p>}

      {result && (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge variant={result.ok ? "success" : "error"}>
                {result.verdict === "healthy"
                  ? "Healthy"
                  : result.verdict === "usable"
                    ? "Usable (models unavailable)"
                    : result.verdict === "unreachable"
                      ? "Unreachable"
                      : result.verdict === "invalid_credentials"
                        ? "Credential rejected"
                        : "Blocked"}
              </Badge>
              <span className="text-xs text-text-muted">
                {CATEGORY_LABELS[result.category] || result.category}
              </span>
            </div>
            {/* Keep the three distinct successes legible at a glance. */}
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant={results.network ? "success" : "default"} size="sm">
                Reachable
              </Badge>
              <Badge variant={results.credential ? "success" : "default"} size="sm">
                Credential
              </Badge>
              <Badge variant={results.models ? "success" : "default"} size="sm">
                Models
              </Badge>
              {checks.some((c) => c.name === "chat") && (
                <Badge variant={results.chat ? "success" : "default"} size="sm">
                  Chat
                </Badge>
              )}
            </div>
            {result.remediation && (
              <p className="text-xs text-text-muted break-words">
                <span className="font-medium">Next step: </span>
                {result.remediation}
              </p>
            )}
          </div>

          <div>
            {checks.map((check) => (
              <CheckRow key={check.name} check={check} />
            ))}
          </div>

          {result.target && (
            <p className="text-xs text-text-muted break-all">
              Tested: <code>{result.target.modelsUrl}</code>
            </p>
          )}
        </>
      )}

      {onClose && (
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      )}
    </div>
  );
}

ProviderDiagnostics.propTypes = {
  providerId: PropTypes.string,
  baseUrl: PropTypes.string,
  apiKey: PropTypes.string,
  apiType: PropTypes.string,
  modelId: PropTypes.string,
  onClose: PropTypes.func,
};