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

  const reviewSignals = signals.filter(
    (signal) => signal.severity === "review",
  );
  if (reviewSignals.length > 0) {
    const openAIReview = reviewSignals.some(
      (signal) => signal.provider === "openai",
    );
    const highRiskAwsReview = reviewSignals.some(
      (signal) =>
        signal.provider === "aws" &&
        signal.score >= 0.8 &&
        /\b(?:violence|weapon|visually disturbing|self harm)\b/iu.test(
          signal.category,
        ),
    );
    if (openAIReview || highRiskAwsReview) {
      return { kind: "review", signals };
    }
  }

  if (errors.length > 0) {
    return { kind: "unavailable", errors: Array.from(new Set(errors)) };
  }

  return { kind: "safe", signals };
}
