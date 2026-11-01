# NBA container proof of concept

This is an isolated experiment, not a replacement for the deployed proxy or
Swagger frontend. The existing `nba-swagger.pages.dev` site, OpenAPI server
configuration, and proxy Worker are unchanged.

```text
Authenticated GET /probe
    → nba-swagger-container-probe Worker
    → NbaStatsProbe Durable Object
    → Linux container running Node + Hono
    → https://stats.nba.com/stats/alltimeleadersgrids
```

The NBA request originates inside Node in the container. No outbound handler
routes it back through Worker `fetch`. It uses the exact query that previously
failed: `LeagueID=20&PerMode=PerGame&SeasonType=Regular%20Season&TopX=2`.
The probe has no caller-controlled upstream host or query parameters.

## Files

- `containers/stats-probe/app.ts`: one fixed NBA request and a health endpoint.
- `containers/stats-probe/server.ts`: real Node HTTP server on port 8080.
- `containers/stats-probe/Dockerfile`: Linux/amd64 Node image, production
  dependencies only, running as the `node` user.
- `src/container-probe.ts`: authenticated Worker-to-container routing.
- `wrangler.container.jsonc`: separate deployment, at most one deployed
  `lite` instance, with a one-minute idle timeout.

The image's build context is allowlisted in `.dockerignore`. Credentials,
environment files, `.git`, and local dependencies are not sent to Docker.

## Run locally with Wrangler

Docker must be running:

```bash
pnpm dev:container
```

In another terminal:

```bash
curl --fail-with-body http://localhost:8789/health \
  -H 'Authorization: Bearer local-test-only'

curl --fail-with-body http://localhost:8789/probe \
  -H 'Authorization: Bearer local-test-only'
```

The local token is intentionally only a development default. Production fails
closed unless the `PROBE_TOKEN` Worker secret is configured.

### Plain Docker comparison

To exercise the Node image independently of Wrangler's container integration:

```bash
pnpm build:container
docker run --rm -p 127.0.0.1:8080:8080 nba-swagger-stats-probe:local
```

Then request `http://localhost:8080/health` or `http://localhost:8080/probe`.
This port is bound to loopback only. Authentication lives at the public Worker;
the internally addressed container does not require a token.

## Deploy the experiment

Prerequisites:

- A Cloudflare account on the Workers Paid plan, with Containers enabled.
- The existing `prod` environment's `CLOUDFLARE_ACCOUNT_ID` variable and
  `CLOUDFLARE_API_TOKEN` secret, with permission to deploy Workers, container
  applications, and images to the target account.
- A new `prod` environment secret named `CONTAINER_PROBE_TOKEN`. Use a long,
  randomly generated value. It is installed as the Worker's `PROBE_TOKEN`
  secret and is never passed to the container or NBA.

Push the source to `main` and manually run **Deploy NBA Container Probe** in
GitHub Actions. This workflow builds the image and deploys a separate Worker
named `nba-swagger-container-probe`. It does not deploy Pages or modify
`nba-swagger-proxy`. Containers can take several minutes to provision on first
deployment; a working Worker URL alone is not proof the container is ready.

Use the deployed URL printed by Wrangler. Set `PROBE_URL` to that URL in your
terminal and `PROBE_TOKEN` to the token you configured, then:

```bash
curl --fail-with-body "$PROBE_URL/probe" \
  -H "Authorization: Bearer $PROBE_TOKEN"
```

Success requires `ok: true`, `runtime: "node"`, `upstreamStatus: 200`, and a
valid NBA `alltimeleadersgrids` JSON response. The endpoint returns metadata
and a result-set count rather than exposing all player data. It uses a
20-second request timeout and 256 KiB response limit for this fixed small query.

Production logs:

```bash
pnpm exec wrangler tail --config wrangler.container.jsonc
```

This experiment can incur Workers, Durable Object, container, and network
charges. Authentication, a fixed instance name, a one-instance cap, and idle
shutdown limit exposure; they are not a monetary budget guarantee. Stop or
remove the isolated deployment when the experiment is complete.

## Results and limitations

- The built image ran successfully in plain Docker: NBA returned JSON `200`,
  `resource: "alltimeleadersgrids"`, and 19 result sets in about 1.3 seconds.
- Worker compilation, image build, TypeScript checks, and offline tests pass.
- The local Wrangler container startup encountered a separate native-Linux
  sidecar failure before the Node application was created. This host has
  `net.ipv4.conf.all.src_valid_mark=1`, matching the symptoms documented in
  [workerd issue 6860](https://github.com/cloudflare/workerd/issues/6860).
  No host networking or Tailscale settings were changed to work around it.
- A deployed Cloudflare Container still needs to be tested. Local Docker
  success does not guarantee access from Cloudflare's container network/IPs.

Only migrate the full proxy after the deployed experiment succeeds. Do not
change `VITE_PROXY_URL` to this probe: it is not a general-purpose API proxy.
