import { Container } from "@cloudflare/containers";
import app from "./gateway.ts";

export class NbaProxy extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
  // Node makes NBA HTTPS requests directly; do not install outbound intercepts.
}

export default app;
