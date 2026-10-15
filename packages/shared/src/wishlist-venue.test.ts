import { describe, expect, it } from "vitest";
import {
  foldVenueName,
  wishlistVenueFit,
  wishlistVenueMultiplier,
  wishlistVenueTaste,
  type WishlistVenueItem,
} from "./wishlist-venue.js";

/**
 * The wishlist as a soft hint for the first venue (decision journal
 * 2026-10-15): what a list says about places, how one venue fits it, and the
 * in-band weight that can only break near-ties.
 */

const item = (over: Partial<WishlistVenueItem>): WishlistVenueItem => ({
  category: "place",
  title: "",
  brand: null,
  catalogKey: null,
  ...over,
});

const venue = (name: string, experiences: string[] = [], ambiences: string[] = [], formats: string[] = []) => ({
  name,
  facets: { experiences, ambiences, formats },
});

describe("wishlistVenueTaste", () => {
  it("reads curated tags of catalog ideas", () => {
    const taste = wishlistVenueTaste([item({ catalogKey: "rooftop-bar", title: "Бар на крыше" })]);
    expect(taste?.experiences.has("drinks_evening")).toBe(true);
    expect(taste?.ambiences.has("romantic_public")).toBe(true);
  });

  it("reads free text in any of the five languages", () => {
    expect(wishlistVenueTaste([item({ category: "drink", title: "Негрони" })])?.experiences.has("drinks_evening")).toBe(true);
    expect(wishlistVenueTaste([item({ category: "drink", title: "матча латте" })])?.experiences.has("coffee_treats")).toBe(true);
    expect(wishlistVenueTaste([item({ category: "experience", title: "Ausstellung im Museum" })])?.experiences.has("art_culture")).toBe(true);
  });

  it("ignores things that say nothing about a place", () => {
    expect(wishlistVenueTaste([item({ category: "perfume", title: "Santal 33", brand: "Le Labo" })])).toBeNull();
    expect(wishlistVenueTaste([item({ category: "flowers", title: "Пионы" })])).toBeNull();
    expect(wishlistVenueTaste([])).toBeNull();
  });

  it("keeps a typed place as a name to look for", () => {
    expect([...(wishlistVenueTaste([item({ title: "Kanapa Café" })])?.placeNames ?? [])]).toEqual(["kanapa cafe"]);
  });
});

describe("wishlistVenueFit", () => {
  const winePerson = wishlistVenueTaste([item({ category: "drink", title: "натуральное вино" })]);

  it("no list, no opinion", () => {
    expect(wishlistVenueFit(null, venue("Any"))).toBe(0.5);
  });

  it("a venue named on the list is a full fit", () => {
    const taste = wishlistVenueTaste([item({ title: "Kanapa" })]);
    expect(wishlistVenueFit(taste, venue("KANAPA restaurant"))).toBe(1);
  });

  it("a matching kind of place is above neutral, a different one a little below", () => {
    expect(wishlistVenueFit(winePerson, venue("Wine bar", ["drinks_evening"]))).toBeGreaterThan(0.5);
    const miss = wishlistVenueFit(winePerson, venue("Bakery", ["coffee_treats"]));
    expect(miss).toBeLessThan(0.5);
    expect(miss).toBeGreaterThanOrEqual(0.4);
  });
});

describe("wishlistVenueMultiplier", () => {
  it("off at weight 0 — the default", () => {
    expect(wishlistVenueMultiplier(1, 1, 0)).toBe(1);
  });

  it("centred on 1 and capped", () => {
    expect(wishlistVenueMultiplier(0.5, 0.5, 0.3)).toBe(1);
    expect(wishlistVenueMultiplier(1, 1, 0.3)).toBeCloseTo(1.3);
    expect(wishlistVenueMultiplier(1, 1, 5)).toBeCloseTo(1.5);
    expect(wishlistVenueMultiplier(0, 0, 5)).toBeCloseTo(0.5);
  });

  it("one side's opinion counts half", () => {
    expect(wishlistVenueMultiplier(1, 0.5, 0.3)).toBeCloseTo(1.15);
  });
});

describe("foldVenueName", () => {
  it("drops case, accents and punctuation", () => {
    expect(foldVenueName("Café — «Kanapa»!")).toBe("cafe kanapa");
  });
});
