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

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

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

export interface TelegramOnboardingState {
  ok: true;
  flowToken: string;
  user: {
    onboardingStep: TelegramOnboardingStep;
    termsAccepted: boolean;
    researchOptIn: boolean;
    language: OnboardingLanguage | null;
    email: string | null;
    isEmailVerified: boolean;
    completed: boolean;
  };
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
): Promise<{ ok: true; alreadyVerified: boolean }> {
  const res = await fetch(`${apiBase}/v1/telegram-onboarding/email/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as { ok: true; alreadyVerified: boolean };
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
