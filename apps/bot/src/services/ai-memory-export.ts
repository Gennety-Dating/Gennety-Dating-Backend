import type { AiMemoryExportPreference } from "@gennety/db";

import { env } from "../config.js";

/**
 * AI-memory export kill switch (PRODUCT_SPEC §1.1/§1.3, `AI_MEMORY_EXPORT_ENABLED`).
 *
 * The feature is ON by default; production can turn it off with a single env
 * var while it is being reworked on dev. The switch deliberately reuses the
 * branch the product already has for a user who *declined* the export, so
 * turning it off adds no new state machine: onboarding simply never offers the
 * choice and never asks for a Magic Prompt paste.
 *
 * Nothing about the flag is persisted. `User.aiMemoryExportPreference` keeps
 * whatever it held, so flipping the flag back on re-enables the branch for
 * everyone with no migration, backfill, or per-user cleanup.
 */
export function isAiMemoryExportEnabled(): boolean {
  return env.AI_MEMORY_EXPORT_ENABLED;
}

/**
 * The preference every read site should act on. While the feature is off the
 * stored value is masked to `declined` — the one branch that already means
 * "no Magic Prompt, go straight to photos, build the profile from the ordinary
 * onboarding answers + vibe".
 */
export function effectiveAiMemoryPreference(
  stored: AiMemoryExportPreference | null | undefined,
): AiMemoryExportPreference {
  if (!env.AI_MEMORY_EXPORT_ENABLED) return "declined";
  return stored ?? "undecided";
}

/** True when the AI-memory branch must be skipped for this user. */
export function isAiMemoryExportDeclined(
  stored: AiMemoryExportPreference | null | undefined,
): boolean {
  return effectiveAiMemoryPreference(stored) === "declined";
}
