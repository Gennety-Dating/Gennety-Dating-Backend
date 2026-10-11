import type { Response } from "express";
import type { MatchmakingStatus } from "../services/user-status.js";

/**
 * The one check every login rail runs before it mints a session (audit B-05).
 *
 * Moderation revokes a banned account's sessions and the refresh rotation
 * refuses it, but each login endpoint used to sign a fresh pair for whatever
 * account the proof resolved to — so a ban lasted exactly until the next
 * one-time code. Only the permanent ban refuses here (decision 2026-10-11):
 * paused and frozen are the user's own choices and need a session to undo, and
 * the temporary moderation states are left to the existing refresh lock.
 *
 * Answers 403 `{ error: "account_banned" }` and returns true when the caller
 * must stop.
 */
export function refuseBannedLogin(
  user: { status: MatchmakingStatus | null },
  res: Response,
): boolean {
  if (user.status !== "banned") return false;
  res.status(403).json({ error: "account_banned" });
  return true;
}
