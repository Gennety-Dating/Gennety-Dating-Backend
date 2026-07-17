import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "@gennety/db";
import { env } from "../config.js";

export interface AccessTokenPayload {
  sub: string; // userId (uuid)
  typ: "access";
}

export const JWT_ISSUER = "gennety-public-api";
export const JWT_AUDIENCE = "gennety-mobile";
export const JWT_SECRET_MIN_BYTES = 32;
const USER_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFRESH_TOKEN_REGEX = /^[A-Za-z0-9_-]{64}$/;

export function isStrongJwtSecret(secret: string): boolean {
  return Buffer.byteLength(secret, "utf8") >= JWT_SECRET_MIN_BYTES;
}

/**
 * M-11 defense. The bot runs in two modes:
 *   - bot-only (Telegram poller): `JWT_SECRET` is optional — local dev.
 *   - bot + public `/v1/*` API: `JWT_SECRET` is mandatory.
 *
 * `startPublicServer` already gates the listener on `env.JWT_SECRET`, but
 * `app` (the Express instance) is exported and importable. If anything ever
 * mounts a route that calls `signAccessToken` without the secret being set,
 * tokens would be signed with an empty key — accepting forged JWTs is a
 * total auth bypass.
 *
 * `assertJwtSecret()` fails LOUDLY at the call site so the bug surfaces in
 * staging instead of in prod under a real attacker.
 */
function assertJwtSecret(): string {
  if (!env.JWT_SECRET || !isStrongJwtSecret(env.JWT_SECRET)) {
    throw new Error(
      "JWT_SECRET is missing or too short — refusing to sign/verify tokens. " +
        `Set a cryptographically random JWT_SECRET (≥${JWT_SECRET_MIN_BYTES} bytes) ` +
        "before starting the public API.",
    );
  }
  return env.JWT_SECRET;
}

export function signAccessToken(userId: string): string {
  if (!USER_ID_REGEX.test(userId)) {
    throw new Error("Cannot sign an access token for an invalid user id");
  }
  const secret = assertJwtSecret();
  const options: jwt.SignOptions = {
    algorithm: "HS256",
    audience: JWT_AUDIENCE,
    issuer: JWT_ISSUER,
    expiresIn: env.JWT_ACCESS_TTL as NonNullable<jwt.SignOptions["expiresIn"]>,
  };
  return jwt.sign(
    { sub: userId, typ: "access" } satisfies AccessTokenPayload,
    secret,
    options,
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const secret = assertJwtSecret();
  const decoded = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    audience: JWT_AUDIENCE,
    issuer: JWT_ISSUER,
  });
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    (decoded as AccessTokenPayload).typ !== "access" ||
    typeof (decoded as AccessTokenPayload).sub !== "string" ||
    !USER_ID_REGEX.test((decoded as AccessTokenPayload).sub)
  ) {
    throw new Error("Invalid access token payload");
  }
  return decoded as AccessTokenPayload;
}

/**
 * Create a refresh token: returns the raw value for the client plus a
 * `UserSession` row with the SHA-256 hash. We hash (not bcrypt) because
 * refresh tokens are already high-entropy random and we hit this table on
 * every rotation — SHA-256 is constant-time and O(1).
 */
export async function createRefreshToken(userId: string, userAgent: string | null): Promise<string> {
  const raw = crypto.randomBytes(48).toString("base64url");
  const hash = hashRefreshToken(raw);

  const ttlMs = parseDurationToMs(env.JWT_REFRESH_TTL);
  const expiresAt = new Date(Date.now() + ttlMs);

  await prisma.userSession.create({
    data: {
      userId,
      refreshTokenHash: hash,
      userAgent,
      expiresAt,
    },
  });
  return raw;
}

/**
 * Rotate a refresh token. Returns `null` for invalid / expired tokens.
 *
 * **Reuse detection (C-5).** If the presented token's session is already
 * revoked, treat it as a stolen-token replay and revoke EVERY active session
 * for the user (RFC 6749 §10.4 / OAuth Best Current Practice). The legitimate
 * client will then have to re-authenticate — far better than letting an
 * attacker in possession of a leaked token mint indefinitely.
 *
 * **Atomicity.** The revoke-old + issue-new pair runs inside a single
 * `prisma.$transaction` so a failure between the two leaves no half-state
 * (previously: a crash between steps logged the user out without giving
 * them a new token).
 */
export async function rotateRefreshToken(
  rawToken: string,
  userAgent: string | null,
): Promise<{ userId: string; nextRefreshToken: string } | null> {
  // Real refresh tokens are exactly 48 random bytes encoded as base64url.
  // Reject malformed attacker input before hashing or touching PostgreSQL.
  if (!REFRESH_TOKEN_REGEX.test(rawToken)) return null;
  const hash = hashRefreshToken(rawToken);
  return prisma.$transaction(async (tx) => {
    const session = await tx.userSession.findUnique({ where: { refreshTokenHash: hash } });
    if (!session) return null;

    // Replay defense: a revoked-but-presented token means either the user
    // raced themselves (rare) OR the token leaked. Either way, hard-revoke
    // the user's entire session set so the attacker is locked out.
    if (session.revokedAt) {
      await tx.userSession.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return null;
    }

    if (session.expiresAt < new Date()) return null;

    const ttlMs = parseDurationToMs(env.JWT_REFRESH_TTL);
    const newRaw = crypto.randomBytes(48).toString("base64url");
    const newHash = hashRefreshToken(newRaw);
    const newExpiresAt = new Date(Date.now() + ttlMs);
    const revokedAt = new Date();

    // Guard the revoke with `revokedAt: null` so a concurrent rotate cannot
    // mint a second live session from the same refresh token.
    const revoked = await tx.userSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt },
    });
    if (revoked.count === 0) {
      await tx.userSession.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt },
      });
      return null;
    }

    await tx.userSession.create({
      data: {
        userId: session.userId,
        refreshTokenHash: newHash,
        userAgent,
        expiresAt: newExpiresAt,
      },
    });

    return { userId: session.userId, nextRefreshToken: newRaw };
  });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

function hashRefreshToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function parseDurationToMs(input: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(input.trim());
  if (!m) throw new Error(`Invalid duration: ${input}`);
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    default: throw new Error(`Invalid duration unit: ${m[2]}`);
  }
}

export function accessTokenTtlSeconds(): number {
  return Math.floor(parseDurationToMs(env.JWT_ACCESS_TTL) / 1000);
}
