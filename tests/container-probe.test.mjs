import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import app from "../containers/stats-probe/app.ts";

afterEach(() => mock.restoreAll());

test("container health does not call NBA", async () => {
  const fetch = mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream request"); });
  const response = await app.request("http://container/health");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runtime, "node");
  assert.equal(fetch.mock.callCount(), 0);
});

test("container probes only the fixed NBA request and verifies its JSON shape", async () => {
  mock.method(console, "log", () => {});
  mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://stats.nba.com/stats/alltimeleadersgrids?LeagueID=20&PerMode=PerGame&SeasonType=Regular%20Season&TopX=2");
    assert.equal(options.headers.connection, "close");
    assert.equal(options.headers["accept-encoding"], "identity");
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.redirect, "manual");
    return Response.json({ resource: "alltimeleadersgrids", resultSets: [{ name: "PTSLeaders" }] });
  });
  const response = await app.request("http://container/probe?target=https://other.test&TopX=1000");
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.runtime, "node");
  assert.equal(result.upstreamStatus, 200);
  assert.equal(result.resultSetCount, 1);
  assert.equal(response.headers.get("x-request-id"), result.requestId);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("container rejects non-JSON without exposing the upstream body", async () => {
  mock.method(console, "error", () => {});
  mock.method(globalThis, "fetch", async () => new Response("error code: 520", {
    status: 520, headers: { "content-type": "text/plain" },
  }));
  const response = await app.request("http://container/probe");
  const result = await response.json();
  assert.equal(response.status, 502);
  assert.equal(result.upstreamStatus, 520);
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes("error code: 520"));
});

test("container does not mistake unrelated JSON for NBA success", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ message: "blocked" }));
  const response = await app.request("http://container/probe");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).ok, false);
});

test("container returns structured timeout errors", async () => {
  mock.method(console, "error", () => {});
  mock.method(globalThis, "fetch", async () => { throw new DOMException("timeout", "TimeoutError"); });
  const response = await app.request("http://container/probe");
  assert.equal(response.status, 504);
  assert.equal((await response.json()).ok, false);
});

test("container rejects unsupported routes and methods without upstream calls", async () => {
  const fetch = mock.method(globalThis, "fetch", () => { throw new Error("Unexpected upstream request"); });
  assert.equal((await app.request("http://container/other")).status, 404);
  assert.equal((await app.request("http://container/probe", { method: "POST" })).status, 405);
  assert.equal((await app.request("http://container/probe", { method: "HEAD" })).status, 405);
  assert.equal(fetch.mock.callCount(), 0);
});
