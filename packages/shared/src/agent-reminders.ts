/**
 * Personal reminders the agent sets on request (decision 2026-11-20,
 * `docs/product/domains/agent-reminders.md`). Limits and timings live here
 * (AGENTS.md rule 8); the tools, worker and delivery are
 * `apps/bot/src/services/agent-reminders.ts`.
 */

export const AGENT_REMINDERS = {
  textMaxChars: 200,
  /** A reminder lands at least this far ahead. */
  minAheadMs: 5 * 60 * 1000,
  maxAheadDays: 90,
  /** Live (`pending`) reminders per person. */
  maxLive: 10,
  /** «Напомни завтра» taps per reminder. */
  maxSnoozes: 3,
  /** Finished rows are deleted this long after their last change. */
  retentionDays: 30,
  /** A due reminder older than this is not sent at all — it would only be noise. */
  staleAfterMs: 24 * 60 * 60 * 1000,
  /** An app chat quieter than this gets the reminder in a new chat. */
  chatGapMs: 6 * 60 * 60 * 1000,
  /** Rows a worker tick claims at most. */
  batch: 50,
} as const;

export const AGENT_REMINDER_STATES = ["pending", "sent", "done", "cancelled"] as const;
export type AgentReminderState = (typeof AGENT_REMINDER_STATES)[number];

/** The token a build lists in `X-Gennety-Chat-Cards` to draw the reminder card. */
export const REMINDER_CARD_CLIENT_TOKEN = "reminder";

/** Push `data.type` of an arriving reminder; opens the chat it landed in. */
export const CHAT_REMINDER_PUSH_TYPE = "chat.reminder";

/**
 * A reminder must be about the person's life, never a way back into the chat
 * (spec principle 2). Matched on the normalised text; the agent's own rules say
 * the same, this is the floor under them.
 */
export const REMINDER_BACK_TO_CHAT_FRAGMENTS: readonly string[] = [
  "gennety", "геннети", "в чат", "в приложени", "поговорить со мной", "написать тебе", "напиши мне", "вернись",
  "вернуться в чат", "зайди в", "come back", "talk to you", "chat with you", "open the app", "check the app",
  "повернись", "напиши мені", "zurückkommen", "schreib mir", "wróć", "napisz do mnie",
];
