import { Hono } from "hono";
import { NBA_BROWSER_HEADERS } from "../../shared/nba-headers.ts";
import { errorResponse, jsonResponse } from "../../shared/http.ts";
import { resolveUpstream, type UpstreamRoute } from "../../shared/routes.ts";
import { UPSTREAM_TIMEOUT_MS, MAX_RESPONSE_BYTES, MAX_QUERY_LENGTH, MAX_IN_FLIGHT } from "../../shared/proxy-config.ts";

const statsHeaders = {
  ...NBA_BROWSER_HEADERS,
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.5",
  "accept-encoding": "identity",
  connection: "close",
};

const liveHeaders = {
  accept: "application/json",
  referer: "https://www.nba.com/",
  "user-agent": statsHeaders["user-agent"],
  "accept-encoding": "identity",
  connection: "close",
};

async function readJsonBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Upstream returned an empty response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Upstream response exceeded the size limit");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readErrorPreview(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const limit = 2_048;
  const bytes = new Uint8Array(limit);
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        while (length < limit) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = value.subarray(0, limit - length);
          bytes.set(chunk, length);
          length += chunk.byteLength;
        }
        return new TextDecoder().decode(bytes.subarray(0, length));
      })(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("[response preview timed out]"), 2_000);
      }),
    ]);
  } catch {
    return "[response preview unavailable]";
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

async function proxyUpstream(route: UpstreamRoute, endpoint: string, requestId: string, signal: AbortSignal): Promise<Response> {
  const startedAt = Date.now();
  let phase = "fetch";
  try {
    const upstream = await fetch(route.url, {
      headers: route.family === "stats" ? statsHeaders : liveHeaders,
      signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      redirect: "manual",
    });

    const contentType = upstream.headers.get("content-type") ?? "";
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    phase = "body";
    // NBA's Live CDN serves some .json documents as text/plain. They must still
    // pass bounded JSON parsing; this does not accept HTML or arbitrary text.
    const jsonBodyExpected = mediaType === "application/json" || mediaType.endsWith("+json") ||
      (route.family === "live" && mediaType === "text/plain");
    if (!jsonBodyExpected) {
      const bodyPreview = await readErrorPreview(upstream);
      const location = upstream.headers.get("location");
      let redirectDestination: string | undefined;
      if (location) {
        try {
          const redirectUrl = new URL(location, route.url);
          redirectDestination = redirectUrl.origin + redirectUrl.pathname;
        } catch {
          redirectDestination = "[invalid redirect URL]";
        }
      }
      console.error(JSON.stringify({
        event: "nba_upstream_non_json",
        requestId,
        endpoint,
        status: upstream.status,
        upstreamHost: route.url.hostname,
        contentType,
        upstreamServer: upstream.headers.get("server"),
        upstreamRay: upstream.headers.get("cf-ray"),
        redirectDestination,
        bodyPreview,
        durationMs: Date.now() - startedAt,
      }));
      return errorResponse(
        502,
        "invalid_upstream_response",
        "NBA upstream returned a non-JSON response",
        { "x-request-id": requestId },
      );
    }

    const body = await readJsonBody(upstream);
    console.log(JSON.stringify({
      event: "nba_upstream_response",
      requestId,
      endpoint,
      status: upstream.status,
      durationMs: Date.now() - startedAt,
    }));
    const headers: Record<string, string> = { "x-request-id": requestId };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["retry-after"] = retryAfter;
    return jsonResponse(upstream.status, body, headers);
  } catch (error) {
    const isTimeout = error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    const status = isTimeout ? 504 : 502;
    console.error(JSON.stringify({
      event: "nba_upstream_failure",
      requestId,
      endpoint,
      status,
      phase,
      errorName: error instanceof Error ? error.name : "UnknownError",
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      upstreamHost: route.url.hostname,
      durationMs: Date.now() - startedAt,
    }));
    return isTimeout
      ? errorResponse(504, "upstream_timeout", "NBA upstream request timed out", {
          "x-request-id": requestId,
        })
      : errorResponse(
          502,
          "upstream_error",
          "NBA upstream returned an invalid or unavailable response",
          { "x-request-id": requestId },
        );
  }
}

const app = new Hono<{ Variables: { requestId: string } }>();
let inFlight = 0;

app.use("*", async (c, next) => {
  const suppliedId = c.req.header("X-Request-ID");
  const requestId = suppliedId && /^[0-9a-f-]{36}$/i.test(suppliedId)
    ? suppliedId : crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-ID", requestId);
  c.header("Cache-Control", "no-store");
  // Reject HEAD too: it must not trigger an upstream GET.
  if (c.req.method !== "GET") {
    return errorResponse(405, "method_not_allowed", "Only GET is supported", {
      allow: "GET",
    });
  }

  if (new URL(c.req.url).search.length > MAX_QUERY_LENGTH) {
    return errorResponse(414, "query_too_large", "Query string exceeds the size limit");
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true, runtime: "node", nodeVersion: process.versions.node }));

app.get("/api/*", async (c) => {
  const requestUrl = new URL(c.req.url);
  const route = resolveUpstream(requestUrl);
  if (!route) return c.notFound();

  if (inFlight >= MAX_IN_FLIGHT) {
    return errorResponse(503, "proxy_busy", "Proxy is busy; retry shortly", { "retry-after": "1" });
  }
  inFlight++;
  try {
    return await proxyUpstream(route, requestUrl.pathname.slice("/api/".length), c.get("requestId"), c.req.raw.signal);
  } finally {
    inFlight--;
  }
});

app.notFound(() => errorResponse(404, "not_found", "This API route is not enabled"));

app.onError(() => errorResponse(500, "internal_error", "The API gateway encountered an error"));

export default app;
