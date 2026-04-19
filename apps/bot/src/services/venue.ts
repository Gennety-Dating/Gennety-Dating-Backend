/**
 * Venue picker service (Phase 3.4 — concierge flow).
 *
 * Two entry points:
 *   - `pickVenueForMatch(input)` — legacy path: resolves a venue from
 *     university domains. Retained so older code + migration rollback
 *     keeps working. Falls back to a deterministic local stub when
 *     `PLACES_API_KEY` is not set.
 *   - `pickVenueAtMidpoint(input)` — concierge path: takes the resolved
 *     midpoint (`lat`, `lng`), a whitelisted `category`, and optional
 *     `keywords`, and queries Google Places Nearby Search.
 *
 * Both paths ultimately go through `VenueClient.pick(...)` and fall back
 * to the local stub on any error so scheduling never wedges.
 *
 * AGENTS.md: no new dependencies without approval — we keep this behind
 * a narrow interface and use `fetch` directly rather than pulling in
 * `@googlemaps/google-maps-services-js`.
 */

import type { VenueCategory } from "./vibe-parser.js";

export interface Venue {
  name: string;
  address: string;
}

/** Legacy (pre-concierge) input. */
export interface VenueInput {
  universityDomainA: string | null;
  universityDomainB: string | null;
}

/** Concierge input — resolved midpoint + merged, whitelisted preferences. */
export interface MidpointVenueInput {
  lat: number;
  lng: number;
  category: VenueCategory;
  keywords: string[];
  radiusMeters: number;
}

export interface VenueClient {
  pick(input: VenueInput): Promise<Venue>;
  pickAtMidpoint?(input: MidpointVenueInput): Promise<Venue>;
}

/**
 * Tiny deterministic lookup table used when there is no Places API key.
 * Maps a university email domain to a known nearby café. Extend as needed.
 * Anything not in the table falls back to a generic "campus café" label.
 */
const STUB_CAFES: Record<string, Venue> = {
  "stanford.edu": { name: "Coupa Café", address: "538 Ramona St, Palo Alto, CA" },
  "mit.edu": { name: "Flour Bakery + Café", address: "190 Massachusetts Ave, Cambridge, MA" },
  "ox.ac.uk": { name: "Vaults & Garden Café", address: "University Church, Oxford" },
  "cam.ac.uk": { name: "Fitzbillies", address: "51-52 Trumpington St, Cambridge" },
};

export function localStubVenueClient(): VenueClient {
  return {
    async pick(input: VenueInput): Promise<Venue> {
      const a = input.universityDomainA;
      const b = input.universityDomainB;
      if (a && a === b && STUB_CAFES[a]) return STUB_CAFES[a];
      if (a && STUB_CAFES[a]) return STUB_CAFES[a];
      if (b && STUB_CAFES[b]) return STUB_CAFES[b];
      return {
        name: "Campus Café",
        address: "Near your university",
      };
    },
    async pickAtMidpoint(input: MidpointVenueInput): Promise<Venue> {
      // Local stub: no geocoding, just surface the category + first keyword
      // so tests and dev environments can distinguish concierge results
      // from the old domain-based results without network access.
      const label = input.keywords[0]
        ? `${input.keywords[0]} ${input.category}`
        : input.category;
      return {
        name: `Neighbourhood ${label}`.replace(/_/g, " "),
        address: `Near ${input.lat.toFixed(3)}, ${input.lng.toFixed(3)}`,
      };
    },
  };
}

interface PlacesResponse {
  results?: Array<{
    name?: string;
    vicinity?: string;
    formatted_address?: string;
    business_status?: string;
    user_ratings_total?: number;
  }>;
}

/** Category → Google Places `type` parameter. Narrower than the whitelist. */
const PLACES_TYPE_MAP: Record<VenueCategory, string> = {
  cafe: "cafe",
  coffee_shop: "cafe",
  restaurant: "restaurant",
  park: "park",
  museum: "museum",
  lounge: "bar",
};

/**
 * Google Places client — supports both the legacy domain-based path and
 * the concierge midpoint path.
 */
export function createPlacesVenueClient(apiKey: string): VenueClient {
  return {
    async pick(input: VenueInput): Promise<Venue> {
      const query = `cafe near ${input.universityDomainA ?? input.universityDomainB ?? "university"}`;
      const url = new URL("https://maps.googleapis.com/maps/api/place/textsearch/json");
      url.searchParams.set("query", query);
      url.searchParams.set("key", apiKey);

      const res = await fetch(url.toString());
      if (!res.ok) {
        throw new Error(`Places API failed: ${res.status}`);
      }
      const json = (await res.json()) as PlacesResponse;
      const first = json.results?.[0];
      if (!first?.name) {
        throw new Error("Places API returned no results");
      }
      return {
        name: first.name,
        address: first.formatted_address ?? first.vicinity ?? "",
      };
    },

    async pickAtMidpoint(input: MidpointVenueInput): Promise<Venue> {
      // Nearby Search centred on the midpoint. We rank by `prominence`
      // (default) rather than `distance`: a slightly-further-away but
      // central/popular spot beats an isolated-but-equidistant one for
      // students commuting by transit. If no results, we fall back to a
      // Text Search biased by the midpoint as a location hint.
      const url = new URL(
        "https://maps.googleapis.com/maps/api/place/nearbysearch/json",
      );
      url.searchParams.set("location", `${input.lat},${input.lng}`);
      url.searchParams.set("radius", String(input.radiusMeters));
      url.searchParams.set("type", PLACES_TYPE_MAP[input.category]);
      if (input.keywords.length > 0) {
        url.searchParams.set("keyword", input.keywords.join(" "));
      }
      url.searchParams.set("opennow", "false");
      url.searchParams.set("key", apiKey);

      const res = await fetch(url.toString());
      if (!res.ok) {
        throw new Error(`Places Nearby failed: ${res.status}`);
      }
      const json = (await res.json()) as PlacesResponse;

      // Pick the first OPERATIONAL, reasonably-rated result. Guards against
      // the occasional closed-permanently or brand-new (zero ratings) hit.
      const candidates = (json.results ?? []).filter(
        (r) =>
          r.name &&
          (r.business_status === undefined ||
            r.business_status === "OPERATIONAL") &&
          (r.user_ratings_total === undefined || r.user_ratings_total > 5),
      );

      const first = candidates[0] ?? json.results?.[0];
      if (!first?.name) {
        // Retry path: widen to a text search biased by the midpoint.
        return await textSearchFallback(apiKey, input);
      }
      return {
        name: first.name,
        address: first.formatted_address ?? first.vicinity ?? "",
      };
    },
  };
}

async function textSearchFallback(
  apiKey: string,
  input: MidpointVenueInput,
): Promise<Venue> {
  const kw = input.keywords.join(" ");
  const query = (kw ? `${kw} ${input.category}` : input.category).replace(
    /_/g,
    " ",
  );
  const url = new URL(
    "https://maps.googleapis.com/maps/api/place/textsearch/json",
  );
  url.searchParams.set("query", query);
  url.searchParams.set("location", `${input.lat},${input.lng}`);
  url.searchParams.set("radius", String(input.radiusMeters));
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Places Text fallback failed: ${res.status}`);
  }
  const json = (await res.json()) as PlacesResponse;
  const first = json.results?.[0];
  if (!first?.name) {
    throw new Error("Places API returned no results");
  }
  return {
    name: first.name,
    address: first.formatted_address ?? first.vicinity ?? "",
  };
}

/**
 * Legacy high-level: pick a venue for a match by university domain.
 * Retained for tests and the fallback path when the concierge flow can't
 * gather both locations (e.g. one user never sends a pin).
 */
export async function pickVenueForMatch(
  input: VenueInput,
  client?: VenueClient,
): Promise<Venue> {
  const apiKey = process.env.PLACES_API_KEY ?? "";
  const impl = client ?? (apiKey ? createPlacesVenueClient(apiKey) : localStubVenueClient());
  try {
    return await impl.pick(input);
  } catch (err) {
    console.warn("Venue pick failed, using stub:", err);
    return localStubVenueClient().pick(input);
  }
}

/**
 * Concierge high-level: pick a venue near the computed midpoint, matching
 * the users' whitelisted category + keywords. Never throws — any Places
 * failure falls back to the local stub so the match still finalises.
 */
export async function pickVenueAtMidpoint(
  input: MidpointVenueInput,
  client?: VenueClient,
): Promise<Venue> {
  const apiKey = process.env.PLACES_API_KEY ?? "";
  const impl = client ?? (apiKey ? createPlacesVenueClient(apiKey) : localStubVenueClient());
  try {
    if (impl.pickAtMidpoint) {
      return await impl.pickAtMidpoint(input);
    }
    // Client doesn't implement the concierge path — fall through to stub.
    return await localStubVenueClient().pickAtMidpoint!(input);
  } catch (err) {
    console.warn("Midpoint venue pick failed, using stub:", err);
    return localStubVenueClient().pickAtMidpoint!(input);
  }
}
