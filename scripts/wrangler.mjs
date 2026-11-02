import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const wranglerPackage = require.resolve("wrangler/package.json");
const { bin } = JSON.parse(readFileSync(wranglerPackage, "utf8"));
const wranglerPath = resolve(dirname(wranglerPackage), bin.wrangler);

export function spawnWrangler(args, options = {}) {
  return spawn(process.execPath, [wranglerPath, ...args], {
    stdio: "inherit",
    ...options,
  });
}
