import { describe, it, expect, vi } from "vitest";
import { buildPlacesPhotoUrl } from "../venue.js";
import { resolveVenuePhoto } from "./photo-source.js";

describe("buildPlacesPhotoUrl", () => {
  it("returns null without a name or key", () => {
    expect(buildPlacesPhotoUrl(null, "key")).toBeNull();
    expect(buildPlacesPhotoUrl("places/x/photos/y", null)).toBeNull();
  });

  it("builds the Places media URL with the key", () => {
    const url = buildPlacesPhotoUrl("places/x/photos/y", "secret", 800);
    expect(url).toBe(
      "https://places.googleapis.com/v1/places/x/photos/y/media?maxWidthPx=800&key=secret",
    );
  });
});

function okResponse(): Response {
  return {
    ok: true,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as Response;
}

describe("resolveVenuePhoto", () => {
  it("prefers the curated photoUrl (no Google attribution)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const res = await resolveVenuePhoto("https://cdn/x.jpg", "places/x/photos/y", fetchFn);
    expect(res?.attribution).toBe(false);
    expect(res?.buffer).toBeInstanceOf(Buffer);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://cdn/x.jpg");
  });

  it("falls back to a Places photo (with attribution) when no curated url", async () => {
    process.env.PLACES_API_KEY = "k";
    const fetchFn = vi.fn().mockResolvedValue(okResponse());
    const res = await resolveVenuePhoto(null, "places/x/photos/y", fetchFn);
    expect(res?.attribution).toBe(true);
    expect(fetchFn.mock.calls[0]![0]).toContain("/media?");
    delete process.env.PLACES_API_KEY;
  });

  it("returns null when nothing is available", async () => {
    const fetchFn = vi.fn();
    expect(await resolveVenuePhoto(null, null, fetchFn)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an oversized venue photo", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("x", {
        headers: { "content-length": String(10 * 1024 * 1024 + 1) },
      }),
    );
    await expect(resolveVenuePhoto("https://cdn/x.jpg", null, fetchFn)).resolves.toBeNull();
  });
});
