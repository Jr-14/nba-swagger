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
    RESPONSE_CACHE: KVNamespace;
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
  const route = resolveUpstream(original);
  if (route) {
    const cacheKey = `response:${original.pathname}${original.search}`;
    // KV keys are limited to 512 bytes. Oversized full path/query keys simply
    // bypass caching rather than being truncated or normalized into collisions.
    if (new TextEncoder().encode(cacheKey).byteLength <= 512) {
      try {
        const cached = await c.env.RESPONSE_CACHE.get(cacheKey, "json") as CachedResponse | null;
        if (cached && Number.isInteger(cached.status) && cached.status >= 200 && cached.status < 300 && typeof cached.body === "string") {
          JSON.parse(cached.body);
          return new Response(cached.body, {
            status: cached.status,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }
      } catch {
        // KV is an optimization: an unavailable or malformed entry is a cache miss.
      }
    }
  }

  if (original.pathname === "/health") {
    const request = new Request("http://container/health", {
      method: "GET",
      headers: { "X-Request-ID": c.get("requestId"), Accept: "application/json" },
      signal: c.req.raw.signal,
    });
    return c.env.PROXY.getByName("nba-proxy").fetch(request);
  }

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
  if (route && response.status >= 200 && response.status < 300 && isJsonContentType(response.headers.get("content-type"))) {
    const cacheKey = `response:${original.pathname}${original.search}`;
    if (new TextEncoder().encode(cacheKey).byteLength <= 512) {
      c.executionCtx.waitUntil((async () => {
        try {
          const body = await response.clone().text();
          JSON.parse(body);
          await c.env.RESPONSE_CACHE.put(cacheKey, JSON.stringify({ status: response.status, body }), { expirationTtl: route.cacheTtlSeconds });
        } catch {
          // Invalid JSON and KV write failures do not affect the origin response.
        }
      })());
    }
  }
  return response;
});

type CachedResponse = { status: number; body: string };

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

app.notFound(() => errorResponse(404, "not_found", "This API route is not enabled"));
app.onError((error, c) => {
  console.error(JSON.stringify({
    event: "proxy_container_failure", requestId: c.get("requestId"), errorName: error.name,
  }));
  return errorResponse(502, "container_unavailable", "Proxy container startup or routing failed; check Worker logs");
});

export default app;
