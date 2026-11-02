# Development

## Requirements

- Node.js 24
- pnpm 12
- Docker for the default local container flow

Install dependencies once:

```bash
pnpm install
```

## Primary development flow

```bash
pnpm dev
```

Open **http://localhost:5173**. The command:

1. Builds the Node proxy image from `containers/proxy/Dockerfile`.
2. Starts it in Docker on loopback port 8080.
3. Waits for the container's `/health` endpoint.
4. Starts Vite and serves Swagger UI.

Vite forwards `/api` and `/health` to the container, so the UI and container use
the same origin in the browser. Swagger uses the relative `/api` server route and
therefore exercises the real Node application without CORS configuration.

The first run builds the image and can take a few minutes. Later runs reuse the
image layers and Docker's build cache, so only changed source layers are rebuilt.

This mode tests **the Node proxy only**. It does not emulate the production
Worker gateway, its CORS policy, the rate limiter, or Durable Object routing.
Use the Wrangler flow below when those layers need to be exercised.

### Editing code

- UI and OpenAPI changes: Vite updates them automatically.
- Node proxy or `shared/` changes: restart `pnpm dev` to rebuild and replace the
  container. Container source and dependencies are not hot-reloaded.
- Dockerfile or dependency changes: restart `pnpm dev`; Docker rebuilds from the
  changed layer.

The image is built every time the command starts, so a restart is the reliable
way to pick up proxy changes.

### Ports and image settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `UI_PORT` | `5173` | Vite and Swagger UI port |
| `PROXY_PORT` | `8080` | Host port mapped to the container's port 8080 |
| `PROXY_IMAGE` | `nba-swagger-proxy:local` | Local image name and tag |
| `DOCKER_PLATFORM` | `linux/amd64` | Build platform; matches the deployed container |

```bash
UI_PORT=5174 PROXY_PORT=8081 pnpm dev
```

`UI_PORT` and `PROXY_PORT` must differ. The container is published on
`127.0.0.1` only, so the Node service is not exposed to the local network.

### Container lifecycle

Each run names its container `nba-swagger-dev-<pid>` and labels it
`com.nba-swagger.dev=true`. The container is detached, but the script stops it on
`SIGINT`/`SIGTERM`; `--rm` removes it after it exits.

For a full reset, including the built image:

```bash
pnpm dev:clean
```

This removes containers labelled `com.nba-swagger.dev=true` and any containers
created from the local image, then removes the image. It also cleans up a
container left behind by an abruptly killed run. The next `pnpm dev` rebuilds
the image. Set `PROXY_IMAGE` to clean a differently named image.

The underlying Docker commands remain available for inspection:

```bash
docker ps --filter label=com.nba-swagger.dev=true
docker ps -aq --filter label=com.nba-swagger.dev=true | xargs -r docker rm -f
```

### Testing the container directly

Both paths are available while `pnpm dev` is running:

```bash
curl --fail-with-body http://127.0.0.1:8080/health

curl --fail-with-body 'http://127.0.0.1:8080/api/stats/alltimeleadersgrids?LeagueID=20&PerMode=PerGame&SeasonType=Regular%20Season&TopX=2'
```

The second request returns the full NBA JSON. `/probe` no longer exists. The four
Live routes remain under `/api/live/`; the endpoint inventory does not
automatically enable additional Stats endpoints.

To run the image without Vite:

```bash
pnpm build:container
docker run --rm --name nba-swagger-manual -p 127.0.0.1:8080:8080 nba-swagger-proxy:local
```

## Wrangler emulation (optional)

On hosts where Wrangler's local containers work, this runs the complete local
stack:

```bash
pnpm dev:wrangler
```

| Process | Default URL | Responsibility |
| --- | --- | --- |
| Vite | `http://localhost:5173` | Swagger UI, UI rebuilds, local OpenAPI asset |
| Wrangler | `http://localhost:8787` | Worker gateway, Durable Object, rate limiter, container |

Vite forwards `/api` and `/health` to Wrangler. Browser requests then pass
through the emulated Worker, including route guards, request-ID propagation,
rate limiting, CORS, and container forwarding. Requests made directly to port
8787 can be used to inspect CORS behavior.

Wrangler builds the container image itself and starts it in local Docker.
- `UI_PORT` changes the Vite port (default `5173`).
- `WORKER_PORT` changes the Wrangler port (default `8787`).
- `DEV_ORIGIN` changes the development CORS origin passed to the Worker. It
  defaults to `http://localhost:<UI_PORT>`.

```bash
UI_PORT=5174 WORKER_PORT=8788 DEV_ORIGIN=http://localhost:5174 pnpm dev:wrangler
```

Worker or gateway changes reload automatically. Node proxy or `shared/` changes
require pressing `r` in the Wrangler terminal to rebuild and restart the
container. Wrangler stores local Durable Object state under `.wrangler/`, which
is ignored by Git. The local container does not enforce `max_instances`.

### Wrangler backend only

```bash
pnpm dev:worker
```

Runs Wrangler and the container on port 8787 without Vite. Use it for direct API
testing with `curl`. It still requires Docker and functional local containers.

### Full Pages emulation

```bash
pnpm dev:pages
```

Builds the exact static output and runs both Wrangler emulators:

- Static Pages at **http://localhost:8788**
- Worker and container at **http://localhost:8787**

This serves the built `dist/` output, so UI changes require a restart. It is
useful for validating static asset paths and the production OpenAPI build.
`PAGES_PORT` and `WORKER_PORT` override the ports.

### Known Wrangler container limitation

On Linux hosts with `net.ipv4.conf.all.src_valid_mark=1`, commonly set by
Tailscale, Wrangler's local container sidecar can fail before the application
container is created. This is the upstream issue described in
[workerd #6860](https://github.com/cloudflare/workerd/issues/6860), not an error
in this project.

Symptoms include the sidecar restarting repeatedly and `Container failed to
start`, or a request hanging before the Node container appears in
`docker events`. Use the default Docker flow or `pnpm dev:node` until the
Wrangler issue is resolved. Do not change global networking or sysctl settings
solely to make local emulation work without understanding their effect on VPN,
Tailscale, or Docker.

## Direct Node fallback

```bash
pnpm dev:node
```

Starts Vite and the Node proxy directly on port 8080, with no Docker or Wrangler.
Use it when Docker is unavailable or when debugging the Node service in
isolation. `PROXY_PORT` overrides the Node port.

This is the least production-like mode: it bypasses the container, Worker,
Durable Object, rate limiter, and gateway behavior.

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
the full Pages build uses the internal `LOCAL_PROXY_URL` override.

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
