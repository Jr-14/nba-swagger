import { serve } from "@hono/node-server";
import { createServer } from "vite";
import app from "../containers/proxy/app.ts";
import { parsePort } from "./ports.mjs";

// Fallback for hosts where Wrangler cannot start local containers. This keeps
// the Node proxy path available, but it does not emulate the Worker boundary.
const uiPort = parsePort("UI_PORT", 5173);
const proxyPort = parsePort("PROXY_PORT", 8080);
if (uiPort === proxyPort) {
  throw new Error("UI_PORT and PROXY_PORT must be distinct");
}

process.env.DEV_PROXY_PORT = String(proxyPort);
const proxy = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: proxyPort });
let vite;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  proxy.closeAllConnections?.();
  proxy.close();
  await vite?.close();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
proxy.on("error", (error) => {
  console.error(error.message);
  void stop(1);
});

try {
  vite = await createServer({
    configFile: "vite.config.mjs",
    root: "src",
    server: { host: "0.0.0.0", port: uiPort, strictPort: true },
  });
  await vite.listen();
  console.log(`Direct Node proxy: http://127.0.0.1:${proxyPort}`);
  vite.printUrls();
} catch (error) {
  console.error(error.message);
  await stop(1);
}
