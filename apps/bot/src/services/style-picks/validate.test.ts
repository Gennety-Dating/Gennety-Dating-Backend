import { describe, expect, it } from "vitest";
import { badgesFor, validateStylePicks } from "./validate.js";
import { item } from "./__fixtures__/fixtures.js";

const shortlist = [
  item("s1"),
  item("s2"),
  item("s3"),
  item("a1", { category: "accents" }),
  item("a2", { category: "accents" }),
  item("g1", { category: "grooming" }),
  item("g2", { category: "grooming" }),
];

function pick(id: string, fitScore = 70, personalSignalCited = true, reason = `Because ${id}`) {
  return { id, fitScore, reason, signals: ["calm tempo"], personalSignalCited };
}

describe("validateStylePicks", () => {
  it("drops unknown and duplicate ids and caps each category at two", () => {
    const out = validateStylePicks(
      { basis: ["a", "b", "c"], picks: [pick("s1"), pick("s1"), pick("nope"), pick("s2"), pick("s3"), pick("a1"), pick("g1")] },
      shortlist,
    )!;
    expect(out.picks.map((p) => p.id)).toEqual(["s1", "s2", "a1", "g1"]);
  });

  it("clamps lengths and scores", () => {
    const out = validateStylePicks(
      {
        basis: ["x".repeat(50), "b", "c", "d", "e"],
        picks: [
          { ...pick("s1", 140), reason: "r".repeat(300), signals: ["s".repeat(40), "b", "c", "d"] },
          pick("a1", -5),
          pick("g1"),
        ],
      },
      shortlist,
    )!;
    expect(out.basis).toHaveLength(4);
    expect(out.basis[0]!.length).toBeLessThanOrEqual(24);
    const s1 = out.picks.find((p) => p.id === "s1")!;
    expect(s1.reason.length).toBeLessThanOrEqual(140);
    expect(s1.signals).toHaveLength(3);
    expect(s1.signals[0]!.length).toBeLessThanOrEqual(24);
    expect(s1.fitScore).toBe(100);
    expect(out.picks.find((p) => p.id === "a1")!.fitScore).toBe(0);
  });

  it("fails below three valid picks — nothing is invented to fill the gap", () => {
    expect(validateStylePicks({ basis: [], picks: [pick("s1"), pick("nope"), pick("a1")] }, shortlist)).toBeNull();
    expect(validateStylePicks(null, shortlist)).toBeNull();
    expect(validateStylePicks({ picks: "x" }, shortlist)).toBeNull();
  });

  it("grants 'for you' only to cited picks at 85+, two at most, highest first", () => {
    const out = validateStylePicks(
      {
        basis: [],
        picks: [pick("s1", 99, false), pick("s2", 86), pick("a1", 90), pick("a2", 95), pick("g1", 84), pick("g2", 88)],
      },
      shortlist,
    )!;
    const forYou = out.picks.filter((p) => p.forYou).map((p) => p.id).sort();
    expect(forYou).toEqual(["a1", "a2"]);
  });

  it("orders cards scent, accents, grooming", () => {
    const out = validateStylePicks({ basis: [], picks: [pick("g1"), pick("a1"), pick("s1", 60), pick("s2", 80)] }, shortlist)!;
    expect(out.picks.map((p) => p.id)).toEqual(["s2", "s1", "a1", "g1"]);
  });
});

describe("badgesFor", () => {
  const badged = item("m", {
    badges: [
      {
        kind: "seenOn",
        text: { en: "Seen in Iron Man 3", ru: "В кадре «Железного человека 3»", uk: "У кадрі «Залізної людини 3»", de: "Zu sehen in Iron Man 3", pl: "Widziane w Iron Man 3" },
        sourceUrl: "https://example.com/src",
      },
    ],
  });

  it("puts 'for you' first, then catalog badges in the person's language", () => {
    expect(badgesFor(badged, true, "uk")).toEqual([
      { kind: "forYou" },
      { kind: "seenOn", text: "У кадрі «Залізної людини 3»", sourceUrl: "https://example.com/src" },
    ]);
  });

  it("falls back to English for an unknown language and omits 'for you' when not granted", () => {
    expect(badgesFor(badged, false, "fr")).toEqual([
      { kind: "seenOn", text: "Seen in Iron Man 3", sourceUrl: "https://example.com/src" },
    ]);
    expect(badgesFor(item("plain"), false, "en")).toEqual([]);
  });
});
