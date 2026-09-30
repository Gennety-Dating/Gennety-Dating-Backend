import type { StructuredOnboardingFacts } from "../services/onboarding-collector.js";

/**
 * Shape-check a basics patch and map it onto the collector's canonical field
 * names. Only shape lives here — ranges, enum whitelists and name normalization
 * are `validateFactValue`'s job, so the Mini App, the chat and the iOS rail all
 * answer to one set of rules.
 *
 * Shared by the Mini App's `POST /v1/telegram-onboarding/profile` and its
 * native twin `POST /v1/onboarding/basics` (DECISIONS 2026-09-30): one body,
 * one set of error codes, whichever rail the screen runs on.
 */
export function parseOnboardingBasicsPatch(
  body: Record<string, unknown>,
): { facts: StructuredOnboardingFacts } | { error: string } {
  const facts: StructuredOnboardingFacts = {};

  if (body.firstName !== undefined) {
    if (typeof body.firstName !== "string") return { error: "invalid-first-name" };
    facts.first_name = body.firstName;
  }
  if (body.age !== undefined) {
    if (typeof body.age !== "number" || !Number.isFinite(body.age)) {
      return { error: "invalid-age" };
    }
    facts.age = body.age;
  }
  if (body.gender !== undefined) {
    if (typeof body.gender !== "string") return { error: "invalid-gender" };
    facts.gender = body.gender;
  }
  if (body.preference !== undefined) {
    if (typeof body.preference !== "string") return { error: "invalid-preference" };
    facts.preference = body.preference;
  }
  if (body.height !== undefined) {
    if (typeof body.height !== "number" || !Number.isFinite(body.height)) {
      return { error: "invalid-height" };
    }
    facts.height = body.height;
  }
  // Multi-select, so the Mini App posts an ARRAY. Whitelisted downstream by
  // `validateFactValue`, which normalises it and rejects an empty result with
  // `invalid_relationship_intent` rather than writing an unanswered set
  // through — a screen that saves nothing must not read as answered.
  if (body.relationshipIntents !== undefined) {
    if (
      !Array.isArray(body.relationshipIntents) ||
      body.relationshipIntents.some((item) => typeof item !== "string")
    ) {
      return { error: "invalid-relationship-intent" };
    }
    facts.relationship_intent = body.relationshipIntents;
  }

  return { facts };
}
