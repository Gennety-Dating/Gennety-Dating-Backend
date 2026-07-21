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

  it("keeps the next drop primary while adding an upcoming date", () => {
    const view = renderStatusBanner({
      now: new Date("2026-07-21T09:00:00.000Z"),
      nextDropAt: NEXT_DROP,
      isProcessing: false,
      language: "ru",
      timeZone: "Europe/Kyiv",
      upcomingDate: {
        at: new Date("2026-07-21T18:00:00.000Z"),
        venueName: "Blur Cafe",
      },
    });

    expect(view.buttonText).toContain("До дропа");
    expect(view.text).toContain("Свидание через");
    expect(view.text).toContain("Blur Cafe");
  });

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
    [new Date("2026-07-23T09:31:00.000Z"), "⏳ До дропа: 5ч 29мин"],
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
});
