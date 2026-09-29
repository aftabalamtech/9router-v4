// Resolver hook that teaches `node --test` the app's `@/` path alias.
//
// The frontend sources use the `@/` alias everywhere (configured in Vite), but
// plain Node does not know it. Without this, any test that imports real app
// code fails to resolve — which is why the existing frontend tests re-implement
// the logic they mean to test. A mirror can drift from the implementation and
// pass while the real code is broken, so this hook lets the test suite import
// the actual modules instead.
//
// Resolution is intentionally strict: `@/x` maps to <frontend>/src/x, exactly
// as Vite's `resolve.alias` does. Any other specifier is passed through to the
// default resolver unchanged, so real package imports still work.
//
// Loaded via `node --import ./test/alias-resolver.mjs --test`.
import { register } from "node:module";

register("./alias-resolver-impl.mjs", import.meta.url);
