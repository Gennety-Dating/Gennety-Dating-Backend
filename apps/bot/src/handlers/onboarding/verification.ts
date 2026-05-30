import { InlineKeyboard, type Api } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { buildPersonaHostedUrl } from "../../services/persona.js";
import { terminalVerificationMessage } from "../../services/verification-messages.js";
import { pullVerificationStatus } from "../../services/verification-pipeline.js";
import { showMainMenu } from "../menu/main.js";
import { pinStatusBanner } from "../../services/status-banner.js";
import { UNVERIFIED_ELO_PENALTY } from "../../utils/elo-calculator.js";
import type { BotContext } from "../../session.js";

/** Callback data for the "Skip verification" button on the CTA card. */
export const VERIFY_SKIP_CALLBACK = "verify:skip";
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
 *     user's ELO score and activates them as `verificationStatus=unverified`.
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

  // Prefer the embedded Mini App in production (no browser frame, native
  // camera permissions inside Telegram). Falls back to the hosted-URL flow
  // only when WEBAPP_URL isn't set up — local dev without a tunnel, where
  // Telegram can't open the Mini App over `example.invalid`.
  const miniAppHost = env.WEBAPP_URL;
  const useMiniApp =
    miniAppHost.startsWith("https://") &&
    !miniAppHost.includes("example.invalid");

  if (useMiniApp) {
    const miniAppUrl = `${miniAppHost.replace(/\/+$/, "")}/verification.html?lang=${lang}`;
    keyboard.webApp(t(lang, "verifyBtnGo"), miniAppUrl);
  } else {
    try {
      const url = buildPersonaHostedUrl(user.id);
      keyboard.url(t(lang, "verifyBtnGo"), url);
      console.warn(
        "[verification] WEBAPP_URL not configured — falling back to hosted Persona URL",
      );
    } catch (err) {
      console.error("[persona] CTA URL build failed:", err);
      return false;
    }
  }

  keyboard.row().text(t(lang, "verifyBtnSkip"), VERIFY_SKIP_CALLBACK);

  await api.sendMessage(chatId, t(lang, "verifyPitch"), { reply_markup: keyboard });
  return true;
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
 * Handle the "Skip" button on the verification CTA. Drops the user's
 * starting Elo by `UNVERIFIED_ELO_PENALTY`, marks them activated but
 * unverified, and surfaces the main menu + status banner.
 *
 * Strict idempotency: a second tap (or a Telegram callback retry) early-returns
 * after acking the callback. Without the gate the visible side-effects
 * (`verifySkipped` ack + `showMainMenu` + `pinStatusBanner`) all re-fired,
 * which is what the user-reported "menu duplicates twice at the end of
 * onboarding" was: same handler executed twice. The Elo penalty path is
 * still doubly safe via `verificationSkippedAt IS NULL` below, but the
 * gate here removes the duplicate render before that even matters.
 */
export async function handleVerificationSkip(ctx: BotContext): Promise<void> {
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

  await ctx.reply(t(lang, "verifySkipped"));
  await showMainMenu(ctx);
  await pinStatusBanner(ctx.api, telegramId, lang);
}
