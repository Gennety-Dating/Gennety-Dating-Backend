import { describe, it, expect, vi } from "vitest";

// Avoid loading real config (which requires BOT_TOKEN).
vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test-bot-token",
    DATABASE_URL: "test",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    OPENAI_API_KEY: "test-openai-key",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

import { validateSingleFace } from "./validate-face.js";

// Minimal ctx shim — the validator only touches `ctx.api.getFile` when no
// getFile override is provided, and we always provide one in these tests.
const ctx = {} as any;

function okResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

describe("validateSingleFace", () => {
  it("returns valid=true when model answers 'true'", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/file_1.jpg" });
    const fetchFn = vi.fn().mockResolvedValue(okResponse("true"));

    const result = await validateSingleFace(ctx, "file-id-1", {
      getFile,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, valid: true });
    expect(getFile).toHaveBeenCalledWith("file-id-1");
    // Body should reference the resolved Telegram file URL.
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe("gpt-5.4-nano");
    expect(body.messages[1].content[0].image_url.url).toBe(
      "https://api.telegram.org/file/bottest-bot-token/photos/file_1.jpg",
    );
  });

  it("returns valid=false when model answers 'false'", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "photos/file_2.jpg" });
    const fetchFn = vi.fn().mockResolvedValue(okResponse("false"));

    const result = await validateSingleFace(ctx, "file-id-2", {
      getFile,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, valid: false });
  });

  it("is case-insensitive and tolerates trailing punctuation", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "p.jpg" });
    const fetchFn = vi.fn().mockResolvedValue(okResponse("True."));

    const result = await validateSingleFace(ctx, "id", {
      getFile,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, valid: true });
  });

  it("returns error=api when OpenAI returns non-200", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "p.jpg" });
    const fetchFn = vi.fn().mockResolvedValue({ ok: false } as Response);

    const result = await validateSingleFace(ctx, "id", {
      getFile,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "api" });
  });

  it("returns error=api when model reply is ambiguous", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "p.jpg" });
    const fetchFn = vi.fn().mockResolvedValue(okResponse("maybe?"));

    const result = await validateSingleFace(ctx, "id", {
      getFile,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "api" });
  });

  it("returns error=api when Telegram getFile has no file_path", async () => {
    const getFile = vi.fn().mockResolvedValue({});
    const fetchFn = vi.fn();

    const result = await validateSingleFace(ctx, "id", {
      getFile,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "api" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns error=api when Telegram getFile throws", async () => {
    const getFile = vi.fn().mockRejectedValue(new Error("boom"));
    const fetchFn = vi.fn();

    const result = await validateSingleFace(ctx, "id", {
      getFile,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "api" });
  });

  it("returns error=timeout when fetch aborts", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "p.jpg" });
    const fetchFn = vi.fn().mockImplementation(() => {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const result = await validateSingleFace(ctx, "id", {
      getFile,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "timeout" });
  });

  it("fails open (valid=true) when OPENAI_API_KEY is not configured", async () => {
    const getFile = vi.fn();
    const fetchFn = vi.fn();

    const result = await validateSingleFace(ctx, "id", {
      openaiApiKey: "",
      getFile,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, valid: true });
    expect(getFile).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
