import { Hono } from "hono";
import { NBA_BROWSER_HEADERS } from "../../shared/nba-headers.ts";

const UPSTREAM_URL = "https://stats.nba.com/stats/alltimeleadersgrids?LeagueID=20&PerMode=PerGame&SeasonType=Regular%20Season&TopX=2";
const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 256 * 1024;

async function readBody(response: Response): Promise<string> {
  if (!response.body) throw new Error("Empty upstream body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("Upstream body exceeds probe limit");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

const app = new Hono();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (c.req.method !== "GET") {
    c.header("Allow", "GET");
    return c.json({ ok: false, error: "Only GET is supported" }, 405);
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true, runtime: "node", nodeVersion: process.versions.node }));

app.get("/probe", async (c) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  c.header("X-Request-ID", requestId);
  try {
    // This executes in real Node inside the container, never Worker fetch.
    // There is no caller-provided target or parameter passthrough in this POC.
    const response = await fetch(UPSTREAM_URL, {
      headers: {
        ...NBA_BROWSER_HEADERS,
        accept: "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.5",
        "accept-encoding": "identity",
        connection: "close",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const body = await readBody(response);
    const metadata = {
      requestId,
      runtime: "node",
      nodeVersion: process.versions.node,
      upstreamStatus: response.status,
      upstreamContentType: contentType,
      durationMs: Date.now() - startedAt,
    };
    if (!response.ok || !contentType.toLowerCase().includes("json")) {
      console.error(JSON.stringify({ event: "container_probe_non_success", ...metadata, bodyPreview: body.slice(0, 2048) }));
      return c.json({ ok: false, ...metadata, error: "NBA did not return a successful JSON response" }, 502);
    }

    const payload: unknown = JSON.parse(body);
    if (
      typeof payload !== "object" || payload === null ||
      !("resource" in payload) || payload.resource !== "alltimeleadersgrids" ||
      !("resultSets" in payload) || !Array.isArray(payload.resultSets)
    ) {
      return c.json({ ok: false, ...metadata, error: "Unexpected NBA JSON response shape" }, 502);
    }
    console.log(JSON.stringify({ event: "container_probe_success", ...metadata }));
    return c.json({
      ok: true, ...metadata, resource: payload.resource,
      resultSetCount: payload.resultSets.length,
    });
  } catch (error) {
    const timeout = error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name);
    const result = {
      ok: false,
      requestId,
      runtime: "node",
      nodeVersion: process.versions.node,
      durationMs: Date.now() - startedAt,
      error: timeout ? "NBA request timed out" : "NBA request or JSON parsing failed",
    };
    console.error(JSON.stringify({ event: "container_probe_failure", ...result }));
    return c.json(result, timeout ? 504 : 502);
  }
});

app.notFound((c) => c.json({ ok: false, error: "Not found" }, 404));

export default app;
