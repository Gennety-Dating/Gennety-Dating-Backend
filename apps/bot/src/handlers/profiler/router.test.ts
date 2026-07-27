import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("../../services/profiler.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/profiler.js")>(
    "../../services/profiler.js",
  );
  return {
    PROFILER_SKIP_PREFIX: actual.PROFILER_SKIP_PREFIX,
    recordProfilerAnswer: vi.fn().mockResolvedValue(true),
    recordProfilerSkip: vi.fn().mockResolvedValue(true),
    resolveProfilerCapture: vi.fn(),
    closeProfilerAnswerWindow: vi.fn().mockResolvedValue(false),
  };
});

import { prisma } from "@gennety/db";
import { PROFILER_ANSWER_DEBOUNCE_MS } from "@gennety/shared";
import { profilerRouter } from "./router.js";
import {
  closeProfilerAnswerWindow,
  recordProfilerAnswer,
  recordProfilerSkip,
  resolveProfilerCapture,
} from "../../services/profiler.js";
import type { BotContext } from "../../session.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFind = (prisma.user as unknown as { findUnique: MockFn }).findUnique;
const mAnswer = recordProfilerAnswer as unknown as MockFn;
const mSkip = recordProfilerSkip as unknown as MockFn;
const mCapture = resolveProfilerCapture as unknown as MockFn;
const mCloseWindow = closeProfilerAnswerWindow as unknown as MockFn;

const answerCallbackQuery = vi.fn().mockResolvedValue(true);
const editMessageReplyMarkup = vi.fn().mockResolvedValue(true);

/** Minimal ctx for a plain text message from a completed, idle user. */
function textCtx(text: string, messageId: number, replyToMessageId?: number): BotContext {
  return {
    from: { id: 555 },
    chat: { id: 555 },
    message: {
      text,
      message_id: messageId,
      ...(replyToMessageId ? { reply_to_message: { message_id: replyToMessageId } } : {}),
    },
    api: {},
    session: {
      onboardingStep: "completed",
      matchFlow: "idle",
      menuState: "idle",
      awaitingContextDump: false,
      expectingPhoto: false,
    },
    answerCallbackQuery,
    editMessageReplyMarkup,
  } as unknown as BotContext;
}

/** Any non-Profiler callback — e.g. the user tapping into the main menu. */
function menuTapCtx(): BotContext {
  return {
    from: { id: 555 },
    chat: { id: 555 },
    callbackQuery: { data: "menu:open" },
    api: {},
    session: {
      onboardingStep: "completed",
      matchFlow: "idle",
      menuState: "idle",
      awaitingContextDump: false,
      expectingPhoto: false,
    },
    answerCallbackQuery,
    editMessageReplyMarkup,
  } as unknown as BotContext;
}

function skipCtx(questionId: string): BotContext {
  return {
    from: { id: 555 },
    chat: { id: 555 },
    callbackQuery: { data: `profiler:skip:${questionId}` },
    api: {},
    session: {
      onboardingStep: "completed",
      matchFlow: "idle",
      menuState: "idle",
      awaitingContextDump: false,
      expectingPhoto: false,
    },
    answerCallbackQuery,
    editMessageReplyMarkup,
  } as unknown as BotContext;
}

async function run(ctx: BotContext, next = vi.fn().mockResolvedValue(undefined)) {
  await profilerRouter.middleware()(ctx, next);
  return next;
}

/** Let the debounce elapse and drain the microtasks the flush schedules. */
async function elapseDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(PROFILER_ANSWER_DEBOUNCE_MS + 50);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  mUserFind.mockReset().mockResolvedValue({
    id: "u1",
    profile: { profilerActiveQuestionId: "f_date_spots" },
  });
  mAnswer.mockClear().mockResolvedValue(true);
  mSkip.mockClear().mockResolvedValue(true);
  mCapture.mockReset().mockResolvedValue({ userId: "u1", questionId: "f_date_spots" });
  mCloseWindow.mockClear().mockResolvedValue(false);
  answerCallbackQuery.mockClear();
  editMessageReplyMarkup.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("profiler router — free-text answers", () => {
  it("coalesces a multi-message answer into ONE recorded answer", async () => {
    // The reported bug: each message was consumed as the answer to a *different*
    // question (message 1's reply opens question 2, which message 2 then
    // answers), firing several questions in seconds and mis-attributing text.
    await run(textCtx("люблю кино", 1));
    await run(textCtx("и музыку", 2));
    await run(textCtx("особенно джаз", 3));

    // Nothing recorded while the user is still typing.
    expect(mAnswer).not.toHaveBeenCalled();

    await elapseDebounce();

    expect(mAnswer).toHaveBeenCalledTimes(1);
    expect(mAnswer.mock.calls[0]![1]).toBe("u1");
    expect(mAnswer.mock.calls[0]![2]).toBe("f_date_spots");
    expect(mAnswer.mock.calls[0]![3]).toBe("люблю кино\nи музыку\nособенно джаз");
    // The reaction targets the LAST line the user sent.
    expect(mAnswer.mock.calls[0]![4]).toMatchObject({
      reactionTarget: { chatId: 555, messageId: 3 },
    });
  });

  it("records a single-message answer after the window", async () => {
    await run(textCtx("rooftop cafes", 1));
    await elapseDebounce();

    expect(mAnswer).toHaveBeenCalledTimes(1);
    expect(mAnswer.mock.calls[0]![3]).toBe("rooftop cafes");
  });

  it("swallows the update so the menu agent never sees a Profiler answer", async () => {
    const next = await run(textCtx("cafes", 1));
    expect(next).not.toHaveBeenCalled();
  });

  it("passes text through when no question is active", async () => {
    mCapture.mockResolvedValue(null);

    const next = await run(textCtx("hey", 1));
    await elapseDebounce();

    expect(next).toHaveBeenCalled();
    expect(mAnswer).not.toHaveBeenCalled();
  });

  it("passes text to the menu agent once the question no longer owns the chat", async () => {
    // The reported bug: a question asked hours ago (or before the user went off
    // into the menu) turned "when is my date?" into a Profiler answer, complete
    // with an acknowledge shimmer and the next question. Capture is now denied,
    // so the message reaches the menu agent it was written for.
    mCapture.mockResolvedValue(null);

    const next = await run(textCtx("когда моё свидание?", 1));
    await elapseDebounce();

    expect(mAnswer).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("forwards an explicit reply so a late answer still counts", async () => {
    await run(textCtx("сова", 9, 4));

    expect(mCapture).toHaveBeenCalledWith(555n, { replyToMessageId: 4 });
  });

  it("abandons a half-typed answer when the user runs a command", async () => {
    await run(textCtx("wait let me think", 1));
    await run(textCtx("/menu", 2));
    await elapseDebounce();

    expect(mAnswer).not.toHaveBeenCalled();
  });

  it("closes the capture window when the user runs a command", async () => {
    await run(textCtx("/menu", 1));

    expect(mCloseWindow).toHaveBeenCalledWith(555n);
  });

  it("closes the capture window when the user taps into the menu", async () => {
    // Tapping a button is the clearest signal the conversation moved on — the
    // next thing they type is for the assistant, not for the open question.
    await run(menuTapCtx());

    expect(mCloseWindow).toHaveBeenCalledWith(555n);
  });

  it("does not close the window while the user is answering", async () => {
    await run(textCtx("rooftop cafes", 1));

    expect(mCloseWindow).not.toHaveBeenCalled();
  });
});

describe("profiler router — skip button", () => {
  it("strips the keyboard so the button cannot be tapped twice", async () => {
    await run(skipCtx("f_date_spots"));

    // No reply_markup argument = Telegram drops the keyboard.
    expect(editMessageReplyMarkup).toHaveBeenCalledWith();
    expect(mSkip).toHaveBeenCalledTimes(1);
    expect(mSkip.mock.calls[0]![2]).toBe("f_date_spots");
  });

  it("a skip supersedes a half-typed answer", async () => {
    await run(textCtx("hmm", 1));
    await run(skipCtx("f_date_spots"));
    await elapseDebounce();

    expect(mSkip).toHaveBeenCalledTimes(1);
    expect(mAnswer).not.toHaveBeenCalled();
  });

  it("still records the skip when the keyboard edit fails (old message)", async () => {
    editMessageReplyMarkup.mockRejectedValue(new Error("message is not modified"));

    await run(skipCtx("f_date_spots"));

    expect(mSkip).toHaveBeenCalledTimes(1);
  });
});
