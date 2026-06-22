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
