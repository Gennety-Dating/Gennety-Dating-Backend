import { placeTipsUsers } from "../services/feature-preview.js";
import { sendPlaceTips } from "../services/place-tips.js";

/**
 * Proactive place tips (decision 2026-11-26): every 30 minutes, at most one
 * tip per eligible person (`services/place-tips.ts` holds every rule). With
 * the flag off and an empty preview list nothing is read and nothing is sent.
 */
export async function placeTipsTick(now: Date = new Date()): Promise<void> {
  const users = placeTipsUsers();
  if (users !== null && users.length === 0) return;
  const sent = await sendPlaceTips(now, { users });
  if (sent > 0) console.log(`[place-tips] sent=${sent}`);
}
