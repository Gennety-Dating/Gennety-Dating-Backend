import { beforeEach, describe, expect, it, vi } from "vitest";

const reportFindUnique = vi.fn();
const reportCreate = vi.fn();
const userFindUnique = vi.fn();
const matchFindUnique = vi.fn();
const transactionMock = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    match: { findUnique: matchFindUnique },
    report: { findUnique: reportFindUnique, create: reportCreate },
    $transaction: transactionMock,
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

const {
  handleReportOpen,
  handleReportCategory,
  handleReportSkip,
  handleReportText,
} = await import("./report.js");

describe("structured report flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindUnique.mockResolvedValue({ id: "reporter-1" });
    matchFindUnique.mockResolvedValue({
      id: "match-1",
      userAId: "reporter-1",
      userBId: "reported-1",
    });
    reportFindUnique.mockResolvedValue(null);
    reportCreate.mockResolvedValue({});
    applyReportAction.mockResolvedValue({ kind: "tier2_warning", strikes: 1 });
    notifyReportedUser.mockResolvedValue(undefined);
    transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
      cb({
        report: { create: reportCreate },
        user: { update: vi.fn() },
        match: { updateMany: vi.fn() },
      }),
    );
  });

  it("moves into optional-details mode after a structured category tap", async () => {
    const ctx = {
      from: { id: 12345 },
      callbackQuery: { data: "rc:match-1:spam_or_fraud" },
      session: {
        language: "en",
        matchFlow: "idle",
        activeMatchId: null,
        pendingReportCategory: null,
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleReportCategory(ctx);

    expect(ctx.session.matchFlow).toBe("awaiting_report_details");
    expect(ctx.session.activeMatchId).toBe("match-1");
    expect(ctx.session.pendingReportCategory).toBe("spam_or_fraud");
    expect(ctx.reply).toHaveBeenCalledWith(
      "reportDetailAsk",
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: [[expect.objectContaining({ callback_data: "rs:match-1" })]],
        }),
      }),
    );
  });

  it("keeps report category callback_data under Telegram's 64-byte limit with UUID ids", async () => {
    const uuid = "22b9c76f-8cb5-4669-bba4-00b3ce408cb1";
    const ctx = {
      from: { id: 12345 },
      callbackQuery: { data: `report:open:${uuid}` },
      session: {
        language: "en",
        matchFlow: "idle",
        activeMatchId: null,
        pendingReportCategory: null,
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleReportOpen(ctx);

    const [, options] = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const callbacks = options.reply_markup.inline_keyboard
      .flat()
      .map((b: { callback_data?: string }) => b.callback_data)
      .filter((data: string | undefined): data is string => Boolean(data));

    expect(callbacks).toContain(`rc:${uuid}:inappropriate_profile`);
    callbacks.forEach((data: string) =>
      expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64),
    );
  });

  it("submits a category-only skip report without needing free text", async () => {
    const ctx = {
      from: { id: 12345 },
      callbackQuery: { data: "rs:match-1" },
      session: {
        language: "en",
        matchFlow: "awaiting_report_details",
        activeMatchId: "match-1",
        pendingReportCategory: "unsafe_red_flag",
      },
      api: {},
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleReportSkip(ctx);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(reportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rawText: "Category: Unsafe / red flag",
        tier: 3,
        adminReviewed: false,
      }),
    });
    expect(applyReportAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 3,
        reporterUserId: "reporter-1",
        reportedUserId: "reported-1",
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();
    expect(ctx.session.pendingReportCategory).toBeNull();
    expect(ctx.reply).toHaveBeenCalledWith("reportThanksT3");
  });

  it("uses the category as a severity floor when the LLM would downgrade the report", async () => {
    callOpenAIJson.mockResolvedValueOnce({
      tier: 1,
      reason_summary: "Unclassifiable report",
    });

    const ctx = {
      from: { id: 12345 },
      message: { text: "These photos were clearly edited and misleading." },
      session: {
        language: "en",
        matchFlow: "awaiting_report_details",
        activeMatchId: "match-1",
        pendingReportCategory: "fake_photos",
      },
      api: {},
      reply: vi.fn().mockResolvedValue(undefined),
    } as any;

    await handleReportText(ctx);

    expect(reportCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rawText:
          "Category: Fake or misleading photos\nDetails: These photos were clearly edited and misleading.",
        tier: 2,
        adminReviewed: true,
      }),
    });
    expect(applyReportAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 2,
        reasonSummary: "Misleading profile photos",
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(ctx.reply).toHaveBeenCalledWith("reportThanksT2");
  });

  it("queues manual review when 'other' has details but triage is unavailable", async () => {
    callOpenAIJson.mockRejectedValueOnce(new Error("openai down"));

    const ctx = {
      from: { id: 12345 },
      message: { text: "He threatened me after the date." },
      session: {
        language: "en",
        matchFlow: "awaiting_report_details",
        activeMatchId: "match-1",
        pendingReportCategory: "other",
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
