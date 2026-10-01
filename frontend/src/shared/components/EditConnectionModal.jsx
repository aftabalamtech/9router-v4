
import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS } from "@/shared/constants/providers";
import Toggle from "@/shared/components/Toggle";
import { readJsonResponse } from "@/shared/utils/safeJson";

// Shared safe reader: never throws on a non-JSON body. Test Connection and the
// API-key "Check" both used `await res.json()`, so whenever the backend replied
// with an HTML page (Cloudflare interstitial, proxy error) the browser threw
// `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` and the real
// failure category was lost.
const postJson = async (url, body) =>
  readJsonResponse(await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { label: "provider validation" });

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
    supportsImageRef: true,
    supportsVideoRef: true,
    supportsStartEndFrame: true,
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testError, setTestError] = useState("");
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [validationError, setValidationError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (connection) {
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
        supportsImageRef: connection.providerSpecificData?.supportsImageRef !== false,
        supportsVideoRef: connection.providerSpecificData?.supportsVideoRef !== false,
        supportsStartEndFrame: connection.providerSpecificData?.supportsStartEndFrame !== false,
      });
      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      setTestResult(null);
      setTestError("");
      setValidationResult(null);
      setValidationError("");
    }
  }, [connection]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerInfo = AI_PROVIDERS[connection?.provider];
  const isVideoProvider = providerInfo?.serviceKinds?.includes("video") || connection?.provider === "leonardo" || connection?.provider === "runwayml";

  const handleTest = async () => {
    if (!connection?.provider) return;
    setTesting(true);
    setTestResult(null);
    setTestError("");
    try {
      const parsed = await readJsonResponse(
        await fetch(`/api/providers/${connection.id}/test`, { method: "POST" }),
        { label: "connection test" }
      );
      const data = parsed.data || {};
      if (parsed.ok && data.valid) {
        setTestResult("success");
      } else {
        setTestResult("failed");
        setTestError(data.error || parsed.error || "Connection test failed");
      }
    } catch {
      setTestResult("failed");
      setTestError("Could not reach the 9Router API");
    } finally {
      setTesting(false);
    }
  };

  const validateKey = async () => {
    const parsed = await postJson("/api/providers/validate", {
      provider: connection.provider,
      apiKey: formData.apiKey,
      ...(isAzure ? { providerSpecificData: azureData } : {}),
      ...(isCloudflareAi ? { providerSpecificData: cloudflareData } : {}),
    });
    const data = parsed.data || {};
    const ok = parsed.ok && !!data.valid;
    setValidationResult(ok ? "success" : "failed");
    setValidationError(ok ? "" : (data.error || parsed.error || "Validation failed"));
    return ok;
  };

  const handleValidate = async () => {
    if (!connection?.provider || !formData.apiKey) return;
    setValidating(true);
    setValidationResult(null);
    setValidationError("");
    try {
      await validateKey();
    } catch {
      setValidationResult("failed");
      setValidationError("Could not reach the 9Router API");
    } finally {
      setValidating(false);
    }
  };

  const handleSubmit = async () => {
    if (!connection) return;
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      if (!isOAuth && formData.apiKey) {
        updates.apiKey = formData.apiKey;
        let isValid = validationResult === "success";
        if (!isValid) {
          try {
            setValidating(true);
            setValidationResult(null);
            isValid = await validateKey();
          } catch {
            setValidationResult("failed");
            setValidationError("Could not reach the 9Router API");
          } finally {
            setValidating(false);
          }
        }
        if (isValid) {
          updates.testStatus = "active";
          updates.lastError = null;
          updates.lastErrorAt = null;
        }
      }
      
      updates.providerSpecificData = {
        ...(connection.providerSpecificData || {}),
        supportsImageRef: formData.supportsImageRef,
        supportsVideoRef: formData.supportsVideoRef,
        supportsStartEndFrame: formData.supportsStartEndFrame,
      };

      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        updates.providerSpecificData = {
          ...updates.providerSpecificData,
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        };
      }
      if (isCloudflareAi) {
        updates.providerSpecificData = {
          ...updates.providerSpecificData,
          accountId: cloudflareData.accountId,
        };
      }
      
      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        {isCompatible && (
          <p className="text-[11px] text-text-muted">
            This connection belongs to{" "}
            <span className="font-medium text-text-main">
              {connection?.providerSpecificData?.nodeName || connection?.providerName || connection?.provider}
            </span>
            . Editing here changes only this connection — its name, key and
            settings. The provider&apos;s base URL and prefix are shared, and are
            edited via &quot;Edit&quot; on the provider configuration card.
          </p>
        )}
        <Input
          label="Connection name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {isVideoProvider && (
          <div className="bg-sidebar/30 p-4 rounded-lg border border-accent/10 flex flex-col gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-text-muted">Capabilities</h4>
            
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Image Reference</p>
                <p className="text-xs text-text-muted">Supports image URL inputs as prompts</p>
              </div>
              <Toggle
                checked={formData.supportsImageRef ?? true}
                onChange={(checked) => setFormData({ ...formData, supportsImageRef: checked })}
              />
            </div>
            
            <div className="flex items-center justify-between border-t border-accent/5 pt-3">
              <div>
                <p className="text-sm font-medium">Video Reference</p>
                <p className="text-xs text-text-muted">Supports video URL inputs as prompts</p>
              </div>
              <Toggle
                checked={formData.supportsVideoRef ?? true}
                onChange={(checked) => setFormData({ ...formData, supportsVideoRef: checked })}
              />
            </div>
            
            <div className="flex items-center justify-between border-t border-accent/5 pt-3">
              <div>
                <p className="text-sm font-medium">Start/End Frame</p>
                <p className="text-xs text-text-muted">Supports specifying start/end frames</p>
              </div>
              <Toggle
                checked={formData.supportsStartEndFrame ?? true}
                onChange={(checked) => setFormData({ ...formData, supportsStartEndFrame: checked })}
              />
            </div>
          </div>
        )}

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="Enter new API key"
                hint="Leave blank to keep this connection's current key. Stored keys are never sent to the browser."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={!formData.apiKey || validating || saving} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <div className="flex flex-col gap-1">
                <Badge variant={validationResult === "success" ? "success" : "error"}>
                  {validationResult === "success" ? "Valid" : "Invalid"}
                </Badge>
                {validationResult === "failed" && validationError && (
                  <span className="text-sm text-red-500 break-words">{validationError}</span>
                )}
              </div>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <div className="flex flex-col gap-1">
                <Badge variant={testResult === "success" ? "success" : "error"}>
                  {testResult === "success" ? "Valid" : "Failed"}
                </Badge>
                {testResult === "failed" && testError && (
                  <span className="text-sm text-red-500 break-words">{testError}</span>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};

