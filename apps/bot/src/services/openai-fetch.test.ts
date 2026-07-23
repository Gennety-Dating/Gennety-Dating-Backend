import { describe, it, expect, vi, afterEach } from "vitest";
import { openaiFetch } from "./openai-fetch.js";
import { runWithUsage } from "./usage-context.js";
import { usageLimiter } from "./usage-limiter.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("openaiFetch token metering", () => {
  it("adds a default timeout when the caller does not provide a signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await openaiFetch("https://api.openai.com/v1/chat/completions");

    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves an explicit caller signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await openaiFetch("https://api.openai.com/v1/chat/completions", {
      signal: controller.signal,
    });

    expect(fetchMock.mock.calls[0]![1]?.signal).toBe(controller.signal);
  });

  it("attributes usage.total_tokens to the ambient key and returns an intact response", async () => {
    const body = {
      choices: [{ message: { content: "hi" } }],
      usage: { prompt_tokens: 812, completion_tokens: 143, total_tokens: 955 },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const record = vi.spyOn(usageLimiter, "recordTokens").mockImplementation(() => {});

    const parsed = await runWithUsage("tg:42", async () => {
      const res = await openaiFetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
      });
      // The caller's own body read must still work — the wrapper reads a clone.
      return res.json();
    });

    expect(parsed).toEqual(body);
    await flush();
    expect(record).toHaveBeenCalledWith("tg:42", 955);
  });

  it("falls back to prompt+completion when total_tokens is absent", async () => {
    const body = { usage: { prompt_tokens: 10, completion_tokens: 5 } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const record = vi.spyOn(usageLimiter, "recordTokens").mockImplementation(() => {});

    await runWithUsage("tg:1", () => openaiFetch("https://api.openai.com/v1/embeddings"));
    await flush();

    expect(record).toHaveBeenCalledWith("tg:1", 15);
  });

  it("does not record when there is no usage field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ choices: [] })));
    const record = vi.spyOn(usageLimiter, "recordTokens").mockImplementation(() => {});

    await runWithUsage("tg:1", () => openaiFetch("https://api.openai.com/v1/chat/completions"));
    await flush();

    expect(record).not.toHaveBeenCalled();
  });

  it("skips non-JSON (e.g. streaming) responses without consuming them", async () => {
    const stream = new Response("data: chunk\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream));
    const record = vi.spyOn(usageLimiter, "recordTokens").mockImplementation(() => {});

    const res = await runWithUsage("tg:1", () =>
      openaiFetch("https://api.openai.com/v1/chat/completions"),
    );
    await flush();

    expect(record).not.toHaveBeenCalled();
    expect(await res.text()).toContain("chunk"); // body still readable
  });

  it("records against no key (worker) when outside any usage context", async () => {
    const body = { usage: { total_tokens: 40 } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(body)));
    const record = vi.spyOn(usageLimiter, "recordTokens").mockImplementation(() => {});

    await openaiFetch("https://api.openai.com/v1/chat/completions");
    await flush();

    expect(record).toHaveBeenCalledWith(undefined, 40);
  });
});

describe("openaiFetch temperature normalization (GPT-5.6 only supports default=1)", () => {
  function forwardedBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
    const raw = fetchMock.mock.calls[0]![1]?.body;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  it("strips a non-default temperature from the chat body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await openaiFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-terra", messages: [], temperature: 0.3 }),
    });

    const body = forwardedBody(fetchMock) as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.messages).toEqual([]);
  });

  it("keeps other sampling params intact while stripping temperature", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await openaiFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        temperature: 0,
        max_completion_tokens: 800,
        response_format: { type: "json_schema" },
      }),
    });

    const body = forwardedBody(fetchMock) as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
    expect(body.max_completion_tokens).toBe(800);
    expect(body.response_format).toEqual({ type: "json_schema" });
  });

  it("preserves an explicit temperature of 1", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await openaiFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ temperature: 1 }),
    });

    expect((forwardedBody(fetchMock) as Record<string, unknown>).temperature).toBe(1);
  });

  it("leaves a body without a temperature untouched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await openaiFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "x" }),
    });

    const body = forwardedBody(fetchMock) as Record<string, unknown>;
    expect(body).toEqual({ model: "gpt-5.6-luna", input: "x" });
  });

  it("leaves a non-JSON string body untouched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await openaiFetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      body: "not-json",
    });

    expect(fetchMock.mock.calls[0]![1]?.body).toBe("not-json");
  });
});
