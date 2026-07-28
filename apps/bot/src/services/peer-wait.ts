import type { Api, RawApi } from "grammy";
import type { Language } from "@gennety/shared";
import { runStatusSequence } from "./ai-stream.js";
import { peerWaitSteps } from "./analysis-status.js";

/**
 * Deliver the "you're done, now we wait on them" receipt as a short rich
 * shimmer that settles into the caller's existing waiting line.
 *
 * Used by the two-sided negotiation steps where one participant commits and the
 * flow then blocks on the other — calendar availability (§3.6) and venue intent
 * (§3.7 / Venue Intent V2). Before this the receipt was a single flat
 * `sendMessage`, so committing your side produced no sense that anything had
 * happened; the shimmer covers the moment of the action and the final line then
 * persists exactly as it did before.
 *
 * The shimmer is bounded (~2.5s) on purpose — see `peerWaitSteps` for why a
 * `<tg-thinking>` draft can never cover the wait itself. Callers get the same
 * best-effort contract as the plain send they replaced: `runStatusSequence`
 * swallows send/edit failures internally, and the rich path falls back to the
 * classic edited-message stream on clients that can't render rich drafts, which
 * lands the identical final text.
 */
export async function sendPeerWaitAck(
  api: Api<RawApi>,
  chatId: number,
  lang: Language,
  finalText: string,
  options: { wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  await runStatusSequence(api, chatId, peerWaitSteps(lang, finalText), {
    rich: true,
    deleteAtEnd: false,
    ...(options.wait ? { wait: options.wait } : {}),
  });
}

/**
 * The same two hand-off beats, but WITHOUT persisting a final line — the caller
 * sends its own durable message immediately afterwards, and the ephemeral draft
 * resolves into it.
 *
 * This variant exists for the pitch decision (§3.4). The first decider's
 * "accepted, waiting on them" receipt is not a throwaway line: it is the tracked
 * post-accept card (`Match.calendarMessageIdA/B`) that later morphs in place into
 * the Date Ticket card and then the Calendar (§3.6), and it carries
 * `MESSAGE_EFFECT_MATCH_ID`. So `sendPeerWaitAck` cannot own that send — it would
 * neither return the message id to track nor carry the effect. Playing beats-only
 * and leaving the card to `sendOrEditPostAcceptMessage` keeps that whole lifecycle
 * untouched while still giving the moment its motion.
 *
 * MUST be awaited: the beats have to land before the card, or the two race and
 * the card arrives first.
 */
export async function sendPeerWaitBeats(
  api: Api<RawApi>,
  chatId: number,
  lang: Language,
  options: { wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  // Drop the trailing final-line step — the caller supplies that message.
  const beats = peerWaitSteps(lang, "").slice(0, -1);
  await runStatusSequence(api, chatId, beats, {
    rich: true,
    deleteAtEnd: true,
    ...(options.wait ? { wait: options.wait } : {}),
  });
}
