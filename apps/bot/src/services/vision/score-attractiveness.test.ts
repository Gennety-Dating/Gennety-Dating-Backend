import { describe, it, expect, vi } from "vitest";

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test-bot-token",
    OPENAI_API_KEY: "test-openai-key",
  },
}));

import {
  scoreAttractivenessFromBuffer,
  scoreAttractivenessFromBuffers,
} from "./score-attractiveness.js";
import { MODELS } from "../../models.js";

const PHOTO = Buffer.from("photo-bytes");

function okResponse(payload: unknown) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
  } as unknown as Response;
}

function batchPayload(...photos: Array<Record<string, unknown>>) {
  return {
    photos: photos.map((photo, index) => ({
      index: index + 1,
      symmetry: 78,
      eye_distance: 64,
      face_shape: 72,
      feature_regularity: 70,
      overall: 71,
      rationale: "balanced features, good symmetry",
      ...photo,
    })),
  };
}

describe("scoreAttractivenessFromBuffer", () => {
  it("returns parsed score + breakdown when the model returns valid JSON", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse(batchPayload({})),
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
    expect(result.model).toBe(MODELS.vision);
    expect(result.rationale).toContain("balanced");
  });

  it("clamps overall score to [0, 100]", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse(batchPayload({
        overall: 250, // hallucinated out-of-range value
        rationale: "n/a",
      })),
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
      okResponse({ photos: [{ index: 1, symmetry: 50, overall: 50 }] }),
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
      okResponse(batchPayload({
        symmetry: 60,
        eye_distance: 60,
        face_shape: 60,
        feature_regularity: 60,
        overall: 60,
        rationale: "ok",
      })),
    );

    await scoreAttractivenessFromBuffer(PHOTO, "image/png", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe(MODELS.vision);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toMatch(/symmetry/i);
    expect(body.messages[0].content).toMatch(/SCUT-FBP5500/);
    // Gender-calibrated grading: stricter on female faces, generous on male.
    expect(body.messages[0].content).toMatch(/FEMALE faces: grade strictly/);
    expect(body.messages[0].content).toMatch(/MALE faces: grade generously/);
    const imageUrl = body.messages[1].content[1].image_url.url;
    expect(imageUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("scoreAttractivenessFromBuffers", () => {
  it("sends all photos in one request and returns ordered assessments", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse(
        batchPayload(
          { overall: 60, rationale: "photo one" },
          { overall: 80, rationale: "photo two" },
        ),
      ),
    );

    const result = await scoreAttractivenessFromBuffers(
      [
        { buffer: Buffer.from("photo-one"), mime: "image/jpeg" },
        { buffer: Buffer.from("photo-two"), mime: "image/png" },
      ],
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      assessments: [
        { score: 60, rationale: "photo one" },
        { score: 80, rationale: "photo two" },
      ],
    });

    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    const imageParts = body.messages[1].content.filter(
      (part: { type: string }) => part.type === "image_url",
    );
    expect(imageParts).toHaveLength(2);
    expect(imageParts[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(imageParts[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects missing, duplicate, or out-of-order photo assessments", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        photos: [
          { ...batchPayload({}).photos[0], index: 1 },
          { ...batchPayload({}).photos[0], index: 1 },
        ],
      }),
    );

    const result = await scoreAttractivenessFromBuffers(
      [
        { buffer: Buffer.from("one"), mime: "image/jpeg" },
        { buffer: Buffer.from("two"), mime: "image/jpeg" },
      ],
      { fetchFn: fetchFn as unknown as typeof fetch },
    );

    expect(result).toEqual({ ok: false, error: "api" });
  });
});
