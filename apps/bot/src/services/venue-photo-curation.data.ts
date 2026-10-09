import type { VenuePhotoCuration } from "./venue-photo-curation.js";

/**
 * The photo audit's verdicts, keyed by Google place id — generated from the
 * audit and reviewed by the founder; see `venue-photo-curation.ts` for what a
 * fingerprint is and how the list is applied.
 */
export const VENUE_PHOTO_CURATION: Readonly<Record<string, VenuePhotoCuration>> = {};
