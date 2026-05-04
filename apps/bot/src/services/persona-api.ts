import { env } from "../config.js";

/**
 * Persona REST API client (server-to-server).
 *
 * Counterpart to `services/persona.ts`, which only handles the hosted-flow
 * URL builder + webhook signature verification (no API calls). This module
 * is for the *post-webhook* path: when an `inquiry.approved` event lands,
 * we re-read the inquiry to fetch the verified selfie that Persona
 * captured during the liveness flow, and hand the bytes to
 * `services/face-match.ts` for comparison against profile photos.
 *
 * Persona API docs: https://docs.withpersona.com/reference/get-an-inquiry
 *
 * Auth: `Authorization: Bearer ${PERSONA_API_KEY}`. The API key MUST belong
 * to the same environment (sandbox vs prod) as `PERSONA_ENVIRONMENT_ID` —
 * cross-environment calls 401.
 */

const PERSONA_API_BASE = "https://api.withpersona.com/api/v1";
/**
 * Pinned Persona-Version header. Persona's API is versioned by date; pinning
 * ensures schema drift in their selfie verification payload doesn't silently
 * change the field names we rely on. Bump deliberately when we audit new
 * fields.
 */
const PERSONA_API_VERSION = "2023-01-05";
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Successful selfie fetch — raw image bytes ready to hand to Rekognition,
 * plus the Persona verification id we pulled them from (recorded in DB
 * alongside the score so the admin dashboard can deep-link back to the
 * Persona inquiry on appeal).
 */
export interface PersonaSelfie {
  buffer: Buffer;
  mime: string;
  /** Persona `verification/selfie` id, e.g. `ver_xxx`. */
  verificationId: string;
}

/**
 * Discriminated result for `fetchInquirySelfie`. Mirrors the shape used by
 * `face-match.ts` so the verification pipeline can branch on `ok` uniformly.
 *
 * `not_configured` — env var missing, treat as a soft failure (manual review).
 * `inquiry_not_found` — Persona returned 404 (typo in `inquiryId` or wrong env).
 * `no_selfie` — inquiry has no selfie verification (template misconfigured).
 * `download_failed` — the signed S3 URL didn't return 200 (TTL expired,
 *                     transient outage).
 * `api` / `timeout` — Persona REST call itself failed.
 */
export type FetchSelfieResult =
  | { ok: true; selfie: PersonaSelfie }
  | {
      ok: false;
      error:
        | "not_configured"
        | "inquiry_not_found"
        | "no_selfie"
        | "download_failed"
        | "api"
        | "timeout";
    };

/**
 * JSON:API shape Persona returns for `GET /inquiries/{id}?include=verifications`.
 * We type only the fields we actually read — the rest are passed through as
 * `unknown` so a Persona-side schema addition doesn't break the parse.
 */
interface PersonaInquiryResponse {
  data: {
    type: "inquiry";
    id: string;
    attributes: { status: string };
    relationships?: unknown;
  };
  included?: Array<{
    type: string;
    id: string;
    attributes: Record<string, unknown>;
  }>;
}

export interface FetchInquirySelfieOptions {
  /** Override timeout for both the inquiry fetch and the photo download. */
  timeoutMs?: number;
  /** Injectable fetch — used by tests. */
  fetchFn?: typeof fetch;
  /** Override the API key. Defaults to `env.PERSONA_API_KEY`. */
  apiKey?: string;
}

/**
 * Fetch the verified selfie photo from a Persona inquiry.
 *
 * Flow:
 *   1. `GET /inquiries/{id}?include=verifications` → JSON with included
 *      verification objects.
 *   2. Locate the `verification/selfie` (or `verification/selfie-v2`) entry.
 *      Prefer the `centered-photo-url` over left/right poses for the best
 *      frontal alignment with profile photos.
 *   3. Download the signed photo URL → return raw bytes + mime.
 *
 * Persona signs photo URLs for ~60 minutes; we download immediately on the
 * webhook fast-path so we never have to refresh.
 */
export async function fetchInquirySelfie(
  inquiryId: string,
  options: FetchInquirySelfieOptions = {},
): Promise<FetchSelfieResult> {
  const apiKey = options.apiKey ?? env.PERSONA_API_KEY;
  if (!apiKey) return { ok: false, error: "not_configured" };

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let inquiry: PersonaInquiryResponse;
  try {
    const url = `${PERSONA_API_BASE}/inquiries/${encodeURIComponent(inquiryId)}?include=verifications`;
    const res = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Persona-Version": PERSONA_API_VERSION,
      },
      signal: controller.signal,
    });

    if (res.status === 404) {
      clearTimeout(timer);
      return { ok: false, error: "inquiry_not_found" };
    }
    if (!res.ok) {
      clearTimeout(timer);
      return { ok: false, error: "api" };
    }

    inquiry = (await res.json()) as PersonaInquiryResponse;
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "api" };
  }

  // Pull the selfie verification out of the included array. Persona has
  // emitted both `verification/selfie` and `verification/selfie-v2` over
  // time — we accept either. Newer accounts get `-v2` by default.
  const selfieVerification = (inquiry.included ?? []).find(
    (v) => v.type === "verification/selfie" || v.type === "verification/selfie-v2",
  );
  if (!selfieVerification) {
    clearTimeout(timer);
    return { ok: false, error: "no_selfie" };
  }

  // Field name varies slightly across Persona API versions. Try the most
  // common fields in priority order: centered (front-facing, best for
  // matching) → left → right → photo-url.
  const photoUrl = pickFirstString(selfieVerification.attributes, [
    "centered-photo-url",
    "photo-url",
    "left-photo-url",
    "right-photo-url",
  ]);
  if (!photoUrl) {
    clearTimeout(timer);
    return { ok: false, error: "no_selfie" };
  }

  // Download the photo bytes. The URL is a short-lived signed S3 URL — no
  // auth header needed (and adding one would actually break the signature).
  try {
    const photoRes = await fetchFn(photoUrl, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!photoRes.ok) return { ok: false, error: "download_failed" };

    const arrayBuf = await photoRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const mime = photoRes.headers.get("content-type") ?? "image/jpeg";

    return {
      ok: true,
      selfie: {
        buffer,
        mime,
        verificationId: selfieVerification.id,
      },
    };
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "download_failed" };
  }
}

/**
 * Defensive accessor — Persona may return a key with `null` or non-string
 * value during partial completes. Returns the first key whose value is a
 * non-empty string.
 */
function pickFirstString(
  attrs: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
