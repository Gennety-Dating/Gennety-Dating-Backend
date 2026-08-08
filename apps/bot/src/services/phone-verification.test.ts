import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const phoneOtpCreate = vi.fn();
const phoneOtpFindFirst = vi.fn();
const phoneOtpUpdateMany = vi.fn();
const phoneOtpCount = vi.fn();
const queryRawUnsafe = vi.fn();

const prismaMock = {
  phoneOtp: {
    create: phoneOtpCreate,
    findFirst: phoneOtpFindFirst,
    updateMany: phoneOtpUpdateMany,
    count: phoneOtpCount,
  },
  $executeRawUnsafe: queryRawUnsafe,
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(prismaMock)),
};

vi.mock("@gennety/db", () => ({
  prisma: prismaMock,
}));

const envMock = {
  PHONE_CODE_PRIMARY_PROVIDER: "twilio",
  TELEGRAM_GATEWAY_TOKEN: "gw-token",
  TWILIO_ACCOUNT_SID: "AC123",
  TWILIO_AUTH_TOKEN: "tw-secret",
  TWILIO_VERIFY_SERVICE_SID: "VA123",
  OTP_LOG_TO_CONSOLE: false,
};

vi.mock("../config.js", () => ({ env: envMock }));

const {
  normalizePhone,
  requestPhoneCode,
  verifyPhoneCode,
  PHONE_OTP_DAILY_CAP,
  PHONE_OTP_MAX_ATTEMPTS,
} = await import("./phone-verification.js");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Route provider calls by URL: gateway methods + twilio start/check. */
function stubProviders(handlers: {
  checkSendAbility?: () => Response | Promise<Response>;
  sendVerificationMessage?: () => Response | Promise<Response>;
  twilioStart?: () => Response | Promise<Response>;
  twilioCheck?: () => Response | Promise<Response>;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const u = url.toString();
    if (u.includes("checkSendAbility")) {
      return handlers.checkSendAbility?.() ?? jsonResponse({ ok: false });
    }
    if (u.includes("sendVerificationMessage")) {
      return handlers.sendVerificationMessage?.() ?? jsonResponse({ ok: false });
    }
    if (u.includes("VerificationCheck")) {
      return handlers.twilioCheck?.() ?? jsonResponse({ status: "pending" });
    }
    if (u.includes("/Verifications")) {
      return handlers.twilioStart?.() ?? jsonResponse({}, 500);
    }
    throw new Error(`Unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  phoneOtpCreate.mockReset();
  phoneOtpFindFirst.mockReset();
  phoneOtpUpdateMany.mockReset();
  phoneOtpCount.mockReset();
  queryRawUnsafe.mockReset();
  envMock.PHONE_CODE_PRIMARY_PROVIDER = "twilio";
  envMock.TELEGRAM_GATEWAY_TOKEN = "gw-token";
  envMock.TWILIO_ACCOUNT_SID = "AC123";
  envMock.TWILIO_AUTH_TOKEN = "tw-secret";
  envMock.TWILIO_VERIFY_SERVICE_SID = "VA123";
  envMock.OTP_LOG_TO_CONSOLE = false;
  phoneOtpFindFirst.mockResolvedValue(null);
  phoneOtpCount.mockResolvedValue(0);
  phoneOtpCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "row-1",
    createdAt: new Date(),
    ...data,
  }));
  phoneOtpUpdateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("console rail (OTP_LOG_TO_CONSOLE)", () => {
  /**
   * The demo deployment and local dev both run on PRODUCTION's `TWILIO_*`
   * credentials — the demo isolation guard deliberately lets stateless
   * third-party keys through — and `/v1/auth/phone` is mounted unconditionally.
   * Until 2026-08-08 nothing here consulted this flag, so a code requested
   * against `demo-api.gennety.com` sent a real SMS billed to production.
   */
  it("sends NOTHING to any provider — the whole point of the fix", async () => {
    envMock.OTP_LOG_TO_CONSOLE = true;
    const fetchMock = stubProviders({});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await requestPhoneCode("+380631234567");

    expect(result.ok).toBe(true);
    // Not "Twilio wasn't reached" — no outbound call was made at all.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });

  it("stores a locally-verifiable code, so the rail needs no provider", async () => {
    envMock.OTP_LOG_TO_CONSOLE = true;
    stubProviders({});
    vi.spyOn(console, "log").mockImplementation(() => {});

    await requestPhoneCode("+380631234567");

    const { data } = phoneOtpCreate.mock.calls[0][0];
    expect(data.provider).toBe("console");
    expect(data.codeHash).toEqual(expect.any(String));
    // Twilio is the only rail that keeps the code for us; this one must not
    // pretend to have a provider request to check against later.
    expect(data.providerRequestId).toBeUndefined();
  });

  it("verifies the printed code locally", async () => {
    const code = "123456";
    phoneOtpFindFirst.mockResolvedValue({
      id: "row-1",
      provider: "console",
      codeHash: await bcrypt.hash(code, 10),
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });
    phoneOtpUpdateMany.mockResolvedValue({ count: 1 });
    const fetchMock = stubProviders({});

    const result = await verifyPhoneCode("+380631234567", code);

    expect(result).toEqual({ ok: true, phone: "+380631234567" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown provider instead of asking Twilio about it", async () => {
    // The branch is "is it Twilio?", not "is it the Gateway?". A rail added
    // without a matching branch lands here with no `codeHash` and is refused,
    // rather than being handed to a provider that never issued it.
    phoneOtpFindFirst.mockResolvedValue({
      id: "row-1",
      provider: "some_future_rail",
      codeHash: null,
      expiresAt: new Date(Date.now() + 60_000),
      attempts: 0,
    });
    const fetchMock = stubProviders({});

    const result = await verifyPhoneCode("+380631234567", "123456");

    expect(result).toEqual({ ok: false, reason: "mismatch" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("normalizePhone", () => {
  it("normalizes tolerated punctuation and a missing plus", () => {
    expect(normalizePhone(" +380 (63) 123-45-67 ")).toBe("+380631234567");
    expect(normalizePhone("380631234567")).toBe("+380631234567");
  });

  it("rejects junk", () => {
    expect(normalizePhone("not a phone")).toBeNull();
    expect(normalizePhone("+0123456")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
});

describe("requestPhoneCode", () => {
  it("uses Twilio SMS first by default (primary = twilio) without touching the Gateway", async () => {
    const fetchMock = stubProviders({
      twilioStart: () => jsonResponse({ sid: "VE100" }, 201),
    });

    const result = await requestPhoneCode("+380631234567");
    expect(result).toMatchObject({ ok: true, deliveredVia: "sms" });
    const created = phoneOtpCreate.mock.calls[0]![0].data;
    expect(created.provider).toBe("twilio_verify");
    expect(created.codeHash).toBeUndefined();
    expect(created.providerRequestId).toBe("VE100");
    const urls = fetchMock.mock.calls.map((c) => c[0]!.toString());
    expect(urls.some((u) => u.includes("gatewayapi.telegram.org"))).toBe(false);
  });

  it("falls back to Telegram Gateway when Twilio fails and Gateway is configured", async () => {
    stubProviders({
      twilioStart: () => jsonResponse({}, 500),
      checkSendAbility: () => jsonResponse({ ok: true, result: { request_id: "req-9" } }),
      sendVerificationMessage: () => jsonResponse({ ok: true, result: { request_id: "req-9" } }),
    });

    const result = await requestPhoneCode("+380631234567");
    expect(result).toMatchObject({ ok: true, deliveredVia: "telegram" });
    expect(phoneOtpCreate.mock.calls[0]![0].data.provider).toBe("telegram_gateway");
  });

  it("delivers via Telegram Gateway first when it is set as the primary", async () => {
    envMock.PHONE_CODE_PRIMARY_PROVIDER = "telegram";
    stubProviders({
      checkSendAbility: () => jsonResponse({ ok: true, result: { request_id: "req-1" } }),
      sendVerificationMessage: () => jsonResponse({ ok: true, result: { request_id: "req-1" } }),
    });

    const result = await requestPhoneCode("+380631234567");
    expect(result).toMatchObject({ ok: true, deliveredVia: "telegram" });
    const created = phoneOtpCreate.mock.calls[0]![0].data;
    expect(created.provider).toBe("telegram_gateway");
    expect(created.codeHash).toEqual(expect.any(String));
    expect(created.providerRequestId).toBe("req-1");
  });

  it("falls back to Twilio SMS when the primary Gateway can't deliver", async () => {
    envMock.PHONE_CODE_PRIMARY_PROVIDER = "telegram";
    stubProviders({
      checkSendAbility: () => jsonResponse({ ok: false, error: "PHONE_NUMBER_NOT_FOUND" }),
      twilioStart: () => jsonResponse({ sid: "VE123" }, 201),
    });

    const result = await requestPhoneCode("+380631234567");
    expect(result).toMatchObject({ ok: true, deliveredVia: "sms" });
    const created = phoneOtpCreate.mock.calls[0]![0].data;
    expect(created.provider).toBe("twilio_verify");
    expect(created.providerRequestId).toBe("VE123");
  });

  it("forceSms never falls back to the Gateway even when Twilio fails", async () => {
    envMock.PHONE_CODE_PRIMARY_PROVIDER = "telegram";
    const fetchMock = stubProviders({
      twilioStart: () => jsonResponse({}, 500),
    });

    const result = await requestPhoneCode("+380631234567", { forceSms: true });
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    const urls = fetchMock.mock.calls.map((c) => c[0]!.toString());
    expect(urls.some((u) => u.includes("gatewayapi.telegram.org"))).toBe(false);
  });

  it("returns cooldown while a fresh challenge is still live", async () => {
    const createdAt = new Date();
    phoneOtpFindFirst.mockResolvedValue({
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 9 * 60_000),
      attempts: 0,
    });
    stubProviders({});

    const result = await requestPhoneCode("+380631234567");
    expect(result).toMatchObject({ ok: false, reason: "cooldown" });
    expect(phoneOtpCreate).not.toHaveBeenCalled();
  });

  it("enforces the durable per-phone daily cap", async () => {
    phoneOtpCount.mockResolvedValue(PHONE_OTP_DAILY_CAP);
    stubProviders({});

    const result = await requestPhoneCode("+380631234567");
    expect(result).toEqual({ ok: false, reason: "daily_cap" });
    expect(phoneOtpCreate).not.toHaveBeenCalled();
  });

  it("reports unavailable when both rails fail", async () => {
    stubProviders({
      checkSendAbility: () => jsonResponse({ ok: false }),
      twilioStart: () => jsonResponse({}, 500),
    });

    const result = await requestPhoneCode("+380631234567");
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(phoneOtpCreate).not.toHaveBeenCalled();
  });
});

describe("verifyPhoneCode", () => {
  it("verifies a Gateway-delivered code locally and consumes the row", async () => {
    const codeHash = await bcrypt.hash("123456", 4);
    phoneOtpFindFirst.mockResolvedValue({
      id: "row-1",
      provider: "telegram_gateway",
      codeHash,
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });
    stubProviders({});

    await expect(verifyPhoneCode("+380631234567", "123456")).resolves.toEqual({
      ok: true,
      phone: "+380631234567",
    });
    expect(phoneOtpUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { consumedAt: expect.any(Date) } }),
    );
  });

  it("increments attempts on a Gateway code mismatch", async () => {
    const codeHash = await bcrypt.hash("123456", 4);
    phoneOtpFindFirst.mockResolvedValue({
      id: "row-1",
      provider: "telegram_gateway",
      codeHash,
      attempts: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    stubProviders({});

    await expect(verifyPhoneCode("+380631234567", "000000")).resolves.toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(phoneOtpUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: { increment: 1 } } }),
    );
  });

  it("delegates Twilio rows to VerificationCheck", async () => {
    phoneOtpFindFirst.mockResolvedValue({
      id: "row-2",
      provider: "twilio_verify",
      codeHash: null,
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });
    stubProviders({ twilioCheck: () => jsonResponse({ status: "approved" }) });

    await expect(verifyPhoneCode("+380631234567", "654321")).resolves.toEqual({
      ok: true,
      phone: "+380631234567",
    });
  });

  it("maps a Twilio outage to provider_unavailable without burning attempts", async () => {
    phoneOtpFindFirst.mockResolvedValue({
      id: "row-2",
      provider: "twilio_verify",
      codeHash: null,
      attempts: 0,
      expiresAt: new Date(Date.now() + 60_000),
    });
    stubProviders({ twilioCheck: () => jsonResponse({}, 500) });

    await expect(verifyPhoneCode("+380631234567", "654321")).resolves.toEqual({
      ok: false,
      reason: "provider_unavailable",
    });
    expect(phoneOtpUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects expired and exhausted challenges", async () => {
    phoneOtpFindFirst.mockResolvedValue({
      id: "row-3",
      provider: "telegram_gateway",
      codeHash: "x",
      attempts: 0,
      expiresAt: new Date(Date.now() - 1),
    });
    stubProviders({});
    await expect(verifyPhoneCode("+380631234567", "123456")).resolves.toEqual({
      ok: false,
      reason: "expired",
    });

    phoneOtpFindFirst.mockResolvedValue({
      id: "row-4",
      provider: "telegram_gateway",
      codeHash: "x",
      attempts: PHONE_OTP_MAX_ATTEMPTS,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(verifyPhoneCode("+380631234567", "123456")).resolves.toEqual({
      ok: false,
      reason: "exhausted",
    });
  });

  it("returns no_request when nothing is pending", async () => {
    phoneOtpFindFirst.mockResolvedValue(null);
    stubProviders({});
    await expect(verifyPhoneCode("+380631234567", "123456")).resolves.toEqual({
      ok: false,
      reason: "no_request",
    });
  });
});
