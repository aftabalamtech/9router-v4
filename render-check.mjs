// Server-render the provider detail page and the Models page to catch
// render-path crashes without a browser: bad imports, undefined identifiers,
// broken hooks, or a component that throws on the initial (empty) data state.
//
// Run from the repo root:  node render-check.mjs
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const FRONTEND = new URL("./frontend/", import.meta.url);
const SRC = new URL("src/", FRONTEND);

// Reuse the app's own `@/` alias hook so these renders resolve exactly what
// Vite would resolve, and add a loader hook that lets Node execute the
// app's .jsx sources (Node has no JSX transform built in; Vite normally does
// this at build time).
register(new URL("frontend/test/alias-resolver-impl.mjs", import.meta.url), import.meta.url);
register(new URL("frontend/test/jsx-loader-impl.mjs", import.meta.url), import.meta.url);

// PROXY: 1 = a running backend on :3001 with a logged-in session, used to
// render the model UI against REAL data; otherwise renders run offline.
const PROXY = process.env.RENDER_PROXY === "1";
const COOKIE = process.env.RENDER_COOKIE || "";

function offlineResponse() {
  return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!PROXY) return offlineResponse();
  const target = String(url).replace(/^https?:\/\/[^/]+/, "http://127.0.0.1:3001");
  const res = await realFetch(target, { ...init, headers: { ...(init.headers || {}), Cookie: COOKIE } });
  return res;
};

const problems = [];

function check(name, Component, routePath) {
  try {
    const html = renderToString(
      h(
        MemoryRouter,
        { initialEntries: [routePath] },
        h(Routes, null, h(Route, { path: "/:rest/*", element: h(Component) }))
      )
    );
    if (html.includes("NaN")) problems.push(`${name}: rendered "NaN"`);
    if (/class="[^"]*\bundefined\b/.test(html)) {
      problems.push(`${name}: rendered "undefined" in a class attribute`);
    }
    if (!html.trim()) problems.push(`${name}: rendered empty output`);
    console.log(`  ok  ${name} (${html.length} bytes)`);
  } catch (error) {
    problems.push(`${name}: threw ${error?.message}`);
    console.log(`  FAIL ${name}: ${error?.message}`);
  }
}

const ProviderDetail = (await import(new URL("pages/providers/[id]/page.jsx", SRC))).default;
const ModelsPage = (await import(new URL("pages/models/page.jsx", SRC))).default;
const SyncPanel = (await import(new URL("pages/providers/[id]/ModelSyncPanel.jsx", SRC))).default;
const Disabled = (await import(new URL("pages/providers/[id]/DisabledModelsSection.jsx", SRC))).default;

console.log("server-render checks:");

check("provider detail page (compatible)", ProviderDetail, "/providers/openai-compatible-chat-x");
check("provider detail page (built-in)", ProviderDetail, "/providers/openai");
check("models page", ModelsPage, "/dashboard/models");

// Render the shared Available Models section against the live catalog, which is
// where the filters, cards and model actions actually live.
try {
  const Section = (await import(new URL("shared/components/AvailableModelsSection.jsx", SRC))).default;
  const html = renderToString(h(Section, { headerTitle: "Available Models" }));
  const cards = (html.match(/Compatibility/g) || []).length;
  const text = html.replaceAll("<!-- -->", "");
  console.log(`  ok  available models section, live data (${html.length} bytes, ${cards} cards)`);
  if (cards === 0) problems.push("available models section: rendered no model cards against live data");
  // Every required filter must be present, not just rendered as an empty shell.
  for (const label of ["All", "Visible only", "Hidden only", "All statuses", "Working", "Error", "Disabled",
                       "Free only", "Paid only", "Free first", "Auto-hide failed models"]) {
    if (!text.includes(label)) problems.push(`available models section: missing filter "${label}"`);
  }
  if (!text.includes("Test all")) problems.push('available models section: missing "Test all"');
} catch (error) {
  problems.push(`available models section: threw ${error?.message}`);
  console.log(`  FAIL available models section: ${error?.message}`);
}

// Smoke-render the sync panel (collapsed and expanded) for both a
// discovery-capable and an unsupported provider. The detailed collapsed/expanded
// assertions live in the section further below.
for (const [label, providerId] of [["discovery-capable", "openai"], ["no discovery", "sdwebui"]]) {
  try {
    const html = renderToString(
      h(SyncPanel, {
        providerId,
        providerStorageAlias: "oc",
        connections: [],
        modelAliases: {},
        hardcodedIds: [],
        testResults: {},
        disabledIds: [],
        onAddModel: () => {},
        onCatalogChanged: () => {},
      })
    );
    if (html.includes("NaN")) problems.push(`sync panel (${label}): rendered "NaN"`);
    console.log(`  ok  sync panel, ${label} (${html.length} bytes)`);
  } catch (error) {
    problems.push(`sync panel (${label}): threw ${error?.message}`);
    console.log(`  FAIL sync panel, ${label}: ${error?.message}`);
  }
}

// The disabled section must render one row per disabled id, with the exact
// upstream model id and an enable action.
try {
  const html = renderToString(
    h(Disabled, {
      disabledIds: ["gpt-4o", "claude-opus-4.5"],
      providerName: "OpenAI",
      catalog: [],
      testResults: { "gpt-4o": "error" },
      testErrors: { "gpt-4o": "upstream 503" },
      modelAliases: {},
      onEnable: () => {},
      onRetest: () => {},
    })
  );
  const rows = (html.match(/Enable/g) || []).length;
  console.log(`  ok  disabled section (${html.length} bytes, ${rows} enable actions)`);
  // Strip React's SSR text separators, then assert on the plain text content.
  const text = html.replaceAll("<!-- -->", "");
  if (!text.includes("OpenAI/gpt-4o")) {
    problems.push("disabled section: missing the provider-qualified model id");
  }
  if (!html.includes("upstream 503")) {
    problems.push("disabled section: missing the failure reason");
  }
  if (rows < 2) problems.push("disabled section: expected an enable action per row");
} catch (error) {
  problems.push(`disabled section: threw ${error?.message}`);
  console.log(`  FAIL disabled section: ${error?.message}`);
}

// The sync panel's collapsed state must be ONE row of controls with no panel
// body leaking, and expanding must reveal it. This is the requirement that the
// panel renders nothing but the row when collapsed — checked by asserting the
// body markers are absent, since a leftover status line or empty container is
// exactly the regression.
const SYNC_ROW_CONTROLS = [
  "Auto-fetch upstream models",
  "Auto-Sync",
  "Auto-Add Models",
  "Sync now",
  "Import from /models",
  "Clear All Models",
];
const SYNC_BODY_MARKERS = [
  "Last sync:",
  "Discovered models",
  "Finished in",
  "Current:",
];

function renderSyncPanel(props) {
  return renderToString(h(SyncPanel, { onAddModel: () => {}, ...props }));
}

for (const [label, providerId, supportsDiscovery] of [
  ["discovery-capable", "openai", true],
  ["no discovery", "sdwebui", false],
]) {
  const common = {
    providerId,
    providerStorageAlias: "oc",
    connections: [{ id: "c1", isActive: true }],
    modelAliases: {},
    hardcodedIds: [],
    testResults: {},
    disabledIds: [],
    onCatalogChanged: () => {},
  };

  const collapsed = renderSyncPanel(common);
  const collapsedText = collapsed.replaceAll("<!-- -->", "");
  for (const control of SYNC_ROW_CONTROLS) {
    // A provider with no upstream catalog must NOT be offered controls that
    // can only fail; the explanation replaces them. Every control is expected
    // exactly when the provider supports discovery or import.
    const expected = supportsDiscovery || control === "Auto-Add Models";
    if (expected && !collapsedText.includes(control)) {
      problems.push(`sync panel (${label}, collapsed): missing control "${control}"`);
    }
    if (!expected && collapsedText.includes(control)) {
      problems.push(`sync panel (${label}, collapsed): offered unsupported control "${control}"`);
    }
  }
  if (!collapsedText.includes("Expand")) {
    problems.push(`sync panel (${label}): missing the expand/collapse control`);
  }
  for (const marker of SYNC_BODY_MARKERS) {
    if (collapsedText.includes(marker)) {
      problems.push(`sync panel (${label}, collapsed): leaked panel body marker "${marker}"`);
    }
  }

  const expanded = renderSyncPanel({ ...common, defaultOpen: true });
  const expandedText = expanded.replaceAll("<!-- -->", "");
  if (!expandedText.includes("Last sync:")) {
    problems.push(`sync panel (${label}, expanded): missing the last-sync information`);
  }
  if (!expandedText.includes("Collapse")) {
    problems.push(`sync panel (${label}, expanded): expand control did not become Collapse`);
  }
  if (expanded.length <= collapsed.length) {
    problems.push(`sync panel (${label}): expanding did not add content`);
  }
}

// A provider with no upstream catalog must explain itself instead of offering a
// control that can only fail.
try {
  const html = renderToString(
    h(SyncPanel, {
      providerId: "sdwebui",
      providerStorageAlias: "sdwebui",
      connections: [],
      modelAliases: {},
      hardcodedIds: [],
      testResults: {},
      disabledIds: [],
      onAddModel: () => {},
    })
  );
  const text = html.replaceAll("<!-- -->", "");
  if (!/does not expose an upstream model catalog/.test(text)) {
    problems.push("sync panel (unsupported provider): missing the explanation");
  }
  if (text.includes("Sync now")) {
    problems.push("sync panel (unsupported provider): offered a Sync now button that cannot work");
  }
} catch (error) {
  problems.push(`sync panel (unsupported): threw ${error?.message}`);
}

// The provider-scoped section must still show the CODE-DEFINED catalogue. This
// is the regression guard for the bug where scoping passed an empty provider
// list, so the static-catalog loop emitted nothing and every provider page
// rendered zero built-in models.
try {
  const Section = (await import(new URL("shared/components/AvailableModelsSection.jsx", SRC))).default;
  const html = renderToString(h(Section, { storageAlias: "ag", headerTitle: "Available Models" }));
  const text = html.replaceAll("<!-- -->", "");
  const cards = (html.match(/Compatibility/g) || []).length;
  console.log(`  ok  available models scoped to ag (${cards} cards)`);
  if (cards === 0) {
    problems.push("provider-scoped section: rendered no built-in models (the empty-provider-list regression)");
  }
  // Spot-check real antigravity ids from the shared catalogue.
  for (const id of ["ag/gemini-3-flash-agent", "ag/claude-sonnet-4-6", "ag/gemini-pro-agent"]) {
    if (!text.includes(id)) {
      problems.push(`provider-scoped section: missing built-in model ${id}`);
    }
  }
  // A model belonging to another provider must never leak in.
  if (/openai\/gpt-4o|cx\/gpt-5/.test(text)) {
    problems.push("provider-scoped section: leaked models from other providers");
  }
} catch (error) {
  problems.push(`provider-scoped section: threw ${error?.message}`);
  console.log(`  FAIL provider-scoped section: ${error?.message}`);
}

// The Add Model modal must offer every capability and compose the registered id
// the same way the backend does. Rendering it catches a modal that silently
// lost capabilities or shows only a single "type" selector.
try {
  const AddModel = (await import(new URL("pages/providers/[id]/AddCustomModelModal.jsx", SRC))).default;
  const html = renderToString(
    h(AddModel, {
      isOpen: true,
      providerAlias: "ag",
      providerDisplayAlias: "ag",
      allowedKinds: ["llm"],
      onSave: () => {},
      onClose: () => {},
    })
  );
  const text = html.replaceAll("<!-- -->", "");
  console.log(`  ok  add model modal (${html.length} bytes)`);

  for (const label of [
    "Chat", "Image gen", "Vision", "Video gen", "Audio",
    "Speech→text", "Text→speech", "Embeddings", "Rerank", "Custom",
  ]) {
    if (!text.includes(label)) {
      problems.push(`add model modal: missing capability "${label}"`);
    }
  }
  // The prefix must be an editable input of its own, not baked into the model id.
  if (!/aria-label="Provider prefix for this model"/.test(html)) {
    problems.push("add model modal: no editable provider prefix field");
  }
  for (const control of ["Test Model", "Add Model", "Display name", "Operation settings"]) {
    if (!text.includes(control)) {
      problems.push(`add model modal: missing "${control}"`);
    }
  }
  // The registered-id preview must be present. React's SSR text separators are
  // already stripped into `text` above, so this is a plain substring check.
  if (!text.includes("Will be registered as:")) {
    problems.push("add model modal: does not show the registered id preview");
  }
  if (!/<code[^>]*>[^<]*\/[^<]*<\/code>/.test(html)) {
    problems.push("add model modal: registered id preview is not a <prefix>/<modelId> code element");
  }
} catch (error) {
  problems.push(`add model modal: threw ${error?.message}`);
  console.log(`  FAIL add model modal: ${error?.message}`);
}

// Empty disabled list must render nothing at all (no empty container).
try {
  const html = renderToString(h(Disabled, { disabledIds: [], providerName: "X" }));
  if (html.trim() !== "") {
    problems.push("disabled section: rendered a container with no rows");
  }
  console.log("  ok  disabled section (empty renders nothing)");
} catch (error) {
  problems.push(`disabled section (empty): threw ${error?.message}`);
}

console.log("");
if (problems.length) {
  console.log("PROBLEMS:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("all server-render checks passed");
