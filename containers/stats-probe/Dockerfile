FROM node:24-bookworm-slim
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@12.17.0 --activate \
    && pnpm install --prod --frozen-lockfile --ignore-scripts

COPY shared/nba-headers.ts ./shared/nba-headers.ts
COPY containers/stats-probe/app.ts containers/stats-probe/server.ts ./containers/stats-probe/

USER node
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "containers/stats-probe/server.ts"]
