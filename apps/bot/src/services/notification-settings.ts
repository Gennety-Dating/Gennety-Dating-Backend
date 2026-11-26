import { prisma } from "@gennety/db";
import { setProfilerEnabled } from "./profiler.js";

/**
 * The person's switches for what Gennety sends on its own (agent concept
 * phase 4, founder 2026-11-26). One read and one write model for the Telegram
 * Settings menu and `GET/PATCH /v1/me/notifications`, so both surfaces show
 * the same answer.
 *
 * - `profilerQuestions` — item 1: the Profiler's questions about the person.
 *   Off = `Profile.profilerOptedOutAt` set; nothing is asked on either surface.
 * - `profilerPausedUntil` — read only: the 14-day Telegram pause after two
 *   ignored batches in a row, so a client can say why it is quiet.
 * - `onlyMyDates` — item 6: the per-type mute («только мои свидания»),
 *   `User.notifyOnlyDates`. What it silences: `services/notification-mute.ts`.
 */
export interface NotificationSettings {
  profilerQuestions: boolean;
  profilerPausedUntil: string | null;
  onlyMyDates: boolean;
}

export type NotificationSettingsPatch = Partial<Pick<NotificationSettings, "profilerQuestions" | "onlyMyDates">>;

export async function getNotificationSettings(
  userId: string,
  now: Date = new Date(),
): Promise<NotificationSettings> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      notifyOnlyDates: true,
      profile: { select: { profilerOptedOutAt: true, profilerPausedUntil: true } },
    },
  });
  const profile = user?.profile;
  const paused = profile?.profilerPausedUntil;
  return {
    profilerQuestions: !profile?.profilerOptedOutAt,
    profilerPausedUntil: paused && paused.getTime() > now.getTime() ? paused.toISOString() : null,
    onlyMyDates: user?.notifyOnlyDates === true,
  };
}

/** Strict: only known keys with boolean values, at least one of them. */
export function parseNotificationSettingsPatch(
  body: unknown,
): { patch: NotificationSettingsPatch } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be an object" };
  const allowed = new Set(["profilerQuestions", "onlyMyDates"]);
  const patch: NotificationSettingsPatch = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!allowed.has(key)) return { error: `Unknown field: ${key}` };
    if (typeof value !== "boolean") return { error: `${key} must be a boolean` };
    patch[key as keyof NotificationSettingsPatch] = value;
  }
  if (Object.keys(patch).length === 0) return { error: "Nothing to update" };
  return { patch };
}

/**
 * Apply a patch. Returns the Telegram message id of a Profiler question the
 * switch released, so the bot surface can strip its Skip button; the API has
 * no bot at hand and leaves the stale button to the stall sweep's no-op.
 */
export async function applyNotificationSettings(
  userId: string,
  patch: NotificationSettingsPatch,
  now: Date = new Date(),
): Promise<{ releasedMessageId: number | null }> {
  let releasedMessageId: number | null = null;
  if (patch.profilerQuestions !== undefined) {
    ({ releasedMessageId } = await setProfilerEnabled(userId, patch.profilerQuestions, now));
  }
  if (patch.onlyMyDates !== undefined) {
    await prisma.user.update({ where: { id: userId }, data: { notifyOnlyDates: patch.onlyMyDates } });
  }
  return { releasedMessageId };
}
