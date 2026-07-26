import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ env: { PROMO_ATTRIBUTION_TTL_MIN: 60 } }));
vi.mock("../config.js", () => ({ env: h.env }));

const {
  fingerprint,
  recordAttribution,
  matchAttribution,
  __resetPromoAttributions,
} = await import("./promo-attribution.js");

beforeEach(() => {
  __resetPromoAttributions();
  h.env.PROMO_ATTRIBUTION_TTL_MIN = 60;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("fingerprint", () => {
  it("is deterministic and normalizes UA/language", () => {
    const a = fingerprint({ ip: "1.2.3.4", userAgent: "iPhone", acceptLanguage: "en-US,en;q=0.9" });
    const b = fingerprint({ ip: "1.2.3.4", userAgent: "iPhone", acceptLanguage: "en-US" });
    expect(a).toBe(b);
    expect(a).toHaveLength(32);
  });

  it("differs for a different IP", () => {
    const a = fingerprint({ ip: "1.2.3.4", userAgent: "x", acceptLanguage: "en" });
    const b = fingerprint({ ip: "9.9.9.9", userAgent: "x", acceptLanguage: "en" });
    expect(a).not.toBe(b);
  });
});

describe("record / match attribution", () => {
  it("matches a recorded code once, then consumes it", () => {
    const fp = fingerprint({ ip: "1.2.3.4", userAgent: "ua", acceptLanguage: "en" });
    recordAttribution(fp, "SUMMER3M");
    expect(matchAttribution(fp)).toBe("SUMMER3M");
    // one-shot: a second match no longer resolves
    expect(matchAttribution(fp)).toBeNull();
  });

  it("returns null for an unknown fingerprint", () => {
    expect(matchAttribution("deadbeef")).toBeNull();
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    const fp = "fp1";
    recordAttribution(fp, "SUMMER3M");
    vi.advanceTimersByTime(61 * 60 * 1000); // TTL is 60 min
    expect(matchAttribution(fp)).toBeNull();
  });

  it("stays bounded under a flood of unique fingerprints", () => {
    // `GET /v1/promo/:code` is public and pre-auth, and the fingerprint folds in
    // the attacker-controlled User-Agent, so unique entries are free to
    // manufacture. Without a ceiling the map grew for the whole TTL — and the
    // old sweep-on-every-access made that quadratic work on a public endpoint.
    for (let i = 0; i < 12_000; i++) recordAttribution(`flood-${i}`, "SUMMER3M");

    // The oldest keys were evicted; the most recent ones still resolve.
    expect(matchAttribution("flood-0")).toBeNull();
    expect(matchAttribution("flood-11999")).toBe("SUMMER3M");
  });

  it("re-recording the same fingerprint does not consume capacity", () => {
    for (let i = 0; i < 20_000; i++) recordAttribution("stable-fp", "SUMMER3M");
    expect(matchAttribution("stable-fp")).toBe("SUMMER3M");
  });
});
