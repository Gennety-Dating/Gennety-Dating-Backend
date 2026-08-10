import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}));

const { mockRecord } = vi.hoisted(() => ({
  mockRecord: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../handlers/date/feedback.js", () => ({ recordPostDateFeedback: mockRecord }));

import { prisma } from "@gennety/db";
import {
  composeFeedbackText,
  normaliseFeedback,
  pendingFeedbackFor,
  resolveLanguage,
  submitPostDateFeedback,
  FEEDBACK_MAX_TEXT_LEN,
} from "./post-date-feedback.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findUnique: MockFn;
  findFirst: MockFn;
  update: MockFn;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRecord.mockResolvedValue({ ok: true });
  mMatch.findUnique.mockResolvedValue({ userAId: "uid-A", userBId: "uid-B" });
  mMatch.update.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Normalising a submission
// ---------------------------------------------------------------------------

describe("normaliseFeedback", () => {
  it("accepts the ordinary shape", () => {
    const result = normaliseFeedback({
      chemistry: 7,
      wantsSecondDate: "maybe",
      text: "  nice place  ",
      venueFit: "partly",
      venueFitReasons: ["too_loud"],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        chemistry: 7,
        wantsSecondDate: "maybe",
        text: "nice place",
        venueFit: "partly",
        venueFitReasons: ["too_loud"],
      },
    });
  });

  /**
   * A 0 or an 11 is a client bug, not "close enough to 1". Rounding one into
   * the dataset is worse than a 400 — this form is the only place the product
   * learns whether a date worked.
   */
  it("refuses an out-of-range chemistry rather than clamping it", () => {
    for (const chemistry of [0, 11, -3, Number.NaN, "abc"]) {
      expect(normaliseFeedback({ chemistry, wantsSecondDate: "yes" })).toEqual({
        ok: false,
        error: "bad-chemistry",
      });
    }
  });

  it("refuses a second-date answer the client invented", () => {
    expect(normaliseFeedback({ chemistry: 5, wantsSecondDate: "probably" })).toEqual({
      ok: false,
      error: "bad-second-date",
    });
  });

  /**
   * The opposite rule to the two above, and deliberately so: an empty comment
   * and an unknown chip are both legitimately "nothing said".
   */
  it("coerces the soft fields instead of refusing them", () => {
    const result = normaliseFeedback({
      chemistry: 5,
      wantsSecondDate: "no",
      venueFit: "sideways",
      venueFitReasons: ["too_loud", "made_up", "too_loud", "wrong_vibe", "route_unfair", "accessibility"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe("");
    expect(result.value.venueFit).toBeNull();
    // Deduped, unknown dropped, capped at three.
    expect(result.value.venueFitReasons).toEqual(["too_loud", "wrong_vibe", "route_unfair"]);
  });

  it("truncates an over-long comment rather than refusing it", () => {
    const result = normaliseFeedback({
      chemistry: 5,
      wantsSecondDate: "yes",
      text: "x".repeat(FEEDBACK_MAX_TEXT_LEN + 500),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toHaveLength(FEEDBACK_MAX_TEXT_LEN);
  });
});

describe("resolveLanguage", () => {
  it("prefers an explicit valid hint, then the profile, then English", () => {
    expect(resolveLanguage("uk", "ru")).toBe("uk");
    expect(resolveLanguage("klingon", "ru")).toBe("ru");
    expect(resolveLanguage(undefined, null)).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// Composing the blob the analyst reads
// ---------------------------------------------------------------------------

describe("composeFeedbackText", () => {
  it("writes the headers in the user's own language", () => {
    const text = composeFeedbackText({
      text: "было здорово",
      chemistry: 9,
      wantsSecondDate: "yes",
      language: "ru",
    });
    expect(text).toContain("Химия (1–10): 9");
    expect(text).toContain("да");
    expect(text).toContain("было здорово");
  });

  it("omits the notes line entirely when nothing was written", () => {
    const text = composeFeedbackText({
      text: "",
      chemistry: 4,
      wantsSecondDate: "no",
      language: "en",
    });
    expect(text.split("\n")).toHaveLength(2);
    expect(text).not.toContain("Notes");
  });
});

// ---------------------------------------------------------------------------
// Submitting
// ---------------------------------------------------------------------------

describe("submitPostDateFeedback", () => {
  const submission = {
    chemistry: 8,
    wantsSecondDate: "yes" as const,
    text: "good",
    venueFit: "yes" as const,
    venueFitReasons: [],
  };

  it("passes the composed blob to the shared pipeline", async () => {
    const result = await submitPostDateFeedback({
      userId: "uid-A",
      matchId: "m-1",
      language: "en",
      submission,
    });
    expect(result).toEqual({ ok: true });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "uid-A", matchId: "m-1", language: "en" }),
    );
    expect(mockRecord.mock.calls[0]![0].text).toContain("Chemistry (1–10): 8");
  });

  it("writes the venue verdict on the actor's own side", async () => {
    await submitPostDateFeedback({ userId: "uid-B", matchId: "m-1", language: "en", submission });
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m-1" },
      data: { venueFitByB: "yes", venueFitReasonsByB: [] },
    });
  });

  /**
   * The venue verdict is the lesser half of the answer. Writing it against a
   * submission the pipeline rejected would leave a row claiming a verdict
   * about a date nobody reviewed.
   */
  it("writes no venue verdict when the pipeline refuses", async () => {
    mockRecord.mockResolvedValue({ ok: false, reason: "wrong-state" });
    const result = await submitPostDateFeedback({
      userId: "uid-A",
      matchId: "m-1",
      language: "en",
      submission,
    });
    expect(result).toEqual({ ok: false, error: "wrong-state" });
    expect(mMatch.update).not.toHaveBeenCalled();
  });

  it("skips the venue write entirely when nothing was said about the venue", async () => {
    await submitPostDateFeedback({
      userId: "uid-A",
      matchId: "m-1",
      language: "en",
      submission: { ...submission, venueFit: null },
    });
    expect(mMatch.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Discovery — the half with no Telegram equivalent
// ---------------------------------------------------------------------------

describe("pendingFeedbackFor", () => {
  const row = {
    id: "m-1",
    agreedTime: new Date("2026-08-10T18:00:00.000Z"),
    venueName: "Kavarnia",
    userAId: "uid-A",
    userBId: "uid-B",
    feedbackByA: null,
    feedbackByB: "already said",
    userA: { firstName: "Ada" },
    userB: { firstName: "Boris" },
  };

  it("names the partner from the caller's own side", async () => {
    mMatch.findFirst.mockResolvedValue(row);
    const forA = await pendingFeedbackFor("uid-A");
    expect(forA?.partnerFirstName).toBe("Boris");
    expect(forA?.submitted).toBe(false);

    const forB = await pendingFeedbackFor("uid-B");
    expect(forB?.partnerFirstName).toBe("Ada");
    expect(forB?.submitted).toBe(true);
  });

  /**
   * The gate is `feedbackPromptedAt`, not `completed` alone: asking before the
   * product has decided to ask would surface the form while one of them may
   * still be at the table.
   */
  it("only looks at dates the lifecycle has already prompted", async () => {
    mMatch.findFirst.mockResolvedValue(null);
    await pendingFeedbackFor("uid-A");
    expect(mMatch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "completed",
          feedbackPromptedAt: { not: null },
        }),
      }),
    );
  });

  it("is null when nothing is owed, which is the ordinary state", async () => {
    mMatch.findFirst.mockResolvedValue(null);
    expect(await pendingFeedbackFor("uid-A")).toBeNull();
  });

  it("is null for a row with no agreed time rather than inventing one", async () => {
    mMatch.findFirst.mockResolvedValue({ ...row, agreedTime: null });
    expect(await pendingFeedbackFor("uid-A")).toBeNull();
  });
});
