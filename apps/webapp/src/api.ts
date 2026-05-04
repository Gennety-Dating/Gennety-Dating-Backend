/**
 * Tiny fetch wrapper for the Mini App → bot public API.
 *
 * Why a dedicated wrapper:
 *   - Centralises the `Authorization: tma <initData>` convention so callers
 *     can't forget the auth scheme.
 *   - Maps non-2xx responses to a typed error so the UI layer can show a
 *     meaningful alert without re-parsing JSON in two places.
 */

interface PickResponse {
  ok: true;
  awaitingPeer: boolean;
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

export async function postCalendarPick(
  initData: string,
  matchId: string,
  pickedIso: string,
): Promise<PickResponse> {
  const res = await fetch(`${apiBase}/v1/calendar/pick`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${initData}`,
    },
    body: JSON.stringify({ matchId, pickedIso }),
  });

  if (!res.ok) {
    let reason: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; reason?: string };
      reason = body.reason ?? body.error;
    } catch {
      // empty body / non-JSON — leave reason undefined.
    }
    throw new CalendarApiError(res.status, reason, `HTTP ${res.status}: ${reason ?? "unknown"}`);
  }

  return (await res.json()) as PickResponse;
}
