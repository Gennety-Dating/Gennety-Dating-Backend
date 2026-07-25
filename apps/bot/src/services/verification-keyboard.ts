import { InlineKeyboard } from "grammy";
import { prisma, type Theme } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { buildPersonaHostedUrl } from "./persona.js";
import { buildMiniAppUrl } from "./mini-app-url.js";

/**
 * Callback data for "Upload different photos" — the way BACK from a
 * verification prompt to the photo manager.
 *
 * Registration v2 made liveness mandatory, but the user only learns their
 * photos will be face-matched *after* they have uploaded them. Someone who put
 * up photos of another person had no way to retreat: the CTA carried a single
 * "Verify now" button, and the only photo editor lived behind the main menu.
 * Every screen that asks for verification now also offers this.
 */
export const VERIFY_PHOTOS_CALLBACK = "verify:photos";

/**
 * Callback data for "Delete all and start over" — shown inside the photo
 * manager only while it was opened through {@link VERIFY_PHOTOS_CALLBACK}.
 * One tap for the common case ("none of these photos are me").
 */
export const VERIFY_PHOTOS_CLEAR_CALLBACK = "verify:photos:clear";

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
export async function appendVerifyNowButton(
  keyboard: InlineKeyboard,
  lang: Language,
  userId: string,
  label: string,
  knownTheme?: Theme,
): Promise<boolean> {
  const miniAppHost = env.WEBAPP_URL;
  const useMiniApp =
    miniAppHost.startsWith("https://") &&
    !miniAppHost.includes("example.invalid");

  if (useMiniApp) {
    const theme =
      knownTheme ??
      (
        await prisma.user.findUnique({
          where: { id: userId },
          select: { theme: true },
        })
      )?.theme ??
      "dark";
    const miniAppUrl = buildMiniAppUrl("verification", { lang, theme });
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

export interface VerificationKeyboardOptions {
  /** Label for the Verify button; defaults to `verifyBtnGo`. */
  verifyLabel?: string;
  /** Include the "Upload different photos" row. Default true. */
  withPhotoRedo?: boolean;
  /** Pre-loaded theme, to skip the extra user lookup. */
  theme?: Theme;
}

/**
 * The standard verification keyboard: a green "Verify now" button over the
 * "Upload different photos" escape hatch.
 *
 * Lives here rather than in the verification handler so the face-match pipeline
 * can attach the same affordances to its rejection DM without importing a
 * handler (`handlers/onboarding/verification.ts` already imports the pipeline —
 * the reverse direction would be a cycle).
 *
 * Returns null when the Verify button could not be built at all (Persona
 * misconfigured), so callers can fall back to plain text rather than showing a
 * keyboard whose only remaining action is unrelated.
 */
export async function buildVerificationKeyboard(
  lang: Language,
  userId: string,
  options: VerificationKeyboardOptions = {},
): Promise<InlineKeyboard | null> {
  const { verifyLabel = t(lang, "verifyBtnGo"), withPhotoRedo = true, theme } = options;

  const keyboard = new InlineKeyboard();
  const hasVerify = await appendVerifyNowButton(
    keyboard,
    lang,
    userId,
    verifyLabel,
    theme,
  );
  if (!hasVerify) return null;
  keyboard.success();

  if (withPhotoRedo) {
    keyboard.row().text(t(lang, "verifyBtnRedoPhotos"), VERIFY_PHOTOS_CALLBACK);
  }
  return keyboard;
}
