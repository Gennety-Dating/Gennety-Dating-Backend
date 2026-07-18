import { readFileSync } from "node:fs";
import http2 from "node:http2";
import jwt from "jsonwebtoken";
import { env } from "../config.js";

/**
 * Direct APNs transport (token-based `.p8` auth over HTTP/2) — the push rail
 * for the native iOS app and the ONLY rail that can update Live Activities
 * (Expo cannot; the Expo SDK transport was retired with it, task 0.2 of
 * IOS_APP_ROADMAP).
 *
 * Uses `node:http2` (APNs speaks HTTP/2 exclusively — undici `fetch` does
 * not) and the already-present `jsonwebtoken` for the ES256 provider token.
 * No new dependencies.
 */

/** Apple wants provider JWTs refreshed between 20 and 60 minutes. */
const APNS_JWT_TTL_MS = 50 * 60_000;
const APNS_TIMEOUT_MS = 10_000;

export type ApnsPushType = "alert" | "liveactivity";

export interface ApnsSendOptions {
  pushType: ApnsPushType;
  /** Defaults: alert → APNS_BUNDLE_ID, liveactivity → its `.push-type.liveactivity` topic. */
  topic?: string;
  /** APNs priority; both alert and LA updates default to immediate (10). */
  priority?: 5 | 10;
}

export type ApnsSendResult =
  | { ok: true }
  | { ok: false; status: number; reason: string | null };

export function apnsConfigured(): boolean {
  return Boolean(
    env.APNS_KEY_PATH && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID,
  );
}

export function apnsHost(): string {
  return env.APNS_ENVIRONMENT === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

export function liveActivityTopic(): string {
  return `${env.APNS_BUNDLE_ID}.push-type.liveactivity`;
}

let cachedKey: string | null = null;
let cachedJwt: { token: string; mintedAt: number } | null = null;

function providerKey(): string {
  cachedKey ??= readFileSync(env.APNS_KEY_PATH, "utf8");
  return cachedKey;
}

/**
 * Mint (or reuse) the ES256 provider JWT. Cached for 50 minutes — inside
 * Apple's required 20–60 minute refresh window.
 */
export function apnsProviderJwt(now = Date.now()): string {
  if (cachedJwt && now - cachedJwt.mintedAt < APNS_JWT_TTL_MS) return cachedJwt.token;
  const token = jwt.sign({}, providerKey(), {
    algorithm: "ES256",
    issuer: env.APNS_TEAM_ID,
    keyid: env.APNS_KEY_ID,
  });
  cachedJwt = { token, mintedAt: now };
  return token;
}

/** Test hook — drops the memoized key/JWT so env changes take effect. */
export function resetApnsCachesForTest(): void {
  cachedKey = null;
  cachedJwt = null;
}

export interface AlertPushInput {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** Standard user-visible notification payload. */
export function buildAlertPayload(input: AlertPushInput): Record<string, unknown> {
  return {
    aps: {
      alert: { title: input.title, body: input.body },
      sound: "default",
    },
    ...(input.data ?? {}),
  };
}

export interface LiveActivityUpdateInput {
  event: "update" | "end";
  /** Must match the ActivityAttributes.ContentState shape on the client. */
  contentState: Record<string, unknown>;
  /** Unix seconds after which the UI shows as stale. */
  staleDate?: number;
  /** Unix seconds when an `end` event removes the activity from the lock screen. */
  dismissalDate?: number;
}

/** ActivityKit remote-update payload (`apns-push-type: liveactivity`). */
export function buildLiveActivityPayload(
  input: LiveActivityUpdateInput,
  nowMs = Date.now(),
): Record<string, unknown> {
  return {
    aps: {
      timestamp: Math.floor(nowMs / 1000),
      event: input.event,
      "content-state": input.contentState,
      ...(input.staleDate ? { "stale-date": input.staleDate } : {}),
      ...(input.dismissalDate ? { "dismissal-date": input.dismissalDate } : {}),
    },
  };
}

function http2Post(
  host: string,
  path: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(host);
    const timer = setTimeout(() => {
      session.destroy();
      reject(new Error("APNs request timed out"));
    }, APNS_TIMEOUT_MS);

    session.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    const req = session.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/json",
      ...headers,
    });

    let status = 0;
    let data = "";
    req.setEncoding("utf8");
    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
    });
    req.on("data", (chunk: string) => {
      data += chunk;
    });
    req.on("end", () => {
      clearTimeout(timer);
      session.close();
      resolve({ status, body: data });
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      session.destroy();
      reject(err);
    });
    req.end(JSON.stringify(body));
  });
}

/**
 * Deliver one notification to one device token. Never throws — transport
 * failures come back as `{ ok: false, status: 0, reason: "transport" }` so
 * callers can decide whether the token is dead (`Unregistered` etc.) or the
 * failure was transient.
 */
export async function sendApnsNotification(
  deviceToken: string,
  payload: Record<string, unknown>,
  options: ApnsSendOptions,
): Promise<ApnsSendResult> {
  if (!apnsConfigured()) {
    return { ok: false, status: 0, reason: "not_configured" };
  }
  const topic =
    options.topic ??
    (options.pushType === "liveactivity" ? liveActivityTopic() : env.APNS_BUNDLE_ID);

  try {
    const res = await http2Post(
      apnsHost(),
      `/3/device/${deviceToken}`,
      {
        authorization: `bearer ${apnsProviderJwt()}`,
        "apns-topic": topic,
        "apns-push-type": options.pushType,
        "apns-priority": String(options.priority ?? 10),
      },
      payload,
    );
    if (res.status === 200) return { ok: true };
    let reason: string | null = null;
    try {
      reason = (JSON.parse(res.body) as { reason?: string }).reason ?? null;
    } catch {
      // Non-JSON error body — keep the status code only.
    }
    return { ok: false, status: res.status, reason };
  } catch (err) {
    console.warn("[apns] send failed:", err);
    return { ok: false, status: 0, reason: "transport" };
  }
}
