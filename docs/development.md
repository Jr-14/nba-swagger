# Development

## Fast local development

```bash
pnpm install
pnpm dev
```

Open the Vite URL, normally **http://localhost:5173**. This command starts the
same Node proxy application used in the container on loopback port 8080.
Vite forwards `/api/*` to that service; it no longer has a separate direct-NBA
proxy. Select **NBA API proxy** in Swagger. Docker is not required for this mode.

Use `PROXY_PORT` to select a different Node port if necessary. `pnpm dev:proxy`
runs just the Node service, using `HOST`/`PORT` (default `0.0.0.0:8080`); bind
`HOST=127.0.0.1` if running it directly outside Docker on an untrusted network.

## Full Cloudflare runtime locally

```bash
pnpm dev:pages
```

Docker must be running. This builds the UI, starts static Pages on
**http://localhost:8788**, and starts the actual Worker/container gateway on port
8787. The generated local OpenAPI points to that gateway, whose CORS origin is
the local Pages site. `PAGES_PORT` and `WORKER_PORT` can override these ports.
Restart the command to rebuild static UI/OpenAPI changes.

`pnpm dev:worker` starts only the Worker/container stack on port 8787. Do not
run it alongside `dev:pages`, which already starts it. No probe token is used.

On Linux/Tailscale hosts, Wrangler's sidecar startup may fail before creating
the Node container, as described in [architecture.md](architecture.md). Use
`pnpm dev` or plain Docker to test the Node service in that case. Do not change
global networking settings just to make this command run. Fast development
does not emulate Worker CORS/rate limits or container cold starts.

## Plain Docker

```bash
pnpm build:container
docker run --rm -p 127.0.0.1:8080:8080 nba-swagger-proxy:local
```

Request `/health` to verify Node startup, or test the real endpoint:

```bash
curl --fail-with-body 'http://localhost:8080/api/stats/alltimeleadersgrids?LeagueID=20&PerMode=PerGame&SeasonType=Regular%20Season&TopX=2'
```

The response is the full NBA JSON. `/probe` no longer exists. The four Live
routes remain under `/api/live/`; the endpoint inventory does not automatically
enable additional Stats endpoints.

## Checks

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm build:worker
```

These commands do not deploy or make NBA requests. `build:worker` is a Wrangler
dry run and builds the Node image, so Docker and registry/network access for
dependencies are required. Tests mock upstream traffic and cover gateway-to-Node
forwarding, full responses, CORS, rate limiting, concurrency, timeouts, size
limits, and Live JSON served as `text/plain`.

Production uses the public proxy URL in `src/openapi.yml`. Local tooling
overrides it automatically; there is no required `VITE_PROXY_URL` setting. Only
the local full-runtime build uses the internal `LOCAL_PROXY_URL` override.

## Production verification and logs

Deploy the backend and Pages manually as described in
[architecture.md](architecture.md). No browser token is required. A successful
`/health` proves only container startup; verify the NBA endpoint separately.

```bash
pnpm exec wrangler tail --config wrangler.worker.jsonc
```

Match `x-request-id` from the browser to gateway/Node logs. Container startup
errors, non-JSON upstream responses, JSON parsing failures, and timeouts produce
distinct diagnostics. Error-body previews are bounded and server-side only.
Historical native-workerd findings remain in the architecture document; the
experimental diagnostic scripts and committed Wrangler state have been removed
from the tracked project.
