import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@gennety/db", () => ({ prisma: {}, Prisma: { DbNull: null } }));
vi.mock("./feature-preview.js", () => ({
  suggestedRepliesOn: () => true,
  suggestedRepliesPreview: () => false,
  agentRemindersOn: () => false,
}));
vi.mock("./chat-sessions.js", () => ({ touchChatSession: async () => undefined }));
vi.mock("./profile-media-validation/openai-moderation.js", () => ({ moderateTextWithOpenAI: async () => ({ ok: true, signals: [] }) }));

import { setVariantRng, isLeavingTurn, chipTextForbidden } from "@gennety/shared";
import {
  availableSteps,
  buildChipSet,
  chipsGate,
  closeLine,
  generateChipSet,
  inHoldout,
  isNight,
  readSuggestedReplies,
  telegramTranscript,
  telegramTurnBegins,
  type GateFacts,
  type ModelVerdict,
} from "./suggested-replies.js";

const KYIV = "Europe/Kyiv";
// 14:00 in Kyiv (UTC+2 in November).
const DAY = new Date("2026-11-19T12:00:00Z");
// 23:40 in Kyiv.
const NIGHT = new Date("2026-11-19T21:40:00Z");

function facts(over: Partial<GateFacts> = {}): GateFacts {
  return {
    enabled: true,
    holdout: false,
    replyHasCard: false,
    userText: "В субботу первое свидание, нервничаю",
    safetyLatched: false,
    ignoredInARow: 0,
    turnsInChat: 2,
    chatStartedAt: new Date(DAY.getTime() - 5 * 60 * 1000),
    now: DAY,
    timeZone: KYIV,
    ...over,
  };
}

function verdict(over: Partial<ModelVerdict> = {}): ModelVerdict {
  return { show: true, quiet: false, safety: false, chips: [], ...over };
}

beforeEach(() => setVariantRng(() => 0));

describe("chipsGate", () => {
  it("asks on an ordinary short chat in the day, without the exit", () => {
    expect(chipsGate(facts())).toEqual({ ask: true, wantExit: false, night: false });
  });

  it.each([
    ["off", { enabled: false }],
    ["holdout", { holdout: true }],
    ["card", { replyHasCard: true }],
    ["safety", { safetyLatched: true }],
    ["ignored", { ignoredInARow: 2 }],
  ] as const)("never asks when %s", (reason, over) => {
    expect(chipsGate(facts(over))).toEqual({ ask: false, reason });
  });

  it.each(["пока", "Спасибо!", "ок", "я спать", "Okay, thanks", "danke", "dzięki 🙏", "ok going to sleep, thanks", "ок, спасибо, я спать"])(
    "lets the person go on «%s» — not even the exit",
    (text) => {
      expect(chipsGate(facts({ userText: text, turnsInChat: 20 }))).toEqual({ ask: false, reason: "leaving" });
    },
  );

  it("wants the exit after 12 turns or 30 minutes", () => {
    expect(chipsGate(facts({ turnsInChat: 12 }))).toMatchObject({ ask: true, wantExit: true });
    expect(chipsGate(facts({ chatStartedAt: new Date(DAY.getTime() - 31 * 60 * 1000) }))).toMatchObject({ wantExit: true });
  });

  it("at night always wants the exit", () => {
    expect(chipsGate(facts({ now: NIGHT }))).toEqual({ ask: true, wantExit: true, night: true });
    expect(isNight(DAY, KYIV)).toBe(false);
  });
});

describe("phrase lists", () => {
  it("does not mistake a real answer for a goodbye", () => {
    expect(isLeavingTurn("ок, а где лучше встретиться?")).toBe(false);
    expect(isLeavingTurn("Впритык")).toBe(false);
  });

  it.each(["Расскажи ещё", "Ещё одну историю?", "Tell me more", "What else?", "Я влюблён", "Да, давай поменяем", "Купить Premium"])(
    "drops «%s»",
    (text) => expect(chipTextForbidden(text)).toBe(true),
  );

  it.each(["Ещё не знаю", "Мне нравится тихо", "Впритык", "Покажи моё свидание", "По-разному"])(
    "keeps «%s»",
    (text) => expect(chipTextForbidden(text)).toBe(false),
  );
});

describe("buildChipSet", () => {
  const base = { wantExit: false, night: false, steps: ["my_date"] as const, language: "ru" as const };

  it("keeps 2–3 answers to one question and never mixes them with a step", () => {
    const set = buildChipSet({
      ...base,
      verdict: verdict({
        chips: [
          { kind: "answer", text: "Заранее", step: "none" },
          { kind: "answer", text: "Впритык", step: "none" },
          { kind: "step", text: "Покажи моё свидание", step: "my_date" },
        ],
      }),
    });
    expect(set.items.map((i) => i.kind)).toEqual(["answer", "answer"]);
  });

  it("drops a single leading answer and a step that is not available", () => {
    const set = buildChipSet({
      ...base,
      steps: [],
      verdict: verdict({
        chips: [
          { kind: "answer", text: "Да", step: "none" },
          { kind: "step", text: "Смени место", step: "venue_change" },
          { kind: "clarify", text: "Как это сказать?", step: "none" },
        ],
      }),
    });
    expect(set.items).toEqual([{ id: "r1", kind: "clarify", text: "Как это сказать?" }]);
  });

  it("filters hooks, long and emoji-only texts", () => {
    const set = buildChipSet({
      ...base,
      verdict: verdict({
        chips: [
          { kind: "clarify", text: "Расскажи ещё", step: "none" },
          { kind: "step", text: "🔥🔥", step: "my_date" },
          { kind: "clarify", text: "А можно очень-очень подробно и с примерами?", step: "none" },
        ],
      }),
    });
    expect(set.items).toEqual([]);
  });

  it("adds the exit last by day and first at night, where clarify and answers go", () => {
    const chips = [
      { kind: "step" as const, text: "Покажи моё свидание", step: "my_date" as const },
      { kind: "clarify" as const, text: "А о чём говорить?", step: "none" as const },
    ];
    const day = buildChipSet({ ...base, wantExit: true, verdict: verdict({ chips }) });
    expect(day.items.map((i) => i.kind)).toEqual(["step", "clarify", "close"]);
    expect(day.items[2]!.text).toBe("На сегодня всё");
    const night = buildChipSet({ ...base, wantExit: true, night: true, verdict: verdict({ chips }) });
    expect(night.items.map((i) => i.kind)).toEqual(["close", "step"]);
  });

  it("shows the exit alone when the model returned nothing on a long chat", () => {
    expect(buildChipSet({ ...base, wantExit: true, verdict: null }).items.map((i) => i.kind)).toEqual(["close"]);
  });

  it("quiet means nothing at all, safety latches", () => {
    expect(buildChipSet({ ...base, wantExit: true, verdict: verdict({ quiet: true }) })).toEqual({ items: [], safety: false });
    expect(buildChipSet({ ...base, wantExit: true, verdict: verdict({ safety: true }) })).toEqual({ items: [], safety: true });
  });
});

describe("generateChipSet", () => {
  const input = {
    language: "ru" as const,
    rows: [],
    userText: "Он пишет каждые 10 минут и знает, где я живу",
    reply: "Ты не обязана отвечать.",
    steps: [],
    wantExit: true,
    night: false,
  };

  it("moderation danger wins over the model", async () => {
    const set = await generateChipSet(input, {
      callJson: async <T,>() => verdict({ chips: [{ kind: "clarify", text: "Что делать?", step: "none" }] }) as T,
      moderate: async () => true,
    });
    expect(set).toEqual({ items: [], safety: true });
  });

  it("fails closed when the model call fails", async () => {
    const set = await generateChipSet(
      { ...input, wantExit: false },
      { callJson: async () => { throw new Error("timeout"); }, moderate: async () => false },
    );
    expect(set.items).toEqual([]);
  });
});

describe("steps", () => {
  it("offers only what the agent can do now", () => {
    expect(availableSteps({ scheduledDate: false, recentDateWithoutFeedback: false }, { surface: "app", eventsTool: false })).toEqual([]);
    expect(availableSteps({ scheduledDate: true, recentDateWithoutFeedback: false }, { surface: "telegram", eventsTool: true })).toEqual([
      "my_date",
      "venue_change",
    ]);
    expect(availableSteps({ scheduledDate: false, recentDateWithoutFeedback: true }, { surface: "app", eventsTool: true })).toEqual([
      "date_feedback",
      "events",
    ]);
  });
});

describe("close line", () => {
  it("never asks a question and follows the clock", () => {
    for (const lang of ["ru", "en", "uk", "de", "pl"] as const) {
      for (const at of [DAY, NIGHT, new Date("2026-11-19T17:30:00Z")]) {
        const line = closeLine(lang, at, KYIV);
        expect(line).not.toContain("?");
        expect(line.length).toBeGreaterThan(3);
      }
    }
    expect(closeLine("ru", NIGHT, KYIV)).toBe("Хорошо. Спокойной ночи.");
  });
});

describe("holdout", () => {
  it("is stable and near the declared share", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const held = ids.filter((id) => inHoldout(id)).length;
    expect(held / ids.length).toBeGreaterThan(0.06);
    expect(held / ids.length).toBeLessThan(0.14);
    expect(inHoldout(ids[7]!)).toBe(inHoldout(ids[7]!));
  });
});

describe("telegram session", () => {
  it("recognises a tap, counts ignored sets and starts a new conversation after six hours", () => {
    const session: Parameters<typeof telegramTurnBegins>[0] = {
      agentReplies: { items: [{ id: "r1", kind: "answer", text: "Впритык" }, { id: "close", kind: "close", text: "На сегодня всё" }], at: 0 },
    };
    const now = 1_000_000_000;
    expect(telegramTurnBegins(session, "впритык", now)).toMatchObject({ id: "r1", kind: "answer" });
    expect(session.agentReplies).toBeNull();
    expect(session.agentRepliesIgnored).toBe(0);
    expect(session.agentChatTurns).toBe(1);

    session.agentReplies = { items: [{ id: "r1", kind: "clarify", text: "Как?" }], at: now };
    expect(telegramTurnBegins(session, "сама напишу", now + 1000)).toBeNull();
    expect(session.agentRepliesIgnored).toBe(1);
    expect(session.agentChatTurns).toBe(2);

    telegramTurnBegins(session, "привет", now + 7 * 60 * 60 * 1000);
    expect(session.agentChatTurns).toBe(1);
  });

  it("transcript drops this turn's pair and tool rows", () => {
    const rows = telegramTranscript([
      { role: "user", content: "привет" },
      { role: "assistant", content: "Привет." },
      { role: "tool", content: "{}" },
      { role: "user", content: "в субботу свидание" },
      { role: "assistant", content: "План такой…" },
    ]);
    expect(rows).toEqual([
      { role: "user", text: "привет" },
      { role: "assistant", text: "Привет." },
    ]);
  });
});

describe("stored set", () => {
  it("reads only its own kind", () => {
    expect(readSuggestedReplies({ kind: "change_offer" })).toBeNull();
    expect(readSuggestedReplies({ kind: "suggested_replies", items: [{ id: "r1", kind: "answer", text: "Да" }], at: "x" })?.items).toHaveLength(1);
  });
});
