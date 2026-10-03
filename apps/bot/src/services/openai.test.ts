import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "sk-test" } }));
import { callOpenAIJson, callOpenAIText } from "./openai.js";

function completion(content: string | null, finish_reason = "stop") {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }), {
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("OpenAI wrapper request and response contracts", () => {
  it("preserves a strict schema and parses Luna JSON with injected transport", async () => {
    const fetchFn = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      completion('{"accepted":true}'));
    const schema = { type: "object", properties: { accepted: { type: "boolean" } },
      required: ["accepted"], additionalProperties: false };
    expect(await callOpenAIJson("Return JSON", "yes", {
      fetchFn, model: "gpt-6-luna", maxTokens: 40, jsonSchema: { name: "decision", schema },
    })).toEqual({ accepted: true });
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(body.reasoning_effort).toBe("none");
    expect(body.max_completion_tokens).toBe(40);
    expect(body.response_format).toEqual({ type: "json_schema",
      json_schema: { name: "decision", strict: true, schema } });
  });

  it("uses low reasoning without sampling params for profile interpretation", async () => {
    const fetchFn = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => completion('{}'));
    await callOpenAIJson("Return JSON", "profile", { model: "gpt-6.1-sol", maxTokens: 4096, fetchFn });
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string);
    expect(body.reasoning_effort).toBe("low");
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_completion_tokens).toBe(4096);
  });

  it("returns existing fallback values for malformed, refused and exhausted responses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const content of ["invalid JSON", null, ""]) {
      expect(await callOpenAIJson("Return JSON", "input", {
        fetchFn: vi.fn(async () => completion(content, "length")),
      })).toBeNull();
    }
    expect(await callOpenAIText("Reply", "input", {
      fetchFn: vi.fn(async () => completion(null)),
    })).toBe("");
    expect(await callOpenAIText("Reply", "input", {
      fetchFn: vi.fn(async () => new Response("error", { status: 429 })),
    })).toBe("");
    expect(await callOpenAIText("Reply", "input", {
      fetchFn: vi.fn(async () => completion("  hello  ")),
    })).toBe("hello");
  });
});
