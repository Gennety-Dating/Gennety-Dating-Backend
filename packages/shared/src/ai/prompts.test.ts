import { describe, it, expect } from "vitest";
import {
  MAGIC_CONTEXT_PROMPT,
  magicContextPrompt,
  parseLLMDumpPrompt,
  pitchAndSynergyPrompt,
  proposeSchedulingPrompt,
  venueSelectionPrompt,
  generateIceBreakersPrompt,
  generateWingmanHintPrompt,
  parseRejectionFeedbackPrompt,
  parsePostDateFeedbackPrompt,
  parseReportTriagePrompt,
} from "./prompts.js";

describe("magicContextPrompt", () => {
  it("instructs the LLM to output a single JSON object only", () => {
    const result = magicContextPrompt("en");
    expect(result).toContain("ONE JSON object");
    expect(result).toContain("no markdown fences");
    expect(result).toMatch(/start with `\{`/);
  });

  it("does NOT use character-count as a length constraint", () => {
    // LLMs can't count characters reliably — length is controlled via
    // per-field sentence/word caps instead.
    const result = magicContextPrompt("en");
    expect(result).not.toMatch(/4096/);
    expect(result).not.toMatch(/characters or fewer/i);
    expect(result).not.toMatch(/count the characters/i);
  });

  it("lists all ParsedProfileSummary schema fields", () => {
    const result = magicContextPrompt("en");
    for (const field of [
      "personality_traits",
      "communication_style",
      "interests",
      "values",
      "attachment_style",
      "social_energy",
      "humor_style",
      "ideal_partner",
      "dealbreakers",
      "summary",
    ]) {
      expect(result).toContain(`"${field}"`);
    }
  });

  it("enforces exact list sizes via structural rules", () => {
    const result = magicContextPrompt("en");
    expect(result).toMatch(/exactly 5/i); // personality_traits
    expect(result).toMatch(/3[–-]6/); // interests range
    expect(result).toMatch(/3[–-]5/); // values range
    expect(result).toMatch(/2[–-]4/); // dealbreakers range
  });

  it("enforces sentence/word caps on free-text fields", () => {
    const result = magicContextPrompt("en");
    expect(result).toMatch(/ONE sentence/i);
    expect(result).toMatch(/2[–-]3 sentences/);
    expect(result).toMatch(/3[–-]4 sentences/);
    expect(result).toMatch(/≤\s*\d+\s*words/);
  });

  it("pins enum fields to fixed value sets", () => {
    const result = magicContextPrompt("en");
    expect(result).toContain('"secure"');
    expect(result).toContain('"anxious"');
    expect(result).toContain('"avoidant"');
    expect(result).toContain('"disorganized"');
    expect(result).toContain('"introvert"');
    expect(result).toContain('"ambivert"');
    expect(result).toContain('"extrovert"');
  });

  it("writes free-text fields in the caller's language", () => {
    const ru = magicContextPrompt("ru");
    expect(ru).toContain("in ru");
    const uk = magicContextPrompt("uk");
    expect(uk).toContain("in uk");
  });

  it("keeps MAGIC_CONTEXT_PROMPT alias backward-compatible", () => {
    expect(MAGIC_CONTEXT_PROMPT).toBe(magicContextPrompt("en"));
  });
});

describe("parseLLMDumpPrompt", () => {
  it("injects firstName and language into the prompt", () => {
    const result = parseLLMDumpPrompt({ firstName: "Alice", language: "en" });
    expect(result).toContain("Alice");
    expect(result).toContain("Language preference: en");
  });

  it("includes JSON schema with required fields", () => {
    const result = parseLLMDumpPrompt({ firstName: "Bob", language: "ru" });
    expect(result).toContain('"personality_traits"');
    expect(result).toContain('"communication_style"');
    expect(result).toContain('"interests"');
    expect(result).toContain('"ideal_partner"');
    expect(result).toContain('"dealbreakers"');
    expect(result).toContain('"summary"');
    expect(result).toContain('"attachment_style"');
    expect(result).toContain('"values"');
  });

  it("instructs the model to write the summary in the user's language", () => {
    const result = parseLLMDumpPrompt({ firstName: "Oleg", language: "uk" });
    expect(result).toContain("summary: write in uk");
  });

  it("enforces JSON-only output", () => {
    const result = parseLLMDumpPrompt({ firstName: "Test", language: "en" });
    expect(result).toContain("single JSON object");
    expect(result).toContain("no markdown");
  });
});

describe("pitchAndSynergyPrompt", () => {
  const base = {
    selfFirstName: "Alice",
    otherFirstName: "Bob",
    selfSummary: "Loves jazz and philosophy",
    otherSummary: "Enjoys hiking and coffee",
    language: "en",
  };

  it("includes the JSON schema for all three output fields", () => {
    const result = pitchAndSynergyPrompt(base);
    expect(result).toContain('"pitch"');
    expect(result).toContain('"synergy_score"');
    expect(result).toContain('"synergy_reason"');
  });

  it("clamps the score range to 70..99 in-prompt", () => {
    const result = pitchAndSynergyPrompt(base);
    expect(result).toMatch(/integer between 70 and 99/);
    expect(result).toMatch(/Never go below 70/);
    expect(result).toMatch(/Never reach 100/);
  });

  it("defines both framing buckets (complementary vs aligned)", () => {
    const result = pitchAndSynergyPrompt(base);
    expect(result).toMatch(/70[–-]79/);
    expect(result).toMatch(/complementary/i);
    expect(result).toMatch(/90[–-]99/);
    expect(result).toMatch(/highly aligned/i);
  });

  it("forbids mentioning the number itself in the reason", () => {
    const result = pitchAndSynergyPrompt(base);
    expect(result).toMatch(/NOT mention the number/i);
  });

  it("requires JSON-only output (mentions JSON for OpenAI JSON mode)", () => {
    const result = pitchAndSynergyPrompt(base);
    expect(result).toContain("JSON");
    expect(result).toMatch(/no markdown/i);
    expect(result).toMatch(/Start with `\{`/);
  });

  it("injects both names and summaries", () => {
    const result = pitchAndSynergyPrompt(base);
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    expect(result).toContain("Loves jazz and philosophy");
    expect(result).toContain("Enjoys hiking and coffee");
  });

  it("injects the language across the schema fields", () => {
    const ru = pitchAndSynergyPrompt({ ...base, language: "ru" });
    expect(ru).toContain("Output language: ru");
    // Both pitch and reason are language-bound.
    expect(ru.match(/in ru/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("handles null names and summaries gracefully", () => {
    const result = pitchAndSynergyPrompt({
      selfFirstName: null,
      otherFirstName: null,
      selfSummary: null,
      otherSummary: null,
      language: "en",
    });
    expect(result).toContain("Reader: User");
    expect(result).toContain("Match: Someone");
    expect(result).toContain("(no bio)");
  });
});

describe("proposeSchedulingPrompt", () => {
  const base = {
    selfFirstName: "Alice",
    otherFirstName: "Bob",
    selfSummary: "Loves jazz and philosophy",
    otherSummary: "Enjoys hiking and coffee",
    language: "en",
    iteration: 1,
    proposedSlots: ["Friday, 7 Apr, 19:00", "Saturday, 8 Apr, 18:00"],
  };

  it("injects both user names", () => {
    const result = proposeSchedulingPrompt(base);
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
  });

  it("includes proposed time slots", () => {
    const result = proposeSchedulingPrompt(base);
    expect(result).toContain("Friday, 7 Apr, 19:00");
    expect(result).toContain("Saturday, 8 Apr, 18:00");
  });

  it("shows iteration number", () => {
    const result = proposeSchedulingPrompt(base);
    expect(result).toContain("iteration **1** of 2");
  });

  it("adds encouragement note for iteration 2", () => {
    const result = proposeSchedulingPrompt({ ...base, iteration: 2 });
    expect(result).toContain("encouraging");
  });

  it("handles null summaries gracefully", () => {
    const result = proposeSchedulingPrompt({
      ...base,
      selfSummary: null,
      otherSummary: null,
    });
    expect(result).toContain("(not available)");
  });
});

describe("venueSelectionPrompt", () => {
  const base = {
    selfFirstName: "Alice",
    otherFirstName: "Bob",
    selfSummary: "Loves jazz",
    otherSummary: "Enjoys hiking",
    venueName: "Coupa Café",
    venueAddress: "538 Ramona St, Palo Alto",
    agreedTime: "Friday, 7 April at 19:00",
    language: "en",
  };

  it("injects venue details", () => {
    const result = venueSelectionPrompt(base);
    expect(result).toContain("Coupa Café");
    expect(result).toContain("538 Ramona St, Palo Alto");
  });

  it("injects agreed time", () => {
    const result = venueSelectionPrompt(base);
    expect(result).toContain("Friday, 7 April at 19:00");
  });

  it("injects language requirement", () => {
    const result = venueSelectionPrompt({ ...base, language: "ru" });
    expect(result).toContain("**ru**");
  });
});

describe("generateIceBreakersPrompt", () => {
  const base = {
    userFirstName: "Alice",
    matchFirstName: "Bob",
    userSummary: "Introvert, loves reading and jazz",
    matchSummary: "Extrovert, into hiking and philosophy",
    language: "en",
  };

  it("injects both names and summaries", () => {
    const result = generateIceBreakersPrompt(base);
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    expect(result).toContain("Introvert, loves reading and jazz");
    expect(result).toContain("Extrovert, into hiking and philosophy");
  });

  it("requests exactly 3 starters", () => {
    const result = generateIceBreakersPrompt(base);
    expect(result).toContain("exactly 3");
  });

  it("includes anti-pattern rules", () => {
    const result = generateIceBreakersPrompt(base);
    expect(result).toContain("NEVER");
    expect(result).toContain("physical appearance");
  });

  it("handles null summaries", () => {
    const result = generateIceBreakersPrompt({
      ...base,
      userSummary: null,
      matchSummary: null,
    });
    expect(result).toContain("(no profile summary available)");
  });
});

describe("generateWingmanHintPrompt", () => {
  const base = {
    viewerFirstName: "Alice",
    targetFirstName: "Bob",
    viewerSummary: "Introvert, loves reading and jazz",
    targetSummary: "Lead of the university debate club, into philosophy",
    language: "en",
  };

  it("frames the writer as a mutual friend addressing the viewer about the target", () => {
    const result = generateWingmanHintPrompt(base);
    expect(result).toContain("mutual friend");
    expect(result).toContain("Alice");
    expect(result).toContain("Bob");
    // Target summary must be present so the model has the source material.
    expect(result).toContain("debate club");
  });

  it("requires a single imperative sentence, not a question", () => {
    const result = generateWingmanHintPrompt(base);
    expect(result).toContain("ONE");
    expect(result).toContain("imperative");
    expect(result).toMatch(/No question marks?/);
  });

  it("injects language", () => {
    const result = generateWingmanHintPrompt({ ...base, language: "ru" });
    expect(result).toContain("**ru**");
  });

  it("injects language for Ukrainian", () => {
    const result = generateWingmanHintPrompt({ ...base, language: "uk" });
    expect(result).toContain("**uk**");
  });

  it("handles null summaries without crashing", () => {
    const result = generateWingmanHintPrompt({
      ...base,
      viewerSummary: null,
      targetSummary: null,
    });
    expect(result).toContain("(no profile summary available)");
  });
});

describe("parseRejectionFeedbackPrompt", () => {
  it("includes JSON schema", () => {
    const result = parseRejectionFeedbackPrompt({ language: "en" });
    expect(result).toContain('"constraint_type"');
    expect(result).toContain('"constraint_summary"');
    expect(result).toContain('"confidence"');
    expect(result).toContain('"extracted_traits_to_avoid"');
  });

  it("injects language", () => {
    const result = parseRejectionFeedbackPrompt({ language: "ru" });
    expect(result).toContain("**ru**");
  });

  it("enforces JSON-only output", () => {
    const result = parseRejectionFeedbackPrompt({ language: "en" });
    expect(result).toContain("single JSON object");
    expect(result).toContain("no markdown");
  });

  it("handles vague feedback gracefully", () => {
    const result = parseRejectionFeedbackPrompt({ language: "en" });
    expect(result).toContain("not feeling it");
    expect(result).toContain('"low"');
  });
});

describe("parsePostDateFeedbackPrompt", () => {
  it("includes JSON schema with all required fields", () => {
    const result = parsePostDateFeedbackPrompt({ language: "en" });
    expect(result).toContain('"chemistry"');
    expect(result).toContain('"chemistry_signals"');
    expect(result).toContain('"outcome"');
    expect(result).toContain('"wants_second_date"');
    expect(result).toContain('"new_positive_preferences"');
    expect(result).toContain('"new_negative_constraints"');
    expect(result).toContain('"feedback_summary"');
    expect(result).toContain('"matching_adjustment"');
  });

  it("injects language", () => {
    const result = parsePostDateFeedbackPrompt({ language: "uk" });
    expect(result).toContain("**uk**");
  });

  it("enforces JSON-only output", () => {
    const result = parsePostDateFeedbackPrompt({ language: "en" });
    expect(result).toContain("single JSON object");
    expect(result).toContain("no markdown");
  });

  it("defines matching_adjustment values", () => {
    const result = parsePostDateFeedbackPrompt({ language: "en" });
    expect(result).toContain('"reinforce"');
    expect(result).toContain('"correct"');
    expect(result).toContain('"neutral"');
  });
});

describe("parseReportTriagePrompt", () => {
  it("includes all three tier definitions", () => {
    const result = parseReportTriagePrompt({ language: "en" });
    expect(result).toContain("Tier 1");
    expect(result).toContain("Tier 2");
    expect(result).toContain("Tier 3");
  });

  it("defines the strict JSON schema with exactly two keys", () => {
    const result = parseReportTriagePrompt({ language: "en" });
    expect(result).toContain('"tier"');
    expect(result).toContain('"reason_summary"');
  });

  it("injects language context", () => {
    const result = parseReportTriagePrompt({ language: "ru" });
    expect(result).toContain("**ru**");
  });

  it("mentions the literal word JSON (required for OpenAI JSON mode)", () => {
    const result = parseReportTriagePrompt({ language: "en" });
    expect(result).toContain("JSON");
  });

  it("instructs safety-first bias between Tier 2 and Tier 3", () => {
    const result = parseReportTriagePrompt({ language: "en" });
    expect(result.toLowerCase()).toContain("tier 3");
    expect(result.toLowerCase()).toContain("safety-first");
  });

  it("instructs conservative bias between Tier 1 and Tier 2", () => {
    const result = parseReportTriagePrompt({ language: "en" });
    expect(result.toLowerCase()).toContain("conservative");
  });

  it("lists canonical example keywords for each tier", () => {
    const result = parseReportTriagePrompt({ language: "en" });
    expect(result.toLowerCase()).toContain("ghost");
    expect(result.toLowerCase()).toContain("harassment");
    expect(result.toLowerCase()).toContain("boring");
  });
});
