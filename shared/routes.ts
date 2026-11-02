export interface UpstreamRoute {
  url: URL;
  family: "stats" | "live";
}

const statsPaths = new Set([
  "alltimeleadersgrids",
  "assistleaders",
  "assisttracker",
  "boxscoreadvancedv2",
  "boxscoreadvancedv3",
  "boxscoredefensivev2",
  "boxscorefourfactorsv2",
  "boxscorefourfactorsv3",
  "boxscorehustlev2",
  "boxscorematchupsv3",
  "boxscoremiscv2",
  "boxscoremiscv3",
  "boxscoreplayertrackv3",
  "boxscorescoringv2",
  "boxscorescoringv3",
  "boxscoresummaryv2",
  "boxscoresummaryv3",
  "boxscoretraditionalv2",
  "boxscoretraditionalv3",
  "boxscoreusagev2",
  "boxscoreusagev3",
  "commonallplayers",
  "commonplayerinfo",
  "commonplayoffseries",
  "commonteamroster",
  "commonteamyears",
  "cumestatsplayer",
  "cumestatsplayergames",
  "cumestatsteam",
  "cumestatsteamgames",
  "defensehub",
  "draftboard",
  "draftcombinedrillresults",
  "draftcombinenonstationaryshooting",
  "draftcombineplayeranthro",
  "draftcombinespotshooting",
  "draftcombinestats",
  "drafthistory",
  "dunkscoreleaders",
  "fantasywidget",
  "franchisehistory",
  "franchiseleaders",
  "franchiseplayers",
  "gamerotation",
  "glalumboxscoresimilarityscore",
  "gravityleaders",
  "homepageleaders",
  "homepagev2",
  "hustlestatsboxscore",
  "infographicfanduelplayer",
  "iststandings",
  "leaderstiles",
  "leaguedashlineups",
  "leaguedashoppptshot",
  "leaguedashplayerbiostats",
  "leaguedashplayerclutch",
  "leaguedashplayerptshot",
  "leaguedashplayershotlocations",
  "leaguedashplayerstats",
]);

const fixedLivePaths = new Set([
  "odds/odds_todaysGames.json",
  "scoreboard/todaysScoreboard_00.json",
]);

// One route allowlist shared by the gateway and Node service. Query parameter
// definitions remain in OpenAPI, not in a second validator.
export function resolveUpstream(requestUrl: URL): UpstreamRoute | null {
  const statsPrefix = "/api/stats/";
  if (requestUrl.pathname.startsWith(statsPrefix)) {
    const endpoint = requestUrl.pathname.slice(statsPrefix.length);
    if (!statsPaths.has(endpoint)) return null;
    const url = new URL(`https://stats.nba.com/stats/${endpoint}`);
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
