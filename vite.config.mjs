import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configureProxyServer } from "./shared/openapi-proxy.mjs";

export default defineConfig(({ command }) => {
  const specPath = fileURLToPath(new URL("./src/openapi.yml", import.meta.url));
  const localProxyUrl = command === "serve" ? "/api" : process.env.LOCAL_PROXY_URL;
  const localSpec = () => configureProxyServer(readFileSync(specPath, "utf8"), localProxyUrl);
  return {
    plugins: [{
      name: "nba-local-openapi",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url, "http://localhost");
          if (url.pathname !== "/openapi.yml" || url.searchParams.has("url") || url.searchParams.has("import")) return next();
          response.setHeader("Content-Type", "application/yaml; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(localSpec());
        });
      },
      load(id) {
        if (id !== `${specPath}?url` || !localProxyUrl) return;
        if (command === "serve") return 'export default "/openapi.yml";';
        const asset = this.emitFile({ type: "asset", name: "openapi.yml", source: localSpec() });
        return `export default import.meta.ROLLUP_FILE_URL_${asset};`;
      },
    }],
    server: {
      proxy: {
        // Fast development runs the same Node service as the container, not a
        // separate Vite-to-NBA implementation with different HTTP behavior.
        "/api": { target: `http://127.0.0.1:${process.env.PROXY_PORT ?? 8080}`, changeOrigin: true },
        "/health": { target: `http://127.0.0.1:${process.env.PROXY_PORT ?? 8080}`, changeOrigin: true },
      },
    },
  };
});
