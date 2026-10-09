import { VENUE_PHOTO_CURATION } from "./venue-photo-curation.data.js";

/**
 * Which of Google's photos of a place we show, and in what order — the
 * founder's photo audit of 2026-10-09, applied wherever a Places answer turns
 * into photo names (`venue.ts`), so every surface agrees: the iOS city guide's
 * card (first five) and profile (up to ten), the Mini App venue-change board,
 * the scheduled-date card's cover.
 *
 * Why a list in code and not a column: Google's photo NAMES are minted per
 * response — the same photo comes back under a new `places/X/photos/Y` every
 * time (measured 2026-10-09: 8 of 8 places, every name different a minute
 * apart) — so a stored name is a pointer that expires, and the nightly
 * re-validation overwrites `photoRefs` anyway. What IS stable is the photo's
 * metadata and Google's order: author + pixel size came back identical, in the
 * same order, on every request. A photo is therefore pinned by a fingerprint
 * of those (`photoFingerprints`), and the choice is re-applied to every fresh
 * answer. Kept in git rather than the database for the same reason as the
 * showcase picks (`showcase-curation.ts`): it is editorial data that must
 * survive a re-seed, and a change to it is reviewed like code.
 *
 * Google gives the API at most ten photos of a place, so curation chooses and
 * orders among those ten; it cannot reach the hundreds on the Maps page.
 */

/** One place's audited choice. Fingerprints, see {@link photoFingerprints}. */
export interface VenuePhotoCuration {
  /** For the reader only. */
  name: string;
  /** Shown, in this order: the first is the cover, the first five the card. */
  show: readonly string[];
  /** Never shown, even if the approved set drifts away (dishes, menus, filters…). */
  hide: readonly string[];
}

/** A photo as the Places API (New) describes it. */
export interface PlacePhotoMeta {
  name?: string;
  widthPx?: number;
  heightPx?: number;
  authorAttributions?: { displayName?: string }[];
}

/**
 * Below this many approved photos still present in Google's answer, the
 * gallery is topped up with photos nobody has reviewed yet (never hidden ones)
 * rather than shrinking towards nothing — Google's set of ten drifts as people
 * upload, and an empty card is worse than an unreviewed photo.
 */
export const CURATED_PHOTOS_MIN_SHOWN = 3;

/**
 * `author|WxH`, plus `#n` for the n-th (n ≥ 2) photo sharing both — one person
 * often uploads several shots from the same phone, so author + size alone is
 * ambiguous for about half of Kyiv's catalog. Google's order is stable, so the
 * occurrence number is too.
 */
export function photoFingerprints(photos: readonly PlacePhotoMeta[]): string[] {
  const seen = new Map<string, number>();
  return photos.map((photo) => {
    const author = (photo.authorAttributions ?? [])
      .map((a) => a.displayName ?? "")
      .join(", ");
    const base = `${author}|${photo.widthPx ?? 0}x${photo.heightPx ?? 0}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  });
}

/**
 * Photo resource names of a place, best first, as we show them. A place with
 * no audit keeps Google's order.
 */
export function curatedPhotoNames(
  placeId: string | null | undefined,
  photos: readonly PlacePhotoMeta[] | undefined,
  curation: Readonly<Record<string, VenuePhotoCuration>> = VENUE_PHOTO_CURATION,
): string[] {
  const named = (photos ?? []).filter(
    (photo): photo is PlacePhotoMeta & { name: string } =>
      typeof photo.name === "string" && photo.name.length > 0,
  );
  const audit = placeId ? curation[placeId] : undefined;
  if (!audit) return named.map((photo) => photo.name);

  const fingerprints = photoFingerprints(named);
  const nameOf = new Map(fingerprints.map((fp, i) => [fp, named[i]!.name]));
  const shown = audit.show
    .map((fp) => nameOf.get(fp))
    .filter((name): name is string => name !== undefined);
  if (shown.length >= CURATED_PHOTOS_MIN_SHOWN) return shown;

  const reviewed = new Set([...audit.show, ...audit.hide]);
  return [
    ...shown,
    ...named.filter((_, i) => !reviewed.has(fingerprints[i]!)).map((photo) => photo.name),
  ];
}
