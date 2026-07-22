import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    profile: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "test-key",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    SMTP_FROM: "test@test.com",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    CUSTOM_EMOJI_MENU_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

vi.mock("./email.js", () => ({
  sendOtpEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./profile-analysis.js", () => ({
  analyseAndSaveProfile: vi.fn().mockResolvedValue({
    parsed: { schema_version: 2 },
    embeddingSaved: false,
  }),
  extractJsonSummary: vi.fn(() => null),
  isValidFastPathSummary: vi.fn(() => false),
  saveFallbackProfileAnalysis: vi.fn().mockResolvedValue({
    summary: "fallback",
    embeddingSaved: false,
  }),
  appendVibeToSummary: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./vibe-axes.js", () => ({
  extractVibeAxes: vi.fn().mockResolvedValue(null),
  saveVibeAxes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../public/otp.js", () => ({
  createAndSendOtp: vi.fn().mockResolvedValue(undefined),
  verifyOtp: vi.fn().mockResolvedValue({ ok: true }),
}));

import { prisma } from "@gennety/db";
import { contextDumpInstruction } from "@gennety/shared";
import { env } from "../config.js";
import { typeRadarInviteCopy } from "./type-radar-copy.js";
import { createAndSendOtp, verifyOtp } from "../public/otp.js";
import { extractVibeAxes, saveVibeAxes } from "./vibe-axes.js";
import { runAgentTurn, injectSystemMessage, truncateForApi, summarizeHistory } from "./onboarding-agent.js";
import type { ChatMessage } from "./onboarding-agent.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock OpenAI response with a text reply (no tool calls) */
function textResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: { role: "assistant", content, tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
    }),
    text: async () => "",
  };
}

/** Build a mock OpenAI response with tool calls */
function toolCallResponse(
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
) {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    text: async () => "",
  };
}

function contextDumpSavedHistory(): ChatMessage[] {
  return [
    { role: "system", content: "system prompt..." },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-save-context",
          type: "function",
          function: { name: "save_context_dump", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call-save-context",
      content: JSON.stringify({ success: true }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("onboarding-agent", () => {
  const telegramId = BigInt(12345);

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.profile.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("returns the assistant text reply on a simple turn", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      textResponse("Hello! Welcome to Gennety."),
    );

    const result = await runAgentTurn(telegramId, "hi", { fetchFn: mockFetch });

    expect(result.reply).toBe("Hello! Welcome to Gennety.");
    expect(result.expectingPhoto).toBe(false);
    expect(result.onboardingComplete).toBe(false);

    // Should persist history
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { telegramId },
        data: expect.objectContaining({
          lastMessageAt: expect.any(Date),
        }),
      }),
    );
  });

  it("deduplicates an accidentally repeated assistant bubble before replying and persisting", async () => {
    const duplicate =
      "Понял: Alexey, 24.\nКто тебе нравится — парни, девушки или оба?\n" +
      "Понял: Alexey, 24.\nКто тебе нравится — парни, девушки или оба?";
    const mockFetch = vi.fn().mockResolvedValueOnce(textResponse(duplicate));

    const result = await runAgentTurn(telegramId, "my name is Alexey", { fetchFn: mockFetch });

    expect(result.reply).toBe("Понял: Alexey, 24.\nКто тебе нравится — парни, девушки или оба?");
    const persisted = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      .data.messageHistory as ChatMessage[];
    const assistant = [...persisted].reverse().find((m: ChatMessage) => m.role === "assistant");
    expect(assistant?.content).toBe(result.reply);
  });

  it("executes send_otp_email tool and feeds result back to LLM", async () => {
    const mockFetch = vi
      .fn()
      // First call: LLM wants to send OTP
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "send_otp_email",
            args: { email: "alice@stanford.edu" },
          },
        ]),
      )
      // Second call: LLM responds with text after tool result
      .mockResolvedValueOnce(
        textResponse("I've sent you a verification code! Check your email."),
      );

    const result = await runAgentTurn(telegramId, "my email is alice@stanford.edu", {
      fetchFn: mockFetch,
      sendOtp: vi.fn().mockResolvedValue(undefined),
    });

    expect(createAndSendOtp).toHaveBeenCalledWith(
      "alice@stanford.edu",
      expect.any(Function),
    );
    expect(result.reply).toBe("I've sent you a verification code! Check your email.");

    // User email was stored in DB; raw OTP is no longer persisted on the user row.
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "alice@stanford.edu",
          universityDomain: "stanford.edu",
        }),
      }),
    );
  });

  it("rejects non-university email via tool result", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "send_otp_email",
            args: { email: "alice@gmail.com" },
          },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("That's not a university email. Please use your .edu address."),
      );

    const result = await runAgentTurn(telegramId, "my email is alice@gmail.com", {
      fetchFn: mockFetch,
    });

    expect(result.reply).toContain("not a university email");
    // OTP should NOT have been sent
    expect(prisma.user.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: "alice@gmail.com" }),
      }),
    );
  });

  it("sets expectingPhoto=true when request_photos is called and the context dump is already saved", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uuid-1",
      messageHistory: contextDumpSavedHistory(),
      language: "en",
      aiMemoryExportPreference: "accepted",
      email: "alice@stanford.edu",
      isEmailVerified: true,
      universityDomain: "stanford.edu",
      firstName: "Alice",
      age: 21,
      gender: "female",
      preference: "men",
      profile: {
        height: 165,
        ethnicity: "Asian",
        hobbies: ["tennis"],
        partnerPreferences: "someone kind",
        photos: [],
        homeCityKey: "ua:kyiv",
      },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "request_photos", args: {} },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("Now send me 2-4 photos of yourself!"),
      );

    const result = await runAgentTurn(telegramId, "ready for photos", {
      fetchFn: mockFetch,
    });

    expect(result.expectingPhoto).toBe(true);
    expect(result.reply).toContain("photos");
  });

  it("allows request_photos when the collector already completed context_dump (no tool-result marker)", async () => {
    // Regression: a typed context dump is saved by the collector, which records
    // success only in onboardingProgress.completedFields and pushes a receipt
    // marker (not the CONTEXT_DUMP_SAVED tool marker). If the tool-loop path
    // then runs (e.g. ONBOARDING_FACT_COLLECTOR_ENABLED off), request_photos
    // must not be blocked into a paste loop.
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
      aiMemoryExportPreference: "accepted",
      email: "alice@stanford.edu",
      isEmailVerified: true,
      universityDomain: "stanford.edu",
      firstName: "Alice",
      age: 21,
      gender: "female",
      preference: "men",
      onboardingProgress: { completedFields: ["context_dump"] },
      profile: {
        height: 165,
        ethnicity: "Asian",
        hobbies: ["tennis"],
        partnerPreferences: "someone kind",
        photos: [],
        homeCityKey: "ua:kyiv",
      },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call-1", name: "request_photos", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("Now send me your photos!"));

    const result = await runAgentTurn(telegramId, "ready for photos", {
      fetchFn: mockFetch,
    });

    expect(result.expectingPhoto).toBe(true);
  });

  it("stops immediately after request_context_dump so the model cannot synthesize the user's dump", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: [],
      language: "ru",
      email: null,
      universityDomain: null,
      isEmailVerified: false,
      profile: {
        ethnicity: "Ukrainian",
        height: 180,
        hobbies: ["reading"],
        partnerPreferences: "someone kind",
        photos: [],
      },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-ctx", name: "request_context_dump", args: {} },
          {
            id: "call-save",
            name: "save_context_dump",
            args: { raw_dump: "x".repeat(1000) },
          },
          { id: "call-photos", name: "request_photos", args: {} },
        ]),
      )
      .mockResolvedValueOnce(textResponse("This response must never be used."));
    const mockAnalyse = vi.fn().mockResolvedValue({
      parsed: { schema_version: 2 },
      embeddingSaved: true,
    });

    const result = await runAgentTurn(telegramId, "готово, дай промпт", {
      fetchFn: mockFetch,
      analyseProfile: mockAnalyse,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockAnalyse).not.toHaveBeenCalled();
    expect(result.contextPromptRequested).toBe(true);
    expect(result.contextDumpStarted).toBe(true);
    expect(result.expectingPhoto).toBe(false);
    expect(result.reply).toBe(contextDumpInstruction("ru"));

    const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemPrompt = requestBody.messages.find(
      (message: { role: string }) => message.role === "system",
    )?.content as string;
    expect(systemPrompt).not.toContain("Telegram");

    const updateCalls = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls;
    const persistedHistory = updateCalls.at(-1)?.[0].data.messageHistory as Array<{
      role: string;
      tool_calls?: Array<{ function: { name: string } }>;
    }>;
    const persistedToolNames = persistedHistory.flatMap((m) =>
      m.tool_calls?.map((call) => call.function.name) ?? [],
    );
    expect(persistedToolNames).toEqual(["request_context_dump"]);
  });

  it("blocks request_context_dump until ethnicity has been asked once", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: [],
      language: "ru",
      email: "alice@stanford.edu",
      universityDomain: "stanford.edu",
      isEmailVerified: true,
      firstName: "Алексей",
      age: 24,
      gender: "male",
      preference: "women",
      profile: {
        ethnicity: null,
        height: 176,
        hobbies: ["готовка"],
        partnerPreferences: "девушка, которая любит готовить",
        photos: [],
      },
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call-ctx", name: "request_context_dump", args: {} }]),
      )
      .mockResolvedValueOnce(
        textResponse("Как ты описываешь своё происхождение или национальность? Можно пропустить"),
      );

    const result = await runAgentTurn(telegramId, "готово, дай промпт", {
      fetchFn: mockFetch,
    });

    expect(result.contextPromptRequested).toBe(false);
    expect(result.reply).toContain("национальность");
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = secondCallBody.messages.find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(JSON.parse(toolMessage.content).error).toContain("ethnicity");
  });

  it("allows request_context_dump after ethnicity was already asked once", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: [
        { role: "system", content: "system prompt..." },
        { role: "assistant", content: "Как ты описываешь своё происхождение или национальность? Можно пропустить" },
        { role: "user", content: "пропустим" },
      ],
      language: "ru",
      email: "alice@stanford.edu",
      universityDomain: "stanford.edu",
      isEmailVerified: true,
      firstName: "Алексей",
      age: 24,
      gender: "male",
      preference: "women",
      profile: {
        ethnicity: null,
        height: 176,
        hobbies: ["готовка"],
        partnerPreferences: "девушка, которая любит готовить",
        photos: [],
      },
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call-ctx", name: "request_context_dump", args: {} }]),
      );

    const result = await runAgentTurn(telegramId, "ок дальше", {
      fetchFn: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.contextPromptRequested).toBe(true);
    expect(result.reply).toBe(contextDumpInstruction("ru"));
  });

  describe("Type Radar gate (step 5B)", () => {
    const radarUser = (typeRadarCompletedAt: Date | null) => ({
      id: "uuid-1",
      messageHistory: [
        { role: "assistant", content: "Как ты описываешь своё происхождение? Можно пропустить" },
        { role: "user", content: "пропустим" },
      ],
      language: "ru",
      email: "alice@stanford.edu",
      universityDomain: "stanford.edu",
      isEmailVerified: true,
      firstName: "Алексей",
      age: 24,
      gender: "male",
      preference: "women",
      profile: {
        ethnicity: null,
        height: 176,
        hobbies: ["готовка"],
        partnerPreferences: "девушка",
        photos: [],
        typeRadarCompletedAt,
      },
    });

    afterEach(() => {
      (env as { TYPE_RADAR_ENABLED?: boolean }).TYPE_RADAR_ENABLED = false;
    });

    it("intercepts request_context_dump before the Magic Prompt when enabled and not completed", async () => {
      (env as { TYPE_RADAR_ENABLED?: boolean }).TYPE_RADAR_ENABLED = true;
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(radarUser(null));
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          toolCallResponse([{ id: "call-ctx", name: "request_context_dump", args: {} }]),
        );

      const result = await runAgentTurn(telegramId, "ок дальше", { fetchFn: mockFetch });

      expect(result.typeRadarRequested).toBe(true);
      expect(result.contextPromptRequested).toBe(false);
      expect(result.contextDumpStarted).toBe(false);
      expect(result.reply).toBe(typeRadarInviteCopy("ru").intro);
    });

    it("lets request_context_dump through once the radar is completed", async () => {
      (env as { TYPE_RADAR_ENABLED?: boolean }).TYPE_RADAR_ENABLED = true;
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        radarUser(new Date()),
      );
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(
          toolCallResponse([{ id: "call-ctx", name: "request_context_dump", args: {} }]),
        );

      const result = await runAgentTurn(telegramId, "ок дальше", { fetchFn: mockFetch });

      expect(result.typeRadarRequested).toBe(false);
      expect(result.contextPromptRequested).toBe(true);
    });
  });

  it("saves the user's latest pasted message as the dump, ignoring any LLM rephrasing in raw_dump", async () => {
    // Real bug: LLMs auto-correct one or two characters when they pass long
    // text through tool args (e.g. "том" → "то"), which used to fail strict
    // verbatim grounding and reject the user's perfectly valid paste.
    // The fix: treat raw_dump as advisory and use the user's actual paste.
    const userPaste = JSON.stringify({
      personality_traits: ["curious", "calm", "warm", "direct", "romantic"],
      communication_style: "Direct and reflective.",
      interests: ["music", "piano", "dating"],
      values: ["honesty", "warmth", "stability"],
      attachment_style: "secure",
      social_energy: "ambivert",
      humor_style: "warm",
      ideal_partner: "Someone emotionally present and sincere.",
      dealbreakers: ["dishonesty", "coldness"],
      summary:
        "A warm, music-oriented person who wants grounded closeness without performance. He values simple honesty, tenderness, and a relationship that feels calm rather than dramatic.",
    });
    const llmRephrased = userPaste.replace("warm,", "warm and"); // single-char drift
    const mockAnalyse = vi.fn().mockResolvedValue({
      parsed: { schema_version: 2 },
      embeddingSaved: true,
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
      })
      .mockResolvedValueOnce({
        id: "uuid-1",
        firstName: "Alice",
        language: "en",
      });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-save",
            name: "save_context_dump",
            args: { raw_dump: llmRephrased },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("Profile saved. Send photos next."));

    const result = await runAgentTurn(telegramId, userPaste, {
      fetchFn: mockFetch,
      analyseProfile: mockAnalyse,
    });

    // Server uses the user's actual paste, not the LLM's rephrased copy.
    expect(mockAnalyse).toHaveBeenCalledWith("uuid-1", userPaste, undefined, {
      firstName: "Alice",
      language: "en",
    });
    expect(result.reply).toContain("Profile saved");
    const persisted = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      .data.messageHistory as ChatMessage[];
    expect(persisted.some((message) => message.content === userPaste)).toBe(false);
    expect(
      persisted.some((message) =>
        message.content?.includes("raw content intentionally not retained"),
      ),
    ).toBe(true);
    // The advisory raw_dump tool argument must not smuggle a copy of the paste
    // into persisted history (the LLM echoed `llmRephrased` there).
    const persistedToolArgs = persisted
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function.arguments)
      .join("\n");
    expect(persistedToolArgs).not.toContain("music-oriented");
    expect(persistedToolArgs).not.toContain(llmRephrased);
  });

  it("rejects save_context_dump when the user's latest message is too short to be a real dump", async () => {
    // Hallucination guard: if the LLM calls save_context_dump while the user
    // hasn't actually pasted anything substantial (< 200 chars), reject —
    // even if the LLM tries to fabricate content via raw_dump.
    const mockAnalyse = vi.fn().mockResolvedValue({ parsed: null, embeddingSaved: true });
    const fabricatedDump =
      "A".repeat(220) +
      " fabricated psychological analysis that was never pasted by the user.";
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-save",
            name: "save_context_dump",
            args: { raw_dump: fabricatedDump },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("Please paste the actual AI response first."));

    await runAgentTurn(telegramId, "да, давай дальше", {
      fetchFn: mockFetch,
      analyseProfile: mockAnalyse,
    });

    expect(mockAnalyse).not.toHaveBeenCalled();
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = secondCallBody.messages.find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(JSON.parse(toolMessage.content).error).toContain("too short");
  });

  it("blocks request_photos when the context dump has not been saved yet (LLM ordering violation)", async () => {
    // Defense-in-depth: even though the system prompt forbids it, an LLM may
    // skip straight to photos. The guard must require a successful
    // save_context_dump tool result, not merely a Profile.psychologicalSummary
    // row, because save_profile_data used to generate a synthetic summary.
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
      profile: { psychologicalSummary: "Synthetic field summary" },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "request_photos", args: {} },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("Sorry, please paste your AI analysis first."),
      );

    const result = await runAgentTurn(telegramId, "anything", {
      fetchFn: mockFetch,
    });

    expect(result.expectingPhoto).toBe(false);
    // The second OpenAI request will see the tool error message; we don't
    // assert exact reply text since the model is mocked, but expectingPhoto
    // staying false is the load-bearing check — photo upload mode is gated.
  });

  it("also blocks request_photos when the user has no profile row at all", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
      profile: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "request_photos", args: {} },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("Need to do the analysis step first."),
      );

    const result = await runAgentTurn(telegramId, "skip ahead", {
      fetchFn: mockFetch,
    });

    expect(result.expectingPhoto).toBe(false);
  });

  it("allows request_photos without a context dump when AI memory export was declined", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
      aiMemoryExportPreference: "declined",
      email: "alice@stanford.edu",
      isEmailVerified: true,
      firstName: "Alice",
      age: 21,
      gender: "female",
      preference: "men",
      profile: {
        ethnicity: "Asian",
        height: 165,
        hobbies: ["tennis"],
        partnerPreferences: "someone kind",
        photos: [],
        homeCityKey: "ua:kyiv",
      },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call-1", name: "request_photos", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("Send me two photos."));

    const result = await runAgentTurn(telegramId, "ready for photos", {
      fetchFn: mockFetch,
    });

    expect(result.expectingPhoto).toBe(true);
  });

  it("blocks request_photos after AI memory decline when required profile fields are missing", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
      aiMemoryExportPreference: "declined",
      email: "alice@stanford.edu",
      isEmailVerified: true,
      firstName: "Alice",
      age: 21,
      profile: {
        ethnicity: null,
        height: null,
        hobbies: [],
        partnerPreferences: null,
        photos: [],
        homeCityKey: "ua:kyiv",
      },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call-1", name: "request_photos", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("I still need a couple of details first."));

    const result = await runAgentTurn(telegramId, "photos?", { fetchFn: mockFetch });

    expect(result.expectingPhoto).toBe(false);
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = secondCallBody.messages.find(
      (m: { role: string }) => m.role === "tool",
    );
    const toolContent = JSON.parse(toolMessage.content);
    expect(toolContent.success).toBe(false);
    expect(toolContent.error).toContain("gender");
    expect(toolContent.error).toContain("ethnicity_question");
  });

  it("sets onboardingComplete=true when finalize_onboarding is called with complete data", async () => {
    const saveFallbackProfile = vi.fn().mockResolvedValue({
      summary: "fallback",
      embeddingSaved: true,
    });
    // finalize_onboarding now checks DB for completeness — mock a complete profile
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: contextDumpSavedHistory(),
        language: "en",
        aiMemoryExportPreference: "accepted",
      })
      .mockResolvedValueOnce({
        id: "uuid-1",
        firstName: "Alice",
        age: 21,
        gender: "female",
        preference: "men",
        email: "alice@stanford.edu",
        isEmailVerified: true,
        termsAccepted: true,
        aiMemoryExportPreference: "accepted",
        profile: {
          ethnicity: null,
          height: 165,
          hobbies: ["tennis", "reading"],
          partnerPreferences: "someone kind and funny",
          psychologicalSummary: "",
          photos: ["photo1", "photo2", "photo3", "photo4"],
          homeCityKey: "ua:kyiv",
        },
      });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "finalize_onboarding", args: {} },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("You're all set! Welcome to Gennety!"),
      );

    const result = await runAgentTurn(telegramId, "looks good, finish up", {
      fetchFn: mockFetch,
      saveFallbackProfile,
    });

    expect(result.onboardingComplete).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          onboardingStep: "completed",
          status: "active",
        }),
      }),
    );

    const updateCalls = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls;
    const finalPersist = updateCalls.at(-1)?.[0];
    expect(finalPersist).toBeDefined();
    expect(finalPersist.data).toEqual(
      expect.objectContaining({
        lastMessageAt: expect.any(Date),
        reEngagementStep: 0,
        reEngagementNextAt: null,
      }),
    );
    expect(saveFallbackProfile).toHaveBeenCalledWith(
      "uuid-1",
      expect.objectContaining({ source: "no_relevant_ai_memory" }),
    );
  });

  it("finalizes the optional media stage directly without calling OpenAI", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        onboardingStep: "conversational",
        language: "en",
        aiMemoryExportPreference: "accepted",
        onboardingProgress: {
          completedFields: ["context_dump", "photos"],
        },
      })
      .mockResolvedValueOnce({
        id: "uuid-1",
        firstName: "Alice",
        age: 21,
        gender: "female",
        preference: "men",
        email: "alice@stanford.edu",
        isEmailVerified: true,
        termsAccepted: true,
        aiMemoryExportPreference: "accepted",
        profile: {
          ethnicity: null,
          height: 165,
          hobbies: ["tennis"],
          partnerPreferences: "someone kind",
          photos: ["photo1", "photo2", "photo3", "photo4"],
          homeCityKey: "ua:kyiv",
        },
      })
      .mockResolvedValueOnce({
        messageHistory: [],
        language: "en",
      });
    const mockFetch = vi.fn();

    const result = await runAgentTurn(
      telegramId,
      { kind: "photos_continue" },
      { fetchFn: mockFetch },
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.onboardingComplete).toBe(true);
    expect(result.expectingPhoto).toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ onboardingStep: "completed" }),
      }),
    );
  });

  it("finalize_onboarding rejects when required profile data is missing", async () => {
    // Mock: user has no profile data saved yet
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
      })
      .mockResolvedValueOnce({
        firstName: "Alice",
        age: 21,
        gender: "female",
        preference: "men",
        email: "alice@stanford.edu",
        isEmailVerified: true,
        termsAccepted: true,
        profile: {
          height: null,
          hobbies: [],
          partnerPreferences: null,
          photos: [],
        },
      });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "finalize_onboarding", args: {} },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("I need to collect more info before we can finish."),
      );

    const result = await runAgentTurn(telegramId, "finish up", {
      fetchFn: mockFetch,
    });

    // Should NOT be marked complete — the tool returned an error
    expect(result.onboardingComplete).toBe(false);

    // Verify the tool result sent back to LLM contains the missing fields
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = secondCallBody.messages.find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMessage).toBeDefined();
    const toolContent = JSON.parse(toolMessage.content);
    expect(toolContent.success).toBe(false);
    expect(toolContent.error).toContain("missing required data");
    expect(toolContent.error).toContain("height");
    // Hobbies are intentionally NOT a blocking requirement — whatever the user
    // shares (including an empty list) is a valid answer.
    expect(toolContent.error).not.toContain("hobbies");
    expect(toolContent.error).toContain("partner_preferences");
    expect(toolContent.error).toContain("photos");
  });

  it("finalizes without context dump and saves fallback analysis when export was declined", async () => {
    const saveFallbackProfile = vi.fn().mockResolvedValue({
      summary: "fallback",
      embeddingSaved: true,
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
        aiMemoryExportPreference: "declined",
      })
      .mockResolvedValueOnce({
        id: "uuid-1",
        firstName: "Alice",
        age: 21,
        gender: "female",
        preference: "men",
        email: "alice@stanford.edu",
        isEmailVerified: true,
        termsAccepted: true,
        aiMemoryExportPreference: "declined",
        profile: {
          ethnicity: "Ukrainian",
          height: 165,
          hobbies: ["tennis", "reading"],
          partnerPreferences: "someone kind and funny",
          fridayVibeText: "quiet dinner at home with one close friend",
          vibeFocusText: "who's there",
          photos: ["photo1", "photo2", "photo3", "photo4"],
          homeCityKey: "ua:kyiv",
        },
      });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      profile: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call-1", name: "finalize_onboarding", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("You're all set."));

    const result = await runAgentTurn(telegramId, "finish", {
      fetchFn: mockFetch,
      saveFallbackProfile,
    });

    expect(result.onboardingComplete).toBe(true);
    expect(saveFallbackProfile).toHaveBeenCalledWith("uuid-1", {
      firstName: "Alice",
      age: 21,
      gender: "female",
      preference: "men",
      height: 165,
      ethnicity: "Ukrainian",
      hobbies: ["tennis", "reading"],
      partnerPreferences: "someone kind and funny",
      homeCityKey: "ua:kyiv",
      fridayVibe: "quiet dinner at home with one close friend",
      vibeFocus: "who's there",
      source: "declined",
    });
  });

  it("does not re-extract vibe axes on a finalize retry once already extracted", async () => {
    // A finalize that runs after vibe axes were already stamped must NOT call
    // the extractor again — a transient LLM failure would return null and wipe
    // the good axes. Guard: `profile.vibeExtractedAt` is set.
    const saveFallbackProfile = vi.fn().mockResolvedValue({
      summary: "fallback",
      embeddingSaved: true,
    });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
        aiMemoryExportPreference: "declined",
      })
      .mockResolvedValueOnce({
        id: "uuid-1",
        firstName: "Alice",
        age: 21,
        gender: "female",
        preference: "men",
        email: "alice@stanford.edu",
        isEmailVerified: true,
        termsAccepted: true,
        aiMemoryExportPreference: "declined",
        profile: {
          ethnicity: "Ukrainian",
          height: 165,
          hobbies: ["tennis"],
          partnerPreferences: "kind and funny",
          fridayVibeText: "quiet dinner at home",
          vibeFocusText: "who's there",
          vibeExtractedAt: new Date("2026-07-20T00:00:00.000Z"),
          photos: ["p1", "p2", "p3", "p4"],
          homeCityKey: "ua:kyiv",
        },
      });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      profile: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call-1", name: "finalize_onboarding", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("You're all set."));

    const result = await runAgentTurn(telegramId, "finish", {
      fetchFn: mockFetch,
      saveFallbackProfile,
    });

    expect(result.onboardingComplete).toBe(true);
    expect(extractVibeAxes).not.toHaveBeenCalled();
    expect(saveVibeAxes).not.toHaveBeenCalled();
  });

  it("handles verify_otp with correct code", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
      })
      .mockResolvedValueOnce({
        email: "alice@stanford.edu",
      });
    (verifyOtp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "verify_otp", args: { code: "123456" } },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("Email verified! Let's continue."),
      );

    const result = await runAgentTurn(telegramId, "123456", {
      fetchFn: mockFetch,
    });

    expect(result.reply).toContain("verified");
    expect(verifyOtp).toHaveBeenCalledWith("alice@stanford.edu", "123456");
  });

  it("handles verify_otp with wrong code", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
      })
      .mockResolvedValueOnce({
        email: "alice@stanford.edu",
      });
    (verifyOtp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "mismatch",
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "verify_otp", args: { code: "000000" } },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("That code doesn't match. Try again?"),
      );

    const result = await runAgentTurn(telegramId, "000000", {
      fetchFn: mockFetch,
    });

    expect(result.reply).toContain("doesn't match");
  });

  it("executes resend_otp tool and sends a new code", async () => {
    // First findUnique: history lookup in runAgentTurn
    // Second findUnique: email lookup in execResendOtp
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
      })
      .mockResolvedValueOnce({
        email: "alice@stanford.edu",
      });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "resend_otp", args: {} },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("I've resent the code to your email!"),
      );

    const result = await runAgentTurn(telegramId, "I didn't get the code", {
      fetchFn: mockFetch,
      sendOtp: vi.fn().mockResolvedValue(undefined),
    });

    expect(createAndSendOtp).toHaveBeenCalledWith(
      "alice@stanford.edu",
      expect.any(Function),
    );
    expect(result.reply).toContain("resent");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { emailOtp: null, emailOtpExpiresAt: null } }),
    );
  });

  it("resend_otp returns error when email sending fails", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
      })
      .mockResolvedValueOnce({
        email: "alice@stanford.edu",
      });
    (createAndSendOtp as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("SMTP failed"));

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "resend_otp", args: {} },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("Sorry, I couldn't send the email. Please try again."),
      );

    await runAgentTurn(telegramId, "resend code please", {
      fetchFn: mockFetch,
      sendOtp: vi.fn().mockResolvedValue(undefined),
    });

    // The tool result should indicate failure so the LLM can inform the user
    const toolResultMsg = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = toolResultMsg.messages.find(
      (m: { role: string }) => m.role === "tool",
    );
    expect(toolMessage).toBeDefined();
    const toolContent = JSON.parse(toolMessage.content);
    expect(toolContent.success).toBe(false);
    expect(toolContent.error).toContain("Failed to resend");
  });

  it("resend_otp returns error when no email on file", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
      })
      .mockResolvedValueOnce({
        email: null,
      });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "resend_otp", args: {} },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("I don't have your email yet. What's your university email?"),
      );

    const result = await runAgentTurn(telegramId, "resend code", {
      fetchFn: mockFetch,
    });

    expect(result.reply).toContain("email");
  });

  it("persists conversation history across turns", async () => {
    const priorHistory = [
      { role: "system", content: "system prompt..." },
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hi there!" },
    ];

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: priorHistory,
      language: "en",
    });

    const mockFetch = vi.fn().mockResolvedValueOnce(
      textResponse("Nice to see you again!"),
    );

    await runAgentTurn(telegramId, "I'm back", { fetchFn: mockFetch });

    // The messages sent to OpenAI should include prior history + new user message
    const calledWith = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(calledWith.messages).toHaveLength(5); // 3 prior + DB state snapshot + 1 new user
    expect(calledWith.messages[1].content).toContain("[CURRENT_SAVED_ONBOARDING_STATE]");
    expect(calledWith.messages[4].content).toBe("I'm back");
  });

  it("injects current DB onboarding state into the API call without persisting the snapshot", async () => {
    const priorHistory = [
      { role: "system", content: "system prompt..." },
      { role: "assistant", content: "What is your height?" },
    ];

    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: priorHistory,
      language: "en",
      email: "alice@stanford.edu",
      isEmailVerified: true,
      universityDomain: "stanford.edu",
      firstName: "Alice",
      age: 21,
      gender: "female",
      preference: "men",
      aiMemoryExportPreference: "accepted",
      profile: {
        ethnicity: null,
        height: 165,
        hobbies: ["tennis"],
        partnerPreferences: "someone kind",
        photos: [],
        homeCityKey: "ua:kyiv",
      },
    });

    const mockFetch = vi.fn().mockResolvedValueOnce(
      textResponse("Got it, let's do the AI profile step."),
    );

    await runAgentTurn(telegramId, "I already gave you that", { fetchFn: mockFetch });

    const calledWith = JSON.parse(mockFetch.mock.calls[0][1].body);
    const snapshot = calledWith.messages.find(
      (m: { role: string; content?: string }) =>
        m.role === "system" && m.content?.includes("[CURRENT_SAVED_ONBOARDING_STATE]"),
    );
    expect(snapshot).toBeDefined();
    expect(snapshot?.content).toContain("height=165");
    expect(snapshot?.content).toContain("Missing next: context_dump");

    const persisted = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
      .data.messageHistory as ChatMessage[];
    expect(
      persisted.some((m) => m.content?.includes("[CURRENT_SAVED_ONBOARDING_STATE]")),
    ).toBe(false);
  });

  it("handles save_profile_data tool correctly", async () => {
    const mockAnalyse = vi.fn().mockResolvedValue({ parsed: null, embeddingSaved: true });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
    }).mockResolvedValueOnce({
      id: "uuid-1",
      profile: null,
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "save_profile_data",
            args: {
              first_name: "Alice",
              age: 21,
              gender: "female",
              preference: "men",
              ethnicity: "Asian",
              height: 165,
              hobbies: ["tennis", "reading"],
              partner_preferences: "someone kind and funny",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        textResponse("Profile saved!"),
      );

    const result = await runAgentTurn(
      telegramId,
      "I'm Alice, 21, female, into men. I'm Asian, 165 cm, I like tennis and reading, and I want someone kind and funny.",
      {
      fetchFn: mockFetch,
      analyseProfile: mockAnalyse,
      },
    );

    expect(result.reply).toBe("Profile saved!");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstName: "Alice",
          age: 21,
          gender: "female",
          preference: "men",
        }),
      }),
    );
    expect(prisma.profile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          ethnicity: "Asian",
          height: 165,
          hobbies: ["tennis", "reading"],
          partnerPreferences: "someone kind and funny",
        }),
      }),
    );
  });

  it("does not persist placeholder ethnicity values as real profile data", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uuid-1",
      messageHistory: [],
      language: "ru",
    }).mockResolvedValueOnce({
      id: "uuid-1",
      profile: null,
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "save_profile_data",
            args: {
              first_name: "Алексей",
              age: 24,
              gender: "male",
              preference: "women",
              ethnicity: "не указано",
              height: 176,
              hobbies: ["готовка"],
              partner_preferences: "девушка, которая любит готовить",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("Saved."));

    await runAgentTurn(
      telegramId,
      "Меня зовут Алексей, мне 24. Я мужчина, ищу женщин. Рост 176 см, люблю готовку, хочу девушку, которая любит готовить.",
      { fetchFn: mockFetch },
    );

    expect(prisma.profile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ ethnicity: null }),
        update: expect.objectContaining({ ethnicity: null }),
      }),
    );
  });

  it("save_profile_data fails when the user clearly mentioned height earlier but the LLM omits it", async () => {
    // Defense-in-depth: if the LLM tries to save without height even though
    // the user explicitly said "180 см" in a prior message, refuse — the
    // LLM was about to silently drop a value the user already volunteered.
    // The guidance message nudges the LLM to re-extract from history.
    const mockAnalyse = vi.fn().mockResolvedValue({ parsed: null, embeddingSaved: true });
    const priorHistory = [
      { role: "system", content: "system prompt..." },
      {
        role: "user",
        content:
          "Меня зовут Руслан, мне 21. Я мужчина, ищу женщин. Рост — 180 см. Хочу красивую и женственную девушку.",
      },
      { role: "assistant", content: "Got it!" },
    ];
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uuid-1",
      messageHistory: priorHistory,
      language: "ru",
    });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "save_profile_data",
            args: {
              first_name: "Руслан",
              age: 21,
              gender: "male",
              preference: "women",
              partner_preferences: "женственную девушку",
              // height omitted — guard should fire
            },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("Sorry, let me re-check."));

    await runAgentTurn(telegramId, "yes save it", {
      fetchFn: mockFetch,
      analyseProfile: mockAnalyse,
    });

    // Profile must NOT have been written: the guard rejected the save.
    expect(prisma.profile.upsert).not.toHaveBeenCalled();

    // The tool result fed back to the LLM must call out the omission and
    // surface the value extracted from history so the LLM can retry cleanly.
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = secondCallBody.messages.find(
      (m: { role: string }) => m.role === "tool",
    );
    const toolContent = JSON.parse(toolMessage.content);
    expect(toolContent.success).toBe(false);
    expect(toolContent.error).toContain("height");
    expect(toolContent.error).toContain("180");
  });

  it("rejects hallucinated save_profile_data fields when the user only gave name and age", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: [],
        language: "en",
        aiMemoryExportPreference: "declined",
        email: "alice@stanford.edu",
        isEmailVerified: true,
        profile: {
          height: null,
          hobbies: [],
          partnerPreferences: null,
          photos: [],
          homeCityKey: "ua:kyiv",
        },
      })
      .mockResolvedValueOnce({
        id: "uuid-1",
        firstName: null,
        age: null,
        gender: null,
        preference: null,
        aiMemoryExportPreference: "declined",
        profile: {
          ethnicity: null,
          height: null,
          hobbies: [],
          partnerPreferences: null,
        },
      });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "save_profile_data",
            args: {
              first_name: "Enny",
              age: 21,
              gender: "female",
              preference: "both",
              height: 170,
              partner_preferences: "missing",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("I still need your gender, preference, height, and what you're looking for."));

    await runAgentTurn(telegramId, "So, my name is Enny and I am 21 years old.", {
      fetchFn: mockFetch,
    });

    expect(prisma.user.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          gender: "female",
          preference: "both",
        }),
      }),
    );
    expect(prisma.profile.upsert).not.toHaveBeenCalled();

    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = secondCallBody.messages.find(
      (m: { role: string }) => m.role === "tool",
    );
    const toolContent = JSON.parse(toolMessage.content);
    expect(toolContent.success).toBe(false);
    expect(toolContent.error).toContain("gender");
    expect(toolContent.error).toContain("preference");
    expect(toolContent.error).toContain("height");
    expect(toolContent.error).toContain("partner_preferences");
  });

  it("save_profile_data succeeds when height is supplied even though it was also in history", async () => {
    // Negative control for the guard above: the LLM extracted height
    // correctly, so the save must proceed normally.
    const mockAnalyse = vi.fn().mockResolvedValue({ parsed: null, embeddingSaved: true });
    const priorHistory = [
      { role: "system", content: "system prompt..." },
      {
        role: "user",
        content:
          "Меня зовут Руслан, мне 21. Я мужчина, ищу женщин. Рост у меня 180 см. Хочу красивую и женственную девушку.",
      },
      { role: "assistant", content: "Noted." },
    ];
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        id: "uuid-1",
        messageHistory: priorHistory,
        language: "ru",
      })
      .mockResolvedValueOnce({
        id: "uuid-1",
        profile: null,
      });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "save_profile_data",
            args: {
              first_name: "Руслан",
              age: 21,
              gender: "male",
              preference: "women",
              height: 180,
              partner_preferences: "женственную девушку",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("Saved."));

    await runAgentTurn(
      telegramId,
      "Меня зовут Руслан, мне 21. Я мужчина, ищу женщин. Рост у меня 180 см. Хочу красивую и женственную девушку.",
      {
      fetchFn: mockFetch,
      analyseProfile: mockAnalyse,
      },
    );

    expect(prisma.profile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ height: 180 }),
      }),
    );
  });

  it("does not generate a synthetic deep context summary during save_profile_data", async () => {
    const mockAnalyse = vi.fn().mockResolvedValue({ parsed: null, embeddingSaved: true });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
    }).mockResolvedValueOnce({
      id: "uuid-1",
      profile: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "save_profile_data",
            args: {
              first_name: "Alice",
              age: 21,
              gender: "female",
              preference: "men",
              height: 165,
              hobbies: ["tennis"],
              partner_preferences: "someone kind",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("Profile saved!"));

    await runAgentTurn(
      telegramId,
      "I'm Alice, 21, female, into men. I'm 165 cm, I like tennis, and I want someone kind.",
      {
      fetchFn: mockFetch,
      analyseProfile: mockAnalyse,
      },
    );

    expect(mockAnalyse).not.toHaveBeenCalled();
  });
});

describe("summarizeHistory", () => {
  function summaryResponse(text: string) {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
      }),
      text: async () => "",
    };
  }

  it("returns history unchanged when under threshold", async () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const mockFetch = vi.fn();

    const result = await summarizeHistory(history, mockFetch as unknown as typeof fetch, 10, 5);
    expect(result).toEqual(history);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("compresses old messages into a summary system message", async () => {
    // Build a history that exceeds threshold=6, keepRecent=3
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old-1" },
      { role: "assistant", content: "old-2" },
      { role: "user", content: "old-3" },
      { role: "assistant", content: "old-4" },
      { role: "user", content: "recent-1" },
      { role: "assistant", content: "recent-2" },
      { role: "user", content: "recent-3" },
    ];

    const mockFetch = vi.fn().mockResolvedValueOnce(
      summaryResponse("User provided old info and completed steps."),
    );

    const result = await summarizeHistory(
      history,
      mockFetch as unknown as typeof fetch,
      6, // threshold
      3, // keepRecent
    );

    // Should be: system + summary + 3 recent = 5 messages
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({ role: "system", content: "sys" });
    expect(result[1].role).toBe("system");
    expect(result[1].content).toContain("[Conversation Summary]");
    expect(result[1].content).toContain("User provided old info");
    // Recent messages preserved
    expect(result[2].content).toBe("recent-1");
    expect(result[3].content).toBe("recent-2");
    expect(result[4].content).toBe("recent-3");
  });

  it("falls back to original history if summarization API fails", async () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "e" },
      { role: "assistant", content: "f" },
    ];

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const result = await summarizeHistory(
      history,
      mockFetch as unknown as typeof fetch,
      4, // threshold
      2, // keepRecent
    );

    // Should return original history unchanged
    expect(result).toEqual(history);
  });
});

describe("truncateForApi", () => {
  it("returns history unchanged when under the limit", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(truncateForApi(history, 10)).toEqual(history);
    expect(truncateForApi(history, 3)).toEqual(history);
  });

  it("keeps system messages + most recent messages", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old-1" },
      { role: "assistant", content: "old-2" },
      { role: "user", content: "old-3" },
      { role: "assistant", content: "old-4" },
      { role: "user", content: "recent-1" },
      { role: "assistant", content: "recent-2" },
    ];
    const result = truncateForApi(history, 4); // 1 system + 3 recent
    expect(result).toEqual([
      { role: "system", content: "sys" },
      { role: "assistant", content: "old-4" },
      { role: "user", content: "recent-1" },
      { role: "assistant", content: "recent-2" },
    ]);
  });

  it("does not split tool-call sequences", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "foo", arguments: "{}" } }] },
      { role: "tool", content: "result", tool_call_id: "c1" },
      { role: "assistant", content: "done" },
      { role: "user", content: "new" },
    ];
    // limit=4 → 1 system + 3 from rest → would start at index 3 (tool msg)
    // should walk back to include the assistant with tool_calls
    const result = truncateForApi(history, 4);
    expect(result[0]).toEqual({ role: "system", content: "sys" });
    expect(result[1].role).toBe("assistant");
    expect(result[1].tool_calls).toBeDefined();
    expect(result[2].role).toBe("tool");
  });

  it("preserves multiple leading system messages", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "sys1" },
      { role: "system", content: "[Summary]" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ];
    const result = truncateForApi(history, 4); // 2 system + 2 recent
    expect(result).toEqual([
      { role: "system", content: "sys1" },
      { role: "system", content: "[Summary]" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);
  });
});

describe("answer validation in system prompt", () => {
  it("system prompt includes vague answer validation rules", async () => {
    // When the agent starts a conversation, the system prompt is injected.
    // We verify the prompt sent to OpenAI contains the critical validation rules.
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const mockFetch = vi.fn().mockResolvedValueOnce(
      textResponse("Welcome to Gennety!"),
    );

    await runAgentTurn(BigInt(12345), "hi", { fetchFn: mockFetch });

    const calledWith = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = calledWith.messages.find(
      (m: { role: string }) => m.role === "system",
    );
    expect(systemMsg).toBeDefined();
    const content = systemMsg.content as string;

    // Key validation rules must be present
    expect(content).toContain("NEVER move to the next question");
    expect(content).toContain("What counts as an INVALID");
    expect(content).toContain("I don't know");
    expect(content).toContain("First attempt");
    expect(content).toContain("Second attempt");
    expect(content).toContain("Third attempt");
    expect(content).toContain("Required data quality standards");
  });

  it("system prompt forbids re-asking already-volunteered fields and includes a multi-field example", async () => {
    // Regression for the Ruslan repro (2026-05-03): a single rich first
    // message containing name+age+preference+height+hobbies+partner_prefs
    // used to trigger 5+ redundant follow-up questions. The prompt must
    // explicitly instruct the LLM to extract everything in one pass and
    // forbid the most common redundant follow-ups.
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const mockFetch = vi.fn().mockResolvedValueOnce(textResponse("Hi!"));

    await runAgentTurn(BigInt(12345), "hi", { fetchFn: mockFetch });

    const calledWith = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemMsg = calledWith.messages.find(
      (m: { role: string }) => m.role === "system",
    );
    const content = systemMsg.content as string;

    // The vivid example mirrors the real failure case
    expect(content).toContain("Руслан");
    // Concrete forbidden-follow-ups list — the heart of the fix
    expect(content).toContain("FORBIDDEN");
    // Gender must come from a direct answer, never from a gendered name.
    expect(content).toContain("NEVER infer gender from a first name");
  });

  it("uses temperature 0.4 for deterministic data collection", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const mockFetch = vi.fn().mockResolvedValueOnce(
      textResponse("Welcome!"),
    );

    await runAgentTurn(BigInt(12345), "hi", { fetchFn: mockFetch });

    const calledWith = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(calledWith.temperature).toBe(0.4);
  });
});

describe("injectSystemMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends a system message to the stored history", async () => {
    const existing = [{ role: "system", content: "init" }];
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      messageHistory: existing,
    });
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await injectSystemMessage(BigInt(42), "Photo uploaded successfully.");

    const updateCall = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const history = updateCall.data.messageHistory;
    expect(history).toHaveLength(2);
    expect(history[1]).toEqual({
      role: "system",
      content: "Photo uploaded successfully.",
    });
  });
});
