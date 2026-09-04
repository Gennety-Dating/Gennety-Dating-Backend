import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyDir = mkdtempSync(join(tmpdir(), "appstore-test-"));
const keyPath = join(keyDir, "AppStoreKey.p8");
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

const envMock = {
  APPSTORE_KEY_PATH: keyPath,
  APPSTORE_KEY_ID: "ASKEY1",
  APPSTORE_ISSUER_ID: "issuer-uuid",
  APPSTORE_BUNDLE_ID: "com.gennety.ios",
  APPSTORE_ENVIRONMENT: "sandbox",
  APPSTORE_TICKET_PRODUCTS: "ticket_1:1,ticket_3:3,ticket_6:6",
};

vi.mock("../config.js", () => ({ env: envMock }));

const {
  appStoreConfigured,
  appStoreHost,
  appStoreProviderJwt,
  decodeJwsPayload,
  getVerifiedTransaction,
  resetAppStoreCachesForTest,
  ticketCountForProduct,
} = await import("./appstore.js");

function fakeJws(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "ES256" })}.${b64(payload)}.sig`;
}

beforeEach(() => {
  envMock.APPSTORE_KEY_PATH = keyPath;
  envMock.APPSTORE_KEY_ID = "ASKEY1";
  envMock.APPSTORE_ENVIRONMENT = "sandbox";
  envMock.APPSTORE_TICKET_PRODUCTS = "ticket_1:1,ticket_3:3,ticket_6:6";
  resetAppStoreCachesForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider JWT", () => {
  it("mints a verifiable ES256 token with the App Store claims", () => {
    const token = appStoreProviderJwt();
    const decoded = jwt.verify(token, publicKey.export({ type: "spki", format: "pem" }), {
      algorithms: ["ES256"],
      issuer: "issuer-uuid",
      audience: "appstoreconnect-v1",
      complete: true,
    });
    expect(decoded.header.kid).toBe("ASKEY1");
    expect((decoded.payload as { bid?: string }).bid).toBe("com.gennety.ios");
  });

  it("selects the host by environment and reports configuration", () => {
    expect(appStoreHost()).toBe("https://api.storekit-sandbox.itunes.apple.com");
    envMock.APPSTORE_ENVIRONMENT = "production";
    expect(appStoreHost()).toBe("https://api.storekit.itunes.apple.com");
    expect(appStoreConfigured()).toBe(true);
    envMock.APPSTORE_KEY_ID = "";
    expect(appStoreConfigured()).toBe(false);
  });
});

describe("decodeJwsPayload", () => {
  it("decodes the middle segment without verification", () => {
    expect(decodeJwsPayload(fakeJws({ transactionId: "t1" }))).toEqual({
      transactionId: "t1",
    });
  });

  it("returns null for malformed input", () => {
    expect(decodeJwsPayload("not-a-jws")).toBeNull();
    expect(decodeJwsPayload("a.b")).toBeNull();
    expect(decodeJwsPayload("a.!!!.c")).toBeNull();
  });
});

describe("ticketCountForProduct", () => {
  it("matches full ids and dot-suffixes", () => {
    expect(ticketCountForProduct("com.gennety.ios.ticket_3")).toBe(3);
    expect(ticketCountForProduct("ticket_6")).toBe(6);
    expect(ticketCountForProduct("com.gennety.ios.subscription")).toBeNull();
    expect(ticketCountForProduct(null)).toBeNull();
  });
});

describe("getVerifiedTransaction", () => {
  it("returns the decoded transaction from Apple's signed info", async () => {
    const signed = fakeJws({
      transactionId: "tx-1",
      bundleId: "com.gennety.ios",
      productId: "com.gennety.ios.ticket_3",
      quantity: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ signedTransactionInfo: signed })),
    );

    await expect(getVerifiedTransaction("tx-1")).resolves.toEqual({
      status: "ok",
      transaction: {
        transactionId: "tx-1",
        originalTransactionId: null,
        bundleId: "com.gennety.ios",
        productId: "com.gennety.ios.ticket_3",
        quantity: 1,
        revocationDate: null,
        expiresDate: null,
        priceCents: null,
        currency: null,
      },
    });
  });

  it("maps 404 to not_found and 5xx to unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await expect(getVerifiedTransaction("tx-x")).resolves.toEqual({ status: "not_found" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await expect(getVerifiedTransaction("tx-x")).resolves.toEqual({ status: "unavailable" });
  });

  it("falls back to the other store when the configured one 404s", async () => {
    // A sandbox (TestFlight) purchase reported to a server pinned to
    // production: the production store has never heard of it.
    envMock.APPSTORE_ENVIRONMENT = "production";
    const signed = fakeJws({ transactionId: "tx-sandbox", bundleId: "com.gennety.ios" });
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("https://api.storekit-sandbox.")
        ? Response.json({ signedTransactionInfo: signed })
        : new Response("{}", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getVerifiedTransaction("tx-sandbox");
    expect(result.status).toBe("ok");
    // Production asked first (env order), sandbox second.
    expect(fetchMock.mock.calls[0]![0]).toContain("https://api.storekit.itunes.apple.com");
    expect(fetchMock.mock.calls[1]![0]).toContain("https://api.storekit-sandbox.");
  });

  it("asks only the configured store when it answers", async () => {
    const signed = fakeJws({ transactionId: "tx-1", bundleId: "com.gennety.ios" });
    const fetchMock = vi.fn(async () => Response.json({ signedTransactionInfo: signed }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getVerifiedTransaction("tx-1")).resolves.toMatchObject({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never turns a transport failure into not_found", async () => {
    // 404 from one store, Apple down on the other. Answering `not_found` here
    // would 422 the client, which never retries past it — a real purchase lost
    // to a blip. `unavailable` keeps the transaction unfinished instead.
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("https://api.storekit-sandbox.")
        ? new Response("{}", { status: 404 })
        : new Response("{}", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getVerifiedTransaction("tx-x")).resolves.toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports not_found only when both stores deny the id", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getVerifiedTransaction("tx-forged")).resolves.toEqual({ status: "not_found" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
