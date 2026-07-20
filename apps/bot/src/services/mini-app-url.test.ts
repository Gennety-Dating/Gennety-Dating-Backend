import { describe, expect, it } from "vitest";
import { buildMiniAppUrl, type MiniAppPage } from "./mini-app-url.js";

describe("buildMiniAppUrl", () => {
  const pages: Array<[MiniAppPage, string]> = [
    ["calendar", "/calendar"],
    ["feedback", "/calendar/feedback.html"],
    ["location", "/calendar/location.html"],
    ["onboarding", "/calendar/onboarding.html"],
    ["verification", "/calendar/verification.html"],
    ["ticket", "/calendar/ticket.html"],
    ["tickets", "/calendar/tickets.html"],
    ["venue-change", "/calendar/venue-change.html"],
  ];

  it.each(pages)("builds the %s page with mandatory locale and theme", (page, path) => {
    const result = new URL(
      buildMiniAppUrl(page, {
        baseUrl: "https://app.test/calendar/",
        lang: "uk",
        theme: "light",
        query: { match: "m 1" },
      }),
    );

    expect(result.pathname).toBe(path);
    expect(result.searchParams.get("match")).toBe("m 1");
    expect(result.searchParams.get("lang")).toBe("uk");
    expect(result.searchParams.get("theme")).toBe("light");
  });

  it("preserves unrelated base query params and replaces stale locale/theme", () => {
    const result = new URL(
      buildMiniAppUrl("calendar", {
        baseUrl: "https://app.test/calendar?source=legacy&lang=en&theme=dark",
        lang: "de",
        theme: "light",
      }),
    );
    expect(result.searchParams.get("source")).toBe("legacy");
    expect(result.searchParams.get("lang")).toBe("de");
    expect(result.searchParams.get("theme")).toBe("light");
  });

  it("accepts a page-specific URL without appending the filename twice", () => {
    expect(
      new URL(
        buildMiniAppUrl("feedback", {
          baseUrl: "https://feedback.test/form/feedback.html",
          lang: "ru",
          theme: "dark",
        }),
      ).pathname,
    ).toBe("/form/feedback.html");
  });
});
