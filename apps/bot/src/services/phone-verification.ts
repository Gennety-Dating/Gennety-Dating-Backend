import bcrypt from "bcryptjs";
import { prisma } from "@gennety/db";
import { generateOtp } from "@gennety/shared";
import { env } from "../config.js";

/**
 * Phone verification for the native mobile app (Registration v2 general
 * track). Provider fork, founder decision 2026-07-18:
 *
 *   1. PRIMARY — Telegram Gateway (gateway.telegram.org): `checkSendAbility`
 *      asks whether the number has Telegram, then `sendVerificationMessage`
 *      delivers OUR generated code as an official Telegram service message.
 *      We store the bcrypt hash and verify locally (same model as email OTP).
 *   2. FALLBACK — Twilio Verify SMS: numbers without Telegram, Gateway
 *      failures, or the client's explicit "send SMS instead" button
 *      (`forceSms`). Twilio generates and checks the code itself; we keep
 *      only the Verification SID.
 *
 * The client never sees the fork — `/v1/auth/phone/*` responds with
 * `deliveredVia: "telegram" | "sms"` for the status line.
 *
 * Anti-SMS-pumping layers: per-phone+IP express rate limit (middleware),
 * per-phone resend cooldown + daily cap here (advisory-lock serialized, same
 * pattern as `public/otp.ts`), and Gateway's own number screening before any
 * Twilio spend.
 */

export const PHONE_OTP_MAX_ATTEMPTS = 5;
export const PHONE_OTP_RESEND_COOLDOWN_MS = 60_000;
export const PHONE_OTP_TTL_MS = 10 * 60_000;
export const PHONE_OTP_DAILY_CAP = 6;
export const PHONE_CODE_LENGTH = 6;
const PROVIDER_TIMEOUT_MS = 10_000;

export type PhoneDeliveryChannel = "telegram" | "sms";

export type PhoneCodeRequestResult =
  | {
      ok: true;
      deliveredVia: PhoneDeliveryChannel;
      expiresAt: Date;
      resendAvailableAt: Date;
    }
  | { ok: false; reason: "invalid_phone" }
  | { ok: false; reason: "cooldown"; resendAvailableAt: Date }
  | { ok: false; reason: "daily_cap" }
  | { ok: false; reason: "unavailable" };

export type PhoneCodeVerifyResult =
  | { ok: true; phone: string }
  | {
      ok: false;
      reason: "invalid_phone" | "no_request" | "expired" | "exhausted" | "mismatch" | "provider_unavailable";
    };

/**
 * Normalize a raw client phone into strict E.164 (`+` + 8..15 digits, no
 * leading zero). Spaces, dashes, dots, and parentheses are tolerated; a
 * missing `+` is added. Returns null when the result isn't plausible E.164.
 */
export function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[\s\-().]/g, "");
  if (!cleaned) return null;
  const withPlus = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null;
}

// ---------------------------------------------------------------------------
// Telegram Gateway client (https://core.telegram.org/gateway/api)
// ---------------------------------------------------------------------------

interface GatewayResponse {
  ok: boolean;
  result?: { request_id?: string };
  error?: string;
}

async function gatewayCall(
  method: "checkSendAbility" | "sendVerificationMessage",
  params: Record<string, unknown>,
): Promise<GatewayResponse | null> {
  try {
    const res = await fetch(`https://gatewayapi.telegram.org/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TELEGRAM_GATEWAY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return (await res.json()) as GatewayResponse;
  } catch (err) {
    console.warn(`[phone-verification] gateway ${method} failed:`, err);
    return null;
  }
}

/**
 * Try to deliver `code` via Telegram. Returns the Gateway request id on
 * success, null on "can't deliver" (no Telegram on that number, config
 * missing, API/timeout failure) — the caller falls through to SMS.
 */
async function sendViaTelegramGateway(phone: string, code: string): Promise<string | null> {
  if (!env.TELEGRAM_GATEWAY_TOKEN) return null;

  // checkSendAbility screens undeliverable numbers for a fraction of the send
  // price, and its request_id makes the follow-up send bill as one request.
  const ability = await gatewayCall("checkSendAbility", { phone_number: phone });
  if (!ability?.ok) return null;

  const sent = await gatewayCall("sendVerificationMessage", {
    phone_number: phone,
    ...(ability.result?.request_id ? { request_id: ability.result.request_id } : {}),
    code,
    ttl: Math.floor(PHONE_OTP_TTL_MS / 1000),
  });
  if (!sent?.ok) return null;
  return sent.result?.request_id ?? ability.result?.request_id ?? "gateway";
}

// ---------------------------------------------------------------------------
// Twilio Verify client (https://www.twilio.com/docs/verify/api)
// ---------------------------------------------------------------------------

function twilioConfigured(): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SERVICE_SID,
  );
}

function twilioAuthHeader(): string {
  const raw = `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function twilioStartVerification(phone: string): Promise<string | null> {
  if (!twilioConfigured()) return null;
  try {
    const res = await fetch(
      `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/Verifications`,
      {
        method: "POST",
        headers: {
          Authorization: twilioAuthHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: phone, Channel: "sms" }).toString(),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      console.warn(`[phone-verification] twilio start returned ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { sid?: string };
    return body.sid ?? null;
  } catch (err) {
    console.warn("[phone-verification] twilio start failed:", err);
    return null;
  }
}

async function twilioCheckVerification(
  phone: string,
  code: string,
): Promise<"approved" | "rejected" | "unavailable"> {
  if (!twilioConfigured()) return "unavailable";
  try {
    const res = await fetch(
      `https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`,
      {
        method: "POST",
        headers: {
          Authorization: twilioAuthHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: phone, Code: code }).toString(),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    // Twilio answers 404 when the verification was already
    // approved/expired/canceled — treat as a plain mismatch-style failure.
    if (res.status === 404) return "rejected";
    if (!res.ok) {
      console.warn(`[phone-verification] twilio check returned ${res.status}`);
      return "unavailable";
    }
    const body = (await res.json()) as { status?: string };
    return body.status === "approved" ? "approved" : "rejected";
  } catch (err) {
    console.warn("[phone-verification] twilio check failed:", err);
    return "unavailable";
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Create and deliver a phone code. Serialized per phone via a
 * transaction-scoped advisory lock (same rationale as `createAndSendOtp` in
 * `public/otp.ts`): concurrent requests cannot bypass the cooldown or send
 * competing codes. Delivery runs inside the bounded transaction so a failed
 * send rolls the challenge row back.
 */
export async function requestPhoneCode(
  rawPhone: string,
  options: { forceSms?: boolean } = {},
): Promise<PhoneCodeRequestResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, reason: "invalid_phone" };

  return prisma.$transaction(
    async (tx) => {
      // $executeRawUnsafe, not $queryRawUnsafe: pg_advisory_xact_lock returns
      // `void`, which Prisma 6.19+ refuses to deserialize (P2010) — caught
      // live on the first prod probe of this endpoint.
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        `phone-otp:${phone}`,
      );
      const now = new Date();

      const existing = await tx.phoneOtp.findFirst({
        where: { phone, consumedAt: null },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, expiresAt: true, attempts: true },
      });
      if (
        existing &&
        existing.expiresAt > now &&
        existing.attempts < PHONE_OTP_MAX_ATTEMPTS &&
        now.getTime() - existing.createdAt.getTime() < PHONE_OTP_RESEND_COOLDOWN_MS
      ) {
        return {
          ok: false as const,
          reason: "cooldown" as const,
          resendAvailableAt: new Date(
            existing.createdAt.getTime() + PHONE_OTP_RESEND_COOLDOWN_MS,
          ),
        };
      }

      // Daily cap per phone — the durable anti-pumping backstop behind the
      // in-memory express limiter (which resets on restart).
      const sentToday = await tx.phoneOtp.count({
        where: { phone, createdAt: { gt: new Date(now.getTime() - 24 * 3_600_000) } },
      });
      if (sentToday >= PHONE_OTP_DAILY_CAP) {
        return { ok: false as const, reason: "daily_cap" as const };
      }

      const expiresAt = new Date(now.getTime() + PHONE_OTP_TTL_MS);

      // Rail 1: Telegram Gateway with our own code, unless SMS was forced.
      if (!options.forceSms) {
        const code = generateOtp(PHONE_CODE_LENGTH);
        const requestId = await sendViaTelegramGateway(phone, code);
        if (requestId) {
          const codeHash = await bcrypt.hash(code, 10);
          const row = await tx.phoneOtp.create({
            data: {
              phone,
              provider: "telegram_gateway",
              codeHash,
              providerRequestId: requestId,
              expiresAt,
            },
          });
          return {
            ok: true as const,
            deliveredVia: "telegram" as const,
            expiresAt,
            resendAvailableAt: new Date(
              row.createdAt.getTime() + PHONE_OTP_RESEND_COOLDOWN_MS,
            ),
          };
        }
      }

      // Rail 2: Twilio Verify SMS.
      const sid = await twilioStartVerification(phone);
      if (sid) {
        const row = await tx.phoneOtp.create({
          data: {
            phone,
            provider: "twilio_verify",
            providerRequestId: sid,
            expiresAt,
          },
        });
        return {
          ok: true as const,
          deliveredVia: "sms" as const,
          expiresAt,
          resendAvailableAt: new Date(
            row.createdAt.getTime() + PHONE_OTP_RESEND_COOLDOWN_MS,
          ),
        };
      }

      return { ok: false as const, reason: "unavailable" as const };
    },
    { timeout: 30_000 },
  );
}

/**
 * Validate a code against the latest unconsumed challenge for this phone.
 * Consumes the row on success; increments `attempts` on mismatch (both via
 * guarded `updateMany` CAS, mirroring the email OTP state machine).
 */
export async function verifyPhoneCode(
  rawPhone: string,
  code: string,
): Promise<PhoneCodeVerifyResult> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return { ok: false, reason: "invalid_phone" };

  const now = new Date();
  const latest = await prisma.phoneOtp.findFirst({
    where: { phone, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!latest) return { ok: false, reason: "no_request" };
  if (latest.expiresAt < now) return { ok: false, reason: "expired" };
  if (latest.attempts >= PHONE_OTP_MAX_ATTEMPTS) return { ok: false, reason: "exhausted" };

  let matched: boolean;
  if (latest.provider === "telegram_gateway") {
    matched = latest.codeHash ? await bcrypt.compare(code, latest.codeHash) : false;
  } else {
    const check = await twilioCheckVerification(phone, code);
    if (check === "unavailable") return { ok: false, reason: "provider_unavailable" };
    matched = check === "approved";
  }

  if (!matched) {
    await prisma.phoneOtp.updateMany({
      where: {
        id: latest.id,
        consumedAt: null,
        attempts: { lt: PHONE_OTP_MAX_ATTEMPTS },
        expiresAt: { gt: now },
      },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, reason: "mismatch" };
  }

  const consumed = await prisma.phoneOtp.updateMany({
    where: {
      id: latest.id,
      consumedAt: null,
      attempts: { lt: PHONE_OTP_MAX_ATTEMPTS },
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (consumed.count === 0) return { ok: false, reason: "no_request" };
  return { ok: true, phone };
}
