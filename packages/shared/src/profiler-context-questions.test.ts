import { describe, it, expect } from "vitest";
import {
  PROFILER_CONTEXT_FAMILIES,
  contextualProfilerQuestion,
  contextualProfilerQuestionById,
  contextualProfilerQuestionId,
  parseContextualProfilerQuestionId,
  profilerFollowupSourceIds,
  profilerRecheckSourceIds,
} from "./profiler-context-questions.js";
import {
  formatProfilerAnswersBlock,
  profilerQuestionBank,
  profilerQuestionById,
  scoreProfilerAnswers,
  type ProfilerQuestion,
} from "./profiler-questions.js";
import { VENUE_EXPERIENCES } from "./venue-intent.js";

const LANGS = ["en", "ru", "uk", "de", "pl"] as const;
const MATCH_ID = "3f2b8c4e-9a1d-4e5f-8b7c-6d5e4f3a2b1c";

/** Every contextual instance a user could ever be shown. */
function allInstances(): ProfilerQuestion[] {
  const out: ProfilerQuestion[] = [];
  for (const gender of ["female", "male"] as const) {
    for (const family of ["topic", "format"] as const) {
      out.push(contextualProfilerQuestion(gender, family, MATCH_ID)!);
    }
    for (const experience of VENUE_EXPERIENCES) {
      const q = contextualProfilerQuestion(gender, "signature", experience);
      if (q) out.push(q);
    }
    for (const id of profilerFollowupSourceIds(gender)) {
      out.push(contextualProfilerQuestion(gender, "followup", id)!);
    }
    for (const id of profilerRecheckSourceIds(gender)) {
      out.push(contextualProfilerQuestion(gender, "recheck", id)!);
    }
  }
  return out;
}

describe("contextual question ids", () => {
  it("round-trip through the id and resolve via profilerQuestionById", () => {
    const id = contextualProfilerQuestionId("female", "topic", MATCH_ID);
    expect(id).toBe(`f_ctx:topic:${MATCH_ID}`);
    expect(parseContextualProfilerQuestionId(id)).toEqual({
      gender: "female",
      ref: { family: "topic", key: MATCH_ID },
    });
    const q = profilerQuestionById(id);
    expect(q?.context).toEqual({ family: "topic", key: MATCH_ID });
    expect(q?.gender).toBe("female");
  });

  it("never collide with bank ids", () => {
    for (const q of [...profilerQuestionBank("female"), ...profilerQuestionBank("male")]) {
      expect(parseContextualProfilerQuestionId(q.id), q.id).toBeNull();
    }
  });

  it("reject instances that do not exist", () => {
    // Another gender's source, a source with no follow-up, a request rather than a place.
    expect(contextualProfilerQuestionById("f_ctx:followup:m_learning")).toBeUndefined();
    expect(contextualProfilerQuestionById("m_ctx:followup:m_pets")).toBeUndefined();
    expect(contextualProfilerQuestionById("f_ctx:signature:surprise_me")).toBeUndefined();
    expect(contextualProfilerQuestionById("f_ctx:season:winter")).toBeUndefined();
    expect(contextualProfilerQuestionById("f_ctx:topic:")).toBeUndefined();
  });

  it("fit the Telegram Skip button's 64-byte callback_data", () => {
    for (const q of allInstances()) {
      const callback = `profiler:skip:${q.id}`;
      expect(Buffer.byteLength(callback, "utf8"), q.id).toBeLessThanOrEqual(64);
    }
  });

  it("cover exactly the five approved families — season is deferred", () => {
    expect([...PROFILER_CONTEXT_FAMILIES]).toEqual([
      "topic",
      "format",
      "signature",
      "followup",
      "recheck",
    ]);
  });
});

describe("contextual question wording", () => {
  it("every instance has every language and closed options in every language", () => {
    for (const q of allInstances()) {
      for (const lang of LANGS) {
        expect(q.text[lang], `${q.id}/${lang}`).toBeTruthy();
        expect(q.text[lang], `${q.id}/${lang}`).not.toContain("{label}");
      }
      expect(q.options?.length, q.id).toBeGreaterThanOrEqual(2);
      const optionIds = q.options!.map((o) => o.id);
      expect(new Set(optionIds).size, q.id).toBe(optionIds.length);
      for (const option of q.options!) {
        for (const lang of LANGS) {
          expect(option.text[lang], `${q.id}/${option.id}/${lang}`).toBeTruthy();
        }
      }
    }
  });

  it("never reads as surveillance", () => {
    // The card shows what the question is about; the words never say how we
    // know, and never touch the fenced sources.
    const forbidden =
      /noticed|we saw|tracked|location|spotify|music|health|step|заметил|видим|отслеж|геолок|музык|здоров|шаг|помітил|бачимо|bemerkt|standort|zauważ|lokaliz/i;
    for (const q of allInstances()) {
      for (const lang of LANGS) {
        expect(q.text[lang], `${q.id}/${lang}`).not.toMatch(forbidden);
      }
    }
  });

  it("follow-ups and rechecks exist only for questions in the person's own bank", () => {
    for (const gender of ["female", "male"] as const) {
      const bank = new Set(profilerQuestionBank(gender).map((q) => q.id));
      for (const id of [...profilerFollowupSourceIds(gender), ...profilerRecheckSourceIds(gender)]) {
        expect(bank.has(id), `${gender}: ${id}`).toBe(true);
      }
    }
  });

  it("the sport preference has a recheck (founder: it stays and matters)", () => {
    expect(profilerRecheckSourceIds("female")).toContain("f_sport_pref");
  });
});

describe("contextual answers in the icebreaker prompts", () => {
  it("a fresh topic feeds only the date it was given for", () => {
    const rows = [
      { questionId: `m_ctx:topic:${MATCH_ID}`, answerText: "building a synth" },
      { questionId: "m_passions", answerText: "chess" },
    ];
    expect(scoreProfilerAnswers(rows, { matchId: MATCH_ID }).map((s) => s.answer)).toEqual([
      "building a synth",
      "chess",
    ]);
    expect(scoreProfilerAnswers(rows, { matchId: "other-match" }).map((s) => s.answer)).toEqual([
      "chess",
    ]);
    expect(scoreProfilerAnswers(rows).map((s) => s.answer)).toEqual(["chess"]);
  });

  it("a follow-up line names the question it follows up", () => {
    const block = formatProfilerAnswersBlock(
      scoreProfilerAnswers([{ questionId: "f_ctx:followup:f_learning", answerText: "Started!" }]),
      "en",
    );
    expect(block).toContain("follow-up to: Is there something you'd love to learn");
    expect(block).toContain("→ Started!");
  });
});
