import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { normalizePhoneE164 } from "@gennety/shared";
import type { Language } from "@gennety/shared";
import { onboardingActivityPatch } from "../../workers/re-engagement-schedule.js";

/**
 * Registration v2 — phone verification for the GENERAL track (ported from the
 * beta clone, where it replaced the university-email gate outright; here it is
 * one branch of the sign-up fork and the student email OTP path is untouched).
 *
 * Trusted path: when the user shares their number via the Mini App one-tap
 * `WebApp.requestContact` (or a `request_contact` reply-keyboard button),
 * Telegram delivers a `message.contact` to the bot. We trust ONLY the user's
 * own, Telegram-vouched number (`contact.user_id === from.id`) — never a
 * forwarded/other contact, and never a number POSTed by client JS. On success
 * we persist `phone` + `phoneVerifiedAt`; the onboarding Mini App polls
 * `/v1/telegram-onboarding/state`, sees the verified phone, and advances itself.
 */
export async function handlePhoneContact(ctx: BotContext): Promise<void> {
  const contact = ctx.message?.contact;
  const fromId = ctx.from?.id;
  if (!contact || !fromId) return;

  const lang = ctx.session.language ?? "en";

  // Only the user's OWN, Telegram-vouched number. A shared/forwarded contact
  // carries a different (or missing) user_id.
  if (contact.user_id !== fromId) {
    await ctx.reply(phoneCopy(lang, "notOwn"));
    return;
  }

  const phone = normalizePhoneE164(contact.phone_number);
  if (!phone) {
    await ctx.reply(phoneCopy(lang, "invalid"));
    return;
  }

  const telegramId = BigInt(fromId);
  try {
    // Stamp the general track only when no track is chosen yet (covers the
    // reply-keyboard fallback that bypasses the Mini App fork). A student-track
    // user sharing their contact must NOT be silently switched off the email
    // gate — the /complete contact gate reads the track, not the phone.
    const existing = await prisma.user.findUnique({
      where: { telegramId },
      select: { registrationTrack: true },
    });
    await prisma.user.update({
      where: { telegramId },
      data: {
        phone,
        phoneVerifiedAt: new Date(),
        ...(existing?.registrationTrack ? {} : { registrationTrack: "general" }),
        ...onboardingActivityPatch(),
      },
    });
  } catch (err) {
    // `User.phone` is @unique — P2002 means this number is already linked to a
    // different Telegram account (one account per number).
    if (isUniqueViolation(err)) {
      await ctx.reply(phoneCopy(lang, "taken"));
      return;
    }
    throw err;
  }

  await ctx.reply(phoneCopy(lang, "ok"));
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

type PhoneCopyKey = "ok" | "notOwn" | "invalid" | "taken";

/**
 * Inline localized confirmations (same approach as `handlers/start.ts`). The
 * Mini App drives the visible UX; these short replies cover the chat surface and
 * the reply-keyboard fallback. Migrate to shared i18n if the flow grows.
 */
function phoneCopy(lang: Language, key: PhoneCopyKey): string {
  const copy: Record<Language, Record<PhoneCopyKey, string>> = {
    en: {
      ok: "✅ Phone number confirmed.",
      notOwn: "Please share *your own* number using the button (not another contact).",
      invalid: "That number didn't look valid. Please try sharing it again.",
      taken: "This number is already linked to another account.",
    },
    ru: {
      ok: "✅ Номер телефона подтверждён.",
      notOwn: "Поделись, пожалуйста, *своим* номером через кнопку (не чужим контактом).",
      invalid: "Номер выглядит некорректным. Попробуй поделиться им ещё раз.",
      taken: "Этот номер уже привязан к другому аккаунту.",
    },
    uk: {
      ok: "✅ Номер телефону підтверджено.",
      notOwn: "Поділися, будь ласка, *своїм* номером через кнопку (не чужим контактом).",
      invalid: "Номер виглядає некоректним. Спробуй поділитися ним ще раз.",
      taken: "Цей номер уже прив'язаний до іншого акаунта.",
    },
    de: {
      ok: "✅ Telefonnummer bestätigt.",
      notOwn: "Bitte teile *deine eigene* Nummer über den Button (keinen anderen Kontakt).",
      invalid: "Die Nummer schien ungültig. Bitte versuche es erneut.",
      taken: "Diese Nummer ist bereits mit einem anderen Konto verknüpft.",
    },
    pl: {
      ok: "✅ Numer telefonu potwierdzony.",
      notOwn: "Udostępnij proszę *swój* numer przyciskiem (nie cudzy kontakt).",
      invalid: "Numer wygląda na nieprawidłowy. Spróbuj udostępnić go ponownie.",
      taken: "Ten numer jest już powiązany z innym kontem.",
    },
  };
  return copy[lang]?.[key] ?? copy.en[key];
}
