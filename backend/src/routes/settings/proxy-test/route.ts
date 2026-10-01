
import { testProxyUrl } from "../../../lib/network/proxyTest.js";
import { validateOutboundUrl } from "../../../lib/net/egressPolicy.js";

export async function POST_handler(req, res) {
  try {
    const body = req.body;

    // A caller-supplied test target turns this endpoint into an SSRF probe: it
    // makes the 9Router host fetch an arbitrary URL through the configured
    // proxy. Validate it under the same policy as a provider base URL.
    if (body?.testUrl) {
      const check = validateOutboundUrl(body.testUrl);
      if (!check.ok) {
        return res.status(400).json({ ok: false, error: `Test target rejected: ${check.reason}` });
      }
      body.testUrl = check.url.toString();
    }

    if (body?.proxyUrl) {
      const check = validateOutboundUrl(body.proxyUrl, { requireHttps: false });
      if (!check.ok) {
        return res.status(400).json({ ok: false, error: `Proxy URL rejected: ${check.reason}` });
      }
      body.proxyUrl = check.url.toString();
    }

    const result = await testProxyUrl({
      proxyUrl: body?.proxyUrl,
      testUrl: body?.testUrl,
      timeoutMs: body?.timeoutMs,
    });

    if (result?.ok) {
      return res.json(result);
    }

    const status = typeof result?.status === "number" ? result.status : 500;
    return res.json({ ok: false, error: result?.error || "Proxy test failed" }, { status });
  } catch (err) {
    const message = err?.name === "AbortError" ? "Proxy test timed out" : (err?.message || String(err));
    return res.status(500).json({ ok: false, error: message });
  }
}
