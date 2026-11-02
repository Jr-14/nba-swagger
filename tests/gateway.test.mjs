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
  const env = {
    ALLOWED_ORIGIN: "https://nba-swagger.pages.dev",
    PROXY: { getByName(name) { names.push(name); return { fetch(request) { requests.push(request); return handler(request); } }; } },
    RATE_LIMITER: { async limit({ key }) { keys.push(key); return { success: allowed }; } },
  };
  return { requests, names, keys, invoke: (path, init) => gateway.request(`https://proxy.test${path}`, init, env) };
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
