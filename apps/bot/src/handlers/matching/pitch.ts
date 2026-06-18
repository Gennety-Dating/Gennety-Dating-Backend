import type { Api, RawApi } from "grammy";
import type {
  InlineKeyboardMarkup,
  InlineKeyboardButton,
  MessageEntity,
} from "grammy/types";
import { prisma } from "@gennety/db";
import { normalizeProfileMedia, t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { streamDraftsToChat } from "../../services/ai-stream.js";
import {
  generatePitch,
  splitPitchIntoDrafts,
  type PitchResult,
} from "../../services/pitch-generator.js";
import { isTelegramTarget } from "../../utils/telegram-target.js";
import {
  appendCountdownPlate,
  PROPOSAL_TTL_MS,
} from "../../utils/countdown-plate.js";
import { sendProfileMediaCard } from "../../services/profile-media-dispatch.js";
import { grantWelcomeGiftIfEligible } from "../../services/ticket-wallet.js";
import {
  sendWelcomeGiftPreroll,
  type WelcomeGiftGender,
} from "../../services/welcome-gift.js";

/**
 * Telegram media group caps at 10 items per request — we slice down to this
 * if a profile somehow has more. Real onboarding limit is 5.
 */
const MAX_MEDIA_GROUP_SIZE = 10;

/**
 * Pitch delivery — called by the match-engine tick after a `proposed` Match
 * row is created. Sends the personalized pitch + Accept/Decline keyboard to
 * both users via `sendMessageDraft` streaming.
 *
 * The engine runs outside a grammY context, so we use `streamDraftsToChat`
 * with a raw `Api` instance. Idempotent: if the match already has pitches
 * stored, we skip regeneration and use the persisted text.
 */

export interface SendMatchProposalOptions {
  /** Injected for tests — overrides `streamDraftsToChat`. */
  streamImpl?: typeof streamDraftsToChat;
  /**
   * The weekly dispatch queue can send the first-match gift as a separate
   * pre-roll phase, then wait before showing the match card. In that case we
   * skip the inline gift attempt here to avoid replaying the moment.
   */
  skipWelcomeGiftPreroll?: boolean | { A?: boolean; B?: boolean };
  /** Injected for tests — overrides `generatePitch`. */
  pitchImpl?: (args: {
    selfFirstName: string | null;
    otherFirstName: string | null;
    selfSummary: string | null;
    otherSummary: string | null;
    language: Language;
  }) => Promise<PitchResult>;
}

/**
 * Build the Accept/Decline inline keyboard for a given match.
 *
 * Uses Telegram Bot API 9.4 button styles:
 *   - Accept → `style: "success"` (native green) + optional custom emoji
 *   - Decline → `style: "danger"` (native red) + optional custom emoji
 *
 * Returns a raw `InlineKeyboardMarkup` because grammY's builder types may
 * not yet expose the `style` / `icon_custom_emoji_id` fields.
 */
export function buildMatchKeyboard(
  matchId: string,
  lang: Language,
): InlineKeyboardMarkup {
  const acceptBtn: InlineKeyboardButton.CallbackButton & Record<string, unknown> = {
    text: t(lang, "matchBtnAccept"),
    callback_data: `match:accept:${matchId}`,
    style: "success",
    ...(env.CUSTOM_EMOJI_ACCEPT_ID ? { icon_custom_emoji_id: env.CUSTOM_EMOJI_ACCEPT_ID } : {}),
  };

  const declineBtn: InlineKeyboardButton.CallbackButton & Record<string, unknown> = {
    text: t(lang, "matchBtnDecline"),
    callback_data: `match:decline:${matchId}`,
    style: "danger",
    ...(env.CUSTOM_EMOJI_DECLINE_ID ? { icon_custom_emoji_id: env.CUSTOM_EMOJI_DECLINE_ID } : {}),
  };

  const reportBtn: InlineKeyboardButton.CallbackButton = {
    text: t(lang, "reportBtn"),
    callback_data: `report:open:${matchId}`,
  };

  return {
    inline_keyboard: [
      [acceptBtn as InlineKeyboardButton, declineBtn as InlineKeyboardButton],
      [reportBtn],
    ],
  };
}

/** Static fallback glyph rendered before the localised "Verified" label
 *  when no `CUSTOM_EMOJI_VERIFIED_ID` is configured. We pick `✓` because
 *  it has no skin-tone variant and reads cleanly across themes. */
const VERIFIED_GLYPH = "✓";

export interface PhotoCaption {
  caption: string;
  entities?: MessageEntity[];
}

/**
 * Build the caption shown under the partner photo.
 *
 * - Always: `Name[, Age]` — name-only fallback for legacy rows pre-mandatory-age.
 * - When `verified` is true, appends a second line with `✓ Verified` (localised).
 *   The leading `✓` is wrapped in a `custom_emoji` MessageEntity if
 *   `customEmojiVerifiedId` is set, so Premium clients render an animated
 *   checkmark; everyone else sees the static glyph.
 */
export function buildPhotoCaption(
  lang: Language,
  firstName: string | null,
  age: number | null,
  options: { verified?: boolean; customEmojiVerifiedId?: string } = {},
): PhotoCaption {
  const name = firstName?.trim() ?? "";
  if (!name) return { caption: "" };

  const headline = age == null ? name : t(lang, "matchPhotoCaption", { name, age });
  if (!options.verified) return { caption: headline };

  const label = t(lang, "matchVerifiedLabel");
  const caption = `${headline}\n${VERIFIED_GLYPH} ${label}`;
  if (!options.customEmojiVerifiedId) return { caption };

  // The custom_emoji entity must cover an emoji-shaped glyph; `✓` works
  // because Telegram treats it as the underlying display char. Premium
  // clients fetch the pack document; non-Premium fall back to the glyph.
  const offset = headline.length + 1; // skip headline + "\n"
  return {
    caption,
    entities: [
      {
        type: "custom_emoji",
        offset,
        length: VERIFIED_GLYPH.length,
        custom_emoji_id: options.customEmojiVerifiedId,
      },
    ],
  };
}

/**
 * Send the partner's photo(s) as a leading visual card before the AI
 * pitch streams in. Without this the user has no visual to anchor their
 * Accept/Decline decision — the pitch is text-only.
 *
 * Telegram media-group rules: caption belongs on the FIRST item only,
 * everything else is rendered as a single album. We swallow API errors so
 * a stale/invalid `file_id` (e.g. user replaced their photos after the
 * match was scored) can't block the pitch dispatch.
 */
async function sendPartnerMedia(
  api: Api<RawApi>,
  chatId: number,
  photos: readonly string[],
  profileMedia: unknown,
  caption: PhotoCaption,
): Promise<void> {
  const media = normalizeProfileMedia(profileMedia, photos).slice(0, MAX_MEDIA_GROUP_SIZE);
  if (media.length === 0) return;
  const { caption: text, entities } = caption;
  try {
    await sendProfileMediaCard(
      api,
      chatId,
      media,
      {
        ...(text ? { caption: text } : {}),
        ...(text && entities?.length ? { caption_entities: entities } : {}),
      },
      // Protect the partner's photos: the pitch is the first place a user sees
      // them, so block forward/save/download (screenshots can't be blocked in a
      // normal bot chat — see PRODUCT_SPEC §3.7a). Privacy of the actual image
      // off-platform stays guaranteed by the date-card blurred share copy.
      { protect: true },
    );
  } catch (err) {
    console.warn("sendPartnerMedia failed, skipping photo card:", err);
  }
}

/**
 * Send the closing trust card — a blockquote-formatted note from the
 * Gennety team explaining that the partner has cleared face-match
 * verification. Only emitted when `partner.verificationStatus` is
 * `verified`; unverified partners get no message (no shaming, matches
 * PRODUCT_SPEC.md §1.4).
 *
 * Uses a `blockquote` MessageEntity instead of MarkdownV2 so the body
 * text doesn't need character escaping.
 */
async function sendVerifiedTrustCard(
  api: Api<RawApi>,
  chatId: number,
  lang: Language,
): Promise<void> {
  const text = t(lang, "matchVerifiedQuote");
  try {
    await api.sendMessage(chatId, text, {
      entities: [{ type: "blockquote", offset: 0, length: text.length }],
    });
  } catch (err) {
    console.warn("sendVerifiedTrustCard failed, skipping trust card:", err);
  }
}

/**
 * Welcome-gift pre-roll, fired on a user's first-ever match pitch. The grant is
 * idempotent (a `welcome_gift` ledger row is the claim marker) and a no-op when
 * `TICKET_FEATURE_ENABLED` is off, so the FIRST qualifying pitch becomes the
 * gift moment automatically — no separate "first match" detection. The
 * кружок/DM only fires when the grant actually credited the ticket
 * (`granted === true`). Best-effort: a failure here is purely cosmetic and must
 * never block pitch dispatch.
 */
async function deliverWelcomeGiftPreroll(
  api: Api<RawApi>,
  userId: string,
  chatId: number,
  lang: Language,
  gender: WelcomeGiftGender | null,
): Promise<boolean> {
  try {
    const { granted } = await grantWelcomeGiftIfEligible(userId);
    if (granted) {
      await sendWelcomeGiftPreroll(api, chatId, lang, gender);
      return true;
    }
  } catch (err) {
    console.warn("[pitch] welcome-gift pre-roll failed:", err);
  }
  return false;
}

export interface MatchWelcomeGiftPrerollResult {
  sent: number;
  sentA: boolean;
  sentB: boolean;
}

function shouldSkipWelcomeGiftPreroll(
  options: SendMatchProposalOptions,
  side: "A" | "B",
): boolean {
  const skip = options.skipWelcomeGiftPreroll;
  return skip === true || (typeof skip === "object" && skip[side] === true);
}

/**
 * Send only the first-match welcome-gift pre-roll for a match. Used by the
 * weekly dispatch queue to stage the gift moment before the match card reveal.
 */
export async function sendMatchWelcomeGiftPreroll(
  api: Api<RawApi>,
  matchId: string,
): Promise<MatchWelcomeGiftPrerollResult> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      pitchMessageIdA: true,
      pitchMessageIdB: true,
      userA: {
        select: {
          id: true,
          telegramId: true,
          gender: true,
          language: true,
        },
      },
      userB: {
        select: {
          id: true,
          telegramId: true,
          gender: true,
          language: true,
        },
      },
    },
  });
  if (!match) return { sent: 0, sentA: false, sentB: false };

  let sent = 0;
  let sentA = false;
  let sentB = false;
  if (isTelegramTarget(match.userA.telegramId) && match.pitchMessageIdA == null) {
    const langA: Language = match.userA.language ?? "en";
    const didSend = await deliverWelcomeGiftPreroll(
      api,
      match.userA.id,
      Number(match.userA.telegramId),
      langA,
      match.userA.gender,
    );
    if (didSend) {
      sent++;
      sentA = true;
    }
  }
  if (isTelegramTarget(match.userB.telegramId) && match.pitchMessageIdB == null) {
    const langB: Language = match.userB.language ?? "en";
    const didSend = await deliverWelcomeGiftPreroll(
      api,
      match.userB.id,
      Number(match.userB.telegramId),
      langB,
      match.userB.gender,
    );
    if (didSend) {
      sent++;
      sentB = true;
    }
  }

  return { sent, sentA, sentB };
}

/**
 * Push a match proposal to both users. Streams the pitch via drafts and
 * finalises with an inline keyboard on the last message.
 */
export async function sendMatchProposal(
  api: Api<RawApi>,
  matchId: string,
  options: SendMatchProposalOptions = {},
): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      pitchForA: true,
      pitchForB: true,
      pitchMessageIdA: true,
      pitchMessageIdB: true,
      synergyScore: true,
      synergyReason: true,
      userA: {
        select: {
          id: true,
          telegramId: true,
          firstName: true,
          age: true,
          gender: true,
          language: true,
          verificationStatus: true,
          profile: {
            select: { psychologicalSummary: true, photos: true, profileMedia: true },
          },
        },
      },
      userB: {
        select: {
          id: true,
          telegramId: true,
          firstName: true,
          age: true,
          gender: true,
          language: true,
          verificationStatus: true,
          profile: {
            select: { psychologicalSummary: true, photos: true, profileMedia: true },
          },
        },
      },
    },
  });
  if (!match) return;

  const stream = options.streamImpl ?? streamDraftsToChat;
  const pitch = options.pitchImpl ?? ((args) => generatePitch(args, undefined, matchId));

  const langA: Language = match.userA.language ?? "en";
  const langB: Language = match.userB.language ?? "en";

  // Reuse stored pitches on retry; otherwise generate + persist. The synergy
  // score + reason are pair-level (one row, one number) — we take them from
  // side-A's generation, since it sees both bios in side-A's language. Side
  // B's call still produces its own translated pitch but its score/reason
  // are discarded.
  let pitchForA = match.pitchForA;
  let pitchForB = match.pitchForB;
  let synergyScore = match.synergyScore;
  let synergyReason = match.synergyReason;

  if (!pitchForA) {
    const resultA = await pitch({
      selfFirstName: match.userA.firstName,
      otherFirstName: match.userB.firstName,
      selfSummary: match.userA.profile?.psychologicalSummary ?? null,
      otherSummary: match.userB.profile?.psychologicalSummary ?? null,
      language: langA,
    });
    pitchForA = resultA.pitch;
    if (synergyScore == null) synergyScore = resultA.synergyScore;
    if (!synergyReason) synergyReason = resultA.synergyReason;
  }

  if (!pitchForB) {
    const resultB = await pitch({
      selfFirstName: match.userB.firstName,
      otherFirstName: match.userA.firstName,
      selfSummary: match.userB.profile?.psychologicalSummary ?? null,
      otherSummary: match.userA.profile?.psychologicalSummary ?? null,
      language: langB,
    });
    pitchForB = resultB.pitch;
    // If side A was already cached but synergy was somehow missing (older
    // row pre-feature), backfill from side B's call as a last resort.
    if (synergyScore == null) synergyScore = resultB.synergyScore;
    if (!synergyReason) synergyReason = resultB.synergyReason;
  }

  if (
    !match.pitchForA ||
    !match.pitchForB ||
    match.synergyScore == null ||
    !match.synergyReason
  ) {
    await prisma.match.update({
      where: { id: matchId },
      data: { pitchForA, pitchForB, synergyScore, synergyReason },
    });
  }

  // Append the live "⏳ 24h left" plate to the visible (final) chunk so it
  // ships with the proposal and can be live-edited by the countdown worker.
  // The plate format is owned by `countdown-plate.ts` so the worker's no-op
  // cache can compare byte-for-byte against the rendered plate.
  const initialMinutes = Math.floor(PROPOSAL_TTL_MS / 60_000);
  const chunksA = splitPitchIntoDrafts(pitchForA);
  const chunksB = splitPitchIntoDrafts(pitchForB);
  const lastA = chunksA.pop() ?? "";
  const lastB = chunksB.pop() ?? "";
  // Synergy header sits inside the final persistent message (above the
  // pitch text, below which the countdown plate is appended). Score+reason
  // are pair-level, but the reason is rendered in each side's language
  // — using the side-A language is acceptable because the LLM only writes
  // one reason per pair, and the mobile app shows it raw too.
  const synergyHeaderA =
    synergyScore != null && synergyReason
      ? t(langA, "matchSynergyHeader", { score: synergyScore, reason: synergyReason })
      : "";
  const synergyHeaderB =
    synergyScore != null && synergyReason
      ? t(langB, "matchSynergyHeader", { score: synergyScore, reason: synergyReason })
      : "";
  const lastWithSynergyA = synergyHeaderA ? `${synergyHeaderA}\n\n${lastA}` : lastA;
  const lastWithSynergyB = synergyHeaderB ? `${synergyHeaderB}\n\n${lastB}` : lastB;
  const finalA = appendCountdownPlate(lastWithSynergyA, langA, initialMinutes);
  const finalB = appendCountdownPlate(lastWithSynergyB, langB, initialMinutes);
  // The deadline notice is streamed right after the headline so the user
  // sees the irreversibility warning before any analysis fluff. Plain-text
  // chunk — the live countdown plate is appended only to the FINAL chunk
  // because that's the message the worker live-edits.
  const draftsA = [
    t(langA, "matchHeadline"),
    t(langA, "matchDeadlineNotice"),
    t(langA, "matchStreamStart"),
    ...chunksA,
    finalA,
  ];
  const draftsB = [
    t(langB, "matchHeadline"),
    t(langB, "matchDeadlineNotice"),
    t(langB, "matchStreamStart"),
    ...chunksB,
    finalB,
  ];
  // `matchStreamStart` (the "analysing compatibility…" beat) sits right after
  // the headline + deadline; on the rich path it renders as a <tg-thinking>
  // shimmer. Same index for both sides since the preamble is identical.
  const thinkingIndex = 2;

  const kbA = buildMatchKeyboard(matchId, langA);
  const kbB = buildMatchKeyboard(matchId, langB);

  // Each user sees their PARTNER's photo + name/age caption — the visual
  // anchor for an Accept/Decline decision since there's no user-to-user
  // chat. Caption uses the *recipient's* locale. The verified affordance
  // describes the *partner's* state, so it gates on the partner's row.
  const photosForA = match.userB.profile?.photos ?? [];
  const photosForB = match.userA.profile?.photos ?? [];
  const mediaForA = match.userB.profile?.profileMedia ?? [];
  const mediaForB = match.userA.profile?.profileMedia ?? [];
  const partnerBVerified = match.userB.verificationStatus === "verified";
  const partnerAVerified = match.userA.verificationStatus === "verified";
  const captionForA = buildPhotoCaption(langA, match.userB.firstName, match.userB.age, {
    verified: partnerBVerified,
    customEmojiVerifiedId: env.CUSTOM_EMOJI_VERIFIED_ID,
  });
  const captionForB = buildPhotoCaption(langB, match.userA.firstName, match.userA.age, {
    verified: partnerAVerified,
    customEmojiVerifiedId: env.CUSTOM_EMOJI_VERIFIED_ID,
  });

  // M-17: skip mobile-only users — their pitch goes via the Expo push path,
  // not Telegram drafts. Sending to a negative chat id used to throw and
  // crash the entire weekly-batch dispatch loop.
  //
  // The verified trust card lands AFTER the pitch as the closing message —
  // last argument the user reads before tapping Accept/Decline. Skipped
  // entirely when the partner isn't `verified` so unverified partners
  // get no negative signal.
  const sendA = (async () => {
    if (!isTelegramTarget(match.userA.telegramId) || match.pitchMessageIdA != null) {
      return;
    }
    const chatA = Number(match.userA.telegramId);
    if (!shouldSkipWelcomeGiftPreroll(options, "A")) {
      await deliverWelcomeGiftPreroll(api, match.userA.id, chatA, langA, match.userA.gender);
    }
    await sendPartnerMedia(api, chatA, photosForA, mediaForA, captionForA);
    const result = await stream(api, chatA, draftsA, { replyMarkup: kbA, thinkingIndex });
    if (!result) throw new Error("Pitch stream returned no final message for side A");
    await prisma.match.update({
      where: { id: matchId },
      data: { pitchMessageIdA: result.message_id },
    });
    if (partnerBVerified) await sendVerifiedTrustCard(api, chatA, langA);
  })();
  const sendB = (async () => {
    if (!isTelegramTarget(match.userB.telegramId) || match.pitchMessageIdB != null) {
      return;
    }
    const chatB = Number(match.userB.telegramId);
    if (!shouldSkipWelcomeGiftPreroll(options, "B")) {
      await deliverWelcomeGiftPreroll(api, match.userB.id, chatB, langB, match.userB.gender);
    }
    await sendPartnerMedia(api, chatB, photosForB, mediaForB, captionForB);
    const result = await stream(api, chatB, draftsB, { replyMarkup: kbB, thinkingIndex });
    if (!result) throw new Error("Pitch stream returned no final message for side B");
    await prisma.match.update({
      where: { id: matchId },
      data: { pitchMessageIdB: result.message_id },
    });
    if (partnerAVerified) await sendVerifiedTrustCard(api, chatB, langB);
  })();
  const results = await Promise.allSettled([sendA, sendB]);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Pitch delivery failed for ${failures.length} side(s)`,
    );
  }
}
