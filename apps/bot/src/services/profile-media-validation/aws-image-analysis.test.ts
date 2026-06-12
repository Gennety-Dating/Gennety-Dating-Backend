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
