import type {
  CombinedModerationResult,
  ModerationProviderResult,
  ModerationSignal,
  ProviderError,
} from "./types.js";

/**
 * Combine independent provider signals without turning a provider outage into
 * approval. A single hard-block signal rejects the media. Review-only signals
 * remain distinct so the caller can request a clearer/safer replacement.
 */
export function combineModerationResults(
  results: readonly ModerationProviderResult[],
): CombinedModerationResult {
  const signals: ModerationSignal[] = [];
  const errors: ProviderError[] = [];

  for (const result of results) {
    if (result.ok) {
      signals.push(...result.signals);
    } else {
      errors.push(result.error);
    }
  }

  if (signals.some((signal) => signal.severity === "block")) {
    return { kind: "blocked", signals };
  }

  if (signals.some((signal) => signal.severity === "review")) {
    return { kind: "review", signals };
  }

  if (errors.length > 0) {
    return { kind: "unavailable", errors: Array.from(new Set(errors)) };
  }

  return { kind: "safe", signals: [] };
}
