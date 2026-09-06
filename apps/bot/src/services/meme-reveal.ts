import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import { profilerImageQuestionIds, t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { DEMO_MODE_ENABLED, PROTECT_PARTNER_MEDIA } from "../demo/config.js";

/**
 * The pre-date meme reveal (§Phase 4) — one card before the date showing what
 * the other person sent when asked what makes them laugh.
 *
 * **This was a paid feature and is deliberately no longer one.** The economics
 * were never the problem: a reveal costs a fraction of a cent to produce and
 * was priced at 25⭐, so it cleared its cost by roughly three orders of
 * magnitude. The problem was what the price implied. Charging one person to see
 * something another person said about themselves makes the second person
 * inventory, and the Profiler's own framing — "the better I know you, the
 * better I can prepare you both" — asks for nothing of the kind. Free and
 * consented is the same product without the part that could not be defended
 * out loud.
 *
 * **Consent is asked before the fact, in the question itself.** The humour
 * question now says the meme will be shown to their match before the date, so
 * anyone who sends one has agreed to exactly what happens. Consent collected
 * after someone has already handed over the thing is not consent, which is why
 * it lives in the question copy rather than in a follow-up prompt. Withdrawal
 * needs no machinery: re-answering in words clears the pointer, and a pointer
 * is the only thing that makes a reveal possible.
 *
 * **The teaser is still a teaser.** The card says a meme exists and not a word
 * about what it is. That is no longer about protecting a purchase — it is that
 * the reveal is a small gift, and a gift you can see through the wrapping is a
 * worse gift.
 *
 * **No advice line.** An earlier version generated "how to bring it up" from
 * the stored description. It was cut on purpose: the model never saw the video,
 * only its own one-sentence summary of one frame, so the advice was a paraphrase
 * of a paraphrase and reliably generic. Worse, it changed the genre — "here is
 * what she finds funny" is a fact about a person, "here is how to play it" is a
 * script for performing at them. The product brings people to a table as
 * themselves.
 */

/** The meme one person has, ready to be shown to the other. */
export interface PartnerMeme {
  /** The partner whose meme this is. */
  subjectUserId: string;
  subjectFirstName: string;
  /** Telegram `file_id` and how it must be re-sent. */
  fileId: string;
  kind: "photo" | "sticker";
  /** The vision-written sentence describing it. */
  description: string;
  /**
   * The TikTok / Reel the cover frame came from, when the answer arrived as a
   * link. Null for an attached picture, which is the whole thing already.
   */
  sourceUrl: string | null;
}

/** Who the card is ABOUT, resolved without touching their answer. */
export interface MemeSubject {
  subjectUserId: string;
  subjectFirstName: string;
}

/** Master switch. Off by default: the card rides the ice-breaker tick, which
 *  fires for every scheduled date, so a half-configured deploy would otherwise
 *  start showing people's memes immediately. */
export function memeRevealFeatureLive(): boolean {
  return env.MEME_REVEAL_ENABLED;
}

/**
 * The partner on this match, or null when the viewer is not on it.
 *
 * Resolving the participant is the trust boundary: a callback carries a match
 * id and nothing else, so a stranger's tap has to find nothing here.
 */
export async function resolveMemeSubject(
  matchId: string,
  viewerUserId: string,
): Promise<MemeSubject | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userAId: true,
      userBId: true,
      userA: { select: { id: true, firstName: true } },
      userB: { select: { id: true, firstName: true } },
    },
  });
  if (!match) return null;

  const subject =
    match.userAId === viewerUserId
      ? match.userB
      : match.userBId === viewerUserId
        ? match.userA
        : null;
  if (!subject) return null;
  return { subjectUserId: subject.id, subjectFirstName: subject.firstName ?? "" };
}

/**
 * The image-backed humour answer for one person, or null when they have none.
 *
 * Null is the ordinary case, not an error: most people type their answer. The
 * `memeFileId: { not: null }` clause is doing the real work — an answer whose
 * text came from a caption fallback carries no pointer, which is exactly how an
 * image the vision pass refused as unsafe stays unshowable.
 */
export async function memeAnswerFor(
  subject: MemeSubject,
): Promise<PartnerMeme | null> {
  const answer = await prisma.profilerAnswer.findFirst({
    where: {
      userId: subject.subjectUserId,
      questionId: { in: profilerImageQuestionIds() },
      skipped: false,
      memeFileId: { not: null },
      answerText: { not: null },
    },
    select: {
      memeFileId: true,
      memeKind: true,
      answerText: true,
      memeSourceUrl: true,
    },
    orderBy: { answeredAt: "desc" },
  });
  if (!answer?.memeFileId || !answer.answerText) return null;

  return {
    ...subject,
    fileId: answer.memeFileId,
    kind: answer.memeKind === "sticker" ? "sticker" : "photo",
    description: answer.answerText,
    sourceUrl: answer.memeSourceUrl ?? null,
  };
}

/**
 * The meme a given viewer can be shown on a given match, or null when there is
 * nothing to show.
 *
 * Null covers every "no card" case on purpose, so the card path has one check
 * instead of three: the viewer is not on this match, the partner answered the
 * humour question in words (or not at all), or the answer has no pointer
 * because only its caption survived.
 */
export async function partnerMemeForViewer(
  matchId: string,
  viewerUserId: string,
): Promise<PartnerMeme | null> {
  const subject = await resolveMemeSubject(matchId, viewerUserId);
  return subject ? memeAnswerFor(subject) : null;
}

// ───────────────────────────────────────────────────────────────────────────
// The card
// ───────────────────────────────────────────────────────────────────────────

/**
 * The standalone card. Its own message rather than a button bolted onto the
 * ice-breaker stream, so the stream stays one uninterrupted thing — and so the
 * card can simply not be sent, which is what happens for every match where the
 * partner typed their humour answer.
 *
 * The tap is kept even though nothing is charged. Pushing the picture into the
 * chat unasked would spend the best part of this feature — the beat where you
 * decide to look — on a notification.
 */
export function buildMemeCard(
  lang: Language,
  matchId: string,
  subjectFirstName: string,
): { text: string; keyboard: InlineKeyboard } {
  return {
    text: t(lang, "memeCardTeaser", { name: subjectFirstName }),
    keyboard: new InlineKeyboard().text(
      t(lang, "memeCardBtn"),
      `meme:show:${matchId}`,
    ),
  };
}

/**
 * Send the card to one viewer, if there is one to send.
 *
 * Returns whether a card actually went out — false is the common case and is
 * not an error: most matches have at least one side who answered the humour
 * question in words, and those simply see the ordinary ice-breaker beat with
 * nothing extra attached.
 *
 * The card is sent whenever the partner has a meme, with no reciprocity
 * requirement. Making it conditional on the viewer having shared one too would
 * re-introduce an exchange, and there is no exchange any more: the person whose
 * meme this is agreed, in the question, that their match would see it.
 *
 * Never throws — the caller is a claimed, once-only lifecycle beat with a
 * safety message queued behind it.
 */
export async function sendMemeCard(
  api: Api<RawApi>,
  chatId: number,
  viewerUserId: string,
  matchId: string,
  lang: Language,
): Promise<boolean> {
  // The demo runtime shows the card too, and is exempt from the master switch.
  if (!memeRevealFeatureLive() && !DEMO_MODE_ENABLED) return false;

  const meme = await partnerMemeForViewer(matchId, viewerUserId).catch(() => null);
  if (!meme) return false;

  const card = buildMemeCard(lang, matchId, meme.subjectFirstName);
  try {
    await api.sendMessage(chatId, card.text, { reply_markup: card.keyboard });
    return true;
  } catch (err) {
    console.warn(
      `[meme-reveal] card send failed chat=${chatId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The reveal
// ───────────────────────────────────────────────────────────────────────────

/**
 * Show the meme.
 *
 * Returns false only when the viewer got NOTHING — nothing depends on that any
 * more (there is no refund to trigger), but the caller still logs it, and a
 * reveal that silently shows an empty chat is worth seeing in the log.
 *
 * A dead `file_id` is not fatal: the stored description says what the thing
 * was, so it goes out in words instead.
 */
export async function deliverMemeReveal(
  api: Api<RawApi>,
  chatId: number,
  lang: Language,
  meme: PartnerMeme,
): Promise<boolean> {
  const caption = t(lang, "memeRevealCaption", { name: meme.subjectFirstName });

  let picture = false;
  try {
    if (meme.kind === "sticker") {
      // A sticker carries no caption field, so the framing line goes first.
      await api.sendMessage(chatId, caption);
      await api.sendSticker(chatId, meme.fileId, {
        protect_content: PROTECT_PARTNER_MEDIA,
      });
    } else {
      await api.sendPhoto(chatId, meme.fileId, {
        caption,
        protect_content: PROTECT_PARTNER_MEDIA,
      });
    }
    picture = true;
  } catch (err) {
    console.warn(
      `[meme-reveal] picture send failed chat=${chatId} kind=${meme.kind}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // The link, when the answer came from one. Its own plain-text message and no
  // `parse_mode`: an Instagram shortcode can contain `_`, and there is nothing
  // to gain from formatting a URL.
  //
  // Sent even when the picture failed — that is the path where it matters most,
  // being the only way left for the viewer to actually see the thing.
  if (meme.sourceUrl) {
    try {
      await api.sendMessage(chatId, `${t(lang, "memeRevealSource")}\n${meme.sourceUrl}`);
      return true;
    } catch (err) {
      console.warn(
        `[meme-reveal] source link send failed chat=${chatId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (picture) return true;

  // No picture and no link: say in words what the thing was, so the tap is not
  // answered with silence.
  try {
    await api.sendMessage(
      chatId,
      t(lang, "memeRevealFallback", {
        name: meme.subjectFirstName,
        description: meme.description,
      }),
    );
    return true;
  } catch (err) {
    console.error(
      `[meme-reveal] fallback send failed chat=${chatId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}
