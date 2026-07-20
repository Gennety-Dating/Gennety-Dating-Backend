import { describe, expect, it } from "vitest";
import {
  alignPhotoHashes,
  appendAlignedPhotoHash,
  photoUploadStatePatch,
  removeAlignedPhotoHash,
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
