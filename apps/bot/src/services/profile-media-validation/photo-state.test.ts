import { describe, expect, it } from "vitest";
import {
  alignPhotoHashes,
  appendAlignedPhotoHash,
  photoUploadStatePatch,
  removeAlignedPhotoHash,
  reorderProfilePhotos,
} from "./photo-state.js";

describe("aligned photo hash state", () => {
  it("preserves an already aligned array including empty sentinels", () => {
    expect(alignPhotoHashes(["a", "b", "c"], ["ha", "", "hc"])).toEqual([
      "ha",
      "",
      "hc",
    ]);
  });

  it("clears ambiguous legacy hash associations when lengths differ", () => {
    expect(alignPhotoHashes(["a", "b", "c"], ["ha", "hc"])).toEqual([
      "",
      "",
      "",
    ]);
  });

  it("appends a sentinel when validation produced no hash", () => {
    expect(appendAlignedPhotoHash(["a"], ["ha"], null)).toEqual(["ha", ""]);
  });

  it("removes the hash at the same index as the deleted photo", () => {
    expect(removeAlignedPhotoHash(["a", "b", "c"], ["ha", "hb", "hc"], 1)).toEqual([
      "ha",
      "hc",
    ]);
  });

  it("does not filter sentinels while building the persistence patch", () => {
    expect(
      photoUploadStatePatch({
        photos: ["a", "b"],
        uploadedPhotoHashes: ["ha", ""],
        skipReferenceCreation: true,
      }).uploadedPhotoHashes,
    ).toEqual(["ha", ""]);
  });
});

describe("reorderProfilePhotos", () => {
  const photo = (ref: string) => ({ type: "photo", photo: ref });
  const video = { type: "video", video: "u/clip.mp4" };

  it("moves each photo with its hash, face score and static media slot", () => {
    const next = reorderProfilePhotos({
      photos: ["a", "b", "c"],
      media: [photo("a"), photo("b"), video, photo("c")],
      photoFaceScores: [0.9, 0.8, 0.7],
      uploadedPhotoHashes: ["ha", "hb", "hc"],
      order: [2, 0, 1],
    });
    expect(next).toEqual({
      photos: ["c", "a", "b"],
      // The video keeps its place; the static slots take the new order.
      media: [photo("c"), photo("a"), video, photo("b")],
      photoFaceScores: [0.7, 0.9, 0.8],
      uploadedPhotoHashes: ["hc", "ha", "hb"],
    });
  });

  it("drops unaligned legacy scores and aligns hashes first", () => {
    const next = reorderProfilePhotos({
      photos: ["a", "b"],
      media: [photo("a"), photo("b")],
      photoFaceScores: [0.9],
      uploadedPhotoHashes: ["only-one"],
      order: [1, 0],
    });
    expect(next?.photoFaceScores).toEqual([]);
    expect(next?.uploadedPhotoHashes).toEqual(["", ""]);
  });

  it("refuses anything that is not a permutation of the current indexes", () => {
    const base = {
      photos: ["a", "b", "c"],
      media: [photo("a"), photo("b"), photo("c")],
      photoFaceScores: [],
      uploadedPhotoHashes: [],
    };
    expect(reorderProfilePhotos({ ...base, order: [0, 1] })).toBeNull();
    expect(reorderProfilePhotos({ ...base, order: [0, 1, 1] })).toBeNull();
    expect(reorderProfilePhotos({ ...base, order: [0, 1, 3] })).toBeNull();
    expect(reorderProfilePhotos({ ...base, order: [0, 1, 2.5] })).toBeNull();
  });
});
