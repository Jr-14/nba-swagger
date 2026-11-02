import { serve } from "@hono/node-server";
import { createServer } from "vite";
import app from "../containers/proxy/app.ts";

const port = Number(process.env.PROXY_PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PROXY_PORT");

const proxy = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
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
proxy.on("error", (error) => { console.error(error.message); void stop(1); });
try {
  vite = await createServer({ configFile: "vite.config.mjs", root: "src", server: { host: "0.0.0.0" } });
  await vite.listen();
  console.log(`Node proxy: http://127.0.0.1:${port}`);
  vite.printUrls();
} catch (error) {
  console.error(error.message);
  await stop(1);
}
