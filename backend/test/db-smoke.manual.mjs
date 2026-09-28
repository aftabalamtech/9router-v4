// Live SQLite smoke test: init → provider node + connections → restart persistence.
// Run from the project root: node backend/test/db-smoke.manual.mjs
process.env.DATA_DIR = "/tmp/9r-smoke-" + Date.now();
process.env.JWT_SECRET = "smoke";
process.env.API_KEY_SECRET = "smoke";

const ROOT = process.cwd();
const { initDb, createProviderNode, createProviderConnection, getProviderConnections } = await import(`${ROOT}/backend/src/lib/db/index.js`);
const { getMeta } = await import(`${ROOT}/backend/src/lib/db/helpers/metaStore.js`);

await initDb();
console.log("init: OK");

const node = await createProviderNode({
  id: "openai-compatible-chat-11111111-2222-3333-4444-555555555555",
  type: "openai-compatible", prefix: "xk", apiType: "chat",
  baseUrl: "https://api.xkiro.example/v1", name: "Xkiro",
});
console.log("node created ok:", node.id === "openai-compatible-chat-11111111-2222-3333-4444-555555555555", "name:", node.name);

await createProviderConnection({
  provider: node.id, authType: "apikey", name: "Main", apiKey: "sk-main-secret", isActive: true,
  providerSpecificData: { prefix: "xk", apiType: "chat", baseUrl: node.baseUrl, nodeName: "Xkiro" },
});
await createProviderConnection({
  provider: node.id, authType: "apikey", name: "Backup", apiKey: "sk-backup-secret", isActive: true,
  providerSpecificData: { prefix: "xk", apiType: "chat", baseUrl: node.baseUrl, nodeName: "Xkiro" },
});
const conns = await getProviderConnections({ provider: node.id });
console.log("connections:", conns.length, conns.map(c => `${c.name}(active=${c.isActive},key=${c.apiKey ? "stored" : "MISSING"})`).join(", "));
console.log("schemaVersion:", await getMeta("schemaVersion"));

// Simulate restart: fresh process, same DATA_DIR.
// Give the sql.js debounced write (100ms) a chance to flush, like a real
// process continuing to run / shutting down gracefully would.
await new Promise((r) => setTimeout(r, 400));
const { execFileSync } = await import("node:child_process");
const checkScript = `
process.env.DATA_DIR = ${JSON.stringify(process.env.DATA_DIR)};
process.env.JWT_SECRET = "smoke";
process.env.API_KEY_SECRET = "smoke";
const { getProviderNodes, getProviderConnections } = await import(${JSON.stringify(`${ROOT}/backend/src/lib/db/index.js`)});
const { getMeta } = await import(${JSON.stringify(`${ROOT}/backend/src/lib/db/helpers/metaStore.js`)});
const nodes = await getProviderNodes();
const node = nodes[0];
const conns = await getProviderConnections({ provider: node.id });
console.log(JSON.stringify({
  nodes: nodes.length,
  name: node.name,
  conns: conns.length,
  names: conns.map(c => c.name).sort(),
  keysStored: conns.every(c => !!c.apiKey),
  schemaVersion: await getMeta("schemaVersion"),
}));
`;
const out = execFileSync(process.execPath, ["--input-type=module", "-e", checkScript], { encoding: "utf8" });
console.log("after restart:", out.trim());
