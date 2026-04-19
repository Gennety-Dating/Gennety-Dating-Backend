import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION } from "@gennety/shared";

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
    },
    match: {
      findUnique: vi.fn(),
      update: vi.fn(),
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
    MESSAGE_EFFECT_MATCH_ID: "5104841245755180586",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
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

import { prisma } from "@gennety/db";
import { handleMatchDecision } from "./decision.js";
import { buildMatchKeyboard } from "./pitch.js";
import { appendNegativeConstraint, normalizeReason } from "./negative-constraints.js";
import { startScheduling } from "./scheduler.js";
import {
  buildCandidateSql,
  preferenceToGenderFilter,
  explicitScore,
  cosineSimilarity,
  visualScore,
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
import { localStubVenueClient, pickVenueForMatch } from "../../services/venue.js";
import { buildDateTimeEntity } from "../../services/datetime-entity.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn; update: MockFn; updateMany: MockFn };
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mProfile = prisma.profile as unknown as { findUnique: MockFn; upsert: MockFn };

function createCtx(overrides: {
  session?: Partial<SessionData>;
  callbackData?: string;
  messageText?: string;
  fromId?: number;
}) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    pendingPhotos: [],
    visualVotes: [],
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
    // Must enforce the hyper-local rule.
    expect(sql).toMatch(/university_domain\s*=\s*\$3/);
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
    visualVector: [0.8, 0.6, 0.5, 0.7, 0.4, 0.9],
    socialEnergy: "ambivert",
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
    visualVector: [0.7, 0.5, 0.6, 0.8, 0.3, 0.85],
    socialEnergy: "extrovert",
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

describe("visualScore", () => {
  it("returns 0 when either vector is empty", () => {
    expect(visualScore([], [1, 2])).toBe(0);
    expect(visualScore([1, 2], [])).toBe(0);
  });

  it("returns high similarity for similar visual vectors", () => {
    const a = [0.8, 0.6, 0.5, 0.7, 0.4, 0.9];
    const b = [0.7, 0.5, 0.6, 0.8, 0.3, 0.85];
    expect(visualScore(a, b)).toBeGreaterThan(0.9);
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
      visualVector: [0.8, 0.6, 0.5, 0.7, 0.4, 0.9],
      psychologicalSummary: "Warm ambivert who loves philosophy and jazz",
    });

    // Candidate B: better embedding but has penalty-triggering traits
    const penaltyCandidate = makeCandidate({
      userId: "penalty",
      distance: 0.2, // better embedding distance
      visualVector: [0.1, 0.1, 0.1, 0.1, 0.1, 0.1], // bad visual match
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
      visualVector: [],
      psychologicalSummary: "Arrogant and dismissive know-it-all",
    });

    const result = scoreCandidate(seeker, candidate);
    expect(result.score).toBeLessThan(0);
  });

  it("breakdown contains all four sub-scores", () => {
    const result = scoreCandidate(makeSeeker(), makeCandidate());
    expect(result.breakdown).toHaveProperty("explicit");
    expect(result.breakdown).toHaveProperty("visual");
    expect(result.breakdown).toHaveProperty("research");
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

// ---------------------------------------------------------------------------
// decision handler: Accept / Decline / rejection reason
// ---------------------------------------------------------------------------

describe("matching decision flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mMatch.update.mockResolvedValue({ id: "match-1", acceptedByA: null, acceptedByB: null });
    mMatch.updateMany.mockResolvedValue({ count: 0 });
    mUser.findUnique.mockResolvedValue({ id: "uid-A" });
  });

  it("accept from userA sets acceptedByA=true and stays pending when B not yet accepted", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow());
    mMatch.update.mockResolvedValueOnce({ id: "match-1", acceptedByA: true, acceptedByB: null });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:accept:match-1",
      fromId: 1001,
    });

    await handleMatchDecision(ctx);

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "match-1" }, data: { acceptedByA: true } }),
    );
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
    mMatch.update
      .mockResolvedValueOnce({ id: "match-1", acceptedByA: true, acceptedByB: true }); // set acceptedByB
    mMatch.updateMany.mockResolvedValueOnce({ count: 1 }); // atomic status -> negotiating

    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:accept:match-1",
      fromId: 1002,
    });

    await handleMatchDecision(ctx);

    const calls = mMatch.update.mock.calls.map((c) => c[0]);
    expect(calls.some((c) => (c.data as { acceptedByB?: boolean }).acceptedByB === true)).toBe(true);
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

  it("decline from userA cancels the match and notifies the peer (no session flag)", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow());

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: "match:decline:match-1",
      fromId: 1001,
    });

    await handleMatchDecision(ctx);

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1" },
        data: { acceptedByA: false, status: "cancelled" },
      }),
    );
    // Rejection reason is now collected conversationally by the menu agent
    // via `record_rejection_feedback`; no session flag is set here.
    expect(ctx.api.sendMessage).toHaveBeenCalled();
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
  it("produces a date_time entity whose offset+length cover the placeholder", () => {
    const base = "See you at Coupa Café";
    const when = new Date("2026-05-01T18:00:00Z");
    const { text, entity } = buildDateTimeEntity(base, when);

    // The text must contain the base + the placeholder at the entity slice.
    const slice = text.slice(entity.offset, entity.offset + entity.length);
    expect(slice.length).toBeGreaterThan(0);

    // Entity carries a unix timestamp in seconds (not ms) inside the
    // `date_time` extension — assert round-trip via the `as any` escape.
    const carried = (entity as unknown as { timestamp?: number }).timestamp;
    expect(carried).toBe(Math.floor(when.getTime() / 1000));
    expect((entity as unknown as { type: string }).type).toBe("date_time");
  });
});
