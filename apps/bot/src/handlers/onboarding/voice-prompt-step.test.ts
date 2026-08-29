import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

process.env.VOICE_PROMPT_ENABLED = "true";

vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

vi.mock("../../services/voice-prompt.js", () => ({
  ingestTelegramVoicePrompt: vi.fn(),
  deleteVoicePrompt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/onboarding-collector.js", () => ({
  markOnboardingField: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/onboarding-agent.js", () => ({
  runAgentTurn: vi.fn().mockResolvedValue({ reply: "", onboardingComplete: false }),
}));

vi.mock("../../services/ai-stream.js", () => ({
  runStatusSequence: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import { DEFAULT_SESSION, type SessionData } from "@gennety/shared";
import { deleteVoicePrompt, ingestTelegramVoicePrompt } from "../../services/voice-prompt.js";
import { markOnboardingField } from "../../services/onboarding-collector.js";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import {
  ONBOARDING_VOICE_PROMPT_KEEP_CALLBACK,
  voicePromptRouter,
} from "./voice-prompt.js";
import { replyPanelMarkupFor } from "../../services/reply-panel.js";
import type { BotContext } from "../../session.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFind = (prisma.user as unknown as { findUnique: MockFn }).findUnique;
const mIngest = ingestTelegramVoicePrompt as unknown as MockFn;
const mDelete = deleteVoicePrompt as unknown as MockFn;
const mMark = markOnboardingField as unknown as MockFn;
const mAgent = runAgentTurn as unknown as MockFn;

const CHAT = 4242;

function api() {
  return {
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };
}

function waitingSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    ...DEFAULT_SESSION,
    onboardingStep: "conversational",
    expectingVoicePrompt: true,
    replyPanel: "voice",
    ...overrides,
  } as SessionData;
}

/** Replies the handler made, in order, as `[text, options]`. */
type Reply = [string, Record<string, unknown> | undefined];

function baseCtx(session: SessionData, replies: Reply[], sentIds: number[]) {
  const next = sentIds.length ? sentIds : [901];
  let i = 0;
  return {
    from: { id: 77 },
    chat: { id: CHAT },
    session,
    api: api(),
    answerCallbackQuery: vi.fn().mockResolvedValue(true),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    reply: vi.fn(async (text: string, options?: Record<string, unknown>) => {
      replies.push([text, options]);
      return { message_id: next[Math.min(i++, next.length - 1)]! };
    }),
  };
}

/**
 * grammY's `on(...)` filters read `ctx.update`, while the handlers read
 * `ctx.message` / `ctx.callbackQuery` — on a real Context the second is a getter
 * over the first. A hand-built ctx has to carry both, or the filter matches
 * nothing and every one of these tests passes for the wrong reason.
 */
function withUpdate(ctx: Record<string, unknown>, update: Record<string, unknown>) {
  return { ...ctx, update: { update_id: 1, ...update } } as unknown as BotContext;
}

function voiceCtx(session: SessionData, replies: Reply[], sentIds: number[] = []) {
  const message = {
    message_id: 10,
    chat: { id: CHAT, type: "private" },
    from: { id: 77 },
    voice: { file_id: "f", duration: 15 },
  };
  return withUpdate({ ...baseCtx(session, replies, sentIds), message }, { message });
}

function textCtx(session: SessionData, text: string, replies: Reply[]) {
  const message = {
    message_id: 11,
    chat: { id: CHAT, type: "private" },
    from: { id: 77 },
    text,
  };
  return withUpdate({ ...baseCtx(session, replies, []), message }, { message });
}

function tapCtx(session: SessionData, replies: Reply[]) {
  const callbackQuery = {
    id: "cb",
    from: { id: 77 },
    chat_instance: "ci",
    data: ONBOARDING_VOICE_PROMPT_KEEP_CALLBACK,
  };
  return withUpdate(
    { ...baseCtx(session, replies, []), callbackQuery },
    { callback_query: callbackQuery },
  );
}

async function run(ctx: BotContext): Promise<boolean> {
  let fellThrough = false;
  await voicePromptRouter.middleware()(ctx, async () => {
    fellThrough = true;
  });
  return fellThrough;
}

beforeEach(() => {
  vi.clearAllMocks();
  mUserFind.mockResolvedValue({ id: "user-1" });
  mIngest.mockResolvedValue({ kind: "saved" });
  mAgent.mockResolvedValue({ reply: "", onboardingComplete: false });
});
afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The recording is no longer the acceptance (founder decision, DECISIONS.md)
// ---------------------------------------------------------------------------
describe("voice prompt — review", () => {
  it("does not end the step on an accepted recording", async () => {
    const session = waitingSession();
    const replies: Reply[] = [];

    await run(voiceCtx(session, replies));

    // The claim outliving the clip is what lets a re-record be re-recorded —
    // and what keeps `voiceHandler` from mining it into the fact collector.
    expect(session.expectingVoicePrompt).toBe(true);
    expect(mMark).not.toHaveBeenCalled();
    expect(mAgent).not.toHaveBeenCalled();
  });

  it("offers exactly one way to keep it, and remembers which card carries it", async () => {
    const session = waitingSession();
    const replies: Reply[] = [];

    await run(voiceCtx(session, replies, [555]));

    const [, options] = replies[0]!;
    const keyboard = (options?.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    expect(keyboard.flat()).toHaveLength(1);
    expect(keyboard[0]![0]!.callback_data).toBe(ONBOARDING_VOICE_PROMPT_KEEP_CALLBACK);
    expect(session.voicePromptCardMsgId).toBe(555);
  });

  it("retires the previous card when a second recording replaces the first", async () => {
    // Two live "keep" buttons would offer to keep two recordings, and only the
    // newest one exists — the row is overwritten, not appended.
    const session = waitingSession({ voicePromptCardMsgId: 555 });
    const replies: Reply[] = [];
    const ctx = voiceCtx(session, replies, [556]);

    await run(ctx);

    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(CHAT, 555, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(session.voicePromptCardMsgId).toBe(556);
  });

  it("keeps the step open on a rejection, and re-offers the panel with it", async () => {
    mIngest.mockResolvedValue({ kind: "rejected", reason: "voice_too_short" });
    const session = waitingSession({ replyPanel: null });
    const replies: Reply[] = [];

    await run(voiceCtx(session, replies));

    expect(session.expectingVoicePrompt).toBe(true);
    // Self-healing: the panel is the only way out of this step, so a session
    // that somehow lost it must not leave the user in front of a dead end.
    expect(replies[0]![1]?.reply_markup).toMatchObject({ is_persistent: true });
  });

  it("finishes the step on the keep tap", async () => {
    const session = waitingSession({ voicePromptCardMsgId: 555 });
    const replies: Reply[] = [];

    await run(tapCtx(session, replies));

    expect(session.expectingVoicePrompt).toBe(false);
    expect(session.voicePromptCardMsgId).toBe(null);
    expect(mMark).toHaveBeenCalledWith(77n, "voice_prompt", false);
    expect(mDelete).not.toHaveBeenCalled();
    expect(mAgent).toHaveBeenCalled();
  });

  it("ignores a keep tap on a step that is already resolved", async () => {
    // The card survives the step, so a late tap must not resume the collector
    // a second time.
    const session = waitingSession({ expectingVoicePrompt: false });
    const replies: Reply[] = [];

    await run(tapCtx(session, replies));

    expect(mMark).not.toHaveBeenCalled();
    expect(mAgent).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The panel means "no voice note", not "no MORE voice notes"
// ---------------------------------------------------------------------------
describe("voice prompt — the panel tap", () => {
  const label = (
    replyPanelMarkupFor("voice", "en").reply_markup as { keyboard: { text: string }[][] }
  ).keyboard[0]![0]!.text;

  it("deletes a recording already saved in this step", async () => {
    const session = waitingSession({ voicePromptCardMsgId: 555 });
    const replies: Reply[] = [];

    await run(textCtx(session, label, replies));

    expect(mDelete).toHaveBeenCalledWith("user-1");
    expect(mMark).toHaveBeenCalledWith(77n, "voice_prompt", true);
    expect(session.expectingVoicePrompt).toBe(false);
  });

  it("does not go looking for a recording that was never made", async () => {
    const session = waitingSession();
    const replies: Reply[] = [];

    await run(textCtx(session, label, replies));

    expect(mDelete).not.toHaveBeenCalled();
    expect(mUserFind).not.toHaveBeenCalled();
    expect(mMark).toHaveBeenCalledWith(77n, "voice_prompt", true);
  });

  it("removes the tap's own message so the label is not read as speech", async () => {
    const session = waitingSession();
    const replies: Reply[] = [];
    const ctx = textCtx(session, label, replies);

    await run(ctx);

    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(CHAT, 11);
  });

  it("claims the tap before the fact collector can mine it as an answer", async () => {
    const session = waitingSession();
    const fellThrough = await run(textCtx(session, ` ${label} `, []));

    expect(fellThrough).toBe(false);
  });

  it("passes ordinary text through untouched", async () => {
    const session = waitingSession();
    const replies: Reply[] = [];

    const fellThrough = await run(textCtx(session, "actually let me think", replies));

    expect(fellThrough).toBe(true);
    expect(session.expectingVoicePrompt).toBe(true);
    expect(replies).toHaveLength(0);
  });

  it("passes the label through when the step is not waiting", async () => {
    const session = waitingSession({ expectingVoicePrompt: false });

    expect(await run(textCtx(session, label, []))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The invariant: whatever ends the step also takes the panel down with it
// ---------------------------------------------------------------------------
describe("voice prompt — the exit carries the panel teardown", () => {
  const label = (
    replyPanelMarkupFor("voice", "en").reply_markup as { keyboard: { text: string }[][] }
  ).keyboard[0]![0]!.text;

  it("removes the keyboard when the recording is kept", async () => {
    const session = waitingSession({ voicePromptCardMsgId: 555 });
    const replies: Reply[] = [];

    await run(tapCtx(session, replies));

    expect(replies).toHaveLength(1);
    expect(replies[0]![1]?.reply_markup).toEqual({ remove_keyboard: true });
    expect(session.replyPanel).toBe(null);
  });

  it("removes the keyboard when the step is skipped", async () => {
    const session = waitingSession();
    const replies: Reply[] = [];

    await run(textCtx(session, label, replies));

    expect(replies).toHaveLength(1);
    expect(replies[0]![1]?.reply_markup).toEqual({ remove_keyboard: true });
    expect(session.replyPanel).toBe(null);
  });

  it("releases the claim BEFORE the line, or the sync would keep the panel up", async () => {
    const session = waitingSession();
    const replies: Reply[] = [];
    let claimWhenTheLineWasSent: boolean | undefined;

    const ctx = textCtx(session, label, replies);
    (ctx as unknown as { reply: MockFn }).reply = vi.fn(
      async (_text: string, options?: Record<string, unknown>) => {
        claimWhenTheLineWasSent = session.expectingVoicePrompt;
        replies.push([_text, options]);
        return { message_id: 1 };
      },
    );

    await run(ctx);

    expect(claimWhenTheLineWasSent).toBe(false);
  });
});
