import { buildPlacesPhotoUrl } from "../venue.js";
import { readResponseBuffer } from "../../utils/bounded-response.js";

/**
 * Photo sourcing for the date card. The partner photo is resolved by the
 * caller via the shared `downloadProfileImage` helper (handles Telegram
 * `file_id` vs Supabase path); this module owns the *venue* photo, whose
 * source discriminates how we treat it.
 */

const VENUE_PHOTO_TIMEOUT_MS = 8_000;
const VENUE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export interface VenuePhotoResult {
  buffer: Buffer;
  /**
   * Always true — every venue photo now comes from Google Places and carries
   * its on-card credit. Kept as a field so the template keeps one explicit
   * switch for the credit line rather than hard-coding it.
   */
  attribution: boolean;
}

/**
 * Resolve the venue photo for a match to raw bytes.
 *
 * Google Places is the SINGLE source (2026-07-25). `photoName` is a Places
 * photo *resource name*; the displayable media URL is rebuilt here with the
 * server-side key, Google's bytes are fetched on demand and never persisted
 * (Places ToS), and the card carries Google credit.
 *
 * The previous operator-owned `photoUrl` branch was removed: no curated row
 * ever had one, so curated venues — the primary assignment source — always fell
 * through to a photo-less card. Curated venues now get their cover resolved
 * from `placeId` at assignment time (`fetchPlacePhotoName`), which is what
 * fills `photoName` here.
 *
 * Returns `null` when there's no usable photo or the fetch fails — the card
 * template then falls back to a branded gradient backdrop.
 */
export async function resolveVenuePhoto(
  photoName: string | null | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<VenuePhotoResult | null> {
  const placesUrl = buildPlacesPhotoUrl(photoName, process.env.PLACES_API_KEY);
  if (!placesUrl) return null;
  const buffer = await fetchImage(placesUrl, fetchFn);
  return buffer ? { buffer, attribution: true } : null;
}

/**
 * The URL carries `key=<PLACES_API_KEY>`, so it can never be logged as-is.
 * Everything diagnostic about it is in the path (which photo, which place).
 */
function redactKey(url: string): string {
  return url.replace(/([?&]key=)[^&]*/i, "$1***");
}

async function fetchImage(url: string, fetchFn: typeof fetch): Promise<Buffer | null> {
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(VENUE_PHOTO_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[date-card] venue photo HTTP ${res.status} for ${redactKey(url)}`);
      return null;
    }
    return await readResponseBuffer(res, VENUE_PHOTO_MAX_BYTES);
  } catch (err) {
    // Never silent. A venue photo that fails leaves the card on its gradient,
    // which looks like a venue that simply has no picture — so without this
    // line the ONLY way to tell the two apart is to diff a delivered card
    // against a fresh render, which is what it took to find the event-loop
    // starvation this module now guards against (see `resolveVenuePhoto`).
    // Same rule PRODUCT_SPEC §3.7b already states for the venue-change proxy:
    // best-effort means logged, never silent.
    console.warn(`[date-card] venue photo fetch failed for ${redactKey(url)}:`, err);
    return null;
  }
}
