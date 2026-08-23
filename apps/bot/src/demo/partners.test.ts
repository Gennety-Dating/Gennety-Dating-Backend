import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LANGUAGES } from "@gennety/shared";

/**
 * The puppet is named in the visitor's own language.
 *
 * `User.firstName` is a plain column that every partner-facing surface prints
 * verbatim, so before this the single Russian row put «Артём» inside an
 * otherwise fully English, German or Polish pitch. The fix is one row per
 * (language, gender), and what has to hold is: the set is complete, the ids
 * cannot collide, and `pickDemoPartner` actually routes on language.
 *
 * `partners.ts` reaches for Prisma and the embedding worker at module load, so
 * both are stubbed — this file tests the tables and the picker, which are pure.
 */
vi.mock("@gennety/db", () => ({ prisma: {} }));
vi.mock("../workers/embedding-refresh.js", () => ({ refreshUserEmbedding: vi.fn() }));
vi.mock("../services/ticket-wallet.js", () => ({ getBalance: vi.fn(), grantTickets: vi.fn() }));

const { DEMO_PARTNERS, DEMO_PARTNER_PERSONAS, pickDemoPartner } = await import("./partners.js");

describe("demo partner roster", () => {
  it("carries one man and one woman in every supported language", () => {
    expect(DEMO_PARTNERS).toHaveLength(SUPPORTED_LANGUAGES.length * 2);
    for (const language of SUPPORTED_LANGUAGES) {
      const rows = DEMO_PARTNERS.filter((p) => p.language === language);
      expect(rows.map((p) => p.gender).sort()).toEqual(["female", "male"]);
    }
  });

  it("gives each language its own name, so no two locales share one", () => {
    // The actual bug: five locales reading the same Russian `firstName`.
    for (const persona of DEMO_PARTNER_PERSONAS) {
      const names = DEMO_PARTNERS.filter((p) => p.gender === persona.gender).map(
        (p) => p.firstName,
      );
      expect(new Set(names).size).toBe(SUPPORTED_LANGUAGES.length);
    }
  });

  it("keeps every id unique and inside the reserved demo band", () => {
    const ids = DEMO_PARTNERS.map((p) => p.telegramId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // `-777_000_0xx`: negative (so no Telegram-only path can reach it) and
      // clear of the synthetic-test band at `-778_000_0xx`.
      expect(id).toBeLessThan(-777_000_000n);
      expect(id).toBeGreaterThan(-777_000_100n);
    }
  });

  it("keeps Russian on the original two ids so seeded photos survive a re-seed", () => {
    const ru = DEMO_PARTNERS.filter((p) => p.language === "ru");
    expect(ru.find((p) => p.gender === "male")?.telegramId).toBe(-777_000_001n);
    expect(ru.find((p) => p.gender === "female")?.telegramId).toBe(-777_000_002n);
  });

  it("shares one persona across a gender's rows", () => {
    // Only the name and the id vary; a second bio per language would be five
    // texts to keep in step for something the visitor never sees.
    for (const persona of DEMO_PARTNER_PERSONAS) {
      const rows = DEMO_PARTNERS.filter((p) => p.gender === persona.gender);
      for (const row of rows) {
        expect(row.psychologicalSummary).toBe(persona.psychologicalSummary);
        expect(row.age).toBe(persona.age);
      }
    }
  });
});

describe("pickDemoPartner", () => {
  it("answers in the visitor's own language", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const picked = pickDemoPartner({ gender: "male", preference: "women", language });
      expect(picked.language).toBe(language);
      expect(picked.gender).toBe("female");
    }
  });

  it("still reads preference first, then gender, then language", () => {
    expect(pickDemoPartner({ gender: "female", preference: "men", language: "pl" })).toMatchObject({
      gender: "male",
      firstName: "Kacper",
    });
    // `both` falls back to the opposite gender rather than dead-ending.
    expect(pickDemoPartner({ gender: "female", preference: "both", language: "de" })).toMatchObject({
      gender: "male",
      firstName: "Jonas",
    });
  });

  it("falls back to English before a visitor has chosen a language", () => {
    // The product's own i18n default. Falling back to `ru` would name the
    // partner in the founder's language for someone who never asked for it.
    const picked = pickDemoPartner({ gender: "male", preference: "women", language: null });
    expect(picked.language).toBe("en");
    expect(picked.firstName).toBe("Chloe");
  });
});
