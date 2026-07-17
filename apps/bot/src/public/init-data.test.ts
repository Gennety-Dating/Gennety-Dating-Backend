import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { validateInitData } from "./init-data.js";

const BOT_TOKEN = "123456:ABCDEFG-test-bot-token";

/**
 * Build a syntactically-valid initData string signed with `BOT_TOKEN`.
 * Mirrors the official algorithm so tests don't depend on a real Telegram
 * client. `overrides` lets tests tweak fields after signing (e.g. corrupt
 * the hash, age out auth_date) to exercise failure paths.
 */
function buildInitData(
  overrides: Partial<{
    user: Record<string, unknown>;
    authDate: number;
    queryId: string;
    badHash: boolean;
    signature: string;
  }> = {},
): string {
  const authDate = overrides.authDate ?? Math.floor(Date.now() / 1000);
  const userObj = overrides.user ?? {
    id: 5986970093,
    first_name: "Test",
    username: "testuser",
  };
  const params = new URLSearchParams();
  params.set("auth_date", String(authDate));
  params.set("query_id", overrides.queryId ?? "AAH123abcDEF");
  params.set("user", JSON.stringify(userObj));

  const sortedKeys = [...params.keys()].sort();
  const dataCheckString = sortedKeys.map((k) => `${k}=${params.get(k)}`).join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const badHash = hash.startsWith("0") ? `1${hash.slice(1)}` : `0${hash.slice(1)}`;
  params.set("hash", overrides.badHash ? badHash : hash);
  if (overrides.signature) params.set("signature", overrides.signature);
  return params.toString();
}

describe("validateInitData", () => {
  it("accepts a freshly-signed initData and parses the user", () => {
    const initData = buildInitData();
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.user.id).toBe(5986970093);
      expect(result.user.first_name).toBe("Test");
      expect(result.user.username).toBe("testuser");
    }
  });

  it("accepts Bot API 8.0+ initData with a separate Ed25519 signature field (hash excludes signature)", () => {
    const initData = buildInitData({ signature: "fake-ed25519-signature" });
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result.valid).toBe(true);
  });

  it("accepts Bot API 8.0+ initData whose hash INCLUDES the signature field (real iOS 9.6 behavior)", () => {
    // Real iOS clients compute `hash` over a data-check-string that includes the
    // `signature` field. Build that variant by hand and assert it validates.
    const params = new URLSearchParams();
    params.set("auth_date", String(Math.floor(Date.now() / 1000)));
    params.set("query_id", "AAH123abcDEF");
    params.set("user", JSON.stringify({ id: 5986970093, first_name: "Test", username: "testuser" }));
    params.set("signature", "real-ed25519-signature");
    const sortedKeys = [...params.keys()].sort();
    const dataCheckString = sortedKeys.map((k) => `${k}=${params.get(k)}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    params.set("hash", hash);

    const result = validateInitData(params.toString(), BOT_TOKEN);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.user.id).toBe(5986970093);
  });

  it("rejects when the hash is tampered with", () => {
    const initData = buildInitData({ badHash: true });
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result).toEqual({ valid: false, reason: "bad-hash" });
  });

  it("rejects when initData was signed by a different bot token", () => {
    const initData = buildInitData();
    const result = validateInitData(initData, "999:OTHER-token");
    expect(result).toEqual({ valid: false, reason: "bad-hash" });
  });

  it("rejects when `hash` is missing entirely", () => {
    const initData = buildInitData();
    const params = new URLSearchParams(initData);
    params.delete("hash");
    const result = validateInitData(params.toString(), BOT_TOKEN);
    expect(result).toEqual({ valid: false, reason: "missing-hash" });
  });

  it("rejects when auth_date is older than the max age", () => {
    const tenHoursAgo = Math.floor(Date.now() / 1000) - 36000;
    const initData = buildInitData({ authDate: tenHoursAgo });
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("accepts when auth_date is within the max age window", () => {
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const initData = buildInitData({ authDate: oneHourAgo });
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result.valid).toBe(true);
  });

  it("rejects a correctly signed auth_date too far in the future", () => {
    const tenMinutesFromNow = Math.floor(Date.now() / 1000) + 600;
    const initData = buildInitData({ authDate: tenMinutesFromNow });
    expect(validateInitData(initData, BOT_TOKEN)).toEqual({
      valid: false,
      reason: "future-auth-date",
    });
  });

  it("allows small client/server clock skew", () => {
    const thirtySecondsFromNow = Math.floor(Date.now() / 1000) + 30;
    expect(validateInitData(buildInitData({ authDate: thirtySecondsFromNow }), BOT_TOKEN).valid).toBe(
      true,
    );
  });

  it("rejects when auth_date is missing", () => {
    // Sign without auth_date by hand — `buildInitData` always adds one.
    const params = new URLSearchParams();
    params.set("query_id", "AAH123");
    params.set("user", JSON.stringify({ id: 1 }));
    const sorted = [...params.keys()].sort();
    const dcs = sorted.map((k) => `${k}=${params.get(k)}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const hash = crypto.createHmac("sha256", secretKey).update(dcs).digest("hex");
    params.set("hash", hash);
    const result = validateInitData(params.toString(), BOT_TOKEN);
    expect(result).toEqual({ valid: false, reason: "missing-auth-date" });
  });

  it("rejects when the user JSON is malformed", () => {
    // Sign with a non-JSON `user` value so the hash is valid but parsing fails.
    const params = new URLSearchParams();
    params.set("auth_date", String(Math.floor(Date.now() / 1000)));
    params.set("query_id", "AAH");
    params.set("user", "{not json");
    const sorted = [...params.keys()].sort();
    const dcs = sorted.map((k) => `${k}=${params.get(k)}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const hash = crypto.createHmac("sha256", secretKey).update(dcs).digest("hex");
    params.set("hash", hash);
    const result = validateInitData(params.toString(), BOT_TOKEN);
    expect(result).toEqual({ valid: false, reason: "malformed-user" });
  });

  it("rejects when user has no numeric id", () => {
    const initData = buildInitData({
      user: { id: "not-a-number" } as unknown as Record<string, unknown>,
    });
    const result = validateInitData(initData, BOT_TOKEN);
    expect(result).toEqual({ valid: false, reason: "malformed-user" });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid numeric Telegram user id (%s)",
    (id) => {
      const initData = buildInitData({ user: { id } });
      expect(validateInitData(initData, BOT_TOKEN)).toEqual({
        valid: false,
        reason: "malformed-user",
      });
    },
  );

  it("rejects when the hash field is the wrong length (e.g. truncated)", () => {
    const initData = buildInitData();
    const params = new URLSearchParams(initData);
    params.set("hash", "short");
    const result = validateInitData(params.toString(), BOT_TOKEN);
    expect(result).toEqual({ valid: false, reason: "bad-hash" });
  });

  it("uses the injected `now` so freshness checks are deterministic", () => {
    const authDate = 1_700_000_000;
    const initData = buildInitData({ authDate });
    // 30 minutes later → still fresh
    const fresh = validateInitData(initData, BOT_TOKEN, 7200, new Date((authDate + 1800) * 1000));
    expect(fresh.valid).toBe(true);
    // 3 hours later → expired
    const expired = validateInitData(initData, BOT_TOKEN, 7200, new Date((authDate + 10800) * 1000));
    expect(expired).toEqual({ valid: false, reason: "expired" });
  });
});
