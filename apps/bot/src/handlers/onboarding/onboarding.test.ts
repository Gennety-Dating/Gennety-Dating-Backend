import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION } from "@gennety/shared";

// Mock prisma before importing handlers
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    profile: {
      upsert: vi.fn(),
    },
    botSession: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("../../services/email.js", () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/vision/validate-face.js", () => ({
  validateSingleFace: vi.fn(),
}));

// Mock the onboarding agent so language handler tests don't hit OpenAI
vi.mock("../../services/onboarding-agent.js", () => ({
  runAgentTurn: vi.fn().mockResolvedValue({
    reply: "Welcome to Gennety!",
    expectingPhoto: false,
    onboardingComplete: false,
    contextPromptRequested: false,
    contextDumpStarted: false,
  }),
  injectSystemMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../menu/main.js", () => ({
  showMainMenu: vi.fn().mockResolvedValue(undefined),
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
    CUSTOM_EMOJI_MENU_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

import { prisma } from "@gennety/db";
import { handleConsent, sendConsentPrompt } from "./consent.js";
import { handleLanguageSelection } from "./language.js";
import { handleConversational } from "./conversational.js";
import { runAgentTurn, injectSystemMessage } from "../../services/onboarding-agent.js";
import { validateSingleFace } from "../../services/vision/validate-face.js";

function createMockCtx(overrides: {
  session?: Partial<SessionData>;
  callbackData?: string;
  messageText?: string;
  fromId?: number;
}) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    ...overrides.session,
  };

  return {
    session,
    from: { id: overrides.fromId ?? 12345 },
    callbackQuery: overrides.callbackData ? { data: overrides.callbackData } : undefined,
    message: overrides.messageText ? { text: overrides.messageText } : undefined,
    reply: vi.fn().mockResolvedValue(undefined),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("Consent gatekeeper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("sends the consent prompt for a fresh user", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "consent" },
    });

    await sendConsentPrompt(ctx);

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const callArgs = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0];
    // Message text contains consent wording
    expect(callArgs[0]).toContain("Privacy Policy");
    // Has inline keyboard with consent:agree callback
    const markup = callArgs[1]?.reply_markup;
    expect(markup).toBeDefined();
  });

  it("re-shows consent prompt when user sends arbitrary text instead of clicking agree", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "consent" },
      messageText: "hello",
    });

    await handleConsent(ctx);

    // Should re-show consent (reply called), NOT advance
    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx.session.onboardingStep).toBe("consent");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("re-shows consent prompt on unrelated callback data", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "consent" },
      callbackData: "lang:en",
    });

    await handleConsent(ctx);

    expect(ctx.session.onboardingStep).toBe("consent");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("advances to language step on consent:agree callback", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "consent" },
      callbackData: "consent:agree",
    });

    await handleConsent(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.session.onboardingStep).toBe("language");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hasConsented: true,
          onboardingStep: "language",
        }),
      }),
    );
    // Should show language picker immediately after consent
    expect(ctx.reply).toHaveBeenCalled();
  });
});

describe("Language selection → conversational transition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "uuid-1" });
  });

  it("language -> conversational on lang:en callback", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "language" },
      callbackData: "lang:en",
    });

    await handleLanguageSelection(ctx);

    expect(ctx.session.language).toBe("en");
    expect(ctx.session.onboardingStep).toBe("conversational");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ language: "en", onboardingStep: "conversational" }),
      }),
    );
  });

  it("language -> conversational on lang:ru callback", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "language" },
      callbackData: "lang:ru",
    });

    await handleLanguageSelection(ctx);
    expect(ctx.session.language).toBe("ru");
    expect(ctx.session.onboardingStep).toBe("conversational");
  });

  it("kicks off the agent with an intro message after language selection", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "language" },
      callbackData: "lang:en",
    });

    await handleLanguageSelection(ctx);

    expect(runAgentTurn).toHaveBeenCalledWith(
      BigInt(12345),
      expect.stringContaining("User selected language: en"),
    );
    // Agent reply is sent to user
    expect(ctx.reply).toHaveBeenCalledWith("Welcome to Gennety!", { parse_mode: "Markdown" });
  });

  it("ignores invalid language callback", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "language" },
      callbackData: "lang:de",
    });

    await handleLanguageSelection(ctx);
    expect(ctx.session.onboardingStep).toBe("language");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("ignores non-lang callback", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "language" },
      callbackData: "other:value",
    });

    await handleLanguageSelection(ctx);
    expect(ctx.session.onboardingStep).toBe("language");
  });
});

describe("Context dump buffering (multi-chunk paste fix)", () => {
  const agentMock = runAgentTurn as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: agent returns a normal reply with no special flags
    agentMock.mockResolvedValue({
      reply: "Agent reply",
      expectingPhoto: false,
      onboardingComplete: false,
      contextPromptRequested: false,
      contextDumpStarted: false,
    });
  });

  it("activates buffering mode when the agent signals contextDumpStarted", async () => {
    agentMock.mockResolvedValueOnce({
      reply: "Here is the prompt, copy it 👇",
      expectingPhoto: false,
      onboardingComplete: false,
      contextPromptRequested: true,
      contextDumpStarted: true,
    });

    const ctx = createMockCtx({
      session: { onboardingStep: "conversational", awaitingContextDump: false, contextDumpBuffer: "" },
      messageText: "ok i'm ready",
    });

    await handleConversational(ctx);

    expect(ctx.session.awaitingContextDump).toBe(true);
    expect(ctx.session.contextDumpBuffer).toBe("");
  });

  it("buffers the first text chunk and shows the Done button", async () => {
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: true,
        contextDumpBuffer: "",
      },
      messageText: "First chunk of the dump",
    });

    await handleConversational(ctx);

    // Should NOT have called the agent
    expect(agentMock).not.toHaveBeenCalled();
    // Buffer should now contain the chunk
    expect(ctx.session.contextDumpBuffer).toBe("First chunk of the dump");
    // Should have replied with the Done-button prompt
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const replyText = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(replyText).toContain("Done");
  });

  it("silently accumulates subsequent chunks without extra replies", async () => {
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: true,
        contextDumpBuffer: "First chunk",
      },
      messageText: " Second chunk",
    });

    await handleConversational(ctx);

    expect(agentMock).not.toHaveBeenCalled();
    expect(ctx.session.contextDumpBuffer).toBe("First chunk\n Second chunk");
    // No extra reply for subsequent chunks
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("flushes the full buffer to the agent on Done callback", async () => {
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: true,
        contextDumpBuffer: "First chunk\nSecond chunk",
      },
      callbackData: "dump:done",
    });

    await handleConversational(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    // Agent receives the full joined buffer
    expect(agentMock).toHaveBeenCalledWith(
      BigInt(12345),
      "First chunk\nSecond chunk",
    );
    // Buffering mode cleared
    expect(ctx.session.awaitingContextDump).toBe(false);
    expect(ctx.session.contextDumpBuffer).toBe("");
  });

  it("handles Done tap with empty buffer gracefully", async () => {
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: true,
        contextDumpBuffer: "",
      },
      callbackData: "dump:done",
    });

    await handleConversational(ctx);

    // Agent should NOT be called with empty string
    expect(agentMock).not.toHaveBeenCalled();
    // Should send a helpful nudge
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain("Paste");
  });

  it("truncates the incoming chunk when the buffer would overflow and auto-flushes", async () => {
    const { MAX_DUMP_BUFFER_CHARS } = await import("@gennety/shared");
    // Pre-fill so only 10 chars of room remain.
    const prefill = "x".repeat(MAX_DUMP_BUFFER_CHARS - 10);
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: true,
        contextDumpBuffer: prefill,
      },
      messageText: "y".repeat(500),
    });

    await handleConversational(ctx);

    // Auto-flush fires immediately after truncation — agent receives the
    // filled buffer (length == cap), and post-flush session state is cleared.
    expect(agentMock).toHaveBeenCalledTimes(1);
    const flushed = agentMock.mock.calls[0]?.[1] as string;
    expect(flushed.length).toBe(MAX_DUMP_BUFFER_CHARS);
    expect(ctx.session.awaitingContextDump).toBe(false);
    expect(ctx.session.contextDumpBuffer).toBe("");
  });

  it("rejects further input once the buffer is already at the cap", async () => {
    const { MAX_DUMP_BUFFER_CHARS } = await import("@gennety/shared");
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: true,
        contextDumpBuffer: "z".repeat(MAX_DUMP_BUFFER_CHARS),
      },
      messageText: "extra paste",
    });

    await handleConversational(ctx);

    // Auto-flush triggers with existing buffer — agent receives it.
    expect(agentMock).toHaveBeenCalledTimes(1);
    // The "extra paste" is dropped — buffer was already full, no room to append.
    const passedBuffer = agentMock.mock.calls[0]?.[1] as string;
    expect(passedBuffer).not.toContain("extra paste");
  });

  it("single-chunk dump completes normally if agent saves it on Done", async () => {
    agentMock.mockResolvedValueOnce({
      reply: "Got it, now send photos!",
      expectingPhoto: true,
      onboardingComplete: false,
      contextPromptRequested: false,
      contextDumpStarted: false,
    });

    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: true,
        contextDumpBuffer: "My full analysis from ChatGPT here...",
      },
      callbackData: "dump:done",
    });

    await handleConversational(ctx);

    expect(agentMock).toHaveBeenCalledWith(
      BigInt(12345),
      "My full analysis from ChatGPT here...",
    );
    expect(ctx.session.expectingPhoto).toBe(true);
    expect(ctx.session.awaitingContextDump).toBe(false);
  });
});

describe("profile-analysis helpers", () => {
  it("extractJsonSummary parses a JSON blob embedded in prose", async () => {
    const { extractJsonSummary } = await import("../../services/profile-analysis.js");
    const dump =
      "Sure, here's the analysis:\n" +
      '{"summary": "kind introvert", "personality_traits": ["curious", "analytical"]}\n' +
      "Let me know if you need more!";
    const parsed = extractJsonSummary(dump);
    expect(parsed?.summary).toBe("kind introvert");
    expect(parsed?.personality_traits).toEqual(["curious", "analytical"]);
  });

  it("extractJsonSummary returns null when no JSON is present", async () => {
    const { extractJsonSummary } = await import("../../services/profile-analysis.js");
    expect(extractJsonSummary("just plain text, no braces")).toBeNull();
  });

  it("extractJsonSummary strips ```json markdown fences", async () => {
    const { extractJsonSummary } = await import("../../services/profile-analysis.js");
    const dump = '```json\n{"summary": "kind", "personality_traits": ["a"]}\n```';
    const parsed = extractJsonSummary(dump);
    expect(parsed?.summary).toBe("kind");
  });

  const FULL_FAST_PATH_DUMP = JSON.stringify({
    personality_traits: ["curious", "analytical", "warm", "driven", "dry humor"],
    communication_style: "Direct but reflective, picks words carefully.",
    interests: ["jazz", "cognitive science", "mountain biking"],
    values: ["honesty", "autonomy", "craftsmanship"],
    attachment_style: "secure",
    social_energy: "ambivert",
    humor_style: "dry",
    ideal_partner:
      "Someone grounded but playful, who pushes back without making it personal.",
    dealbreakers: ["dishonesty", "contempt"],
    summary:
      "A quietly intense person who thinks in systems, cares about doing things right, and trusts people slowly. Humor is their offramp when things get too earnest.",
  });

  it("isValidFastPathSummary accepts a complete, well-formed profile", async () => {
    const { isValidFastPathSummary } = await import(
      "../../services/profile-analysis.js"
    );
    const parsed = JSON.parse(FULL_FAST_PATH_DUMP);
    expect(isValidFastPathSummary(parsed)).toBe(true);
  });

  it("isValidFastPathSummary rejects a profile missing required fields", async () => {
    const { isValidFastPathSummary } = await import(
      "../../services/profile-analysis.js"
    );
    const partial = JSON.parse(FULL_FAST_PATH_DUMP);
    delete partial.summary;
    expect(isValidFastPathSummary(partial)).toBe(false);
  });

  it("isValidFastPathSummary rejects when personality_traits is too short", async () => {
    const { isValidFastPathSummary } = await import(
      "../../services/profile-analysis.js"
    );
    const shallow = JSON.parse(FULL_FAST_PATH_DUMP);
    shallow.personality_traits = ["a", "b"];
    expect(isValidFastPathSummary(shallow)).toBe(false);
  });

  it("isValidFastPathSummary rejects empty strings in required text fields", async () => {
    const { isValidFastPathSummary } = await import(
      "../../services/profile-analysis.js"
    );
    const blank = JSON.parse(FULL_FAST_PATH_DUMP);
    blank.summary = "   ";
    expect(isValidFastPathSummary(blank)).toBe(false);
  });

  it("isValidFastPathSummary rejects non-object input", async () => {
    const { isValidFastPathSummary } = await import(
      "../../services/profile-analysis.js"
    );
    expect(isValidFastPathSummary(null)).toBe(false);
    expect(isValidFastPathSummary("string")).toBe(false);
    expect(isValidFastPathSummary([])).toBe(false);
  });

  it("parseDumpWithLLM skips the OpenAI call on a valid fast-path paste", async () => {
    vi.resetModules();
    vi.doMock("../../services/openai.js", () => ({
      callOpenAIJson: vi.fn(),
    }));
    const { parseDumpWithLLM } = await import(
      "../../services/profile-analysis.js"
    );
    const { callOpenAIJson } = await import("../../services/openai.js");

    const result = await parseDumpWithLLM(FULL_FAST_PATH_DUMP, "Alice", "en");

    expect(callOpenAIJson).not.toHaveBeenCalled();
    expect(result?.summary).toContain("quietly intense");
    expect(result?.personality_traits).toHaveLength(5);
  });

  it("parseDumpWithLLM falls back to the LLM when the paste is incomplete", async () => {
    vi.resetModules();
    const llmResult = {
      personality_traits: ["a", "b", "c", "d", "e"],
      communication_style: "terse",
      interests: ["x", "y", "z"],
      values: ["a", "b", "c"],
      attachment_style: "secure",
      social_energy: "ambivert",
      humor_style: "dry",
      ideal_partner: "someone reflective",
      dealbreakers: ["rudeness"],
      summary: "Recovered via LLM.",
    };
    vi.doMock("../../services/openai.js", () => ({
      callOpenAIJson: vi.fn().mockResolvedValue(llmResult),
    }));
    const { parseDumpWithLLM } = await import(
      "../../services/profile-analysis.js"
    );
    const { callOpenAIJson } = await import("../../services/openai.js");

    // Incomplete paste (missing several fields) — must hit the LLM.
    const paste = JSON.stringify({
      summary: "only a summary",
      personality_traits: ["a"],
    });
    const result = await parseDumpWithLLM(paste, "Alice", "en");

    expect(callOpenAIJson).toHaveBeenCalledTimes(1);
    expect(result?.summary).toBe("Recovered via LLM.");
  });

  it("toPgVectorLiteral formats numbers with brackets", async () => {
    const { toPgVectorLiteral } = await import("../../services/profile-analysis.js");
    expect(toPgVectorLiteral([0.1, -0.2, 0.3])).toBe("[0.1,-0.2,0.3]");
  });

  it("buildEmbeddingInput falls back to raw text when parsed is null", async () => {
    const { buildEmbeddingInput } = await import("../../services/profile-analysis.js");
    expect(buildEmbeddingInput(null, "raw dump text")).toBe("raw dump text");
  });

  it("buildEmbeddingInput concatenates parsed fields deterministically", async () => {
    const { buildEmbeddingInput } = await import("../../services/profile-analysis.js");
    const out = buildEmbeddingInput(
      {
        summary: "S",
        personality_traits: ["a", "b"],
        interests: ["jazz"],
      },
      "ignored",
    );
    expect(out).toBe("Summary: S\nPersonality: a, b\nInterests: jazz");
  });
});

describe("Album (media_group_id) photo coalescing", () => {
  const agentMock = runAgentTurn as ReturnType<typeof vi.fn>;
  const injectMock = injectSystemMessage as ReturnType<typeof vi.fn>;
  const visionMock = validateSingleFace as ReturnType<typeof vi.fn>;

  function createAlbumCtx(overrides: {
    session?: Partial<SessionData>;
    photoFileId: string;
    photoUniqueId: string;
    mediaGroupId: string;
    chatId?: number;
    fromId?: number;
  }) {
    const session: SessionData = {
      ...DEFAULT_SESSION,
      ...overrides.session,
    };
    const api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn(),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
    };
    return {
      session,
      from: { id: overrides.fromId ?? 99001 },
      chat: { id: overrides.chatId ?? 99001 },
      api,
      message: {
        photo: [
          {
            file_id: overrides.photoFileId,
            file_unique_id: overrides.photoUniqueId,
            width: 800,
            height: 800,
          },
        ],
        media_group_id: overrides.mediaGroupId,
      },
      reply: vi.fn().mockResolvedValue(undefined),
      replyWithChatAction: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    visionMock.mockResolvedValue({ ok: true, valid: true });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "uuid-x" });
    (prisma.profile.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
    agentMock.mockResolvedValue({
      reply: "Photos received, nice!",
      expectingPhoto: true,
      onboardingComplete: false,
      contextPromptRequested: false,
      contextDumpStarted: false,
    });
    injectMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires exactly ONE agent turn for a 3-photo album (not one per frame)", async () => {
    const session: Partial<SessionData> = {
      onboardingStep: "conversational",
      expectingPhoto: true,
      pendingPhotos: [],
      pendingPhotoUniqueIds: [],
    };
    // Shared session object across the three frames — mirrors the real
    // behavior of `sequentializeByChat` where each handler reads/writes
    // the same session row.
    const shared: SessionData = { ...DEFAULT_SESSION, ...session };

    // Frame 1
    const ctx1 = createAlbumCtx({
      photoFileId: "file_1",
      photoUniqueId: "uid_1",
      mediaGroupId: "group_A",
    });
    ctx1.session = shared;
    await handleConversational(ctx1);

    // Frame 2
    const ctx2 = createAlbumCtx({
      photoFileId: "file_2",
      photoUniqueId: "uid_2",
      mediaGroupId: "group_A",
    });
    ctx2.session = shared;
    await handleConversational(ctx2);

    // Frame 3
    const ctx3 = createAlbumCtx({
      photoFileId: "file_3",
      photoUniqueId: "uid_3",
      mediaGroupId: "group_A",
    });
    ctx3.session = shared;
    await handleConversational(ctx3);

    // Before debounce fires: no agent turn, no user-visible reply
    expect(agentMock).not.toHaveBeenCalled();
    expect(ctx1.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx2.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx3.api.sendMessage).not.toHaveBeenCalled();

    // All three photos validated + persisted inline
    expect(visionMock).toHaveBeenCalledTimes(3);
    expect(shared.pendingPhotos).toEqual(["file_1", "file_2", "file_3"]);
    expect(shared.pendingPhotoUniqueIds).toEqual(["uid_1", "uid_2", "uid_3"]);

    // Seed the DB read that the flush does to rebuild session state
    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "99001",
      data: shared,
    });
    (prisma.botSession.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});

    // Advance past debounce → flush runs
    await vi.advanceTimersByTimeAsync(800);

    // Exactly ONE agent turn for the whole album
    expect(agentMock).toHaveBeenCalledTimes(1);
    expect(agentMock).toHaveBeenCalledWith(
      BigInt(99001),
      expect.stringContaining("Album uploaded: 3 verified photo(s)"),
    );

    // Exactly ONE user-visible reply (on the api captured by the first frame)
    expect(ctx1.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx2.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx3.api.sendMessage).not.toHaveBeenCalled();
  });

  it("coalesces standalone photo messages (no media_group_id) into ONE agent turn", async () => {
    // Simulates the real-world case where a Telegram client sends photos
    // as separate messages rather than as a media group — e.g. when the
    // user picks photos one-by-one. Without coalescing, each photo would
    // fire its own agent turn, producing "got 1, need 1 more" immediately
    // followed by "got all" seconds later — the exact confused-user UX
    // the batcher exists to prevent.
    const shared: SessionData = {
      ...DEFAULT_SESSION,
      onboardingStep: "conversational",
      expectingPhoto: true,
      pendingPhotos: [],
      pendingPhotoUniqueIds: [],
    };

    for (let i = 1; i <= 3; i++) {
      const ctx = createAlbumCtx({
        photoFileId: `solo_${i}`,
        photoUniqueId: `solo_uid_${i}`,
        mediaGroupId: "", // Overwritten below to simulate a standalone photo
      });
      // Remove media_group_id so handlePhotoMessage treats it as standalone.
      delete ctx.message.media_group_id;
      ctx.session = shared;
      await handleConversational(ctx);
    }

    // All three frames validated and persisted inline; no premature turn.
    expect(visionMock).toHaveBeenCalledTimes(3);
    expect(shared.pendingPhotos).toEqual(["solo_1", "solo_2", "solo_3"]);
    expect(agentMock).not.toHaveBeenCalled();

    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "99001",
      data: shared,
    });
    (prisma.botSession.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await vi.advanceTimersByTimeAsync(800);

    // Exactly ONE agent turn for the whole burst — not three.
    expect(agentMock).toHaveBeenCalledTimes(1);
    expect(agentMock).toHaveBeenCalledWith(
      BigInt(99001),
      expect.stringContaining("Album uploaded: 3 verified photo(s)"),
    );
  });

  it("auto-accepts an unsolicited album and nudges the agent to call request_photos", async () => {
    const shared: SessionData = {
      ...DEFAULT_SESSION,
      onboardingStep: "conversational",
      expectingPhoto: false,
      pendingPhotos: [],
      pendingPhotoUniqueIds: [],
    };

    for (let i = 1; i <= 3; i++) {
      const ctx = createAlbumCtx({
        photoFileId: `file_${i}`,
        photoUniqueId: `uid_${i}`,
        mediaGroupId: "group_B",
      });
      ctx.session = shared;
      await handleConversational(ctx);
    }

    // Frames validated + persisted inline (no longer silently dropped)
    expect(visionMock).toHaveBeenCalledTimes(3);
    expect(shared.pendingPhotos).toEqual(["file_1", "file_2", "file_3"]);
    expect(shared.expectingPhoto).toBe(true);
    expect(agentMock).not.toHaveBeenCalled();

    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "99001",
      data: shared,
    });
    (prisma.botSession.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await vi.advanceTimersByTimeAsync(800);

    // ONE agent turn for the whole album, but tagged as an auto-accepted batch
    expect(agentMock).toHaveBeenCalledTimes(1);
    expect(agentMock).toHaveBeenCalledWith(
      BigInt(99001),
      expect.stringContaining("Album uploaded: 3 verified photo(s)"),
    );
    expect(injectMock).toHaveBeenCalledWith(
      BigInt(99001),
      expect.stringContaining("BEFORE you called request_photos"),
    );
  });
});
