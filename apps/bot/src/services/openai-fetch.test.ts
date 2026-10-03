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

function forwardedBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
  const raw = fetchMock.mock.calls[0]![1]?.body;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

describe("openaiFetch model capabilities", () => {
  async function send(body: Record<string, unknown>, endpoint = "chat/completions") {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await openaiFetch(`https://api.openai.com/v1/${endpoint}`, {
      method: "POST", body: JSON.stringify(body),
    });
    return forwardedBody(fetchMock) as Record<string, unknown>;
  }

  it("gives Luna tools and tiny classifiers a visible-output budget", async () => {
    for (const extra of [
      { max_completion_tokens: 16 },
      { max_completion_tokens: 1024 },
      { tools: [{ type: "function", function: { name: "get_my_profile" } }], tool_choice: "auto" },
    ]) {
      const body = await send({ model: "gpt-6-luna", temperature: 0.3, ...extra });
      expect(body).toEqual({ model: "gpt-6-luna", temperature: 0.3, ...extra, reasoning_effort: "none" });
    }
  });

  it("uses low reasoning for Sol and removes incompatible sampling fields", async () => {
    const body = await send({
      model: "gpt-6.1-sol", reasoning_effort: "none", temperature: 0,
      top_p: 0.9, top_logprobs: 2, logprobs: true, max_completion_tokens: 4096,
      response_format: { type: "json_object" }, messages: [],
    });
    expect(body).toEqual({
      model: "gpt-6.1-sol", reasoning_effort: "low", max_completion_tokens: 4096,
      response_format: { type: "json_object" }, messages: [],
    });
  });

  it("preserves supported explicit reasoning and strips sampling for Luna low", async () => {
    expect(await send({ model: "gpt-6-luna", reasoning_effort: "low", temperature: 1 }))
      .toEqual({ model: "gpt-6-luna", reasoning_effort: "low" });
  });

  it("rejects incompatible agent overrides before making an HTTP request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const params of [
      { model: "gpt-6.1-sol" },
      { model: "gpt-6-luna", reasoning_effort: "low" },
    ]) {
      await expect(openaiFetch("https://api.openai.com/v1/chat/completions", {
        body: JSON.stringify({ ...params, tools: [{ type: "function" }] }),
      })).rejects.toThrow(/tools|tool calling/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves unknown models and non-chat endpoints intact", async () => {
    const body = { model: "gpt-4.1-mini", temperature: 0, max_completion_tokens: 16 };
    expect(await send(body)).toEqual(body);
    const other = { model: "gpt-6-luna", temperature: 0 };
    for (const endpoint of ["embeddings", "moderations", "responses"]) {
      expect(await send(other, endpoint)).toEqual(other);
    }
  });

  it("retains legacy override compatibility without changing generous budgets", async () => {
    expect(await send({ model: "gpt-5.6-terra", temperature: 0, max_completion_tokens: 16 }))
      .toEqual({ model: "gpt-5.6-terra", max_completion_tokens: 16, reasoning_effort: "none" });
    expect(await send({ model: "gpt-5.6-terra", temperature: 0, max_completion_tokens: 1000 }))
      .toEqual({ model: "gpt-5.6-terra", max_completion_tokens: 1000 });
  });

  it("leaves malformed JSON and multipart data intact", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    for (const body of ["not-json", "null", "[]", new FormData()]) {
      await openaiFetch("https://api.openai.com/v1/chat/completions", { body });
      expect(fetchMock.mock.lastCall?.[1]?.body).toBe(body);
    }
  });
});
