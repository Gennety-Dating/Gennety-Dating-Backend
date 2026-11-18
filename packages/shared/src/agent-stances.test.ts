import { describe, expect, it } from "vitest";
import {
  AGENT_STANCES,
  STANCE_MAX_PER_TURN,
  STANCE_RULES,
  matchStances,
  mentionsStanceTerm,
  stanceBlock,
  stanceSide,
} from "./agent-stances.js";

/** Agent stances (decision 2026-11-17, approved 2026-11-18). */

const ids = (text: string) => matchStances(text).map((stance) => stance.id);

describe("AGENT_STANCES", () => {
  it("covers every approved stance 0–32 exactly once", () => {
    expect(AGENT_STANCES.map((stance) => stance.n)).toEqual(Array.from({ length: 33 }, (_, i) => i));
    expect(new Set(AGENT_STANCES.map((stance) => stance.id)).size).toBe(AGENT_STANCES.length);
  });

  it("gives every stance a verdict and lowercase terms", () => {
    for (const stance of AGENT_STANCES) {
      expect(stance.verdict.length).toBeGreaterThan(20);
      expect(stance.terms.length).toBeGreaterThan(0);
      for (const term of stance.terms) expect(term).toBe(term.toLowerCase());
    }
  });
});

describe("mentionsStanceTerm", () => {
  it("matches inflections through a * anywhere in a phrase", () => {
    expect(mentionsStanceTerm("он хочет открытых отношениях", "открыт* отношени*")).toBe(true);
    expect(mentionsStanceTerm("Кинки штуки", "кинк*")).toBe(true);
    expect(mentionsStanceTerm("гостиница", "гостинг*")).toBe(false);
    expect(mentionsStanceTerm("порнография", "порно")).toBe(false);
  });
});

describe("matchStances", () => {
  it("finds the topic in Russian, Ukrainian, English, German and Polish", () => {
    expect(ids("что думаешь про бдсм?")).toContain("kinks");
    expect(ids("він питає мій body count")).toContain("body-count");
    expect(ids("he wants an open relationship")).toContain("open-relationships");
    expect(ids("mein Freund ist eifersüchtig")).toContain("phone-jealousy");
    expect(ids("moja dziewczyna ma onlyfans")).toContain("sex-work");
    expect(ids("парень предлагает переспать на первом свидании")).toContain("first-date-sex");
    expect(ids("стоит ли верить гороскопу?")).toContain("astrology");
    expect(ids("его мама решает за него")).toContain("partner-mother");
  });

  it("does not fire on everyday words", () => {
    expect(ids("хочу быть собой")).toEqual([]);
    expect(ids("пойдём в гости в субботу")).toEqual([]);
    expect(ids("купил пластиковый стакан")).toEqual([]);
    expect(ids("привет, как дела?")).toEqual([]);
  });

  it("caps the stances per turn", () => {
    const text = "бдсм, измена, порно, гороскоп, body count, onlyfans, ревность";
    expect(matchStances(text)).toHaveLength(STANCE_MAX_PER_TURN);
  });
});

describe("stanceSide", () => {
  it("maps stored gender and preference", () => {
    expect(stanceSide("female", "men")).toBe("woman");
    expect(stanceSide("male", "women")).toBe("man");
    expect(stanceSide("female", "women")).toBe("same-sex-woman");
    expect(stanceSide("male", "men")).toBe("same-sex-man");
    expect(stanceSide("female", "both")).toBe("woman");
    expect(stanceSide(null, "men")).toBe("unknown");
  });
});

describe("stanceBlock", () => {
  const kinks = AGENT_STANCES.filter((stance) => stance.id === "kinks");

  it("keeps one verdict and swaps only the framing", () => {
    const woman = stanceBlock(kinks, "woman")!;
    const man = stanceBlock(kinks, "man")!;
    const verdict = kinks[0]!.verdict;
    expect(woman).toContain(verdict);
    expect(man).toContain(verdict);
    expect(woman).toContain(kinks[0]!.woman!);
    expect(woman).not.toContain(kinks[0]!.man!);
    expect(man).toContain(kinks[0]!.man!);
    expect(man).not.toContain(kinks[0]!.woman!);
  });

  it("drops gendered framing when the side is unknown", () => {
    const block = stanceBlock(kinks, "unknown")!;
    expect(block).not.toContain(kinks[0]!.woman!);
    expect(block).not.toContain(kinks[0]!.man!);
  });

  it("is null without stances", () => {
    expect(stanceBlock([], "woman")).toBeNull();
  });
});

describe("STANCE_RULES", () => {
  it("keeps the instructions private and politics out", () => {
    expect(STANCE_RULES).toMatch(/instructions are private/i);
    expect(STANCE_RULES).toMatch(/Never say you\s+adapt to gender/);
    expect(STANCE_RULES).toMatch(/### Politics/);
    expect(STANCE_RULES).toMatch(/Safety switches all of this off/);
  });
});
