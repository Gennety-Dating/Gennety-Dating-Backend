import type { Api } from "grammy";
import { InlineKeyboard } from "grammy";
import { Prisma, prisma } from "@gennety/db";
import {
  AGENT_REMINDERS,
  CHAT_REMINDER_PUSH_TYPE,
  REMINDER_BACK_TO_CHAT_FRAGMENTS,
  isQuietHourIn,
  isValidTimeZone,
  normalizeChipText,
  t,
  tv,
  type Language,
} from "@gennety/shared";
import { agentRemindersOn } from "./feature-preview.js";
import { sendPushToUser } from "./push.js";
import { touchChatSession } from "./chat-sessions.js";
import { personTimeZone } from "./suggested-replies.js";

/**
 * Personal reminders the agent sets on the person's request (decision
 * 2026-11-20, `docs/product/domains/agent-reminders.md`).
 *
 * Only on request, only about life outside the chat, delivered once as a
 * code-owned agent message with «Сделано» / «Напомни завтра», and never a
 * question after it (agent concept rules 6–7).
 */

export type ReminderSurface = "app" | "telegram";

export const SET_REMINDER_TOOL_NAME = "set_reminder";
export const LIST_REMINDERS_TOOL_NAME = "list_reminders";
export const CANCEL_REMINDER_TOOL_NAME = "cancel_reminder";

export const REMINDER_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: SET_REMINDER_TOOL_NAME,
      description:
        "Set a personal reminder ONLY when the person asks for one in this message («напомни…», «remind me…») or tapped a «Напомни…» suggestion. " +
        "It must be about something they will do in their life (text her, buy flowers, call mum), never about coming back to this chat. " +
        "Do not set one for their booked date — the product already reminds them; say so instead. " +
        "Resolve the time from their words and the clock line: a named day without a time means 10:00, «вечером» 19:00, «завтра» 10:00 tomorrow. " +
        "If the time is too vague («потом»), ask once instead of calling. After it succeeds, confirm in a few words — a receipt with the exact time is shown under your reply, do not repeat the date.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: `What to remind them of, in their language and their words, short (max ${AGENT_REMINDERS.textMaxChars} chars), e.g. «написать Маше».` },
          local_time: { type: "string", description: "When, in the person's own local time: YYYY-MM-DDTHH:mm." },
          exact_time: { type: "boolean", description: "True only when they named the clock time themselves («в 23:30»)." },
        },
        required: ["text", "local_time", "exact_time"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: LIST_REMINDERS_TOOL_NAME,
      description: "List the person's upcoming reminders, when they ask what reminders they have.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: CANCEL_REMINDER_TOOL_NAME,
      description: "Cancel one upcoming reminder the person asked to cancel. Call list_reminders first if you do not know its id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The reminder id from list_reminders." } },
        required: ["id"],
      },
    },
  },
];

export const REMINDER_TOOL_KINDS: Record<string, "read" | "write"> = {
  [SET_REMINDER_TOOL_NAME]: "write",
  [LIST_REMINDERS_TOOL_NAME]: "read",
  [CANCEL_REMINDER_TOOL_NAME]: "write",
};

export function isReminderTool(name: string): boolean {
  return name in REMINDER_TOOL_KINDS;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Offset of `timeZone` from UTC at `at`, in minutes. */
function offsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** «2026-11-21T10:00» in `timeZone` → the instant. Null when malformed. */
export function localToInstant(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle a DST edge.
  let at = new Date(naive - offsetMinutes(new Date(naive), timeZone) * 60000);
  at = new Date(naive - offsetMinutes(at, timeZone) * 60000);
  return at;
}

function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export function formatClock(at: Date, timeZone: string, language: Language): string {
  return new Intl.DateTimeFormat(language, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

/** «сегодня в 18:00», «завтра в 10:00», «пт, 21 ноября в 10:00». */
export function formatWhen(at: Date, timeZone: string, language: Language, now: Date = new Date()): string {
  const day = localDay(at, timeZone);
  const clock = formatClock(at, timeZone, language);
  const at_ = t(language, "remindersAt");
  if (day === localDay(now, timeZone)) return `${t(language, "remindersToday")} ${at_} ${clock}`;
  if (day === localDay(new Date(now.getTime() + 24 * 3600 * 1000), timeZone)) return `${t(language, "remindersTomorrow")} ${at_} ${clock}`;
  const date = new Intl.DateTimeFormat(language, { timeZone, weekday: "short", day: "numeric", month: "long" }).format(at);
  return `${date} ${at_} ${clock}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ReminderToolContext {
  userId: string;
  surface: ReminderSurface;
  sessionId: string | null;
  language: Language;
  timeZone: string;
  now?: Date;
}

export interface ReminderToolOutcome {
  result: string;
  /** A code-owned receipt, already localised, for a write that landed. */
  receipt: string | null;
}

const fail = (error: string, instruction: string): ReminderToolOutcome => ({
  result: JSON.stringify({ success: false, error, instruction }),
  receipt: null,
});

export function backToChatText(text: string): boolean {
  const norm = ` ${normalizeChipText(text)} `;
  return REMINDER_BACK_TO_CHAT_FRAGMENTS.some((frag) => norm.includes(frag));
}

export async function executeReminderTool(
  ctx: ReminderToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ReminderToolOutcome> {
  const now = ctx.now ?? new Date();
  if (name === LIST_REMINDERS_TOOL_NAME) {
    const rows = await prisma.agentReminder.findMany({
      where: { userId: ctx.userId, state: "pending" },
      orderBy: { dueAt: "asc" },
      take: AGENT_REMINDERS.maxLive,
      select: { id: true, text: true, dueAt: true, timeZone: true },
    });
    return {
      result: JSON.stringify({
        success: true,
        reminders: rows.map((r) => ({ id: r.id, text: r.text, when: formatWhen(r.dueAt, r.timeZone, ctx.language, now) })),
      }),
      receipt: null,
    };
  }

  if (name === CANCEL_REMINDER_TOOL_NAME) {
    const id = typeof args.id === "string" ? args.id.trim().toLowerCase() : "";
    const row = id
      ? await prisma.agentReminder.findFirst({ where: { id, userId: ctx.userId, state: "pending" }, select: { id: true, text: true } }).catch(() => null)
      : null;
    if (!row) return fail("not_found", "No such upcoming reminder. Call list_reminders and use its id.");
    await prisma.agentReminder.update({ where: { id: row.id }, data: { state: "cancelled", answeredAt: now } });
    return { result: JSON.stringify({ success: true }), receipt: t(ctx.language, "remindersCancelledReceipt", { text: row.text }) };
  }

  if (name !== SET_REMINDER_TOOL_NAME) return fail("unknown_tool", "Answer without it.");

  const text = typeof args.text === "string" ? args.text.replace(/\s+/g, " ").trim() : "";
  if (!text || [...text].length > AGENT_REMINDERS.textMaxChars) {
    return fail("bad_text", `Keep the reminder text short, 1–${AGENT_REMINDERS.textMaxChars} characters.`);
  }
  if (backToChatText(text)) {
    return fail("not_about_life", "A reminder is for something in their life, not for coming back here. Say so in one line; set nothing.");
  }
  const zone = isValidTimeZone(ctx.timeZone) ? ctx.timeZone : personTimeZone(null);
  const dueAt = typeof args.local_time === "string" ? localToInstant(args.local_time, zone) : null;
  if (!dueAt) return fail("bad_time", "local_time must be YYYY-MM-DDTHH:mm in their local time. If their words are too vague, ask once.");
  if (dueAt.getTime() < now.getTime() + AGENT_REMINDERS.minAheadMs) {
    return fail("in_the_past", "That time has passed or is too close. Ask when they want it, or pick the next occurrence.");
  }
  if (dueAt.getTime() > now.getTime() + AGENT_REMINDERS.maxAheadDays * 24 * 3600 * 1000) {
    return fail("too_far", `Reminders go at most ${AGENT_REMINDERS.maxAheadDays} days ahead. Say so in one line.`);
  }
  const live = await prisma.agentReminder.count({ where: { userId: ctx.userId, state: "pending" } });
  if (live >= AGENT_REMINDERS.maxLive) {
    return fail("too_many", `They already have ${AGENT_REMINDERS.maxLive} upcoming reminders. Offer to cancel one first.`);
  }
  const row = await prisma.agentReminder.create({
    data: {
      userId: ctx.userId,
      text,
      dueAt,
      timeZone: zone,
      surface: ctx.surface,
      sessionId: ctx.sessionId,
      exactTime: args.exact_time === true,
    },
    select: { id: true },
  });
  console.info(`[reminders] set surface=${ctx.surface} ahead_h=${Math.round((dueAt.getTime() - now.getTime()) / 3600000)}`);
  return {
    result: JSON.stringify({ success: true, id: row.id, when: formatWhen(dueAt, zone, ctx.language, now) }),
    receipt: t(ctx.language, "remindersReceipt", { when: formatWhen(dueAt, zone, ctx.language, now), text }),
  };
}

// ---------------------------------------------------------------------------
// The card under an arriving reminder (app)
// ---------------------------------------------------------------------------

/** `messages.attachment` of the agent row a reminder arrived as. */
export interface ReminderCard {
  kind: "agent_reminder";
  reminderId: string;
  text: string;
  dueAt: string;
}

export interface ReminderCardView {
  /** `sent` (buttons live), `done`, `snoozed` (moved to tomorrow) or `cancelled`. */
  state: "sent" | "done" | "snoozed" | "cancelled";
  text: string;
  dueAt: string;
}

export function readReminderCard(raw: unknown): ReminderCard | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Partial<ReminderCard>;
  if (v.kind !== "agent_reminder" || typeof v.reminderId !== "string" || typeof v.text !== "string") return null;
  return { kind: "agent_reminder", reminderId: v.reminderId, text: v.text, dueAt: typeof v.dueAt === "string" ? v.dueAt : "" };
}

function viewState(row: { state: string; messageId: string | null }, messageId: string): ReminderCardView["state"] {
  if (row.state === "done") return "done";
  if (row.state === "cancelled") return "cancelled";
  // Snoozed: the row is pending again, or it arrived later as another message.
  if (row.state === "pending" || row.messageId !== messageId) return "snoozed";
  return "sent";
}

/** Views of the cards on a page of history, one read for all of them. */
export async function reminderCardViews(
  cards: ReadonlyArray<{ messageId: string; card: ReminderCard }>,
): Promise<Map<string, ReminderCardView>> {
  if (cards.length === 0) return new Map();
  const rows = await prisma.agentReminder.findMany({
    where: { id: { in: cards.map((c) => c.card.reminderId) } },
    select: { id: true, state: true, messageId: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return new Map(
    cards.map(({ messageId, card }) => {
      const row = byId.get(card.reminderId);
      return [messageId, { state: row ? viewState(row, messageId) : "cancelled", text: card.text, dueAt: card.dueAt }];
    }),
  );
}

// ---------------------------------------------------------------------------
// «Сделано» / «Напомни завтра»
// ---------------------------------------------------------------------------

export type ReminderAction = "done" | "tomorrow";

export type AnswerResult =
  | { ok: true; line: string; state: "done" | "snoozed"; changed: boolean }
  | { ok: false; error: "not-found" | "snooze-limit" };

/**
 * One answer per arrival. A row that is already answered answers its state
 * again and changes nothing, so a double tap is harmless.
 */
export async function answerReminder(
  userId: string,
  reminderId: string,
  action: ReminderAction,
  language: Language,
  now: Date = new Date(),
): Promise<AnswerResult> {
  const row = await prisma.agentReminder.findFirst({
    where: { id: reminderId, userId },
    select: { id: true, state: true, dueAt: true, timeZone: true, snoozes: true },
  });
  if (!row) return { ok: false, error: "not-found" };
  if (row.state === "done") return { ok: true, line: tv(language, "remindersDoneLine"), state: "done", changed: false };
  if (row.state === "pending") {
    return { ok: true, line: t(language, "remindersSnoozedLine", { time: formatClock(row.dueAt, row.timeZone, language) }), state: "snoozed", changed: false };
  }
  if (row.state !== "sent") return { ok: false, error: "not-found" };

  if (action === "done") {
    const claimed = await prisma.agentReminder.updateMany({
      where: { id: row.id, state: "sent" },
      data: { state: "done", answeredAt: now },
    });
    console.info("[reminders] done");
    return { ok: true, line: tv(language, "remindersDoneLine"), state: "done", changed: claimed.count > 0 };
  }
  if (row.snoozes >= AGENT_REMINDERS.maxSnoozes) return { ok: false, error: "snooze-limit" };
  // Same clock time tomorrow — at least a day from now, never in the past.
  let next = new Date(row.dueAt.getTime() + 24 * 3600 * 1000);
  while (next.getTime() < now.getTime() + 60 * 60 * 1000) next = new Date(next.getTime() + 24 * 3600 * 1000);
  const claimed = await prisma.agentReminder.updateMany({
    where: { id: row.id, state: "sent" },
    data: { state: "pending", dueAt: next, snoozes: { increment: 1 }, sentAt: null, answeredAt: now },
  });
  console.info("[reminders] snoozed");
  return {
    ok: true,
    line: t(language, "remindersSnoozedLine", { time: formatClock(next, row.timeZone, language) }),
    state: "snoozed",
    changed: claimed.count > 0,
  };
}

/** The app's buttons: answer by the agent row the reminder arrived as. */
export async function answerReminderMessage(
  userId: string,
  messageId: string,
  action: ReminderAction,
): Promise<
  | { ok: true; reminder: ReminderCardView; message: { id: string; content: string; createdAt: Date } | null }
  | { ok: false; error: "not-found" | "snooze-limit" }
> {
  const msg = await prisma.message.findUnique({ where: { id: messageId }, select: { userId: true, sessionId: true, attachment: true } });
  const card = msg && msg.userId === userId ? readReminderCard(msg.attachment) : null;
  if (!msg || !card) return { ok: false, error: "not-found" };
  const account = await prisma.user.findUnique({ where: { id: userId }, select: { language: true } });
  const language = (account?.language ?? "en") as Language;
  const answer = await answerReminder(userId, card.reminderId, action, language);
  if (!answer.ok) return answer;
  let line: { id: string; content: string; createdAt: Date } | null = null;
  // The short line goes into the chat once — not again on a double tap.
  if (answer.changed && msg.sessionId) {
    const row = await prisma.message.create({
      data: { userId, sessionId: msg.sessionId, role: "assistant", content: answer.line, imageUrls: [] },
      select: { id: true, content: true, createdAt: true },
    });
    await touchChatSession(msg.sessionId, row.createdAt).catch(() => undefined);
    line = row;
  }
  return { ok: true, reminder: { state: answer.state, text: card.text, dueAt: card.dueAt }, message: line };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export function telegramReminderKeyboard(reminderId: string, language: Language): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(language, "remindersDoneBtn"), `rem:done:${reminderId}`)
    .text(t(language, "remindersTomorrowBtn"), `rem:tmr:${reminderId}`);
}

export interface DeliveryDeps {
  api?: Pick<Api, "sendMessage"> | null;
  push?: typeof sendPushToUser;
  /** Who may get sends (`null` = everyone with the flag). */
  users?: readonly string[] | null;
}

async function appChatFor(userId: string, sessionId: string | null, now: Date): Promise<string> {
  if (sessionId) {
    const s = await prisma.chatSession.findUnique({ where: { id: sessionId }, select: { userId: true, updatedAt: true } });
    if (s && s.userId === userId && now.getTime() - s.updatedAt.getTime() < AGENT_REMINDERS.chatGapMs) return sessionId;
  }
  const created = await prisma.chatSession.create({ data: { userId }, select: { id: true } });
  return created.id;
}

/**
 * Claim and send the due reminders. A row is claimed (pending → sent) before
 * anything leaves, so a crash costs that one reminder rather than repeating it.
 * Quiet hours hold back a reminder whose time the person did not name; it goes
 * on the first tick after they end. A reminder a day late is dropped silently.
 */
export async function sendDueReminders(now: Date = new Date(), deps: DeliveryDeps = {}): Promise<number> {
  const due = await prisma.agentReminder.findMany({
    where: {
      state: "pending",
      dueAt: { lte: now },
      ...(deps.users ? { userId: { in: [...deps.users] } } : {}),
    },
    orderBy: { dueAt: "asc" },
    take: AGENT_REMINDERS.batch,
    include: { user: { select: { language: true, telegramId: true, status: true, botBlockedAt: true } } },
  });
  let sent = 0;
  for (const r of due) {
    if (now.getTime() - r.dueAt.getTime() > AGENT_REMINDERS.staleAfterMs) {
      await prisma.agentReminder.updateMany({ where: { id: r.id, state: "pending" }, data: { state: "cancelled" } });
      continue;
    }
    if (r.user.status === "banned") continue;
    if (!r.exactTime && isQuietHourIn(now, r.timeZone)) continue;
    const claimed = await prisma.agentReminder.updateMany({ where: { id: r.id, state: "pending" }, data: { state: "sent", sentAt: now } });
    if (claimed.count === 0) continue;
    const language = (r.user.language ?? "en") as Language;
    const content = t(language, "remindersArrive", { text: r.text });
    try {
      if (r.surface === "telegram") {
        if (!deps.api || r.user.botBlockedAt) continue;
        await deps.api.sendMessage(Number(r.user.telegramId), content, {
          reply_markup: telegramReminderKeyboard(r.id, language),
        });
      } else {
        const sessionId = await appChatFor(r.userId, r.sessionId, now);
        const card: ReminderCard = { kind: "agent_reminder", reminderId: r.id, text: r.text, dueAt: r.dueAt.toISOString() };
        const message = await prisma.message.create({
          data: {
            userId: r.userId,
            sessionId,
            role: "assistant",
            content,
            imageUrls: [],
            attachment: card as unknown as Prisma.InputJsonValue,
          },
          select: { id: true, createdAt: true },
        });
        await touchChatSession(sessionId, message.createdAt).catch(() => undefined);
        await prisma.agentReminder.update({ where: { id: r.id }, data: { messageId: message.id, sessionId } });
        await (deps.push ?? sendPushToUser)(r.userId, {
          title: t(language, "remindersPushTitle"),
          body: r.text,
          collapseId: `reminder.${r.id}`,
          data: { type: CHAT_REMINDER_PUSH_TYPE, sessionId },
        });
      }
      sent++;
    } catch (err) {
      console.warn("[reminders] delivery failed:", err instanceof Error ? err.message : err);
    }
  }
  return sent;
}

/** Finished rows go 30 days after their last change (spec Phase 2 point 2). */
export async function sweepFinishedReminders(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - AGENT_REMINDERS.retentionDays * 24 * 3600 * 1000);
  const { count } = await prisma.agentReminder.deleteMany({
    where: { state: { in: ["done", "cancelled", "sent"] }, updatedAt: { lt: before } },
  });
  return count;
}

export { agentRemindersOn };

/**
 * The calendar the model needs to resolve «в пятницу»: the prompts carry the
 * weekday and the clock, never the date. Added only on turns that offer the
 * reminder tools, before the agent-concept block.
 */
export function reminderClockBlock(now: Date, timeZone: string): string {
  const zone = isValidTimeZone(timeZone) ? timeZone : personTimeZone(null);
  const today = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const iso = localDay(now, zone);
  return `### Reminders
- Today in their zone (${zone}): ${today} (${iso}). Resolve set_reminder's local_time from THIS date, never from your own sense of today.
- A weekday means its next occurrence: today only if that time is still ahead. «Завтра» is ${localDay(new Date(now.getTime() + 24 * 3600 * 1000), zone)}. «Через неделю» is ${localDay(new Date(now.getTime() + 7 * 24 * 3600 * 1000), zone)}.
- No clock time named: 10:00; «вечером» 19:00; «утром» 09:00. «Потом», «как-нибудь», «позже» are not a time — ask once («когда напомнить?»), do not guess.`;
}
