import { parsePort } from "./ports.mjs";
import { spawnWrangler } from "./wrangler.mjs";

// Build the exact static Pages output, then emulate both production pieces:
// `wrangler pages dev` for the site and `wrangler dev` for the Worker/container.
const pagesPort = parsePort("PAGES_PORT", 8788);
const workerPort = parsePort("WORKER_PORT", 8787);
if (pagesPort === workerPort) {
  throw new Error("PAGES_PORT and WORKER_PORT must be distinct");
}

process.env.LOCAL_PROXY_URL = `http://localhost:${workerPort}/api`;
const { build } = await import("vite");
await build({
  configFile: "vite.config.mjs",
  root: "src",
  build: { outDir: "../dist", emptyOutDir: true },
});

const commands = [
  ["dev", "--config", "wrangler.worker.jsonc", "--port", String(workerPort),
    "--var", `ALLOWED_ORIGIN:http://localhost:${pagesPort}`],
  ["pages", "dev", "dist", "--port", String(pagesPort)],
];
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
for (const args of commands) {
  const child = spawnWrangler(args);
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
