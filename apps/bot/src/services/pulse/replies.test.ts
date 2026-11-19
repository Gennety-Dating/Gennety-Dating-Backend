import { describe, expect, it, vi } from "vitest";

vi.mock("@gennety/db", () => ({ prisma: {}, Prisma: { sql: () => null } }));
vi.mock("../feature-preview.js", () => ({
  suggestedRepliesOn: () => true,
  suggestedRepliesPreview: () => false,
  suggestedRepliesUsers: () => null,
}));
vi.mock("../chat-sessions.js", () => ({ touchChatSession: async () => undefined }));

import { computeReplyRows, detectRepliesLoop, type ReplyChatRow } from "./replies.js";

const day = "2026-11-18";
const at = (h: number) => new Date(`${day}T${String(h).padStart(2, "0")}:00:00Z`);

function chat(over: Partial<ReplyChatRow>): ReplyChatRow {
  return { sessionId: "s", userId: "a", startedAt: at(10), userTurns: 4, assistantRows: 4, sets: [], ...over };
}

const tappedStep = {
  kind: "suggested_replies" as const,
  items: [
    { id: "r1", kind: "step" as const, text: "Покажи моё свидание" },
    { id: "close", kind: "close" as const, text: "На сегодня всё" },
  ],
  tapped: "r1",
  tappedAt: at(11).toISOString(),
  at: at(11).toISOString(),
};

describe("computeReplyRows", () => {
  it("counts shown share, taps by kind, offline steps after a step tap and the arms", () => {
    const rows = computeReplyRows({
      days: new Set([day]),
      eligible: null,
      holdout: (id) => id === "h",
      chats: [
        chat({ userId: "a", sets: [tappedStep] }),
        chat({ userId: "b", sessionId: "s2", sets: [{ ...tappedStep, tapped: "close", tappedAt: at(12).toISOString() }] }),
        chat({ userId: "h", sessionId: "s3", userTurns: 2 }),
      ],
      steps: [{ userId: "a", at: new Date(at(11).getTime() + 2 * 24 * 3600 * 1000) }],
    });
    const get = (metric: string, dim = "") => rows.find((r) => r.metric === metric && r.dim === dim);
    expect(get("agent_replies_shown_share")).toMatchObject({ value: 2 / 8, n: 8 });
    expect(get("agent_replies_tap_rate", "step")).toMatchObject({ value: 0.5, n: 2 });
    expect(get("agent_replies_tap_rate", "close")).toMatchObject({ value: 0.5, n: 2 });
    expect(get("agent_replies_offline_step_7d")).toMatchObject({ value: 1, n: 1 });
    expect(get("agent_replies_exit_share")).toMatchObject({ value: 0.5, n: 2 });
    expect(get("agent_chat_turns_p50", "chips")).toMatchObject({ value: 4, n: 2 });
    expect(get("agent_chat_turns_p50", "holdout")).toMatchObject({ value: 2, n: 1 });
  });
});

describe("detectRepliesLoop", () => {
  it("fires when chips make chats longer without more offline steps", () => {
    const chats = [
      ...Array.from({ length: 30 }, (_, i) => chat({ userId: `c${i}`, sessionId: `c${i}`, userTurns: 10 })),
      ...Array.from({ length: 30 }, (_, i) => chat({ userId: `h${i}`, sessionId: `h${i}`, userTurns: 6 })),
    ];
    const input = { days: new Set([day]), chats, steps: [], eligible: null, holdout: (id: string) => id.startsWith("h"), asOf: day, minSample: 20 };
    expect(detectRepliesLoop(input)).toHaveLength(1);
    expect(detectRepliesLoop({ ...input, chats: chats.map((c) => ({ ...c, userTurns: 6 })) })).toHaveLength(0);
  });
});
