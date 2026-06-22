import { fileURLToPath } from "node:url";
import { InlineKeyboard, InputFile, type Api } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { buildPersonaHostedUrl } from "../../services/persona.js";
import { terminalVerificationMessage } from "../../services/verification-messages.js";
import { pullVerificationStatus } from "../../services/verification-pipeline.js";
import { showMainMenu } from "../menu/main.js";
import { pinStatusBanner } from "../../services/status-banner.js";
import { UNVERIFIED_ELO_PENALTY } from "../../utils/elo-calculator.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import { skipAnalysisSteps } from "../../services/analysis-status.js";
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
 * Callback data for the "I'm done" button — pull-fallback when Persona's
 * webhook hasn't landed yet (or never will, e.g. local dev). See
 * `pullVerificationStatus` for the full semantic.
 */
export const VERIFY_CHECK_CALLBACK = "verify:check";

/**
 * Send the Persona liveness CTA to the user at the end of onboarding.
 *
 * Two buttons:
 *   • Verify now → `web_app` button opening the Verification Mini App
 *     (`verification.html`), which mounts Persona's Embedded SDK inline
 *     inside the Telegram WebView — no redirect to withpersona.com,
 *     no in-app browser frame. The Mini App POSTs back to
 *     `/v1/verification/mini-app/event` on terminal SDK events, which
 *     fires the same pull-fallback the old "I've finished" button used.
 *   • Skip for now → callback button (`verify:skip`) that drops the
 *     user into the voice-nudge confirmation step without applying a penalty.
 *
 * The legacy hosted-URL path is kept as a dev/fallback safety net when
 * `WEBAPP_URL` isn't configured (local dev without a tunnel) — see below.
 * `handleVerificationCheck` and the `verify:check` callback stay registered
 * because the deep-link auto-poll (`?start=verify_done`) still routes
 * through them as a webhook fallback.
 *
 * Returns true when the CTA was sent, false when the caller should fall
 * back to the normal main-menu flow (Persona disabled or misconfigured).
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
  if (!env.ENABLE_PERSONA_VERIFICATION) return false;
  if (!env.PERSONA_TEMPLATE_ID || !env.PERSONA_ENVIRONMENT_ID) {
    return false;
  }
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return false;

  // Mark pending so elsewhere in the bot we can surface "review in progress".
  // Mirrors the same write the Mini App's /init endpoint does — leaving
  // it here keeps the dev/fallback URL path consistent with prod.
  await prisma.user
    .update({
      where: { id: user.id },
      data: { verificationStatus: "pending" },
    })
    .catch(() => {});

  const keyboard = new InlineKeyboard();
  if (!appendVerifyNowButton(keyboard, lang, user.id, t(lang, "verifyBtnGo"))) {
    return false;
  }
  keyboard.success();
  keyboard.row().text(t(lang, "verifyBtnSkip"), VERIFY_SKIP_CALLBACK);

  const pitchKey = env.TICKET_FEATURE_ENABLED
    ? "verifyPitchTicket"
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
 * Append the "Verify now" affordance to a keyboard: the embedded Verification
 * Mini App in production (no browser frame, native camera permissions inside
 * Telegram), or the hosted Persona URL as a dev/fallback when WEBAPP_URL isn't
 * a real HTTPS host (local dev without a tunnel, where Telegram can't open the
 * Mini App over `example.invalid`).
 *
 * Returns false when neither could be built (hosted-URL construction threw) so
 * the caller can decide whether that is fatal (CTA aborts; the skip-nudge fork
 * just drops the button and keeps the "Skip anyway" option).
 */
function appendVerifyNowButton(
  keyboard: InlineKeyboard,
  lang: Language,
  userId: string,
  label: string,
): boolean {
  const miniAppHost = env.WEBAPP_URL;
  const useMiniApp =
    miniAppHost.startsWith("https://") &&
    !miniAppHost.includes("example.invalid");

  if (useMiniApp) {
    const miniAppUrl = `${miniAppHost.replace(/\/+$/, "")}/verification.html?lang=${lang}`;
    keyboard.webApp(label, miniAppUrl);
    return true;
  }
  try {
    const url = buildPersonaHostedUrl(userId);
    keyboard.url(label, url);
    console.warn(
      "[verification] WEBAPP_URL not configured — falling back to hosted Persona URL",
    );
    return true;
  } catch (err) {
    console.error("[persona] CTA URL build failed:", err);
    return false;
  }
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
  const captionKey = env.TICKET_FEATURE_ENABLED
    ? "verifySkipNudgeCaptionTicket"
    : "verifySkipNudgeCaption";
  const caption = t(lang, captionKey, {
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
 * Handle the "✅ I'm done" button — pull Persona's REST API for the user's
 * latest inquiry and run the pipeline if it's `approved`. Used for cases
 * where the webhook hasn't arrived yet (or never will, in local dev).
 *
 * Webhook stays primary in production — this is a safety net + the only
 * path that works locally without a public tunnel.
 */
export async function handleVerificationCheck(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;

  const outcome = await pullVerificationStatus(user.id, ctx.api);

  switch (outcome.kind) {
    case "pipeline_ran":
      // The pipeline already DM'd the user (verified / pending_review /
      // rejected outcome message). Nothing more to do here.
      return;
    case "already_done":
      // Webhook beat us to it OR user double-tapped after a previous pull.
      // Remind them of the stored terminal state so the click is never silent
      // and doesn't rely on an older message still being visible.
      await ctx.reply(terminalVerificationMessage(lang, outcome.verificationStatus));
      return;
    case "no_inquiry":
      await ctx.reply(t(lang, "verifyCheckNoInquiry"));
      return;
    case "still_pending":
      await ctx.reply(t(lang, "verifyCheckPending"));
      return;
    case "persona_failed":
      await ctx.reply(t(lang, "verifyCheckPersonaFailed"));
      return;
    case "infra_error":
      await ctx.reply(t(lang, "verifyCheckInfraError"));
      return;
  }
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

  const keyboard = new InlineKeyboard();
  const hasVerifyButton = appendVerifyNowButton(
    keyboard,
    lang,
    user.id,
    t(lang, "verifyBtnReconsider"),
  );
  if (hasVerifyButton) keyboard.success();
  const skipConfirmKey = env.TICKET_FEATURE_ENABLED
    ? "verifyBtnSkipConfirmTicket"
    : "verifyBtnSkipConfirm";
  keyboard
    .row()
    .text(t(lang, skipConfirmKey), VERIFY_SKIP_CONFIRM_CALLBACK)
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

  // Even when the user skips Persona, narrate the profile build so the app
  // feels like it's working rather than going silent on activation.
  if (ctx.chat?.id !== undefined) {
    await runStatusSequence(ctx.api, ctx.chat.id, skipAnalysisSteps(lang), { rich: true });
  }

  await ctx.reply(t(lang, "verifySkipped"));
  await showMainMenu(ctx);
  await pinStatusBanner(ctx.api, telegramId, lang);
}
