import { describe, expect, it } from "vitest";
import {
  normalizeProfileMedia,
  profileLivePhotoMedia,
  profileVideoMedia,
  profileMediaHasVideo,
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

  it("keeps a video item alongside photos (static count still aligns)", () => {
    const result = normalizeProfileMedia(
      [
        { type: "photo", photo: "p1" },
        { type: "photo", photo: "p2" },
        { type: "video", video: "vid_1", duration: 12 },
      ],
      ["p1", "p2"],
    );
    expect(result).toEqual([
      { type: "photo", photo: "p1" },
      { type: "photo", photo: "p2" },
      { type: "video", video: "vid_1", duration: 12 },
    ]);
  });

  it("excludes video from static verification photos (face-match invariant)", () => {
    const media = [
      { type: "photo" as const, photo: "p1" },
      profileVideoMedia({ video: "vid_1" }),
      profileLivePhotoMedia({ photo: "static_2", livePhoto: "live_2" }),
    ];
    expect(staticPhotosFromProfileMedia(media)).toEqual(["p1", "static_2"]);
    expect(profileMediaHasVideo(media)).toBe(true);
  });

  it("rejects a video item without a file id", () => {
    expect(
      normalizeProfileMedia([{ type: "video", video: "" }], ["p1"]),
    ).toEqual([{ type: "photo", photo: "p1" }]);
  });
});
