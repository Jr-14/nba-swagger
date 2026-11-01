import { Container } from "@cloudflare/containers";
import { Hono, type Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";

export class NbaStatsProbe extends Container {
  defaultPort = 8080;
  sleepAfter = "1m";
  enableInternet = true;
  // No outbound HTTP/HTTPS interception: Node must connect to NBA directly.
}

type Bindings = {
  PROBE: DurableObjectNamespace<NbaStatsProbe>;
  PROBE_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

async function forwardToContainer(c: Context<{ Bindings: Bindings }>, path: "/health" | "/probe") {
  const response = await c.env.PROBE.getByName("single-probe").fetch(`http://container${path}`);
  if (!response.ok && !(response.headers.get("content-type") ?? "").includes("json")) {
    return c.json({ ok: false, error: "Container startup or routing failed; check Worker logs" }, 502);
  }
  return response;
}

app.use("*", async (c, next) => {
  if (!c.env.PROBE_TOKEN) {
    return c.json({ ok: false, error: "Probe authentication is not configured" }, 503);
  }
  return bearerAuth<{ Bindings: Bindings }>({ token: c.env.PROBE_TOKEN })(c, next);
});

app.use("*", async (c, next) => {
  if (c.req.method !== "GET") {
    c.header("Allow", "GET");
    return c.json({ ok: false, error: "Only GET is supported" }, 405);
  }
  await next();
});

app.get("/health", async (c) => {
  return forwardToContainer(c, "/health");
});

app.get("/probe", async (c) => {
  // One stable instance, no user-controlled routing, headers, or target URL.
  return forwardToContainer(c, "/probe");
});

app.notFound((c) => c.json({ ok: false, error: "Not found" }, 404));
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error(JSON.stringify({ event: "container_unavailable", errorName: error.name }));
  return c.json({ ok: false, error: "Container startup or routing failed; check Worker logs" }, 502);
});

export default app;
