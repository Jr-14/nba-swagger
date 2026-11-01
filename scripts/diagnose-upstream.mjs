import http from "node:http";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NBA_BROWSER_HEADERS } from "../shared/nba-headers.ts";

const upstream = new URL("https://stats.nba.com/stats/alltimeleadersgrids?LeagueID=20&PerMode=PerGame&SeasonType=Regular%20Season&TopX=2");
const timeoutMs = 8_000;
const headers = {
  ...NBA_BROWSER_HEADERS,
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.5",
  "accept-encoding": "identity",
};
const report = (client, result) => console.log(JSON.stringify({ client, ...result }));

async function nodeFetch() {
  const startedAt = Date.now();
  try {
    const response = await fetch(upstream, {
      headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    });
    report("node-fetch", {
      status: response.status, contentType: response.headers.get("content-type"),
      durationMs: Date.now() - startedAt,
    });
    await response.body?.cancel();
  } catch (error) {
    report("node-fetch", { error: error.name, durationMs: Date.now() - startedAt });
  }
}

async function rawNodeRequest(connection) {
  return new Promise((done) => {
    const startedAt = Date.now();
    let finished = false;
    const socket = tls.connect({
      host: upstream.hostname, servername: upstream.hostname, port: 443,
      ALPNProtocols: ["http/1.1"],
    }, () => {
      // These requests differ only in the Connection header. No certificate
      // verification is disabled and no upstream URLs are caller-controlled.
      socket.write([
        `GET ${upstream.pathname}${upstream.search} HTTP/1.1`,
        `Host: ${upstream.hostname}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        ...(connection ? [`Connection: ${connection}`] : []), "", "",
      ].join("\r\n"));
    });
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      report("node-tls", { connection, ...result, durationMs: Date.now() - startedAt });
      socket.destroy();
      done();
    };
    const timer = setTimeout(() => finish({ error: "diagnostic_timeout" }), timeoutMs);
    socket.once("data", (bytes) => finish({
      statusLine: bytes.toString("latin1").split("\r\n")[0],
      remoteAddress: socket.remoteAddress, tls: socket.getProtocol(),
    }));
    socket.once("error", (error) => finish({ error: error.code ?? error.name }));
    socket.once("end", () => finish({ error: "closed_without_response" }));
  });
}

async function workerd() {
  const echo = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    // Only report the headers relevant to this investigation, not full requests.
    response.end(JSON.stringify({
      connectionReceived: request.headers.connection ?? null,
      encodingReceived: request.headers["accept-encoding"] ?? null,
      cfWorkerAdded: Boolean(request.headers["cf-worker"]),
    }));
  });
  await new Promise((done) => echo.listen(0, "127.0.0.1", done));
  const echoUrl = `http://127.0.0.1:${echo.address().port}`;
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("wrangler/package.json");
  const { bin } = JSON.parse(readFileSync(packagePath, "utf8"));
  const cli = resolve(dirname(packagePath), bin.wrangler);
  const child = spawn(process.execPath, [cli, "dev", "--config",
    "scripts/fixtures/wrangler.diagnostic.jsonc", "--port", "0",
    "--show-interactive-dev-session=false", "--var", `HEADER_ECHO_URL:${echoUrl}`,
    "--var", `DIAGNOSTIC_TIMEOUT_MS:${timeoutMs}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cleanup = () => { child.kill("SIGTERM"); echo.closeAllConnections(); echo.close(); };
  const interrupt = () => { cleanup(); process.exitCode = 130; };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const localUrl = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Wrangler startup timed out")), 20_000);
      let output = "";
      const inspect = (chunk) => {
        output += chunk.toString();
        const ready = output.match(/Ready on (http:\/\/localhost:\d+)/);
        if (ready) { clearTimeout(timer); done(ready[1]); }
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Wrangler exited with code ${code} before startup`));
      });
    });
    for (const path of ["headers", "nba"]) {
      const response = await fetch(`${localUrl}/${path}`, {
        signal: AbortSignal.timeout(timeoutMs + 2_000),
      });
      report(`workerd-${path}`, await response.json());
    }
  } finally {
    cleanup();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

console.log("Live diagnostic: four bounded NBA requests; no deploy, credentials, or response bodies logged.");
await nodeFetch();
await rawNodeRequest("close");
await rawNodeRequest(null);
await workerd();
