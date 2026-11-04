import { describe, expect, it } from "vitest";
import { pickLang, strings, walletLine, type Lang } from "./i18n.js";

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

  it("carries the native gate copy (iOS variant B, 2026-10-30)", () => {
    expect(strings("ru").heading).toBe("Свиданию нужен билет");
    expect(strings("ru").successTitle).toBe("Оба билета на месте");
    expect(strings("ru").coverAction).toBe("Беру на себя");
    expect(strings("en").scopeOnlyMine).toBe("Pay only for mine");
    for (const lang of languages) {
      const s = strings(lang);
      expect(s.payAmount).toContain("{amount}");
      expect(s.coverPartnerSub).toContain("{name}");
      for (const w of [s.walletOne, s.walletFew, s.walletMany, s.walletOther]) expect(w).toContain("{n}");
    }
  });

  it("declines the wallet line by the language's plural rules", () => {
    expect(walletLine("ru", 1)).toBe("1 билет в кошельке");
    expect(walletLine("ru", 3)).toBe("3 билета в кошельке");
    expect(walletLine("ru", 5)).toBe("5 билетов в кошельке");
    expect(walletLine("en", 2)).toBe("2 tickets in your wallet");
    expect(walletLine("pl", 2)).toBe("2 bilety w portfelu");
  });

  it("no longer carries the pay-step \"free with Premium\" line", () => {
    // Premium stopped covering Date Tickets on 2026-10-08; the upsell that
    // promised it went with the benefit.
    for (const lang of languages) {
      expect(strings(lang)).not.toHaveProperty("premiumWouldCover");
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
