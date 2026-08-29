import { describe, it, expect } from "vitest";
import { monthsPhrase, t, TRANSLATION_KEYS } from "./i18n.js";
import { SUPPORTED_LANGUAGES } from "./types.js";

/**
 * Keys that are legitimately byte-identical to English in de/pl.
 * Everything here must be either a pure template/glyph (nothing to translate)
 * or a deliberate product decision — never "we forgot".
 */
const ALLOWED_IDENTICAL_TO_EN = new Set<string>([
  // Deliberate fixed English brand line in all five locales (PRODUCT_SPEC §3.7a).
  "dateCardSlogan",
  // Pure glyphs / placeholder templates — no prose to translate.
  "btnLike",
  "btnDislike",
  "myProfileBody",
  "matchPhotoCaption",
  // "💎 {label} — {reason}" carries no words at all: the translated noun lives
  // in `matchSynergyLabel`, which the pitch needs as its own key to bold it via
  // a MessageEntity (the final pitch message has no `parse_mode`).
  "matchSynergyHeader",
  "coordProxyRelayNamedPrefix",
  // A coordination-card headline line that is just the product name plus a
  // question mark. pl phrases the ask as "Udostępnić / Telegram?", so its
  // second line lands byte-identical to English — nothing to translate.
  "coordCardAskHead2",
  // Bare domain on the referral card — a URL, not prose.
  "referralCardFooter",
  // "−{pct}%" on a plan card is a minus sign, a number and a percent sign — a
  // discount badge with no word in it. The translated part of that row is the
  // plan NAME (`premiumPlan3Months`) and the per-month price suffix
  // (`premiumPlanPerMonth`), neither of which is allowlisted.
  "premiumPlanSaveBadge",
  // "Gennety Premium" is a fixed brand line — identical across all locales.
  "menuPremium",
  "premiumHubTitle",
  "premiumInvoiceTitle",
  // "Rematch" is the product name on the Telegram payment sheet. It is an
  // established loanword in de/pl, so translating it would invent a term users
  // never see anywhere else in the product. ru/uk do localize it ("Реметч"),
  // because there the Latin spelling would read as foreign in Cyrillic copy.
  "rematchInvoiceTitle",
  "rematchInvoiceLabel",
  // "Details" is the ordinary German word, spelled exactly as in English.
  "statusButtonDateOpen",
  // Bare "{d}d {h}h" — Polish abbreviates days/hours the same way English does,
  // matching the existing `statusButtonDaysHours` ("Do dropu: {d}d {h}h").
  "statusTimeDaysHours",
]);
/**
 * Keys that are legitimately byte-identical between Ukrainian and Russian.
 * The two languages share a great deal of vocabulary, so an identical value is
 * not automatically a missing translation — but it is not automatically fine
 * either, and nothing used to tell the two apart. Every entry here must be a
 * pure glyph/template, a fixed brand line, a word that is genuinely the same in
 * both languages, or an explicit product decision — never "we forgot".
 */
const ALLOWED_IDENTICAL_UK_RU = new Set<string>([
  // Pure glyphs / placeholder templates / a bare domain — no prose to translate.
  "btnLike",
  "btnDislike",
  "myProfileBody",
  "matchPhotoCaption",
  // See the note in ALLOWED_IDENTICAL_TO_EN: the header is placeholders only,
  // and the translated noun lives in `matchSynergyLabel` (which is NOT
  // allowlisted — "Синергия" and "Синергія" genuinely differ).
  "matchSynergyHeader",
  "coordProxyRelayNamedPrefix",
  // Two interpolations, a separator and one word — and that word is "код" in
  // both languages. Inventing a difference to satisfy this guard would be
  // worse than recording that there is none.
  "eventRoundPushBody",
  "referralCardFooter",
  "coordCardAskHead2",
  "photoReceived",
  // Deliberate fixed English brand line in all five locales (PRODUCT_SPEC §3.7a).
  "dateCardSlogan",
  // "−{pct}%" on a plan card is a minus sign, a number and a percent sign — a
  // discount badge with no word in it. The translated part of that row is the
  // plan NAME (`premiumPlan3Months`) and the per-month price suffix
  // (`premiumPlanPerMonth`), neither of which is allowlisted.
  "premiumPlanSaveBadge",
  // Fixed brand lines — "Gennety Premium" / "Реметч" are product names, and the
  // Cyrillic spelling of Rematch is shared by both languages.
  "menuPremium",
  "premiumHubTitle",
  "premiumInvoiceTitle",
  "menuPremiumActive",
  "rematchInvoiceTitle",
  "rematchInvoiceLabel",
  // Single words that are spelled identically in Ukrainian and Russian.
  // Translating them would mean inventing a synonym nobody uses.
  "voicePromptSkipButton",
  // "Готово" is the same word in both — the label on the voice step's
  // confirmation button, where a forced synonym would be worse than the match.
  "voicePromptReviewDone",
  "menuBack",
  "reportBackBtn",
  "stallBtnCancelBack",
  "matchBtnKeepDeciding",
  "matchBtnDecline",
  "menuPause",
  "photoManagerDoneBtn",
  "settingsTheme",
  // Founder decision 2026-08-19 (DECISIONS.md): reviewed alongside the three
  // "Думаю…" status beats that WERE rewritten, and deliberately kept. "Го!" is
  // an English loanword equally at home in both languages, and "Погнали" /
  // "Не задано" are real Ukrainian — changing them is taste, not a fix.
  "philosophyContinue",
  "referralGiftContinue",
  "editPrefsNotSet",
]);

describe("t (translation)", () => {
  it("returns English string by default", () => {
    const result = t("en", "welcome");
    expect(result).toContain("Gennety Dating");
  });

  it("returns Russian string", () => {
    const result = t("ru", "welcome");
    expect(result).toContain("Gennety Dating");
  });

  it("returns Ukrainian string", () => {
    const result = t("uk", "welcome");
    expect(result).toContain("Gennety Dating");
  });

  it("returns German and Polish strings", () => {
    expect(t("de", "chooseLanguage")).toContain("Sprache");
    expect(t("pl", "chooseLanguage")).toContain("język");
  });

  it("interpolates parameters", () => {
    const result = t("en", "otpSent", { email: "test@stanford.edu" });
    expect(result).toContain("test@stanford.edu");
  });

  it("interpolates numeric parameters", () => {
    const result = t("en", "invalidAge", { min: 17, max: 35 });
    expect(result).toContain("17");
    expect(result).toContain("35");
  });

  it("returns all keys for all languages without throwing", () => {
    const keys: Array<Parameters<typeof t>[1]> = [
      "welcome", "chooseLanguage", "philosophyPitch", "philosophyContinue",
      "askEmail", "invalidEmail", "otpSent", "otpInvalid", "otpExpired",
      "emailVerified", "askFirstName", "askSurname", "askAge", "invalidAge",
      "llmDumpReceived",
      "askPhotos", "photoReceived", "photosEnough", "photosDone",
      "profileReview", "profileConfirm", "profileEdit", "onboardingComplete",
      "btnLike", "btnDislike", "btnContinuePhotos",
      // Phase 2 — Main Menu
      "menuTitle", "menuMyProfile", "menuEdit", "menuPause", "menuResume",
      "menuSettings", "menuHelp", "menuBack",
      "myProfileBody", "myProfileNoBio",
      "editProfileBody", "editProfilePhotosBtn", "editProfilePhotosStart",
      "editProfilePhotosSaved",
      "pauseConfirmed", "resumeConfirmed",
      "settingsTitle", "settingsLanguage", "settingsLanguagePick", "settingsLanguageSaved",
      "helpBody",
    ];

    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of keys) {
        expect(typeof t(lang, key)).toBe("string");
      }
    }
  });

  it("localizes core preregistration and onboarding keys for every supported language", () => {
    const keys = [
      "consentMessage",
      "consentAgree",
      "askEmail",
      "otpSent",
      "emailVerified",
      "chooseLanguage",
      "settingsLanguagePick",
      "verifyPitch",
      "verifyPitchMandatory",
      "verifySkipNudgeCaption",
      "verifyBtnSkipConfirm",
      "feedbackThanks",
    ] as const;

    for (const lang of SUPPORTED_LANGUAGES) {
      for (const key of keys) {
        const value = t(lang, key, { email: "test@stanford.edu" });
        expect(value.length).toBeGreaterThan(0);
        if (lang === "de" || lang === "pl") {
          expect(value).not.toBe(t("en", key, { email: "test@stanford.edu" }));
        }
      }
    }
  });

  // `deTranslations`/`plTranslations` are built as `{ ...translations.en, ...overrides }`,
  // so a key nobody overrode silently renders ENGLISH to the user rather than
  // failing. That shipped the whole pre-date coordination flow + the ticket DMs
  // in English to de/pl users. Nothing but this test catches the next one.
  it.each(["de", "pl"] as const)(
    "%s never falls through to the English string (spread-inheritance guard)",
    (lang) => {
      const leaked = TRANSLATION_KEYS.filter(
        (key) =>
          !ALLOWED_IDENTICAL_TO_EN.has(key) && t(lang, key) === t("en", key),
      );
      expect(
        leaked,
        `${leaked.length} ${lang} key(s) are byte-identical to English — either translate them, ` +
          `or add them to ALLOWED_IDENTICAL_TO_EN with a reason if there is genuinely nothing to translate.`,
      ).toEqual([]);
    },
  );
  // The de/pl guard above cannot see the ru/uk pair: those two are hand-written
  // tables, not spreads of English, so a forgotten Ukrainian string does not
  // fall back — it gets pasted from Russian instead, and reads to a Ukrainian
  // user as untranslated even when the word is technically valid in both. That
  // is exactly how three status beats shipped as "Думаю…" in both languages
  // (found 2026-08-19). An identical value is allowed only with a stated reason.
  it("uk is never a byte-identical copy of ru (hand-written-table guard)", () => {
    const leaked = TRANSLATION_KEYS.filter(
      (key) => !ALLOWED_IDENTICAL_UK_RU.has(key) && t("uk", key) === t("ru", key),
    );
    expect(
      leaked,
      `${leaked.length} uk key(s) are byte-identical to Russian — either translate them, ` +
        `or add them to ALLOWED_IDENTICAL_UK_RU with a reason if the two languages genuinely ` +
        `share the wording.`,
    ).toEqual([]);
  });

  // A cheaper, allowlist-free signal for the same class of copy-paste: letters
  // that exist in one alphabet and not the other. Ukrainian has no ы/э/ъ/ё and
  // Russian has no і/ї/є/ґ, so a hit is never a judgement call — it is a letter
  // the language does not contain. This is what would have caught "цей мэтч"
  // (uk, `matchDeclineDismissed`) the day it was written.
  const FOREIGN_LETTERS = {
    uk: /[ыэъёЫЭЪЁ]/,
    ru: /[іїєґІЇЄҐ]/,
  } as const;
  it.each(["uk", "ru"] as const)(
    "%s uses no letters from the other Cyrillic alphabet",
    (lang) => {
      const re = FOREIGN_LETTERS[lang];
      const leaked = TRANSLATION_KEYS.filter((key) => re.test(t(lang, key)));
      expect(
        leaked,
        `${lang} key(s) contain letters that do not exist in that alphabet: ${leaked.join(", ")}`,
      ).toEqual([]);
    },
  );

  // Byte-identical-to-English is not the only way English leaks: a key can be
  // *partly* translated yet keep an English interjection or tech phrase inline
  // (e.g. "Heads up - dein Match…", "это by design", "face-match check"). Those
  // survive the spread-inheritance guard above because the string as a whole
  // differs from English. This catches the residue directly.
  const ENGLISH_RESIDUE = [
    /\bHeads up\b/i,
    /\bby design\b/i,
    /\bface-match check\b/i,
  ];
  it.each(["ru", "uk", "de", "pl"] as const)(
    "%s carries no untranslated English interjections/tech phrases",
    (lang) => {
      const leaked = TRANSLATION_KEYS.filter((key) =>
        ENGLISH_RESIDUE.some((re) => re.test(t(lang, key))),
      );
      expect(
        leaked,
        `${lang} key(s) still contain raw English: ${leaked.join(", ")}`,
      ).toEqual([]);
    },
  );

  it("menu keys contain expected action labels in English", () => {
    expect(t("en", "menuMyProfile")).toContain("My Profile");
    expect(t("en", "menuPause")).toContain("Pause");
    expect(t("en", "menuResume")).toContain("Resume");
    expect(t("en", "menuSettings")).toContain("Settings");
  });

  it("monthsPhrase declines the unit word for every supported language", () => {
    expect(monthsPhrase("en", 1)).toBe("1 month");
    expect(monthsPhrase("en", 3)).toBe("3 months");
    expect(monthsPhrase("de", 1)).toBe("1 Monat");
    expect(monthsPhrase("de", 3)).toBe("3 Monate");
    // Slavic one/few/many, including the 11-14 "teen" exception to the mod-10 rule.
    expect(monthsPhrase("ru", 1)).toBe("1 месяц");
    expect(monthsPhrase("ru", 2)).toBe("2 месяца");
    expect(monthsPhrase("ru", 5)).toBe("5 месяцев");
    expect(monthsPhrase("ru", 11)).toBe("11 месяцев");
    expect(monthsPhrase("ru", 21)).toBe("21 месяц");
    expect(monthsPhrase("uk", 1)).toBe("1 місяць");
    expect(monthsPhrase("uk", 3)).toBe("3 місяці");
    expect(monthsPhrase("uk", 11)).toBe("11 місяців");
    expect(monthsPhrase("pl", 1)).toBe("1 miesiąc");
    expect(monthsPhrase("pl", 2)).toBe("2 miesiące");
    expect(monthsPhrase("pl", 12)).toBe("12 miesięcy");
  });

  it("editProfileBody interpolates all four fixed fields", () => {
    const body = t("en", "editProfileBody", {
      firstName: "Alice",
      surname: "Smith",
      age: 21,
      university: "stanford.edu",
    });
    expect(body).toContain("Alice");
    expect(body).toContain("Smith");
    expect(body).toContain("21");
    expect(body).toContain("stanford.edu");
    expect(body.toLowerCase()).toContain("locked in");
  });
});
