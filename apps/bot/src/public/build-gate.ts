import type { Request, Response, NextFunction } from "express";
import { env } from "../config.js";

/**
 * Forced-update gate by build number (audit C-23, contract decision #3).
 *
 * `GET /v1/app/config → minSupportedIosVersion` only works if the client
 * chooses to read it; this is the server's half. Every native request carries
 * `X-Gennety-Build: <CFBundleVersion>`, and one below `MIN_IOS_BUILD` is
 * refused with 426 `{ error: "update_required" }` before any router runs.
 *
 * Fails open by design: the floor is off at 0, and a request without the
 * header (the Mini App, older builds, webhooks) or with a value that is not a
 * plain integer passes untouched — the gate must never lock out a client it
 * cannot identify.
 */
export function requireMinBuild(req: Request, res: Response, next: NextFunction): void {
  const floor = env.MIN_IOS_BUILD;
  if (floor > 0) {
    const raw = req.get("x-gennety-build")?.trim();
    if (raw && /^\d{1,9}$/.test(raw) && Number(raw) < floor) {
      res.status(426).json({ error: "update_required" });
      return;
    }
  }
  next();
}
