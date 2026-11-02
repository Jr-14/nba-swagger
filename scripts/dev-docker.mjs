import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { parsePort } from "./ports.mjs";

const uiPort = parsePort("UI_PORT", 5173);
const proxyPort = parsePort("PROXY_PORT", 8080);
if (uiPort === proxyPort) {
  throw new Error("UI_PORT and PROXY_PORT must be distinct");
}

const image = process.env.PROXY_IMAGE ?? "nba-swagger-proxy:local";
const platform = process.env.DOCKER_PLATFORM ?? "linux/amd64";
const containerName = `nba-swagger-dev-${process.pid}`;
let containerStarted = false;
let vite;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  await vite?.close();
  if (containerStarted) {
    try {
      execFileSync("docker", ["stop", "--time", "5", containerName], {
        stdio: "ignore",
        timeout: 10_000,
      });
    } catch {
      // The container may already have exited.
    }
  }
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

try {
  console.log(`Building ${image} for ${platform}...`);
  execFileSync("docker", [
    "build",
    "--platform", platform,
    "-f", "containers/proxy/Dockerfile",
    "-t", image,
    ".",
  ], { stdio: "inherit" });

  console.log(`Starting Node proxy container on 127.0.0.1:${proxyPort}...`);
  execFileSync("docker", [
    "run",
    "--rm",
    "--detach",
    "--name", containerName,
    "--label", "com.nba-swagger.dev=true",
    "-p", `127.0.0.1:${proxyPort}:8080`,
    image,
  ], { stdio: "inherit" });
  containerStarted = true;

  let healthy = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.runtime !== "node") throw new Error("Unexpected container health response");
        healthy = true;
        break;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!healthy) {
    execFileSync("docker", ["logs", containerName], { stdio: "inherit" });
    throw new Error("Node proxy container did not become healthy");
  }

  process.env.DEV_PROXY_PORT = String(proxyPort);
  vite = await createServer({
    configFile: "vite.config.mjs",
    root: "src",
    server: { host: "0.0.0.0", port: uiPort, strictPort: true },
  });
  await vite.listen();
  console.log(`Docker Node proxy: http://127.0.0.1:${proxyPort}`);
  vite.printUrls();
} catch (error) {
  console.error(error.message);
  await stop(1);
}
