# Production Architecture

## Overview

Cloudflare Pages serves the static Swagger UI at **https://nba-swagger.pages.dev**.
A separate Cloudflare Worker runs the Hono reverse proxy. The frontend hostname
does not change, and there are no Pages Functions or deprecated Hono Pages
adapters in this architecture.

```text
Public browser
    ├── nba-swagger.pages.dev
    │       └── Cloudflare Pages: index.html, JavaScript, OpenAPI asset
    │
    └── configured proxy Worker hostname /api/*
            └── Hono Worker
                    ├── /api/stats/{endpoint}
                    │       └── https://stats.nba.com/stats/{endpoint}
                    └── /api/live/{path}
                            └── https://cdn.nba.com/static/json/liveData/{path}
```

Swagger also offers direct NBA Stats requests as an alternative; browser CORS
restrictions may prevent those calls. The proxy Worker is the default server.

**Connectivity status:** this describes the implemented architecture, not a
verified working NBA Stats transport. The tested Stats operation still has
unresolved failures through workerd. The Node container experiment is separate
and has not yet been validated on Cloudflare's deployed container network.

## Components and configuration

### Static Swagger UI

- Source: `src/index.html`, `src/swagger.js`, and `src/openapi.yml`.
- Build: `pnpm build`; output: `dist/`.
- Pages project: `nba-swagger`, configured in `wrangler.jsonc`.
- Public hostname: `nba-swagger.pages.dev`; no custom domain.
- Production builds receive `VITE_PROXY_URL`, the deployed Worker's full HTTPS
  base URL ending in `/api`. This is public configuration, not a secret.
- The Vite build substitutes this value into the emitted OpenAPI YAML, so both
  Swagger's server selector and the downloadable specification use the correct
  Worker URL. No local proxy URL is used for production deployment.

### Hono proxy Worker

- Entry point: `src/worker.ts`, exporting the Hono application directly.
- Wrangler configuration: `wrangler.worker.jsonc`.
- Worker name: `nba-swagger-proxy`.
- The `workers.dev` hostname is assigned under the Cloudflare account's Worker
  subdomain; it is not the Pages hostname and must not be guessed.
- Typed `ALLOWED_ORIGIN` binding: `https://nba-swagger.pages.dev`.
- No static assets, Pages adapter, or Pages-specific context are required by
  the Worker.

## Cross-origin requests

The Worker and static site have different hostnames. Hono's CORS middleware:

- Allows the exact configured Pages origin, not `*`.
- Handles preflight `OPTIONS` requests without calling NBA.com.
- Advertises `GET` and the `Accept` request header.
- Exposes `X-Request-ID` for troubleshooting.
- Adds CORS headers to API errors as well as successful responses.
- Does not allow browser credentials.

CORS controls browser access to responses; it does not authenticate callers or
prevent requests from scripts or other servers. The proxy remains a public API.

## Request handling and safeguards

1. Only `GET` API requests and CORS preflight are supported.
2. Explicit route allowlists constrain upstream requests to the fixed NBA hosts.
   Enabled Stats route: `alltimeleadersgrids`. Enabled Live routes: scoreboard,
   odds, boxscore, and play-by-play. The inventory in `endpoints.md` does not
   automatically enable additional Stats routes.
3. Query parameters pass through without duplicating OpenAPI parameter
   validation. Original encoding/order are preserved; the overall query string
   is limited to 2,048 characters.
4. The Worker adds the configured NBA headers rather than forwarding browser
   cookies, authorization, or arbitrary request headers. Redirects are not
   followed to unapproved destinations.
5. Upstream requests have a 180-second timeout and a 5 MiB response limit. JSON
   responses preserve the upstream status. Non-JSON and malformed responses
   produce JSON gateway errors, never a static HTML fallback.

Configure rate limiting for `/api/*` before promoting the proxy for broad public
use. Keep any private runtime configuration in Cloudflare secrets. Follow
NBA.com's Terms of Use and applicable data-use restrictions.

## Deployment

- **Method:** GitHub Actions + the project-local Wrangler dev dependency.
- **Branch:** `main`.
- **GitHub environment:** `prod` for the manual deployment workflows.
- **CI:** `ci.yml` runs type-checking, offline tests, the static build, and Worker
  compilation, including the container probe image build, on pull requests and
  pushes to `main`; it does not deploy or make live NBA requests.
- **Worker deployment:** manually run `deploy-worker.yml` from `main`.
- **Pages deployment:** manually run `deploy-pages.yml` from `main`.
- **Previews:** not configured.
- **Node/pnpm:** retain the versions configured in the repository workflows.

The `prod` environment must contain:

| Setting | Kind | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Token with Pages deployment and Workers Scripts edit permissions for the target account |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Target Cloudflare account |
| `VITE_PROXY_URL` | Variable | Full deployed Worker base URL, including `/api` |

### First migration deployment

1. Ensure the API token has Workers Scripts edit permission in addition to its
   existing Pages permissions.
2. Run **Deploy NBA Proxy Worker** from `main`. Wrangler creates or updates
   `nba-swagger-proxy` and prints its public URL.
3. Set `VITE_PROXY_URL` in the `prod` environment to that URL plus `/api`.
4. Run **Deploy Swagger Pages** from `main`. It validates the proxy URL, builds
   the static UI, and updates the existing `nba-swagger` Pages project.

The existing Pages site remains available until the Pages deployment replaces
its assets. Deploy compatible Worker and frontend revisions together, Worker
first. Subsequent proxy-only changes can deploy independently if the API
contract is unchanged. No workflow automatically deletes the Pages project.

## Operations and failure behavior

- Responses use `Cache-Control: no-store`. Add caching only after reviewing NBA
  terms and endpoint-specific freshness requirements; never cache errors.
- Upstream failures log status, endpoint, duration, and a correlation ID. For
  non-JSON responses, selected headers and a bounded 2 KiB body preview are
  logged server-side rather than returned publicly.
- Match `x-request-id` with Worker logs. Stream production logs with
  `pnpm exec wrangler tail --config wrangler.worker.jsonc`.
- Monitor upstream errors, timeouts, invocation usage, and rate limiting. Do not
  assume migrating from Pages Functions changes NBA's network access behavior:
  both platforms use workerd, and NBA connectivity remains a separate issue.

## Pages Functions and Workers: connectivity findings

The initial reverse proxy was a Pages Function. It removed the browser's CORS
restriction, but did not establish reliable connectivity to NBA Stats. Moving
the proxy to Hono on a standalone Worker removed the deprecated Pages adapter;
it did not change the underlying workerd HTTP runtime or resolve the failure.

The investigation used the same `alltimeleadersgrids` request with `LeagueID=20`,
`PerMode=PerGame`, `SeasonType=Regular Season`, and `TopX=2` (or `3` in a reported
production request). These findings do not establish that all Stats endpoints
or the separate Live CDN behave the same way.

### Confirmed observations

| Execution path | Observed result |
| --- | --- |
| Local Vite/Node proxy | Successful NBA JSON response |
| Deployed Pages Function | Upstream `520` after approximately 40 seconds, with `Content-Type: text/plain; charset=UTF-8` and body `error code: 520`; the gateway correctly returned JSON `502` |
| Local Wrangler/workerd | Upstream request timed out despite running on the local machine |
| Node TLS, with `Connection: close` or `keep-alive` | NBA returned `200` |
| Otherwise-identical Node TLS request, only `Connection` removed | Diagnostic request timed out |
| Local workerd request to a header echo server | `Connection` was absent on the wire even when explicitly set in application code |

Connection tracing showed Node and local workerd connecting directly to the
same NBA IPv4 address. Local Wrangler was not routing the request through
Cloudflare's production edge. Sharing a network therefore does not guarantee
the same result: the runtimes construct different outbound HTTP requests.

Adding `CF-Worker` to a successful Node request did not cause failure. Matching
application headers and query encoding, adding `Accept-Encoding` or
`Sec-Fetch-Mode`, switching routing frameworks, and increasing timeouts did not
produce a working native workerd request in the tests.

### Interpretation and architectural consequence

The missing `Connection` header is a concrete incompatibility in the tested
HTTP/1.1 request. workerd manages this hop-by-hop header, so setting it in the
application's `fetch` options does not reliably reproduce the successful Node
request. However, a raw-socket workerd experiment with the header present and
a Node HTTPS compatibility-mode experiment also failed. Additional transport
or TLS differences remain possible; the header finding is not proof of the
complete server-side cause.

The upstream `520` alone is **not proof of an IP block**, and the local failure
cannot be attributed exclusively to Cloudflare production egress. No verified
header-only fix exists in this project. Longer timeouts do not resolve the
observed incompatibility. Logs and the JSON gateway errors must not be treated
as successful NBA responses.

For now, retain Pages for static documentation and keep the deployed proxy's
Stats connectivity limitation explicit. Test real Node in an isolated
container before deciding whether to replace the Worker's NBA-facing transport.
The reproducible `pnpm diagnose:upstream` command and detailed results are
documented in [development.md](development.md); it is an explicit live diagnostic,
not a CI test.

## Isolated container experiment

`wrangler.container.jsonc` defines a separate, authenticated Node container
proof of concept to test NBA connectivity outside Worker `fetch`. It is not
part of the frontend or proxy deployment and does not replace either service.
See [container-probe.md](container-probe.md) for local commands, the manual
deployment workflow, cost controls, and observed results. Migration of the full
proxy is conditional on a successful test from the deployed container.

The plain Docker test succeeded: Node received NBA JSON `200` with 19 result
sets in approximately 1.3 seconds. Local Wrangler-to-container startup failed
separately before the Node application was created. The host's
`src_valid_mark=1` setting and sidecar timeout match the reported native-Linux
issue linked in [container-probe.md](container-probe.md); no host networking
settings were changed.

This local Docker success validates the image and its Node request, not
Cloudflare-hosted NBA access. A successful authenticated probe from the deployed
Cloudflare Container is the next decision gate. The existing frontend, proxy
selection, and full API routing are not switched to the container until that
test succeeds.
