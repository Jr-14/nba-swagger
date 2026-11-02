import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { parsePort } from "./ports.mjs";
import { spawnWrangler } from "./wrangler.mjs";

function warnAboutLocalContainers() {
  if (process.platform !== "linux") return;
  try {
    if (readFileSync("/proc/sys/net/ipv4/conf/all/src_valid_mark", "utf8").trim() !== "1") return;
    console.warn(
      "Warning: net.ipv4.conf.all.src_valid_mark=1 can prevent local Wrangler containers from starting.\n" +
      "See workerd issue #6860. If startup fails, use `pnpm dev:node` or plain Docker.",
    );
  } catch {
    // The sysctl is not available; Wrangler can still try to start normally.
  }
}

const uiPort = parsePort("UI_PORT", 5173);
const workerPort = parsePort("WORKER_PORT", 8787);
if (uiPort === workerPort) {
  throw new Error("UI_PORT and WORKER_PORT must be distinct");
}

const uiOrigin = process.env.DEV_ORIGIN ?? `http://localhost:${uiPort}`;
try {
  new URL(uiOrigin);
} catch {
  throw new Error("DEV_ORIGIN must be a valid URL");
}

// Vite serves the UI with HMR and forwards API traffic to the Worker. Wrangler
// emulates the Worker, Durable Object, rate limiter, and Docker container.
warnAboutLocalContainers();
process.env.DEV_PROXY_PORT = String(workerPort);
const worker = spawnWrangler([
  "dev",
  "--config",
  "wrangler.worker.jsonc",
  "--port",
  String(workerPort),
  "--var",
  `ALLOWED_ORIGIN:${uiOrigin}`,
]);

let vite;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
  await vite?.close();
}

worker.on("error", (error) => {
  console.error(`Could not start Wrangler: ${error.message}`);
  void stop(1);
});
worker.on("exit", (code, signal) => {
  if (stopping) return;
  console.error(`Wrangler exited${signal ? ` from ${signal}` : ""}${code === null ? "" : ` with code ${code}`}`);
  void stop(code ?? 1);
});
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

try {
  vite = await createServer({
    configFile: "vite.config.mjs",
    root: "src",
    server: { host: "0.0.0.0", port: uiPort, strictPort: true },
  });
  await vite.listen();
  console.log(`Wrangler gateway: http://127.0.0.1:${workerPort}`);
  console.log("Changed container source? Press r in the Wrangler session to rebuild it.");
  vite.printUrls();
} catch (error) {
  console.error(error.message);
  await stop(1);
}
