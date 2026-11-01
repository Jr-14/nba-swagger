import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Keep the familiar command while running the static Pages site and proxy
// Worker separately, just as they are deployed in production.
const pagesPort = Number(process.env.PAGES_PORT ?? 8788);
const workerPort = Number(process.env.WORKER_PORT ?? 8787);
if (
  ![pagesPort, workerPort].every((port) => Number.isInteger(port) && port > 0 && port < 65536) ||
  pagesPort === workerPort
) {
  throw new Error("PAGES_PORT and WORKER_PORT must be distinct valid port numbers");
}
process.env.VITE_PROXY_URL = `http://localhost:${workerPort}/api`;
const { build } = await import("vite");
await build({
  configFile: "vite.config.mjs",
  root: "src",
  build: { outDir: "../dist", emptyOutDir: true },
});

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const { bin } = JSON.parse(readFileSync(wranglerPackage, "utf8"));
const wrangler = resolve(dirname(wranglerPackage), bin.wrangler);
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
  for (const child of children) child.kill("SIGTERM");
}
for (const args of commands) {
  const child = spawn(process.execPath, [wrangler, ...args], { stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
