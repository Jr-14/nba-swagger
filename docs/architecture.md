# Production Architecture

## Request flow

The static Swagger UI stays at **https://nba-swagger.pages.dev**. A separate
Worker provides the public API gateway; real Node in a Linux container makes
the NBA requests. The Worker no longer uses workerd's `fetch` to contact NBA.

```text
Browser
    ├── nba-swagger.pages.dev
    │       └── Cloudflare Pages: Swagger UI and OpenAPI assets
    │
    └── nba-swagger-proxy.jr-jemerson14.workers.dev/api/*
            └── Hono Worker: CORS, route guards, rate limiting
                    └── NbaProxy Durable Object
                            └── Node + Hono container
                                    ├── Stats: stats.nba.com/stats/*
                                    └── Live: cdn.nba.com/static/json/liveData/*
```

The proxy returns the actual upstream JSON, not probe summaries or mock data.
Swagger also offers direct NBA Stats requests, which browsers may block through
CORS. Production's public proxy URL is committed in `src/openapi.yml`;
`VITE_PROXY_URL` is no longer a required deployment setting.

## Components

| Component | Source/configuration | Responsibility |
| --- | --- | --- |
| Static UI | `src/index.html`, `src/swagger.js`, `src/openapi.yml`, `wrangler.jsonc` | Build into `dist/` and deploy to Pages |
| Worker entry point | `src/worker.ts`, `wrangler.worker.jsonc` | Export the container class and Hono gateway |
| Gateway | `src/gateway.ts` | CORS, early request rejection, rate limiting, forwarding and startup-error handling |
| Node service | `containers/proxy/app.ts`, `server.ts`, `Dockerfile` | Fixed-host NBA requests, JSON parsing and diagnostics |
| Shared policy | `shared/routes.ts`, `shared/proxy-config.ts` | One endpoint allowlist and common resource limits |

There are no Pages Functions, deprecated Hono Pages adapters, standalone probe
service sources, or alternate workerd-to-NBA proxy implementations.

The container has direct outbound Internet access. No HTTP/HTTPS interception
handler forwards NBA requests back to workerd. It runs as the `node` user and
includes production dependencies only. `.dockerignore` allowlists the source
and manifests needed for the image; credentials and `.git` are excluded.

## Request handling

- Enabled Stats routes: `/api/stats/alltimeleadersgrids`,
  `/api/stats/assistleaders`, `/api/stats/assisttracker`,
  `/api/stats/boxscoreadvancedv2`, `/api/stats/boxscoreadvancedv3`,
  `/api/stats/boxscoredefensivev2`, `/api/stats/boxscorefourfactorsv2`,
  `/api/stats/boxscorefourfactorsv3`, `/api/stats/boxscorehustlev2`, and
  `/api/stats/boxscorematchupsv3`, `/api/stats/boxscoremiscv2`,
  `/api/stats/boxscoremiscv3`, `/api/stats/boxscoreplayertrackv3`,
  `/api/stats/boxscorescoringv2`, `/api/stats/boxscorescoringv3`, and
  `/api/stats/boxscoresummaryv2`, `/api/stats/boxscoresummaryv3`,
  `/api/stats/boxscoretraditionalv2`, `/api/stats/boxscoretraditionalv3`,
  `/api/stats/boxscoreusagev2`, `/api/stats/boxscoreusagev3`, and
  `/api/stats/commonallplayers`, `/api/stats/commonplayerinfo`,
  `/api/stats/commonplayoffseries`, `/api/stats/commonteamroster`,
  `/api/stats/commonteamyears`, `/api/stats/cumestatsplayer`,
  `/api/stats/cumestatsplayergames`, `/api/stats/cumestatsteam`,
  `/api/stats/cumestatsteamgames`, `/api/stats/defensehub`, and
  `/api/stats/draftboard`, `/api/stats/draftcombinedrillresults`,
  `/api/stats/draftcombinenonstationaryshooting`,
  `/api/stats/draftcombineplayeranthro`, `/api/stats/draftcombinespotshooting`,
  `/api/stats/draftcombinestats`, `/api/stats/drafthistory`, and
  `/api/stats/dunkscoreleaders`, `/api/stats/fantasywidget`, and
  `/api/stats/franchisehistory`, `/api/stats/franchiseleaders`, and
  `/api/stats/franchiseplayers`, `/api/stats/gamerotation`, and
  `/api/stats/glalumboxscoresimilarityscore`, `/api/stats/gravityleaders`, and
  `/api/stats/homepageleaders`, `/api/stats/homepagev2`, and
  `/api/stats/hustlestatsboxscore`, `/api/stats/infographicfanduelplayer`, and
  `/api/stats/iststandings`, `/api/stats/leaderstiles`, and
  `/api/stats/leaguedashlineups`.
  The assist endpoints are deprecated
  upstream and currently return the NBA.com homepage instead of JSON;
  `boxscoreadvancedv2`, `boxscorefourfactorsv2`, `boxscoremiscv2`,
  `boxscorescoringv2`, and `boxscoreusagev2` are deprecated upstream and return
  an empty JSON object.
  `boxscoretraditionalv2` no longer publishes data as of the 2025-26 season;
  `BoxScoreTraditionalV3` is the recommended replacement.
  `boxscoresummaryv2` can return incomplete or missing data for games on or
  after 2025-04-10; `BoxScoreSummaryV3` is the recommended replacement.
  `draftboard` currently returns HTTP 500 for all parameter combinations tested
  upstream as of 2026-10-21.
- Enabled Live routes: scoreboard, odds, boxscore, and play-by-play under
  `/api/live/`. Scoreboard, boxscore, odds, and play-by-play are documented
  under the Live API tag in Swagger. Game-specific paths require a ten-digit ID.
- The inventory in `docs/endpoints.md` does not automatically enable other Stats
  endpoints. This refactor changes transport, not endpoint coverage.
- Both gateway and container use `shared/routes.ts`. Unknown paths and methods
  are rejected before waking a container and checked again inside Node.
- Query parameters pass through unchanged in encoding and order. Their schema
  stays in OpenAPI rather than a duplicate per-parameter validator.
- The gateway forwards only the path, query, and a generated request ID to the
  container. Browser cookies, authorization, and arbitrary headers are dropped.
- Node sets its own NBA headers, including `Connection: close` and
  `Accept-Encoding: identity`; redirects to other destinations are not followed.
- JSON responses preserve the upstream status. Valid Live CDN JSON labeled
  `text/plain` is parsed and normalized to `application/json`. HTML, invalid JSON,
  oversized bodies, and failed startup produce JSON gateway errors.
- `/health` reports the Node runtime without contacting NBA. It proves startup,
  not NBA connectivity. The old `/probe` endpoint is removed.

## CORS and abuse controls

The gateway allows browser CORS from exactly `https://nba-swagger.pages.dev`.
It handles preflight without starting a container, allows `GET`/`Accept`, exposes
`X-Request-ID`, and does not allow browser credentials. CORS headers apply to
errors too. CORS is not authentication: the proxy is public, as required for
Swagger's Try it out. The old probe token is not embedded in the UI or required
for API calls.

- Worker rate limiter: approximately **30 requests per client IP per 60 seconds**.
  Cloudflare's counters are location-local and approximate, not a strict global
  quota. The dedicated namespace is configured in `wrangler.worker.jsonc`.
- One deployed `lite` container instance, addressed by a stable Durable Object
  name. It sleeps after five minutes of inactivity to reduce cold starts while
  users interact with Swagger. Running time can incur charges.
- Node accepts at most four concurrent NBA requests; excess requests return
  `503` with `Retry-After` rather than creating an unbounded queue.
- Existing limits are preserved: 180-second upstream timeout, 5 MiB response
  limit, and 2,048-character query limit. These are in `shared/proxy-config.ts`.
- Responses use `Cache-Control: no-store`; no stale or synthetic success response
  hides an upstream error.

These controls are not a monetary budget guarantee. Monitor Worker invocations,
Durable Object/container usage, and NBA failures. Follow NBA.com's Terms of Use
and applicable data-use restrictions.

## Deployment

- **Method:** GitHub Actions with the project-local Wrangler dependency.
- **Branch:** `main`; **environment:** `prod`.
- **CI:** `ci.yml` runs checks, offline tests, the UI build, and Worker/container
  compilation on PRs and pushes. It never deploys or makes NBA requests.
- **Backend:** manually run **Deploy NBA Proxy Worker** (`deploy-worker.yml`).
  It deploys the gateway, Durable Object, and Node image together.
- **Frontend:** manually run **Deploy Swagger Pages** (`deploy-pages.yml`).
  It updates the existing `nba-swagger` Pages project, not its public hostname.
- No preview deployments or custom domains are configured. Node/pnpm versions
  remain those specified by the repository workflows.

The `prod` environment needs `CLOUDFLARE_ACCOUNT_ID` as a variable and
`CLOUDFLARE_API_TOKEN` as a secret. The account must have Workers Paid/Containers
enabled, and the token must permit Pages, Worker, container, and image deployment.
No probe token or frontend proxy URL environment variable is needed.

### Deploying this refactor

1. Push the changes to `main` and manually deploy **Deploy NBA Proxy Worker**.
2. Allow initial image provisioning, then check the public Worker's `/health`.
3. Request `/api/stats/alltimeleadersgrids` with the documented query parameters
   and verify the full NBA JSON, not only the health result.
4. Deploy **Deploy Swagger Pages** and select **NBA API proxy** in Swagger.
5. After successful verification, retire the old `nba-swagger-container-probe`
   deployment in Cloudflare and remove the unused `CONTAINER_PROBE_TOKEN` secret
   from GitHub. Its source and workflow are removed, but source cleanup does not
   delete deployed Cloudflare resources. No remote deletion is automated here.

The backend keeps the `nba-swagger-proxy` Worker name. If Cloudflare assigns a
different public hostname for the target account, update `src/openapi.yml`
before deploying Pages. Existing unused `VITE_PROXY_URL` settings can be removed.

## Observability

The gateway generates `X-Request-ID`, passes it into Node, and exposes it to the
browser. Node logs the endpoint, upstream status, duration, and bounded error
diagnostics. Query strings, credentials, and successful NBA bodies are not logged.
An invalid upstream response can log a body preview up to 2 KiB server-side;
it is not exposed publicly. Startup failures are distinguishable from NBA errors.

```bash
pnpm exec wrangler tail --config wrangler.worker.jsonc
```

## Why the native Functions/Workers transport was replaced

The initial Pages Function removed browser CORS restrictions but received an
upstream `520` after roughly 40 seconds, with a plain-text `error code: 520`
body. It correctly returned a JSON `502` to Swagger. Local Vite/Node requests
worked, while local workerd requests timed out. Migrating the routing layer to
Hono on a standalone Worker did not change that underlying transport.

Connection tracing showed Node and local workerd connecting directly to the
same NBA IPv4 address, not through Cloudflare's production edge. In a controlled
Node HTTP/1.1 experiment, removing only `Connection` caused a timeout; adding
`close` or `keep-alive` returned `200`. workerd stripped that hop-by-hop header
even when the application explicitly supplied it. Adding `CF-Worker` to Node
did not itself cause failure. Header matching and longer timeouts did not fix
native workerd; raw socket and Node compatibility experiments there failed too.
The complete upstream policy/TLS cause was not established, and `520` alone
does not prove an IP block.

Real Node in plain Docker subsequently returned NBA JSON `200` with 19 result
sets in about 1.3 seconds. The deployed proof-of-concept health check confirmed
Node startup, but no deployed NBA `/probe` result was supplied before this
refactor. Cloudflare-hosted NBA connectivity still requires the API verification
step above; it is not inferred from health checks or unit tests.

Local Wrangler container startup also encountered a separate Linux sidecar
issue matching [workerd issue 6860](https://github.com/cloudflare/workerd/issues/6860)
on a host with `src_valid_mark=1`. Host networking settings were not changed.
This is distinct from the native workerd-to-NBA failure.
