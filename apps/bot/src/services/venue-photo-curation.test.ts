import { describe, expect, it } from "vitest";
import {
  curatedPhotoNames,
  photoFingerprints,
  type PlacePhotoMeta,
  type VenuePhotoCuration,
} from "./venue-photo-curation.js";

/** Google mints a new name per response; only author, size and order repeat. */
function photo(author: string, w: number, h: number, mint = "a"): PlacePhotoMeta {
  return {
    name: `places/P/photos/${mint}-${author}-${w}x${h}-${Math.random()}`,
    widthPx: w,
    heightPx: h,
    authorAttributions: [{ displayName: author }],
  };
}

const google = [
  photo("Ann", 3024, 4032), // 0 Ann|3024x4032 — a dish
  photo("Ann", 3024, 4032), // 1 Ann|3024x4032#2 — the hall
  photo("Bob", 4000, 3000), // 2 the facade
  photo("Cat", 1080, 1350), // 3 a menu
  photo("Dan", 4032, 3024), // 4 the terrace
];

const audit: Record<string, VenuePhotoCuration> = {
  P: {
    name: "Test place",
    show: ["Bob|4000x3000", "Ann|3024x4032#2", "Dan|4032x3024"],
    hide: ["Ann|3024x4032", "Cat|1080x1350"],
  },
};

describe("photoFingerprints", () => {
  it("numbers the repeats of one author's same-size shots in Google's order", () => {
    expect(photoFingerprints(google)).toEqual([
      "Ann|3024x4032",
      "Ann|3024x4032#2",
      "Bob|4000x3000",
      "Cat|1080x1350",
      "Dan|4032x3024",
    ]);
  });
});

describe("curatedPhotoNames", () => {
  it("keeps Google's order for a place nobody audited", () => {
    expect(curatedPhotoNames("Q", google, audit)).toEqual(google.map((p) => p.name));
  });

  it("shows only the approved photos, in the audited order, under today's names", () => {
    expect(curatedPhotoNames("P", google, audit)).toEqual([
      google[2]!.name,
      google[1]!.name,
      google[4]!.name,
    ]);
  });

  it("matches a fresh answer whose names all changed", () => {
    const fresh = google.map((p) => ({ ...p, name: `${p.name}-tomorrow` }));
    expect(curatedPhotoNames("P", fresh, audit)[0]).toBe(fresh[2]!.name);
  });

  it("tops up with unreviewed photos, never hidden ones, once the approved set drifts away", () => {
    const drifted = [google[0]!, google[2]!, google[3]!, photo("Eve", 2000, 1500)];
    expect(curatedPhotoNames("P", drifted, audit)).toEqual([drifted[1]!.name, drifted[3]!.name]);
  });

  it("drops photos without a name", () => {
    expect(curatedPhotoNames("Q", [{ widthPx: 1 }, google[0]!], audit)).toEqual([google[0]!.name]);
  });
});
