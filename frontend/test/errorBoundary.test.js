// Error-boundary and error-reporting behaviour.
//
// WHY: a render throw with no boundary unmounts the WHOLE React tree. That is
// how one bad page in the shared model section produced a completely blank
// dashboard — sidebar, header and navigation all gone, nothing on screen to
// explain why. These tests pin the containment and the reporting.
import { test } from "node:test";
import assert from "node:assert/strict";

import { scrubLogText } from "../../backend/src/lib/net/scrubLog.js";
import ErrorBoundary from "../src/shared/components/ErrorBoundary.jsx";

test("credentials are scrubbed from anything written to the log", () => {
  const cases = [
    ["Authorization: Bearer sk-abcdef0123456789", /\[redacted\]/],
    ["cookie: 9r_session=abc.def.ghi", /\[redacted\]/],
    ["x-api-key: 1234567890abcdef", /\[redacted\]/],
    ["failed with sk-proj-AAAABBBBCCCCDDDD", /\[redacted-key\]/],
    ["token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwiaWF0IjoxNTE2In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c", /\[redacted/],
    ["?key=supersecretvalue&x=1", /\[redacted\]/],
    ["api_key: abcdefghijkl", /\[redacted\]/],
  ];
  for (const [input, expected] of cases) {
    const out = scrubLogText(input);
    assert.match(out, expected, `expected redaction in: ${input}\n  got: ${out}`);
  }
});

test("scrubbing keeps the diagnostic value of a message", () => {
  // A log line is only useful if the non-secret part survives.
  const out = scrubLogText("HTTP 404: model not_found for ag/gemini-3-flash (Authorization: Bearer sk-xyz123456789)");
  assert.match(out, /HTTP 404/);
  assert.match(out, /model not_found/);
  assert.match(out, /ag\/gemini-3-flash/);
  assert.equal(/sk-xyz123456789/.test(out), false);
});

test("scrubbing is safe on non-strings and never throws", () => {
  for (const value of [null, undefined, 42, {}, []]) {
    const out = scrubLogText(value);
    assert.equal(typeof out, "string", `${String(value)} should produce a string`);
  }
});

test("ErrorBoundary is a class component that records the error", () => {
  // The mechanism React relies on: getDerivedStateFromError must put the error
  // into state, otherwise the boundary renders its children again and throws
  // again, which is an infinite crash loop.
  assert.equal(typeof ErrorBoundary, "function");
  assert.ok(ErrorBoundary.prototype instanceof Error === false, "boundary is a plain class, not an Error");
  assert.equal(typeof ErrorBoundary.getDerivedStateFromError, "function");

  const state = ErrorBoundary.getDerivedStateFromError(new Error("boom"));
  assert.ok(state.error instanceof Error);
  assert.equal(state.error.message, "boom");
});
