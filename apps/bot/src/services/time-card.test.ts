import { describe, it, expect } from "vitest";

import { renderTimeCard, buildTimeCardElement } from "./time-card.js";

describe("renderTimeCard", () => {
  // Satori parses the bundled fonts on first render, which is slow under
  // full-suite load — give the smoke render a generous timeout.
  it.each(["dark", "light"] as const)(
    "renders a valid PNG (with Cyrillic) in the %s theme",
    async (theme) => {
      const png = await renderTimeCard({
        agreedTime: new Date("2026-06-20T16:00:00Z"),
        language: "uk",
        theme,
        label: "ВАШЕ ПОБАЧЕННЯ",
      });
      expect(png).toBeInstanceOf(Buffer);
      expect(png!.subarray(0, 4).toString("hex")).toBe("89504e47"); // PNG magic
    },
    60_000,
  );
});

describe("buildTimeCardElement", () => {
  function textNodes(node: unknown, out: string[] = []): string[] {
    if (typeof node === "string") {
      out.push(node);
      return out;
    }
    const children = (node as { props?: { children?: unknown } })?.props?.children;
    if (Array.isArray(children)) children.forEach((c) => textNodes(c, out));
    else if (children !== undefined) textNodes(children, out);
    return out;
  }

  it("renders the agreed slot in the canonical Europe/Kyiv timezone", () => {
    // 16:00 UTC in June == 19:00 Kyiv (UTC+3).
    const texts = textNodes(
      buildTimeCardElement({
        agreedTime: new Date("2026-06-20T16:00:00Z"),
        language: "en",
        theme: "dark",
        label: "YOUR DATE",
      }),
    );
    expect(texts).toContain("19:00");
    expect(texts.some((s) => s.includes("20") && s.includes("JUNE"))).toBe(true);
  });

  it("localizes the date line per language", () => {
    const ru = textNodes(
      buildTimeCardElement({
        agreedTime: new Date("2026-06-20T16:00:00Z"),
        language: "ru",
        theme: "light",
        label: "ВАШЕ СВИДАНИЕ",
      }),
    );
    expect(ru.some((s) => s.includes("ИЮНЯ"))).toBe(true);
    expect(ru).toContain("19:00");
  });
});
