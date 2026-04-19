import type { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup, InlineKeyboardButton } from "grammy/types";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { streamDraftsToChat } from "../../services/ai-stream.js";
import { generatePitch, splitPitchIntoDrafts } from "../../services/pitch-generator.js";

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
  }) => Promise<string>;
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
      userA: {
        select: {
          telegramId: true,
          firstName: true,
          language: true,
          profile: { select: { psychologicalSummary: true } },
        },
      },
      userB: {
        select: {
          telegramId: true,
          firstName: true,
          language: true,
          profile: { select: { psychologicalSummary: true } },
        },
      },
    },
  });
  if (!match) return;

  const stream = options.streamImpl ?? streamDraftsToChat;
  const pitch = options.pitchImpl ?? ((args) => generatePitch(args));

  const langA: Language = match.userA.language ?? "en";
  const langB: Language = match.userB.language ?? "en";

  // Reuse stored pitches on retry; otherwise generate + persist.
  const pitchForA =
    match.pitchForA ??
    (await pitch({
      selfFirstName: match.userA.firstName,
      otherFirstName: match.userB.firstName,
      selfSummary: match.userA.profile?.psychologicalSummary ?? null,
      otherSummary: match.userB.profile?.psychologicalSummary ?? null,
      language: langA,
    }));
  const pitchForB =
    match.pitchForB ??
    (await pitch({
      selfFirstName: match.userB.firstName,
      otherFirstName: match.userA.firstName,
      selfSummary: match.userB.profile?.psychologicalSummary ?? null,
      otherSummary: match.userA.profile?.psychologicalSummary ?? null,
      language: langB,
    }));

  if (!match.pitchForA || !match.pitchForB) {
    await prisma.match.update({
      where: { id: matchId },
      data: { pitchForA, pitchForB },
    });
  }

  const draftsA = [t(langA, "matchHeadline"), t(langA, "matchStreamStart"), ...splitPitchIntoDrafts(pitchForA)];
  const draftsB = [t(langB, "matchHeadline"), t(langB, "matchStreamStart"), ...splitPitchIntoDrafts(pitchForB)];

  const kbA = buildMatchKeyboard(matchId, langA);
  const kbB = buildMatchKeyboard(matchId, langB);

  await Promise.all([
    stream(api, Number(match.userA.telegramId), draftsA, {
      replyMarkup: kbA,
    }),
    stream(api, Number(match.userB.telegramId), draftsB, {
      replyMarkup: kbB,
    }),
  ]);
}
