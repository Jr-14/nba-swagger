export function configureProxyServer(source, proxyUrl) {
  // Only local tooling overrides this value. Production uses the public URL
  // committed in the OpenAPI source, not a required environment variable.
  let value = proxyUrl;
  if (proxyUrl !== "/api") {
    const url = new URL(proxyUrl);
    const localHttp = url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !localHttp) ||
      url.username || url.password || url.search || url.hash ||
      url.pathname.replace(/\/$/, "") !== "/api"
    ) {
      throw new Error("Proxy URL must be an HTTPS URL ending in /api (HTTP is allowed for localhost only)");
    }
    value = url.href.replace(/\/$/, "");
  }

  const marker = /(^servers:\r?\n  - url: )[^\r\n]+/m;
  if (!marker.test(source)) {
    throw new Error("Could not find the proxy server entry in src/openapi.yml");
  }
  return source.replace(marker, (_, prefix) => `${prefix}${JSON.stringify(value)}`);
}
