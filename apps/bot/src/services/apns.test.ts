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
  TIME_SENSITIVE_PUSH_TYPES,
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
      aps: { alert: { title: "T", body: "B" }, sound: "default", category: "match" },
      type: "match",
      matchId: "m1",
    });
  });

  // The client attaches actions to a category, and the category IS the type —
  // so a push carrying a type but no category is a push whose buttons silently
  // do not appear. That failure is invisible server-side, hence the guard.
  it("carries the notification type as the APNs category", () => {
    const payload = buildAlertPayload({
      title: "T",
      body: "B",
      data: { type: "proxy.message", matchId: "m1" },
    }) as { aps: { category?: string } };
    expect(payload.aps.category).toBe("proxy.message");
  });

  it("omits the category when there is no type to name it", () => {
    const payload = buildAlertPayload({ title: "T", body: "B" }) as {
      aps: Record<string, unknown>;
    };
    expect(payload.aps).not.toHaveProperty("category");
  });

  // Without `mutable-content` the Notification Service Extension never runs,
  // so the drop notification arrives with no picture at all — a silent
  // downgrade that looks identical to a device with no image support.
  it("turns on mutable-content when the payload carries an image", () => {
    const payload = buildAlertPayload({
      title: "T",
      body: "B",
      data: { type: "match.proposed", matchId: "m1", image: "https://x/y.jpg" },
    }) as { aps: Record<string, unknown> };
    expect(payload.aps["mutable-content"]).toBe(1);
  });

  it("leaves mutable-content off when there is no image to rewrite", () => {
    const payload = buildAlertPayload({
      title: "T",
      body: "B",
      data: { type: "proxy.message", matchId: "m1" },
    }) as { aps: Record<string, unknown> };
    expect(payload.aps).not.toHaveProperty("mutable-content");
  });

  // A level that never arrives is invisible: it only shows itself when the
  // recipient has Focus on, which is precisely the case nobody tests by hand.
  it.each(["safety.brief", "proxy.opened"])(
    "marks %s time-sensitive so it reaches someone with Focus on",
    (type) => {
      const payload = buildAlertPayload({
        title: "T",
        body: "B",
        data: { type, matchId: "m1" },
      }) as { aps: Record<string, unknown> };
      expect(payload.aps["interruption-level"]).toBe("time-sensitive");
    },
  );

  // The absence is the actual product rule — the level is a claim on the
  // user's attention, and the list of types allowed to make it is closed.
  // A drop under the daily cadence would pierce Focus every single evening;
  // a proxy message would do it every couple of minutes.
  it.each(["match.proposed", "proxy.message", "feedback.due"])(
    "leaves %s ordinary — it has no claim on Focus",
    (type) => {
      const payload = buildAlertPayload({
        title: "T",
        body: "B",
        data: { type, matchId: "m1" },
      }) as { aps: Record<string, unknown> };
      expect(payload.aps).not.toHaveProperty("interruption-level");
    },
  );

  it("leaves a typeless push ordinary", () => {
    const payload = buildAlertPayload({ title: "T", body: "B" }) as {
      aps: Record<string, unknown>;
    };
    expect(payload.aps).not.toHaveProperty("interruption-level");
  });

  // Guards the whole policy rather than the two members: a type added to the
  // set is a decision about someone's Do Not Disturb, and it should have to be
  // taken here as well as there.
  it("keeps the Focus-piercing set to exactly the two documented types", () => {
    expect([...TIME_SENSITIVE_PUSH_TYPES].sort()).toEqual(["proxy.opened", "safety.brief"]);
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
