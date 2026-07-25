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
