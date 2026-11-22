import { readResponseBuffer } from "./bounded-response.js";

/**
 * Why Google Places refused a request, in Google's own words.
 *
 * A bare status says almost nothing here: a 403 is a quota, an unpaid bill, a
 * key restriction and a disabled API alike, and which of them it is decides
 * whether the fix is money, a console setting or code. From 2026-11-02 the key
 * was refused on every call for three weeks and the log held 22 000 lines of
 * "HTTP 403" with the answer thrown away in each.
 */

const ERROR_BODY_MAX_BYTES = 16 * 1024;
const MESSAGE_MAX_CHARS = 160;

export interface PlacesErrorBody {
  /** Canonical status, e.g. `PERMISSION_DENIED`. */
  status: string | null;
  /** `ErrorInfo.reason`, e.g. `API_KEY_SERVICE_BLOCKED` — absent on some refusals. */
  reason: string | null;
  message: string | null;
}

const EMPTY: PlacesErrorBody = { status: null, reason: null, message: null };

/** Keys and project numbers may be quoted back in a refusal; neither belongs in a log. */
function scrub(text: string): string {
  return text
    .replace(/AIza[\w-]+/g, "<key>")
    .replace(/\b\d{9,}\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MESSAGE_MAX_CHARS);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? scrub(value) : null;
}

/**
 * Read the error body of a non-OK response. Consumes it. Never throws: a body
 * that is not Google's JSON (a CDN page, an empty one, one that died) is simply
 * a refusal without words.
 */
export async function readPlacesError(res: Response): Promise<PlacesErrorBody> {
  try {
    const raw = await readResponseBuffer(res, ERROR_BODY_MAX_BYTES);
    const body = JSON.parse(raw.toString("utf8")) as {
      error?: { status?: unknown; message?: unknown; details?: unknown };
    } | null;
    const error = body?.error;
    if (!error) return EMPTY;
    const details = Array.isArray(error.details) ? (error.details as Array<{ reason?: unknown } | null>) : [];
    return {
      status: text(error.status),
      reason: text(details.find((d) => typeof d?.reason === "string")?.reason),
      message: text(error.message),
    };
  } catch {
    return EMPTY;
  }
}

/** `403 PERMISSION_DENIED API_KEY_SERVICE_BLOCKED: Requests to this API…` — or just `403`. */
export function formatPlacesError(httpStatus: number, body: PlacesErrorBody): string {
  const head = [String(httpStatus), body.status, body.reason].filter(Boolean).join(" ");
  return body.message ? `${head}: ${body.message}` : head;
}
