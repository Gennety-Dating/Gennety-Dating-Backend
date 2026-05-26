import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

/**
 * Persona (withpersona.com) hosted-flow integration.
 *
 * Two responsibilities:
 *   1. Build the hosted-flow URL that the bot and mobile app open so the user
 *      can complete liveness + ID-document verification.
 *   2. Verify the HMAC signature on incoming webhooks so we never trust a
 *      forged `inquiry.completed` event.
 *
 * Design note: the hosted flow doesn't require a server-minted token — the
 * URL is fully constructed from template-id + environment-id + reference-id
 * and is safe to expose client-side. Webhooks are the only trust boundary.
 */

/** Persona sets this header on every webhook — `Persona-Signature: t=<ts>,v1=<hex>`. */
export const PERSONA_SIGNATURE_HEADER = "persona-signature";
/** Reject signatures older than this (prevents replay if the secret is exposed). */
export const WEBHOOK_MAX_AGE_SECONDS = 5 * 60;

export type PersonaInquiryStatus =
  | "created"
  | "pending"
  | "completed"
  | "approved"
  | "declined"
  | "expired"
  | "failed"
  | "needs_review";

export interface PersonaWebhookPayload {
  data: {
    type: "event";
    id: string;
    attributes: {
      name: string; // e.g. "inquiry.completed"
      payload: {
        data: {
          type: "inquiry";
          id: string; // "inq_…"
          attributes: {
            status: PersonaInquiryStatus;
            // Persona's hosted-flow API actually emits this field as camelCase
            // (`referenceId`) in webhook payloads, despite older docs (and
            // earlier versions of this code) referencing the kebab-case form
            // `reference-id`. We accept both for robustness — never seen them
            // sent simultaneously, but if Persona ever flips back the handler
            // won't break.
            referenceId?: string | null;
            "reference-id"?: string | null;
          };
        };
      };
    };
  };
}

/**
 * Build the Persona hosted-flow URL for a given user.
 *
 * `referenceId` is echoed back verbatim on every webhook as
 * `data.attributes.payload.data.attributes.reference-id` — we use it to
 * resolve the inquiry to our DB user row. Conventionally our `User.id`.
 *
 * When `BOT_USERNAME` is set we also pass
 * `redirect-uri=https://t.me/<bot>?start=verify_done` so Persona's "you're
 * done" page bounces the user back to the bot chat AND triggers a
 * `/start verify_done` deep-link payload that the bot uses to auto-poll
 * the verification status (`services/verification-poller.ts`). Without
 * the `?start=…` part the user would land in the chat with nothing
 * happening, having to scroll to the original CTA and tap "I'm done"
 * manually.
 *
 * The DB-side activation still happens via the webhook path — the
 * redirect + auto-poll are purely UX so users don't have to babysit
 * verification.
 */
export function buildPersonaHostedUrl(referenceId: string): string {
  if (!env.PERSONA_TEMPLATE_ID || !env.PERSONA_ENVIRONMENT_ID) {
    throw new Error("Persona not configured");
  }
  const params = new URLSearchParams({
    "inquiry-template-id": env.PERSONA_TEMPLATE_ID,
    "environment-id": env.PERSONA_ENVIRONMENT_ID,
    "reference-id": referenceId,
  });
  if (env.BOT_USERNAME) {
    params.set("redirect-uri", `https://t.me/${env.BOT_USERNAME}?start=verify_done`);
  }
  return `${env.PERSONA_HOSTED_URL_BASE}?${params.toString()}`;
}

/**
 * Parse the `Persona-Signature: t=<ts>,v1=<hex>[,v1=<hex>,...]` header.
 * Persona may include multiple `v1=` entries during secret rotation — accept
 * the header as long as one of them matches.
 */
export function parsePersonaSignatureHeader(
  header: string | undefined,
): { ts: string; digests: string[] } | null {
  if (!header) return null;
  const parts = header.split(",").map((p) => p.trim());
  let ts: string | null = null;
  const digests: string[] = [];
  for (const part of parts) {
    const [k, v] = part.split("=", 2);
    if (!k || !v) continue;
    if (k === "t") ts = v;
    else if (k === "v1") digests.push(v);
  }
  if (!ts || digests.length === 0) return null;
  return { ts, digests };
}

/**
 * Verify a Persona webhook signature. Returns `true` only when the header is
 * well-formed, the timestamp is fresh, and a constant-time HMAC compare matches
 * at least one of the digests.
 *
 * The `rawBody` MUST be the exact bytes received — re-serialising a parsed
 * JSON body would change key order / whitespace and break the signature.
 */
export function verifyPersonaWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret) return false;
  const parsed = parsePersonaSignatureHeader(signatureHeader);
  if (!parsed) return false;
  const { ts, digests } = parsed;

  // Replay guard: reject stale signatures. An attacker who captured an old
  // webhook + secret shouldn't be able to replay it weeks later.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(nowSeconds - tsNum) > WEBHOOK_MAX_AGE_SECONDS) return false;

  // Persona's signed payload is `${timestamp}.${rawBody}`.
  const expected = createHmac("sha256", secret)
    .update(`${ts}.`)
    .update(rawBody)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");

  for (const digest of digests) {
    if (digest.length !== expected.length) continue;
    const candidateBuf = Buffer.from(digest, "utf8");
    if (timingSafeEqual(expectedBuf, candidateBuf)) return true;
  }
  return false;
}

/** Map a Persona inquiry status to our internal `verificationStatus` enum. */
export function mapPersonaStatusToInternal(
  status: PersonaInquiryStatus,
): "verified" | "rejected" | "pending" {
  switch (status) {
    case "approved":
    case "completed":
      return "verified";
    case "declined":
    case "failed":
    case "expired":
      return "rejected";
    default:
      return "pending";
  }
}

/**
 * Event names we trust to drive a `verificationStatus` write.
 *
 * Persona emits dozens of `inquiry.*` events through the lifecycle
 * (`inquiry.created`, `inquiry.started`, `inquiry.transitioned`, …).
 * Some carry a `status: "approved"` payload purely as state metadata
 * — they do NOT mean the user just got approved. Treating any event
 * as authoritative would let a `created` event activate a user before
 * they've even started the flow.
 *
 * The allowlist below contains only the terminal-decision events.
 * Pre-fix the handler trusted any event name; this is the M-9 patch.
 */
export const TRUSTED_PERSONA_EVENT_NAMES = new Set([
  "inquiry.completed",
  "inquiry.approved",
  "inquiry.declined",
  "inquiry.failed",
  "inquiry.expired",
  "inquiry.marked-for-review",
]);

/** Returns true if the webhook event is a terminal-decision event we trust. */
export function isTrustedPersonaEvent(eventName: string | undefined): boolean {
  if (!eventName) return false;
  return TRUSTED_PERSONA_EVENT_NAMES.has(eventName);
}
