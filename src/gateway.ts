import { Hono } from "hono";
import { cors } from "hono/cors";
import type { NbaProxy } from "./worker.ts";
import { errorResponse } from "../shared/http.ts";
import { resolveUpstream } from "../shared/routes.ts";
import { MAX_QUERY_LENGTH } from "../shared/proxy-config.ts";

type Environment = {
  Bindings: {
    PROXY: DurableObjectNamespace<NbaProxy>;
    RATE_LIMITER: RateLimit;
    ALLOWED_ORIGIN: string;
  };
  Variables: { requestId: string };
};

const app = new Hono<Environment>();

app.use("*", cors({
  origin: (origin, c) => origin === c.env.ALLOWED_ORIGIN ? origin : null,
  allowMethods: ["GET"],
  allowHeaders: ["Accept"],
  exposeHeaders: ["X-Request-ID"],
  maxAge: 600,
}));

app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  c.header("X-Request-ID", c.get("requestId"));
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET") {
    return errorResponse(405, "method_not_allowed", "Only GET is supported", { allow: "GET" });
  }
  const url = new URL(c.req.url);
  if (url.search.length > MAX_QUERY_LENGTH) {
    return errorResponse(414, "query_too_large", "Query string exceeds the size limit");
  }
  // Reject invalid routes before waking a paid container. Both layers share
  // this allowlist; neither duplicates the OpenAPI parameter schema.
  if (url.pathname !== "/health" && !resolveUpstream(url)) return c.notFound();

  const limit = await c.env.RATE_LIMITER.limit({
    key: c.req.header("CF-Connecting-IP") ?? "local",
  });
  if (!limit.success) {
    return errorResponse(429, "rate_limited", "Too many requests; try again later", { "retry-after": "60" });
  }
  await next();
});

app.get("*", async (c) => {
  const original = new URL(c.req.url);
  const target = new URL("http://container");
  target.pathname = original.pathname;
  target.search = original.search;
  // No browser credentials, cookies, origin, or arbitrary headers enter the
  // container. The Node service adds its own headers for the NBA request.
  const request = new Request(target, {
    method: "GET",
    headers: { "X-Request-ID": c.get("requestId"), Accept: "application/json" },
    signal: c.req.raw.signal,
  });
  const response = await c.env.PROXY.getByName("nba-proxy").fetch(request);
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
    void response.body?.cancel().catch(() => {});
    return errorResponse(502, "container_unavailable", "Proxy container returned a non-JSON response; check Worker logs");
  }
  return response;
});

app.notFound(() => errorResponse(404, "not_found", "This API route is not enabled"));
app.onError((error, c) => {
  console.error(JSON.stringify({
    event: "proxy_container_failure", requestId: c.get("requestId"), errorName: error.name,
  }));
  return errorResponse(502, "container_unavailable", "Proxy container startup or routing failed; check Worker logs");
});

export default app;
