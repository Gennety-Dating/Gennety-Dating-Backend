import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { normalizePhoneE164 } from "@gennety/shared";
import type { Language } from "@gennety/shared";
import { onboardingActivityPatch } from "../../workers/re-engagement-schedule.js";
import {
  ACCOUNT_LINK_SELECT,
  adoptAccountByPhone,
  classifyPhoneConflict,
} from "../../services/account-linking.js";
import { sendCompletedUserEntry } from "../start.js";

/**
 * Registration v2 — phone verification for the GENERAL track: one branch of the
 * sign-up fork, leaving the student email OTP path untouched.
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
    // `User.phone` is @unique — P2002 means another row already holds this
    // number. Telegram vouched that the number belongs to THIS account, and
    // Telegram allows one active account per number, so that row is the same
    // human: treat the collision as a login, not a refusal (PRODUCT_SPEC §1.1).
    if (isUniqueViolation(err)) {
      await resolvePhoneConflict(ctx, telegramId, phone, lang);
      return;
    }
    throw err;
  }

  await ctx.reply(phoneCopy(lang, "ok"));
}

/**
 * "Вход по номеру": the number is already on file, so hand this Telegram
 * account the existing profile instead of dead-ending the user. Only a
 * collision where BOTH rows carry real data needs a human (a true merge).
 */
async function resolvePhoneConflict(
  ctx: BotContext,
  telegramId: bigint,
  phone: string,
  lang: Language,
): Promise<void> {
  const [current, owner] = await Promise.all([
    prisma.user.findUnique({ where: { telegramId }, select: ACCOUNT_LINK_SELECT }),
    prisma.user.findUnique({ where: { phone }, select: ACCOUNT_LINK_SELECT }),
  ]);

  // Either row vanishing under us means the state has moved on; the safe answer
  // is the conservative one rather than a guess.
  if (!current || !owner) {
    await ctx.reply(phoneCopy(lang, "taken"));
    return;
  }

  const decision = classifyPhoneConflict(current, owner);
  if (decision.kind === "same") {
    await ctx.reply(phoneCopy(lang, "ok"));
    return;
  }
  if (decision.kind === "manual-merge") {
    await ctx.reply(phoneCopy(lang, "conflict"));
    return;
  }

  const adopted = await adoptAccountByPhone({
    ownerId: decision.ownerId,
    stubId: decision.stubId,
    telegramId,
    phone,
    telegramUsername: ctx.from?.username ?? null,
  });
  if (adopted.kind === "stale") {
    await ctx.reply(phoneCopy(lang, "taken"));
    return;
  }

  const user = adopted.user;
  // The session still carries the deleted row's onboarding position. Without
  // this sync the router would keep walking a fully onboarded user through
  // registration.
  ctx.session.onboardingStep = user.onboardingStep;
  if (user.language) ctx.session.language = user.language;
  const adoptedLang = user.language ?? lang;

  await ctx.reply(phoneCopy(adoptedLang, "welcomeBack"));

  if (user.onboardingStep === "completed") {
    await sendCompletedUserEntry(ctx, {
      telegramId: user.telegramId,
      status: user.status,
    });
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

type PhoneCopyKey =
  | "ok"
  | "notOwn"
  | "invalid"
  | "taken"
  | "welcomeBack"
  | "conflict";

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
      welcomeBack: "✅ Number confirmed — welcome back! This is your existing account.",
      conflict:
        "This number belongs to another Gennety account, and this one already " +
        "has your data — we can't merge them automatically. Write to " +
        "@gennetysupport and we'll sort it out.",
    },
    ru: {
      ok: "✅ Номер телефона подтверждён.",
      notOwn: "Поделись, пожалуйста, *своим* номером через кнопку (не чужим контактом).",
      invalid: "Номер выглядит некорректным. Попробуй поделиться им ещё раз.",
      taken: "Этот номер уже привязан к другому аккаунту.",
      welcomeBack: "✅ Номер подтверждён — с возвращением! Это твой аккаунт.",
      conflict:
        "Этот номер привязан к другому аккаунту Gennety, а в текущем уже есть " +
        "твои данные — объединить их автоматически нельзя. Напиши " +
        "@gennetysupport, и мы всё решим.",
    },
    uk: {
      ok: "✅ Номер телефону підтверджено.",
      notOwn: "Поділися, будь ласка, *своїм* номером через кнопку (не чужим контактом).",
      invalid: "Номер виглядає некоректним. Спробуй поділитися ним ще раз.",
      taken: "Цей номер уже прив'язаний до іншого акаунта.",
      welcomeBack: "✅ Номер підтверджено — з поверненням! Це твій акаунт.",
      conflict:
        "Цей номер прив'язаний до іншого акаунта Gennety, а в поточному вже є " +
        "твої дані — об'єднати їх автоматично не вийде. Напиши " +
        "@gennetysupport, і ми все вирішимо.",
    },
    de: {
      ok: "✅ Telefonnummer bestätigt.",
      notOwn: "Bitte teile *deine eigene* Nummer über den Button (keinen anderen Kontakt).",
      invalid: "Die Nummer schien ungültig. Bitte versuche es erneut.",
      taken: "Diese Nummer ist bereits mit einem anderen Konto verknüpft.",
      welcomeBack:
        "✅ Nummer bestätigt — willkommen zurück! Das ist dein bestehendes Konto.",
      conflict:
        "Diese Nummer gehört zu einem anderen Gennety-Konto, und dieses hier " +
        "enthält bereits deine Daten — automatisch zusammenführen können wir " +
        "das nicht. Schreib an @gennetysupport, wir klären das.",
    },
    pl: {
      ok: "✅ Numer telefonu potwierdzony.",
      notOwn: "Udostępnij proszę *swój* numer przyciskiem (nie cudzy kontakt).",
      invalid: "Numer wygląda na nieprawidłowy. Spróbuj udostępnić go ponownie.",
      taken: "Ten numer jest już powiązany z innym kontem.",
      welcomeBack:
        "✅ Numer potwierdzony — witaj z powrotem! To twoje istniejące konto.",
      conflict:
        "Ten numer należy do innego konta Gennety, a to już zawiera twoje dane " +
        "— nie możemy połączyć ich automatycznie. Napisz do @gennetysupport, " +
        "a wszystko ustalimy.",
    },
  };
  return copy[lang]?.[key] ?? copy.en[key];
}
