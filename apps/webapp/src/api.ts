// DEV-ONLY: bypass the ngrok free-tier browser-warning interstitial on Mini App
// API calls (Telegram WebView UA gets HTML instead of JSON otherwise). Compiled
// out of production builds. See dev-ngrok-fetch.ts.
import "./dev-ngrok-fetch.js";

/**
 * Tiny fetch wrapper for the Mini App → bot public API.
 *
 *   GET  /v1/calendar/state — snapshot of the grid + both sides' picks
 *   POST /v1/calendar/pick  — replace this user's availability set
 *
 * Why a dedicated wrapper:
 *   - Centralises the `Authorization: tma <initData>` convention so callers
 *     can't forget the auth scheme.
 *   - Maps non-2xx responses to a typed error so the UI layer can show a
 *     meaningful alert without re-parsing JSON in two places.
 */

export interface CalendarState {
  proposedTimes: string[];
  mySlots: string[];
  peerSlots: string[];
  agreedTime: string | null;
  isFirstMover: boolean;
}

export interface PickResponse {
  ok: true;
  mySlots: string[];
  peerSlots: string[];
  agreedTime: string | null;
  /**
   * Set when the post-update intersection has more than one element.
   * The Mini App shows a "pick the final one" confirm card; the user
   * taps a slot, which re-POSTs with that single iso and collapses
   * the intersection to size 1 — auto-locking it.
   */
  overlapCandidates: string[];
  bothPicked: boolean;
}

export class CalendarApiError extends Error {
  status: number;
  reason: string | undefined;
  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

export const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export async function fetchCalendarState(
  initData: string,
  matchId: string,
): Promise<CalendarState> {
  const url = `${apiBase}/v1/calendar/state?matchId=${encodeURIComponent(matchId)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as CalendarState & { ok: true };
  return body;
}

export async function postCalendarPicks(
  initData: string,
  matchId: string,
  pickedIsos: string[],
): Promise<PickResponse> {
  const res = await fetch(`${apiBase}/v1/calendar/pick`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ matchId, pickedIsos }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as PickResponse;
}

// ---------------------------------------------------------------------------
// Location Mini App API
// ---------------------------------------------------------------------------

export interface LocationSearchHit {
  placeId?: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

export async function searchLocations(
  initData: string,
  query: string,
  bias: { lat: number; lng: number } | null,
): Promise<LocationSearchHit[]> {
  const params = new URLSearchParams({ q: query });
  if (bias) {
    params.set("lat", bias.lat.toString());
    params.set("lng", bias.lng.toString());
  }
  const res = await fetch(`${apiBase}/v1/location/search?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { ok: true; results: LocationSearchHit[] };
  return body.results;
}

export async function selectLocation(
  initData: string,
  matchId: string,
  lat: number,
  lng: number,
  address: string | null,
): Promise<void> {
  const res = await fetch(`${apiBase}/v1/location/select`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ matchId, lat, lng, address }),
  });
  if (!res.ok) throw await toError(res);
}

// ---------------------------------------------------------------------------
// Telegram Onboarding Mini App API
// ---------------------------------------------------------------------------

export type OnboardingLanguage = "en" | "ru" | "uk" | "de" | "pl";
export type TelegramOnboardingStep = "consent" | "language" | "conversational" | "completed";
export type AiMemoryExportPreference = "undecided" | "accepted" | "declined";
export type EmailVerificationStatus = "none" | "pending" | "expired" | "exhausted";

export interface EmailVerificationState {
  status: EmailVerificationStatus;
  expiresAt: string | null;
  resendAvailableAt: string | null;
  attemptsRemaining: number;
}

export interface TelegramOnboardingState {
  ok: true;
  flowToken: string;
  user: {
    onboardingStep: TelegramOnboardingStep;
    aiMemoryExportPreference: AiMemoryExportPreference;
    aiMemoryExportPreferenceAt: string | null;
    termsAccepted: boolean;
    researchOptIn: boolean;
    language: OnboardingLanguage | null;
    email: string | null;
    isEmailVerified: boolean;
    emailVerification: EmailVerificationState;
    // Registration v2 (sign-up fork). `phoneAuthEnabled` mirrors the server
    // flag so the fork renders only when the phone rail is live.
    isPhoneVerified: boolean;
    phone: string | null;
    registrationTrack: RegistrationTrack | null;
    phoneAuthEnabled: boolean;
    homeLocation: TelegramHomeLocation | null;
    completed: boolean;
  };
}

export type RegistrationTrack = "student" | "general";

export interface TelegramHomeLocation {
  homeCity: string | null;
  homeCountryCode: string | null;
  homeCityKey: string;
  homePlaceId: string | null;
  latitude: number | null;
  longitude: number | null;
  locationUpdatedAt: string | null;
}

export interface TelegramCityHit {
  label: string;
  homeCity: string;
  homeCountryCode: string;
  homeCityKey: string;
  homePlaceId: string | null;
  latitude: number;
  longitude: number;
}

export interface TelegramOnboardingCompleteResponse {
  ok: true;
  botTookOver: boolean;
  completed: boolean;
}

export async function fetchTelegramOnboardingState(
  initData: string,
  source: string | null,
): Promise<TelegramOnboardingState> {
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/state${suffix}`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TelegramOnboardingState;
}

export async function acceptTelegramOnboardingConsent(
  initData: string,
  researchOptIn: boolean,
): Promise<TelegramOnboardingState> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ termsAccepted: true, researchOptIn }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TelegramOnboardingState;
}

export async function setTelegramOnboardingTrack(
  initData: string,
  track: RegistrationTrack,
): Promise<TelegramOnboardingState> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/track`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ track }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TelegramOnboardingState;
}

export async function setTelegramOnboardingLanguage(
  initData: string,
  language: OnboardingLanguage,
): Promise<TelegramOnboardingState> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/language`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ language }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TelegramOnboardingState;
}

export async function requestTelegramOnboardingOtp(
  initData: string,
  email: string,
): Promise<{
  ok: true;
  alreadyVerified: boolean;
  emailVerification?: EmailVerificationState;
}> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/email/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as {
    ok: true;
    alreadyVerified: boolean;
    emailVerification?: EmailVerificationState;
  };
}

export async function verifyTelegramOnboardingOtp(
  initData: string,
  code: string,
): Promise<TelegramOnboardingState> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/email/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TelegramOnboardingState;
}

export async function searchTelegramOnboardingCities(
  initData: string,
  query: string,
): Promise<TelegramCityHit[]> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/city/search?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { ok: true; results: TelegramCityHit[] };
  return body.results;
}

export async function resolveTelegramOnboardingCity(
  initData: string,
  latitude: number,
  longitude: number,
): Promise<TelegramCityHit> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/city/resolve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ latitude, longitude }),
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { ok: true; city: TelegramCityHit };
  return body.city;
}

export async function selectTelegramOnboardingCity(
  initData: string,
  city: TelegramCityHit,
): Promise<TelegramOnboardingState> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/city/select`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({
      homeCity: city.homeCity,
      homeCountryCode: city.homeCountryCode,
      homeCityKey: city.homeCityKey,
      homePlaceId: city.homePlaceId,
      latitude: city.latitude,
      longitude: city.longitude,
    }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TelegramOnboardingState;
}

export async function setTelegramOnboardingAiMemoryPreference(
  initData: string,
  preference: Exclude<AiMemoryExportPreference, "undecided">,
): Promise<TelegramOnboardingState> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/ai-memory`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ preference }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TelegramOnboardingState;
}

export async function completeTelegramOnboardingGate(
  initData: string,
  flowToken: string,
): Promise<TelegramOnboardingCompleteResponse> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ completedVisualIntro: true, flowToken }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TelegramOnboardingCompleteResponse;
}

// ---------------------------------------------------------------------------
// Verification Mini App API (Phase 6.3 — Persona embedded flow)
// ---------------------------------------------------------------------------

export interface VerificationInit {
  referenceId: string;
  templateId: string;
  /** Persona env id (`env_xxxxx`) — fully encodes sandbox vs production. */
  environmentId: string;
  language: "en" | "ru" | "uk" | "de" | "pl";
}

export type VerificationEventKind = "complete" | "cancel" | "error";

export async function fetchVerificationInit(
  initData: string,
): Promise<VerificationInit> {
  const res = await fetch(`${apiBase}/v1/verification/mini-app/init`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as VerificationInit;
}

export async function postVerificationEvent(
  initData: string,
  payload: {
    kind: VerificationEventKind;
    inquiryId?: string | null;
    status?: string | null;
    message?: string | null;
  },
): Promise<void> {
  const res = await fetch(`${apiBase}/v1/verification/mini-app/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await toError(res);
}

// ---------------------------------------------------------------------------
// Date Ticket Mini App API (premium post-accept gate, mock payment)
// ---------------------------------------------------------------------------

export type TicketScope = "self" | "both" | "partner";

export interface TicketState {
  ticketStatus: "pending" | "partial" | "completed" | "refunded" | "expired";
  priceCents: number;
  myGender: "male" | "female" | null;
  mySide: "A" | "B";
  iPaid: boolean;
  partnerPaid: boolean;
  partnerName: string | null;
  partnerPaidForMe: boolean;
  /** True when I (the male) covered the partner's ticket — drives the "you
   * covered {name}'s ticket 💛" success copy (goodwill gesture, §3.5b). */
  iCoveredPartner: boolean;
  bothPaid: boolean;
  expiresAt: string | null;
  paymentMode: "mock" | "stripe";
  /** Actor's ticket-wallet balance — drives the "use a ticket" buttons. */
  myBalance: number;
  /** Active famine single-ticket discount percent (0 = none); `self` only. */
  selfDiscountPct: number;
  /** Charged price for the actor's OWN ticket after `selfDiscountPct`. */
  selfPriceCents: number;
  /** Relative proxy path to my first profile photo (null if none). Load via
   *  `ticketPhotoSrc()`, which appends auth + the API base. */
  myPhotoUrl: string | null;
  /** Relative proxy path to the partner's first profile photo (null if none). */
  partnerPhotoUrl: string | null;
}

/**
 * Build a loadable `<img>` src from a ticket photo proxy path. Appends the
 * Mini App `initData` as `?a=` (the photo endpoint can't read an Authorization
 * header from an image request) and prefixes the API base. Returns null when
 * there is no photo so callers can fall back to a monogram.
 */
export function ticketPhotoSrc(relPath: string | null, initData: string): string | null {
  if (!relPath) return null;
  return `${apiBase}${relPath}?a=${encodeURIComponent(initData)}`;
}

export interface TicketIntent {
  clientSecret: string;
  amountCents: number;
  mode: "mock" | "stripe";
}

const ticketBase = (matchId: string): string =>
  `${apiBase}/v1/matches/${encodeURIComponent(matchId)}/ticket`;

export async function fetchTicketState(
  initData: string,
  matchId: string,
): Promise<TicketState> {
  const res = await fetch(`${ticketBase(matchId)}/state`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TicketState & { ok: true };
}

export async function createTicketIntent(
  initData: string,
  matchId: string,
  scope: TicketScope,
): Promise<TicketIntent> {
  const res = await fetch(`${ticketBase(matchId)}/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify({ scope }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TicketIntent;
}

export async function confirmTicketPayment(
  initData: string,
  matchId: string,
  scope: TicketScope,
  clientSecret: string,
): Promise<TicketState> {
  const res = await fetch(`${ticketBase(matchId)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify({ scope, clientSecret }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TicketState & { ok: true };
}

/** Spend ticket(s) from the wallet to settle the gate (no payment). */
export async function useTicketFromWallet(
  initData: string,
  matchId: string,
  scope: TicketScope,
): Promise<TicketState> {
  const res = await fetch(`${ticketBase(matchId)}/use`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify({ scope }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as TicketState & { ok: true };
}

// ---------------------------------------------------------------------------
// Ticket store / wallet Mini App API (pre-purchase bundles, mock payment)
// ---------------------------------------------------------------------------

export interface WalletState {
  balance: number;
  priceCents: number;
  /** Active famine single-ticket discount percent (0 = none); "1 ticket" only. */
  discountPct: number;
  /** ISO deadline of the active discount, or null. */
  discountExpiresAt: string | null;
}

export interface StoreBundle {
  count: number;
  priceCents: number;
}

export interface StoreIntent {
  clientSecret: string;
  amountCents: number;
  count: number;
  mode: "mock" | "stripe";
}

const storeBase = `${apiBase}/v1/tickets`;

export async function fetchWalletState(initData: string): Promise<WalletState> {
  const res = await fetch(`${storeBase}/wallet`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as WalletState & { ok: true };
}

export async function createStoreIntent(
  initData: string,
  count: number,
): Promise<StoreIntent> {
  const res = await fetch(`${storeBase}/store/intent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify({ count }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as StoreIntent;
}

export async function confirmStorePurchase(
  initData: string,
  count: number,
  clientSecret: string,
): Promise<WalletState> {
  const res = await fetch(`${storeBase}/store/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify({ count, clientSecret }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as WalletState & { ok: true };
}

// ---------------------------------------------------------------------------
// Venue change Mini App API (female-exclusive one-shot swap)
// ---------------------------------------------------------------------------

export interface VenueChangeState {
  status: string;
  eligible: boolean;
  ineligibleReason: string | null;
  minCommentLength: number;
  original: { name: string | null; address: string | null; mapsUri: string | null } | null;
}

export interface VenueChangeCatalogItem {
  source: "curated" | "places";
  placeId: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  mapsUri: string | null;
  category: string;
  distanceKm: number;
  photoUrl: string | null;
  /** Google Places photo resource names → resolved via `venueChangePhotoUrl`. */
  photoRefs: string[];
  rating: number | null;
  userRatingCount: number | null;
  editorialSummary: string | null;
}

const venueChangeBase = `${apiBase}/v1/venue-change`;

/**
 * Build a server-proxied URL for a Google Places photo resource name. The proxy
 * keeps `PLACES_API_KEY` server-side; `<img>` can't send headers, so initData
 * rides the query string (HMAC-verified server-side, same as the tma header).
 */
export function venueChangePhotoUrl(
  initData: string,
  ref: string,
  width = 1000,
): string {
  const p = new URLSearchParams({ ref, w: String(width), tma: initData });
  return `${venueChangeBase}/photo?${p.toString()}`;
}

export async function fetchVenueChangeState(
  initData: string,
  matchId: string,
): Promise<VenueChangeState> {
  const res = await fetch(`${venueChangeBase}/state?match=${encodeURIComponent(matchId)}`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as VenueChangeState & { ok: true };
}

export async function fetchVenueChangeCatalog(
  initData: string,
  matchId: string,
): Promise<VenueChangeCatalogItem[]> {
  const res = await fetch(`${venueChangeBase}/catalog?match=${encodeURIComponent(matchId)}`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { ok: true; venues: VenueChangeCatalogItem[] };
  return body.venues;
}

export async function proposeVenueChange(
  initData: string,
  body: {
    matchId: string;
    placeId: string | null;
    name: string;
    address: string;
    lat: number;
    lng: number;
    mapsUri: string | null;
    comment: string;
  },
): Promise<void> {
  const res = await fetch(`${venueChangeBase}/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
}

async function toError(res: Response): Promise<CalendarApiError> {
  let reason: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; reason?: string };
    reason = body.reason ?? body.error;
  } catch {
    // empty body / non-JSON — leave reason undefined.
  }
  return new CalendarApiError(res.status, reason, `HTTP ${res.status}: ${reason ?? "unknown"}`);
}
