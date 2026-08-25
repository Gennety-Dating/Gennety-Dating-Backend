/**
 * The Living Canvas's three calls (PRODUCT_SPEC §6).
 *
 * All of them go through the shared `apiFetch`, so they carry the Mini App's
 * 20-second deadline — which matters more here than anywhere else in the app,
 * because the canvas polls: a request that never settles would otherwise pin
 * the screen on a stale state forever rather than for one interval.
 *
 * The three routes accept `tma` initData as well as a JWT (see
 * `public/canvas-auth.ts` on the bot side), so the Mini App and the native
 * client read exactly the same shapes.
 */

import { apiBase, apiFetch } from "../api.js";
import type { CanvasState, RadarReading } from "./sheet.js";

export interface DateStateVenue {
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  mapsUri: string | null;
}

export interface DateStateMatch {
  id: string;
  agreedTime: string | null;
  venue: DateStateVenue | null;
  bump: { mine: boolean; verified: boolean } | null;
}

export interface DateStateResponse {
  state: CanvasState;
  serverNow: string;
  nextDropAt: string | null;
  timeZone: string | null;
  match: DateStateMatch | null;
}

export interface BumpResponse {
  ok: true;
  verified: boolean;
  deck: { topicsForA: string[]; topicsForB: string[] } | null;
}

export interface ProximityResponse extends RadarReading {
  ok: true;
  arrived: boolean;
}

/** Refused for a reason the screen can act on, rather than a network fault. */
export class CanvasApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "CanvasApiError";
  }
}

async function toError(res: Response): Promise<CanvasApiError> {
  let code = `http-${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === "string") code = body.error;
  } catch {
    // A body that is not JSON tells us nothing the status has not already.
  }
  return new CanvasApiError(res.status, code);
}

function auth(initData: string): Record<string, string> {
  return { Authorization: `tma ${initData}` };
}

export async function fetchDateState(initData: string): Promise<DateStateResponse> {
  const res = await apiFetch(`${apiBase}/v1/date/state`, { headers: auth(initData) });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as DateStateResponse;
}

export async function postBump(
  initData: string,
  matchId: string,
  at: { lat: number; lng: number; when: Date },
): Promise<BumpResponse> {
  const res = await apiFetch(`${apiBase}/v1/dates/${matchId}/bump`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(initData) },
    // The device clock is sent deliberately: the alignment check compares the
    // two phones' own clocks, so the server cannot substitute its own — it
    // clamps ours instead when it is implausible.
    body: JSON.stringify({ lat: at.lat, lng: at.lng, at: at.when.toISOString() }),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as BumpResponse;
}

export async function postProximity(
  initData: string,
  matchId: string,
  at: { lat: number; lng: number },
): Promise<ProximityResponse> {
  const res = await apiFetch(`${apiBase}/v1/dates/${matchId}/proximity`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth(initData) },
    body: JSON.stringify(at),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as ProximityResponse;
}
