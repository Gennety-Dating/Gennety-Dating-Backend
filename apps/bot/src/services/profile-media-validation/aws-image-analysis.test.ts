import {
  DetectFacesCommand,
  DetectModerationLabelsCommand,
} from "@aws-sdk/client-rekognition";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  env: {
    FACE_MATCH_PROVIDER: "disabled",
    FACE_MATCH_THRESHOLD_VERIFY: 0.85,
    AWS_REGION: "eu-central-1",
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
  },
}));

import {
  detectFaces,
  detectModerationLabels,
} from "../face-match.js";

describe("AWS profile-media image analysis", () => {
  it("returns normalized face geometry and quality", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        FaceDetails: [
          {
            Confidence: 99,
            BoundingBox: {
              Left: 0.1,
              Top: 0.2,
              Width: 0.3,
              Height: 0.4,
            },
            Quality: { Brightness: 80, Sharpness: 70 },
            Pose: { Pitch: 1, Roll: 2, Yaw: 3 },
          },
        ],
      }),
    };

    const result = await detectFaces(Buffer.from("image"), {
      provider: "rekognition",
      client: client as never,
    });

    expect(client.send.mock.calls[0]![0]).toBeInstanceOf(DetectFacesCommand);
    expect(result).toEqual({
      ok: true,
      faces: [
        {
          confidence: 0.99,
          boundingBox: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
          },
          brightness: 0.8,
          sharpness: 0.7,
          pitch: 1,
          roll: 2,
          yaw: 3,
          sunglasses: null,
          occluded: null,
        },
      ],
    });
  });

  it("maps the Sunglasses and FaceOccluded attributes", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        FaceDetails: [
          {
            Confidence: 99,
            BoundingBox: { Left: 0.1, Top: 0.2, Width: 0.3, Height: 0.4 },
            Sunglasses: { Value: true, Confidence: 99 },
            FaceOccluded: { Value: true, Confidence: 100 },
          },
        ],
      }),
    };

    const result = await detectFaces(Buffer.from("image"), {
      provider: "rekognition",
      client: client as never,
    });

    expect(result).toMatchObject({
      ok: true,
      faces: [
        {
          sunglasses: { value: true, confidence: 0.99 },
          occluded: { value: true, confidence: 1 },
        },
      ],
    });
  });

  it("maps explicit AWS labels to block and suggestive labels to review", async () => {
    const client = {
      send: vi.fn().mockResolvedValue({
        ModerationLabels: [
          {
            Name: "Graphic Female Nudity",
            ParentName: "Explicit Nudity",
            Confidence: 97,
          },
          {
            Name: "Female Swimwear Or Underwear",
            ParentName: "Suggestive",
            Confidence: 88,
          },
        ],
      }),
    };

    const result = await detectModerationLabels(Buffer.from("image"), {
      provider: "rekognition",
      client: client as never,
    });

    expect(client.send.mock.calls[0]![0]).toBeInstanceOf(
      DetectModerationLabelsCommand,
    );
    expect(result).toEqual({
      ok: true,
      signals: [
        {
          provider: "aws",
          category: "Graphic Female Nudity",
          score: 0.97,
          severity: "block",
        },
        {
          provider: "aws",
          category: "Female Swimwear Or Underwear",
          score: 0.88,
          severity: "review",
        },
      ],
    });
  });

  it("allows revealing-but-non-explicit labels (no substring false-block)", async () => {
    // Regression: the old `includes("explicit nudity")` test matched the
    // SOFTEST AWS label, "Non-Explicit Nudity", and hard-blocked acceptable
    // revealing photos. Exact matching keeps these as review (which the policy
    // does not reject) while still blocking a truly explicit leaf.
    const client = {
      send: vi.fn().mockResolvedValue({
        ModerationLabels: [
          {
            Name: "Non-Explicit Nudity",
            ParentName: "Non-Explicit Nudity of Intimate parts and Kissing",
            Confidence: 93,
          },
          {
            Name: "Partially Exposed Female Breast",
            ParentName: "Non-Explicit Nudity",
            Confidence: 95,
          },
          {
            Name: "Partially Exposed Buttocks",
            ParentName: "Non-Explicit Nudity",
            Confidence: 98,
          },
          {
            Name: "Exposed Female Nipple",
            ParentName: "Explicit Nudity",
            Confidence: 96,
          },
        ],
      }),
    };

    const result = await detectModerationLabels(Buffer.from("image"), {
      provider: "rekognition",
      client: client as never,
    });

    expect(result).toEqual({
      ok: true,
      signals: [
        {
          provider: "aws",
          category: "Non-Explicit Nudity",
          score: 0.93,
          severity: "review",
        },
        {
          provider: "aws",
          category: "Partially Exposed Female Breast",
          score: 0.95,
          severity: "review",
        },
        {
          provider: "aws",
          category: "Partially Exposed Buttocks",
          score: 0.98,
          severity: "review",
        },
        {
          provider: "aws",
          category: "Exposed Female Nipple",
          score: 0.96,
          severity: "block",
        },
      ],
    });
  });

  it("does not synthesize approval when the provider is disabled", async () => {
    expect(
      await detectFaces(Buffer.from("image"), { provider: "disabled" }),
    ).toEqual({ ok: false, error: "not_configured" });
    expect(
      await detectModerationLabels(Buffer.from("image"), {
        provider: "disabled",
      }),
    ).toEqual({ ok: false, error: "not_configured" });
  });

  it("returns API failures without throwing", async () => {
    const client = {
      send: vi.fn().mockRejectedValue(new Error("denied")),
    };

    expect(
      await detectModerationLabels(Buffer.from("image"), {
        provider: "rekognition",
        client: client as never,
      }),
    ).toEqual({ ok: false, error: "api" });
  });
});
