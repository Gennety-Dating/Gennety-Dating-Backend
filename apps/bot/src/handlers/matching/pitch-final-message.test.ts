/**
 * Unit tests for `composeFinalPitchMessage` — the ONE persisted pitch message
 * (synergy header + pitch + the verified trust note).
 *
 * These exist because the failure mode here is silent. A wrong `MessageEntity`
 * offset raises no error from Telegram: it simply bolds or quotes the wrong
 * span, which no integration test that only greps the body would notice. So
 * every assertion slices the entity back OUT of the composed text and compares
 * it with the string it is supposed to cover — on Cyrillic locales too, since
 * the header opens with `💎` (two UTF-16 code units) and an off-by-one there
 * would be invisible in English-only fixtures.
 */
import { describe, expect, it, vi } from "vitest";
import { t, type Language } from "@gennety/shared";

vi.mock("@gennety/db", () => ({ prisma: {} }));
vi.mock("../../config.js", () => ({
  env: {
    CUSTOM_EMOJI_ACCEPT_ID: "",
    CUSTOM_EMOJI_DECLINE_ID: "",
    CUSTOM_EMOJI_VERIFIED_ID: "",
  },
}));

const { composeFinalPitchMessage } = await import("./pitch.js");

const LANGS: Language[] = ["en", "ru", "uk", "de", "pl"];

function sliceEntity(text: string, entity: { offset: number; length: number }): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

describe("composeFinalPitchMessage", () => {
  it.each(LANGS)("bolds exactly the synergy label (%s)", (lang) => {
    const result = composeFinalPitchMessage({
      lang,
      synergyScore: 88,
      synergyReason: "Aligned values.",
      pitchTail: "You two click.",
      partnerVerified: false,
    });

    const bold = result.entities.find((e) => e.type === "bold");
    expect(bold).toBeDefined();
    // The span must be the label itself — not the 💎 before it, not the reason
    // after it. This is the assertion that catches an off-by-one on the emoji.
    expect(sliceEntity(result.text, bold!)).toBe(t(lang, "matchSynergyLabel", { score: 88 }));
  });

  it.each(LANGS)("quotes exactly the trust note (%s)", (lang) => {
    const result = composeFinalPitchMessage({
      lang,
      synergyScore: 88,
      synergyReason: "Aligned values.",
      pitchTail: "You two click.",
      partnerVerified: true,
    });

    const quote = result.entities.find((e) => e.type === "blockquote");
    expect(quote).toBeDefined();
    expect(sliceEntity(result.text, quote!)).toBe(t(lang, "matchVerifiedQuote"));
    expect(result.overflowTrustCard).toBeNull();
  });

  it("no longer emits the markdown asterisks that rendered literally", () => {
    const result = composeFinalPitchMessage({
      lang: "ru",
      synergyScore: 88,
      synergyReason: "Общие ценности.",
      pitchTail: "Вы совпадаете.",
      partnerVerified: true,
    });

    // The final message has never carried a `parse_mode`, so a surviving `*`
    // would be shown to the user verbatim.
    expect(result.text).not.toContain("*");
  });

  it("keeps the bold offset correct once the trust note is appended", () => {
    const result = composeFinalPitchMessage({
      lang: "ru",
      synergyScore: 91,
      synergyReason: "Общие ценности.",
      pitchTail: "Вы совпадаете.",
      partnerVerified: true,
    });

    const bold = result.entities.find((e) => e.type === "bold")!;
    const quote = result.entities.find((e) => e.type === "blockquote")!;
    expect(sliceEntity(result.text, bold)).toBe(t("ru", "matchSynergyLabel", { score: 91 }));
    expect(sliceEntity(result.text, quote)).toBe(t("ru", "matchVerifiedQuote"));
    // The two spans must not overlap — a shared offset base is the easy bug.
    expect(bold.offset + bold.length).toBeLessThan(quote.offset);
  });

  it("omits the trust note entirely for an unverified partner", () => {
    const result = composeFinalPitchMessage({
      lang: "en",
      synergyScore: 88,
      synergyReason: "Aligned values.",
      pitchTail: "You two click.",
      partnerVerified: false,
    });

    expect(result.entities.some((e) => e.type === "blockquote")).toBe(false);
    expect(result.text).not.toContain("face-match");
    expect(result.overflowTrustCard).toBeNull();
  });

  it("emits no bold when the row carries no synergy score or reason", () => {
    const result = composeFinalPitchMessage({
      lang: "en",
      synergyScore: null,
      synergyReason: null,
      pitchTail: "You two click.",
      partnerVerified: false,
    });

    expect(result.entities).toEqual([]);
    expect(result.text).toBe("You two click.");
  });

  it("spills the trust note to its own message rather than breaching 4096", () => {
    const pitchTail = "x".repeat(4096);
    const result = composeFinalPitchMessage({
      lang: "en",
      synergyScore: 88,
      synergyReason: "Aligned values.",
      pitchTail,
      partnerVerified: true,
    });

    // Exceeding the ceiling does not degrade — it throws, and that throw costs
    // the user the entire pitch. So the note steps out instead.
    expect(result.overflowTrustCard).toBe(t("en", "matchVerifiedQuote"));
    expect(result.entities.some((e) => e.type === "blockquote")).toBe(false);
    expect(result.text).not.toContain("face-match");
  });
});
