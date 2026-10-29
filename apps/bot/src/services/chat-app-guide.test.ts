import { beforeEach, describe, expect, it, vi } from "vitest";
import { SUPPORTED_LANGUAGES } from "@gennety/shared";

/**
 * The «how the app works» card (decision journal 2026-10-29): the step a
 * person is on, the card in every language, and the stored JSON read back.
 * The card inside a chat turn is tested in `chat-agent-guide.test.ts`.
 */

const env = { MORNING_AFTER_ENABLED: true };
vi.mock("../config.js", () => ({ env }));

const USER = "11111111-1111-4111-8111-111111111111";
const PARTNER = "22222222-2222-4222-8222-222222222222";

let live: unknown[] = [];
let owing: unknown = null;
vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findMany: async () => live,
      findFirst: async () => owing,
    },
  },
}));
let morningPending = false;
vi.mock("./morning-after.js", () => ({
  pendingMorningAfterFor: async () => (morningPending ? { matchId: "m" } : null),
}));

const {
  appGuideNote,
  appGuideToolResult,
  appGuideView,
  buildAppGuide,
  dropTimeLabel,
  guideStageOf,
  loadGuideStage,
  readAppGuide,
  GUIDE_STEP_KEYS,
} = await import("./chat-app-guide.js");

const NOW = new Date("2026-10-29T12:00:00Z");

function match(over: Record<string, unknown>) {
  return {
    status: "proposed",
    userAId: USER,
    userBId: PARTNER,
    acceptedByA: null,
    acceptedByB: null,
    agreedTime: null,
    feedbackPromptedAt: null,
    feedbackByA: null,
    feedbackByB: null,
    createdAt: NOW,
    ...over,
  };
}

beforeEach(() => {
  live = [];
  owing = null;
  morningPending = false;
});

describe("guideStageOf", () => {
  it("maps every canvas state onto one of the five steps", () => {
    expect(guideStageOf("IDLE_EXPLORING", false)).toBe("match");
    expect(guideStageOf("DROP_PENDING_DECISION", false)).toBe("blind");
    expect(guideStageOf("LOGISTICS_SCHEDULING", false)).toBe("plan");
    for (const s of ["DATE_SCHEDULED", "DATE_RADAR_ACTIVE", "DATE_BUMP_PENDING", "DATE_IN_PROGRESS"] as const) {
      expect(guideStageOf(s, false)).toBe("date");
    }
    expect(guideStageOf("POST_DATE_FEEDBACK", false)).toBe("morning");
  });

  it("a morning-after question still waiting puts an idle person on «morning»", () => {
    expect(guideStageOf("IDLE_EXPLORING", true)).toBe("morning");
    // …but never pulls someone out of a live decision.
    expect(guideStageOf("DROP_PENDING_DECISION", true)).toBe("blind");
  });
});

describe("loadGuideStage", () => {
  it("no match at all — waiting for the evening drop", async () => {
    expect(await loadGuideStage(USER, NOW)).toBe("match");
  });

  it("a pitch they have not answered — the blind decision", async () => {
    live = [match({})];
    expect(await loadGuideStage(USER, NOW)).toBe("blind");
  });

  it("both said yes, time and place still open — the ticket step", async () => {
    live = [match({ status: "negotiating", acceptedByA: true, acceptedByB: true })];
    expect(await loadGuideStage(USER, NOW)).toBe("plan");
  });

  it("a scheduled date tomorrow — the date step, from either side", async () => {
    live = [match({ status: "scheduled", acceptedByA: true, acceptedByB: true, agreedTime: new Date("2026-10-30T17:00:00Z") })];
    expect(await loadGuideStage(USER, NOW)).toBe("date");
    expect(await loadGuideStage(PARTNER, NOW)).toBe("date");
  });

  it("a finished date still owing feedback — the morning step", async () => {
    owing = match({
      status: "completed",
      acceptedByA: true,
      acceptedByB: true,
      agreedTime: new Date("2026-10-27T17:00:00Z"),
      feedbackPromptedAt: new Date("2026-10-28T17:00:00Z"),
    });
    expect(await loadGuideStage(USER, NOW)).toBe("morning");
  });

  it("idle, but the morning-after question waits — the morning step", async () => {
    morningPending = true;
    expect(await loadGuideStage(USER, NOW)).toBe("morning");
  });
});

describe("the card", () => {
  it("five steps in the loop's order, every language, no key left untranslated", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const guide = buildAppGuide(lang, "blind", "18:00");
      expect(guide.steps.map((s) => s.key)).toEqual([...GUIDE_STEP_KEYS]);
      expect(guide.steps[0]!.title).toBe("18:00");
      for (const step of guide.steps) {
        expect(step.title).not.toMatch(/^guide/);
        expect(step.line).not.toMatch(/^guide/);
        expect(step.line.length).toBeGreaterThan(0);
      }
      expect(guide.hereLabel).not.toMatch(/^guide/);
    }
    expect(buildAppGuide("ru", "match", "18:00").hereLabel).toBe("ты здесь");
  });

  it("the first title is the drop time the batch cron runs on", () => {
    expect(dropTimeLabel("0 18 * * *")).toBe("18:00");
    expect(dropTimeLabel("5 9 * * 1,3")).toBe("09:05");
  });

  it("round-trips through the stored JSON; anything else is not a guide", () => {
    const guide = buildAppGuide("en", "date", "18:00");
    const stored = JSON.parse(JSON.stringify(guide));
    expect(readAppGuide(stored)).toEqual(guide);
    expect(appGuideView(guide)).toEqual({ steps: guide.steps, here: "date", hereLabel: guide.hereLabel });
    expect(readAppGuide({ kind: "change_offer", question: "?" })).toBeNull();
    expect(readAppGuide({ kind: "app_guide", steps: [] })).toBeNull();
    expect(readAppGuide({ ...stored, here: "nowhere" })!.here).toBeNull();
    expect(readAppGuide(null)).toBeNull();
  });

  it("tells the model where they are and forbids a Help button", () => {
    const result = JSON.parse(appGuideToolResult(buildAppGuide("ru", "plan", "18:00")));
    expect(result).toMatchObject({ success: true, here: "plan" });
    expect(result.instruction).toContain("do not mention a Help screen");
    expect(appGuideNote(buildAppGuide("ru", "plan", "18:00"))).toContain("«here» on plan");
  });
});
