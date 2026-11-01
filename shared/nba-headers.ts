// Keep the explicitly configured NBA headers consistent across both dev runtimes.
// The runtimes can still add transport headers of their own.
export const NBA_BROWSER_HEADERS = {
  origin: "https://www.nba.com",
  referer: "https://www.nba.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};
