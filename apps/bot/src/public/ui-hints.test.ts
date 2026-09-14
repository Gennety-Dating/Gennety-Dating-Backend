import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIN_AGE, MAX_AGE, MIN_PHOTOS, MAX_PHOTOS } from "@gennety/shared";
import { ONBOARDING_QUESTIONS } from "../services/onboarding-collector.js";
import { uiHintForQuestion } from "./ui-hints.js";
import { buildInterviewState } from "./routes/onboarding-state.js";

describe("uiHintForQuestion", () => {
  it("maps every canonical question except `complete` to a hint", () => {
    for (const question of ONBOARDING_QUESTIONS) {
      const hint = uiHintForQuestion(question);
      if (question === "complete") {
        expect(hint).toBeNull();
      } else {
        expect(hint, `hint for ${question}`).not.toBeNull();
      }
    }
  });

  it("carries validated bounds and canonical enum values", () => {
    expect(uiHintForQuestion("first_name_age")).toEqual({
      control: "name_age",
      min: MIN_AGE,
      max: MAX_AGE,
    });
    expect(uiHintForQuestion("gender")).toEqual({
      control: "choice_chips",
      options: ["male", "female"],
    });
    expect(uiHintForQuestion("preference")).toEqual({
      control: "choice_chips",
      options: ["men", "women", "both"],
    });
    expect(uiHintForQuestion("height")).toEqual({
      control: "height_wheel",
      min: 140,
      max: 220,
    });
    expect(uiHintForQuestion("context_dump")).toEqual({ control: "magic_prompt" });
    expect(uiHintForQuestion("photos")).toEqual({
      control: "photo_upload",
      min: MIN_PHOTOS,
      max: MAX_PHOTOS,
    });
    expect(MAX_PHOTOS).toBe(10);
  });

  it("resolves null for unknown keys and empty input (client falls back to text)", () => {
    expect(uiHintForQuestion(null)).toBeNull();
    expect(uiHintForQuestion(undefined)).toBeNull();
    expect(uiHintForQuestion("complete")).toBeNull();
    expect(uiHintForQuestion("brand_new_future_question")).toBeNull();
  });
});

describe("buildInterviewState uiHint wiring", () => {
  it("derives the hint from currentQuestion during the conversational step", () => {
    const state = buildInterviewState({
      step: "conversational",
      history: [],
      photoCount: 0,
      currentQuestion: "height",
    });
    expect(state.uiHint).toEqual({ control: "height_wheel", min: 140, max: 220 });
  });

  it("prefers the photo hint whenever the photo gate is active", () => {
    const state = buildInterviewState({
      step: "conversational",
      history: [{ role: "assistant", content: "…", tool_calls: [{ function: { name: "request_photos" } }] }],
      photoCount: 1,
      currentQuestion: "hobbies",
    });
    expect(state.expectingPhoto).toBe(true);
    expect(state.uiHint).toMatchObject({ control: "photo_upload" });
  });

  it("returns null outside the conversational step and for legacy users", () => {
    expect(
      buildInterviewState({ step: "consent", history: [], photoCount: 0 }).uiHint,
    ).toBeNull();
    expect(
      buildInterviewState({
        step: "conversational",
        history: [],
        photoCount: 0,
        currentQuestion: null,
      }).uiHint,
    ).toBeNull();
    expect(
      buildInterviewState({ step: "completed", history: [], photoCount: 4 }).uiHint,
    ).toBeNull();
  });
});

describe("the OpenAPI contract", () => {
  // The Swift client decodes `UiHint.control` into a FROZEN enum: a value the
  // spec does not list does not fall back to a text field, it fails to decode
  // the whole interview state. `voice_record` shipped in this file on
  // 2026-08-21 and was missing from the spec until 2026-09-14, so the first
  // iOS account to reach the voice step with the flag on would have lost the
  // interview screen.
  it("declares every control the server can send", () => {
    const spec = readFileSync(new URL("../../../../openapi/gennety-v1.yaml", import.meta.url), "utf8");
    const block = spec.slice(spec.indexOf("\n    UiHint:"));
    const listed = /control:\s*\n\s*type: string\s*\n\s*enum:\s*\[([^\]]+)\]/.exec(block);
    expect(listed, "UiHint.control enum in openapi/gennety-v1.yaml").not.toBeNull();
    const declared = new Set(listed![1]!.split(",").map((value) => value.trim()));

    for (const question of ONBOARDING_QUESTIONS) {
      const control = uiHintForQuestion(question)?.control;
      if (control) expect(declared, `control ${control} (${question})`).toContain(control);
    }
  });
});
