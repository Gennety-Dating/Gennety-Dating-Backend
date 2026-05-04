import type { Api, RawApi } from "grammy";
import type {
  InlineKeyboardMarkup,
  InlineKeyboardButton,
  InputMediaPhoto,
} from "grammy/types";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
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

/**
 * Build the `Name, Age` caption shown under the partner photo. Falls back
 * to just the name when age is missing (legacy rows pre-mandatory-age).
 */
function buildPhotoCaption(
  lang: Language,
  firstName: string | null,
  age: number | null,
): string {
  const name = firstName?.trim() ?? "";
  if (!name) return "";
  if (age == null) return name;
  return t(lang, "matchPhotoCaption", { name, age });
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
async function sendPartnerPhotos(
  api: Api<RawApi>,
  chatId: number,
  photos: readonly string[],
  caption: string,
): Promise<void> {
  if (photos.length === 0) return;
  const slice = photos.slice(0, MAX_MEDIA_GROUP_SIZE);
  try {
    if (slice.length === 1) {
      await api.sendPhoto(chatId, slice[0]!, caption ? { caption } : {});
      return;
    }
    const media: InputMediaPhoto[] = slice.map((fileId, i) => ({
      type: "photo",
      media: fileId,
      ...(i === 0 && caption ? { caption } : {}),
    }));
    await api.sendMediaGroup(chatId, media);
  } catch (err) {
    console.warn("sendPartnerPhotos failed, skipping photo card:", err);
  }
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
      synergyScore: true,
      synergyReason: true,
      userA: {
        select: {
          telegramId: true,
          firstName: true,
          age: true,
          language: true,
          profile: {
            select: { psychologicalSummary: true, photos: true },
          },
        },
      },
      userB: {
        select: {
          telegramId: true,
          firstName: true,
          age: true,
          language: true,
          profile: {
            select: { psychologicalSummary: true, photos: true },
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

  const kbA = buildMatchKeyboard(matchId, langA);
  const kbB = buildMatchKeyboard(matchId, langB);

  // Each user sees their PARTNER's photo + name/age caption — the visual
  // anchor for an Accept/Decline decision since there's no user-to-user
  // chat. Caption uses the *recipient's* locale.
  const photosForA = match.userB.profile?.photos ?? [];
  const photosForB = match.userA.profile?.photos ?? [];
  const captionForA = buildPhotoCaption(langA, match.userB.firstName, match.userB.age);
  const captionForB = buildPhotoCaption(langB, match.userA.firstName, match.userA.age);

  // M-17: skip mobile-only users — their pitch goes via the Expo push path,
  // not Telegram drafts. Sending to a negative chat id used to throw and
  // crash the entire weekly-batch dispatch loop.
  const sendA = (async () => {
    if (!isTelegramTarget(match.userA.telegramId)) return undefined;
    const chatA = Number(match.userA.telegramId);
    await sendPartnerPhotos(api, chatA, photosForA, captionForA);
    return stream(api, chatA, draftsA, { replyMarkup: kbA });
  })();
  const sendB = (async () => {
    if (!isTelegramTarget(match.userB.telegramId)) return undefined;
    const chatB = Number(match.userB.telegramId);
    await sendPartnerPhotos(api, chatB, photosForB, captionForB);
    return stream(api, chatB, draftsB, { replyMarkup: kbB });
  })();
  const [resA, resB] = await Promise.all([sendA, sendB]);

  // Persist the visible message_id per side so the countdown worker can
  // edit it later. Mobile-only sides have no Telegram message → leave NULL.
  const pitchMessageIdA = resA?.message_id ?? null;
  const pitchMessageIdB = resB?.message_id ?? null;
  if (pitchMessageIdA != null || pitchMessageIdB != null) {
    await prisma.match.update({
      where: { id: matchId },
      data: {
        ...(pitchMessageIdA != null ? { pitchMessageIdA } : {}),
        ...(pitchMessageIdB != null ? { pitchMessageIdB } : {}),
      },
    });
  }
}
