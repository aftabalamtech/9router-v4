
import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { cachedJson, invalidateCache } from "@/shared/utils/cachedJson";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";

const NONE_PROXY_POOL_VALUE = "__none__";

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      cachedJson("/api/proxy-pools?isActive=true"),
      cachedJson("/api/settings"),
    ]).then(([poolRes, settingsRes]) => {
      if (cancelled) return;
      const poolData = poolRes.data || {};
      const settingsData = settingsRes.data || {};
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const handleChange = async (newValue) => {
    setProxyPoolId(newValue);
    setSaving(true);
    try {
      // Read-modify-write: always bypass the cache so a concurrent settings
      // update from another card is not clobbered by a stale snapshot.
      const res = await cachedJson("/api/settings", { force: true });
      const data = res.data || {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (newValue === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = newValue;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      invalidateCache("/api/settings");
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxyPoolId error:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>
      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
      />
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
