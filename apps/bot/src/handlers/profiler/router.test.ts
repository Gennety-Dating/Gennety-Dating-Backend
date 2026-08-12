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
    recordProfilerRefusal: vi.fn().mockResolvedValue(true),
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
  recordProfilerRefusal,
  recordProfilerSkip,
  resolveProfilerCapture,
} from "../../services/profiler.js";
import type { BotContext } from "../../session.js";
import type { MenuState } from "@gennety/shared";
import { releaseStaleMenuClaim } from "../../services/menu-text-claim.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFind = (prisma.user as unknown as { findUnique: MockFn }).findUnique;
const mAnswer = recordProfilerAnswer as unknown as MockFn;
const mSkip = recordProfilerSkip as unknown as MockFn;
const mCapture = resolveProfilerCapture as unknown as MockFn;
const mCloseWindow = closeProfilerAnswerWindow as unknown as MockFn;
const mRefusal = recordProfilerRefusal as unknown as MockFn;

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
  mRefusal.mockClear().mockResolvedValue(true);
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

describe("profiler router — a refusal is not an answer", () => {
  // The reported defect: "не хочу отвечать" was stored verbatim as the ANSWER
  // to the live question with `skipped: false`, which burns the question for
  // good (answered questions are never re-asked) and feeds the text to the
  // ice-breaker / wingman generators as though it were an interest.
  it("routes a refusal to the skip path, never to recordProfilerAnswer", async () => {
    await run(textCtx("не хочу отвечать", 1));
    await elapseDebounce();

    expect(mAnswer).not.toHaveBeenCalled();
    expect(mRefusal).toHaveBeenCalledTimes(1);
    expect(mRefusal.mock.calls[0]![1]).toBe("u1");
    expect(mRefusal.mock.calls[0]![2]).toBe("f_date_spots");
  });

  // Classification runs on the COALESCED text for the same reason the buffer
  // exists: a refusal split over two messages is one refusal, not one refusal
  // plus one stray answer.
  it("classifies the coalesced text, not the first line", async () => {
    await run(textCtx("не хочу", 1));
    await run(textCtx("отвечать", 2));
    await elapseDebounce();

    expect(mRefusal).toHaveBeenCalledTimes(1);
    expect(mAnswer).not.toHaveBeenCalled();
  });

  it("still records a real answer that merely opens with a refusal phrase", async () => {
    await run(textCtx("не хочу в кино, а вот на концерт хочу", 1));
    await elapseDebounce();

    expect(mRefusal).not.toHaveBeenCalled();
    expect(mAnswer).toHaveBeenCalledTimes(1);
  });

  // A bare "нет" answers a large part of the bank ("do you play any sport?"),
  // so it must stay an answer or real signal is thrown away.
  it("records a bare negative as an answer", async () => {
    await run(textCtx("нет", 1));
    await elapseDebounce();

    expect(mRefusal).not.toHaveBeenCalled();
    expect(mAnswer).toHaveBeenCalledTimes(1);
    expect(mAnswer.mock.calls[0]![3]).toBe("нет");
  });
});

/**
 * Ordering regression: an abandoned menu editor must not eat a Profiler answer.
 *
 * `menuState` is one of the four fields this router reads to decide the chat is
 * idle. Its claim used to be released inside the menu router, which is mounted
 * AFTER this one — so a claim that had expired hours earlier was still set here.
 * The answer was refused, the answer window was closed as a side effect, and the
 * menu router then released the claim and handed the text to the concierge
 * agent: the answer vanished into the agent and the question sat unresolved
 * until the 6 h stall sweep skipped it and paused the rest of the batch.
 *
 * These tests run the release exactly where `bot.ts` runs it — before the
 * router — so they encode the ORDER, which is the thing that was wrong.
 */
describe("profiler router — stale menu claim (bot.ts ordering)", () => {
  function withMenuClaim(text: string, state: MenuState, claimUntil: number | null): BotContext {
    const ctx = textCtx(text, 1);
    ctx.session.menuState = state;
    ctx.session.menuClaimUntil = claimUntil;
    return ctx;
  }

  /** The early middleware from `bot.ts`, verbatim. */
  function botEarlyMiddleware(ctx: BotContext): void {
    releaseStaleMenuClaim(ctx.session, {
      callbackData: ctx.callbackQuery?.data,
      text: ctx.message?.text,
    });
  }

  it("records the answer when the abandoned editor's claim has expired", async () => {
    const ctx = withMenuClaim("комедии", "edit_bio", Date.now() - 60_000);
    botEarlyMiddleware(ctx);

    const next = await run(ctx);
    await elapseDebounce();

    expect(ctx.session.menuState).toBe("idle");
    expect(mAnswer).toHaveBeenCalledTimes(1);
    expect(mAnswer.mock.calls[0]![3]).toBe("комедии");
    // The window must survive: closing it disqualifies the live question from
    // ever being answered by plain text again.
    expect(mCloseWindow).not.toHaveBeenCalled();
    // And the agent never sees it.
    expect(next).not.toHaveBeenCalled();
  });

  it("still leaves a LIVE editor claim alone", async () => {
    // The user really is mid-bio-edit; that text is the bio, not a Profiler
    // answer, and the Profiler must stand down (and close its window).
    const ctx = withMenuClaim("моя новая био", "edit_bio", Date.now() + 60_000);
    botEarlyMiddleware(ctx);

    const next = await run(ctx);
    await elapseDebounce();

    expect(ctx.session.menuState).toBe("edit_bio");
    expect(mAnswer).not.toHaveBeenCalled();
    expect(mCloseWindow).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
});
