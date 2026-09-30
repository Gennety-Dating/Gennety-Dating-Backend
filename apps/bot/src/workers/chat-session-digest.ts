import {
  sweepChatSessionDigests,
  type ChatDigestSweepResult,
  type DigestDeps,
} from "../services/chat-session-digest.js";

/**
 * Chat-session digest sweep (decision journal 2026-09-30).
 *
 * Titles and summarizes the chats a live turn did not: a chat quiet for 30
 * minutes whose summary is stale (it grew since) or that never got a title.
 * Small batches, freshest first — right after the deploy that added chat
 * sessions this is what works through the backfilled history, ten chats a tick.
 *
 * Cost bound: one `MODELS.fast` call plus one embedding per chat, only for a
 * chat that changed since its last summary, and a chat that keeps failing
 * backs off (in memory) up to a day between attempts. The logic lives in
 * `services/chat-session-digest.ts`; this is the cron entry point.
 */
export async function chatSessionDigestTick(
  deps: DigestDeps & { batch?: number } = {},
): Promise<ChatDigestSweepResult> {
  return sweepChatSessionDigests(deps);
}
