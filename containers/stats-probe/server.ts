import { serve } from "@hono/node-server";
import app from "./app.ts";

const server = serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 8080 }, () => {
  console.log("container_probe_ready:8080");
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
