import { NBA_BROWSER_HEADERS } from "../../shared/nba-headers.ts";

type DiagnosticBindings = {
  HEADER_ECHO_URL: string;
  DIAGNOSTIC_TIMEOUT_MS: string;
};

// Used only by diagnose:upstream, never by the production Worker or CI.
export default {
  async fetch(request, env) {
    const capture = new URL(request.url).pathname === "/headers";
    const startedAt = Date.now();
    try {
      const response = await fetch(capture ? env.HEADER_ECHO_URL :
        "https://stats.nba.com/stats/alltimeleadersgrids?LeagueID=20&PerMode=PerGame&SeasonType=Regular%20Season&TopX=2", {
        headers: {
          ...NBA_BROWSER_HEADERS,
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.5",
          "accept-encoding": "identity",
          connection: "close",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(Number(env.DIAGNOSTIC_TIMEOUT_MS)),
      });
      if (capture) return Response.json(await response.json());

      const result = {
        status: response.status,
        contentType: response.headers.get("content-type"),
        durationMs: Date.now() - startedAt,
      };
      await response.body?.cancel();
      return Response.json(result);
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.name : "UnknownError",
        durationMs: Date.now() - startedAt,
      });
    }
  },
} satisfies ExportedHandler<DiagnosticBindings>;
