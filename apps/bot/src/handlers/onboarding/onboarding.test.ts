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
      updateMany: vi.fn(),
    },
    botSession: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

vi.mock("../../services/status-banner.js", () => ({
  pinStatusBanner: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/email.js", () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/vision/validate-face.js", () => ({
  validateSingleFace: vi.fn(),
}));

const mediaValidationMocks = vi.hoisted(() => ({
  downloadTelegramFile: vi.fn(),
  validatePhoto: vi.fn(),
  validateVideo: vi.fn(),
}));

vi.mock("../../services/storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/storage.js")>()),
  downloadTelegramFile: mediaValidationMocks.downloadTelegramFile,
}));

vi.mock(
  "../../services/profile-media-validation/profile-photo-validation.js",
  () => ({
    validateUserProfilePhoto: mediaValidationMocks.validatePhoto,
  }),
);

vi.mock(
  "../../services/profile-media-validation/profile-video-validation.js",
  () => ({
    validateUserProfileVideo: mediaValidationMocks.validateVideo,
  }),
);

const ticketMocks = vi.hoisted(() => ({
  grantPhotoBonusIfEligible: vi.fn(),
  grantVideoBonusIfEligible: vi.fn(),
  sendTicketRewardDM: vi.fn(),
}));

vi.mock("../../services/ticket-wallet.js", () => ({
  grantPhotoBonusIfEligible: ticketMocks.grantPhotoBonusIfEligible,
  grantVideoBonusIfEligible: ticketMocks.grantVideoBonusIfEligible,
}));

vi.mock("../../services/ticket-reward.js", () => ({
  sendTicketRewardDM: ticketMocks.sendTicketRewardDM,
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
  recordOnboardingAssistantReply: vi.fn().mockResolvedValue(undefined),
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
    ENABLE_PERSONA_VERIFICATION: true,
    PERSONA_TEMPLATE_ID: "tmpl-test",
    PERSONA_ENVIRONMENT_ID: "env-test",
    PERSONA_HOSTED_URL_BASE: "https://withpersona.test/verify",
    BOT_USERNAME: "gennetytestbot",
    WEBAPP_URL: "https://test.invalid/calendar",
    TICKET_FEATURE_ENABLED: true,
    MESSAGE_EFFECT_TICKET_ID: "",
    PROFILE_MEDIA_VALIDATION_ENABLED: false,
    PROFILE_MEDIA_VALIDATION_FAIL_OPEN: false,
    PROFILE_VIDEO_MAX_ANALYSIS_FRAMES: 24,
    PROFILE_VIDEO_VALIDATION_TIMEOUT_MS: 60_000,
    FACE_MATCH_THRESHOLD_VERIFY: 0.85,
    FACE_MATCH_THRESHOLD_REVIEW: 0.75,
  },
}));

import { prisma } from "@gennety/db";
import { handleConsent, sendConsentPrompt } from "./consent.js";
import { handleLanguageSelection } from "./language.js";
import {
  handleConversational,
  ONBOARDING_PHOTOS_CONTINUE_CALLBACK,
} from "./conversational.js";
import {
  VERIFY_SKIP_CALLBACK,
  VERIFY_SKIP_CONFIRM_CALLBACK,
  handleVerificationSkip,
  handleVerificationSkipConfirm,
  sendVerificationCTABare,
} from "./verification.js";
import { runAgentTurn, injectSystemMessage } from "../../services/onboarding-agent.js";
import { validateSingleFace } from "../../services/vision/validate-face.js";
import { showMainMenu } from "../menu/main.js";
import { pinStatusBanner } from "../../services/status-banner.js";
import { env } from "../../config.js";

const mutableValidationEnv = env as unknown as {
  PROFILE_MEDIA_VALIDATION_ENABLED: boolean;
  PROFILE_MEDIA_VALIDATION_FAIL_OPEN: boolean;
};

function createMockCtx(overrides: {
  session?: Partial<SessionData>;
  callbackData?: string;
  messageText?: string;
  photo?: { file_id: string; file_unique_id: string };
  video?: {
    file_id: string;
    file_unique_id: string;
    duration?: number;
    file_size?: number;
    width?: number;
    height?: number;
  };
  livePhoto?: {
    file_id: string;
    file_unique_id: string;
    static_file_id?: string;
    static_unique_id?: string;
    duration?: number;
    file_size?: number;
    width?: number;
    height?: number;
  };
  messageId?: number;
  fromId?: number;
}) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    ...overrides.session,
  };

  const message = overrides.video
    ? {
        message_id: overrides.messageId ?? 111,
        video: {
          file_id: overrides.video.file_id,
          file_unique_id: overrides.video.file_unique_id,
          duration: overrides.video.duration ?? 20,
          width: overrides.video.width ?? 720,
          height: overrides.video.height ?? 1280,
          ...(overrides.video.file_size !== undefined
            ? { file_size: overrides.video.file_size }
            : {}),
        },
      }
    : overrides.livePhoto
    ? {
        message_id: overrides.messageId ?? 111,
        live_photo: {
          file_id: overrides.livePhoto.file_id,
          file_unique_id: overrides.livePhoto.file_unique_id,
          duration: overrides.livePhoto.duration ?? 4,
          width: overrides.livePhoto.width ?? 720,
          height: overrides.livePhoto.height ?? 1280,
          ...(overrides.livePhoto.file_size !== undefined
            ? { file_size: overrides.livePhoto.file_size }
            : {}),
          ...(overrides.livePhoto.static_file_id
            ? {
                photo: [
                  {
                    file_id: overrides.livePhoto.static_file_id,
                    file_unique_id: overrides.livePhoto.static_unique_id ?? "static_unique",
                    width: 800,
                    height: 800,
                  },
                ],
              }
            : {}),
        },
      }
    : overrides.photo
    ? {
        message_id: overrides.messageId ?? 111,
        photo: [
          {
            file_id: overrides.photo.file_id,
            file_unique_id: overrides.photo.file_unique_id,
            width: 800,
            height: 800,
          },
        ],
      }
    : overrides.messageText
      ? { message_id: overrides.messageId ?? 111, text: overrides.messageText }
      : undefined;

  return {
    session,
    from: { id: overrides.fromId ?? 12345 },
    chat: { id: overrides.fromId ?? 12345 },
    callbackQuery: overrides.callbackData ? { data: overrides.callbackData } : undefined,
    message,
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      setMessageReaction: vi.fn().mockResolvedValue(undefined),
    },
    reply: vi.fn().mockResolvedValue({ message_id: 700 }),
    replyWithPhoto: vi.fn().mockResolvedValue(undefined),
    replyWithChatAction: vi.fn().mockResolvedValue(undefined),
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
          termsAccepted: true,
          termsAcceptedAt: expect.any(Date),
          onboardingStep: "language",
        }),
      }),
    );
    // Should show language picker immediately after consent
    expect(ctx.reply).toHaveBeenCalled();
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]
      ?.reply_markup;
    const serializedMarkup = JSON.stringify(markup);
    expect(serializedMarkup).toContain("lang:en");
    expect(serializedMarkup).toContain("lang:ru");
    expect(serializedMarkup).toContain("lang:uk");
    expect(serializedMarkup).toContain("lang:de");
    expect(serializedMarkup).toContain("lang:pl");
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

  it("language -> conversational on lang:de callback", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "language" },
      callbackData: "lang:de",
    });

    await handleLanguageSelection(ctx);
    expect(ctx.session.language).toBe("de");
    expect(ctx.session.onboardingStep).toBe("conversational");
  });

  it("language -> conversational on lang:pl callback", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "language" },
      callbackData: "lang:pl",
    });

    await handleLanguageSelection(ctx);
    expect(ctx.session.language).toBe("pl");
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
      { kind: "resume" },
    );
    // Agent reply is sent to user
    expect(ctx.reply).toHaveBeenCalledWith("Welcome to Gennety!", { parse_mode: "Markdown" });
  });

  it("ignores invalid language callback", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "language" },
      callbackData: "lang:fr",
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

describe("Context dump processing delay", () => {
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

  it("likes a user message when the collector accepted hobbies", async () => {
    agentMock.mockResolvedValueOnce({
      reply: "Nice, I saved that.",
      expectingPhoto: false,
      onboardingComplete: false,
      contextPromptRequested: false,
      contextDumpStarted: false,
      contextDumpSaved: false,
      acceptedOnboardingFields: ["hobbies"],
    });

    const ctx = createMockCtx({
      session: { onboardingStep: "conversational" },
      messageText: "I like climbing and jazz.",
      messageId: 444,
    });

    await handleConversational(ctx);

    expect(ctx.api.setMessageReaction).toHaveBeenCalledWith(
      12345,
      444,
      [{ type: "emoji", emoji: "👍" }],
      { is_big: false },
    );
  });

  it("context dump mode wins if the agent also incorrectly signals expectingPhoto", async () => {
    agentMock.mockResolvedValueOnce({
      reply: "Paste the AI response first.",
      expectingPhoto: true,
      onboardingComplete: false,
      contextPromptRequested: true,
      contextDumpStarted: true,
    });

    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: false,
        expectingPhoto: false,
      },
      messageText: "ready",
    });

    await handleConversational(ctx);

    expect(ctx.session.awaitingContextDump).toBe(true);
    expect(ctx.session.expectingPhoto).toBe(false);
  });

  it("rejects photos while waiting for the user's LLM dump paste", async () => {
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: true,
        expectingPhoto: true,
      },
      photo: { file_id: "photo_1", file_unique_id: "unique_1" },
    });

    await handleConversational(ctx);

    expect(validateSingleFace).not.toHaveBeenCalled();
    expect(agentMock).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "Send the AI-chat response to the prompt above first. Photos come after that.",
    );
    expect(ctx.session.expectingPhoto).toBe(false);
  });

  it("accepts a valid Live Photo and validates its static frame", async () => {
    vi.useFakeTimers();
    try {
      (validateSingleFace as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        valid: true,
      });
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "uuid-live",
      });
      (prisma.profile.upsert as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

      const ctx = createMockCtx({
        session: {
          onboardingStep: "conversational",
          expectingPhoto: true,
          pendingPhotos: [],
          pendingProfileMedia: [],
          pendingPhotoUniqueIds: [],
        },
        livePhoto: {
          file_id: "live_video_1",
          file_unique_id: "live_unique_1",
          static_file_id: "live_static_1",
          static_unique_id: "live_static_unique_1",
          duration: 6,
          file_size: 1024,
          width: 720,
          height: 1280,
        },
      });

      await handleConversational(ctx);

      expect(validateSingleFace).toHaveBeenCalledWith(ctx, "live_static_1");
      expect(ctx.session.pendingPhotos).toEqual(["live_static_1"]);
      expect(ctx.session.pendingProfileMedia).toEqual([
        {
          type: "live_photo",
          photo: "live_static_1",
          livePhoto: "live_video_1",
          duration: 6,
          width: 720,
          height: 1280,
          fileSize: 1024,
        },
      ]);
      expect(prisma.profile.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: expect.any(String) },
          create: expect.objectContaining({
            photos: ["live_static_1"],
            profileMedia: [
              {
                type: "live_photo",
                photo: "live_static_1",
                livePhoto: "live_video_1",
                duration: 6,
                width: 720,
                height: 1280,
                fileSize: 1024,
              },
            ],
            acceptedPhotoCount: 1,
            uploadedPhotoHashes: [],
            referenceFaceEmbedding: expect.objectContaining({
              kind: "reference_photo",
              photoRef: "live_static_1",
            }),
          }),
        }),
      );
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects Live Photo without a static frame", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "conversational", expectingPhoto: true },
      livePhoto: {
        file_id: "live_video_1",
        file_unique_id: "live_unique_1",
      },
    });

    await handleConversational(ctx);

    expect(validateSingleFace).not.toHaveBeenCalled();
    expect(prisma.profile.upsert).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "That Live Photo is missing its still frame, so I can't verify it. Send it as a regular photo or choose another Live Photo.",
    );
  });

  it("rejects Live Photo over the Telegram duration limit", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "conversational", expectingPhoto: true },
      livePhoto: {
        file_id: "live_video_1",
        file_unique_id: "live_unique_1",
        static_file_id: "live_static_1",
        duration: 11,
      },
    });

    await handleConversational(ctx);

    expect(validateSingleFace).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "Live Photos need to be 10 seconds or shorter. Send a shorter one or a regular photo.",
    );
  });

  it("rejects Live Photo over the Telegram file-size limit", async () => {
    const ctx = createMockCtx({
      session: { onboardingStep: "conversational", expectingPhoto: true },
      livePhoto: {
        file_id: "live_video_1",
        file_unique_id: "live_unique_1",
        static_file_id: "live_static_1",
        file_size: 10 * 1024 * 1024 + 1,
      },
    });

    await handleConversational(ctx);

    expect(validateSingleFace).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "Live Photos need to be 10 MB or smaller. Send a smaller one or a regular photo.",
    );
  });

  it("buffers a long paste without a Done button and auto-flushes after a pause", async () => {
    vi.useFakeTimers();
    try {
      const longPaste = "Here is your psychological analysis. ".repeat(20);
      const ctx = createMockCtx({
        session: {
          onboardingStep: "conversational",
          awaitingContextDump: true,
          contextDumpBuffer: "",
        },
        messageText: longPaste,
      });

      await handleConversational(ctx);

      expect(agentMock).not.toHaveBeenCalled();
      expect(ctx.session.contextDumpBuffer).toBe(longPaste);
      // No "received" ack while buffering — the paste is acknowledged by the
      // analysing status sequence that plays after the debounce flush, so an
      // extra "processing…" line (or a Done button) would just be chat noise.
      expect(ctx.reply).not.toHaveBeenCalled();

      (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: ctx.session,
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(agentMock).toHaveBeenCalledWith(BigInt(12345), {
        kind: "context_dump",
        text: longPaste.trim(),
      });
      expect(prisma.botSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            data: expect.objectContaining({
              awaitingContextDump: false,
              contextDumpBuffer: "",
            }),
          },
        }),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("short message while awaiting dump (empty buffer) is treated as a question, not a paste", async () => {
    // Most users want to ask "wait, why do I need this?" before pasting
    // anything. Pre-fix this got swallowed into contextDumpBuffer; now it
    // falls through to the agent so the LLM can answer.
    agentMock.mockResolvedValueOnce({
      reply: "It's a quick read on your psych profile — helps me match you well.",
      expectingPhoto: false,
      onboardingComplete: false,
      contextPromptRequested: false,
      contextDumpStarted: false,
    });

    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        awaitingContextDump: true,
        contextDumpBuffer: "",
      },
      messageText: "А для чего это делать?",
    });

    await handleConversational(ctx);

    // Agent was invoked with the question
    expect(agentMock).toHaveBeenCalledWith(BigInt(12345), "А для чего это делать?");
    // Buffer remains empty; awaitingContextDump remains true so a
    // subsequent paste still routes through the buffer.
    expect(ctx.session.contextDumpBuffer).toBe("");
    expect(ctx.session.awaitingContextDump).toBe(true);
    // No paste-buffer acknowledgment was sent — only the agent's reply.
    const replies = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as string,
    );
    expect(replies.some((r) => r.includes("processing your response"))).toBe(false);
  });

  it("silently accumulates subsequent chunks until the debounce expires", async () => {
    vi.useFakeTimers();
    try {
      const firstChunk = "First analysis chunk. ".repeat(25);
      const ctx = createMockCtx({
        session: {
          onboardingStep: "conversational",
          awaitingContextDump: true,
          contextDumpBuffer: "",
        },
        messageText: firstChunk,
      });

      await handleConversational(ctx);
      await vi.advanceTimersByTimeAsync(1_000);

      ctx.message = { text: "Second chunk" };
      await handleConversational(ctx);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(agentMock).not.toHaveBeenCalled();
      expect(ctx.session.contextDumpBuffer).toBe(`${firstChunk}\nSecond chunk`);
      // Buffering is silent — no per-chunk ack (see handleContextDumpChunk).
      expect(ctx.reply).not.toHaveBeenCalled();

      (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: ctx.session,
      });
      await vi.advanceTimersByTimeAsync(1_000);

      expect(agentMock).toHaveBeenCalledWith(
        BigInt(12345),
        {
          kind: "context_dump",
          text: `${firstChunk}\nSecond chunk`.trim(),
        },
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("still accepts a legacy Done callback from an older chat message", async () => {
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
      {
        kind: "context_dump",
        text: "First chunk\nSecond chunk",
      },
    );
    // Buffering mode cleared
    expect(ctx.session.awaitingContextDump).toBe(false);
    expect(ctx.session.contextDumpBuffer).toBe("");
  });

  it("handles a stale legacy Done callback with an empty buffer gracefully", async () => {
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
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const msg = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain("Paste the AI response");
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
    const flushed = agentMock.mock.calls[0]?.[1] as {
      kind: string;
      text: string;
    };
    expect(flushed.kind).toBe("context_dump");
    expect(flushed.text.length).toBe(MAX_DUMP_BUFFER_CHARS);
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

  it("single-chunk dump advances to photos after automatic processing", async () => {
    vi.useFakeTimers();
    try {
      agentMock.mockResolvedValueOnce({
        reply: "Got it, now send photos!",
        expectingPhoto: true,
        onboardingComplete: false,
        contextPromptRequested: false,
        contextDumpStarted: false,
      });

      const fullDump = "My full analysis from ChatGPT. ".repeat(20);
      const ctx = createMockCtx({
        session: {
          onboardingStep: "conversational",
          awaitingContextDump: true,
          contextDumpBuffer: "",
        },
        messageText: fullDump,
      });

      await handleConversational(ctx);
      (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: ctx.session,
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(agentMock).toHaveBeenCalledWith(BigInt(12345), {
        kind: "context_dump",
        text: fullDump.trim(),
      });
      expect(prisma.botSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            data: expect.objectContaining({
              awaitingContextDump: false,
              expectingPhoto: true,
            }),
          },
        }),
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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
    messageId?: number;
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
      setMessageReaction: vi.fn().mockResolvedValue(undefined),
    };
    return {
      session,
      from: { id: overrides.fromId ?? 99001 },
      chat: { id: overrides.chatId ?? 99001 },
      api,
      message: {
        message_id: overrides.messageId ?? 610,
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
    ticketMocks.grantPhotoBonusIfEligible.mockResolvedValue({
      granted: false,
      balance: 0,
    });
    ticketMocks.grantVideoBonusIfEligible.mockResolvedValue({
      granted: false,
      balance: 0,
    });
    ticketMocks.sendTicketRewardDM.mockResolvedValue(undefined);
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = false;
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_FAIL_OPEN = false;
    mediaValidationMocks.downloadTelegramFile.mockResolvedValue(
      Buffer.from("media"),
    );
    mediaValidationMocks.validatePhoto.mockResolvedValue({
      ok: true,
      value: {
        fingerprint: { sha256: "a", differenceHash: "0".repeat(16) },
        identitySimilarity: 0.93,
      },
    });
    mediaValidationMocks.validateVideo.mockResolvedValue({
      ok: true,
      value: {
        evidence: {
          matchedFrameCount: 3,
          matchedClusterCount: 2,
          matchedTemporalThirds: 2,
          hasHighQualityMatch: true,
        },
        durationSeconds: 20,
        sampledFrameCount: 12,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders one optional-stage prompt for a 4-photo album without an agent turn", async () => {
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

    // Frame 4 — reaches the minimum so the optional ticket-offer stage renders
    const ctx4 = createAlbumCtx({
      photoFileId: "file_4",
      photoUniqueId: "uid_4",
      mediaGroupId: "group_A",
    });
    ctx4.session = shared;
    await handleConversational(ctx4);

    // Before debounce fires: no agent turn, no user-visible reply
    expect(agentMock).not.toHaveBeenCalled();
    expect(ctx1.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx2.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx3.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx4.api.sendMessage).not.toHaveBeenCalled();

    // All four photos validated + persisted inline
    expect(visionMock).toHaveBeenCalledTimes(4);
    expect(shared.pendingPhotos).toEqual(["file_1", "file_2", "file_3", "file_4"]);
    expect(shared.pendingPhotoUniqueIds).toEqual(["uid_1", "uid_2", "uid_3", "uid_4"]);

    // Seed the DB read that the flush does to rebuild session state
    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "99001",
      data: shared,
    });
    (prisma.botSession.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});

    // Advance past debounce → flush runs
    await vi.advanceTimersByTimeAsync(800);

    expect(agentMock).not.toHaveBeenCalled();

    // Exactly ONE user-visible reply (on the api captured by the first frame)
    expect(ctx1.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(ctx1.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("free Date Ticket"),
      expect.objectContaining({
        reply_markup: expect.any(Object),
      }),
    );
    expect(ctx2.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx3.api.sendMessage).not.toHaveBeenCalled();
    expect(ctx4.api.sendMessage).not.toHaveBeenCalled();
  });

  it("reacts with fire only to the first valid profile photo", async () => {
    const shared: SessionData = {
      ...DEFAULT_SESSION,
      onboardingStep: "conversational",
      expectingPhoto: true,
      pendingPhotos: [],
      pendingPhotoUniqueIds: [],
    };

    const first = createAlbumCtx({
      photoFileId: "first_photo",
      photoUniqueId: "first_uid",
      mediaGroupId: "",
      messageId: 701,
    });
    delete first.message.media_group_id;
    first.session = shared;
    await handleConversational(first);

    expect(first.api.setMessageReaction).toHaveBeenCalledWith(
      99001,
      701,
      [{ type: "emoji", emoji: "🔥" }],
      { is_big: false },
    );

    const second = createAlbumCtx({
      photoFileId: "second_photo",
      photoUniqueId: "second_uid",
      mediaGroupId: "",
      messageId: 702,
    });
    delete second.message.media_group_id;
    second.session = shared;
    await handleConversational(second);

    expect(second.api.setMessageReaction).not.toHaveBeenCalled();
  });

  it("coalesces standalone photo messages into one deterministic prompt", async () => {
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

    expect(agentMock).not.toHaveBeenCalled();
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
      { kind: "photos_updated", count: 3 },
    );
    expect(injectMock).toHaveBeenCalledWith(
      BigInt(99001),
      expect.stringContaining("BEFORE you called request_photos"),
    );
  });

  it("guides one-by-one uploads through the minimum (4) up to the bonus (6)", async () => {
    // First 5 photos: no bonus yet; the 6th (PHOTO_BONUS_TICKET_THRESHOLD) grants it.
    ticketMocks.grantPhotoBonusIfEligible
      .mockResolvedValueOnce({ granted: false, balance: 0 })
      .mockResolvedValueOnce({ granted: false, balance: 0 })
      .mockResolvedValueOnce({ granted: false, balance: 0 })
      .mockResolvedValueOnce({ granted: false, balance: 0 })
      .mockResolvedValueOnce({ granted: false, balance: 0 })
      .mockResolvedValueOnce({ granted: true, balance: 1 });
    const shared: SessionData = {
      ...DEFAULT_SESSION,
      onboardingStep: "conversational",
      expectingPhoto: true,
      pendingPhotos: [],
      pendingPhotoUniqueIds: [],
    };

    const uploadPhoto = async (n: number) => {
      const ctx = createAlbumCtx({
        photoFileId: `single_${n}`,
        photoUniqueId: `single_uid_${n}`,
        mediaGroupId: "",
      });
      delete ctx.message.media_group_id;
      ctx.session = shared;
      await handleConversational(ctx);
      await vi.advanceTimersByTimeAsync(800);
      return ctx;
    };

    const first = createAlbumCtx({
      photoFileId: "single_1",
      photoUniqueId: "single_uid_1",
      mediaGroupId: "",
    });
    delete first.message.media_group_id;
    first.session = shared;
    await handleConversational(first);

    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "99001",
      data: shared,
    });
    (prisma.botSession.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await vi.advanceTimersByTimeAsync(800);

    // Below the minimum: bare progress, no Continue button, no ticket copy yet.
    expect(first.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("1/4"),
    );

    await uploadPhoto(2);
    await uploadPhoto(3);

    // Minimum reached at 4 photos: the initial free-ticket offer + Continue.
    const fourth = await uploadPhoto(4);
    expect(fourth.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("free Date Ticket"),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(shared.expectingPhoto).toBe(true);
    expect(agentMock).not.toHaveBeenCalled();

    // One below the bonus threshold: progress toward 6.
    const fifth = await uploadPhoto(5);
    expect(fifth.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("5/6"),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );

    // Bonus threshold (6) reached: grant + celebratory copy.
    const sixth = await uploadPhoto(6);
    expect(ticketMocks.sendTicketRewardDM).toHaveBeenCalledWith(
      sixth.api,
      99001,
      "en",
      "photo",
      1,
    );
    expect(sixth.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("photo Date Ticket is secured"),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(shared.pendingPhotos).toHaveLength(6);
  });

  it("explains that a repeated photo was not counted", async () => {
    const shared: SessionData = {
      ...DEFAULT_SESSION,
      onboardingStep: "conversational",
      expectingPhoto: true,
      pendingPhotos: ["photo_1"],
      pendingPhotoUniqueIds: ["photo_uid_1"],
    };
    const ctx = createAlbumCtx({
      photoFileId: "photo_1",
      photoUniqueId: "photo_uid_1",
      mediaGroupId: "",
    });
    delete ctx.message.media_group_id;
    ctx.session = shared;

    await handleConversational(ctx);
    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      key: "99001",
      data: shared,
    });
    await vi.advanceTimersByTimeAsync(800);

    expect(visionMock).not.toHaveBeenCalled();
    // The explanation is anchored to the offending photo itself (an album is N
    // separate messages, so a detached line cannot say *which* frame failed).
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("already in your profile"),
      {
        reply_parameters: {
          message_id: 610,
          allow_sending_without_reply: true,
        },
      },
    );
    expect(ctx.api.setMessageReaction).toHaveBeenCalledWith(
      99001,
      610,
      [{ type: "emoji", emoji: "🤔" }],
      { is_big: false },
    );
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("1/4"),
    );
  });

  it.each([4, 6])(
    "keeps onboarding open after a %i-photo album and shows Continue",
    async (photoCount) => {
      const shared: SessionData = {
        ...DEFAULT_SESSION,
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: [],
        pendingPhotoUniqueIds: [],
      };
      let firstCtx: ReturnType<typeof createAlbumCtx> | null = null;

      for (let i = 1; i <= photoCount; i++) {
        const ctx = createAlbumCtx({
          photoFileId: `batch_${photoCount}_${i}`,
          photoUniqueId: `batch_uid_${photoCount}_${i}`,
          mediaGroupId: `group_${photoCount}`,
        });
        ctx.session = shared;
        firstCtx ??= ctx;
        await handleConversational(ctx);
      }

      (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        key: "99001",
        data: shared,
      });
      (prisma.botSession.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await vi.advanceTimersByTimeAsync(800);

      expect(firstCtx!.api.sendMessage).toHaveBeenCalledWith(
        99001,
        expect.stringContaining("profile video"),
        expect.objectContaining({ reply_markup: expect.any(Object) }),
      );
      expect(shared.onboardingStep).toBe("conversational");
      expect(shared.expectingPhoto).toBe(true);
      expect(agentMock).not.toHaveBeenCalled();
    },
  );

  it("accepts a profile video after the minimum and keeps Continue available", async () => {
    ticketMocks.grantVideoBonusIfEligible.mockResolvedValue({
      granted: true,
      balance: 1,
    });
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: ["photo_1", "photo_2", "photo_3", "photo_4"],
      },
      video: {
        file_id: "video_1",
        file_unique_id: "video_uid_1",
      },
      fromId: 99001,
    });

    await handleConversational(ctx as any);

    expect(ticketMocks.sendTicketRewardDM).toHaveBeenCalledWith(
      ctx.api,
      99001,
      "en",
      "video",
      1,
    );
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("video bonus is secured"),
      expect.objectContaining({ reply_markup: expect.any(Object) }),
    );
    expect(ctx.session.onboardingStep).toBe("conversational");
  });

  it("replaces an existing profile video instead of appending another one", async () => {
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: ["photo_1", "photo_2"],
        pendingProfileMedia: [
          { type: "photo", photo: "photo_1" },
          { type: "photo", photo: "photo_2" },
          { type: "video", video: "old_video", duration: 10 },
        ],
      },
      video: {
        file_id: "new_video",
        file_unique_id: "new_video_uid",
      },
      fromId: 99001,
    });

    await handleConversational(ctx as any);

    expect(
      ctx.session.pendingProfileMedia.filter(
        (item: { type: string }) => item.type === "video",
      ),
    ).toEqual([
      expect.objectContaining({ type: "video", video: "new_video" }),
    ]);
  });

  it("rejects a different person during onboarding before persisting the photo", async () => {
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = true;
    mediaValidationMocks.validatePhoto.mockResolvedValueOnce({
      ok: false,
      reason: "identity_mismatch",
      retryable: false,
    });
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: ["photo_1"],
        pendingPhotoUniqueIds: ["uid_1"],
      },
      photo: {
        file_id: "photo_other_person",
        file_unique_id: "uid_other_person",
      },
      fromId: 99001,
    });

    await handleConversational(ctx as any);
    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: ctx.session,
    });
    await vi.advanceTimersByTimeAsync(800);

    expect(ctx.session.pendingPhotos).toEqual(["photo_1"]);
    expect(prisma.profile.upsert).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("All photos must belong to the same person"),
      expect.anything(),
    );
  });

  it("points at the exact photo that failed, with its real reason", async () => {
    // The founder's own onboarding: an album of photos where ONE is bounced.
    // The bot used to answer "3/4" plus one detached line, so there was no way
    // to tell which frame failed or why. The explanation must land ON the frame.
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = true;
    mediaValidationMocks.validatePhoto.mockResolvedValueOnce({
      ok: false,
      reason: "face_obscured",
      retryable: false,
    });
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: ["photo_1"],
        pendingPhotoUniqueIds: ["uid_1"],
      },
      photo: { file_id: "photo_sunglasses", file_unique_id: "uid_sunglasses" },
      messageId: 777,
      fromId: 99001,
    });

    await handleConversational(ctx as any);
    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: ctx.session,
    });
    await vi.advanceTimersByTimeAsync(800);

    expect(ctx.session.pendingPhotos).toEqual(["photo_1"]);
    // Reason is the concrete one (sunglasses / covering), not a generic bounce…
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      99001,
      expect.stringContaining("sunglasses"),
      {
        reply_parameters: {
          message_id: 777,
          allow_sending_without_reply: true,
        },
      },
    );
    // …and the offending frame is marked, so an album shows which one it was.
    expect(ctx.api.setMessageReaction).toHaveBeenCalledWith(
      99001,
      777,
      [{ type: "emoji", emoji: "🤔" }],
      { is_big: false },
    );
  });

  it("hands the real rejection reason to the agent on the deterministic path", async () => {
    // The media stage runs no agent turn, so without an explicit injection the
    // agent stays blind: the user's next message ("why didn't it count?") would
    // be answered by a model that never learned a photo was rejected.
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = true;
    mediaValidationMocks.validatePhoto.mockResolvedValueOnce({
      ok: false,
      reason: "face_obscured",
      retryable: false,
    });
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: ["photo_1"],
        pendingPhotoUniqueIds: ["uid_1"],
      },
      photo: { file_id: "photo_shades", file_unique_id: "uid_shades" },
      messageId: 812,
      fromId: 99001,
    });

    await handleConversational(ctx as any);
    (prisma.botSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: ctx.session,
    });
    await vi.advanceTimersByTimeAsync(800);

    expect(injectSystemMessage).toHaveBeenCalledWith(
      99001n,
      expect.stringContaining("face_obscured"),
    );
    expect(injectSystemMessage).toHaveBeenCalledWith(
      99001n,
      expect.stringContaining("Never respond by simply repeating the request"),
    );
  });

  it("keeps the existing video when owner evidence is too brief", async () => {
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = true;
    mediaValidationMocks.validateVideo.mockResolvedValueOnce({
      ok: false,
      reason: "video_owner_too_brief",
      retryable: false,
    });
    const oldVideo = { type: "video" as const, video: "old_video", duration: 10 };
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: ["photo_1", "photo_2"],
        pendingProfileMedia: [
          { type: "photo", photo: "photo_1" },
          { type: "photo", photo: "photo_2" },
          oldVideo,
        ],
      },
      video: {
        file_id: "brief_video",
        file_unique_id: "brief_video_uid",
      },
      fromId: 99001,
    });

    await handleConversational(ctx as any);

    expect(ctx.session.pendingProfileMedia).toContainEqual(oldVideo);
    expect(prisma.profile.upsert).not.toHaveBeenCalled();
    expect(ticketMocks.grantVideoBonusIfEligible).not.toHaveBeenCalled();
    // The thinking-status sequence is torn down; the verdict lands as its own
    // message instead of editing the old static "checking…" line in place.
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("too briefly"));
  });

  it("asks for an identity photo before checking an early video", async () => {
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = true;
    mediaValidationMocks.validateVideo.mockResolvedValueOnce({
      ok: false,
      reason: "video_identity_reference_missing",
      retryable: false,
    });
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: [],
      },
      video: {
        file_id: "early_video",
        file_unique_id: "early_video_uid",
      },
      fromId: 99001,
    });

    await handleConversational(ctx as any);

    expect(prisma.profile.upsert).not.toHaveBeenCalled();
    expect(ticketMocks.grantVideoBonusIfEligible).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("profile photo first"),
    );
  });

  it("persists and rewards a video only after validation succeeds", async () => {
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = true;
    ticketMocks.grantVideoBonusIfEligible.mockResolvedValueOnce({
      granted: true,
      balance: 2,
    });
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: ["photo_1", "photo_2"],
      },
      video: {
        file_id: "validated_video",
        file_unique_id: "validated_video_uid",
      },
      fromId: 99001,
    });

    await handleConversational(ctx as any);

    expect(prisma.profile.upsert).toHaveBeenCalled();
    expect(ctx.session.pendingProfileMedia).toContainEqual(
      expect.objectContaining({
        type: "video",
        video: "validated_video",
        validationVersion: 1,
        validatedAt: expect.any(String),
      }),
    );
    expect(ticketMocks.sendTicketRewardDM).toHaveBeenCalledWith(
      ctx.api,
      99001,
      "en",
      "video",
      2,
    );
  });

  it("finalizes only after the user taps Continue", async () => {
    agentMock.mockResolvedValueOnce({
      reply: "Onboarding complete.",
      expectingPhoto: false,
      onboardingComplete: true,
      verificationRequired: false,
      contextPromptRequested: false,
      contextDumpStarted: false,
      contextDumpSaved: false,
    });
    const ctx = createMockCtx({
      session: {
        onboardingStep: "conversational",
        expectingPhoto: true,
        pendingPhotos: ["photo_1", "photo_2", "photo_3", "photo_4"],
      },
      callbackData: ONBOARDING_PHOTOS_CONTINUE_CALLBACK,
      fromId: 99001,
    });

    await handleConversational(ctx as any);

    expect(agentMock).toHaveBeenCalledWith(99001n, {
      kind: "photos_continue",
    });
    expect(ctx.session.onboardingStep).toBe("completed");
    expect(showMainMenu).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Verification CTA — Mini App + dev fallback to hosted URL
// ---------------------------------------------------------------------------

describe("sendVerificationCTABare", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the web_app Verification Mini App button (prod path) + Skip fallback", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "user-uuid",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) };

    const sent = await sendVerificationCTABare(api as any, 12345, 12345n, "en");

    expect(sent).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [, , options] = api.sendMessage.mock.calls[0]!;
    const keyboard = options.reply_markup.inline_keyboard;
    // Two rows now: web_app Verify button + Skip callback. The legacy
    // "I've finished" manual-check button was removed because the embedded
    // SDK posts back to /v1/verification/mini-app/event automatically.
    expect(keyboard).toHaveLength(2);
    expect(keyboard[0]?.[0]?.web_app?.url).toBe(
      "https://test.invalid/calendar/verification.html?lang=en",
    );
    expect(keyboard[0]?.[0]?.style).toBe("success");
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("1 free Date Ticket");
    expect(api.sendMessage.mock.calls[0]?.[1]).toContain("150");
    // Make sure we're NOT serving the legacy Persona URL or the legacy
    // verify:check callback — both should be gone from the CTA surface.
    expect(keyboard[0]?.[0]?.url).toBeUndefined();
    expect(keyboard[1]?.[0]?.callback_data).toBe(VERIFY_SKIP_CALLBACK);
    // Side-effect: status flipped to `pending` so the rest of the bot can
    // surface "review in progress" without waiting on the first Persona event.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-uuid" },
      data: { verificationStatus: "pending" },
    });
  });

  it("falls back to hosted Persona URL when WEBAPP_URL is the example.invalid placeholder", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "user-uuid",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) };

    // Temporarily flip the env mock to the dev-default placeholder. The
    // production prefix check is the only differentiator between web_app
    // and hosted-URL paths — see sendVerificationCTABare.
    const cfg = (await import("../../config.js")) as unknown as {
      env: Record<string, unknown>;
    };
    const prev = cfg.env.WEBAPP_URL;
    cfg.env.WEBAPP_URL = "https://example.invalid/calendar";
    try {
      const sent = await sendVerificationCTABare(api as any, 12345, 12345n, "en");
      expect(sent).toBe(true);
      const [, , options] = api.sendMessage.mock.calls[0]!;
      const keyboard = options.reply_markup.inline_keyboard;
      expect(keyboard[0]?.[0]?.url).toContain("withpersona.test");
      expect(keyboard[0]?.[0]?.url).toContain("start%3Dverify_done");
      expect(keyboard[0]?.[0]?.web_app).toBeUndefined();
      expect(keyboard[1]?.[0]?.callback_data).toBe(VERIFY_SKIP_CALLBACK);
    } finally {
      cfg.env.WEBAPP_URL = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Verification skip — idempotency
// ---------------------------------------------------------------------------

describe("handleVerificationSkip — soft skip (voice nudge + fork)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function createSoftSkipCtx(fromId = 1001) {
    const session: SessionData = { ...DEFAULT_SESSION };
    return {
      session,
      from: { id: fromId },
      chat: { id: fromId },
      callbackQuery: { data: "verify:skip" },
      reply: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      api: {
        sendVoice: vi.fn().mockResolvedValue({ voice: { file_id: "vf-en" } }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  }

  it("plays a native voice note with the reconsider/skip-anyway fork and applies NO penalty", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uid-1",
      verificationSkippedAt: null,
    });

    const ctx = createSoftSkipCtx();
    await handleVerificationSkip(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    // Native voice message (not a file/document, not plain text).
    expect(ctx.api.sendVoice).toHaveBeenCalledTimes(1);
    const [, , voiceOpts] = ctx.api.sendVoice.mock.calls[0]!;
    const keyboard = voiceOpts.reply_markup.inline_keyboard;
    // Fork: row 0 = reconsider/verify, row 1 = "Skip anyway" confirm callback.
    expect(keyboard[0]?.[0]?.style).toBe("success");
    expect(keyboard[1]?.[0]?.callback_data).toBe(VERIFY_SKIP_CONFIRM_CALLBACK);
    expect(keyboard[1]?.[0]?.style).toBe("danger");
    expect(keyboard[1]?.[0]?.text).toContain("Give up the bonus");
    expect(voiceOpts.caption).toContain("free ticket");
    expect(voiceOpts.caption).toContain("150");
    // No penalty, no activation — the soft skip only nudges.
    expect(prisma.profile.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(showMainMenu).not.toHaveBeenCalled();
    expect(pinStatusBanner).not.toHaveBeenCalled();
  });

  it("plays a native voice note in every onboarding language (en/ru/uk/de/pl)", async () => {
    for (const lang of ["en", "ru", "uk", "de", "pl"] as const) {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "uid-1",
        verificationSkippedAt: null,
      });
      const ctx = createSoftSkipCtx();
      ctx.session.language = lang;
      await handleVerificationSkip(ctx);
      // Voice (not text fallback) for all five — each has a bundled asset.
      expect(ctx.api.sendVoice).toHaveBeenCalledTimes(1);
      expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    }
  });

  it("already-skipped user: acks and does not re-play the nudge", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uid-1",
      verificationSkippedAt: new Date("2026-05-08T20:00:00Z"),
    });

    const ctx = createSoftSkipCtx();
    await handleVerificationSkip(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.api.sendVoice).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("handleVerificationSkipConfirm — idempotency", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function createSkipCtx(fromId = 1001) {
    const session: SessionData = { ...DEFAULT_SESSION };
    return {
      session,
      from: { id: fromId },
      chat: { id: fromId },
      callbackQuery: { data: "verify:skip:confirm" },
      reply: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      api: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  }

  it("first call: applies Elo penalty, activates, renders menu + banner exactly once", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uid-1",
      verificationSkippedAt: null,
    });
    (prisma.profile.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const ctx = createSkipCtx();
    await handleVerificationSkipConfirm(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(prisma.profile.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          verificationStatus: "unverified",
          status: "active",
          onboardingStep: "completed",
        }),
      }),
    );
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(showMainMenu).toHaveBeenCalledTimes(1);
    expect(pinStatusBanner).toHaveBeenCalledTimes(1);
  });

  it("second call (already skipped): early-returns after callback ack — no re-render of menu/banner", async () => {
    // Regression: pre-fix, a second tap on the Skip button (or a Telegram
    // callback retry) re-ran ctx.reply + showMainMenu + pinStatusBanner, which
    // was the user-reported "menu duplicates twice at the end of onboarding".
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uid-1",
      verificationSkippedAt: new Date("2026-05-08T20:00:00Z"),
    });

    const ctx = createSkipCtx();
    await handleVerificationSkipConfirm(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    // No DB writes — the user is already in the post-skip state.
    expect(prisma.profile.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    // No visible side-effects — the menu/banner from the first call still stand.
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(showMainMenu).not.toHaveBeenCalled();
    expect(pinStatusBanner).not.toHaveBeenCalled();
  });

  it("two rapid taps on the same Skip button render menu + banner only once", async () => {
    // First tap: row exists, verificationSkippedAt=null → full path runs.
    // Second tap (immediately after): row now has verificationSkippedAt set,
    // so the gate trips and we ack-only.
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: "uid-1", verificationSkippedAt: null })
      .mockResolvedValueOnce({
        id: "uid-1",
        verificationSkippedAt: new Date("2026-05-08T20:00:00Z"),
      });
    (prisma.profile.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 1 });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

    const ctx1 = createSkipCtx();
    const ctx2 = createSkipCtx();
    await handleVerificationSkipConfirm(ctx1);
    await handleVerificationSkipConfirm(ctx2);

    // Penalty applied once, menu rendered once, banner pinned once.
    expect(prisma.profile.updateMany).toHaveBeenCalledTimes(1);
    expect(showMainMenu).toHaveBeenCalledTimes(1);
    expect(pinStatusBanner).toHaveBeenCalledTimes(1);
    expect(ctx1.reply).toHaveBeenCalledTimes(1);
    expect(ctx2.reply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Registration v2 — mandatory liveness (MANDATORY_VERIFICATION_ENABLED)
// ---------------------------------------------------------------------------

describe("mandatory verification (Registration v2)", () => {
  const cfgPromise = import("../../config.js") as unknown as Promise<{
    env: Record<string, unknown>;
  }>;

  beforeEach(async () => {
    vi.resetAllMocks();
    (await cfgPromise).env.MANDATORY_VERIFICATION_ENABLED = true;
  });
  afterEach(async () => {
    (await cfgPromise).env.MANDATORY_VERIFICATION_ENABLED = false;
  });

  function createSkipCtx(callback: string, fromId = 1001) {
    const session: SessionData = { ...DEFAULT_SESSION };
    return {
      session,
      from: { id: fromId },
      chat: { id: fromId },
      callbackQuery: { data: callback },
      reply: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      api: {
        sendVoice: vi.fn().mockResolvedValue({ voice: { file_id: "vf-en" } }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  }

  it("CTA carries only the Verify button (no Skip) and the mandatory pitch", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "user-uuid",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) };

    const sent = await sendVerificationCTABare(api as any, 12345, 12345n, "en");

    expect(sent).toBe(true);
    const [, text, options] = api.sendMessage.mock.calls[0]!;
    const keyboard = options.reply_markup.inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]?.[0]?.web_app?.url).toContain("verification.html");
    expect(text).toContain("Verification is required");
    // Re-arm the re-engagement chain so a stall at this CTA still gets nudges.
    const updateArg = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(updateArg.data.verificationStatus).toBe("pending");
    expect(updateArg.data.reEngagementStep).toBe(0);
    expect(updateArg.data.reEngagementNextAt).toBeInstanceOf(Date);
  });

  it("legacy Skip tap: no voice fork — mandatory notice + Verify button instead", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uid-1",
      verificationSkippedAt: null,
    });

    const ctx = createSkipCtx("verify:skip");
    await handleVerificationSkip(ctx);

    expect(ctx.api.sendVoice).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).toHaveBeenCalledTimes(1);
    const [, text, options] = ctx.api.sendMessage.mock.calls[0]!;
    expect(text).toContain("required");
    expect(options.reply_markup.inline_keyboard[0]?.[0]?.web_app?.url).toContain(
      "verification.html",
    );
    expect(prisma.profile.updateMany).not.toHaveBeenCalled();
  });

  it("stale 'Skip anyway' tap: refuses — no penalty, no unverified activation", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uid-1",
      verificationSkippedAt: null,
    });

    const ctx = createSkipCtx("verify:skip:confirm");
    await handleVerificationSkipConfirm(ctx);

    expect(prisma.profile.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(showMainMenu).not.toHaveBeenCalled();
    expect(pinStatusBanner).not.toHaveBeenCalled();
    expect(ctx.api.sendMessage).toHaveBeenCalledTimes(1);
    const [, text] = ctx.api.sendMessage.mock.calls[0]!;
    expect(text).toContain("required");
  });

  it("already-skipped legacy user stays grandfathered (ack only, no notice)", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uid-1",
      verificationSkippedAt: new Date("2026-05-08T20:00:00Z"),
    });

    const ctx = createSkipCtx("verify:skip:confirm");
    await handleVerificationSkipConfirm(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    expect(prisma.profile.updateMany).not.toHaveBeenCalled();
  });
});
