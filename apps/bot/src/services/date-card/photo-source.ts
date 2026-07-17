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
  /** True when the photo came from Google Places (requires on-card credit). */
  attribution: boolean;
}

/**
 * Resolve the venue photo for a match to raw bytes.
 *
 * Priority:
 *   1. `photoUrl` — an operator-owned curated photo (clean licensing, no credit).
 *   2. `photoName` — a Google Places photo resource name; the displayable media
 *      URL is rebuilt here with the server-side key, and Google credit is
 *      required on the card. Google's bytes are fetched on demand and never
 *      persisted (Places ToS).
 *
 * Returns `null` when there's no usable photo or the fetch fails — the card
 * template then falls back to a branded gradient backdrop.
 */
export async function resolveVenuePhoto(
  photoUrl: string | null | undefined,
  photoName: string | null | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<VenuePhotoResult | null> {
  if (photoUrl) {
    const buffer = await fetchImage(photoUrl, fetchFn);
    if (buffer) return { buffer, attribution: false };
  }

  const placesUrl = buildPlacesPhotoUrl(photoName, process.env.PLACES_API_KEY);
  if (placesUrl) {
    const buffer = await fetchImage(placesUrl, fetchFn);
    if (buffer) return { buffer, attribution: true };
  }

  return null;
}

async function fetchImage(url: string, fetchFn: typeof fetch): Promise<Buffer | null> {
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(VENUE_PHOTO_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await readResponseBuffer(res, VENUE_PHOTO_MAX_BYTES);
  } catch {
    return null;
  }
}
