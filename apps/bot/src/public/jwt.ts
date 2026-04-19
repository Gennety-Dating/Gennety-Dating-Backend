import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { prisma } from "@gennety/db";
import { env } from "../config.js";

export interface AccessTokenPayload {
  sub: string; // userId (uuid)
  typ: "access";
}

export function signAccessToken(userId: string): string {
  const options = { expiresIn: env.JWT_ACCESS_TTL } as jwt.SignOptions;
  return jwt.sign(
    { sub: userId, typ: "access" } satisfies AccessTokenPayload,
    env.JWT_SECRET,
    options,
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    (decoded as AccessTokenPayload).typ !== "access" ||
    typeof (decoded as AccessTokenPayload).sub !== "string"
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
 * Rotate a refresh token: validate, revoke the old session, mint a new one.
 * Returns `null` if the token is invalid, expired, or already revoked.
 */
export async function rotateRefreshToken(
  rawToken: string,
  userAgent: string | null,
): Promise<{ userId: string; nextRefreshToken: string } | null> {
  const hash = hashRefreshToken(rawToken);
  const session = await prisma.userSession.findUnique({ where: { refreshTokenHash: hash } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

  // Rotate: revoke the presented token, issue a fresh one atomically enough.
  await prisma.userSession.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });
  const next = await createRefreshToken(session.userId, userAgent);
  return { userId: session.userId, nextRefreshToken: next };
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
