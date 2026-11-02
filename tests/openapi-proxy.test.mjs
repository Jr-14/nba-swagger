import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { configureProxyServer } from "../shared/openapi-proxy.mjs";

const spec = readFileSync(new URL("../src/openapi.yml", import.meta.url), "utf8");

test("production spec has a public proxy URL without deployment variables", () => {
  assert.ok(spec.includes("url: https://nba-swagger-proxy.jr-jemerson14.workers.dev/api"));
  assert.ok(!spec.includes("url: /api\n"));
});

test("built OpenAPI points at the Worker and retains the direct Stats server", () => {
  const result = configureProxyServer(spec, "https://nba-swagger-proxy.example.workers.dev/api");
  assert.ok(result.includes('url: "https://nba-swagger-proxy.example.workers.dev/api"'));
  assert.ok(result.includes('url: "https://nba-swagger-proxy.example.workers.dev/api/live"'));
  assert.ok(result.includes("url: https://stats.nba.com"));
  assert.ok(!result.includes("url: /api\n"));
});

test("local Pages can use the separate local Worker", () => {
  assert.ok(configureProxyServer(spec, "http://localhost:8787/api/")
    .includes('url: "http://localhost:8787/api"'));
});

test("Vite can point at the local API route", () => {
  const result = configureProxyServer(spec, "/api");
  assert.ok(result.includes('url: "/api"'));
  assert.ok(result.includes('url: "/api/live"'));
  assert.ok(!result.includes("https://nba-swagger-proxy.jr-jemerson14.workers.dev/api/live"));
});

test("reject malformed or unsafe deployment proxy URLs", () => {
  for (const url of [
    "not-a-url", "http://public.test/api", "https://proxy.test/", "https://proxy.test/api?key=secret",
    "https://proxy.test/api#fragment", "https://user:password@proxy.test/api",
  ]) {
    assert.throws(() => configureProxyServer(spec, url));
  }
});
