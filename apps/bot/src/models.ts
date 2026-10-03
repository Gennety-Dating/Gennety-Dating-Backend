/** Central model roles. Keep this module independent of config/dotenv for tests. */
export const MODELS = {
  // Quality-sensitive initial Elo and interpretation of profile answers.
  vision: process.env.OPENAI_MODEL_VISION || "gpt-6.1-sol",
  profile: process.env.OPENAI_MODEL_PROFILE || "gpt-6.1-sol",
  // Conversation, extraction, copy, classification and routine vision.
  visionFast: process.env.OPENAI_MODEL_VISION_FAST || "gpt-6-luna",
  agent: process.env.OPENAI_MODEL_AGENT || "gpt-6-luna",
  fast: process.env.OPENAI_MODEL_FAST || "gpt-6-luna",
  transcription: process.env.OPENAI_MODEL_TRANSCRIPTION || "gpt-transcribe",
  // These contracts cannot be switched by an environment override: existing
  // vectors must share one embedding space; duration needs verbose_json.
  transcriptionDuration: "whisper-1",
  embedding: "text-embedding-3-small",
  moderation: "omni-moderation-latest",
} as const;

/** Apply only documented capabilities; unknown overrides pass through intact. */
export function normalizeChatCompletion(body: Record<string, unknown>): Record<string, unknown> {
  const model = typeof body.model === "string" ? body.model : "";
  const matches = (name: string) => model === name || model.startsWith(`${name}-`);
  const luna = matches("gpt-6-luna") || matches("gpt-6-sol");
  const sol = matches("gpt-6.1-sol") || matches("gpt-6-astra");
  const legacy = matches("gpt-5.6-terra") || matches("gpt-5.6-luna");
  if (!luna && !sol && !legacy) return body;

  const result = { ...body };
  const hasTools = Array.isArray(result.tools) && result.tools.length > 0;
  if (sol && hasTools) {
    throw new Error(`${model} tool calling requires Responses API; configure GPT-6 Luna for chat agents`);
  }
  if (sol) {
    // Sol has no 'none' effort. Reserve a separate reasoning budget at callers.
    if (result.reasoning_effort === undefined || result.reasoning_effort === "none") {
      result.reasoning_effort = "low";
    }
  } else if (luna) {
    // Routine requests use the entire completion allowance for visible output.
    result.reasoning_effort ??= "none";
    if (hasTools && result.reasoning_effort !== "none") {
      throw new Error(`${model} Chat Completions tools require reasoning_effort:none`);
    }
  } else if (result.reasoning_effort === undefined) {
    const budget = result.max_completion_tokens;
    if (hasTools || (typeof budget === "number" && budget > 0 && budget <= 512)) {
      result.reasoning_effort = "none";
    }
  }

  if (legacy || result.reasoning_effort !== "none") {
    delete result.temperature;
    delete result.top_p;
    delete result.top_logprobs;
    delete result.logprobs;
  }
  return result;
}
