import type { Server } from "node:http";
import { HTTP_KEEP_ALIVE_TIMEOUT_MS } from "@gennety/shared";

/**
 * Keep idle connections open longer than Caddy does (see
 * `HTTP_KEEP_ALIVE_TIMEOUT_MS`), so the proxy closes them first and never sends
 * a request down a socket Node is closing.
 */
export function applyProxyKeepAlive(server: Server): void {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS + 1_000;
}
