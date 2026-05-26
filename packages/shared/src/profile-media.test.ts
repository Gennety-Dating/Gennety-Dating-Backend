import { describe, expect, it } from "vitest";
import {
  normalizeProfileMedia,
  profileLivePhotoMedia,
  staticPhotosFromProfileMedia,
} from "./profile-media.js";

describe("profile media normalization", () => {
  it("falls back from legacy photos[] when profileMedia is empty", () => {
    expect(normalizeProfileMedia([], ["p1", "p2"])).toEqual([
      { type: "photo", photo: "p1" },
      { type: "photo", photo: "p2" },
    ]);
  });

  it("preserves valid live photo items", () => {
    expect(
      normalizeProfileMedia(
        [
          {
            type: "live_photo",
            photo: "static_1",
            livePhoto: "live_1",
            duration: 4,
            width: 720,
            height: 1280,
            fileSize: 1234,
            mimeType: "video/mp4",
          },
        ],
        ["legacy_1"],
      ),
    ).toEqual([
      {
        type: "live_photo",
        photo: "static_1",
        livePhoto: "live_1",
        duration: 4,
        width: 720,
        height: 1280,
        fileSize: 1234,
        mimeType: "video/mp4",
      },
    ]);
  });

  it("falls back to photos[] when structured media is unusable", () => {
    expect(
      normalizeProfileMedia(
        [
          { type: "live_photo", photo: "static_without_video" },
          { type: "photo", photo: "" },
        ],
        ["p1"],
      ),
    ).toEqual([{ type: "photo", photo: "p1" }]);
  });

  it("falls back to photos[] when structured media count no longer aligns", () => {
    expect(
      normalizeProfileMedia(
        [{ type: "live_photo", photo: "static_1", livePhoto: "live_1" }],
        ["p1", "p2"],
      ),
    ).toEqual([
      { type: "photo", photo: "p1" },
      { type: "photo", photo: "p2" },
    ]);
  });

  it("derives static verification photos from mixed media", () => {
    const media = [
      { type: "photo" as const, photo: "p1" },
      profileLivePhotoMedia({ photo: "static_2", livePhoto: "live_2" }),
    ];

    expect(staticPhotosFromProfileMedia(media)).toEqual(["p1", "static_2"]);
  });
});
