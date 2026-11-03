import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import gateway from "../src/gateway.ts";
import nodeProxy from "../containers/proxy/app.ts";

const statsPath = "/api/stats/alltimeleadersgrids";
const query = "?LeagueID=20&PerMode=PerGame&SeasonType=Regular%20Season&TopX=2";

function harness(handler = () => Response.json({ ok: true }), allowed = true) {
  const requests = [];
  const names = [];
  const keys = [];
  const entries = new Map();
  const reads = [];
  const writes = [];
  const background = [];
  const env = {
    ALLOWED_ORIGIN: "https://nba-swagger.pages.dev",
    PROXY: { getByName(name) { names.push(name); return { fetch(request) { requests.push(request); return handler(request); } }; } },
    RATE_LIMITER: { async limit({ key }) { keys.push(key); return { success: allowed }; } },
    RESPONSE_CACHE: {
      async get(key, type) { reads.push({ key, type }); return entries.get(key) ?? null; },
      async put(key, value, options) { writes.push({ key, options }); entries.set(key, JSON.parse(value)); },
    },
  };
  const executionCtx = { waitUntil(promise) { background.push(promise); } };
  return {
    requests, names, keys, entries, reads, writes, background, env,
    flush: () => Promise.all(background),
    invoke: (path, init) => gateway.request(`https://proxy.test${path}`, init, env, executionCtx),
  };
}

afterEach(() => mock.restoreAll());

test("gateway forwards only safe request data to one stable container", async () => {
  const h = harness();
  const response = await h.invoke(statsPath + query, {
    headers: { origin: "https://nba-swagger.pages.dev", cookie: "private=1", authorization: "Bearer private", "cf-connecting-ip": "192.0.2.1" },
  });
  assert.equal(response.status, 200);
  assert.equal(h.requests[0].url, `http://container${statsPath}${query}`);
  assert.equal(h.requests[0].headers.get("cookie"), null);
  assert.equal(h.requests[0].headers.get("authorization"), null);
  assert.equal(h.requests[0].headers.get("origin"), null);
  assert.equal(h.requests[0].headers.get("x-request-id"), response.headers.get("x-request-id"));
  assert.deepEqual(h.names, ["nba-proxy"]);
  assert.deepEqual(h.keys, ["192.0.2.1"]);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("successful JSON responses are cached by the complete public path and query", async () => {
  let upstreamCalls = 0;
  const h = harness(() => { upstreamCalls++; return Response.json({ call: upstreamCalls }); });
  const path = statsPath + "?Season=2025-26&LeagueID=00";
  const first = await h.invoke(path, { headers: { origin: "https://nba-swagger.pages.dev" } });
  const firstId = first.headers.get("x-request-id");
  const second = await h.invoke(path, { headers: { origin: "https://nba-swagger.pages.dev" } });

  assert.deepEqual(await first.json(), { call: 1 });
  assert.deepEqual(await second.json(), { call: 1 });
  await h.flush();
  assert.equal(upstreamCalls, 1);
  assert.equal(h.reads.length, 2);
  assert.deepEqual(h.writes, [{ key: `response:${path}`, options: { expirationTtl: 600 } }]);
  assert.notEqual(second.headers.get("x-request-id"), firstId);
  assert.equal(second.headers.get("cache-control"), "no-store");
  assert.equal(second.headers.get("x-content-type-options"), "nosniff");
  assert.equal(second.headers.get("access-control-allow-origin"), "https://nba-swagger.pages.dev");
});

test("game-state Stats endpoints use the one-minute TTL; other Stats keep ten minutes", async () => {
  const h = harness();
  await h.invoke("/api/stats/boxscoretraditionalv3?GameID=0022500001");
  await h.invoke("/api/stats/playbyplayv3?GameID=0022500001");
  await h.invoke("/api/stats/scoreboardv3?GameDate=11%2F04%2F2026");
  await h.invoke(statsPath);
  await h.flush();

  assert.deepEqual(h.writes.map(({ options }) => options.expirationTtl), [60, 60, 60, 600]);
});

test("Live cache uses a one-minute TTL and query order remains part of the key", async () => {
  const h = harness();
  const path = "/api/live/scoreboard/todaysScoreboard_00.json?x=1&y=2";
  await h.invoke(path);
  await h.invoke("/api/live/scoreboard/todaysScoreboard_00.json?y=2&x=1");
  await h.flush();
  assert.deepEqual(h.writes.map(({ key, options }) => [key, options.expirationTtl]), [
    [`response:${path}`, 60],
    ["response:/api/live/scoreboard/todaysScoreboard_00.json?y=2&x=1", 60],
  ]);
});

test("cache writes run in the background and failures do not change the response", async () => {
  const h = harness(() => Response.json({ ok: true }));
  let releaseWrite;
  let writeStarted;
  const started = new Promise((resolve) => { writeStarted = resolve; });
  h.env.RESPONSE_CACHE.put = async () => new Promise((resolve) => { releaseWrite = resolve; writeStarted(); });
  const response = await h.invoke(statsPath);
  assert.equal(response.status, 200);
  await started;
  assert.equal(typeof releaseWrite, "function");
  releaseWrite();
  await h.flush();

  const failed = harness(() => Response.json({ ok: true }));
  failed.env.RESPONSE_CACHE.put = async () => { throw new Error("KV unavailable"); };
  assert.equal((await failed.invoke(statsPath)).status, 200);
  await failed.flush();
});

test("only successful JSON API responses are cached; health and errors are excluded", async () => {
  for (const [response, expectedStatus] of [
    [Response.json({ error: true }, { status: 500 }), 500],
    [new Response("not json", { status: 200, headers: { "content-type": "application/json" } }), 200],
    [new Response('{"valid":true}', { status: 200, headers: { "content-type": "application/notjson" } }), 200],
    [new Response("no", { status: 200, headers: { "content-type": "text/plain" } }), 502],
  ]) {
    const h = harness(() => response.clone());
    assert.equal((await h.invoke(statsPath)).status, expectedStatus);
    assert.equal(h.writes.length, 0);
  }
  const h = harness(() => Response.json({ healthy: true }));
  await h.invoke("/health");
  assert.equal(h.reads.length, 0);
  assert.equal(h.writes.length, 0);
});

test("oversized KV keys bypass cache without changing the full upstream request", async () => {
  const h = harness();
  const path = `${statsPath}?x=${"a".repeat(600)}`;
  const response = await h.invoke(path);
  assert.equal(response.status, 200);
  assert.equal(h.reads.length, 0);
  assert.equal(h.background.length, 0);
  assert.equal(h.requests[0].url, `http://container${path}`);
});

test("cache hits are rate limited before lookup", async () => {
  const h = harness(undefined, false);
  h.entries.set(`response:${statsPath}`, { status: 200, body: '{"cached":true}' });
  const response = await h.invoke(statsPath);
  assert.equal(response.status, 429);
  assert.equal(h.reads.length, 0);
  assert.equal(h.requests.length, 0);
});

test("KV read failures and malformed entries degrade to the origin", async () => {
  const unavailable = harness(() => Response.json({ source: "origin" }));
  unavailable.env.RESPONSE_CACHE.get = async () => { throw new Error("KV unavailable"); };
  assert.deepEqual(await (await unavailable.invoke(statsPath)).json(), { source: "origin" });

  const malformed = harness(() => Response.json({ source: "origin" }));
  malformed.entries.set(`response:${statsPath}`, { status: 200, body: "not-json" });
  assert.deepEqual(await (await malformed.invoke(statsPath)).json(), { source: "origin" });
  assert.equal(malformed.requests.length, 1);
});

test("gateway route, method, and query guards do not start containers", async () => {
  const h = harness();
  assert.equal((await h.invoke("/api/stats/commonplayerinfox")).status, 404);
  assert.equal((await h.invoke("/api/live/https://example.com")).status, 404);
  assert.equal((await h.invoke("/probe")).status, 404);
  assert.equal((await h.invoke(statsPath, { method: "POST" })).status, 405);
  assert.equal((await h.invoke(statsPath, { method: "HEAD" })).status, 405);
  assert.equal((await h.invoke(`${statsPath}?x=${"a".repeat(2050)}`)).status, 414);
  assert.equal(h.requests.length, 0);
});

test("CORS permits Pages and exposes request IDs on errors", async () => {
  const h = harness();
  const origin = "https://nba-swagger.pages.dev";
  const response = await h.invoke("/api/stats/not-enabled", { headers: { origin } });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(response.headers.get("access-control-expose-headers"), "X-Request-ID");
  assert.match(response.headers.get("vary"), /Origin/);
});

test("CORS preflight never starts a container", async () => {
  const h = harness();
  const response = await h.invoke(statsPath, {
    method: "OPTIONS",
    headers: { origin: "https://nba-swagger.pages.dev", "access-control-request-method": "GET", "access-control-request-headers": "accept" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://nba-swagger.pages.dev");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET");
  assert.equal(h.requests.length, 0);
});

test("CORS does not grant other origins access or include credentials", async () => {
  const response = await harness().invoke("/api/stats/not-enabled", { headers: { origin: "https://other.test" } });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

test("rate limiting returns JSON 429 before starting a container", async () => {
  const h = harness(undefined, false);
  const response = await h.invoke(statsPath + query);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, "rate_limited");
  assert.equal(h.requests.length, 0);
});

test("container startup errors and non-JSON responses become gateway JSON errors", async () => {
  mock.method(console, "error", () => {});
  for (const handler of [() => { throw new Error("startup failed"); }, () => new Response("Failed to start", { status: 500 })]) {
    const response = await harness(handler).invoke(statsPath + query);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "container_unavailable");
    assert.ok(response.headers.get("x-request-id"));
  }
});

test("gateway-to-Node integration returns full NBA JSON, not probe metadata", async () => {
  mock.method(console, "log", () => {});
  const payload = { resource: "alltimeleadersgrids", parameters: { LeagueID: "20" }, resultSets: [{ name: "PTSLeaders", headers: ["PLAYER_ID"], rowSet: [[1]] }] };
  mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), `https://stats.nba.com/stats/alltimeleadersgrids${query}`);
    return Response.json(payload);
  });
  const h = harness((request) => nodeProxy.fetch(request));
  const response = await h.invoke(statsPath + query, { headers: { origin: "https://nba-swagger.pages.dev" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://nba-swagger.pages.dev");
  assert.deepEqual(await response.json(), payload);
});
