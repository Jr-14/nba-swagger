import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NBA_BROWSER_HEADERS } from "./shared/nba-headers.ts";
import { configureProxyServer } from "./shared/openapi-proxy.mjs";

export default defineConfig({
  plugins: [{
    name: "nba-proxy-openapi",
    apply: "build",
    enforce: "pre",
    load(id) {
      const specPath = fileURLToPath(new URL("./src/openapi.yml", import.meta.url));
      if (id !== `${specPath}?url` || !process.env.VITE_PROXY_URL) return;

      // Configure the actual emitted spec, not just Swagger's in-memory copy.
      // Emitting before bundling also keeps the asset's content hash correct.
      const source = configureProxyServer(
        readFileSync(specPath, "utf8"),
        process.env.VITE_PROXY_URL,
      );
      const asset = this.emitFile({ type: "asset", name: "openapi.yml", source });
      return `export default import.meta.ROLLUP_FILE_URL_${asset};`;
    },
  }],
  server: {
    proxy: {
      "/api/stats": {
        target: "https://stats.nba.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/stats/, "/stats"),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            for (const [name, value] of Object.entries(NBA_BROWSER_HEADERS)) {
              proxyReq.setHeader(name, value);
            }
          });
        },
      },
      "/api/live": {
        target: "https://cdn.nba.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/live/, "/static/json/liveData"),
      },
    },
  },
});
