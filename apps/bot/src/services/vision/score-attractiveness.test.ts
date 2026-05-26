import { describe, it, expect, vi } from "vitest";

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test-bot-token",
    OPENAI_API_KEY: "test-openai-key",
  },
}));

import { scoreAttractivenessFromBuffer } from "./score-attractiveness.js";

const PHOTO = Buffer.from("photo-bytes");

function okResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
  } as unknown as Response;
}

describe("scoreAttractivenessFromBuffer", () => {
  it("returns parsed score + breakdown when the model returns valid JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        symmetry: 78,
        eye_distance: 64,
        face_shape: 72,
        feature_regularity: 70,
        overall: 71,
        rationale: "balanced features, good symmetry",
      }),
    );

    const result = await scoreAttractivenessFromBuffer(PHOTO, "image/jpeg", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.score).toBe(71);
    expect(result.breakdown).toEqual({
      symmetry: 78,
      eyeDistance: 64,
      faceShape: 72,
      featureRegularity: 70,
    });
    expect(result.model).toBe("gpt-5.4-nano");
    expect(result.rationale).toContain("balanced");
  });

  it("clamps overall score to [0, 100]", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        symmetry: 50,
        eye_distance: 50,
        face_shape: 50,
        feature_regularity: 50,
        overall: 250, // hallucinated out-of-range value
        rationale: "n/a",
      }),
    );

    const result = await scoreAttractivenessFromBuffer(PHOTO, "image/jpeg", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.score).toBe(100);
  });

  it("returns error=api when the model returns malformed JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not-json" } }] }),
    } as unknown as Response);

    const result = await scoreAttractivenessFromBuffer(PHOTO, "image/jpeg", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "api" });
  });

  it("returns error=api when required fields are missing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({ symmetry: 50, overall: 50 /* missing the rest */ }),
    );

    const result = await scoreAttractivenessFromBuffer(PHOTO, "image/jpeg", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "api" });
  });

  it("returns error=api when OpenAI returns non-200", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false } as Response);

    const result = await scoreAttractivenessFromBuffer(PHOTO, "image/jpeg", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "api" });
  });

  it("returns error=timeout when the fetch aborts", async () => {
    const fetchFn = vi.fn().mockImplementation(() => {
      const err = new Error("aborted") as Error & { name: string };
      err.name = "AbortError";
      return Promise.reject(err);
    });

    const result = await scoreAttractivenessFromBuffer(PHOTO, "image/jpeg", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "timeout" });
  });

  it("returns error=disabled when OPENAI_API_KEY is empty (no fail-open)", async () => {
    // Unlike validate-face, scoring is silent and not user-visible: failing
    // open would silently corrupt the Elo seed (everyone starts at the
    // default). Caller should treat `disabled` as "skip seeding entirely".
    const fetchFn = vi.fn();

    const result = await scoreAttractivenessFromBuffer(PHOTO, "image/jpeg", {
      openaiApiKey: "",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, error: "disabled" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends the image as a base64 data URL with the SCUT-style prompt", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        symmetry: 60,
        eye_distance: 60,
        face_shape: 60,
        feature_regularity: 60,
        overall: 60,
        rationale: "ok",
      }),
    );

    await scoreAttractivenessFromBuffer(PHOTO, "image/png", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe("gpt-5.4-nano");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toMatch(/symmetry/i);
    expect(body.messages[0].content).toMatch(/SCUT-FBP5500/);
    const imageUrl = body.messages[1].content[0].image_url.url;
    expect(imageUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});
