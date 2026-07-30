import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { isTelegramTarget, toTelegramChatId } from "../utils/telegram-target.js";
import { sendRichMessageDraft, thinkingHtml } from "./telegram-rich.js";

/**
 * The "waiting on your partner" shimmer (PRODUCT_SPEC §3.6b).
 *
 * The two-sided negotiation steps share a shape: one participant commits their
 * side, and the flow then blocks on the other. Those moments used to answer with
 * one flat line ("saved, we'll tell you when they reply") and then nothing —
 * open the chat an hour later and there is no sign the process is alive rather
 * than stuck. Instead of that line, a `<tg-thinking>` shimmer now plays for the
 * WHOLE wait, its text rotating, and disappears when the partner answers.
 *
 * A rich draft is ephemeral (~30s), so "for the whole wait" means it has to be
 * re-issued on a wall-clock interval. That is what `workers/peer-wait-shimmer.ts`
 * does; this module owns the two primitives it and the action handlers share:
 * which label to show, and how to put it on screen once.
 *
 * The handler that receives the user's action calls `issuePeerWaitDraft`
 * immediately — otherwise the chat would sit empty until the next worker tick.
 * From there the worker keeps the same `draft_id` alive.
 */

/** Distinct, stable draft id per (chat, match, side) so ticks animate as one draft. */
export function peerWaitDraftId(chatId: number, matchId: string, side: "A" | "B"): number {
  // Telegram wants a non-zero int32. Hash the triple so two different waits in
  // the same chat (impossible today — one live match per user — but cheap to be
  // safe) never share, and so the id is STABLE across ticks and restarts: an
  // unstable id would start a second draft instead of refreshing the first.
  let hash = 2166136261;
  for (const ch of `${chatId}:${matchId}:${side}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const id = Math.abs(hash) % 0x7fffffff;
  return id === 0 ? 1 : id;
}

/**
 * The wording ladder, keyed by how long THIS side has been waiting rather than
 * by a rotation counter. Time is the variation now: a wait two minutes old and
 * one twenty hours old used to read identically, which is what made the shimmer
 * feel decorative.
 *
 * The lines are **plain text** — no leading emoji and no animated `<tg-emoji>`
 * glyph (founder decision 2026-07-30). A status here is a description of state,
 * and an icon on it is decoration the state does not need; the `<tg-thinking>`
 * shimmer already signals "something is in progress" on its own.
 *
 * The two late tiers deliberately describe machinery that really ran, so the
 * copy reports state instead of just filling space:
 *   - `t4` ≥ 6h  — the §3.5 scheduling/venue nudge has actually been sent.
 *   - `t5` ≥ 24h — the §3.5c "still on?" check-in is out and the 48h
 *                  cancellation is the next thing that happens.
 * Move a boundary and you are making a claim about those workers; check them
 * first (`workers/match-nudge.ts`, `services/match-stall.ts`).
 */
const TIERS = [
  { afterMs: 24 * 60 * 60 * 1000, key: "peerWaitT5Deadline" },
  { afterMs: 6 * 60 * 60 * 1000, key: "peerWaitT4Nudged" },
  { afterMs: 60 * 60 * 1000, key: "peerWaitT3Quiet" },
  { afterMs: 5 * 60 * 1000, key: "peerWaitT2Waiting" },
  { afterMs: 0, key: "peerWaitT1Sent" },
] as const;

/**
 * What KIND of wait this is. The default ladder assumes the partner simply
 * hasn't acted; `no_overlap` is the calendar state where they DID act and the
 * two selections just don't intersect, which makes "no word from them yet" and
 * "nudged them" both false — the scheduling nudge deliberately skips a pair
 * where both sides have picked (`workers/match-nudge.ts`). It therefore gets its
 * own two-step ladder rather than a mislabelled five.
 */
export type PeerWaitVariant = "default" | "no_overlap";

/** Wall-clock tiers are only meaningful against a real anchor; guard the maths. */
function elapsedMs(startedAt: Date | null | undefined, now: Date): number {
  if (!startedAt) return 0;
  const ms = now.getTime() - startedAt.getTime();
  return ms > 0 ? ms : 0;
}

/**
 * The line to show for a wait that started at `startedAt`, personalised with the
 * partner's first name.
 *
 * `firstName` is a required onboarding field and these waits only happen on a
 * live match, so the anonymous variant is defensive rather than expected — but
 * it exists because substituting a generic noun into the personalised templates
 * breaks case agreement in German and Polish. The no-overlap lines name no one,
 * so they stay correct without it.
 */
export function peerWaitLabel(
  lang: Language,
  partnerName: string | null | undefined,
  startedAt: Date | null | undefined,
  now: Date = new Date(),
  variant: PeerWaitVariant = "default",
): string {
  const elapsed = elapsedMs(startedAt, now);

  if (variant === "no_overlap") {
    return t(lang, elapsed >= TIERS[0].afterMs ? "peerWaitNoOverlapLate" : "peerWaitNoOverlap");
  }

  const name = partnerName?.trim();
  if (!name) return t(lang, "peerWaitAnon");
  const tier = TIERS.find((candidate) => elapsed >= candidate.afterMs) ?? TIERS[TIERS.length - 1]!;
  return t(lang, tier.key, { name });
}

/** Everything `issuePeerWaitDraft` needs to render one beat. */
export interface PeerWaitDraftInput {
  chatId: number;
  matchId: string;
  side: "A" | "B";
  lang: Language;
  partnerName: string | null | undefined;
  /** When this side started waiting; null renders tier 1. */
  startedAt: Date | null | undefined;
  now?: Date;
  variant?: PeerWaitVariant;
}

/**
 * Put (or refresh) the shimmer on screen once. Re-issuing the same `draft_id`
 * with new html is what both advances the wording and resets the ~30s TTL.
 *
 * Throws on failure — callers decide what that means. For the worker it means
 * "this chat can't render rich drafts, use the fallback line"; for an action
 * handler it means the same, and the worker will set the fallback up on its next
 * tick rather than the handler duplicating that logic.
 */
export async function issuePeerWaitDraft(
  api: Api<RawApi>,
  input: PeerWaitDraftInput,
): Promise<void> {
  const label = peerWaitLabel(
    input.lang,
    input.partnerName,
    input.startedAt,
    input.now ?? new Date(),
    input.variant ?? "default",
  );
  // No `emojiId`: these lines carry no glyph at all (see the TIERS comment).
  await sendRichMessageDraft(api, {
    chat_id: input.chatId,
    draft_id: peerWaitDraftId(input.chatId, input.matchId, input.side),
    rich_message: { html: thinkingHtml(label) },
  });
}

/**
 * Fire-and-forget wrapper for the action handlers: start the shimmer the instant
 * the user commits, so the chat isn't empty until the next worker tick (up to
 * 20s later). From there `workers/peer-wait-shimmer.ts` keeps the same draft id
 * alive for the rest of the wait.
 *
 * Resolves the side, language and partner name itself so every call site is one
 * line — the callers are Mini App response paths and a callback handler, none of
 * which should be plumbing render data around for a cosmetic draft.
 *
 * Swallows everything. A chat that can't render rich drafts is picked up by the
 * worker's fallback path on its next tick; a chat we can't reach at all needs no
 * shimmer. Neither may break the flow this decorates.
 *
 * Always renders tier 1, and deliberately writes no anchor: this only ever fires
 * the instant the user commits, so "just handed off" is true by construction,
 * and leaving `peerWaitStartedAt*` to the worker keeps that column single-writer
 * (see the schema comment).
 */
export function startPeerWaitShimmer(
  api: Api<RawApi>,
  matchId: string,
  // Discriminated on purpose: the bot handlers hold a DB user id, while the
  // initData Mini App routes only ever hold a Telegram id. Taking a bare string
  // made those two silently interchangeable, and passing the wrong one resolves
  // to the WRONG SIDE of the match — a shimmer in the partner's chat.
  actor: { userId: string } | { telegramId: bigint },
): void {
  void (async () => {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        userAId: true,
        userA: { select: { telegramId: true, language: true, firstName: true } },
        userB: { select: { telegramId: true, language: true, firstName: true } },
      },
    });
    if (!match) return;
    // Resolve the side explicitly rather than "A if it matches, else B": an id
    // belonging to NEITHER participant must be a no-op, not a shimmer aimed at
    // side B.
    const isA =
      "userId" in actor
        ? match.userAId === actor.userId
        : match.userA.telegramId === actor.telegramId;
    const isB =
      "userId" in actor
        ? match.userAId !== actor.userId
        : match.userB.telegramId === actor.telegramId;
    if (!isA && !isB) return;
    const me = isA ? match.userA : match.userB;
    const peer = isA ? match.userB : match.userA;
    if (!isTelegramTarget(me.telegramId)) return;
    await issuePeerWaitDraft(api, {
      chatId: toTelegramChatId(me.telegramId),
      matchId,
      side: isA ? "A" : "B",
      lang: (me.language ?? "en") as Language,
      partnerName: peer.firstName,
      startedAt: null,
    });
  })().catch(() => {});
}
