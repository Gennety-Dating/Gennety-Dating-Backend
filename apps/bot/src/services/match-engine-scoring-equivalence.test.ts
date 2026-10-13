import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  areMutuallyCompatible,
  greedyPair,
  majorSimilarityScore,
  penaltyScore,
  resolveCluster,
  scorePair,
  type BatchUser,
  type ScoredPair,
} from "./match-engine.js";

/**
 * The drop batch's scoring loop runs once per same-city pair — ~80 000 pairs
 * for a 400-user city — so its helpers memoise what depends on one side only
 * (the seeker's parsed dealbreaker traits, a major's cluster). A memo must not
 * be able to move a single score, so this file pins the loop's output two ways:
 *
 *   1. against verbatim copies of the per-call implementations the memos
 *      replaced (`reference*` below), pair by pair, on a fixture built to hit
 *      the regex edges — Cyrillic, regex metacharacters, case folding, the
 *      "non-smoker" boundary, blank and bracket-less lines;
 *   2. against a digest of every pair's score and breakdown plus the greedy
 *      allocation, recorded from the engine before the memos existed. Any
 *      change to a float, a pair, the ordering or a tie-break changes it.
 */

// ---------------------------------------------------------------------------
// Reference implementations — the pre-memo code, copied verbatim
// ---------------------------------------------------------------------------

function referenceParseNegativeTraits(constraints: string | null): string[] {
  if (!constraints) return [];
  const traits: string[] = [];
  for (const line of constraints.split("\n")) {
    const trimmed = line.replace(/^-\s*/, "").trim().toLowerCase();
    if (!trimmed) continue;
    const bracketMatch = trimmed.match(/\[([^\]]+)\]\s*$/);
    if (bracketMatch) {
      for (const t of bracketMatch[1]!.split(",")) {
        const cleaned = t.trim();
        if (cleaned) traits.push(cleaned);
      }
    } else {
      traits.push(trimmed);
    }
  }
  return traits;
}

function referenceEscapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function referenceTraitHits(summary: string, trait: string): boolean {
  if (!trait) return false;
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${referenceEscapeRegex(trait)}(?![\\p{L}\\p{N}])`,
    "iu",
  );
  return re.test(summary);
}

function referencePenaltyScore(
  seekerConstraints: string | null,
  candidateSummary: string | null,
): number {
  const traits = referenceParseNegativeTraits(seekerConstraints);
  if (traits.length === 0) return 0;
  if (!candidateSummary) return 0;
  let hits = 0;
  for (const trait of traits) {
    if (referenceTraitHits(candidateSummary, trait)) hits++;
  }
  return hits / traits.length;
}

const REFERENCE_MAJOR_CLUSTERS: Record<string, string[]> = {
  stem: [
    "computer science", "cs", "mathematics", "math", "physics", "engineering",
    "electrical engineering", "mechanical engineering", "chemistry", "biology",
    "statistics", "data science", "information technology", "it",
  ],
  humanities: [
    "history", "philosophy", "literature", "english", "linguistics",
    "cultural studies", "classics", "religious studies", "sociology",
    "anthropology", "political science", "psychology",
  ],
  arts: [
    "art", "fine arts", "music", "theater", "film", "design",
    "graphic design", "photography", "architecture",
  ],
  business: [
    "business", "economics", "finance", "accounting", "marketing",
    "management", "mba", "entrepreneurship", "international business",
  ],
  health: [
    "medicine", "nursing", "public health", "pharmacy", "dentistry",
    "kinesiology", "nutrition", "biomedical",
  ],
};

function referenceResolveCluster(major: string | null): string | null {
  if (!major) return null;
  const lookup = new Map<string, string>();
  for (const [cluster, majors] of Object.entries(REFERENCE_MAJOR_CLUSTERS)) {
    for (const m of majors) lookup.set(m, cluster);
  }
  const norm = major.trim().toLowerCase();
  const exact = lookup.get(norm);
  if (exact) return exact;
  for (const [key, cluster] of lookup) {
    if (norm.includes(key) || key.includes(norm)) return cluster;
  }
  return null;
}

function referenceMajorSimilarityScore(
  seekerMajor: string | null,
  candidateMajor: string | null,
): number {
  if (!seekerMajor || !candidateMajor) return 0.5;
  const a = seekerMajor.trim().toLowerCase();
  const b = candidateMajor.trim().toLowerCase();
  if (a === b) return 1.0;
  const clusterA = referenceResolveCluster(seekerMajor);
  const clusterB = referenceResolveCluster(candidateMajor);
  if (clusterA && clusterB && clusterA === clusterB) return 0.7;
  return 0.3;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const TRAITS = [
  "smoker", "SMOKER", "non-smoker", "lazy", "c++", "a.b", "(loud)", "$money",
  "back\\slash", "курить", "ледачий", "Кава", "late nights", "party animal",
  "gym", "Kelvin", "kelvin", "straße", "jazz?", "[x]", "it", "ex-",
];
const SUMMARY_WORDS = [
  "smoker", "Smoker", "non-smoker", "smokers", "lazy", "Lazy.", "c++", "C++ dev",
  "a.b", "axb", "(loud)", "loud", "$money", "back\\slash", "курить", "курити",
  "ледачий", "Кава", "кавa", "late nights", "late-nights", "party animal",
  "gym", "gymnast", "kelvin", "KELVIN", "strasse", "straße", "jazz?", "jazz",
  "[x]", "it", "IT", "ex-", "ex-partner", "calm", "curious", "runner", "2am",
];
const MAJORS = [
  "Computer Science", "  computer science ", "CS", "computer science and engineering",
  "Applied Math", "History", "Fine Arts", "art history", "Law", "law and economics",
  "Medicine", "IT", "it", "Design", "Журналістика", "Business", "", null,
];

function pick<T>(rand: () => number, list: readonly T[]): T {
  return list[Math.floor(rand() * list.length)]!;
}

function constraintsFor(rand: () => number): string | null {
  const roll = rand();
  if (roll < 0.25) return null;
  if (roll < 0.3) return "";
  const lines: string[] = [];
  const count = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const shape = rand();
    if (shape < 0.45) {
      const traits = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(rand, TRAITS));
      lines.push(`- [lifestyle] Avoid ${pick(rand, TRAITS)} [${traits.join(", ")}]`);
    } else if (shape < 0.7) {
      lines.push(`- ${pick(rand, TRAITS)}`);
    } else if (shape < 0.8) {
      lines.push("   ");
    } else if (shape < 0.9) {
      lines.push(`[values] summary [ ${pick(rand, TRAITS)} ,  , ${pick(rand, TRAITS)} ]  `);
    } else {
      lines.push(`-   ${pick(rand, TRAITS).toUpperCase()}   `);
    }
  }
  return lines.join("\n");
}

function summaryFor(rand: () => number): string | null {
  if (rand() < 0.1) return null;
  const words = Array.from({ length: 4 + Math.floor(rand() * 40) }, () => pick(rand, SUMMARY_WORDS));
  return words.join(rand() < 0.5 ? " " : ", ");
}

const GENDERS = ["male", "female"] as const;
const PREFERENCES = ["men", "women", "both"] as const;
const INTENTS = ["spark", "open", "falling", "longterm"] as const;

function fixtureUsers(count: number): BatchUser[] {
  const rand = lcg(20261013);
  const users: BatchUser[] = [];
  for (let i = 0; i < count; i++) {
    const hasBand = rand() < 0.4;
    users.push({
      id: `user-${String(i).padStart(3, "0")}`,
      age: rand() < 0.05 ? null : 18 + Math.floor(rand() * 14),
      gender: pick(rand, GENDERS),
      major: pick(rand, MAJORS),
      preference: pick(rand, PREFERENCES),
      universityDomain: rand() < 0.5 ? "knu.ua" : "hu-berlin.de",
      height: rand() < 0.1 ? null : 155 + Math.floor(rand() * 40),
      negativeConstraints: constraintsFor(rand),
      psychologicalSummary: summaryFor(rand),
      energyAxis: rand() < 0.2 ? null : rand() * 2.4 - 1.2,
      orientationAxis: rand() < 0.2 ? null : rand() * 2.4 - 1.2,
      embeddingLiteral: "[1]",
      eloScore: 200 + Math.floor(rand() * 600),
      standbyCount: Math.floor(rand() * 8) - 1,
      homeCityKey: rand() < 0.7 ? "ua:kyiv" : "de:berlin",
      ageRangeMin: hasBand && rand() < 0.8 ? 18 + Math.floor(rand() * 6) : null,
      ageRangeMax: hasBand && rand() < 0.8 ? 22 + Math.floor(rand() * 8) : null,
      typePrefTags: null,
      appearanceTags: null,
      relationshipIntents: INTENTS.filter(() => rand() < 0.3),
      rhythm: null,
    });
  }
  return users;
}

const USERS = fixtureUsers(160);

/** Same pair set and key order as `computePairwiseDistances`. */
function fixturePairs(users: readonly BatchUser[]): Array<[BatchUser, BatchUser, number]> {
  const byCity = new Map<string, BatchUser[]>();
  for (const user of users) {
    const bucket = byCity.get(user.homeCityKey!);
    if (bucket) bucket.push(user);
    else byCity.set(user.homeCityKey!, [user]);
  }
  const rand = lcg(7);
  const pairs: Array<[BatchUser, BatchUser, number]> = [];
  for (const city of byCity.values()) {
    for (let i = 0; i < city.length; i++) {
      for (let j = i + 1; j < city.length; j++) {
        if (!areMutuallyCompatible(city[i]!, city[j]!)) continue;
        pairs.push([city[i]!, city[j]!, rand() * 1.2]);
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scoring memos change no output", () => {
  it("penaltyScore equals the per-call regex implementation in both directions", () => {
    let compared = 0;
    for (const seeker of USERS) {
      for (const candidate of USERS) {
        expect(penaltyScore(seeker.negativeConstraints, candidate.psychologicalSummary)).toBe(
          referencePenaltyScore(seeker.negativeConstraints, candidate.psychologicalSummary),
        );
        compared++;
      }
    }
    expect(compared).toBe(USERS.length * USERS.length);
  });

  it("penaltyScore holds the regex edges the fixture is built around", () => {
    // Boundaries are letters and digits only, Unicode-aware: a suffix letter
    // breaks the hit, punctuation (a hyphen included) does not…
    expect(penaltyScore("- [smoker]", "two smokers")).toBe(0);
    expect(penaltyScore("- [smoker]", "a non-smoker")).toBe(1);
    // …metacharacters are literal, case folds under `iu`, Cyrillic is a letter.
    expect(penaltyScore("- [a.b, c++]", "axb and C++")).toBe(0.5);
    expect(penaltyScore("- [Kelvin]", "kelvin")).toBe(1);
    expect(penaltyScore("- [курить]", "курити")).toBe(0);
    // The memo returns the same matchers for a repeated seeker string.
    for (let i = 0; i < 3; i++) expect(penaltyScore("- [lazy, gym]", "Lazy. gymnast")).toBe(0.5);
  });

  it("resolveCluster and majorSimilarityScore equal the per-call implementation", () => {
    for (const a of MAJORS) {
      expect(resolveCluster(a)).toBe(referenceResolveCluster(a));
      for (const b of MAJORS) {
        expect(majorSimilarityScore(a, b)).toBe(referenceMajorSimilarityScore(a, b));
      }
    }
  });

  it("every pair score, breakdown and the greedy allocation match the pre-memo digest", () => {
    const pairs = fixturePairs(USERS);
    const hash = createHash("sha256");
    const scored: ScoredPair[] = [];
    for (const [a, b, distance] of pairs) {
      const result = scorePair(a, b, distance);
      hash.update(`${a.id}:${b.id}:${JSON.stringify(result)}\n`);
      scored.push({ userAId: a.id, userBId: b.id, score: result.score, breakdown: result.breakdown });
    }
    const allocation = greedyPair(scored).map((pair) => `${pair.userAId}:${pair.userBId}`);
    hash.update(allocation.join(","));

    const digest = hash.digest("hex");
    expect(pairs.length).toBe(PINNED_PAIR_COUNT);
    expect(allocation.length).toBe(PINNED_ALLOCATION_COUNT);
    expect(digest).toBe(PINNED_DIGEST);
  });
});

// Recorded from match-engine.ts at 5d935472, before the scoring memos.
const PINNED_PAIR_COUNT = 3721;
const PINNED_ALLOCATION_COUNT = 77;
const PINNED_DIGEST = "1a2ef3d2cdee8e40e46e45273d61f14fbf270082c96e079181a7cdfe424e65ff";
