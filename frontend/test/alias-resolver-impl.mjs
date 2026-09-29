// Implementation half of the `@/` alias resolver (see alias-resolver.mjs).
// Lives in its own file because module.register() runs hooks on a separate
// thread, so it cannot close over this file's imports.
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);

// The app source omits file extensions and imports directories (Vite resolves
// both). Node needs a real FILE, so probe the usual extensions and the index
// file, in the same order Vite does, and skip directories.
const CANDIDATE_SUFFIXES = ["", ".js", ".jsx", ".mjs", "/index.js", "/index.jsx"];

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

function withExtension(url) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = new URL(url.href + suffix);
    if (isFile(candidate)) return candidate;
  }
  return url;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    return nextResolve(withExtension(new URL(specifier.slice(2), SRC)).href, context);
  }
  // Relative/absolute file specifiers inside the app are also extensionless.
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith(SRC)) {
    return nextResolve(withExtension(new URL(specifier, context.parentURL)).href, context);
  }
  return nextResolve(specifier, context);
}
