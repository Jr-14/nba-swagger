import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/nba-stats": {
        target: "https://stats.nba.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nba-stats/, ""),
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Referer", "https://www.nba.com/");
            proxyReq.setHeader("Origin", "https://www.nba.com");
            proxyReq.setHeader(
              "User-Agent",
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            );
          });
        },
      },
      "/nba-live": {
        target: "https://cdn.nba.com/static/json/liveData",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nba-live/, ""),
      },
    },
  },
});
