import type { Request, Response, NextFunction } from "express";
import { DB_POOL_BUSY_RETRY_AFTER_SECONDS } from "@gennety/shared";
import { multerErrorResponse } from "../utils/upload-limits.js";

/**
 * The code of a Prisma known-request error, or null. Matched by name rather
 * than `instanceof Prisma.PrismaClientKnownRequestError` so the handler does
 * not depend on the generated client's class identity (route suites mock
 * `@gennety/db` wholesale).
 */
function prismaKnownErrorCode(err: unknown): string | null {
  if (!(err instanceof Error) || err.name !== "PrismaClientKnownRequestError") return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * The public API's last-resort error handler. Its own module so it can be
 * tested without booting every router `server.ts` mounts.
 */
export function publicErrorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // body-parser surfaces PayloadTooLargeError (413) and SyntaxError (400)
  // with a proper `.status`. Honor 4xx client errors instead of masking them
  // as 500 — the client needs the right code to distinguish retryable bugs
  // from its own malformed request.
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ error: err.message });
    return;
  }
  // multer carries no `.status`, so an oversized voice note or a wrong field
  // name on a route without its own wrapper fell through to 500 (audit B-07/08).
  const upload = multerErrorResponse(err);
  if (upload) {
    res.status(upload.status).json(upload.body);
    return;
  }
  // A lookup that raced a delete (P2025) or an id Postgres cannot parse
  // (P2023) is the caller's problem, not an outage (audit B-19).
  const prismaCode = prismaKnownErrorCode(err);
  if (prismaCode === "P2025") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (prismaCode === "P2023") {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // P2024: no pool connection freed up within `pool_timeout` — the process is
  // saturated (typically a cron burst), not broken. A 503 with Retry-After
  // tells the app to retry shortly instead of showing a hard failure.
  if (prismaCode === "P2024") {
    console.warn("[public] DB pool exhausted — answering 503:", err.message);
    res.setHeader("Retry-After", String(DB_POOL_BUSY_RETRY_AFTER_SECONDS));
    res.status(503).json({ error: "Service busy, retry shortly" });
    return;
  }
  console.error("[public] unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
}
