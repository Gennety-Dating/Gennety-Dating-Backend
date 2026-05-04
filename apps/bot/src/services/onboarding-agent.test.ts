import { describe, it, expect, vi, beforeEach } from "vitest";

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
  analyseAndSaveProfile: vi.fn().mockResolvedValue({ parsed: null, embeddingSaved: false }),
}));

vi.mock("../public/otp.js", () => ({
  createAndSendOtp: vi.fn().mockResolvedValue(undefined),
  verifyOtp: vi.fn().mockResolvedValue({ ok: true }),
}));

import { prisma } from "@gennety/db";
import { createAndSendOtp, verifyOtp } from "../public/otp.js";
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
    // Two findUnique calls in this turn:
    //   1. runAgentTurn loads message history at the top
    //   2. request_photos guard checks profile.psychologicalSummary
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: "uuid-1", messageHistory: [], language: "en" })
      .mockResolvedValueOnce({
        profile: { psychologicalSummary: "A thoughtful introvert with secure attachment." },
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

  it("blocks request_photos when the context dump has not been saved yet (LLM ordering violation)", async () => {
    // Defense-in-depth: even though the system prompt forbids it, an LLM may
    // chain request_context_dump → request_photos in the same turn. The tool
    // boundary must refuse the second call so the user isn't stranded between
    // "paste your AI analysis" and "send me photos" with no clear next step.
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: "uuid-1", messageHistory: [], language: "en" })
      .mockResolvedValueOnce({ profile: { psychologicalSummary: null } });

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
    (prisma.user.findUnique as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ id: "uuid-1", messageHistory: [], language: "en" })
      .mockResolvedValueOnce({ profile: null });

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

  it("sets onboardingComplete=true when finalize_onboarding is called with complete data", async () => {
    // finalize_onboarding now checks DB for completeness — mock a complete profile
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
        profile: {
          height: 165,
          hobbies: ["tennis", "reading"],
          partnerPreferences: "someone kind and funny",
          psychologicalSummary: "A thoughtful introvert with secure attachment.",
          photos: ["photo1", "photo2"],
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

    const result = await runAgentTurn(telegramId, "resend code please", {
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
    expect(calledWith.messages).toHaveLength(4); // 3 prior + 1 new user
    expect(calledWith.messages[3].content).toBe("I'm back");
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

    const result = await runAgentTurn(telegramId, "here's my info", {
      fetchFn: mockFetch,
      analyseProfile: mockAnalyse,
    });

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

  it("does not overwrite an existing deep context summary during save_profile_data", async () => {
    const mockAnalyse = vi.fn().mockResolvedValue({ parsed: null, embeddingSaved: true });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "uuid-1",
      messageHistory: [],
      language: "en",
    }).mockResolvedValueOnce({
      id: "uuid-1",
      profile: { psychologicalSummary: "Rich context dump summary" },
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
              partner_preferences: "someone kind",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("Profile saved!"));

    await runAgentTurn(telegramId, "here's my info", {
      fetchFn: mockFetch,
      analyseProfile: mockAnalyse,
    });

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
