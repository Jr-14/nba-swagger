# Production Architecture

## Overview

Cloudflare Pages serves the public Swagger UI and OpenAPI documents. A Cloudflare
Pages Function provides a same-origin, allowlisted gateway for supported NBA
Stats and Live API routes.

```text
Public browser
    │
    ├── GET / and generated OpenAPI/static assets
    │       └── Cloudflare Pages static assets
    │
    └── GET /api/{family}/{endpoint}[?parameters]
            └── Cloudflare Pages Function
                    ├── /api/stats/{endpoint}
                    │       └── https://stats.nba.com/stats/{endpoint}
                    └── /api/live/{path}
                            └── https://cdn.nba.com/static/json/liveData/{path}
```

Pages and Functions use the same public hostname. Swagger UI API requests remain
same-origin, avoiding browser-to-NBA.com CORS and restricted-header problems.

## Cloudflare components

### Cloudflare Pages

- Serves the built Swagger UI and OpenAPI files from the Vite build output.
- Build command: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm build`.
- Build output directory: `dist`.
- Uses the project’s production hostname and TLS for the documentation routes.

### Cloudflare Pages Function

The Pages Function at `functions/api/[[path]].ts` handles `/api/*`. Wrangler
deploys this source alongside the static Pages build. The Function runs at
Cloudflare’s edge and makes server-side requests to the fixed NBA origins.

The OpenAPI server URL is `/api`; operation paths identify the NBA API family
and endpoint, for example `/stats/alltimeleadersgrids`. Direct NBA origin
servers are not exposed in the Swagger document.

## Deployment configuration

- **Deployment pipeline:** GitHub Actions builds the site and deploys the static
  assets and Pages Function with Wrangler.
- **Pages project:** `nba-swagger`.
- **Production branch:** `main`.
- **Public hostname:** use the default `nba-swagger.pages.dev` hostname; no
  custom domain is configured.
- **Cloudflare account ID:** supplied by the project owner before workflow
  setup.
- **Credentials:** store a Cloudflare API token scoped to Pages deployment as a
  GitHub Actions secret
  (for example, `CLOUDFLARE_API_TOKEN`). Do not commit it or put it in this
  document. The account ID can be supplied to the workflow as a repository
  variable or secret.
- **Branch previews:** not included in the production deployment setup. A
  preview deployment is a separate Pages URL built from a non-production branch
  or pull request; it does not update the `main` production deployment. Preview
  deployments can be configured separately if needed.
- **Runtime versions:** retain the repository’s current Node/pnpm configuration
  without introducing new version pins as part of this deployment setup.

The Pages project must exist before the first non-interactive Wrangler deploy.
Pull requests and pushes to `main` run the build without deploying. Production
deployment is started manually with GitHub Actions’ **Run workflow** action on
the `main` branch; the static assets and Pages Function deploy from the same
revision.

## Request handling

The Function must:

1. Accept only `GET` requests for explicitly supported Stats or Live paths.
2. Validate the endpoint against an explicit allowlist. Currently enabled Stats
   routes: `alltimeleadersgrids`. Enabled Live routes: the four endpoints listed
   in `endpoints.md`. Other entries in the endpoint inventory are not enabled.
   Reject unknown paths; never accept a caller-provided hostname or arbitrary
   upstream URL.
3. Forward query parameters to the fixed upstream endpoint without duplicating
   the OpenAPI parameter schema in the Function. Enforce only the overall query
   string length limit.
4. Map the request to its fixed NBA origin and add the upstream headers required
   by that API family. Do not depend on browser-supplied `Origin`, `Referer`, or
   `User-Agent` headers.
5. Return the upstream status and JSON response with an appropriate JSON
   content type. Do not return a Pages fallback document as a successful API
   response. Convert non-JSON upstream failures into a clear gateway error.

The Stats mapping preserves the endpoint path after `/api/stats/` under
`https://stats.nba.com/stats/`. The Live mapping appends the path after
`/api/live/` under `https://cdn.nba.com/static/json/liveData/`.

## Security and abuse controls

- Keep the proxy restricted to the fixed NBA hosts, endpoint allowlist, and `GET`
  method. Normalize and validate paths before constructing the upstream URL.
- Limit query-string length without duplicating per-parameter validation from
  the OpenAPI specification.
- Configure Cloudflare rate limiting for `/api/*` before promoting the gateway
  for public use; apply per-client and global limits.
- The Function enforces a 10-second upstream timeout and a 5 MiB response limit.
- Do not expose an open proxy, forward browser cookies or authorization headers,
  or place credentials in the Swagger document or static assets.
- Keep any required private configuration in Cloudflare environment bindings
  or secrets. Never treat a public Swagger API key as a secret.
- Same-origin routing does not require permissive CORS headers. If the public
  site and API are later split across hostnames, allow only the exact production
  site origin and handle preflight requests explicitly.
- Follow NBA.com’s Terms of Use and any applicable data-use restrictions.

## Caching

The Function returns `Cache-Control: no-store`. Add Cloudflare caching
only where permitted by NBA.com’s terms and the endpoint’s freshness
requirements. Cache keys must include the complete, validated query string. Do
not cache errors, malformed responses, or rate-limit responses. If caching is
not permitted or freshness is uncertain, do not cache the response.

## Failure behavior and operations

- Preserve upstream non-success status codes where useful; return a gateway
  error for timeouts, invalid JSON, or upstream HTML/block pages. Never label
  an HTML error response as a successful JSON response.
- Log request family, allowlisted endpoint, status, duration, and a correlation
  identifier. Avoid logging full query strings or response bodies by default.
- Monitor gateway 4xx/5xx rates, upstream timeouts, rate limiting, and cache
  behavior. Set alerts for sustained upstream failures.
- Deploy the Function with the Pages assets from the same reviewed source
  revision so the published OpenAPI paths and gateway routes remain in sync.

## Production request paths

| Public path | Upstream target |
| --- | --- |
| `/api/stats/alltimeleadersgrids` | `https://stats.nba.com/stats/alltimeleadersgrids` |
| `/api/live/scoreboard/todaysScoreboard_00.json` | `https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json` |

The Stats route is the currently described Swagger operation. The Live route
shows the production path convention for the Live endpoints maintained in
`endpoints.md`.
