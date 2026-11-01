# Development and proxy diagnostics

## Local servers

- `pnpm dev` runs Swagger UI with Vite's Node HTTP proxy on port 5173. Select
  **NBA API proxy** to use the local `/api` routes.
- `pnpm dev:pages` builds Swagger UI and starts two servers: the static Pages
  site on **http://localhost:8788** and the actual Hono Worker on port 8787.
  Its built OpenAPI spec points to `http://localhost:8787/api`; the local Worker
  allows CORS from `http://localhost:8788`. Both servers stop when the command
  exits. Restart to rebuild after static UI or OpenAPI changes.
- `pnpm dev:worker` runs only the standalone Worker on port 8787. Do not run it
  at the same time as `dev:pages`, which already starts a Worker.

`dev:pages` is retained as a convenience command, but the proxy is no longer a
Pages Function. It runs through `wrangler dev`, without `hono/cloudflare-pages`.
These local commands do not deploy anything.

NBA browser-header configuration is shared in `shared/nba-headers.ts`; each
runtime may add its own transport headers. Normal Vite development remains a
useful Node-runtime comparison, not a simulation of the Worker.

## Checks and builds

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm build:worker
```

These commands do not make NBA requests or deploy anything. The Worker build
is a Wrangler dry run. Tests mock upstream HTTP requests, including CORS,
timeout, query passthrough, and route allowlist scenarios.

For a production frontend build, set `VITE_PROXY_URL` to the actual deployed
Worker HTTPS URL ending in `/api`. The manual Pages workflow reads this public
setting from GitHub's `prod` environment and refuses to deploy without it.
The generated OpenAPI asset includes this URL, not just an in-memory UI override.

## Interpreting failures

The Worker logs `nba_upstream_non_json` with upstream status, selected headers,
and at most 2 KiB of its response body. A body of `error code: 520` is the actual
error body, not missing logging, and does not establish an IP block.

`nba_upstream_failure` includes the failing phase (`fetch` or `body`), error
name, configured timeout, duration, upstream host, and request ID. Match the ID
with the response's `x-request-id` header. Body previews remain in server logs.

Production log command:

```bash
pnpm exec wrangler tail --config wrangler.worker.jsonc
```

## Reproduce the Node/workerd transport difference

```bash
pnpm diagnose:upstream
```

This explicitly makes four NBA requests, bounded to eight seconds each. It
starts an isolated local workerd fixture and a loopback-only header echo server,
then cleans them up. It does not deploy, use production credentials, change the
application timeout, or run in CI.

Observed results on the debugging machine:

| Test | Result |
| --- | --- |
| Node `fetch` | JSON `200`, approximately 200 ms |
| Node TLS, HTTP/1.1 with `Connection: close` | `200`, approximately 50 ms |
| Same Node TLS request, only `Connection` removed | Eight-second diagnostic timeout |
| workerd HTTP request to local echo, explicitly setting `Connection: close` | Header absent on the wire |
| workerd NBA request with the same configured headers | Eight-second diagnostic timeout |

Connection tracing also showed Node and workerd connecting directly to the same
NBA IPv4 address. Local Wrangler was not relaying this request through the
Cloudflare production edge. Local development therefore uses the same network,
but not the same HTTP client behavior.

Node's default client supplies connection/encoding headers that workerd does
not necessarily send. In this experiment, the NBA endpoint did not respond to
the otherwise-identical Node request without `Connection`. workerd owns and
strips this hop-by-hop header; adding it to application `fetch` headers does not
put it on the wire. `Accept-Encoding` alone and `Sec-Fetch-Mode` did not fix the
workerd request. Adding `CF-Worker` to Node requests still returned `200`, so
that header alone is not the cause.

This establishes a concrete HTTP-request incompatibility, not NBA's complete
server-side failure policy. A raw-TLS-socket experiment inside workerd still
timed out with `Connection` present, and Node HTTPS compatibility mode did not
resolve it. Additional runtime/TLS differences remain possible. No verified
application-header-only fix or production transport workaround is established;
there is no fallback or automatic retry that conceals the failure.

The live diagnostic can be run on another network to compare results without
assuming they generalize to every NBA edge or production Cloudflare egress.
