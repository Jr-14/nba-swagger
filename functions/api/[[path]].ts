const NBA_STATS_ORIGIN = "https://stats.nba.com";
const NBA_LIVE_ORIGIN = "https://cdn.nba.com/static/json/liveData/";
const UPSTREAM_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_QUERY_LENGTH = 2_048;

interface UpstreamRoute {
  url: URL;
  headers: Record<string, string>;
}

const statsHeaders = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.5",
  origin: "https://www.nba.com",
  referer: "https://www.nba.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
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

function resolveUpstream(
  pathname: string,
  searchParams: URLSearchParams,
): UpstreamRoute | null {
  if (pathname === "/api/stats/alltimeleadersgrids") {
    const url = new URL("/stats/alltimeleadersgrids", NBA_STATS_ORIGIN);
    url.search = searchParams.toString();
    return { url, headers: statsHeaders };
  }

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
  url.search = searchParams.toString();
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

export const onRequest: PagesFunction = async ({ request }) => {
  if (request.method !== "GET") {
    return errorResponse(405, "method_not_allowed", "Only GET is supported", {
      allow: "GET",
    });
  }

  const requestUrl = new URL(request.url);
  if (requestUrl.search.length > MAX_QUERY_LENGTH) {
    return errorResponse(414, "query_too_large", "Query string exceeds the size limit");
  }
  const route = resolveUpstream(requestUrl.pathname, requestUrl.searchParams);
  if (!route) {
    return errorResponse(404, "not_found", "This API route is not enabled");
  }

  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const endpoint = requestUrl.pathname.replace(/^\/api\//, "");
  try {
    const upstream = await fetch(route.url, {
      headers: route.headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "manual",
    });

    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      console.error(JSON.stringify({
        event: "nba_upstream_non_json",
        requestId,
        endpoint,
        status: upstream.status,
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
};
