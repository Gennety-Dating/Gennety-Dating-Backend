import { InlineKeyboard, type Api } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { buildPersonaHostedUrl } from "../../services/persona.js";
import { showMainMenu } from "../menu/main.js";
import { pinStatusBanner } from "../../services/status-banner.js";
import type { BotContext } from "../../session.js";

/** Callback data for the "Skip verification" button on the CTA card. */
export const VERIFY_SKIP_CALLBACK = "verify:skip";

/**
 * Elo penalty applied to users who tap "Skip" on the verification CTA.
 * Default seed is 500 (`Profile.eloScore`); skipping drops them to 350,
 * which materially decays the V_league multiplier in match scoring and
 * surfaces fewer candidates — exactly the friction the CTA copy promises.
 *
 * The penalty is reversible: if the user later runs Persona successfully,
 * the webhook handler resets `verificationSkippedAt` and the cold-start
 * AI vision pass re-seeds `eloScore` to its true value.
 */
export const UNVERIFIED_ELO_PENALTY = 150;

/**
 * Send the Persona liveness CTA to the user at the end of onboarding.
 *
 * Two buttons:
 *   • Verify now → URL button opening the Persona hosted flow.
 *   • Skip for now → callback button (`verify:skip`) that drops the
 *     user's ELO score and activates them as `verificationStatus=unverified`.
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

  let url: string;
  try {
    url = buildPersonaHostedUrl(user.id);
  } catch (err) {
    console.error("[persona] CTA URL build failed:", err);
    return false;
  }

  // Mark pending so elsewhere in the bot we can surface "review in progress".
  await prisma.user
    .update({
      where: { id: user.id },
      data: { verificationStatus: "pending" },
    })
    .catch(() => {});

  const keyboard = new InlineKeyboard()
    .url(t(lang, "verifyBtnGo"), url)
    .row()
    .text(t(lang, "verifyBtnSkip"), VERIFY_SKIP_CALLBACK);

  await api.sendMessage(chatId, t(lang, "verifyPitch"), { reply_markup: keyboard });
  return true;
}

/**
 * Handle the "Skip" button on the verification CTA. Drops the user's
 * starting Elo by `UNVERIFIED_ELO_PENALTY`, marks them activated but
 * unverified, and surfaces the main menu.
 *
 * Idempotent: running it twice doesn't double-penalise the user — the
 * Elo update is gated on `verificationSkippedAt IS NULL`.
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

  // Apply the Elo penalty exactly once. updateMany returns 0 if the user
  // already skipped (e.g. button-spam), which prevents stacking penalties.
  if (!user.verificationSkippedAt) {
    await prisma.profile.updateMany({
      where: { userId: user.id },
      data: { eloScore: { decrement: UNVERIFIED_ELO_PENALTY } },
    });
  }

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
