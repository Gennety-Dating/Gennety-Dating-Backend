import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  userId: string;
  text: string;
  dueAt: Date;
  timeZone: string;
  surface: string;
  sessionId: string | null;
  state: string;
  exactTime: boolean;
  snoozes: number;
  sentAt: Date | null;
  answeredAt: Date | null;
  messageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

let rows: Row[] = [];
let messages: Array<{ id: string; userId: string; sessionId: string; content: string; attachment: unknown; createdAt: Date }> = [];
let seq = 0;
const user = { language: "ru", telegramId: 42n, status: "active", botBlockedAt: null as Date | null };

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    const val = (row as unknown as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const cond = v as Record<string, unknown>;
      if ("lte" in cond && !((val as Date) <= (cond.lte as Date))) return false;
      if ("in" in cond && !(cond.in as unknown[]).includes(val)) return false;
      continue;
    }
    if (val !== v) return false;
  }
  return true;
}

vi.mock("@gennety/db", () => ({
  Prisma: {},
  prisma: {
    agentReminder: {
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
          .slice(0, take ?? 100)
          .map((r) => ({ ...r, user })),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null,
      count: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)).length,
      create: async ({ data }: { data: Partial<Row> }) => {
        const row = {
          id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
          state: "pending",
          exactTime: false,
          snoozes: 0,
          sentAt: null,
          answeredAt: null,
          messageId: null,
          sessionId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as Row;
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) {
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === "object" && "increment" in (v as object)) {
              (r as unknown as Record<string, number>)[k] += (v as { increment: number }).increment;
            } else {
              (r as unknown as Record<string, unknown>)[k] = v;
            }
          }
        }
        return { count: hit.length };
      },
    },
    chatSession: {
      findUnique: async () => ({ userId: "u1", updatedAt: new Date("2026-11-21T07:00:00Z") }),
      create: async () => ({ id: "s-new" }),
    },
    message: {
      create: async ({ data }: { data: { userId: string; sessionId: string; content: string; attachment?: unknown } }) => {
        const m = { id: `m${messages.length + 1}`, createdAt: new Date(), attachment: null, ...data };
        messages.push(m);
        return m;
      },
    },
  },
}));
vi.mock("./feature-preview.js", () => ({
  agentRemindersOn: () => true,
  suggestedRepliesOn: () => true,
  suggestedRepliesPreview: () => false,
}));
vi.mock("./chat-sessions.js", () => ({ touchChatSession: async () => undefined }));
vi.mock("./push.js", () => ({ sendPushToUser: vi.fn(async () => true) }));
vi.mock("./profile-media-validation/openai-moderation.js", () => ({ moderateTextWithOpenAI: async () => ({ ok: true, signals: [] }) }));

import { setVariantRng } from "@gennety/shared";
import {
  answerReminder,
  backToChatText,
  executeReminderTool,
  formatWhen,
  localToInstant,
  sendDueReminders,
} from "./agent-reminders.js";

const KYIV = "Europe/Kyiv";
// Wednesday 19 Nov 2026, 14:00 in Kyiv (UTC+2).
const NOW = new Date("2026-11-19T12:00:00Z");
const ctx = { userId: "u1", surface: "app" as const, sessionId: "s1", language: "ru" as const, timeZone: KYIV, now: NOW };

beforeEach(() => {
  rows = [];
  messages = [];
  seq = 0;
  user.botBlockedAt = null;
  setVariantRng(() => 0);
});

describe("time", () => {
  it("reads a local time in the person's zone", () => {
    expect(localToInstant("2026-11-21T10:00", KYIV)?.toISOString()).toBe("2026-11-21T08:00:00.000Z");
    expect(localToInstant("2026-11-21T10:00", "America/New_York")?.toISOString()).toBe("2026-11-21T15:00:00.000Z");
    expect(localToInstant("21.11 10:00", KYIV)).toBeNull();
    expect(localToInstant("2026-13-01T10:00", KYIV)).toBeNull();
  });

  it("keeps the local clock across a DST change", () => {
    // Kyiv leaves summer time on 25 Oct 2026: 10:00 local is 07:00Z before, 08:00Z after.
    expect(localToInstant("2026-10-24T10:00", KYIV)?.toISOString()).toBe("2026-10-24T07:00:00.000Z");
    expect(localToInstant("2026-10-26T10:00", KYIV)?.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("says today, tomorrow or the date", () => {
    expect(formatWhen(new Date("2026-11-19T16:00:00Z"), KYIV, "ru", NOW)).toBe("сегодня в 18:00");
    expect(formatWhen(new Date("2026-11-20T08:00:00Z"), KYIV, "ru", NOW)).toBe("завтра в 10:00");
    expect(formatWhen(new Date("2026-11-21T08:00:00Z"), KYIV, "ru", NOW)).toMatch(/^сб, 21 ноября в 10:00$/);
  });
});

describe("set_reminder", () => {
  it("sets one with a code-owned receipt", async () => {
    const out = await executeReminderTool(ctx, "set_reminder", { text: "написать Маше", local_time: "2026-11-21T10:00", exact_time: false });
    expect(JSON.parse(out.result)).toMatchObject({ success: true });
    expect(out.receipt).toMatch(/^Напомню сб, 21 ноября в 10:00: написать Маше$/);
    expect(rows[0]).toMatchObject({ userId: "u1", surface: "app", sessionId: "s1", state: "pending", exactTime: false, timeZone: KYIV });
  });

  it("refuses a reminder to come back to the chat", async () => {
    const out = await executeReminderTool(ctx, "set_reminder", { text: "вернись поговорить со мной", local_time: "2026-11-21T10:00", exact_time: false });
    expect(JSON.parse(out.result).error).toBe("not_about_life");
    expect(backToChatText("зайди в Gennety")).toBe(true);
    expect(backToChatText("купить цветы")).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it.each([
    ["the past", "2026-11-19T13:00", "in_the_past"],
    ["too close", "2026-11-19T14:02", "in_the_past"],
    ["too far", "2027-06-01T10:00", "too_far"],
    ["garbage", "в пятницу", "bad_time"],
  ])("refuses %s", async (_name, local, error) => {
    const out = await executeReminderTool(ctx, "set_reminder", { text: "x", local_time: local, exact_time: false });
    expect(JSON.parse(out.result).error).toBe(error);
    expect(out.receipt).toBeNull();
  });

  it("holds at ten live reminders", async () => {
    for (let i = 0; i < 10; i++) {
      await executeReminderTool(ctx, "set_reminder", { text: `дело ${i}`, local_time: "2026-11-22T10:00", exact_time: false });
    }
    const out = await executeReminderTool(ctx, "set_reminder", { text: "ещё дело", local_time: "2026-11-22T10:00", exact_time: false });
    expect(JSON.parse(out.result).error).toBe("too_many");
  });

  it("lists and cancels", async () => {
    await executeReminderTool(ctx, "set_reminder", { text: "купить цветы", local_time: "2026-11-20T19:00", exact_time: false });
    const list = JSON.parse((await executeReminderTool(ctx, "list_reminders", {})).result);
    expect(list.reminders).toEqual([{ id: rows[0]!.id, text: "купить цветы", when: "завтра в 19:00" }]);
    const out = await executeReminderTool(ctx, "cancel_reminder", { id: rows[0]!.id });
    expect(out.receipt).toBe("Напоминание отменено: купить цветы");
    expect(rows[0]!.state).toBe("cancelled");
  });
});

describe("delivery", () => {
  async function due(over: Partial<Row> = {}) {
    await executeReminderTool(ctx, "set_reminder", { text: "написать Маше", local_time: "2026-11-21T10:00", exact_time: false });
    Object.assign(rows[rows.length - 1]!, over);
    return rows[rows.length - 1]!;
  }

  it("arrives once in the app chat with a card and a push", async () => {
    const r = await due();
    const at = new Date("2026-11-21T08:00:30Z");
    const push = vi.fn(async () => true);
    expect(await sendDueReminders(at, { push })).toBe(1);
    expect(await sendDueReminders(at, { push })).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ sessionId: "s1", content: "Напоминаю: написать Маше", attachment: { kind: "agent_reminder", reminderId: r.id } });
    expect(push).toHaveBeenCalledWith("u1", expect.objectContaining({ title: "Напоминание", body: "написать Маше", data: { type: "chat.reminder", sessionId: "s1" } }));
    expect(r).toMatchObject({ state: "sent", messageId: "m1" });
  });

  it("waits out quiet hours unless the person named the time", async () => {
    const quiet = new Date("2026-11-21T22:30:00Z"); // 00:30 in Kyiv
    const r = await due({ dueAt: new Date("2026-11-21T22:00:00Z") });
    expect(await sendDueReminders(quiet, { push: async () => true })).toBe(0);
    expect(r.state).toBe("pending");
    r.exactTime = true;
    expect(await sendDueReminders(quiet, { push: async () => true })).toBe(1);
  });

  it("drops a reminder a day late, silently", async () => {
    const r = await due();
    expect(await sendDueReminders(new Date("2026-11-22T09:00:00Z"), { push: async () => true })).toBe(0);
    expect(r.state).toBe("cancelled");
  });

  it("sends Telegram reminders with two buttons", async () => {
    await executeReminderTool({ ...ctx, surface: "telegram", sessionId: null }, "set_reminder", { text: "купить цветы", local_time: "2026-11-21T10:00", exact_time: false });
    const sendMessage = vi.fn(async () => ({}));
    expect(await sendDueReminders(new Date("2026-11-21T08:01:00Z"), { api: { sendMessage } as never })).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith(42, "Напоминаю: купить цветы", expect.objectContaining({ reply_markup: expect.anything() }));
  });
});

describe("the buttons", () => {
  async function sent() {
    await executeReminderTool(ctx, "set_reminder", { text: "написать Маше", local_time: "2026-11-21T10:00", exact_time: false });
    const r = rows[0]!;
    r.state = "sent";
    r.sentAt = new Date("2026-11-21T08:00:00Z");
    return r;
  }

  it("«Сделано» closes it once", async () => {
    const r = await sent();
    const at = new Date("2026-11-21T09:00:00Z");
    expect(await answerReminder("u1", r.id, "done", "ru", at)).toEqual({ ok: true, line: "Отлично.", state: "done", changed: true });
    expect(await answerReminder("u1", r.id, "done", "ru", at)).toMatchObject({ ok: true, changed: false });
    expect(r.state).toBe("done");
  });

  it("«Напомни завтра» moves it a day, at most three times", async () => {
    const r = await sent();
    const at = new Date("2026-11-21T09:00:00Z");
    const first = await answerReminder("u1", r.id, "tomorrow", "ru", at);
    expect(first).toMatchObject({ ok: true, state: "snoozed", changed: true, line: "Хорошо, завтра в 10:00." });
    expect(r).toMatchObject({ state: "pending", snoozes: 1 });
    expect(r.dueAt.toISOString()).toBe("2026-11-22T08:00:00.000Z");
    r.state = "sent";
    r.snoozes = 3;
    expect(await answerReminder("u1", r.id, "tomorrow", "ru", at)).toEqual({ ok: false, error: "snooze-limit" });
  });

  it("is someone else's → not found", async () => {
    const r = await sent();
    expect(await answerReminder("u2", r.id, "done", "ru")).toEqual({ ok: false, error: "not-found" });
  });
});
