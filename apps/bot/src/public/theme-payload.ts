import type { Theme, ThemeMode } from "@gennety/db";

/**
 * Validation for `PATCH /v1/me/theme`, kept out of `routes/me.ts` so it can be
 * tested without standing up that router — it drags in multer, storage, vision
 * and the onboarding agent, none of which this decision touches.
 */
export interface ThemePayload {
  mode: ThemeMode;
  theme: Theme;
}

const MODES: ThemeMode[] = ["system", "light", "dark"];
const THEMES: Theme[] = ["light", "dark"];

/**
 * Returns the parsed pair, or the reason it was refused.
 *
 * The third guard is the one that matters: an explicit `light`/`dark` pick
 * whose resolved colour disagrees with itself is a client bug, and storing it
 * would leave the app and the Telegram cards in different themes — the exact
 * split this endpoint exists to close. `system` is the only mode allowed to
 * carry either colour, because there the phone, not the person, decides.
 */
export function parseThemePayload(body: unknown): ThemePayload | { error: string } {
  const raw = (body ?? {}) as { mode?: unknown; theme?: unknown };
  const mode = MODES.find((m) => m === raw.mode);
  if (!mode) return { error: "Invalid mode" };
  const theme = THEMES.find((t) => t === raw.theme);
  if (!theme) return { error: "Invalid theme" };
  if (mode !== "system" && mode !== theme) return { error: "mode and theme disagree" };
  return { mode, theme };
}
