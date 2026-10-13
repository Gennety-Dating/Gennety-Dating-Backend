import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One APNs request timing out used to `destroy()` the shared HTTP/2 session,
 * which failed every other push in flight on it as "transport". These drive the
 * real transport over a scripted session to pin what a timeout touches now.
 */

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyDir = mkdtempSync(join(tmpdir(), "apns-timeout-test-"));
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

const { sendApnsNotification, resetApnsCachesForTest, __setApnsConnectForTests } =
  await import("./apns.js");

class ScriptedStream extends EventEmitter {
  readonly close = vi.fn((_code?: number) => {
    this.emit("close");
  });

  setEncoding(): this {
    return this;
  }

  end(): this {
    return this;
  }

  answer(status: number, body = ""): void {
    this.emit("response", { ":status": status });
    if (body) this.emit("data", body);
    this.emit("end");
    this.emit("close");
  }
}

class ScriptedSession extends EventEmitter {
  closed = false;
  destroyed = false;
  readonly streams: ScriptedStream[] = [];
  readonly close = vi.fn(() => {
    this.closed = true;
  });
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    for (const stream of this.streams) stream.emit("close");
  });

  request(): ScriptedStream {
    const stream = new ScriptedStream();
    this.streams.push(stream);
    return stream;
  }

  setTimeout(): void {}

  unref(): void {}
}

let dialled: ScriptedSession[] = [];
const payload = { aps: { alert: { title: "T", body: "B" } } };

beforeEach(() => {
  vi.useFakeTimers();
  resetApnsCachesForTest();
  dialled = [];
  __setApnsConnectForTests(() => {
    const session = new ScriptedSession();
    dialled.push(session);
    return session as never;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  __setApnsConnectForTests(null);
});

describe("an APNs request that times out", () => {
  it("cancels only its own stream; the other push on the connection still lands", async () => {
    const slow = sendApnsNotification("token-slow", payload, { pushType: "alert" });
    await vi.advanceTimersByTimeAsync(5_000);
    const fast = sendApnsNotification("token-fast", payload, { pushType: "alert" });

    expect(dialled).toHaveLength(1);
    const session = dialled[0]!;
    const [slowStream, fastStream] = session.streams;

    // The slow request reaches its 10 s ceiling.
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(slow).resolves.toEqual({ ok: false, status: 0, reason: "transport" });
    expect(slowStream!.close).toHaveBeenCalledWith(http2.constants.NGHTTP2_CANCEL);
    expect(session.destroy).not.toHaveBeenCalled();
    expect(fastStream!.close).not.toHaveBeenCalled();

    // The connection's other push answers afterwards, as it would have.
    fastStream!.answer(200);
    await expect(fast).resolves.toEqual({ ok: true });
  });

  it("takes the connection out of the pool gracefully, so new pushes dial a fresh one", async () => {
    const slow = sendApnsNotification("token-slow", payload, { pushType: "alert" });
    await vi.advanceTimersByTimeAsync(10_000);
    await slow;

    const first = dialled[0]!;
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.destroy).not.toHaveBeenCalled();

    const next = sendApnsNotification("token-next", payload, { pushType: "alert" });
    expect(dialled).toHaveLength(2);
    expect(first.streams).toHaveLength(1);
    dialled[1]!.streams[0]!.answer(200);
    await expect(next).resolves.toEqual({ ok: true });
  });

  it("still reports a request that answered in time as before", async () => {
    const push = sendApnsNotification("token-dead", payload, { pushType: "alert" });
    const stream = dialled[0]!.streams[0]!;
    stream.answer(410, JSON.stringify({ reason: "Unregistered" }));

    await expect(push).resolves.toEqual({ ok: false, status: 410, reason: "Unregistered" });
    expect(dialled[0]!.close).not.toHaveBeenCalled();
  });
});
