import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";

import { requireCanvasAuth } from "../canvas-auth.js";
import { allowCrossOriginImage } from "../cross-origin-image.js";
import { canvasLimiter, venuePhotoLimiter } from "../rate-limit.js";
import {
  ALLOWED_PHOTO_WIDTHS,
  createPhotoCache,
  fetchPlacesPhoto,
  type PhotoBytes,
} from "../places-photo.js";
import { venuePhotoSignatureValid, venuePhotoUrl } from "../showcase-photos.js";
import { buildPlacesPhotoUrl } from "../../services/venue.js";
import {
  getShowcaseVenues,
  showcasePhotoRef,
  type ShowcasePlace,
} from "../../services/curated-venue.js";

/**
 * Curated places for the iOS standby canvas (`IDLE_EXPLORING`).
 *
 *   GET /v1/venues/showcase[?cityKey=ua:kyiv] — the places, in display order
 *   GET /v1/venues/:id/photo?w=&e=&sig=       — one place's photo, by signed link
 *
 * The two halves authenticate differently, and on purpose. The list is the
 * canvas talking, so it takes either rail like every other canvas call. The
 * photo is fetched by an image loader, which sends no Authorization header — so,
 * as with the partner photos, the link carries the permission itself
 * (`showcase-photos.ts`), and only the list above mints links.
 *
 * Why not the existing `/v1/venue-change/photo`: it authenticates with Telegram
 * initData in the query, which the native client does not have, and it takes a
 * raw Places resource name from the caller. Here the caller names a catalog row
 * and the server decides which photograph that is.
 */
export const venuesRouter: Router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loose on purpose. The key only ever reaches a parameterised Prisma filter, so
 * the check exists to turn junk into a 400, not to know the list of cities —
 * an unknown but well-formed key simply answers an empty list.
 */
const CITY_KEY_REGEX = /^[a-z0-9:_-]{2,64}$/;

/** Card photo and map-pin photo — the two widths `ALLOWED_PHOTO_WIDTHS` allows. */
const CARD_WIDTH = ALLOWED_PHOTO_WIDTHS[1];
const PIN_WIDTH = ALLOWED_PHOTO_WIDTHS[0];

/**
 * Bytes of proxied photos. 24 places × two widths is the working set of a
 * city, so 96 entries hold two cities with room to spare; see
 * `createPhotoCache` for why this surface needs one and the board does not.
 */
const photoCache = createPhotoCache({
  maxEntries: 96,
  maxBytes: 24 * 1024 * 1024,
  ttlMs: 12 * 60 * 60 * 1000,
});

/** Test-only: forget every cached photo. */
export function resetVenuePhotoCache(): void {
  photoCache.clear();
}

/** One place as it goes over the wire: photo links are signed per response. */
export function serializeShowcasePlace(place: ShowcasePlace, now: number = Date.now()) {
  const { hasPhoto, ...rest } = place;
  return {
    ...rest,
    photoUrl: hasPhoto ? venuePhotoUrl(place.id, CARD_WIDTH, now) : null,
    thumbnailUrl: hasPhoto ? venuePhotoUrl(place.id, PIN_WIDTH, now) : null,
  };
}

venuesRouter.get(
  "/showcase",
  requireCanvasAuth,
  // After auth, so the key is the person — see `canvasLimiter`.
  canvasLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const raw = req.query.cityKey;
    let cityKey: string | null;

    if (raw !== undefined) {
      const trimmed = typeof raw === "string" ? raw.trim() : "";
      if (!CITY_KEY_REGEX.test(trimmed)) {
        res.status(400).json({ error: "bad-city-key" });
        return;
      }
      cityKey = trimmed;
    } else {
      // The client does not have to know its own city: the canvas opens on
      // the one the person chose at onboarding, the same key the match pool
      // uses (`Profile.homeCityKey`).
      const user = await prisma.user.findUnique({
        where: { id: req.userId! },
        select: { profile: { select: { homeCityKey: true } } },
      });
      cityKey = user?.profile?.homeCityKey ?? null;
    }

    if (!cityKey) {
      // No city yet — an empty list is the true answer, not an error. The
      // canvas then shows its ordinary standby sheet instead of a showcase.
      res.json({ cityKey: null, venues: [] });
      return;
    }

    const places = await getShowcaseVenues(cityKey);
    const now = Date.now();
    res.json({ cityKey, venues: places.map((place) => serializeShowcasePlace(place, now)) });
  },
);

venuesRouter.get(
  "/:id/photo",
  venuePhotoLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id ?? "");
    const width = Number(req.query.w);
    const expiresAt = Number(req.query.e);
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";

    if (
      !UUID_REGEX.test(id) ||
      !(ALLOWED_PHOTO_WIDTHS as readonly number[]).includes(width) ||
      !Number.isFinite(expiresAt) ||
      !sig
    ) {
      res.status(400).json({ error: "bad-link" });
      return;
    }
    if (!venuePhotoSignatureValid(id, width, expiresAt, sig)) {
      // Forged and expired look the same from here, and the client's answer
      // to both is the same: ask the list again.
      res.status(403).json({ error: "bad-signature" });
      return;
    }

    const key = `${id}@${width}`;
    const cached = photoCache.get(key);
    if (cached) {
      sendPhoto(res, cached);
      return;
    }

    const apiKey = process.env.PLACES_API_KEY;
    if (!apiKey) {
      res.status(404).json({ error: "photos-unavailable" });
      return;
    }
    const url = buildPlacesPhotoUrl(await showcasePhotoRef(id), apiKey, width);
    if (!url) {
      res.status(404).json({ error: "no-photo" });
      return;
    }

    const result = await fetchPlacesPhoto(url, "[venues]");
    if (!result.ok) {
      res.status(502).json({ error: "upstream" });
      return;
    }
    const photo: PhotoBytes = { contentType: result.contentType, body: result.body };
    photoCache.set(key, photo);
    sendPhoto(res, photo);
  },
);

function sendPhoto(res: Response, photo: PhotoBytes): void {
  res.setHeader("Content-Type", photo.contentType);
  allowCrossOriginImage(res);
  // Private — the link is signed. A day, like the link's own lifetime: a
  // curated venue's cover changes only when the nightly re-validation says so.
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.status(200).send(photo.body);
}
