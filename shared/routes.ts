export interface UpstreamRoute {
  url: URL;
  family: "stats" | "live";
}

const fixedLivePaths = new Set([
  "odds/odds_todaysGames.json",
  "scoreboard/todaysScoreboard_00.json",
]);

// One route allowlist shared by the gateway and Node service. Query parameter
// definitions remain in OpenAPI, not in a second validator.
export function resolveUpstream(requestUrl: URL): UpstreamRoute | null {
  if (requestUrl.pathname === "/api/stats/alltimeleadersgrids") {
    const url = new URL("https://stats.nba.com/stats/alltimeleadersgrids");
    url.search = requestUrl.search;
    return { url, family: "stats" };
  }

  if (!requestUrl.pathname.startsWith("/api/live/")) return null;
  const path = requestUrl.pathname.slice("/api/live/".length);
  if (
    !fixedLivePaths.has(path) &&
    !/^boxscore\/boxscore_\d{10}\.json$/.test(path) &&
    !/^playbyplay\/playbyplay_\d{10}\.json$/.test(path)
  ) return null;

  const url = new URL(path, "https://cdn.nba.com/static/json/liveData/");
  url.search = requestUrl.search;
  return { url, family: "live" };
}
