import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const keyDir = mkdtempSync(join(tmpdir(), "apns-test-"));
const keyPath = join(keyDir, "AuthKey_TEST.p8");
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

const envMock = {
  APNS_KEY_PATH: keyPath,
  APNS_KEY_ID: "KEY123",
  APNS_TEAM_ID: "TEAM456",
  APNS_BUNDLE_ID: "com.gennety.ios",
  APNS_ENVIRONMENT: "sandbox",
};

vi.mock("../config.js", () => ({ env: envMock }));

const {
  apnsConfigured,
  apnsHost,
  apnsProviderJwt,
  buildAlertPayload,
  buildLiveActivityPayload,
  liveActivityTopic,
  resetApnsCachesForTest,
} = await import("./apns.js");

beforeEach(() => {
  envMock.APNS_KEY_PATH = keyPath;
  envMock.APNS_KEY_ID = "KEY123";
  envMock.APNS_TEAM_ID = "TEAM456";
  envMock.APNS_BUNDLE_ID = "com.gennety.ios";
  envMock.APNS_ENVIRONMENT = "sandbox";
  resetApnsCachesForTest();
});

describe("provider JWT", () => {
  it("mints a verifiable ES256 token with kid + iss claims", () => {
    const token = apnsProviderJwt();
    const decoded = jwt.verify(token, publicKey.export({ type: "spki", format: "pem" }), {
      algorithms: ["ES256"],
      issuer: "TEAM456",
      complete: true,
    });
    expect(decoded.header.kid).toBe("KEY123");
    expect(decoded.header.alg).toBe("ES256");
  });

  it("reuses the cached token inside the 50-minute window and rotates after", () => {
    const t0 = Date.now();
    const first = apnsProviderJwt(t0);
    expect(apnsProviderJwt(t0 + 49 * 60_000)).toBe(first);
    // A minted-later token has a different iat → different signature.
    expect(apnsProviderJwt(t0 + 51 * 60_000)).not.toBe(first);
  });
});

describe("configuration", () => {
  it("selects the host by environment", () => {
    expect(apnsHost()).toBe("https://api.sandbox.push.apple.com");
    envMock.APNS_ENVIRONMENT = "production";
    expect(apnsHost()).toBe("https://api.push.apple.com");
  });

  it("reports unconfigured when any credential is missing", () => {
    expect(apnsConfigured()).toBe(true);
    envMock.APNS_KEY_ID = "";
    expect(apnsConfigured()).toBe(false);
  });

  it("derives the Live Activity topic from the bundle id", () => {
    expect(liveActivityTopic()).toBe("com.gennety.ios.push-type.liveactivity");
  });
});

describe("payload builders", () => {
  it("shapes the alert payload with data merged at top level", () => {
    expect(
      buildAlertPayload({ title: "T", body: "B", data: { type: "match", matchId: "m1" } }),
    ).toEqual({
      aps: { alert: { title: "T", body: "B" }, sound: "default" },
      type: "match",
      matchId: "m1",
    });
  });

  it("shapes an ActivityKit update with timestamp and optional dates", () => {
    const payload = buildLiveActivityPayload(
      {
        event: "update",
        contentState: { stage: "icebreakers" },
        staleDate: 1_800_000_000,
      },
      1_700_000_000_000,
    );
    expect(payload).toEqual({
      aps: {
        timestamp: 1_700_000_000,
        event: "update",
        "content-state": { stage: "icebreakers" },
        "stale-date": 1_800_000_000,
      },
    });
  });
});
