import { env } from "../config.js";

/**
 * Whether the screenshot library and ideas are on for one person. A feature is
 * on when its global flag is on, or when the person's id is in its preview list
 * (`SCREENSHOT_LIBRARY_USER_IDS`, `MEMORY_IDEAS_USER_IDS`), so the founder can
 * try both in production while everyone else keeps the flag-off behaviour.
 *
 * Every per-person decision reads these two functions; nothing reads the flags
 * directly. A job that acts for many people asks `…Users()`: `null` means
 * everyone, a list means only those people, an empty list means nobody.
 */

type Flag = "SCREENSHOT_LIBRARY" | "MEMORY_IDEAS";

function previewList(flag: Flag): readonly string[] {
  const raw = (env as Record<string, unknown>)[`${flag}_USER_IDS`];
  return Array.isArray(raw) ? (raw as string[]) : [];
}

function globallyOn(flag: Flag): boolean {
  return (env as Record<string, unknown>)[`${flag}_ENABLED`] === true;
}

function onFor(flag: Flag, userId: string | null | undefined): boolean {
  if (globallyOn(flag)) return true;
  return Boolean(userId) && previewList(flag).includes((userId as string).toLowerCase());
}

function usersOf(flag: Flag): readonly string[] | null {
  return globallyOn(flag) ? null : previewList(flag);
}

export const screenshotLibraryOn = (userId: string | null | undefined): boolean => onFor("SCREENSHOT_LIBRARY", userId);
export const memoryIdeasOn = (userId: string | null | undefined): boolean => onFor("MEMORY_IDEAS", userId);
export const screenshotLibraryUsers = (): readonly string[] | null => usersOf("SCREENSHOT_LIBRARY");
export const memoryIdeasUsers = (): readonly string[] | null => usersOf("MEMORY_IDEAS");
