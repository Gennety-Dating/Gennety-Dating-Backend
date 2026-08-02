import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";

/**
 * The trust boundary for "Continue with Telegram".
 *
 * These tests sign REAL tokens with a throwaway key pair rather than mocking
 * `jsonwebtoken`, because the whole value of this module is that a token we
 * did not want is rejected — mocking the verifier would test nothing.
 */

const env = { TELEGRAM_LOGIN_CLIENT_ID: "8707759133" };
vi.mock("../config.js", () => ({ env }));

const { verifyTelegramIdToken, __resetTelegramLoginKeyCache } = await import(
  "./telegram-login.js"
);

const ISSUER = "https://oauth.telegram.org";
const KID = "test-key-1";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// A second, unrelated pair: what an attacker signing their own token has.
const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwks(keys: Array<{ kid: string; key: typeof publicKey }>): unknown {
  return {
    keys: keys.map(({ kid, key }) => ({
      ...key.export({ format: "jwk" }),
      kid,
      use: "sig",
      alg: "RS256",
    })),
  };
}

function sign(
  payload: Record<string, unknown>,
  options: { key?: typeof privateKey; kid?: string } = {},
): string {
  return jwt.sign(payload, options.key ?? privateKey, {
    algorithm: "RS256",
    keyid: options.kid ?? KID,
  });
}

function validPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: "8707759133",
    sub: "482533900",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...over,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetTelegramLoginKeyCache();
  env.TELEGRAM_LOGIN_CLIENT_ID = "8707759133";
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => jwks([{ kid: KID, key: publicKey }]),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyTelegramIdToken", () => {
  it("accepts a properly signed token and returns the Telegram id", async () => {
    const result = await verifyTelegramIdToken(sign(validPayload()));

    expect(result).toEqual({
      ok: true,
      identity: {
        telegramId: 482533900n,
        phone: null,
        firstName: null,
        username: null,
      },
    });
  });

  it("rejects a token signed by someone else's key", async () => {
    // The entire point of the module: a self-issued token must not be an
    // identity, even when every claim inside it looks right.
    const result = await verifyTelegramIdToken(
      sign(validPayload(), { key: foreign.privateKey }),
    );

    expect(result).toEqual({ ok: false, error: "invalid_token" });
  });

  it("rejects a token minted for a different bot", async () => {
    // Telegram signs tokens for every bot with the same keys, so the audience
    // is the only thing separating our users from another product's.
    const result = await verifyTelegramIdToken(sign(validPayload({ aud: "1111111" })));

    expect(result).toEqual({ ok: false, error: "invalid_token" });
  });

  it("rejects a token from a different issuer", async () => {
    const result = await verifyTelegramIdToken(
      sign(validPayload({ iss: "https://evil.example" })),
    );

    expect(result).toEqual({ ok: false, error: "invalid_token" });
  });

  it("rejects an expired token", async () => {
    const result = await verifyTelegramIdToken(
      sign(validPayload({ exp: Math.floor(Date.now() / 1000) - 10 })),
    );

    expect(result).toEqual({ ok: false, error: "invalid_token" });
  });

  it("rejects an unsigned (alg: none) token", async () => {
    const unsigned = jwt.sign(validPayload(), "", {
      algorithm: "none",
      keyid: KID,
    });

    const result = await verifyTelegramIdToken(unsigned);

    expect(result).toEqual({ ok: false, error: "invalid_token" });
  });

  it("takes the phone only when Telegram says it is verified", async () => {
    // `User.phone` is unique and doubles as the cross-rail login key, so an
    // unverified number would be a way to claim someone else's account.
    const unverified = await verifyTelegramIdToken(
      sign(validPayload({ phone_number: "+380972455081", phone_number_verified: false })),
    );
    expect(unverified).toMatchObject({ ok: true, identity: { phone: null } });

    const verified = await verifyTelegramIdToken(
      sign(validPayload({ phone_number: "380972455081", phone_number_verified: true })),
    );
    expect(verified).toMatchObject({ ok: true, identity: { phone: "+380972455081" } });
  });

  it("refuses a non-positive subject", async () => {
    // Negative ids are the space we mint synthetic mobile-only users into;
    // a token claiming one would collide with a real account.
    const result = await verifyTelegramIdToken(sign(validPayload({ sub: "-42" })));
    expect(result).toEqual({ ok: false, error: "invalid_token" });
  });

  it("reports keys_unavailable (not invalid) when Telegram cannot be reached", async () => {
    // A transient outage on our side must be retryable, never presented to the
    // user as "your login is invalid".
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await verifyTelegramIdToken(sign(validPayload()));

    expect(result).toEqual({ ok: false, error: "keys_unavailable" });
  });

  it("re-fetches the key set when a token names an unknown kid (rotation)", async () => {
    await verifyTelegramIdToken(sign(validPayload()));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Telegram rotated: a new kid we have never cached.
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => jwks([{ kid: "test-key-2", key: rotated.publicKey }]),
    });

    const result = await verifyTelegramIdToken(
      sign(validPayload(), { key: rotated.privateKey, kid: "test-key-2" }),
    );

    expect(result).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches the key set instead of fetching per login", async () => {
    await verifyTelegramIdToken(sign(validPayload()));
    await verifyTelegramIdToken(sign(validPayload()));
    await verifyTelegramIdToken(sign(validPayload()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to verify anything when no Client ID is configured", async () => {
    env.TELEGRAM_LOGIN_CLIENT_ID = "";

    const result = await verifyTelegramIdToken(sign(validPayload()));

    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
