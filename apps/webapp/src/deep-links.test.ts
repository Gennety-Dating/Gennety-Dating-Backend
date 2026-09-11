import { describe, expect, it, vi } from "vitest";

import {
  MAPS_APP_NAME,
  appleMapsLink,
  googleMapsLink,
  mapsAppFor,
  mapsLink,
  openExternal,
  uberLink,
  type Destination,
} from "./deep-links.js";

const VENUE: Destination = {
  lat: 50.4481234567,
  lng: 30.5137654321,
  name: "ТРІШКИ БІЛЬШЕ на Золотих Воротах",
  address: "Володимирська 40/2, Київ",
};

function params(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("uberLink", () => {
  it("is Uber's documented rider universal link, picking up at the phone", () => {
    const url = new URL(uberLink(VENUE));
    expect(url.origin + url.pathname).toBe("https://m.uber.com/looking");
    expect(url.searchParams.get("pickup")).toBe("my_location");
  });

  it("drops off at the venue's point, labelled with its name and address", () => {
    const drop = JSON.parse(params(uberLink(VENUE)).get("drop[0]") ?? "null");
    expect(drop).toEqual({
      latitude: 50.448123,
      longitude: 30.513765,
      addressLine1: VENUE.name,
      addressLine2: VENUE.address,
    });
  });

  it("writes a space as %20, never +", () => {
    // iOS URLComponents keeps "+" literal: the app would read "ТРІШКИ+БІЛЬШЕ".
    const url = uberLink(VENUE);
    expect(url).not.toContain("+");
    expect(url).toContain("%20");
  });

  it("leaves out a missing name rather than sending an empty label", () => {
    const drop = JSON.parse(params(uberLink({ ...VENUE, name: null, address: null })).get("drop[0]") ?? "null");
    expect(drop).toEqual({ latitude: 50.448123, longitude: 30.513765 });
  });

  it("carries client_id only when there is one", () => {
    expect(params(uberLink(VENUE)).has("client_id")).toBe(false);
    expect(params(uberLink(VENUE, { clientId: "" })).has("client_id")).toBe(false);
    expect(params(uberLink(VENUE, { clientId: null })).has("client_id")).toBe(false);
    expect(params(uberLink(VENUE, { clientId: "abc123" })).get("client_id")).toBe("abc123");
  });
});

describe("maps links", () => {
  it("Apple Maps: directions to the point, on foot or by car", () => {
    const walk = new URL(appleMapsLink(VENUE, "walking"));
    expect(walk.origin + walk.pathname).toBe("https://maps.apple.com/");
    expect(walk.searchParams.get("daddr")).toBe("50.448123,30.513765");
    expect(walk.searchParams.get("dirflg")).toBe("w");
    expect(params(appleMapsLink(VENUE, "driving")).get("dirflg")).toBe("d");
  });

  it("Google Maps: the documented api=1 directions form", () => {
    const drive = new URL(googleMapsLink(VENUE, "driving"));
    expect(drive.origin + drive.pathname).toBe("https://www.google.com/maps/dir/");
    expect(drive.searchParams.get("api")).toBe("1");
    expect(drive.searchParams.get("destination")).toBe("50.448123,30.513765");
    expect(drive.searchParams.get("travelmode")).toBe("driving");
    expect(params(googleMapsLink(VENUE, "walking")).get("travelmode")).toBe("walking");
  });

  it("mapsLink picks the builder for the app", () => {
    expect(mapsLink("apple", VENUE, "walking")).toBe(appleMapsLink(VENUE, "walking"));
    expect(mapsLink("google", VENUE, "driving")).toBe(googleMapsLink(VENUE, "driving"));
  });
});

describe("every hand-off", () => {
  const all = [
    uberLink(VENUE, { clientId: "abc" }),
    appleMapsLink(VENUE, "walking"),
    appleMapsLink(VENUE, "driving"),
    googleMapsLink(VENUE, "walking"),
    googleMapsLink(VENUE, "driving"),
  ];

  it("is https — Telegram's openLink throws on any other scheme", () => {
    for (const url of all) expect(new URL(url).protocol, url).toBe("https:");
  });

  it("names no origin, so the user's position never leaves the phone", () => {
    for (const url of all) {
      const p = params(url);
      for (const key of ["origin", "saddr", "sll", "pickup[latitude]", "pickup[longitude]"]) {
        expect(p.has(key), `${url} → ${key}`).toBe(false);
      }
    }
    expect(params(uberLink(VENUE)).get("pickup")).toBe("my_location");
  });
});

describe("mapsAppFor", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/128.0";
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0";

  it("trusts Telegram's own platform first", () => {
    expect(mapsAppFor("ios", ANDROID)).toBe("apple");
    expect(mapsAppFor("macos", WINDOWS)).toBe("apple");
    expect(mapsAppFor("android", IPHONE)).toBe("google");
  });

  it("falls back to the user agent for the web and desktop clients, and outside Telegram", () => {
    expect(mapsAppFor("weba", IPHONE)).toBe("apple");
    expect(mapsAppFor("webk", ANDROID)).toBe("google");
    expect(mapsAppFor("tdesktop", WINDOWS)).toBe("google");
    expect(mapsAppFor(undefined, IPHONE)).toBe("apple");
    expect(mapsAppFor(undefined, ANDROID)).toBe("google");
  });

  it("names the apps the way their makers do", () => {
    expect(MAPS_APP_NAME).toEqual({ apple: "Apple Maps", google: "Google Maps" });
  });
});

describe("openExternal", () => {
  it("hands the link to Telegram when it can", () => {
    const openLink = vi.fn();
    const fallback = vi.fn();
    openExternal("https://m.uber.com/looking", { openLink }, fallback);
    expect(openLink).toHaveBeenCalledWith("https://m.uber.com/looking");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("opens a tab outside Telegram, and when the client refuses the call", () => {
    const fallback = vi.fn();
    openExternal("https://maps.apple.com/", undefined, fallback);
    openExternal(
      "https://maps.apple.com/",
      {
        openLink: () => {
          throw new Error("WebAppTgUrlInvalid");
        },
      },
      fallback,
    );
    expect(fallback).toHaveBeenCalledTimes(2);
  });
});
