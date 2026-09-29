// Regression guard: a shared component must not reference an identifier it did
// not import.
//
// THE BUG
// AvailableModelsSection used `aggregateCapabilityRecords(...)` but only
// imported `mapCapabilityResults`. Because the call sat behind a branch that
// only runs when a model HAS per-capability test records, the missing binding
// was invisible to every check that rendered the component with empty data: the
// server-side render harness, the render-check sweep and the production build
// all passed. It threw `ReferenceError: aggregateCapabilityRecords is not
// defined` only in a real browser, with real test results, which unmounted the
// whole app and produced a blank dashboard.
//
// This is therefore a STATIC check over the real source, not a render test —
// reachability is irrelevant.
//
// METHOD
// The file is first transformed with esbuild so JSX becomes plain calls. Without
// that step, JSX *text* ("Connections (3)") is indistinguishable from a
// function call and produces noise. Identifiers are then collected from imports,
// declarations, destructuring (including the `[value, setValue]` form React
// hooks use), class methods and function parameters; anything still called but
// never bound is a free reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transform } from "esbuild";

const SRC = new URL("../src/", import.meta.url);

// Reserved words and ambient globals. A module may reference these freely; they
// are not bindings the file has to supply.
const AMBIENT = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "delete", "void",
  "new", "await", "yield", "throw", "case", "do", "else", "in", "of",
  "instanceof", "this", "super", "arguments", "function", "class", "const",
  "let", "var", "async", "import", "export", "default", "extends", "static",
  "get", "set", "try", "finally", "break", "continue", "debugger", "with",
  "window", "document", "console", "fetch", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "AbortController", "FormData", "Blob", "File", "Headers", "Request",
  "Response", "URL", "URLSearchParams", "location", "history", "navigator",
  "globalThis", "process", "localStorage", "sessionStorage", "crypto",
  "performance", "structuredClone", "TextEncoder", "TextDecoder", "EventSource",
  "IntersectionObserver", "ResizeObserver", "matchMedia", "Image", "Worker",
  "alert", "confirm", "prompt", "open", "close", "print", "scrollTo", "focus",
  "Math", "JSON", "Object", "Array", "String", "Number", "Boolean", "Date",
  "Error", "TypeError", "RangeError", "Promise", "Set", "Map", "WeakMap",
  "Symbol", "RegExp", "Intl", "BigInt", "isNaN", "parseInt", "parseFloat",
  "undefined", "NaN", "Infinity", "React", "jsx", "jsxs", "Fragment", "_jsx",
  "_jsxs", "_Fragment",
]);

async function compile(rel) {
  const source = readFileSync(new URL(rel, SRC), "utf8");
  const { code } = await transform(source, {
    loader: rel.endsWith(".tsx") ? "tsx" : rel.endsWith(".ts") ? "ts" : "jsx",
    format: "esm",
    target: "esnext",
    jsx: "automatic",
    sourcefile: rel,
  });
  return code;
}

function collectBindings(source) {
  const bound = new Set(AMBIENT);

  for (const m of source.matchAll(/import\s+([^;]+?)\s+from\s*["'][^"']+["']/g)) {
    const clause = m[1];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) bound.add(name);
      }
    }
    const def = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").replace(/^\*\s*as\s*/, "").trim();
    if (def) bound.add(def);
    const star = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (star) bound.add(star[1]);
  }

  for (const m of source.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    bound.add(m[1]);
  }
  // Object and array destructuring, including the React `[value, setValue]` form.
  for (const m of source.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=]/)[0].replace(/^\.\.\./, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
    }
  }
  for (const m of source.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const name = (t.includes(":") ? t.split(":")[1] : t).replace(/=.*$/, "").trim().replace(/^\.\.\./, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
    }
  }
  // Function/method parameters and arrow params.
  for (const m of source.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/[:=]/)[0].replace(/^\.\.\./, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) bound.add(name);
    }
  }
  // Class method names: `name(...) {` at the start of a line inside a class,
  // including `static name(...)`.
  for (const m of source.matchAll(/^\s{2,}(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) {
    bound.add(m[1]);
  }
  for (const m of source.matchAll(/^\s{2,}static\s+([A-Za-z_$][\w$]*)/gm)) {
    bound.add(m[1]);
  }
  // Class fields holding arrow functions: `name = (...) =>`
  for (const m of source.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*=\s*(?:\(|async)/gm)) {
    bound.add(m[1]);
  }
  for (const m of source.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*=/gm)) {
    bound.add(m[1]);
  }
  return bound;
}

function stripLiterals(source) {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
      // Regex literals. A `/` opens a regex (rather than dividing) when the
      // previous significant character is one of these; without this a pattern
      // like /\b(sk|pk|key)/ is misread as a call to `b`.
      .replace(/([([{=,:;!?&|+\-*%~^<>]|\breturn|\bcase|\btypeof|\bin|\bof)\s*\/((?:\\.|[^/\\\n])+)\/[gimsuy]*/g, "$1 /__REGEX__/")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  );
}

function findUnboundCalls(source, bound) {
  const stripped = stripLiterals(source);
  const out = [];
  // A call is `name(` not preceded by `.` or a word char, and not a keyword.
  for (const m of stripped.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!bound.has(name)) out.push(name);
  }
  return [...new Set(out)];
}

const TARGETS = [
  "shared/components/AvailableModelsSection.jsx",
  "shared/components/ModelCompatibilityModal.jsx",
  "shared/components/ErrorBoundary.jsx",
  "shared/components/Sidebar.jsx",
  "shared/utils/modelCatalog.js",
  "shared/utils/clientErrorReporting.js",
  "shared/utils/cachedJson.js",
  "pages/providers/[id]/page.jsx",
  "pages/providers/[id]/ModelSyncPanel.jsx",
  "pages/providers/[id]/AddCustomModelModal.jsx",
  "pages/providers/[id]/DisabledModelsSection.jsx",
  "pages/models/page.jsx",
  "App.tsx",
];

for (const rel of TARGETS) {
  test(`${rel} calls only bound identifiers`, async () => {
    const code = await compile(rel);
    const bound = collectBindings(code);
    const unbound = findUnboundCalls(code, bound);
    assert.deepEqual(
      unbound,
      [],
      `${rel} calls identifiers it never imports or defines: ${unbound.join(", ")}`
    );
  });
}
