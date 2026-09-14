import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Post-date feedback, source by source, against one in-memory match row
 * (A13-M27 + decision 2026-09-08).
 *
 * Each source answers once per side: the form once, the concierge's story once
 * and only onto an empty side. A story told first does not close the form —
 * the rating and the second-date answer come only from there. Every accepted
 * submission runs the paid analysis exactly once, over its own text.
 *
 * The real pipeline runs here (`recordPostDateFeedback`, `submitPostDateFeedback`,
 * `pendingFeedbackFor`, the `record_date_feedback` executor); only the database,
 * the LLM and the constraint writer are stubbed.
 */

vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "k" } }));

interface Row {
  id: string;
  status: string;
  userAId: string;
  userBId: string;
  feedbackByA: string | null;
  feedbackByB: string | null;
  venueFitByA: string | null;
  venueFitReasonsByA: string[];
  agreedTime: Date;
  venueName: string;
  userA: { firstName: string };
  userB: { firstName: string };
}

let row: Row;

function freshRow(): Row {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "completed",
    userAId: "u1",
    userBId: "u2",
    feedbackByA: null,
    feedbackByB: null,
    venueFitByA: null,
    venueFitReasonsByA: [],
    agreedTime: new Date("2026-09-10T18:00:00Z"),
    venueName: "Kavarnia",
    userA: { firstName: "Ada" },
    userB: { firstName: "Boris" },
  };
}

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: async () => ({ id: "u1", language: "en" }) },
    match: {
      findUnique: async () => ({ ...row }),
      findFirst: async () => ({ ...row }),
      // A faithful compare-and-set: the write lands only while the column still
      // holds the value the caller read.
      updateMany: async (args: {
        where: { feedbackByA?: string | null; feedbackByB?: string | null };
        data: Partial<Row>;
      }) => {
        const column = "feedbackByA" in args.where ? "feedbackByA" : "feedbackByB";
        if (row[column] !== args.where[column]) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
      update: async (args: { data: Partial<Row> }) => {
        Object.assign(row, args.data);
        return row;
      },
    },
  },
  Prisma: {},
}));

const callOpenAIJson = vi.fn(async (_prompt: string, _text: string) => ({
  new_negative_constraints: ["smoking"],
}));
vi.mock("./openai.js", () => ({
  callOpenAIJson: (prompt: string, text: string) => callOpenAIJson(prompt, text),
}));
vi.mock("../handlers/matching/negative-constraints.js", () => ({
  appendNegativeConstraint: vi.fn(async () => undefined),
}));
vi.mock("./rematch.js", () => ({ checkRematchEligibility: async () => ({ ok: false }) }));
vi.mock("../handlers/menu/city-switch.js", () => ({ isMarketPending: () => false }));

const { executeAgentTool } = await import("./menu-agent.js");
const { submitPostDateFeedback, pendingFeedbackFor } = await import("./post-date-feedback.js");

const STORY = "It was easy, we talked for three hours and I'd see her again";
const FORM = {
  chemistry: 8,
  wantsSecondDate: "yes" as const,
  text: "",
  venueFit: null,
  venueFitReasons: [],
};

function tellStory() {
  return executeAgentTool(1n, "record_date_feedback", { feedback: STORY });
}

function answerForm() {
  return submitPostDateFeedback({
    userId: "u1",
    matchId: row.id,
    language: "en",
    submission: FORM,
  });
}

beforeEach(() => {
  row = freshRow();
  callOpenAIJson.mockClear();
});

describe("post-date feedback sources", () => {
  it("story, then form: both accepted, the story kept, each analysed once on its own text", async () => {
    expect(JSON.parse((await tellStory()).result).success).toBe(true);
    expect((await pendingFeedbackFor("u1"))?.submitted).toBe(false);

    expect(await answerForm()).toEqual({ ok: true });

    expect(row.feedbackByA?.startsWith("Chemistry (1–10): 8")).toBe(true);
    expect(row.feedbackByA).toContain(STORY);
    expect(callOpenAIJson.mock.calls.map((c) => c[1])).toEqual([
      STORY,
      "Chemistry (1–10): 8\nSecond date?: yes",
    ]);
    expect((await pendingFeedbackFor("u1"))?.submitted).toBe(true);
  });

  it("form twice: the second is refused and not analysed", async () => {
    expect(await answerForm()).toEqual({ ok: true });
    const first = row.feedbackByA;

    expect(await answerForm()).toEqual({ ok: false, error: "already-submitted" });

    expect(row.feedbackByA).toBe(first);
    expect(callOpenAIJson).toHaveBeenCalledTimes(1);
  });

  it("story twice: the second is refused and not analysed", async () => {
    await tellStory();

    const second = JSON.parse((await tellStory()).result);

    expect(second.success).toBe(false);
    expect(row.feedbackByA).toBe(STORY);
    expect(callOpenAIJson).toHaveBeenCalledTimes(1);
  });

  it("form, then story: the story adds nothing and is refused", async () => {
    await answerForm();
    const answered = row.feedbackByA;

    const story = JSON.parse((await tellStory()).result);

    expect(story.success).toBe(false);
    expect(story.instruction).toMatch(/already answered the feedback form/);
    expect(row.feedbackByA).toBe(answered);
    expect(callOpenAIJson).toHaveBeenCalledTimes(1);
  });
});
