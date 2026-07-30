import { describe, expect, it } from "vitest";
import { renderStatusBanner } from "./status-banner-view.js";

const NEXT_DROP = new Date("2026-07-23T15:00:00.000Z");

describe("renderStatusBanner", () => {
  it.each([
    ["en", "Drop in"],
    ["ru", "До дропа"],
    ["uk", "До дропу"],
    ["de", "Drop in"],
    ["pl", "Do dropu"],
  ] as const)("renders the primary timer copy for %s", (language, fragment) => {
    const view = renderStatusBanner({
      now: new Date("2026-07-21T09:00:00.000Z"),
      nextDropAt: NEXT_DROP,
      isProcessing: false,
      language,
      timeZone: "Europe/Kyiv",
    });

    expect(view.text).toContain("✦ GENNETY DROP");
    expect(view.buttonText).toContain(fragment);
    expect(view.callbackData).toBe("menu:open");
    expect(view.buttonStyle).toBe("primary");
  });

  it.each(["en", "ru", "uk", "de", "pl"] as const)(
    "does not repeat the countdown inside the %s banner text (button only)",
    (language) => {
      const view = renderStatusBanner({
        now: new Date("2026-07-21T09:00:00.000Z"),
        nextDropAt: NEXT_DROP,
        isProcessing: false,
        language,
        timeZone: "Europe/Kyiv",
      });

      // The remaining time now lives only on the inline button; the body leads
      // with the title and never repeats the countdown.
      expect(view.text.split("\n")[0]).toBe("✦ GENNETY DROP");
      expect(view.text.startsWith(view.buttonText)).toBe(false);
      expect(view.text).not.toContain(view.buttonText);
    },
  );

  it("renders the processing state in the blue button", () => {
    const view = renderStatusBanner({
      now: NEXT_DROP,
      nextDropAt: new Date("2026-07-30T15:00:00.000Z"),
      isProcessing: true,
      language: "ru",
      timeZone: "Europe/Kyiv",
    });
    expect(view.buttonText).toBe("✨ Подбираем мэтчи");
  });

  it.each([
    [new Date("2026-07-23T09:31:00.000Z"), "До дропа: 5ч 29мин"],
    [new Date("2026-07-23T14:42:00.000Z"), "✨ До дропа: 18мин"],
  ])("renders the short timer phase at %s", (now, expected) => {
    const view = renderStatusBanner({
      now,
      nextDropAt: NEXT_DROP,
      isProcessing: false,
      language: "ru",
      timeZone: "Europe/Kyiv",
    });

    expect(view.buttonText).toBe(expected);
  });

  // Kyiv-only market gate (PRODUCT_SPEC §1.1): an account registered in a city
  // we haven't launched is not in the pool, so the banner must not count down
  // to a drop it cannot be in.
  it("replaces the drop countdown with the waitlist copy for an unlaunched city", () => {
    const view = renderStatusBanner({
      now: new Date("2026-07-21T09:00:00.000Z"),
      nextDropAt: NEXT_DROP,
      isProcessing: false,
      language: "ru",
      timeZone: "Europe/Kyiv",
      marketPending: { city: "Берлин" },
    });

    expect(view.text).toContain("Берлин");
    expect(view.text).not.toContain("Следующий дроп");
    expect(view.buttonText).toBe("Открыть меню");
    // Still opens the menu — that's where the switch row lives.
    expect(view.callbackData).toBe("menu:open");
  });

  it("outranks every live-match stage for an unlaunched city", () => {
    const view = renderStatusBanner({
      now: new Date("2026-07-21T09:00:00.000Z"),
      nextDropAt: NEXT_DROP,
      isProcessing: false,
      language: "en",
      timeZone: "Europe/Kyiv",
      stage: { kind: "date", at: new Date("2026-07-22T16:00:00.000Z"), venueName: "Blur Cafe" },
      marketPending: { city: "Berlin" },
    });

    expect(view.text).not.toContain("Blur Cafe");
    expect(view.callbackData).toBe("menu:open");
  });

  // Stage-aware banner (PRODUCT_SPEC §2.1): a user holding a live match is
  // excluded from the weekly batch, so the drop countdown is replaced by
  // whatever is actually next for them.
  describe("live-match stages", () => {
    const base = {
      now: new Date("2026-07-21T09:00:00.000Z"),
      nextDropAt: NEXT_DROP,
      isProcessing: false,
      timeZone: "Europe/Kyiv",
    } as const;

    it("counts down to a scheduled date instead of the drop", () => {
      const view = renderStatusBanner({
        ...base,
        language: "ru",
        stage: {
          kind: "date",
          at: new Date("2026-07-23T15:00:00.000Z"),
          venueName: "Blur Cafe",
        },
      });

      // First line names what is counted; the badge holds only the digits.
      expect(view.text.split("\n")[0]).toBe("До свидания:");
      expect(view.text).toContain("📍 Blur Cafe");
      expect(view.buttonText).toBe("2д 6ч");
      expect(view.callbackData).toBe("menu:date");
      expect(view.text).not.toContain("Следующий дроп");
    });

    it("omits the venue line when the venue is unknown", () => {
      const view = renderStatusBanner({
        ...base,
        language: "ru",
        stage: { kind: "date", at: NEXT_DROP, venueName: null },
      });

      expect(view.text).not.toContain("📍");
    });

    it("counts down the reply window while a decision is open", () => {
      const view = renderStatusBanner({
        ...base,
        language: "ru",
        stage: { kind: "decision", minutesLeft: 320 },
      });

      expect(view.text.split("\n")[0]).toBe("Осталось на ответ:");
      // Digits only — a label here would eat the truncated badge's width and
      // the number would never render (see renderStage).
      expect(view.buttonText).toBe("5ч 20мин");
      expect(view.callbackData).toBe("menu:date");
    });

    it("shows the neutral planning copy for the middle stages", () => {
      const view = renderStatusBanner({
        ...base,
        language: "ru",
        stage: { kind: "planning" },
      });

      expect(view.text).toContain("Свидание планируется");
      // No countdown exists here, so the badge is an action — and must not
      // just repeat the body's own first line.
      expect(view.buttonText).toBe("Подробности");
      expect(view.text).not.toContain(view.buttonText);
      expect(view.callbackData).toBe("menu:date");
    });

    // The planning stage also covers an accepted-but-unanswered proposal, so
    // its copy must not assert what the partner picked — that would hand the
    // user a verdict the product has not made (blind-decision invariant §3.4).
    it.each(["en", "ru", "uk", "de", "pl"] as const)(
      "never claims the partner agreed, in %s",
      (language) => {
        const text = renderStatusBanner({
          ...base,
          language,
          stage: { kind: "planning" },
        }).text.toLowerCase();

        for (const claim of [
          "you both said yes",
          "вы оба сказали",
          "ви обоє сказали",
          "beide ja gesagt",
          "oboje powiedzieli",
        ]) {
          expect(text).not.toContain(claim);
        }
      },
    );

    // The collapsed pinned bar shows the body's first line on the left and the
    // button as a TRUNCATED badge on the right. A label inside the badge eats
    // its width and the number never renders, which is exactly the bug this
    // guards: the badge must be digits + unit only.
    it.each(["en", "ru", "uk", "de", "pl"] as const)(
      "keeps the badge to a bare countdown, in %s",
      (language) => {
        for (const stage of [
          { kind: "date", at: NEXT_DROP, venueName: null },
          { kind: "decision", minutesLeft: 90 },
        ] as const) {
          const view = renderStatusBanner({ ...base, language, stage });

          // Digits, a unit, at most one space-separated pair — nothing else.
          expect(view.buttonText).toMatch(/^\d+\s*\p{L}+( \d+\s*\p{L}+)?$/u);
          expect(view.buttonText.length).toBeLessThanOrEqual(14);
          // The heading carries the meaning and ends with a colon so the two
          // halves read as one sentence in the pinned bar.
          expect(view.text.split("\n")[0]).toMatch(/:$/);
          // The countdown rides the badge; the body never repeats it.
          expect(view.text).not.toContain(view.buttonText);
          expect(view.text).not.toContain("GENNETY DROP");
        }
      },
    );
  });
});
