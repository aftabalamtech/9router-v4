/**
 * Tests for the dashboard's live connection-event client.
 *
 * Pins: one shared EventSource per tab regardless of subscriber count,
 * dedupe of stale/duplicate revisions, revision-progress notification (a tab
 * that missed events learns the server moved ahead), and socket teardown when
 * the last subscriber unsubscribes.
 */
import test from "node:test";
import assert from "node:assert/strict";

class MockEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.listeners = new Map();
    this.closed = false;
    MockEventSource.instances.push(this);
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  emit(name, event) {
    if (name === "message" && this.onmessage) this.onmessage(event);
    for (const fn of this.listeners.get(name) || []) fn(event);
  }
  close() {
    this.closed = true;
  }
}

async function loadFresh() {
  const mod = await import(`../src/shared/utils/connectionEvents.js?v=${Math.random()}`);
  return mod;
}

function sseEvent(data, eventName) {
  return { data: JSON.stringify(data), eventName };
}

test("subscribers share one EventSource and all receive events", async () => {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource;
  globalThis.document = { visibilityState: "visible", addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  const { subscribeConnectionEvents } = await loadFresh();

  const a = [];
  const b = [];
  const unsubA = subscribeConnectionEvents({ onEvent: (e) => a.push(e) });
  const unsubB = subscribeConnectionEvents({ onEvent: (e) => b.push(e) });
  assert.equal(MockEventSource.instances.length, 1, "one socket per tab, not per subscriber");

  const es = MockEventSource.instances[0];
  es.onopen?.();
  es.emit("message", sseEvent({ type: "updated", id: "c1", provider: "p", revision: 1 }));

  assert.deepEqual(a, [{ type: "updated", id: "c1", provider: "p", revision: 1 }]);
  assert.deepEqual(b, a);
  unsubA();
  unsubB();
});

test("stale or duplicate revisions do not re-notify; a newer revision does", async () => {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource;
  globalThis.document = { visibilityState: "visible", addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  const { subscribeConnectionEvents } = await loadFresh();

  const revisions = [];
  const unsub = subscribeConnectionEvents({ onRevision: (rev) => revisions.push(rev) });
  const es = MockEventSource.instances[0];
  es.emit("revision", sseEvent({ revision: 5 }, "revision"));
  es.emit("revision", sseEvent({ revision: 5 }, "revision")); // duplicate
  es.emit("revision", sseEvent({ revision: 3 }, "revision")); // stale
  es.emit("revision", sseEvent({ revision: 7 }, "revision")); // progress

  assert.deepEqual(revisions, [5, 7]);
  unsub();
});

test("message events carry the revision forward even without a revision event", async () => {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource;
  globalThis.document = { visibilityState: "visible", addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  const { subscribeConnectionEvents } = await loadFresh();

  const events = [];
  const unsub = subscribeConnectionEvents({ onEvent: (e) => events.push(e) });
  const es = MockEventSource.instances[0];
  es.emit("message", sseEvent({ type: "updated", id: "c2", revision: 10 }));
  es.emit("message", sseEvent({ type: "updated", id: "c2", revision: 10 })); // dup dropped
  assert.equal(events.length, 1);
  unsub();
});

test("last unsubscribe closes the socket; resubscribe reconnects with since=", async () => {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource;
  globalThis.document = { visibilityState: "visible", addEventListener() {} };
  globalThis.window = { addEventListener() {} };
  const { subscribeConnectionEvents } = await loadFresh();

  const unsub1 = subscribeConnectionEvents({ onEvent: () => {} });
  const es1 = MockEventSource.instances[0];
  es1.onopen?.();
  es1.emit("message", sseEvent({ type: "updated", id: "x", revision: 42 }));
  unsub1();
  assert.equal(es1.closed, true, "socket closes when the last subscriber leaves");

  const unsub2 = subscribeConnectionEvents({ onEvent: () => {} });
  const es2 = MockEventSource.instances[1];
  assert.ok(es2.url.includes("since=42"), "reconnect replays from the last seen revision");
  unsub2();
});
