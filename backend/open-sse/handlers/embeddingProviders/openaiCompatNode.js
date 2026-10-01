// Custom node providers (openai-compatible-* / custom-embedding-*) — baseUrl from credentials
import createOpenAIEmbeddingAdapter from "./openai.js";
// Shared endpoint construction. This adapter previously re-implemented the
// normalization inline (a third copy of the suffix-stripping rules), which is
// how the chat path and the embeddings path could disagree about the URL.
// open-sse is a separate workspace; from dist/ its copy of this tree sits at
// ../../open-sse, so the shared module resolves as ../../../src/lib/net/...
// (executors/default.js reaches the same file via ../../../src/... — both
// resolve to backend/src/lib/net/providerConnection.js once compiled.)
import { describeProviderTarget, compatibleFamily } from "../../../src/lib/net/providerConnection.js";

const baseAdapter = createOpenAIEmbeddingAdapter("openai");

export default {
  ...baseAdapter,
  buildUrl: (_model, creds, providerId) => {
    const target = describeProviderTarget({
      providerId: providerId || creds?.provider || "custom-embedding-unknown",
      baseUrl: creds?.providerSpecificData?.baseUrl,
      apiKey: creds?.apiKey || creds?.accessToken,
    });
    return target.urls.embeddings || "";
  },
};
