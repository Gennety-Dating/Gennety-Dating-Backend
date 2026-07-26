import { fileURLToPath } from "node:url";
import { InlineKeyboard, InputFile, type Api } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { terminalVerificationMessage } from "../../services/verification-messages.js";
import { showMainMenu } from "../menu/main.js";
import { pinStatusBanner } from "../../services/status-banner.js";
import { notifyFounderNewUser } from "../../services/founder-notify.js";
import { UNVERIFIED_ELO_PENALTY } from "../../utils/elo-calculator.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import { skipAnalysisSteps } from "../../services/analysis-status.js";
import { computeNextTouch } from "../../workers/re-engagement-schedule.js";
import { isVerificationGated } from "../../services/verification-gate.js";
import {
  appendVerifyNowButton,
  buildVerificationKeyboard,
} from "../../services/verification-keyboard.js";
import type { BotContext } from "../../session.js";

/**
 * Callback data for the "Skip verification" button on the CTA card. This is now
 * a *soft* skip: it does NOT apply the Elo penalty. Instead it plays a short
 * personal voice nudge and offers a fork — reconsider (verify) or confirm the
 * skip via {@link VERIFY_SKIP_CONFIRM_CALLBACK}.
 */
export const VERIFY_SKIP_CALLBACK = "verify:skip";
/**
 * Callback data for the "Skip anyway" button shown under the voice nudge. This
 * is the hard skip that actually applies {@link UNVERIFIED_ELO_PENALTY} and
 * activates the user as `unverified`.
 */
export const VERIFY_SKIP_CONFIRM_CALLBACK = "verify:skip:confirm";
/**
 * Callback data for the legacy "I'm done" button. Nothing renders it any more
 * (Face Liveness returns its verdict synchronously, so there is no pull to
 * make) — the handler survives only so a stale keyboard isn't a dead tap.
 * See {@link handleVerificationCheck}.
 */
export const VERIFY_CHECK_CALLBACK = "verify:check";

/**
 * Send the liveness CTA to the user at the end of onboarding.
 *
 * Buttons:
 *   • Verify now → `web_app` button opening the Verification Mini App
 *     (`verification.html`), which runs AWS Face Liveness inline
 *     inside the Telegram WebView — no redirect anywhere,
 *     no in-app browser frame. The Mini App POSTs back to
 *     `/v1/verification/mini-app/event` on terminal detector events. That
 *     request reads AWS's verdict directly and starts the face-match pipeline.
 *   • Upload different photos → the way back. This screen is the first place
 *     the user learns their photos will be face-matched, so someone who
 *     uploaded photos of another person must be able to retreat and swap them
 *     rather than being stranded in front of a check they know they will fail.
 *   • Skip for now → callback button (`verify:skip`) that drops the
 *     user into the voice-nudge confirmation step without applying a penalty.
 *     Retired while `MANDATORY_VERIFICATION_ENABLED` is on.
 *
 * There is no non-Mini-App fallback: Face Liveness runs in our own page, so a
 * deploy without a real `WEBAPP_URL` has nowhere to send the user and the CTA
 * refuses rather than rendering a dead button.
 *
 * Returns true when the CTA was sent, false when the caller should fall
 * back to the normal main-menu flow (liveness disabled or misconfigured).
 */
export async function sendVerificationCTA(ctx: BotContext): Promise<boolean> {
  return sendVerificationCTABare(
    ctx.api,
    ctx.chat!.id,
    BigInt(ctx.from!.id),
    ctx.session.language,
  );
}

/**
 * Ctx-free variant of {@link sendVerificationCTA}. Used by background flows
 * (e.g. the photo-batch debounced flush in `conversational.ts`) where the
 * live `BotContext` has already been released.
 */
export async function sendVerificationCTABare(
  api: Api,
  chatId: number,
  telegramId: bigint,
  lang: Language,
): Promise<boolean> {
  if (!env.FACE_LIVENESS_ENABLED) return false;
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, theme: true },
  });
  if (!user) return false;

  // Mark pending so elsewhere in the bot we can surface "review in progress".
  // Mirrors the same write the Mini App's /init endpoint does.
  // Registration v2 (mandatory liveness): re-arm the re-engagement chain at the
  // CTA so a user who stalls here (onboardingStep=completed, still not active)
  // gets the verification-stall nudges — the main onboarding chain stops at
  // `completed` and would otherwise never touch them again.
  const now = new Date();
  await prisma.user
    .update({
      where: { id: user.id },
      data: {
        verificationStatus: "pending",
        ...(env.MANDATORY_VERIFICATION_ENABLED
          ? { reEngagementStep: 0, reEngagementNextAt: computeNextTouch(1, now, now) }
          : {}),
      },
    })
    .catch(() => {});

  const keyboard = await buildVerificationKeyboard(lang, user.id, {
    theme: user.theme,
  });
  if (!keyboard) return false;
  // Registration v2 (mandatory liveness): no Skip affordance — verification is
  // the only path to activation. The soft-skip flow survives solely for legacy
  // CTA messages sent before the flag flip (see the skip handlers below).
  if (!env.MANDATORY_VERIFICATION_ENABLED) {
    keyboard.row().text(t(lang, "verifyBtnSkip"), VERIFY_SKIP_CALLBACK);
  }

  const pitchKey = env.MANDATORY_VERIFICATION_ENABLED
    ? "verifyPitchMandatory"
    : "verifyPitch";
  await api.sendMessage(
    chatId,
    t(lang, pitchKey, { penalty: UNVERIFIED_ELO_PENALTY }),
    {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    },
  );
  return true;
}

/**
 * Languages with a recorded skip-nudge voice asset. The onboarding Mini App
 * language picker offers all five (en/ru/uk/de/pl), each with a dubbed voice
 * note in `assets/verify-skip/<lang>.ogg`. A language outside this set (should
 * never happen) falls back to the text caption.
 */
const SKIP_NUDGE_VOICE_LANGS = new Set<Language>([
  "en",
  "ru",
  "uk",
  "de",
  "pl",
]);

/**
 * In-memory cache of Telegram `file_id`s for the skip-nudge voice notes, keyed
 * by language. The first send uploads the local OGG/Opus asset; Telegram
 * returns a `file_id` we reuse for every subsequent send so we never re-upload.
 * Process-local (resets on restart), which is fine — it self-heals on the next
 * upload.
 */
const skipNudgeVoiceFileIds = new Map<Language, string>();

/** Absolute path to the bundled OGG/Opus skip-nudge voice for a language. */
function skipNudgeVoicePath(lang: Language): string {
  return fileURLToPath(
    new URL(`../../assets/verify-skip/${lang}.ogg`, import.meta.url),
  );
}

/**
 * Send the personal "please don't skip" voice note as a NATIVE Telegram voice
 * message (`sendVoice` → OGG/Opus renders with a waveform + inline one-tap
 * player, not a file attachment), with the reconsider/skip-anyway fork attached
 * directly to it. Caches the resulting `file_id`. If the asset is missing or
 * the send fails, falls back to a plain text message carrying the same fork so
 * the user is never stranded without a way to proceed.
 */
async function sendSkipNudge(
  api: Api,
  chatId: number,
  lang: Language,
  keyboard: InlineKeyboard,
): Promise<void> {
  const caption = t(lang, "verifySkipNudgeCaption", {
    penalty: UNVERIFIED_ELO_PENALTY,
  });
  if (SKIP_NUDGE_VOICE_LANGS.has(lang)) {
    try {
      const cached = skipNudgeVoiceFileIds.get(lang);
      const voice = cached ?? new InputFile(skipNudgeVoicePath(lang));
      const msg = await api.sendVoice(chatId, voice, {
        caption,
        reply_markup: keyboard,
      });
      const fileId = msg.voice?.file_id;
      if (fileId && !cached) skipNudgeVoiceFileIds.set(lang, fileId);
      return;
    } catch (err) {
      // A stale cached file_id, a missing asset, or a transient Bot API error
      // must never block the skip flow — fall through to the text fork.
      skipNudgeVoiceFileIds.delete(lang);
      console.error("[verification] skip-nudge voice failed:", err);
    }
  }
  await api.sendMessage(chatId, caption, { reply_markup: keyboard });
}

/**
 * Handle a tap on the legacy "✅ I'm done" button.
 *
 * Under Persona this pulled their REST API, because the verification result
 * arrived asynchronously (a webhook that might be late, or in local dev never
 * arrive at all). Face Liveness has no async leg — the result is read inside
 * the `/event` request and the outcome DM follows immediately — so there is
 * nothing left to poll and no surface still renders this button.
 *
 * The handler stays only so a stale keyboard in an old chat isn't a dead tap:
 * it reports the stored status, and re-offers verification when there is still
 * something to do.
 */
export async function handleVerificationCheck(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, verificationStatus: true },
  });
  if (!user) return;

  if (
    user.verificationStatus === "verified" ||
    user.verificationStatus === "rejected" ||
    user.verificationStatus === "pending_review"
  ) {
    await ctx.reply(terminalVerificationMessage(lang, user.verificationStatus));
    return;
  }

  // `pending` / `unverified` — they never finished a check. Re-offer it.
  const keyboard = await buildVerificationKeyboard(lang, user.id);
  await ctx.reply(t(lang, "verifyReminderNudge"), {
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

/**
 * Registration v2 (mandatory liveness): tell the user verification is now
 * required and re-offer the Verify button. Used when a legacy Skip / Skip-anyway
 * callback fires after `MANDATORY_VERIFICATION_ENABLED` was flipped on.
 */
async function sendMandatoryVerifyNotice(
  api: Api,
  chatId: number,
  lang: Language,
  userId: string,
): Promise<void> {
  const keyboard = await buildVerificationKeyboard(lang, userId);
  await api.sendMessage(chatId, t(lang, "verifyMandatoryNotice"), {
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

/**
 * Registration v2 (mandatory liveness): the verification-stall re-engagement
 * touch — the profile is done, only the liveness check remains. Sent by the re-engagement
 * worker on the standard decaying cadence (see `runReEngagementSweep`).
 */
export async function sendVerificationReminder(
  api: Api,
  chatId: number,
  lang: Language,
  userId: string,
  prefix?: string,
): Promise<void> {
  const keyboard = await buildVerificationKeyboard(lang, userId);
  const body = t(lang, "verifyReminderNudge");
  await api.sendMessage(chatId, prefix ? `${prefix}\n\n${body}` : body, {
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}

/**
 * A user who FINALIZED onboarding (`onboardingStep = completed`) but is still
 * held at `status = onboarding` reopened the bot. The only thing that leaves a
 * user in that state is the liveness gate (see `finalize_onboarding`):
 * they have NOT been activated and the matchmaker has NOT started searching for
 * them. Surfacing the normal "your AI is already looking for a match" greeting
 * here misleads them — matching is paused until they clear verification.
 *
 * Instead, tell them their ACTUAL verification state:
 *   • `pending_review` — the pipeline ran and we're double-checking their
 *     photos; nothing for them to do, so no button.
 *   • `rejected` — their photos didn't match the selfie; the copy points them
 *     at Settings → re-verify (fix photos, retry).
 *   • `pending` / `unverified` (default) — they never completed the check, so
 *     re-offer the Verify button; matching begins right after it passes.
 *
 * Returns true when a gate notice was sent (the caller should then SKIP the
 * misleading `onboardingComplete` greeting and the next-match banner). Returns
 * false only for the defensive `verified`-but-not-active edge, so the caller
 * can fall back to the normal greeting.
 */
export async function sendVerificationGateNotice(
  api: Api,
  chatId: number,
  telegramId: bigint,
  lang: Language,
  options: { locked?: boolean } = {},
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, verificationStatus: true },
  });
  if (!user) return false;

  // Only prefix the "the menu opens right after verification" line when the
  // card was triggered by a blocked tap — on /start it would read as a scold.
  const prefix = options.locked ? t(lang, "verifyGateLocked") : undefined;
  const withPrefix = (body: string): string =>
    prefix ? `${prefix}\n\n${body}` : body;

  switch (user.verificationStatus) {
    case "verified":
      // A verified user should already be `active`; if we somehow land here,
      // let the caller show the normal greeting rather than a stale nudge.
      return false;
    case "pending_review":
      // Nothing for the user to do — an admin is moderating. No buttons.
      await api.sendMessage(chatId, t(lang, "verifyOutcomePendingReview"));
      return true;
    case "rejected": {
      // The photos didn't match the selfie. Both recoveries ride the message:
      // swap the photos (the pipeline then re-checks them against the selfie
      // already on file) or re-run the liveness check. A face WAS detected here
      // and didn't match, so "these aren't my photos" is the more likely fix —
      // lead with it (see `buildVerificationKeyboard`'s `photoRedoFirst`).
      const keyboard = await buildVerificationKeyboard(lang, user.id, {
        photoRedoFirst: true,
      });
      await api.sendMessage(chatId, withPrefix(t(lang, "verifyOutcomeRejected")), {
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      return true;
    }
    default:
      await sendVerificationReminder(api, chatId, lang, user.id, prefix);
      return true;
  }
}

/**
 * Gate helper for entry points that live OUTSIDE the FSM router — the
 * `/menu`, `/edit`, `/profile` and `/settings` commands are registered on the
 * `start` composer, which runs before `handlers/router.ts` and its gate.
 *
 * Returns true when the caller is verification-gated and the card was sent, in
 * which case the command must not proceed.
 */
export async function blockIfVerificationGated(ctx: BotContext): Promise<boolean> {
  if (!ctx.from?.id || !ctx.chat) return false;

  const telegramId = BigInt(ctx.from.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { status: true, onboardingStep: true },
  });
  if (!isVerificationGated(user)) return false;

  await sendVerificationGateNotice(
    ctx.api,
    ctx.chat.id,
    telegramId,
    ctx.session.language,
    { locked: true },
  );
  return true;
}

/**
 * Handle the "Skip" button on the verification CTA — the *soft* skip.
 *
 * Instead of immediately applying the Elo penalty, this plays a short personal
 * voice note ("please don't skip — your rating will drop") as a native Telegram
 * voice message and offers a fork: reconsider and verify, or
 * {@link VERIFY_SKIP_CONFIRM_CALLBACK} ("Skip anyway") to actually commit the
 * skip. The real penalty/activation lives in {@link handleVerificationSkipConfirm}.
 *
 * Idempotency: if the user has already committed a skip
 * (`verificationSkippedAt` set), this acks the callback and returns without
 * re-playing the nudge.
 */
export async function handleVerificationSkip(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const lang = ctx.session.language;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true, verificationSkippedAt: true },
  });
  if (!user) return;

  // Already committed a skip — the nudge is moot, don't re-play it.
  if (user.verificationSkippedAt) return;

  // Registration v2 (mandatory liveness): a Skip tap on a legacy CTA message
  // (sent before the flag flip) no longer opens the soft-skip fork — explain
  // the new rule and re-offer the Verify button so the user is never stranded.
  if (env.MANDATORY_VERIFICATION_ENABLED) {
    await sendMandatoryVerifyNotice(ctx.api, ctx.chat!.id, lang, user.id);
    return;
  }

  const keyboard = new InlineKeyboard();
  const hasVerifyButton = await appendVerifyNowButton(
    keyboard,
    lang,
    user.id,
    t(lang, "verifyBtnReconsider"),
  );
  if (hasVerifyButton) keyboard.success();
  keyboard
    .row()
    .text(t(lang, "verifyBtnSkipConfirm"), VERIFY_SKIP_CONFIRM_CALLBACK)
    .danger();

  await sendSkipNudge(ctx.api, ctx.chat!.id, lang, keyboard);
}

/**
 * Handle "Skip anyway" — the *hard* skip confirmed after the voice nudge.
 * Drops the user's starting Elo by `UNVERIFIED_ELO_PENALTY`, marks them
 * activated but unverified, and surfaces the main menu + status banner.
 *
 * Strict idempotency: a second tap (or a Telegram callback retry) early-returns
 * after acking the callback. Without the gate the visible side-effects
 * (`verifySkipped` ack + `showMainMenu` + `pinStatusBanner`) all re-fired,
 * which is what the user-reported "menu duplicates twice at the end of
 * onboarding" was: same handler executed twice. The Elo penalty path is
 * still doubly safe via `verificationSkippedAt IS NULL` below, but the
 * gate here removes the duplicate render before that even matters.
 */
export async function handleVerificationSkipConfirm(
  ctx: BotContext,
): Promise<void> {
  await ctx.answerCallbackQuery();

  const telegramId = BigInt(ctx.from!.id);
  const lang = ctx.session.language;

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, verificationSkippedAt: true },
  });
  if (!user) return;

  // Idempotency: skip already applied. Acking the callback above is enough —
  // do NOT re-send menu / banner / "skipped" text on the second hit.
  if (user.verificationSkippedAt) return;

  // Registration v2 (mandatory liveness): a stale "Skip anyway" button from a
  // pre-flip nudge message must not activate an unverified user.
  if (env.MANDATORY_VERIFICATION_ENABLED) {
    await sendMandatoryVerifyNotice(ctx.api, ctx.chat!.id, lang, user.id);
    return;
  }

  await prisma.profile.updateMany({
    where: { userId: user.id },
    data: { eloScore: { decrement: UNVERIFIED_ELO_PENALTY } },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: {
      verificationStatus: "unverified",
      verificationSkippedAt: new Date(),
      status: "active",
      onboardingStep: "completed",
    },
  });

  // Founder ops feed: first activation via a soft-skip (no vision score yet).
  // Idempotent + status-gated inside the notifier; fire-and-forget.
  void notifyFounderNewUser(user.id).catch(() => {});

  // Even when the user skips verification, narrate the profile build so the app
  // feels like it's working rather than going silent on activation.
  if (ctx.chat?.id !== undefined) {
    await runStatusSequence(ctx.api, ctx.chat.id, skipAnalysisSteps(lang), { rich: true });
  }

  await ctx.reply(t(lang, "verifySkipped"));
  await showMainMenu(ctx);
  await pinStatusBanner(ctx.api, telegramId, lang);
}
