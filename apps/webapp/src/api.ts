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

export type VenueExperience = "conversation" | "coffee_treats" | "meal_discovery" | "walk_view" | "art_culture" | "drinks_evening" | "playful_activity" | "surprise_me";
export type VenueAmbience = "quiet" | "cozy_public" | "lively" | "design_forward" | "scenic" | "romantic_public";
export type VenueFormat = "seated" | "walking" | "interactive" | "indoor" | "outdoor";
export type VenueDietary = "vegan" | "vegetarian" | "halal" | "kosher" | "gluten_free";
export interface VenueHardConstraints {
  dietary: VenueDietary[];
  alcoholFree: boolean;
  stepFree: boolean;
  setting: "indoor" | "outdoor" | null;
  maxPrice: "free" | "inexpensive" | "moderate" | null;
  maxCommuteKm: 8 | 12;
}
export interface VenueIntentDraft {
  rawText: string;
  experiences: VenueExperience[];
  ambiences: VenueAmbience[];
  formats: VenueFormat[];
  hardConstraints: VenueHardConstraints;
  parserConfidence: number;
  state: "draft" | "confirmed";
  manualConfirmationRequired: boolean;
  origin?: { lat: number; lng: number; address: string | null } | null;
}
export interface VenueIntentTmaState {
  intent: VenueIntentDraft | null;
  status: "none" | "draft" | "confirmed";
  partnerSubmitted: boolean;
  suggestions: Array<Pick<VenueIntentDraft, "experiences" | "ambiences" | "formats">>;
  selectionError: string | null;
  mode: "off" | "shadow" | "live";
}

export async function fetchVenueIntentState(initData: string, matchId: string): Promise<VenueIntentTmaState> {
  const params = new URLSearchParams({ matchId });
  const res = await fetch(`${apiBase}/v1/location/venue-intent/state?${params}`, {
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as VenueIntentTmaState & { ok: true };
}

export async function interpretVenueIntentTma(
  initData: string,
  matchId: string,
  text: string,
  origin: { lat: number; lng: number; address: string | null },
): Promise<VenueIntentDraft> {
  const res = await fetch(`${apiBase}/v1/location/venue-intent/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify({ matchId, text, origin }),
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { ok: true; intent: VenueIntentDraft };
  return body.intent;
}

export async function confirmVenueIntentTma(
  initData: string,
  matchId: string,
  intent: Omit<VenueIntentDraft, "rawText" | "parserConfidence" | "state" | "manualConfirmationRequired"> & {
    origin: { lat: number; lng: number; address: string | null };
  },
): Promise<VenueIntentTmaState> {
  const res = await fetch(`${apiBase}/v1/location/venue-intent/confirm`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify({ matchId, intent }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as VenueIntentTmaState & { ok: true };
}

// ---------------------------------------------------------------------------
// Telegram Onboarding Mini App API
// ---------------------------------------------------------------------------

export type OnboardingLanguage = "en" | "ru" | "uk" | "de" | "pl";
export type OnboardingTheme = "light" | "dark";
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
    theme: OnboardingTheme;
    themeChosen: boolean;
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

export async function setTelegramOnboardingTheme(
  initData: string,
  theme: OnboardingTheme,
): Promise<TelegramOnboardingState> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/theme`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ theme }),
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
  ticketStatus:
    | "pending"
    | "partial"
    | "completed"
    | "refund_pending"
    | "refunded"
    | "expired";
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
  /** When true, the gate pay buttons are priced + paid in Telegram Stars via
   *  `openInvoice` (the mock USD intent/confirm path is disabled server-side). */
  starsEnabled?: boolean;
  /** Per-scope Star (XTR) prices when `starsEnabled` (null otherwise). */
  stars?: { self: number; both: number; partner: number } | null;
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

/**
 * Create a Telegram Stars (XTR) invoice link for a date-gate payment. The Mini
 * App opens the returned link with `WebApp.openInvoice()`; the gate is settled
 * server-side by the bot's `successful_payment` handler. Replaces the mock USD
 * intent/confirm flow when Stars is enabled.
 */
export async function createTicketStarsInvoice(
  initData: string,
  matchId: string,
  scope: TicketScope,
): Promise<{ link: string; stars: number }> {
  const res = await fetch(`${ticketBase(matchId)}/stars-invoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify({ scope }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as { link: string; stars: number };
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
  /** When true, the store sells bundles for Telegram Stars via `openInvoice`
   *  (the mock USD intent/confirm path is disabled server-side). */
  starsEnabled?: boolean;
  /** Star (XTR) price per bundle count (`{ "1": 350, "3": 830, "6": 1350 }`)
   *  when `starsEnabled`; null otherwise. */
  bundleStars?: Record<string, number> | null;
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

/**
 * Create a Telegram Stars (XTR) invoice link for a store bundle. The Mini App
 * opens the returned link with `WebApp.openInvoice()`; the wallet is credited
 * server-side by the bot's `successful_payment` handler.
 */
export async function createStoreStarsInvoice(
  initData: string,
  count: number,
): Promise<{ link: string; stars: number }> {
  const res = await fetch(`${storeBase}/store/stars-invoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify({ count }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as { link: string; stars: number };
}

// ---------------------------------------------------------------------------
// Venue change Mini App API (female-exclusive one-shot swap)
// ---------------------------------------------------------------------------

/** Board snapshot for the v2 multiplayer venue-change Mini App. */
export interface VenueBoardState {
  status: string; // none | liking | agreed | settled | lapsed
  open: boolean;
  closedReason: string | null;
  original: { name: string | null; address: string | null; mapsUri: string | null };
  /** Partner's first name — board captions name who picked what. */
  partnerName: string;
  myLikes: string[];
  peerLikes: string[];
  agreed: {
    key: string;
    name: string;
    address: string;
    mapsUri: string | null;
    expiresAt: string | null;
  } | null;
  myAction: "pay" | "pay_or_decline" | "pay_or_offer" | "wait" | null;
  priceStars: number | null;
  canOfferPartner: boolean;
  offerSent: boolean;
  /** The caller is viewing their OWN hidden express mint (drives express copy). */
  express: boolean;
  expressAvailable: boolean;
  settled: { name: string; address: string; mapsUri: string | null; peerPaid: boolean } | null;
  /** §Premium: either participant is premium → premium venues are selectable. */
  pairPremiumActive?: boolean;
  /** §Premium: caller has a paying action but isn't premium → show the "free with
   * Premium" counterfactual at the pay step. */
  premiumWouldWaive?: boolean;
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
  /** §Premium: "base" | "premium". Premium cards show a plate + a locked button
   * unless a participant is premium. */
  tier?: string;
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

export async function fetchVenueBoardState(
  initData: string,
  matchId: string,
): Promise<VenueBoardState> {
  const res = await fetch(`${venueChangeBase}/state?match=${encodeURIComponent(matchId)}`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as VenueBoardState & { ok: true };
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

async function venuePost(
  initData: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${venueChangeBase}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `tma ${initData}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as Record<string, unknown>;
}

/** Full like-set submission (calendar `pick` semantics). */
export async function submitVenueLikes(
  initData: string,
  matchId: string,
  keys: string[],
): Promise<{ agreed: boolean; kept: boolean; overlapCandidates: string[] }> {
  const body = await venuePost(initData, "like", { matchId, keys });
  return {
    agreed: body.agreed === true,
    kept: body.kept === true,
    overlapCandidates: Array.isArray(body.overlapCandidates)
      ? (body.overlapCandidates as string[])
      : [],
  };
}

/** Resolve a multi-overlap by picking one venue both sides liked. */
export async function confirmVenueChoice(
  initData: string,
  matchId: string,
  key: string,
): Promise<{ kept: boolean }> {
  const body = await venuePost(initData, "confirm", { matchId, key });
  return { kept: body.kept === true };
}

/** Her one-shot "offer him to pay" (sends the wish card to his chat). */
export async function offerVenuePay(initData: string, matchId: string): Promise<void> {
  await venuePost(initData, "offer-pay", { matchId });
}

/** Stay at the assigned venue: withdraw my marks, call off any agreement. */
export async function keepOriginalVenue(
  initData: string,
  matchId: string,
): Promise<{ toldPartner: boolean }> {
  const body = await venuePost(initData, "keep-original", { matchId });
  return { toldPartner: body.toldPartner === true };
}

/** His single, final "not this time" from the Mini App fork. */
export async function declineVenuePayApi(initData: string, matchId: string): Promise<void> {
  await venuePost(initData, "pay-decline", { matchId });
}

/** Mint the Stars invoice link (agreed payment or her express swap). */
export async function venueStarsInvoice(
  initData: string,
  matchId: string,
  mode: "agreed" | "express",
  key?: string,
): Promise<{ link: string; stars: number }> {
  const body = await venuePost(initData, "stars-invoice", { matchId, mode, key });
  return { link: String(body.link), stars: Number(body.stars) };
}

/**
 * §Premium: mint the recurring Telegram Stars subscription invoice from inside a
 * Mini App (opened with WebApp.openInvoice). Used by the venue-change board's
 * locked premium cards to unlock the tier in place.
 */
export async function premiumStarsInvoice(
  initData: string,
): Promise<{ link: string; stars: number }> {
  const res = await fetch(`${apiBase}/v1/premium/stars-invoice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ product: "premium" }),
  });
  if (!res.ok) throw await toError(res);
  const body = (await res.json()) as { link: string; stars: number };
  return { link: String(body.link), stars: Number(body.stars) };
}

// ---------------------------------------------------------------------------
// Type Radar Mini App API
// ---------------------------------------------------------------------------

export type RadarSet = "female" | "male";
export interface RadarDeckCard {
  photoId: string;
  set: RadarSet;
  /** Path relative to the Mini App origin: `radar/<band>/<id>.png`. */
  image: string;
}
export interface RadarChip {
  id: string;
}
export interface RadarDeck {
  ok: true;
  band: string;
  cards: RadarDeckCard[];
  chips: Partial<Record<RadarSet, { like: RadarChip[]; dislike: RadarChip[] }>>;
}
export type RadarVerdict = "like" | "dislike";
export interface RadarAnswerInput {
  photoId: string;
  verdict: RadarVerdict;
  chipId?: string | null;
}

export async function fetchRadarDeck(initData: string): Promise<RadarDeck> {
  const res = await fetch(`${apiBase}/v1/radar/deck`, {
    method: "GET",
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as RadarDeck;
}

export async function submitRadar(
  initData: string,
  answers: RadarAnswerInput[],
): Promise<{ ok: true; counted: number }> {
  const res = await fetch(`${apiBase}/v1/radar/submit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as { ok: true; counted: number };
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
