export function configureProxyServer(source, proxyUrl) {
  const url = new URL(proxyUrl);
  const localHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localHttp) ||
    url.username || url.password || url.search || url.hash ||
    url.pathname.replace(/\/$/, "") !== "/api"
  ) {
    throw new Error("VITE_PROXY_URL must be an HTTPS URL ending in /api (HTTP is allowed for localhost only)");
  }

  const marker = "  - url: /api\n";
  if (!source.includes(marker)) {
    throw new Error("Could not find the proxy server entry in src/openapi.yml");
  }
  return source.replace(marker, `  - url: ${JSON.stringify(url.href.replace(/\/$/, ""))}\n`);
}
