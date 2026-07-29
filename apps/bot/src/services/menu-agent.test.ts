import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    profile: {
      update: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    match: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    matchEvent: {
      updateMany: vi.fn(),
    },
    systemKnowledge: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    chatEvent: {
      findMany: vi.fn().mockResolvedValue([]),
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

// `appendNegativeConstraint` calls the LLM under the hood; stub it out.
vi.mock("../handlers/matching/negative-constraints.js", () => ({
  appendNegativeConstraint: vi.fn(),
}));

import { prisma } from "@gennety/db";
import {
  AGENT_HISTORY_MAX_MESSAGES,
  AGENT_HISTORY_WINDOW_MS,
  recentAgentHistory,
  runMenuAgentTurn,
  splitReplyIntoBubbles,
  toApiMessages,
  TOOL_KINDS,
  type StoredChatMessage,
} from "./menu-agent.js";
import { clearKnowledgeCache } from "./prompt-builder.js";
import { appendNegativeConstraint } from "../handlers/matching/negative-constraints.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    }),
    text: async () => "",
  };
}

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

describe("menu-agent record_rejection_feedback", () => {
  const telegramId = BigInt(1001);
  const matchId = "match-1";

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();

    // `appendNegativeConstraint` is reset by resetAllMocks, so re-stub.
    (appendNegativeConstraint as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // `systemKnowledge.findMany` is reset too — re-stub.
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.chatEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // Default: buildSystemPrompt → no pending rejection
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        // Query from prompt-builder.fetchUserContext (selects id + matchesAsA/B)
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        // Query from runMenuAgentTurn for messageHistory
        if (args.select && "messageHistory" in args.select) {
          return { messageHistory: [] };
        }
        // Query from executor (select: { id, language })
        return { id: "uid-A", language: "en" };
      },
    );
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.match.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.match.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("persists rejection reason on the match and fires appendNegativeConstraint", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "cancelled",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: {
              match_id: matchId,
              reason: "prefers more extroverted social partners",
            },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("got it, noted"));

    const result = await runMenuAgentTurn(telegramId, "he was too quiet for me", {
      fetchFn: mockFetch,
    });

    expect(result.reply).toBe("got it, noted");
    expect(prisma.match.update).toHaveBeenCalledWith({
      where: { id: matchId },
      data: { rejectionReasonA: "prefers more extroverted social partners" },
    });
    expect(prisma.matchEvent.updateMany).toHaveBeenCalledWith({
      where: {
        matchId,
        actorId: "uid-A",
        targetId: "uid-B",
        actionType: "DECLINED",
      },
      data: {
        metadata: {
          rejectionReason: "prefers more extroverted social partners",
        },
      },
    });
    expect(appendNegativeConstraint).toHaveBeenCalledWith(
      "uid-A",
      "prefers more extroverted social partners",
      "en",
    );
  });

  it("rejects short/vague reasons without writing to DB", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "cancelled",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "call-1", name: "record_rejection_feedback", args: { match_id: matchId, reason: "idk" } },
        ]),
      )
      .mockResolvedValueOnce(textResponse("ok tell me more — what didn't click?"));

    await runMenuAgentTurn(telegramId, "idk", { fetchFn: mockFetch });

    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(appendNegativeConstraint).not.toHaveBeenCalled();
  });

  it("refuses when the match does not belong to the caller", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-X",
      userBId: "uid-Y",
      status: "cancelled",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: { match_id: matchId, reason: "too quiet and reserved" },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("sorry, something's off"));

    await runMenuAgentTurn(telegramId, "he was too quiet", { fetchFn: mockFetch });

    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(appendNegativeConstraint).not.toHaveBeenCalled();
  });

  it("persists when the first decliner is still in proposed state", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "proposed",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: { match_id: matchId, reason: "too quiet and reserved" },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("saved for next time"));

    await runMenuAgentTurn(telegramId, "x", { fetchFn: mockFetch });

    expect(prisma.match.update).toHaveBeenCalledWith({
      where: { id: matchId },
      data: { rejectionReasonA: "too quiet and reserved" },
    });
    expect(appendNegativeConstraint).toHaveBeenCalledWith(
      "uid-A",
      "too quiet and reserved",
      "en",
    );
  });

  it("refuses when the user has not personally declined", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "proposed",
      acceptedByA: null,
      acceptedByB: null,
      rejectionReasonA: null,
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: { match_id: matchId, reason: "too quiet and reserved" },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("no active rejection"));

    await runMenuAgentTurn(telegramId, "x", { fetchFn: mockFetch });

    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(appendNegativeConstraint).not.toHaveBeenCalled();
  });

  it("is idempotent when a reason is already recorded", async () => {
    (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      userAId: "uid-A",
      userBId: "uid-B",
      status: "cancelled",
      acceptedByA: false,
      acceptedByB: null,
      rejectionReasonA: "already here",
      rejectionReasonB: null,
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          {
            id: "call-1",
            name: "record_rejection_feedback",
            args: { match_id: matchId, reason: "a second reason being submitted" },
          },
        ]),
      )
      .mockResolvedValueOnce(textResponse("already noted"));

    await runMenuAgentTurn(telegramId, "also he was too tall", { fetchFn: mockFetch });

    // Executor returns success but must not overwrite or re-append.
    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(appendNegativeConstraint).not.toHaveBeenCalled();
  });
});

describe("menu-agent resume_matching", () => {
  const telegramId = BigInt(1001);

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.chatEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "banned",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) {
          return { messageHistory: [] };
        }
        if (args.select && "status" in args.select) {
          return { status: "banned" };
        }
        return { id: "uid-A", language: "en" };
      },
    );
  });

  it("refuses to reactivate users outside the paused state", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "call-1", name: "resume_matching", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("I can't resume matching from this account state."));

    await runMenuAgentTurn(telegramId, "resume me", { fetchFn: mockFetch });

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    const secondCallBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const toolMessage = secondCallBody.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(JSON.parse(toolMessage.content).success).toBe(false);
  });
});

describe("splitReplyIntoBubbles", () => {
  it("keeps a reply without blank lines as one bubble", () => {
    expect(splitReplyIntoBubbles("готово ✨ жду вторую сторону")).toEqual([
      "готово ✨ жду вторую сторону",
    ]);
    expect(splitReplyIntoBubbles("line one\nstill same bubble")).toEqual([
      "line one\nstill same bubble",
    ]);
  });

  it("splits on blank lines into separate bubbles", () => {
    expect(splitReplyIntoBubbles("первая мысль\n\nвторая мысль")).toEqual([
      "первая мысль",
      "вторая мысль",
    ]);
  });

  it("caps at three bubbles, folding overflow into the last", () => {
    const out = splitReplyIntoBubbles("a\n\nb\n\nc\n\nd\n\ne");
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("a");
    expect(out[1]).toBe("b");
    expect(out[2]).toBe("c\n\nd\n\ne");
  });

  it("strips markdown emphasis — bubbles are sent as plain text", () => {
    expect(
      splitReplyIntoBubbles("у тебя уже есть дата: **четверг, 16 июля, 19:00**, **Kyiv Food Market**."),
    ).toEqual(["у тебя уже есть дата: четверг, 16 июля, 19:00, Kyiv Food Market."]);
    expect(splitReplyIntoBubbles("могу напомнить, __как вы найдёте друг друга__")).toEqual([
      "могу напомнить, как вы найдёте друг друга",
    ]);
    expect(splitReplyIntoBubbles("набери `/menu` в чате")).toEqual([
      "набери /menu в чате",
    ]);
  });

  it("drops empty fragments and trims whitespace", () => {
    expect(splitReplyIntoBubbles("  привет  \n\n\n\n  как дела  ")).toEqual([
      "привет",
      "как дела",
    ]);
  });

  // BASE_PERSONA asks the model to author the bubbles with blank lines; when it
  // doesn't, a long reply must still land as chat rather than a wall of text.
  describe("auto-split fallback for a single block", () => {
    it("splits a long multi-sentence block at the boundary nearest the midpoint", () => {
      // Nearest-the-middle, not "before the last sentence": two balanced
      // bubbles read as texting, a 120/14 split reads as an afterthought.
      const out = splitReplyIntoBubbles(
        "твоё свидание в четверг в 19:00, Kyiv Food Market. адрес и карта — на карточке в «My Date». приходи к самому входу, там легко найтись.",
      );
      expect(out).toEqual([
        "твоё свидание в четверг в 19:00, Kyiv Food Market.",
        "адрес и карта — на карточке в «My Date». приходи к самому входу, там легко найтись.",
      ]);
    });

    it("does not mistake a clock time for a sentence boundary", () => {
      const out = splitReplyIntoBubbles(
        "твоё свидание в четверг в 19:00, Kyiv Food Market. адрес и карта — на карточке в «My Date». приходи к самому входу, там легко найтись.",
      );
      expect(out[0]).toContain("19:00");
      expect(out.every((bubble) => !bubble.startsWith("00"))).toBe(true);
    });

    it("leaves a short reply alone even when it has two sentences", () => {
      // Splitting "готово. жду." is worse, not chattier.
      expect(splitReplyIntoBubbles("готово ✨ жду вторую сторону. напишу сразу.")).toEqual([
        "готово ✨ жду вторую сторону. напишу сразу.",
      ]);
    });

    it("leaves a long single sentence alone — there is no honest cut point", () => {
      const oneSentence =
        "матчей пока нет потому что в Киеве прямо сейчас слишком мало анкет твоего профиля, и следующий заход в четверг";
      expect(oneSentence.length).toBeGreaterThan(90);
      expect(splitReplyIntoBubbles(oneSentence)).toEqual([oneSentence]);
    });

    it("never produces a third bubble on its own", () => {
      const out = splitReplyIntoBubbles(
        "первое предложение здесь. второе предложение здесь. третье предложение здесь. четвёртое предложение здесь.",
      );
      expect(out).toHaveLength(2);
    });

    it("splits on ? too, and keeps the terminator with its sentence", () => {
      const out = splitReplyIntoBubbles(
        "хочешь поменять место? это можно до пяти часов до свидания, кнопка «Сменить место» на карточке свидания.",
      );
      expect(out).toEqual([
        "хочешь поменять место?",
        "это можно до пяти часов до свидания, кнопка «Сменить место» на карточке свидания.",
      ]);
    });

    it("does not fire when the model already authored the bubbles", () => {
      const out = splitReplyIntoBubbles(
        "ага, понял.\n\nтвоё свидание в четверг в 19:00, Kyiv Food Market. адрес — на карточке в «My Date».",
      );
      expect(out).toEqual([
        "ага, понял.",
        "твоё свидание в четверг в 19:00, Kyiv Food Market. адрес — на карточке в «My Date».",
      ]);
    });
  });
});

describe("menu-agent offer_cancel_premium", () => {
  const telegramId = BigInt(2002);
  const FUTURE = new Date("2026-08-19T12:00:00Z");

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.chatEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) {
          return { messageHistory: [] };
        }
        // getPremiumCancelContext — an active Telegram Stars subscriber.
        if (args.select && "premiumUntil" in args.select) {
          return {
            premiumUntil: FUTURE,
            premiumProvider: "telegram_stars",
            premiumExternalId: "charge-x",
            premiumAutoRenew: true,
          };
        }
        // evaluatePremiumCancelOffer's own id+language lookup.
        return { id: "uid-A", language: "en" };
      },
    );
  });

  it("returns the confirm-card action for an active Stars subscriber", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "offer_cancel_premium", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("sure — one sec"));

    const result = await runMenuAgentTurn(telegramId, "cancel my premium please", {
      fetchFn: mockFetch,
    });

    expect(result.reply).toBe("sure — one sec");
    expect(result.action).toEqual({ kind: "premium_cancel_confirm" });
  });

  it("has no action when the user has no active subscription", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) return { messageHistory: [] };
        if (args.select && "premiumUntil" in args.select) {
          return {
            premiumUntil: null,
            premiumProvider: null,
            premiumExternalId: null,
            premiumAutoRenew: false,
          };
        }
        return { id: "uid-A", language: "en" };
      },
    );

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "offer_cancel_premium", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("you don't have an active sub"));

    const result = await runMenuAgentTurn(telegramId, "cancel premium", {
      fetchFn: mockFetch,
    });

    expect(result.action).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// History window
// ---------------------------------------------------------------------------

describe("recentAgentHistory", () => {
  const NOW = Date.UTC(2026, 6, 28, 11, 0, 0);

  /**
   * The second half of the bug in PRODUCT_SPEC §2.1: `messageHistory` is shared
   * with the ONBOARDING agent, and replaying all of it meant a "Почему?" typed
   * under a venue-change notice was answered against the tail of onboarding.
   * Onboarding turns carry no `ts`, so they are never replayed.
   */
  it("drops untimestamped onboarding-era turns", () => {
    const stored: StoredChatMessage[] = [
      { role: "assistant", content: "Отлично! Анкета собрана: фото, ответы, запрос к партнёру." },
      { role: "user", content: "why is my match late?", ts: NOW - 60_000 },
    ];
    expect(recentAgentHistory(stored, NOW)).toEqual([
      { role: "user", content: "why is my match late?", ts: NOW - 60_000 },
    ]);
  });

  it("drops turns older than the window", () => {
    const stored: StoredChatMessage[] = [
      { role: "user", content: "old", ts: NOW - AGENT_HISTORY_WINDOW_MS - 1 },
      { role: "user", content: "fresh", ts: NOW - 1000 },
    ];
    expect(recentAgentHistory(stored, NOW).map((m) => m.content)).toEqual(["fresh"]);
  });

  it("keeps only the newest N turns", () => {
    const stored: StoredChatMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
      ts: NOW - 1000,
    }));
    const kept = recentAgentHistory(stored, NOW);
    expect(kept).toHaveLength(AGENT_HISTORY_MAX_MESSAGES);
    expect(kept[kept.length - 1]!.content).toBe("m29");
  });

  it("never opens the replay on an orphaned tool result", () => {
    const stored: StoredChatMessage[] = [
      { role: "assistant", content: null, ts: NOW - 5000 },
      ...Array.from({ length: AGENT_HISTORY_MAX_MESSAGES }, (_, i) => ({
        role: (i === 0 ? "tool" : "user") as "tool" | "user",
        content: `m${i}`,
        ts: NOW - 1000,
      })),
    ];
    expect(recentAgentHistory(stored, NOW)[0]!.role).not.toBe("tool");
  });

  it("never replays a stored system message", () => {
    const stored: StoredChatMessage[] = [
      { role: "system", content: "stale prompt", ts: NOW - 1000 },
      { role: "user", content: "hi", ts: NOW - 1000 },
    ];
    expect(recentAgentHistory(stored, NOW).map((m) => m.role)).toEqual(["user"]);
  });
});

describe("toApiMessages", () => {
  it("strips `ts` — OpenAI rejects unknown message fields", () => {
    const out = toApiMessages([
      { role: "user", content: "hi", ts: 123 } as StoredChatMessage,
      { role: "assistant", content: "hey" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
    ]);
    expect(Object.hasOwn(out[0]!, "ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool safety envelope
// ---------------------------------------------------------------------------

describe("menu-agent tool classes", () => {
  it("classifies every advertised tool", () => {
    // A tool with no entry in TOOL_KINDS silently escapes the write budget, so
    // the registry has to stay exhaustive rather than best-effort.
    for (const name of Object.keys(TOOL_KINDS)) {
      expect(TOOL_KINDS[name]).toBeDefined();
    }
    expect(TOOL_KINDS.update_bio).toBe("write");
    expect(TOOL_KINDS.get_my_standing).toBe("read");
    expect(TOOL_KINDS.propose_cancel_date).toBe("confirm");
    expect(TOOL_KINDS.open_screen).toBe("open");
  });

  it("never classifies an irreversible action as a write", () => {
    // Cancelling a date / closing an account / cancelling a subscription must
    // stay in the confirm class: those tools may only surface a button.
    expect(TOOL_KINDS.propose_cancel_date).toBe("confirm");
    expect(TOOL_KINDS.propose_close_account).toBe("confirm");
    expect(TOOL_KINDS.offer_cancel_premium).toBe("confirm");
  });
});

describe("menu-agent write budget", () => {
  const telegramId = BigInt(2002);

  /**
   * How many times a `major` edit actually reached the database. Every turn
   * also calls `user.update` once to persist message history, so a raw call
   * count would always be one too high.
   */
  function majorWrites(): number {
    return (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => (call[0] as { data?: { major?: unknown } })?.data?.major !== undefined,
    ).length;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.chatEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) return { messageHistory: [] };
        if (args.select && "profile" in args.select) {
          return { id: "uid-A", language: "en", profile: { psychologicalSummary: "" } };
        }
        return { id: "uid-A", language: "en" };
      },
    );
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.profile.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("applies only the first write in a turn and refuses the rest", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "c1", name: "update_major", args: { major: "Design" } },
          { id: "c2", name: "update_age_range", args: { min_age: 22, max_age: 30 } },
        ]),
      )
      .mockResolvedValueOnce(textResponse("done"));

    const result = await runMenuAgentTurn(telegramId, "change both", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    // The major landed; the age range never reached the database. (Every turn
    // also calls `user.update` once to persist history — match on the payload.)
    expect(majorWrites()).toBe(1);
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(result.receipts).toHaveLength(1);

    const secondRequest = JSON.parse(
      (fetchFn.mock.calls[1]![1] as { body: string }).body,
    ) as { messages: Array<{ role: string; content: string }> };
    const refusal = secondRequest.messages.find(
      (m) => m.role === "tool" && m.content.includes("write_budget_exhausted"),
    );
    expect(refusal).toBeDefined();
  });

  it("does not spend the budget on a write that failed validation", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          // Rejected: min > max.
          { id: "c1", name: "update_age_range", args: { min_age: 40, max_age: 20 } },
          { id: "c2", name: "update_major", args: { major: "Design" } },
        ]),
      )
      .mockResolvedValueOnce(textResponse("ok"));

    const result = await runMenuAgentTurn(telegramId, "fix it", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    // The second call still ran, because the first never wrote anything.
    expect(majorWrites()).toBe(1);
    expect(result.receipts).toEqual(["Saved"]);
  });

  it("emits no receipt when nothing was written", async () => {
    const fetchFn = vi.fn().mockResolvedValue(textResponse("just chatting"));
    const result = await runMenuAgentTurn(telegramId, "hey", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.receipts).toBeUndefined();
  });
});

describe("menu-agent update_bio destructive-replacement guard", () => {
  const telegramId = BigInt(3003);
  const longBio = "x".repeat(400);

  function mockUser(existingBio: string) {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) return { messageHistory: [] };
        if (args.select && "profile" in args.select) {
          return {
            id: "uid-A",
            language: "en",
            profile: { psychologicalSummary: existingBio },
          };
        }
        return { id: "uid-A", language: "en" };
      },
    );
  }

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.chatEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.profile.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("refuses to collapse a long existing bio into one line", async () => {
    mockUser(longBio);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "update_bio", args: { bio: "I like coffee." } }]),
      )
      .mockResolvedValueOnce(textResponse("that would wipe your description"));

    const result = await runMenuAgentTurn(telegramId, "add that I like coffee", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(result.receipts).toBeUndefined();
    // The user is handed the editor, where the current text is visible first.
    expect(result.action).toEqual({
      kind: "entry_point",
      entry: { label: expect.any(String), callbackData: "menu:edit:bio" },
    });
  });

  it("allows a rewrite that keeps the substance", async () => {
    mockUser(longBio);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([
          { id: "c1", name: "update_bio", args: { bio: `${longBio} And I like coffee.` } },
        ]),
      )
      .mockResolvedValueOnce(textResponse("added"));

    const result = await runMenuAgentTurn(telegramId, "add that I like coffee", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(prisma.profile.update).toHaveBeenCalledTimes(1);
    expect(result.receipts).toEqual(["About me updated"]);
  });

  it("lets a user with no bio yet write a short one", async () => {
    mockUser("");
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "update_bio", args: { bio: "I like coffee." } }]),
      )
      .mockResolvedValueOnce(textResponse("saved"));

    await runMenuAgentTurn(telegramId, "write my bio", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(prisma.profile.update).toHaveBeenCalledTimes(1);
  });
});

describe("menu-agent propose_cancel_date", () => {
  const telegramId = BigInt(4004);

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.chatEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) return { messageHistory: [] };
        return { id: "uid-A", language: "en" };
      },
    );
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("hands over the existing emergency button and cancels nothing itself", async () => {
    (prisma.match.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "match-9",
      status: "scheduled",
      proposedTimes: [],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "propose_cancel_date", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("here's the button"));

    const result = await runMenuAgentTurn(telegramId, "I can't make it, cancel", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(result.action).toMatchObject({
      kind: "entry_point",
      entry: { callbackData: "emerg:start:match-9" },
    });
  });

  it("offers no button when there is nothing booked or being planned", async () => {
    (prisma.match.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "propose_cancel_date", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("nothing scheduled"));

    const result = await runMenuAgentTurn(telegramId, "cancel my date", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.action).toBeUndefined();
  });

  it("reaches the planning-stage cancellation too, not just a booked date", async () => {
    // Before §3.5c this tool filtered on `scheduled` alone, so someone writing
    // "I want to cancel" mid-planning got a polite explanation and no way out.
    (prisma.match.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "match-7",
      status: "negotiating_venue",
      proposedTimes: [new Date("2026-08-01T16:00:00Z")],
    });
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "propose_cancel_date", args: {} }]),
      )
      .mockResolvedValueOnce(textResponse("here's the button"));

    const result = await runMenuAgentTurn(telegramId, "мои планы поменялись, отмени", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    // Still only OPENS the confirmation card — nothing is cancelled by text.
    expect(prisma.match.update).not.toHaveBeenCalled();
    expect(result.action).toMatchObject({
      kind: "entry_point",
      entry: { callbackData: "stall:no:match-7" },
    });
  });
});

describe("menu-agent open_screen", () => {
  const telegramId = BigInt(5005);

  beforeEach(() => {
    vi.resetAllMocks();
    clearKnowledgeCache();
    (prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.chatEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
      async (args: { select?: Record<string, unknown> }) => {
        if (args.select && "matchesAsA" in args.select) {
          return {
            id: "uid-A",
            firstName: "Alice",
            universityDomain: "stanford.edu",
            status: "active",
            language: "en",
            matchesAsA: [],
            matchesAsB: [],
          };
        }
        if (args.select && "messageHistory" in args.select) return { messageHistory: [] };
        return { id: "uid-A", language: "en" };
      },
    );
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("hands over a real menu callback, never a model-authored one", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "open_screen", args: { screen: "photos" } }]),
      )
      .mockResolvedValueOnce(textResponse("here"));

    const result = await runMenuAgentTurn(telegramId, "I want to change my photos", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.action).toMatchObject({
      kind: "entry_point",
      entry: { callbackData: "menu:edit:photos" },
    });
  });

  it("offers nothing for an unknown screen", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "open_screen", args: { screen: "admin" } }]),
      )
      .mockResolvedValueOnce(textResponse("can't do that"));

    const result = await runMenuAgentTurn(telegramId, "open admin", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.action).toBeUndefined();
  });

  it("offers nothing for a screen whose feature is off", async () => {
    // TICKET_FEATURE_ENABLED is absent from the mocked env, so tickets are off.
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        toolCallResponse([{ id: "c1", name: "open_screen", args: { screen: "tickets" } }]),
      )
      .mockResolvedValueOnce(textResponse("not available"));

    const result = await runMenuAgentTurn(telegramId, "buy tickets", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.action).toBeUndefined();
  });
});
