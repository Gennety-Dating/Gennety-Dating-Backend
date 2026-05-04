import { beforeEach, describe, expect, it, vi } from "vitest";

const reportCreate = vi.fn();
const userFindUnique = vi.fn();
const matchFindUnique = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    match: { findUnique: matchFindUnique },
    report: { findUnique: vi.fn(), create: reportCreate },
    $transaction: vi.fn(),
  },
}));

vi.mock("@gennety/shared", () => ({
  t: vi.fn((_lang: string, key: string) => key),
  parseReportTriagePrompt: vi.fn(() => "triage-prompt"),
}));

const callOpenAIJson = vi.fn();
vi.mock("../../services/openai.js", () => ({
  callOpenAIJson,
}));

const applyReportAction = vi.fn();
const notifyReportedUser = vi.fn();
vi.mock("../../services/moderation.js", () => ({
  applyReportAction,
  notifyReportedUser,
}));

const { handleReportText } = await import("./report.js");

describe("handleReportText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindUnique.mockResolvedValue({ id: "reporter-1" });
    matchFindUnique.mockResolvedValue({
      id: "match-1",
      userAId: "reporter-1",
      userBId: "reported-1",
    });
    reportCreate.mockResolvedValue({});
  });

  it("queues manual review when LLM triage is unavailable instead of downgrading to Tier 1", async () => {
    callOpenAIJson.mockRejectedValueOnce(new Error("openai down"));

    const ctx = {
      from: { id: 12345 },
      message: { text: "He threatened me after the date." },
      session: {
        language: "en",
        matchFlow: "awaiting_report_details",
        activeMatchId: "match-1",
      },
      api: {},
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleReportText(ctx);

    expect(reportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tier: 3,
        adminReviewed: false,
      }),
    });
    expect(applyReportAction).not.toHaveBeenCalled();
    expect(notifyReportedUser).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith("reportThanksT3");
  });
});
