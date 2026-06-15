import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION } from "@gennety/shared";

const { mClaimMatchDecision } = vi.hoisted(() => ({
  mClaimMatchDecision: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks — prisma, config, and downstream services the matching flow touches.
// Mirrors the pattern used by apps/bot/src/handlers/onboarding/onboarding.test.ts
// ---------------------------------------------------------------------------

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    profile: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    match: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    matchEvent: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    OPENAI_API_KEY: "",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    CUSTOM_EMOJI_ACCEPT_ID: "test-accept-emoji-id",
    CUSTOM_EMOJI_DECLINE_ID: "test-decline-emoji-id",
    CUSTOM_EMOJI_VERIFIED_ID: "test-verified-emoji-id",
    MESSAGE_EFFECT_MATCH_ID: "5104841245755180586",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

vi.mock("../../services/match-decision-claim.js", () => ({
  claimMatchDecision: (...args: unknown[]) => mClaimMatchDecision(...args),
}));

// Keep the scheduler handoff inert during decision tests — we assert the
// transition via the match.update mock instead of following the side effect.
vi.mock("./scheduler.js", () => ({
  startScheduling: vi.fn().mockResolvedValue(undefined),
  handleSchedulePick: vi.fn(),
  handleCalendarWebAppData: vi.fn(),
  generateProposalSlots: vi.fn(() => [
    new Date("2026-04-10T19:00:00.000Z"),
    new Date("2026-04-11T19:00:00.000Z"),
    new Date("2026-04-17T19:00:00.000Z"),
  ]),
}));

vi.mock("../../services/venue.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../services/venue.js")>(
      "../../services/venue.js",
    );
  return {
    ...actual,
    pickVenueAtMidpoint: vi.fn(async () => ({
      name: "Test Cafe",
      address: "123 Test St",
      googleMapsUri: "https://maps.google.com/?cid=test",
    })),
  };
});

vi.mock("../../services/wingman-hint.js", () => ({
  generateAndSaveWingmanHints: vi.fn().mockResolvedValue(null),
}));

import { prisma } from "@gennety/db";
import { handleMatchDecision } from "./decision.js";
import { buildDeclineReasonKeyboard, handleDeclineReasonCallback } from "./decline-feedback.js";
import { buildMatchKeyboard, sendMatchProposal } from "./pitch.js";
import { appendNegativeConstraint, normalizeReason } from "./negative-constraints.js";
import { startScheduling } from "./scheduler.js";
import { tryFinalize } from "./venue-negotiation.js";
import {
  buildCandidateSql,
  preferenceToGenderFilter,
  explicitScore,
  cosineSimilarity,
  penaltyScore,
  parseNegativeTraits,
  researchScore,
  heightNormScore,
  ageGradientScore,
  majorSimilarityScore,
  resolveCluster,
  scoreCandidate,
  rankCandidates,
  extractSocialEnergy,
  SCORING_WEIGHTS,
} from "../../services/match-engine.js";
import type { RichCandidateRow, SeekerProfile } from "../../services/match-engine.js";
import { localFallbackPitch, splitPitchIntoDrafts } from "../../services/pitch-generator.js";
import {
  localStubVenueClient,
  pickVenueAtMidpoint,
  pickVenueForMatch,
} from "../../services/venue.js";
import { buildDateTimeEntity } from "../../services/datetime-entity.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn; update: MockFn; updateMany: MockFn };
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mProfile = prisma.profile as unknown as { findUnique: MockFn; upsert: MockFn; updateMany: MockFn };
const mMatchEvent = prisma.matchEvent as unknown as { create: MockFn; updateMany: MockFn };
const mPickVenueAtMidpoint = pickVenueAtMidpoint as unknown as MockFn;

function createCtx(overrides: {
  session?: Partial<SessionData>;
  callbackData?: string;
  messageText?: string;
  fromId?: number;
}) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    pendingPhotos: [],
    ...overrides.session,
  };
  return {
    session,
    from: { id: overrides.fromId ?? 1001 },
    chat: { id: overrides.fromId ?? 1001 },
    callbackQuery: overrides.callbackData ? { data: overrides.callbackData } : undefined,
    message: overrides.messageText ? { text: overrides.messageText } : undefined,
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function matchRow(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "match-1",
    userAId: "uid-A",
    userBId: "uid-B",
    acceptedByA: null,
    acceptedByB: null,
    status: "proposed",
    userA: { telegramId: 1001n, language: "en" },
    userB: { telegramId: 1002n, language: "en" },
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// match-engine: SQL shape + preference mapping
// ---------------------------------------------------------------------------

describe("match-engine: pure helpers", () => {
  it("preferenceToGenderFilter maps men→male, women→female, both→empty", () => {
    expect(preferenceToGenderFilter("men")).toBe("male");
    expect(preferenceToGenderFilter("women")).toBe("female");
    expect(preferenceToGenderFilter("both")).toBe("");
  });

  it("buildCandidateSql returns parameterised SQL with no string concatenation of inputs", () => {
    const sql = buildCandidateSql();
    // All interpolated values MUST use $N placeholders — never embedded literals.
    expect(sql).toMatch(/\$1/);
    expect(sql).toMatch(/\$2::vector/);
    expect(sql).toMatch(/\$3/);
    expect(sql).toMatch(/\$7/);
    // Must enforce the citywide local rule while keeping email domain as a trust gate.
    expect(sql).toMatch(/u\.university_domain IS NOT NULL/);
    expect(sql).toMatch(/p\.home_city_key\s*=\s*\$3/);
    // Must enforce the lifetime ban: any historical Match between the two
    // users excludes the candidate, regardless of terminal status.
    expect(sql).toMatch(/NOT EXISTS/);
    // The anti-join uses LEAST/GREATEST so the canonical-pair functional
    // index (matches_pair_canonical_idx) is the chosen access path.
    expect(sql).toMatch(/LEAST\(m\.user_a_id, m\.user_b_id\)/);
    expect(sql).toMatch(/GREATEST\(m\.user_a_id, m\.user_b_id\)/);
    // No status filter — lifetime ban covers every terminal state.
    expect(sql).not.toMatch(/status IN/);
    // Must ORDER BY pgvector distance ASC.
    expect(sql).toMatch(/ORDER BY distance ASC/);
  });
});

// ---------------------------------------------------------------------------
// Multi-factor scoring — pure functions
// ---------------------------------------------------------------------------

function makeSeeker(overrides: Partial<SeekerProfile> = {}): SeekerProfile {
  return {
    age: 22,
    gender: "female",
    height: 165,
    major: "computer science",
    negativeConstraints: null,
    socialEnergy: "ambivert",
    eloScore: 500,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<RichCandidateRow> = {}): RichCandidateRow {
  return {
    userId: "cand-1",
    telegramId: 2001n,
    firstName: "Bob",
    distance: 0.3,
    age: 23,
    gender: "male",
    height: 180,
    major: "physics",
    psychologicalSummary: "Warm, curious, extroverted. Loves jazz and philosophy.",
    negativeConstraints: null,
    socialEnergy: "extrovert",
    eloScore: 500,
    homeCityKey: "ua:kyiv",
    ...overrides,
  };
}

describe("explicitScore", () => {
  it("returns 1.0 for distance 0 (identical embeddings)", () => {
    expect(explicitScore(0)).toBe(1);
  });

  it("returns 0.5 for distance 1 (orthogonal)", () => {
    expect(explicitScore(1)).toBe(0.5);
  });

  it("returns 0 for distance 2 (opposite)", () => {
    expect(explicitScore(2)).toBe(0);
  });

  it("clamps negative distances to 1.0", () => {
    expect(explicitScore(-0.1)).toBe(1);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe("parseNegativeTraits", () => {
  it("returns empty array for null input", () => {
    expect(parseNegativeTraits(null)).toEqual([]);
  });

  it("extracts traits from bracketed format", () => {
    const input = "- [preference] Too introverted [introvert, shy]";
    const traits = parseNegativeTraits(input);
    expect(traits).toEqual(["introvert", "shy"]);
  });

  it("uses full line as trait when no brackets present", () => {
    const input = "- not into gym bros";
    expect(parseNegativeTraits(input)).toEqual(["not into gym bros"]);
  });

  it("handles multiple constraint lines", () => {
    const input = "- [physical] Too short [short]\n- [lifestyle] Party animal [party, loud]";
    const traits = parseNegativeTraits(input);
    expect(traits).toEqual(["short", "party", "loud"]);
  });
});

describe("penaltyScore", () => {
  it("returns 0 when seeker has no constraints", () => {
    expect(penaltyScore(null, "anything")).toBe(0);
  });

  it("returns 0 when candidate has no summary", () => {
    expect(penaltyScore("- [pref] avoids loud [loud]", null)).toBe(0);
  });

  it("returns 1.0 when all traits match", () => {
    const constraints = "- [pref] avoids loud people [loud, obnoxious]";
    const summary = "Loud and obnoxious party animal.";
    expect(penaltyScore(constraints, summary)).toBe(1.0);
  });

  it("returns 0.5 when half the traits match", () => {
    const constraints = "- [pref] avoids loud people [loud, obnoxious]";
    const summary = "Quiet but somewhat obnoxious.";
    expect(penaltyScore(constraints, summary)).toBe(0.5);
  });

  it("returns 0 when no traits match", () => {
    const constraints = "- [pref] avoids gym bros [gym, bro]";
    const summary = "Loves reading, painting, and jazz.";
    expect(penaltyScore(constraints, summary)).toBe(0);
  });
});

describe("extractSocialEnergy", () => {
  it("detects introvert", () => {
    expect(extractSocialEnergy("An introvert who loves books")).toBe("introvert");
  });

  it("detects extrovert", () => {
    expect(extractSocialEnergy("Extrovert, loves parties")).toBe("extrovert");
  });

  it("detects ambivert", () => {
    expect(extractSocialEnergy("A true ambivert")).toBe("ambivert");
  });

  it("returns null when no keyword found", () => {
    expect(extractSocialEnergy("Loves cooking")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(extractSocialEnergy(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// heightNormScore
// ---------------------------------------------------------------------------

describe("heightNormScore", () => {
  it("returns 1.0 when male is 5–12 cm taller (sweet spot)", () => {
    expect(heightNormScore(175, 165)).toBe(1.0); // +10
    expect(heightNormScore(170, 165)).toBe(1.0); // +5
    expect(heightNormScore(177, 165)).toBe(1.0); // +12
  });

  it("returns 0.7 when male is >12 cm taller", () => {
    expect(heightNormScore(185, 160)).toBe(0.7); // +25
  });

  it("returns 0.6 when male is 1–4 cm taller", () => {
    expect(heightNormScore(168, 165)).toBe(0.6); // +3
  });

  it("returns 0.5 for equal height", () => {
    expect(heightNormScore(170, 170)).toBe(0.5);
  });

  it("returns 0.2 (penalty) when male is shorter", () => {
    expect(heightNormScore(160, 170)).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// ageGradientScore
// ---------------------------------------------------------------------------

describe("ageGradientScore", () => {
  it("returns 1.0 for same-age M/F pair", () => {
    expect(ageGradientScore(22, 22, "female", "male")).toBe(1.0);
  });

  it("returns 1.0 when male is 1–2 years older", () => {
    // female seeker 22, male candidate 23 → male is 1yr older
    expect(ageGradientScore(22, 23, "female", "male")).toBe(1.0);
    // male seeker 24, female candidate 22 → male is 2yr older
    expect(ageGradientScore(24, 22, "male", "female")).toBe(1.0);
  });

  it("returns 0.6 (soft penalty) for exactly 3-year gap", () => {
    expect(ageGradientScore(22, 25, "female", "male")).toBe(0.6);
  });

  it("returns < 0.6 for gap > 3 years", () => {
    const score = ageGradientScore(22, 27, "female", "male");
    expect(score).toBeLessThan(0.6);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 for gap >= 10 years", () => {
    expect(ageGradientScore(20, 30, "female", "male")).toBe(0);
  });

  it("penalises female-older direction in M/F pairs", () => {
    // female 25, male 22 → male is 3yr YOUNGER → gap=3 but wrong direction
    const femaleOlder = ageGradientScore(25, 22, "female", "male");
    // female 22, male 25 → male is 3yr OLDER → gap=3
    const maleOlder = ageGradientScore(22, 25, "female", "male");
    expect(maleOlder).toBeGreaterThanOrEqual(femaleOlder);
  });

  it("uses symmetric scoring for same-gender pairs", () => {
    const a = ageGradientScore(22, 24, "male", "male");
    const b = ageGradientScore(24, 22, "male", "male");
    expect(a).toBe(b);
    expect(a).toBe(1.0); // diff=2 → full score
  });
});

// ---------------------------------------------------------------------------
// majorSimilarityScore + resolveCluster
// ---------------------------------------------------------------------------

describe("majorSimilarityScore", () => {
  it("returns 1.0 for exact same major", () => {
    expect(majorSimilarityScore("Computer Science", "computer science")).toBe(1.0);
  });

  it("returns 0.7 for same cluster (STEM + STEM)", () => {
    expect(majorSimilarityScore("physics", "mathematics")).toBe(0.7);
  });

  it("returns 0.3 for cross-cluster majors", () => {
    expect(majorSimilarityScore("computer science", "history")).toBe(0.3);
  });

  it("returns 0.5 (neutral) when either major is null", () => {
    expect(majorSimilarityScore(null, "physics")).toBe(0.5);
    expect(majorSimilarityScore("physics", null)).toBe(0.5);
  });
});

describe("resolveCluster", () => {
  it("resolves known majors to their cluster", () => {
    expect(resolveCluster("computer science")).toBe("stem");
    expect(resolveCluster("history")).toBe("humanities");
    expect(resolveCluster("music")).toBe("arts");
    expect(resolveCluster("finance")).toBe("business");
    expect(resolveCluster("nursing")).toBe("health");
  });

  it("resolves via substring match", () => {
    expect(resolveCluster("Computer Science and Engineering")).toBe("stem");
  });

  it("returns null for unknown major", () => {
    expect(resolveCluster("underwater basket weaving")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(resolveCluster(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// researchScore (composite)
// ---------------------------------------------------------------------------

describe("researchScore", () => {
  it("taller male + 1yr older scores higher than shorter male (identical embeddings)", () => {
    const seeker = { age: 22, gender: "female" as const, height: 165, socialEnergy: null, major: null };
    const tallerOlder = { age: 23, gender: "male" as const, height: 175, socialEnergy: null, major: null };
    const shorterSame = { age: 22, gender: "male" as const, height: 160, socialEnergy: null, major: null };

    const scoreTaller = researchScore(seeker, tallerOlder);
    const scoreShorter = researchScore(seeker, shorterSame);
    expect(scoreTaller).toBeGreaterThan(scoreShorter);
  });

  it("same-major pair beats cross-cluster pair", () => {
    const base = { age: null, gender: null, height: null, socialEnergy: null };
    const sameMajor = researchScore(
      { ...base, major: "physics" },
      { ...base, major: "physics" },
    );
    const crossCluster = researchScore(
      { ...base, major: "physics" },
      { ...base, major: "history" },
    );
    expect(sameMajor).toBeGreaterThan(crossCluster);
  });

  it("boosts same social energy", () => {
    const score = researchScore(
      { age: null, gender: null, height: null, socialEnergy: "introvert", major: null },
      { age: null, gender: null, height: null, socialEnergy: "introvert", major: null },
    );
    expect(score).toBe(1.0);
  });

  it("returns 0.5 (neutral) when no data available", () => {
    expect(researchScore(
      { age: null, gender: null, height: null, socialEnergy: null, major: null },
      { age: null, gender: null, height: null, socialEnergy: null, major: null },
    )).toBe(0.5);
  });
});

describe("scoreCandidate — composite formula", () => {
  it("candidate with matching traits and no red flags scores higher than embedding-only match", () => {
    const seeker = makeSeeker();

    // Candidate A: good embedding, matching visual, no penalty
    const goodCandidate = makeCandidate({
      userId: "good",
      distance: 0.4,
      psychologicalSummary: "Warm ambivert who loves philosophy and jazz",
    });

    // Candidate B: better embedding but has penalty-triggering traits
    const penaltyCandidate = makeCandidate({
      userId: "penalty",
      distance: 0.2, // better embedding distance
      psychologicalSummary: "Loud gym bro who parties every night",
    });

    const seekerWithConstraints = makeSeeker({
      negativeConstraints: "- [lifestyle] avoids party animals [loud, gym, party]",
    });

    const scoreGood = scoreCandidate(seekerWithConstraints, goodCandidate);
    const scorePenalty = scoreCandidate(seekerWithConstraints, penaltyCandidate);

    expect(scoreGood.score).toBeGreaterThan(scorePenalty.score);
  });

  it("penalty can push score negative for heavily penalised candidates", () => {
    const seeker = makeSeeker({
      negativeConstraints: "- [dealbreaker] red flags [arrogant, dismissive]",
    });
    const candidate = makeCandidate({
      distance: 1.8, // poor embedding
      psychologicalSummary: "Arrogant and dismissive know-it-all",
    });

    const result = scoreCandidate(seeker, candidate);
    expect(result.score).toBeLessThan(0);
  });

  it("breakdown contains all four sub-scores", () => {
    const result = scoreCandidate(makeSeeker(), makeCandidate());
    expect(result.breakdown).toHaveProperty("explicit");
    expect(result.breakdown).toHaveProperty("research");
    expect(result.breakdown).toHaveProperty("league");
    expect(result.breakdown).toHaveProperty("penalty");
  });
});

describe("rankCandidates", () => {
  it("returns candidates sorted by score descending", () => {
    const seeker = makeSeeker();
    const candidates = [
      makeCandidate({ userId: "far", distance: 1.5 }),
      makeCandidate({ userId: "close", distance: 0.1 }),
      makeCandidate({ userId: "mid", distance: 0.6 }),
    ];

    const ranked = rankCandidates(seeker, candidates);
    expect(ranked[0]!.userId).toBe("close");
    expect(ranked[ranked.length - 1]!.userId).toBe("far");
  });

  it("respects the limit parameter", () => {
    const seeker = makeSeeker();
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate({ userId: `c-${i}`, distance: i * 0.1 }),
    );

    const ranked = rankCandidates(seeker, candidates, 3);
    expect(ranked).toHaveLength(3);
  });

  it("re-ranks so a penalised candidate with better embedding drops below a clean one", () => {
    const seeker = makeSeeker({
      negativeConstraints: "- [lifestyle] avoids smokers [smoker, smoking]",
    });

    const cleanCandidate = makeCandidate({
      userId: "clean",
      distance: 0.5,
      psychologicalSummary: "Loves hiking and reading.",
    });
    const smokerCandidate = makeCandidate({
      userId: "smoker",
      distance: 0.2, // better embedding
      psychologicalSummary: "Heavy smoker who loves smoking breaks.",
    });

    const ranked = rankCandidates(seeker, [smokerCandidate, cleanCandidate]);
    expect(ranked[0]!.userId).toBe("clean");
    expect(ranked[1]!.userId).toBe("smoker");
  });
});

// ---------------------------------------------------------------------------
// pitch-generator: fallback + draft splitter
// ---------------------------------------------------------------------------

describe("pitch-generator: fallback + splitter", () => {
  it("localFallbackPitch includes the other user's first name when known", () => {
    const text = localFallbackPitch({
      selfFirstName: "Alice",
      otherFirstName: "Bob",
      selfSummary: null,
      otherSummary: null,
      language: "en",
    });
    expect(text).toContain("Bob");
  });

  it("localFallbackPitch falls back to 'someone' when name missing", () => {
    const text = localFallbackPitch({
      selfFirstName: null,
      otherFirstName: null,
      selfSummary: null,
      otherSummary: null,
      language: "en",
    });
    expect(text).toMatch(/someone/i);
  });

  it("localFallbackPitch localises to Russian", () => {
    const text = localFallbackPitch({
      selfFirstName: null,
      otherFirstName: "Маша",
      selfSummary: null,
      otherSummary: null,
      language: "ru",
    });
    expect(text).toContain("Маша");
    expect(text).toMatch(/совпадение/);
  });

  it("splitPitchIntoDrafts returns one chunk for a single sentence", () => {
    expect(splitPitchIntoDrafts("Just one sentence.")).toEqual(["Just one sentence."]);
  });

  it("splitPitchIntoDrafts produces growing-prefix drafts for multiple sentences", () => {
    const drafts = splitPitchIntoDrafts("First sentence. Second one! Third?");
    expect(drafts).toEqual([
      "First sentence.",
      "First sentence. Second one!",
      "First sentence. Second one! Third?",
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildMatchKeyboard: API 9.4 styled buttons
// ---------------------------------------------------------------------------

describe("buildMatchKeyboard (API 9.4 styled buttons)", () => {
  it("returns InlineKeyboardMarkup with Accept/Decline row + Report row", () => {
    const kb = buildMatchKeyboard("match-42", "en");
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0]).toHaveLength(2);
    expect(kb.inline_keyboard[1]).toHaveLength(1);
  });

  it("Accept button has style='success' and icon_custom_emoji_id when configured", () => {
    const kb = buildMatchKeyboard("match-42", "en");
    const acceptBtn = kb.inline_keyboard[0]![0] as unknown as Record<string, unknown>;
    expect(acceptBtn.callback_data).toBe("match:accept:match-42");
    expect(acceptBtn.style).toBe("success");
    expect(acceptBtn.icon_custom_emoji_id).toBe("test-accept-emoji-id");
  });

  it("Decline button has style='danger' and icon_custom_emoji_id when configured", () => {
    const kb = buildMatchKeyboard("match-42", "en");
    const declineBtn = kb.inline_keyboard[0]![1] as unknown as Record<string, unknown>;
    expect(declineBtn.callback_data).toBe("match:decline:match-42");
    expect(declineBtn.style).toBe("danger");
    expect(declineBtn.icon_custom_emoji_id).toBe("test-decline-emoji-id");
  });

  it("Report button lives on the second row with report:open callback", () => {
    const kb = buildMatchKeyboard("match-42", "en");
    const reportBtn = kb.inline_keyboard[1]![0] as unknown as Record<string, unknown>;
    expect(reportBtn.callback_data).toBe("report:open:match-42");
  });
});

describe("buildDeclineReasonKeyboard", () => {
  it("offers quick reasons plus a free-text/voice fallback", () => {
    const kb = buildDeclineReasonKeyboard("match-42", "en");
    const buttons = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;

    expect(buttons.map((b) => b.text)).toEqual([
      "Not my type",
      "Different vibe",
      "Interests don't match",
      "Lifestyle mismatch",
      "Something else",
    ]);
    expect(buttons.map((b) => b.callback_data)).toContain("mdr:match-42:interests");
  });

  it("keeps quick-reason callback_data under Telegram's 64-byte limit with UUID ids", () => {
    const kb = buildDeclineReasonKeyboard("22b9c76f-8cb5-4669-bba4-00b3ce408cb1", "en");
    const callbacks = kb.inline_keyboard
      .flat()
      .map((b) => (b as { callback_data?: string }).callback_data)
      .filter((data): data is string => Boolean(data));

    expect(callbacks).toContain("mdr:22b9c76f-8cb5-4669-bba4-00b3ce408cb1:lifestyle");
    callbacks.forEach((data) => expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64));
  });
});

// ---------------------------------------------------------------------------
// sendMatchProposal: photo card + synergy header dispatch
// ---------------------------------------------------------------------------

describe("sendMatchProposal — photo + synergy dispatch", () => {
  function makeApi() {
    return {
      token: "test-bot-token",
      sendLivePhoto: vi.fn().mockResolvedValue({ message_id: 9000 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 9001 }),
      sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 9001 }]),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 9002 }),
      raw: {
        sendMessageDraft: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  }

  function findUniquePayload(overrides: {
    pitchForA?: string | null;
    pitchForB?: string | null;
    synergyScore?: number | null;
    synergyReason?: string | null;
    photosA?: string[];
    photosB?: string[];
    profileMediaA?: unknown[];
    profileMediaB?: unknown[];
    ageA?: number | null;
    ageB?: number | null;
    verificationA?: string;
    verificationB?: string;
    pitchMessageIdA?: number | null;
    pitchMessageIdB?: number | null;
  } = {}) {
    // `in` so explicit `null` overrides (age missing, synergy missing) win
    // over the defaults. Plain `??` coerces null back to the default.
    const pick = <T,>(key: string, fallback: T): T =>
      key in overrides ? ((overrides as Record<string, unknown>)[key] as T) : fallback;
    return {
      id: "match-photo-1",
      pitchForA: pick<string | null>("pitchForA", "You two click. Both love jazz."),
      pitchForB: pick<string | null>("pitchForB", "You two click. Both love jazz."),
      synergyScore: pick<number | null>("synergyScore", 87),
      synergyReason: pick<string | null>(
        "synergyReason",
        "Aligned values and complementary rhythms.",
      ),
      pitchMessageIdA: pick<number | null>("pitchMessageIdA", null),
      pitchMessageIdB: pick<number | null>("pitchMessageIdB", null),
      userA: {
        telegramId: 1001n,
        firstName: "Alice",
        age: pick<number | null>("ageA", 22),
        language: "en",
        verificationStatus: pick<string>("verificationA", "unverified"),
        profile: {
          psychologicalSummary: "warm",
          photos: pick<string[]>("photosA", ["file-a-1"]),
          profileMedia: pick<unknown[]>("profileMediaA", []),
        },
      },
      userB: {
        telegramId: 1002n,
        firstName: "Bob",
        age: pick<number | null>("ageB", 24),
        language: "en",
        verificationStatus: pick<string>("verificationB", "unverified"),
        profile: {
          psychologicalSummary: "curious",
          photos: pick<string[]>("photosB", ["file-b-1", "file-b-2"]),
          profileMedia: pick<unknown[]>("profileMediaB", []),
        },
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mMatch.update.mockResolvedValue({ id: "match-photo-1" });
  });

  it("sends partner's media group with `Name, Age` caption to the recipient", async () => {
    mMatch.findUnique.mockResolvedValue(findUniquePayload());
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream });

    // User A is shown User B's two photos with caption "Bob, 24" on the
    // first item only. User B is shown User A's single photo via sendPhoto
    // with caption "Alice, 22".
    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(api.sendMediaGroup).toHaveBeenCalledWith(
      1001,
      [
        { type: "photo", media: "file-b-1", caption: "Bob, 24" },
        { type: "photo", media: "file-b-2" },
      ],
      { protect_content: true },
    );
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto).toHaveBeenCalledWith(1002, "file-a-1", {
      caption: "Alice, 22",
      protect_content: true,
    });
  });

  it("sends a single live profile media item with sendLivePhoto", async () => {
    mMatch.findUnique.mockResolvedValue(
      findUniquePayload({
        photosB: ["bob_static_1"],
        profileMediaB: [
          {
            type: "live_photo",
            photo: "bob_static_1",
            livePhoto: "bob_live_1",
            duration: 4,
          },
        ],
      }),
    );
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream });

    expect(api.sendLivePhoto).toHaveBeenCalledWith(1001, "bob_live_1", "bob_static_1", {
      caption: "Bob, 24",
      protect_content: true,
    });
  });

  it("sends mixed photo/live albums with caption entities on the first item", async () => {
    mMatch.findUnique.mockResolvedValue(
      findUniquePayload({
        verificationB: "verified",
        photosB: ["bob_static_1", "bob_static_2"],
        profileMediaB: [
          { type: "photo", photo: "bob_static_1" },
          {
            type: "live_photo",
            photo: "bob_static_2",
            livePhoto: "bob_live_2",
          },
        ],
      }),
    );
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream });

    const mediaCallA = api.sendMediaGroup.mock.calls.find((c: unknown[]) => c[0] === 1001);
    expect(mediaCallA).toBeDefined();
    expect(mediaCallA![1]).toEqual([
      {
        type: "photo",
        media: "bob_static_1",
        caption: "Bob, 24\n✓ Verified",
        caption_entities: [
          {
            type: "custom_emoji",
            offset: "Bob, 24\n".length,
            length: 1,
            custom_emoji_id: "test-verified-emoji-id",
          },
        ],
      },
      {
        type: "live_photo",
        media: "bob_live_2",
        photo: "bob_static_2",
      },
    ]);
  });

  it("prepends `💎 Synergy 87/99 — <reason>` to the final pitch chunk", async () => {
    mMatch.findUnique.mockResolvedValue(findUniquePayload());
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream });

    // streamImpl receives (api, chatId, drafts, options); the final chunk
    // is the last entry — it should carry both the synergy line and the
    // countdown plate.
    const callA = stream.mock.calls.find((c) => c[1] === 1001);
    const callB = stream.mock.calls.find((c) => c[1] === 1002);
    expect(callA).toBeDefined();
    expect(callB).toBeDefined();
    const draftsA = callA![2] as string[];
    const draftsB = callB![2] as string[];
    const finalA = draftsA[draftsA.length - 1]!;
    const finalB = draftsB[draftsB.length - 1]!;
    expect(finalA).toContain("Synergy 87/99");
    expect(finalA).toContain("Aligned values and complementary rhythms.");
    expect(finalA).toContain("You two click. Both love jazz.");
    expect(finalB).toContain("Synergy 87/99");
  });

  it("falls back to name-only caption when age is missing", async () => {
    mMatch.findUnique.mockResolvedValue(findUniquePayload({ ageB: null }));
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream });

    // User A sees User B's photos — but B has no age, so caption is just "Bob".
    const mediaCall = api.sendMediaGroup.mock.calls.find((c: unknown[]) => c[0] === 1001);
    expect(mediaCall).toBeDefined();
    const media = mediaCall![1] as Array<Record<string, unknown>>;
    expect(media[0]!.caption).toBe("Bob");
  });

  it("skips photo dispatch when partner has no photos but still streams pitch", async () => {
    mMatch.findUnique.mockResolvedValue(findUniquePayload({ photosA: [], photosB: [] }));
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream });

    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendMediaGroup).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("swallows photo dispatch errors so a stale file_id can't block the pitch", async () => {
    mMatch.findUnique.mockResolvedValue(findUniquePayload());
    const api = makeApi();
    api.sendMediaGroup.mockRejectedValueOnce(new Error("file_id revoked"));
    api.sendPhoto.mockRejectedValueOnce(new Error("file_id revoked"));
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await expect(
      sendMatchProposal(api, "match-photo-1", { streamImpl: stream }),
    ).resolves.toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("falls back to the static frame when a single Live Photo send fails", async () => {
    mMatch.findUnique.mockResolvedValue(
      findUniquePayload({
        photosB: ["bob_static_1"],
        profileMediaB: [
          {
            type: "live_photo",
            photo: "bob_static_1",
            livePhoto: "bob_live_1",
          },
        ],
      }),
    );
    const api = makeApi();
    api.sendLivePhoto.mockRejectedValueOnce(new Error("live unsupported"));
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await expect(
      sendMatchProposal(api, "match-photo-1", { streamImpl: stream }),
    ).resolves.toBeUndefined();

    expect(api.sendPhoto).toHaveBeenCalledWith(1001, "bob_static_1", {
      caption: "Bob, 24",
      protect_content: true,
    });
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("falls back to a static media group when a mixed Live Photo album fails", async () => {
    mMatch.findUnique.mockResolvedValue(
      findUniquePayload({
        photosB: ["bob_static_1", "bob_static_2"],
        profileMediaB: [
          {
            type: "live_photo",
            photo: "bob_static_1",
            livePhoto: "bob_live_1",
          },
          { type: "photo", photo: "bob_static_2" },
        ],
      }),
    );
    const api = makeApi();
    api.sendMediaGroup.mockRejectedValueOnce(new Error("live album unsupported"));
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream });

    expect(api.sendMediaGroup).toHaveBeenNthCalledWith(
      2,
      1001,
      [
        { type: "photo", media: "bob_static_1", caption: "Bob, 24" },
        { type: "photo", media: "bob_static_2" },
      ],
      { protect_content: true },
    );
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("omits the synergy header when score/reason are missing on the row", async () => {
    // Older rows pre-feature might land here without synergy data and with
    // an injected pitchImpl that also returns nothing — verify we don't
    // crash and don't render an empty header.
    mMatch.findUnique.mockResolvedValue(
      findUniquePayload({ synergyScore: null, synergyReason: null }),
    );
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });
    const pitchImpl = vi.fn().mockResolvedValue({
      pitch: "You two click.",
      synergyScore: null as unknown as number,
      synergyReason: "",
    });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream, pitchImpl });

    const callA = stream.mock.calls.find((c) => c[1] === 1001);
    const draftsA = callA![2] as string[];
    const finalA = draftsA[draftsA.length - 1]!;
    expect(finalA).not.toContain("Synergy");
    expect(finalA).not.toContain("/99");
  });

  it("renders the verified badge in the partner caption + sends the trust card after the pitch", async () => {
    // Side A is the recipient; the badge describes the *partner* (B).
    mMatch.findUnique.mockResolvedValue(
      findUniquePayload({ verificationB: "verified" }),
    );
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream });

    // Partner-photo caption now carries `Bob, 24\n✓ Verified` with a
    // `custom_emoji` entity over the `✓` glyph (offset = headline + "\n").
    const mediaCallA = api.sendMediaGroup.mock.calls.find((c: unknown[]) => c[0] === 1001);
    expect(mediaCallA).toBeDefined();
    const mediaA = mediaCallA![1] as Array<Record<string, unknown>>;
    expect(mediaA[0]!.caption).toBe("Bob, 24\n✓ Verified");
    expect(mediaA[0]!.caption_entities).toEqual([
      {
        type: "custom_emoji",
        offset: "Bob, 24\n".length,
        length: 1,
        custom_emoji_id: "test-verified-emoji-id",
      },
    ]);
    // Other album items must NOT carry caption fields — Telegram puts the
    // caption on the first item only.
    expect(mediaA[1]).toEqual({ type: "photo", media: "file-b-2" });

    // Closing trust card is the last sendMessage to side A's chat, with
    // a blockquote entity covering the entire body.
    const trustCalls = api.sendMessage.mock.calls.filter((c: unknown[]) => c[0] === 1001);
    expect(trustCalls).toHaveLength(1);
    const [, body, opts] = trustCalls[0]!;
    expect(body).toContain("face-match");
    expect((opts as { entities: unknown[] }).entities).toEqual([
      { type: "blockquote", offset: 0, length: (body as string).length },
    ]);

    // Side B's partner (A) is unverified → no trust card, no badge for B.
    const mediaCallB = api.sendPhoto.mock.calls.find((c: unknown[]) => c[0] === 1002);
    expect(mediaCallB![2]).toEqual({ caption: "Alice, 22", protect_content: true });
    const trustCallsB = api.sendMessage.mock.calls.filter((c: unknown[]) => c[0] === 1002);
    expect(trustCallsB).toHaveLength(0);
  });

  it("omits the verified badge and trust card when the partner is unverified", async () => {
    mMatch.findUnique.mockResolvedValue(findUniquePayload());
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-photo-1", { streamImpl: stream });

    // Caption stays at the legacy `Name, Age` form — no extra line, no entities.
    const mediaCallA = api.sendMediaGroup.mock.calls.find((c: unknown[]) => c[0] === 1001);
    const mediaA = mediaCallA![1] as Array<Record<string, unknown>>;
    expect(mediaA[0]!.caption).toBe("Bob, 24");
    expect(mediaA[0]!.caption_entities).toBeUndefined();

    // No closing trust card on either chat.
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("persists a successful side immediately and skips it on retry", async () => {
    mMatch.findUnique
      .mockResolvedValueOnce(findUniquePayload())
      .mockResolvedValueOnce(findUniquePayload({ pitchMessageIdA: 7001 }));
    const api = makeApi();
    const firstStream = vi.fn(async (_api: unknown, chatId: number): Promise<any> => {
      if (chatId === 1002) throw new Error("temporary Telegram failure");
      return { message_id: 7001 };
    });

    await expect(
      sendMatchProposal(api, "match-photo-1", { streamImpl: firstStream }),
    ).rejects.toThrow("Pitch delivery failed");
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "match-photo-1" },
      data: { pitchMessageIdA: 7001 },
    });

    const retryStream = vi.fn().mockResolvedValue({ message_id: 7002 });
    await sendMatchProposal(api, "match-photo-1", { streamImpl: retryStream });

    expect(retryStream).toHaveBeenCalledOnce();
    expect(retryStream.mock.calls[0]![1]).toBe(1002);
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "match-photo-1" },
      data: { pitchMessageIdB: 7002 },
    });
  });
});

// ---------------------------------------------------------------------------
// decision handler: Accept / Decline / rejection reason
// ---------------------------------------------------------------------------

describe("matching decision flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mMatch.update.mockResolvedValue({ id: "match-1", acceptedByA: null, acceptedByB: null });
    mMatch.updateMany.mockResolvedValue({ count: 0 });
    mMatchEvent.updateMany.mockResolvedValue({ count: 1 });
    mProfile.updateMany.mockResolvedValue({ count: 1 });
    mUser.findUnique.mockResolvedValue({ id: "uid-A" });
    mClaimMatchDecision.mockResolvedValue({ claimed: false });
  });

  it("accept from userA sets acceptedByA=true and stays pending when B not yet accepted", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow());
    mClaimMatchDecision.mockResolvedValueOnce({
      claimed: true,
      status: "proposed",
      acceptedByA: true,
      acceptedByB: null,
    });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:accept:match-1",
      fromId: 1001,
    });

    await handleMatchDecision(ctx);

    expect(mClaimMatchDecision).toHaveBeenCalledWith({
      matchId: "match-1",
      side: "A",
      decision: true,
    });
    expect(mMatchEvent.create).toHaveBeenCalledWith({
      data: {
        matchId: "match-1",
        actorId: "uid-A",
        targetId: "uid-B",
        actionType: "ACCEPTED",
      },
    });
    // No transition to `negotiating` yet.
    expect(mMatch.updateMany).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
    // API 9.3: accept reply carries message_effect_id.
    expect(ctx.reply).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message_effect_id: "5104841245755180586" }));
    expect(startScheduling).not.toHaveBeenCalled();
  });

  it("second accept flips match to 'negotiating' and invokes startScheduling", async () => {
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ acceptedByA: true, acceptedByB: null }),
    );
    mClaimMatchDecision.mockResolvedValueOnce({
      claimed: true,
      status: "proposed",
      acceptedByA: true,
      acceptedByB: true,
    });
    mMatch.updateMany.mockResolvedValueOnce({ count: 1 }); // atomic status -> negotiating

    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:accept:match-1",
      fromId: 1002,
    });

    await handleMatchDecision(ctx);

    expect(mClaimMatchDecision).toHaveBeenCalledWith({
      matchId: "match-1",
      side: "B",
      decision: true,
    });
    expect(mMatchEvent.create).toHaveBeenCalledWith({
      data: {
        matchId: "match-1",
        actorId: "uid-B",
        targetId: "uid-A",
        actionType: "ACCEPTED",
      },
    });
    expect(mMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1", status: "proposed" },
        data: { status: "negotiating" },
      }),
    );
    expect(startScheduling).toHaveBeenCalledWith(expect.anything(), "match-1");
    // API 9.3: both-accepted reply carries message_effect_id.
    expect(ctx.reply).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message_effect_id: "5104841245755180586" }));
  });

  it("first decline keeps match in 'proposed' and sends BLIND nudge (no reveal)", async () => {
    // Blind-decision: when A declines first, the row must NOT flip to
    // cancelled — peer's keyboard stays live until they decide or TTL
    // hits. Peer gets a generic "your match answered, your turn" DM
    // that gives away nothing about the actual answer.
    mMatch.findUnique.mockResolvedValueOnce(matchRow());
    mClaimMatchDecision.mockResolvedValueOnce({
      claimed: true,
      status: "proposed",
      acceptedByA: false,
      acceptedByB: null,
    });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:decline:match-1",
      fromId: 1001,
    });

    await handleMatchDecision(ctx);

    // Status MUST stay 'proposed' — no `status: 'cancelled'` in the update.
    expect(mClaimMatchDecision).toHaveBeenCalledWith({
      matchId: "match-1",
      side: "A",
      decision: false,
    });
    expect(mMatchEvent.create).toHaveBeenCalledWith({
      data: {
        matchId: "match-1",
        actorId: "uid-A",
        targetId: "uid-B",
        actionType: "DECLINED",
      },
    });

    const [declineText, declineOptions] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(declineText).toMatch(/main reason/i);
    expect(declineText).toMatch(/text or voice note/i);
    expect(declineOptions).toEqual(
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({
                callback_data: "mdr:match-1:type",
              }),
            ]),
          ]),
        }),
      }),
    );

    // Peer DM must be the neutral nudge, NOT any message that hints
    // at decline (e.g. nothing matching "passed" / "не сложился").
    const peerCalls = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(peerCalls).toHaveLength(1);
    const [peerChatId, peerText] = peerCalls[0]!;
    expect(peerChatId).toBe(1002); // userB
    expect(peerText).toMatch(/your match has already given their answer/i);
    expect(peerText).not.toMatch(/passed|declined|not in/i);
  });

  it("first accept sends BLIND nudge to peer (no 'they accepted' leak)", async () => {
    // Mirror of the decline-blind test for the accept path — the peer
    // must learn ONLY that the actor answered, not what they answered.
    mMatch.findUnique.mockResolvedValueOnce(matchRow());
    mClaimMatchDecision.mockResolvedValueOnce({
      claimed: true,
      status: "proposed",
      acceptedByA: true,
      acceptedByB: null,
    });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:accept:match-1",
      fromId: 1001,
    });

    await handleMatchDecision(ctx);

    const peerCalls = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(peerCalls).toHaveLength(1);
    expect(peerCalls[0]![1]).toMatch(/your match has already given their answer/i);
    // Must not reveal the accept verdict.
    expect(peerCalls[0]![1]).not.toMatch(/mutual|accepted|both/i);
  });

  it("second decider on a peer-declined match: cancels + reveals peer's decline to actor + DMs first-decider", async () => {
    // A declined first (acceptedByA=false). B now taps Accept. We must:
    //   1. Flip status to 'cancelled' (both decisions are in).
    //   2. Tell B their decision was logged (matchAccepted).
    //   3. Reveal A's prior decline to B inline.
    //   4. DM A (the first decider) with the outcome reveal — they'd
    //      seen `matchDeclined` earlier and now learn how it ended.
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ acceptedByA: false, acceptedByB: null }),
    );
    mClaimMatchDecision.mockResolvedValueOnce({
      claimed: true,
      status: "proposed",
      acceptedByA: false,
      acceptedByB: true,
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:accept:match-1",
      fromId: 1002,
    });

    await handleMatchDecision(ctx);

    // Status flipped to cancelled via updateMany guard.
    expect(mMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1", status: "proposed" },
        data: { status: "cancelled" },
      }),
    );

    // Actor (B) gets two replies: matchAccepted + accepted-side support copy.
    const replyTexts = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(replyTexts.some((s: string) => /waiting on the other person/i.test(s))).toBe(true);
    expect(replyTexts.some((s: string) => /your match didn't agree to meet/i.test(s))).toBe(true);
    expect(replyTexts.some((s: string) => /boosted your priority for next Thursday/i.test(s))).toBe(true);

    // The user who accepted despite the peer's earlier decline gets a real
    // priority boost for the next weekly batch.
    expect(mProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "uid-B" },
        data: expect.objectContaining({
          standbyCount: { increment: 1 },
          missedWeeks: { increment: 1 },
          lastMissedAt: expect.any(Date),
        }),
      }),
    );

    // First decider (A) gets DM'd the actor's choice — they accepted.
    const peerSends = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(peerSends).toHaveLength(1);
    expect(peerSends[0]![0]).toBe(1001); // userA telegramId
    expect(peerSends[0]![1]).toMatch(/your match was in/i);
  });

  it("second decline on a peer-accepted match cancels and reveals both ways", async () => {
    // A accepted first. B declines. Match cancels; B sees their decline
    // ack + reveal of A's accept; A gets the accepted-side support DM.
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ acceptedByA: true, acceptedByB: null }),
    );
    mClaimMatchDecision.mockResolvedValueOnce({
      claimed: true,
      status: "proposed",
      acceptedByA: true,
      acceptedByB: false,
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:decline:match-1",
      fromId: 1002,
    });

    await handleMatchDecision(ctx);

    expect(mMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1", status: "proposed" },
        data: { status: "cancelled" },
      }),
    );

    // Actor (B) sees matchDeclined + matchPeerWasAccepted.
    const replyTexts = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(replyTexts.some((s: string) => /main reason/i.test(s))).toBe(true);
    expect(replyTexts.some((s: string) => /your match was in/i.test(s))).toBe(true);

    // First decider (A) accepted, then learns B did not confirm the meeting.
    const peerSends = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(peerSends).toHaveLength(1);
    expect(peerSends[0]![0]).toBe(1001);
    expect(peerSends[0]![1]).toMatch(/your match didn't agree to meet/i);
    expect(peerSends[0]![1]).toMatch(/boosted your priority for next Thursday/i);
    expect(mProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "uid-A" },
        data: expect.objectContaining({
          standbyCount: { increment: 1 },
          missedWeeks: { increment: 1 },
          lastMissedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("second decline after a peer decline stays neutral and does not boost priority", async () => {
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ acceptedByA: false, acceptedByB: null }),
    );
    mClaimMatchDecision.mockResolvedValueOnce({
      claimed: true,
      status: "proposed",
      acceptedByA: false,
      acceptedByB: false,
    });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:decline:match-1",
      fromId: 1002,
    });

    await handleMatchDecision(ctx);

    const replyTexts = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(replyTexts.some((s: string) => /your match passed/i.test(s))).toBe(true);
    expect(replyTexts.some((s: string) => /boosted your priority/i.test(s))).toBe(false);

    const peerSends = (ctx.api.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(peerSends).toHaveLength(1);
    expect(peerSends[0]![1]).toMatch(/your match passed/i);
    expect(mProfile.updateMany).not.toHaveBeenCalled();
  });

  it("quick decline reason saves preset feedback without changing negative constraints", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A", language: "en" });
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({
        acceptedByA: false,
        rejectionReasonA: null,
        rejectionReasonB: null,
      }),
    );

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "mdr:match-1:interests",
      fromId: 1001,
    });

    await handleDeclineReasonCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "match-1" },
      data: { rejectionReasonA: "Preset reason: interests did not match" },
    });
    expect(mMatchEvent.updateMany).toHaveBeenCalledWith({
      where: {
        matchId: "match-1",
        actorId: "uid-A",
        targetId: "uid-B",
        actionType: "DECLINED",
      },
      data: {
        metadata: {
          rejectionReason: "Preset reason: interests did not match",
        },
      },
    });
    expect(mProfile.upsert).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatch(
      /next recommendations/i,
    );
  });

  it("something else decline reason asks for text or voice without saving a placeholder", async () => {
    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "mdr:match-1:other",
      fromId: 1001,
    });

    await handleDeclineReasonCallback(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(mMatch.update).not.toHaveBeenCalled();
    expect(mMatchEvent.updateMany).not.toHaveBeenCalled();
    expect((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatch(
      /text or voice note/i,
    );
  });

  it("ignores double-tap from the same side (own decision is final)", async () => {
    // A already accepted. They tap Decline a second time — must be a
    // no-op: no DB write, no peer DM, no reply.
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ acceptedByA: true, acceptedByB: null }),
    );

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:decline:match-1",
      fromId: 1001,
    });

    await handleMatchDecision(ctx);

    expect(mMatch.update).not.toHaveBeenCalled();
    expect(mMatchEvent.create).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
  });

  it("handleMatchDecision no-ops on already-cancelled matches", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow({ status: "cancelled" }));

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:accept:match-1",
      fromId: 1001,
    });

    await handleMatchDecision(ctx);
    expect(mMatch.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// venue negotiation: scheduled final DM
// ---------------------------------------------------------------------------

describe("venue negotiation finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mMatch.findUnique.mockReset();
    mMatch.update.mockReset();
    mMatch.updateMany.mockReset();
    mPickVenueAtMidpoint.mockReset();
    mMatch.update.mockResolvedValue({ id: "match-venue-1" });
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    mPickVenueAtMidpoint.mockResolvedValue({
      name: "Test Cafe",
      address: "123 Test St",
      googleMapsUri: "https://maps.google.com/?cid=test",
    });
  });

  it("adds a localized Open in Maps URL button to the selected venue, not the midpoint", async () => {
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-venue-1",
      status: "negotiating_venue",
      agreedTime: new Date("2026-05-16T16:00:00.000Z"),
      vibeTextA: "quiet cafe",
      vibeTextB: "quiet cafe",
      vibeLatA: 50.45,
      vibeLngA: 30.52,
      vibeLatB: 50.45,
      vibeLngB: 30.52,
      parsedCategoryA: null,
      parsedCategoryB: null,
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "ru" },
    });
    const api = { sendMessage: vi.fn().mockResolvedValue({}) } as any;

    await tryFinalize(api, "match-venue-1");

    expect(mMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-venue-1", status: "negotiating_venue" },
        data: expect.objectContaining({
          status: "scheduled",
          venueLat: 50.45,
          venueLng: 30.52,
        }),
      }),
    );

    const finalCalls = api.sendMessage.mock.calls.filter((call: unknown[]) => {
      const opts = call[2] as { entities?: unknown[] } | undefined;
      return Array.isArray(opts?.entities);
    });
    expect(finalCalls).toHaveLength(2);

    type MapsButton = { text: string; url: string };
    const getOnlyButton = (call: unknown[]): MapsButton => {
      const opts = call[2] as {
        reply_markup?: { inline_keyboard?: MapsButton[][] };
      };
      expect(opts.reply_markup?.inline_keyboard).toHaveLength(1);
      expect(opts.reply_markup?.inline_keyboard?.[0]).toHaveLength(1);
      return opts.reply_markup!.inline_keyboard![0]![0]!;
    };

    const callA = finalCalls.find((call: unknown[]) => call[0] === 1001);
    const callB = finalCalls.find((call: unknown[]) => call[0] === 1002);
    expect(callA).toBeDefined();
    expect(callB).toBeDefined();

    expect(getOnlyButton(callA!)).toEqual({
      text: "📍 Open in Maps",
      url: "https://maps.google.com/?cid=test",
    });
    expect(getOnlyButton(callB!)).toEqual({
      text: "📍 Открыть в картах",
      url: "https://maps.google.com/?cid=test",
    });
  });

  it("structures the scheduled caption (name/address/blurb) and drops the inlined Maps URL", async () => {
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-venue-1",
      status: "negotiating_venue",
      agreedTime: new Date("2026-05-16T16:00:00.000Z"),
      vibeTextA: "quiet cafe",
      vibeTextB: "quiet cafe",
      vibeLatA: 50.45,
      vibeLngA: 30.52,
      vibeLatB: 50.45,
      vibeLngB: 30.52,
      parsedCategoryA: null,
      parsedCategoryB: null,
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "ru" },
    });
    const api = { sendMessage: vi.fn().mockResolvedValue({}) } as any;

    await tryFinalize(api, "match-venue-1");

    const callA = api.sendMessage.mock.calls.find((call: unknown[]) => {
      const opts = call[2] as { entities?: unknown[] } | undefined;
      return call[0] === 1001 && Array.isArray(opts?.entities);
    })!;
    const caption = callA[1] as string;

    // Structured block: name + full address are present.
    expect(caption).toContain("📍 Test Cafe");
    expect(caption).toContain("123 Test St");
    // The Maps URL is no longer duplicated in the body (it lives on the button).
    expect(caption).not.toContain("http");
    expect(caption).not.toContain("maps.google.com");
    // The blurb line (fallback, since OPENAI_API_KEY is empty in tests) is there.
    expect(caption).toContain("unhurried conversation");
  });

  it("falls back to a Google Maps search URL when the venue has no Places deep-link", async () => {
    mPickVenueAtMidpoint.mockResolvedValueOnce({
      name: "Fallback Cafe",
      address: "123 Test St",
      googleMapsUri: null,
    });
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-venue-1",
      status: "negotiating_venue",
      agreedTime: new Date("2026-05-16T16:00:00.000Z"),
      vibeTextA: "quiet cafe",
      vibeTextB: "quiet cafe",
      vibeLatA: 50.45,
      vibeLngA: 30.52,
      vibeLatB: 50.45,
      vibeLngB: 30.52,
      parsedCategoryA: null,
      parsedCategoryB: null,
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "ru" },
    });
    const api = { sendMessage: vi.fn().mockResolvedValue({}) } as any;

    await tryFinalize(api, "match-venue-1");

    const finalCall = api.sendMessage.mock.calls.find((call: unknown[]) => {
      const opts = call[2] as { entities?: unknown[] } | undefined;
      return call[0] === 1001 && Array.isArray(opts?.entities);
    })!;
    const opts = finalCall[2] as {
      reply_markup?: { inline_keyboard?: Array<Array<{ url: string }>> };
    };
    expect(opts.reply_markup?.inline_keyboard?.[0]?.[0]?.url).toBe(
      "https://maps.google.com/?q=Fallback%20Cafe%2C%20123%20Test%20St",
    );
  });

  it("does not send scheduled cards when another finalizer wins the status CAS", async () => {
    mMatch.updateMany.mockResolvedValueOnce({ count: 0 });
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-venue-1",
      status: "negotiating_venue",
      agreedTime: new Date("2026-05-16T16:00:00.000Z"),
      vibeTextA: "quiet cafe",
      vibeTextB: "quiet cafe",
      vibeLatA: 50.45,
      vibeLngA: 30.52,
      vibeLatB: 50.45,
      vibeLngB: 30.52,
      parsedCategoryA: null,
      parsedCategoryB: null,
      userA: { telegramId: 1001n, language: "en" },
      userB: { telegramId: 1002n, language: "ru" },
    });
    const api = { sendMessage: vi.fn().mockResolvedValue({}) } as any;

    await tryFinalize(api, "match-venue-1");

    const scheduledCards = api.sendMessage.mock.calls.filter((call: unknown[]) => {
      const opts = call[2] as { entities?: unknown[] } | undefined;
      return Array.isArray(opts?.entities);
    });
    expect(scheduledCards).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// negative constraints: pure normaliser + upsert
// ---------------------------------------------------------------------------

describe("negative-constraints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizeReason trims, collapses whitespace, and caps at 240 chars", () => {
    expect(normalizeReason("  too   loud ")).toBe("too loud");
    const long = "a".repeat(500);
    expect(normalizeReason(long).length).toBe(240);
  });

  it("appendNegativeConstraint creates a new list entry when profile is empty", async () => {
    mProfile.findUnique.mockResolvedValueOnce({ negativeConstraints: null });
    mProfile.upsert.mockResolvedValueOnce({});
    await appendNegativeConstraint("uid-A", "not into gym bros");
    expect(mProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ negativeConstraints: "- not into gym bros" }),
      }),
    );
  });

  it("appendNegativeConstraint appends on a new line when profile already has constraints", async () => {
    mProfile.findUnique.mockResolvedValueOnce({ negativeConstraints: "- prior item" });
    mProfile.upsert.mockResolvedValueOnce({});
    await appendNegativeConstraint("uid-A", "loud chewing");
    const call = mProfile.upsert.mock.calls[0]![0] as { update: { negativeConstraints: string } };
    expect(call.update.negativeConstraints).toBe("- prior item\n- loud chewing");
  });
});

// ---------------------------------------------------------------------------
// venue service — stub behavior
// ---------------------------------------------------------------------------

describe("venue service", () => {
  it("localStubVenueClient returns the mapped café when both users share a known domain", async () => {
    const client = localStubVenueClient();
    const v = await client.pick({
      universityDomainA: "stanford.edu",
      universityDomainB: "stanford.edu",
    });
    expect(v.name).toBe("Coupa Café");
  });

  it("localStubVenueClient returns a generic fallback when domain is unknown", async () => {
    const client = localStubVenueClient();
    const v = await client.pick({
      universityDomainA: "nowhere.edu",
      universityDomainB: "nowhere.edu",
    });
    expect(v.name).toBe("Campus Café");
  });

  it("pickVenueForMatch swallows a throwing custom client and falls back", async () => {
    const throwing = {
      async pick() {
        throw new Error("boom");
      },
    };
    const v = await pickVenueForMatch(
      { universityDomainA: "stanford.edu", universityDomainB: "stanford.edu" },
      throwing,
    );
    // Fallback stub returns Stanford entry since domain matches the table.
    expect(v.name).toBe("Coupa Café");
  });
});

// ---------------------------------------------------------------------------
// datetime entity builder
// ---------------------------------------------------------------------------

describe("datetime-entity", () => {
  it("wraps a localized date string with a 📅 affordance as the entity tap target", () => {
    const base = "See you at Coupa Café";
    // 16 May 2026 19:00 Europe/Kyiv = 16:00Z (Kyiv is UTC+3 in May)
    const when = new Date("2026-05-16T16:00:00Z");
    const { text, entity } = buildDateTimeEntity(base, when, "en");

    const slice = text.slice(entity.offset, entity.offset + entity.length);
    // 📅 leads the wrapped tap target so the affordance is unmistakable.
    expect(slice.startsWith("📅 ")).toBe(true);
    // Rendered in Europe/Kyiv with weekday + day + month + 24h time.
    expect(slice).toMatch(/Sat/);
    expect(slice).toMatch(/May/);
    expect(slice).toMatch(/19:00/);

    // Entity carries the unix timestamp (seconds) in `unix_time` per Bot
    // API 9.5 spec for `date_time`. Telegram rejects payloads that use
    // `timestamp` here — see datetime-entity.ts.
    const carried = (entity as unknown as { unix_time?: number }).unix_time;
    expect(carried).toBe(Math.floor(when.getTime() / 1000));
    expect((entity as unknown as { type: string }).type).toBe("date_time");
  });

  it("renders month names in the user's language", () => {
    const when = new Date("2026-05-16T16:00:00Z");
    const baseEn = "x";
    const baseRu = "x";
    const baseUk = "x";

    const en = buildDateTimeEntity(baseEn, when, "en");
    const ru = buildDateTimeEntity(baseRu, when, "ru");
    const uk = buildDateTimeEntity(baseUk, when, "uk");

    const sliceEn = en.text.slice(en.entity.offset, en.entity.offset + en.entity.length);
    const sliceRu = ru.text.slice(ru.entity.offset, ru.entity.offset + ru.entity.length);
    const sliceUk = uk.text.slice(uk.entity.offset, uk.entity.offset + uk.entity.length);

    expect(sliceEn).toContain("May");
    expect(sliceRu).toContain("мая");
    expect(sliceUk).toContain("травня");
  });
});
