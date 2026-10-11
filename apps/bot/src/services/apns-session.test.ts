import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Audit B-14: every push dialled a fresh HTTP/2 connection. These run the real
 * transport against a local cleartext HTTP/2 server (every APNs host is
 * redirected to it) and count the connections the server sees.
 */

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyDir = mkdtempSync(join(tmpdir(), "apns-session-test-"));
const keyPath = join(keyDir, "AuthKey_TEST.p8");
writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

vi.mock("../config.js", () => ({
  env: {
    APNS_KEY_PATH: keyPath,
    APNS_KEY_ID: "KEY123",
    APNS_TEAM_ID: "TEAM456",
    APNS_BUNDLE_ID: "com.gennety.ios",
    APNS_ENVIRONMENT: "sandbox",
  },
}));

const { sendApnsNotification, resetApnsCachesForTest, getApnsSession, __setApnsConnectForTests } =
  await import("./apns.js");

let server: http2.Http2Server;
let origin = "";
let sessionsSeen = 0;

beforeAll(async () => {
  server = http2.createServer();
  server.on("session", () => {
    sessionsSeen++;
  });
  server.on("stream", (stream: http2.ServerHttp2Stream) => {
    stream.respond({ ":status": 200 });
    stream.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  __setApnsConnectForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  resetApnsCachesForTest();
  __setApnsConnectForTests(() => http2.connect(origin));
  sessionsSeen = 0;
});

afterEach(() => {
  __setApnsConnectForTests(() => http2.connect(origin));
});

describe("APNs connection reuse", () => {
  it("sends consecutive pushes over one connection", async () => {
    const payload = { aps: { alert: { title: "T", body: "B" } } };
    for (let i = 0; i < 3; i++) {
      await expect(
        sendApnsNotification(`token-${i}`, payload, { pushType: "alert" }),
      ).resolves.toEqual({ ok: true });
    }
    expect(sessionsSeen).toBe(1);
  });

  it("dials a fresh connection once the pooled one is gone", async () => {
    const first = getApnsSession("https://api.sandbox.push.apple.com");
    expect(getApnsSession("https://api.sandbox.push.apple.com") === first).toBe(true);

    first.destroy();
    const second = getApnsSession("https://api.sandbox.push.apple.com");
    expect(second === first).toBe(false);

    await expect(
      sendApnsNotification("token-x", { aps: {} }, { pushType: "alert" }),
    ).resolves.toEqual({ ok: true });
  });

  it("keeps one connection per host", () => {
    const sandbox = getApnsSession("https://api.sandbox.push.apple.com");
    const production = getApnsSession("https://api.push.apple.com");
    expect(production === sandbox).toBe(false);
  });
});
