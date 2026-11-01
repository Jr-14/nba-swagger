import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import app from "../src/worker.ts";
import { NBA_BROWSER_HEADERS } from "../shared/nba-headers.ts";

const invoke = (path, init) =>
  app.request(`https://proxy.test${path}`, init, {
    ALLOWED_ORIGIN: "https://nba-swagger.pages.dev",
  });
const statsPath = "/api/stats/alltimeleadersgrids";
const query = "?LeagueID=20&PerMode=PerGame&SeasonType=Regular%20Season&TopX=2";

afterEach(() => mock.restoreAll());

test("Stats forwards the original query encoding and headers with a configured timeout", async () => {
  mock.method(console, "log", () => {});
  const timeout = mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  const fetch = mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), `https://stats.nba.com/stats/alltimeleadersgrids${query}`);
    for (const [name, value] of Object.entries(NBA_BROWSER_HEADERS)) {
      assert.equal(options.headers[name], value);
    }
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    return Response.json({ resource: "alltimeleadersgrids", resultSets: [] });
  });
  const response = await invoke(statsPath + query, {
    headers: { cookie: "private=test", authorization: "Bearer test" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(timeout.mock.callCount(), 1);
  assert.ok(Number.isInteger(timeout.mock.calls[0].arguments[0]));
  assert.ok(timeout.mock.calls[0].arguments[0] > 0);
});

test("query parameters remain passthrough, not a duplicate OpenAPI validator", async () => {
  mock.method(console, "log", () => {});
  mock.method(globalThis, "fetch", async (url) => {
    assert.equal(new URL(url).search, "?Extra=a%20b&Extra=a+b&TopX=101");
    return Response.json({});
  });
  assert.equal((await invoke(statsPath + "?Extra=a%20b&Extra=a+b&TopX=101")).status, 200);
});

test("all four Live routes retain the liveData prefix", async () => {
  mock.method(console, "log", () => {});
  const paths = [
    "scoreboard/todaysScoreboard_00.json",
    "odds/odds_todaysGames.json",
    "boxscore/boxscore_0022500001.json",
    "playbyplay/playbyplay_0022500001.json",
  ];
  for (const path of paths) {
    mock.method(globalThis, "fetch", async (url) => {
      assert.equal(String(url), `https://cdn.nba.com/static/json/liveData/${path}?extra=1`);
      return Response.json({});
    });
    assert.equal((await invoke(`/api/live/${path}?extra=1`)).status, 200);
    mock.restoreAll();
    mock.method(console, "log", () => {});
  }
});

test("unknown routes, methods, and oversized queries do not reach NBA", async () => {
  const fetch = mock.method(globalThis, "fetch", () => {
    throw new Error("No upstream request should be made");
  });
  assert.equal((await invoke("/api/stats/commonplayerinfo")).status, 404);
  assert.equal((await invoke("/api/live/https://example.com")).status, 404);
  assert.equal((await invoke(statsPath, { method: "POST" })).status, 405);
  assert.equal((await invoke(statsPath, { method: "HEAD" })).status, 405);
  assert.equal((await invoke(`${statsPath}?x=${"a".repeat(2050)}`)).status, 414);
  assert.equal(fetch.mock.callCount(), 0);
});

test("520 logs the actual upstream response without exposing it publicly", async () => {
  const log = mock.method(console, "error", () => {});
  mock.method(globalThis, "fetch", async () => new Response("error code: 520\n", {
    status: 520,
    headers: { "content-type": "text/plain; charset=UTF-8", server: "cloudflare" },
  }));
  const response = await invoke(statsPath + query);
  assert.equal(response.status, 502);
  const event = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.equal(event.status, 520);
  assert.equal(event.bodyPreview, "error code: 520\n");
  assert.equal(event.upstreamHost, "stats.nba.com");
  assert.equal(event.requestId, response.headers.get("x-request-id"));
  assert.equal((await response.json()).error.code, "invalid_upstream_response");
});

test("upstream timeouts log the phase and error type and return JSON 504", async () => {
  const log = mock.method(console, "error", () => {});
  const timeout = mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  mock.method(globalThis, "fetch", async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const response = await invoke(statsPath + query);
  assert.equal(response.status, 504);
  const event = JSON.parse(log.mock.calls[0].arguments[0]);
  assert.equal(event.errorName, "TimeoutError");
  assert.equal(event.phase, "fetch");
  assert.equal(event.timeoutMs, timeout.mock.calls[0].arguments[0]);
  assert.equal((await response.json()).error.code, "upstream_timeout");
});

test("CORS permits the Pages origin and exposes the request ID on errors", async () => {
  const origin = "https://nba-swagger.pages.dev";
  const response = await invoke("/api/stats/not-enabled", { headers: { origin } });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-expose-headers"), "X-Request-ID");
  assert.match(response.headers.get("vary"), /Origin/);
});

test("CORS preflight does not call NBA and allows GET only", async () => {
  const fetch = mock.method(globalThis, "fetch", () => {
    throw new Error("Preflight must not call NBA");
  });
  const response = await invoke(statsPath, {
    method: "OPTIONS",
    headers: {
      origin: "https://nba-swagger.pages.dev",
      "access-control-request-method": "GET",
      "access-control-request-headers": "accept",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://nba-swagger.pages.dev");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET");
  assert.equal(fetch.mock.callCount(), 0);
});

test("CORS does not grant access to other origins or include credentials", async () => {
  const response = await invoke("/api/stats/not-enabled", {
    headers: { origin: "https://other.test" },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});
