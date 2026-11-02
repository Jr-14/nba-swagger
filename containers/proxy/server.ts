import { serve } from "@hono/node-server";
import app from "./app.ts";

const hostname = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
const server = serve({ fetch: app.fetch, hostname, port }, () => {
  console.log(`nba_proxy_ready:${port}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
