// Boot the PRODUCTION server build exactly like Render does (node dist/server.js
// with the alias loader) and verify: server starts, /api/health OK, UI served
// at /, and SPA fallback works. Run from project root:
//   node backend/test/prod-boot-check.manual.mjs
import { spawn } from "node:child_process";

const PORT = 3947;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = "/tmp/9r-prod-boot-" + Date.now();

const child = spawn(
  process.execPath,
  ["--loader", "./bin/alias-loader.mjs", "dist/server.js"],
  {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR,
      NODE_ENV: "production",
      JWT_SECRET: "bootcheck",
      API_KEY_SECRET: "bootcheck",
      INITIAL_PASSWORD: "bootcheck",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let bootLog = "";
child.stdout.on("data", (d) => { bootLog += d; });
child.stderr.on("data", (d) => { bootLog += d; });

const deadline = Date.now() + 30_000;
async function waitUntil(fn, label) {
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`BOOT CHECK FAILED at step: ${label}\n--- server log ---\n${bootLog}`);
  child.kill("SIGKILL");
  process.exit(1);
}

const fetchOk = async (path, needle) => {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  return res.ok && text.includes(needle) ? { status: res.status } : null;
};

await waitUntil(
  async () => (await fetch(`${BASE}/api/health`)).ok,
  "server did not come up"
);

// 1. Health endpoint
const health = await (await fetch(`${BASE}/api/health`)).json();
console.log("health:", JSON.stringify(health));

// 2. Root URL serves the SPA shell (the UI users see)
const index = await fetch(`${BASE}/`);
const indexBody = await index.text();
console.log("GET / :", index.status, "| serves UI:", indexBody.includes("<div id=\"root\">") || indexBody.includes("<script"));

// 3. SPA fallback for a client-side route
const spa = await fetch(`${BASE}/providers`);
console.log("GET /providers (SPA fallback):", spa.status);

// 4. No redirect away from the UI
console.log("no redirect on / :", !index.redirected, index.url === `${BASE}/` ? "" : `→ ${index.url}`);

const ok = health.status === "ok" && index.status === 200 && !index.redirected;
console.log(ok ? "\nPROD BOOT CHECK: PASS" : "\nPROD BOOT CHECK: FAIL");
child.kill("SIGKILL");
process.exit(ok ? 0 : 1);
