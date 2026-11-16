import { describe, expect, it } from "vitest";
import {
  CURATED_VIDEOS,
  TREND_GLOSSARY,
  VIDEO_MOMENTS,
  VIDEO_TAGS,
  VIDEO_TAG_KEYWORDS,
  isTrendFresh,
  matchTrendEntries,
  mentionsTerm,
  pickVideoCandidates,
  tagsFromInterests,
  trendGlossaryBlock,
  type CuratedVideo,
  type TrendEntry,
} from "./agent-takes.js";
import { SUPPORTED_LANGUAGES } from "./types.js";

/** Agent video takes (decision 2026-11-16): the shared constants and helpers. */

const NOW = new Date("2026-11-16T12:00:00Z");

const entry = (id: string, terms: string[], checkedAt = "2026-11-16"): TrendEntry => ({
  id,
  terms,
  meaning: `${id} meaning`,
  take: `${id} take`,
  checkedAt,
});

describe("mentionsTerm", () => {
  it("matches whole words in any script, case-insensitively", () => {
    expect(mentionsTerm("Это чистый Mewing, бро", "mewing")).toBe(true);
    expect(mentionsTerm("аура фарм", "аура")).toBe(true);
    expect(mentionsTerm("аурами", "аура")).toBe(false);
    expect(mentionsTerm("rizzler", "rizz")).toBe(false);
  });

  it("matches inflections through a trailing *", () => {
    expect(mentionsTerm("все эти лукс-максеры", "лукс-макс*")).toBe(true);
    expect(mentionsTerm("лукс-максингом занялся", "лукс-макс*")).toBe(true);
    expect(mentionsTerm("пре-лукс", "лукс-макс*")).toBe(false);
  });

  it("treats regex characters in a term literally", () => {
    expect(mentionsTerm("+1000 aura", "+1000 aura")).toBe(true);
    expect(mentionsTerm("10000 aura", "+1000 aura")).toBe(false);
  });
});

describe("matchTrendEntries", () => {
  const glossary = [
    entry("looksmaxxing", ["looksmaxxing", "лукс-макс*"]),
    entry("aura", ["aura farming", "фарм ауры", "аура"]),
    entry("old", ["skibidi"], "2026-08-01"),
  ];

  it("returns the entries a text names, most hits first", () => {
    const out = matchTrendEntries("аура и фарм ауры, а ещё лукс-максинг", { now: NOW, glossary });
    expect(out.map((e) => e.id)).toEqual(["aura", "looksmaxxing"]);
  });

  it("leaves out entries unchecked for more than 60 days", () => {
    expect(isTrendFresh(glossary[2]!, NOW)).toBe(false);
    expect(matchTrendEntries("skibidi", { now: NOW, glossary })).toEqual([]);
  });

  it("caps the number per turn and ignores empty text", () => {
    expect(matchTrendEntries("аура looksmaxxing", { now: NOW, glossary, limit: 1 })).toHaveLength(1);
    expect(matchTrendEntries("   ", { now: NOW, glossary })).toEqual([]);
  });

  it("renders a block only when something matched", () => {
    expect(trendGlossaryBlock([])).toBeNull();
    const block = trendGlossaryBlock([{ ...glossary[0]!, redLine: "no bone smashing" }]);
    expect(block).toContain("looksmaxxing: looksmaxxing meaning");
    expect(block).toContain("Your take: looksmaxxing take");
    expect(block).toContain("Red line: no bone smashing");
  });
});

describe("the real glossary", () => {
  const ids = (text: string) => matchTrendEntries(text, { now: NOW }).map((e) => e.id);

  it("recognises what people actually type", () => {
    expect(ids("что думаешь про лукс-максинг?")).toContain("looksmaxxing");
    expect(ids("он реально фармит ауру, аура фарминг")).toContain("aura-farming");
    expect(ids("брат, это bone smashing, норм?")).toContain("bone-smashing");
    expect(ids("меня могнули на тусовке")).toContain("mogging");
    expect(ids("он воздухан")).toContain("vozdukhan");
  });

  it("stays quiet on ordinary talk", () => {
    expect(ids("пойдём в кино в субботу? я могу в шесть")).toEqual([]);
    expect(ids("chewing gum and a coffee, then the gym")).toEqual([]);
  });

  it("every entry is fresh on the day it was written", () => {
    for (const e of TREND_GLOSSARY) expect(isTrendFresh(e, NOW), e.id).toBe(true);
  });
});

describe("tagsFromInterests", () => {
  it("maps free-text interests in several languages to tags", () => {
    const tags = tagsFromInterests(["Качалка", "стендап", "Kochen", "travelling"]);
    expect([...tags].sort()).toEqual(["fitness", "food", "humor", "travel"]);
  });

  it("finds nothing in empty interests", () => {
    expect(tagsFromInterests([]).size).toBe(0);
  });
});

describe("pickVideoCandidates", () => {
  const video = (id: string, over: Partial<CuratedVideo>): CuratedVideo => ({
    id,
    platform: "youtube",
    url: `https://www.youtube.com/watch?v=${id.padEnd(11, "x")}`,
    creator: "c",
    language: "en",
    description: "d",
    take: "t",
    tags: [],
    moments: [],
    addedAt: "2026-11-16",
    ...over,
  });
  const list = [
    video("nerves", { tags: ["dating"], moments: ["nerves_before_date"] }),
    video("gymru", { language: "ru", tags: ["fitness"] }),
    video("gymen", { tags: ["fitness"] }),
    video("german", { language: "de", tags: ["fitness"] }),
  ];

  it("puts the moment above topics and interests", () => {
    const out = pickVideoCandidates({ language: "ru", moment: "nerves_before_date", topics: ["fitness"], list });
    expect(out[0]!.id).toBe("nerves");
  });

  it("prefers the person's own language, keeps English, drops other languages", () => {
    const out = pickVideoCandidates({ language: "ru", topics: ["fitness"], list });
    expect(out.map((v) => v.id)).toEqual(["gymru", "gymen"]);
  });

  it("offers nothing without any overlap, and nothing already sent", () => {
    expect(pickVideoCandidates({ language: "en", list })).toEqual([]);
    const sent = new Set([list[0]!.url]);
    expect(pickVideoCandidates({ language: "en", moment: "nerves_before_date", alreadySent: sent, list })).toEqual([]);
  });
});

describe("the authored data", () => {
  it("glossary entries are well-formed and unique", () => {
    const ids = new Set<string>();
    for (const e of TREND_GLOSSARY) {
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      expect(e.terms.length, e.id).toBeGreaterThan(0);
      for (const term of e.terms) expect(term, e.id).toBe(term.toLowerCase());
      expect(Number.isNaN(Date.parse(e.checkedAt)), e.id).toBe(false);
      expect(e.meaning.trim().length, e.id).toBeGreaterThan(0);
      expect(e.take.trim().length, e.id).toBeGreaterThan(0);
      // A take is a position, never a link or a rating.
      expect(e.take, e.id).not.toMatch(/https?:\/\/|\b\d+\s*\/\s*10\b/);
    }
  });

  it("curated videos use canonical links, known tags and our own words", () => {
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const v of CURATED_VIDEOS) {
      expect(ids.has(v.id), v.id).toBe(false);
      expect(urls.has(v.url), v.id).toBe(false);
      ids.add(v.id);
      urls.add(v.url);
      expect(v.url, v.id).toMatch(
        /^https:\/\/(www\.youtube\.com\/(watch\?v=|shorts\/)[\w-]{6,20}|www\.tiktok\.com\/@[\w.-]+\/video\/\d{6,25}|www\.instagram\.com\/reel\/[\w-]{5,30}\/?)$/,
      );
      for (const tag of v.tags) expect(VIDEO_TAGS, v.id).toContain(tag);
      for (const moment of v.moments) expect(VIDEO_MOMENTS, v.id).toContain(moment);
      expect(v.tags.length + v.moments.length, v.id).toBeGreaterThan(0);
      expect([...SUPPORTED_LANGUAGES, "any"], v.id).toContain(v.language);
      expect(Number.isNaN(Date.parse(v.addedAt)), v.id).toBe(false);
      expect(v.description + v.take, v.id).not.toMatch(/https?:\/\//);
    }
  });

  it("every tag has interest keywords", () => {
    for (const tag of VIDEO_TAGS) expect(VIDEO_TAG_KEYWORDS[tag].length, tag).toBeGreaterThan(0);
  });
});
