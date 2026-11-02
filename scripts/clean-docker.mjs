import { execFileSync } from "node:child_process";

const image = process.env.PROXY_IMAGE ?? "nba-swagger-proxy:local";
const label = "com.nba-swagger.dev=true";

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function containerIds(filters) {
  const args = ["ps", "-aq"];
  for (const filter of filters) args.push("--filter", filter);
  return docker(args).split(/\s+/).filter(Boolean);
}

function errorMessage(error) {
  return String(error.stderr ?? "").trim() || error.message;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: pnpm dev:clean

Removes containers labelled ${label} or created from ${image}, then removes the
image. Set PROXY_IMAGE to clean a differently named image.`);
  process.exit(0);
}

let ids;
try {
  ids = [...new Set([
    ...containerIds([`label=${label}`]),
    ...containerIds([`ancestor=${image}`]),
  ])];
} catch (error) {
  console.error(`Could not query Docker. Is the Docker daemon running?\n${errorMessage(error)}`);
  process.exit(1);
}

if (ids.length === 0) {
  console.log("No dev containers found.");
} else {
  try {
    docker(["rm", "-f", ...ids], { stdio: "inherit" });
    console.log(`Removed ${ids.length} dev container${ids.length === 1 ? "" : "s"}.`);
  } catch (error) {
    console.error(`Could not remove one or more dev containers.\n${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

let imageExists = true;
try {
  docker(["image", "inspect", image], { stdio: "ignore" });
} catch {
  imageExists = false;
}

if (!imageExists) {
  console.log(`Image ${image} not found; nothing to remove.`);
} else {
  try {
    docker(["image", "rm", image], { stdio: "inherit" });
    console.log(`Removed image ${image}.`);
  } catch (error) {
    console.error(`Could not remove image ${image}.\n${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Docker dev cleanup complete. The next `pnpm dev` will rebuild the image.");
