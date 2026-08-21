import { describe, expect, it } from "vitest";
import { pickLang, strings, type Lang } from "./i18n.js";

const languages: Lang[] = ["en", "ru", "uk", "de", "pl"];

describe("Date Ticket i18n", () => {
  it("has a complete distinct dictionary for every supported language", () => {
    for (const lang of languages) {
      expect(pickLang(lang)).toBe(lang);
      expect(strings(lang).heading.length).toBeGreaterThan(0);
      expect(strings(lang).matchFallback.length).toBeGreaterThan(0);
      // Accessible name for the stub's "🎟 × N"; the count is substituted in.
      expect(strings(lang).balanceNote).toContain("{n}");
      // The stub's printed field name. It shares a 220px line with the count
      // and is uppercased and tracked at 0.16em, so a phrase does not fit —
      // "Guthaben" (8) is the longest that does. A wrapped or ellipsised field
      // name would read as a rendering fault on a ticket.
      const label = strings(lang).balanceLabel;
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(10);
      expect(label).not.toContain(" ");
    }
    expect(strings("de").heading).not.toBe(strings("en").heading);
    expect(strings("pl").heading).not.toBe(strings("en").heading);
  });

  it("keeps the ticket emoji out of every screen heading", () => {
    // Each of these sits directly above the rendered 268×392 ticket, so an
    // emoji of one restates the picture in a platform font we do not control.
    // Button labels are deliberately NOT covered: 🎟️ there tells the wallet
    // rail apart from the money rail.
    for (const lang of languages) {
      const s = strings(lang);
      for (const heading of [s.heading, s.waitingTitle, s.successTitle, s.coverPartnerTitle]) {
        expect(heading).not.toContain("🎟");
      }
    }
  });

  it("keeps the white heart off the mutual-match heading", () => {
    // Founder decision 2026-08-19: this is the screen that asks for money, and
    // a decorative glyph beside the headline reads as marketing rather than as
    // a receipt. The warmth lives in the chat card's falling-hearts effect.
    for (const lang of languages) {
      expect(strings(lang).heading).not.toContain("🤍");
    }
  });

  it("names whose window the countdown is, and carries localized units", () => {
    for (const lang of languages) {
      const s = strings(lang);
      expect(s.waitingTimer).toContain("{time}");
      // A bare "Осталось {time}" is what this guards against: the line has to
      // say whose time it is, so it is longer than the placeholder plus a word.
      expect(s.waitingTimer.replace("{time}", "").trim().length).toBeGreaterThan(12);
      expect(s.timeHours).toContain("{n}");
      expect(s.timeMinutes).toContain("{n}");
      expect(s.timeSoon.length).toBeGreaterThan(0);
      expect(s.timeSoon).not.toContain("{n}");
    }
  });

  it("explains a Premium-covered slot, and says what Premium does NOT cover", () => {
    for (const lang of languages) {
      const s = strings(lang);
      // Without this line a covered user reads "waiting on them" with no account
      // of why THEIR half is already done.
      expect(s.premiumCovered.trim().length).toBeGreaterThan(0);
      // The one thing a subscriber could reasonably misread on the cover screen
      // is that covering her is included too — so it names her explicitly.
      expect(s.premiumCoverNotIncluded).toContain("{name}");
    }
  });
});
