# nba-swagger
NBA Swagger Docs. Documenting the undocumented

https://nba-swagger.pages.dev/

## Development

Requirements: Node 24, pnpm 12, and Docker.

```bash
pnpm install
pnpm dev
```

Open **http://localhost:5173**. This builds the Node proxy image, starts it on
**http://127.0.0.1:8080**, and serves Swagger UI with Vite. Vite forwards `/api`
and `/health` to the container, so requests use the same Node application that
runs in production. The first run builds the image and can take a few minutes.

This mode tests the Node proxy only. It does not emulate the Worker gateway,
CORS policy, or rate limiting. Use `pnpm dev:wrangler` or `pnpm dev:pages` on
hosts where Wrangler's local containers work.

Useful alternatives:

```bash
pnpm dev:node     # direct Node process, without Docker or Wrangler
pnpm dev:clean    # remove dev containers and the local image
pnpm dev:wrangler # Worker, Durable Object, rate limiter, and container in Wrangler
pnpm dev:worker   # Wrangler backend only, without Vite
pnpm dev:pages    # built static Pages plus Worker/container emulation
```

See [development](docs/development.md) for details and
[architecture](docs/architecture.md) for deployment and transport findings.

# License and terms of use
Data retrieved with this package comes from NBA.com and is subject to the NBA.com [Terms of Use](https://www.nba.com/termsofuse).

`nba-swagger` is an independent, community-maintained project and is not affiliated with, endorsed by, or sponsored by the NBA.
