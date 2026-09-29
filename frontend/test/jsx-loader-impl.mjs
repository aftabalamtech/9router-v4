// Loader hook that compiles the app's .jsx sources on the fly.
//
// Vite does this at build time; plain Node cannot parse JSX. This lets
// render-check.mjs execute the real page components (rather than a copy) so
// render-path bugs surface without a browser. esbuild is already a transitive
// dependency of Vite, so nothing new is installed.
//
// Only .jsx/.tsx under the app source tree are transformed; everything else is
// passed through untouched.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const APP_SRC = new URL("../src/", import.meta.url);

export async function load(url, context, nextLoad) {
  // Vite injects this as JSON; Node requires an explicit import attribute.
  if (url.endsWith("frontend/package.json")) {
    return nextLoad(url, { ...context, importAttributes: { type: "json" } });
  }
  // Stylesheets have no effect in a server render; stub them as empty modules.
  if (/\.css(\?|$)/.test(url)) {
    return { format: "module", shortCircuit: true, source: "export default {};" };
  }
  if (url.startsWith(APP_SRC.href) && /\.(jsx|tsx|ts|js)(\?|$)/.test(url) && !url.includes("?")) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const ext = url.split(".").pop();
    const { code } = await transform(source, {
      loader: ext === "ts" ? "ts" : ext === "tsx" ? "tsx" : ext === "js" ? "jsx" : "jsx",
      format: "esm",
      target: "node20",
      jsx: "automatic",
      sourcefile: url,
    });
    return { format: "module", shortCircuit: true, source: code };
  }
  return nextLoad(url, context);
}
