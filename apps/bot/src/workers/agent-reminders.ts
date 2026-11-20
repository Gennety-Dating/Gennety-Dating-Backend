import type { Api } from "grammy";
import { agentRemindersUsers } from "../services/feature-preview.js";
import { sendDueReminders, sweepFinishedReminders } from "../services/agent-reminders.js";

/**
 * Personal reminders (decision 2026-11-20): every minute, send what is due;
 * once an hour, delete finished rows past retention. With the flag off and an
 * empty preview list nothing is sent, and reminders already set wait. The
 * sweep runs regardless — deleting old rows is never gated.
 */
export async function agentRemindersTick(api: Pick<Api, "sendMessage">, now: Date = new Date()): Promise<void> {
  if (now.getUTCMinutes() === 7) {
    const swept = await sweepFinishedReminders(now);
    if (swept > 0) console.log(`[reminders] swept=${swept}`);
  }
  const users = agentRemindersUsers();
  if (users !== null && users.length === 0) return;
  const sent = await sendDueReminders(now, { api, users });
  if (sent > 0) console.log(`[reminders] sent=${sent}`);
}
