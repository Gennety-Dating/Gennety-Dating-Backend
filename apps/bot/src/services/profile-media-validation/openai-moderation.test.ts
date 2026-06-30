import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  env: {
    OPENAI_API_KEY: "sk-test",
  },
}));

import {
  moderateImageWithOpenAI,
  moderateTextWithOpenAI,
} from "./openai-moderation.js";

function response(result: unknown): Response {
  return new Response(JSON.stringify({ results: [result] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAI moderation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends an image as a base64 data URL and does NOT block the coarse `sexual` category", async () => {
    // Revealing-but-legal dating photos (swimwear, lingerie, bare torso) get
    // flagged `sexual` by omni-moderation. For images that must NOT hard-block:
    // the explicit-nudity line is drawn by AWS Rekognition, not this boolean.
    const fetchFn = vi.fn().mockResolvedValue(
      response({
        flagged: true,
        categories: { sexual: true, violence: false },
        category_scores: { sexual: 0.94, violence: 0.01 },
      }),
    );

    const result = await moderateImageWithOpenAI(
      Buffer.from("image-bytes"),
      "image/jpeg",
      { fetchFn },
    );

    expect(result).toEqual({ ok: true, signals: [] });
    const body = JSON.parse(fetchFn.mock.calls[0]![1].body as string);
    expect(body.model).toBe("omni-moderation-latest");
    expect(body.input[0].image_url.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });

  it("still hard-blocks `sexual/minors` on an image (CSAM)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      response({
        flagged: true,
        categories: { "sexual/minors": true, sexual: true },
        category_scores: { "sexual/minors": 0.97, sexual: 0.9 },
      }),
    );

    expect(
      await moderateImageWithOpenAI(Buffer.from("x"), "image/jpeg", {
        fetchFn,
      }),
    ).toEqual({
      ok: true,
      signals: [
        {
          provider: "openai",
          category: "sexual/minors",
          score: 0.97,
          severity: "block",
        },
      ],
    });
  });

  it("returns review for non-graphic violence", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      response({
        flagged: true,
        categories: { violence: true, "violence/graphic": false },
        category_scores: { violence: 0.82, "violence/graphic": 0.1 },
      }),
    );

    expect(
      await moderateImageWithOpenAI(Buffer.from("x"), "image/jpeg", {
        fetchFn,
      }),
    ).toEqual({
      ok: true,
      signals: [
        {
          provider: "openai",
          category: "violence",
          score: 0.82,
          severity: "review",
        },
      ],
    });
  });

  it("moderates transcript text with text-only categories", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      response({
        flagged: true,
        categories: { "sexual/minors": true },
        category_scores: { "sexual/minors": 0.99 },
      }),
    );

    expect(
      await moderateTextWithOpenAI("unsafe transcript", { fetchFn }),
    ).toEqual({
      ok: true,
      signals: [
        {
          provider: "openai",
          category: "sexual/minors",
          score: 0.99,
          severity: "block",
        },
      ],
    });
  });

  it("ignores a flagged result whose categories we do not gate on", async () => {
    // We deliberately do NOT escalate a bare `flagged: true` with only
    // unmapped categories into a review signal — that catch-all was a real
    // false-positive source on ordinary media. Only explicitly mapped
    // block/review categories produce a signal.
    const fetchFn = vi.fn().mockResolvedValue(
      response({
        flagged: true,
        categories: { new_category: true },
        category_scores: { new_category: 0.8 },
      }),
    );

    expect(
      await moderateTextWithOpenAI("text", { fetchFn }),
    ).toEqual({
      ok: true,
      signals: [],
    });
  });

  it("returns not_configured instead of failing open", async () => {
    expect(
      await moderateTextWithOpenAI("text", { apiKey: "", fetchFn: vi.fn() }),
    ).toEqual({ ok: false, error: "not_configured" });
  });

  it("returns invalid_response for malformed API output", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    expect(
      await moderateTextWithOpenAI("text", { fetchFn }),
    ).toEqual({ ok: false, error: "invalid_response" });
  });
});
