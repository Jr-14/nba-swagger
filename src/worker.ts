import { Hono } from "hono";
import { cors } from "hono/cors";
import { NBA_BROWSER_HEADERS } from "../shared/nba-headers.ts";

type Bindings = {
  ALLOWED_ORIGIN: string;
};

type ProxyEnvironment = {
  Bindings: Bindings;
};

const NBA_STATS_ORIGIN = "https://stats.nba.com";
const NBA_LIVE_ORIGIN = "https://cdn.nba.com/static/json/liveData/";
const UPSTREAM_TIMEOUT_MS = 180_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_QUERY_LENGTH = 2_048;

interface UpstreamRoute {
  url: URL;
  headers: Record<string, string>;
}

const statsHeaders = {
  ...NBA_BROWSER_HEADERS,
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.5",
};

const liveHeaders = {
  accept: "application/json",
  referer: "https://www.nba.com/",
  "user-agent": statsHeaders["user-agent"],
};

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(status, { error: { code, message } }, extraHeaders);
}

function resolveLiveUpstream(
  pathname: string,
  search: string,
): UpstreamRoute | null {
  const livePath = pathname.startsWith("/api/live/")
    ? pathname.slice("/api/live/".length)
    : null;
  if (livePath === null) return null;

  const fixedLivePaths = new Set([
    "odds/odds_todaysGames.json",
    "scoreboard/todaysScoreboard_00.json",
  ]);
  const validGamePath =
    /^boxscore\/boxscore_\d{10}\.json$/.test(livePath) ||
    /^playbyplay\/playbyplay_\d{10}\.json$/.test(livePath);

  if (!fixedLivePaths.has(livePath) && !validGamePath) return null;

  const url = new URL(livePath, NBA_LIVE_ORIGIN);
  url.search = search;
  return { url, headers: liveHeaders };
}

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

async function proxyUpstream(route: UpstreamRoute, endpoint: string): Promise<Response> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let phase = "fetch";
  try {
    const upstream = await fetch(route.url, {
      headers: route.headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "manual",
    });

    const contentType = upstream.headers.get("content-type") ?? "";
    phase = "body";
    if (!contentType.toLowerCase().includes("json")) {
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
    return jsonResponse(upstream.status, body, { "x-request-id": requestId });
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

const app = new Hono<ProxyEnvironment>().basePath("/api");

app.use("*", cors({
  origin: (origin, c) => origin === c.env.ALLOWED_ORIGIN ? origin : null,
  allowMethods: ["GET"],
  allowHeaders: ["Accept"],
  exposeHeaders: ["X-Request-ID"],
  maxAge: 600,
}));

app.use("*", async (c, next) => {
  // Reject HEAD too: Hono otherwise handles it automatically through GET routes.
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

app.get("/stats/alltimeleadersgrids", (c) => {
  const url = new URL("/stats/alltimeleadersgrids", NBA_STATS_ORIGIN);
  // Preserve query encoding and order rather than reserializing through c.req.query().
  url.search = new URL(c.req.url).search;
  return proxyUpstream({ url, headers: statsHeaders }, "stats/alltimeleadersgrids");
});

app.get("/live/:resource/:file", (c) => {
  const requestUrl = new URL(c.req.url);
  const route = resolveLiveUpstream(requestUrl.pathname, requestUrl.search);
  if (!route) return c.notFound();

  return proxyUpstream(route, requestUrl.pathname.slice("/api/".length));
});

app.notFound(() => errorResponse(404, "not_found", "This API route is not enabled"));

app.onError(() => errorResponse(500, "internal_error", "The API gateway encountered an error"));

export default app;
