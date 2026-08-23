import { describe, it, expect } from "vitest";
import { t } from "@gennety/shared";
import type { Language } from "@gennety/shared";
import {
  terminalVerificationMessage,
  terminalVerificationPush,
  verificationPhotosDroppedPush,
  verificationPhotosNeededPush,
  verificationRetryMessage,
  verificationRetryPush,
  livenessRetryMessage,
} from "./verification-messages.js";

describe("livenessRetryMessage", () => {
  it("maps not_live to the confidence-bar copy (framing/lighting advice)", () => {
    expect(livenessRetryMessage("en", "not_live")).toBe(t("en", "verifyRetryNotLive"));
  });

  it("maps expired and in_progress to the same unfinished-check copy", () => {
    expect(livenessRetryMessage("en", "expired")).toBe(t("en", "verifyRetryUnfinished"));
    expect(livenessRetryMessage("en", "in_progress")).toBe(t("en", "verifyRetryUnfinished"));
  });

  it("maps no_reference to the no-fault technical-hiccup copy", () => {
    expect(livenessRetryMessage("en", "no_reference")).toBe(t("en", "verifyRetryTechnical"));
  });

  it("the three copy variants are all distinct", () => {
    const variants = new Set([
      livenessRetryMessage("en", "not_live"),
      livenessRetryMessage("en", "expired"),
      livenessRetryMessage("en", "no_reference"),
    ]);
    expect(variants.size).toBe(3);
  });

  it.each(["ru", "uk", "de", "pl"] as const)(
    "resolves a non-English variant for %s (no silent English fallback)",
    (lang) => {
      expect(livenessRetryMessage(lang, "not_live")).not.toBe(
        livenessRetryMessage("en", "not_live"),
      );
    },
  );
});

describe("terminalVerificationMessage", () => {
  it("maps each terminal status to its own outcome copy", () => {
    expect(terminalVerificationMessage("en", "verified")).toBe(t("en", "verifyOutcomeVerified"));
    expect(terminalVerificationMessage("en", "pending_review")).toBe(
      t("en", "verifyOutcomePendingReview"),
    );
    expect(terminalVerificationMessage("en", "rejected")).toBe(t("en", "verifyOutcomeRejected"));
  });
});

describe("verificationRetryMessage", () => {
  it("reuses the ordinary reminder copy (infra-failure retry, not the liveness-retry copy)", () => {
    expect(verificationRetryMessage("en")).toBe(t("en", "verifyReminderNudge"));
  });
});

describe("push copy for the native rail", () => {
  const LANGUAGES: Language[] = ["en", "ru", "uk", "de", "pl"];

  it("gives each terminal outcome its own title and body", () => {
    // A swapped case in the switch is the failure that matters here: it would
    // tell a rejected user "your profile is live" on their lock screen, and
    // nothing else in the stack would notice.
    const copies = (["verified", "pending_review", "rejected"] as const).map((status) =>
      terminalVerificationPush("en", status),
    );
    expect(new Set(copies.map((c) => c.title)).size).toBe(3);
    expect(new Set(copies.map((c) => c.body)).size).toBe(3);
  });

  it("says the same thing as the DM about a rejection", () => {
    // The DM leads with "these aren't your photos" (`photoRedoFirst`). A `both`
    // user gets both rails for one event, so the push cannot lead elsewhere.
    expect(terminalVerificationPush("en", "rejected").title.toLowerCase()).toContain(
      "don't match",
    );
    expect(terminalVerificationMessage("en", "rejected").toLowerCase()).toContain(
      "don't match",
    );
  });

  it("carries both photo counts into the under-minimum copy, in every language", () => {
    for (const lang of LANGUAGES) {
      const copy = verificationPhotosNeededPush(lang, { min: 4, need: 3 });
      expect(copy.title + copy.body, lang).toContain("3");
      expect(copy.body, lang).toContain("4");
      expect(copy.title + copy.body, lang).not.toContain("{");
    }
  });

  it("is filled in for all five languages, never left as the English string", () => {
    const builders = [
      (lang: Language) => terminalVerificationPush(lang, "verified"),
      (lang: Language) => terminalVerificationPush(lang, "pending_review"),
      (lang: Language) => terminalVerificationPush(lang, "rejected"),
      verificationRetryPush,
      verificationPhotosDroppedPush,
    ];
    for (const build of builders) {
      const english = build("en");
      for (const lang of LANGUAGES.filter((l) => l !== "en")) {
        expect(build(lang).title, lang).not.toBe(english.title);
        expect(build(lang).body, lang).not.toBe(english.body);
      }
    }
  });

  it("stays short enough that a lock screen shows the verdict, not a prefix", () => {
    for (const lang of LANGUAGES) {
      for (const status of ["verified", "pending_review", "rejected"] as const) {
        const copy = terminalVerificationPush(lang, status);
        expect(copy.title.length, `${lang}/${status} title`).toBeLessThanOrEqual(40);
        expect(copy.body.length, `${lang}/${status} body`).toBeLessThanOrEqual(180);
      }
    }
  });
});
