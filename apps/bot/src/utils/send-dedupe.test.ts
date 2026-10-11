import { describe, expect, it, vi } from "vitest";
import { parseClientMessageId, SendDedupe } from "./send-dedupe.js";

describe("parseClientMessageId", () => {
  it("accepts 8..64 characters and ignores anything else", () => {
    expect(parseClientMessageId("abcdefgh")).toBe("abcdefgh");
    expect(parseClientMessageId("x".repeat(64))).toBe("x".repeat(64));
    expect(parseClientMessageId("short")).toBeNull();
    expect(parseClientMessageId("x".repeat(65))).toBeNull();
    expect(parseClientMessageId(12345678)).toBeNull();
    expect(parseClientMessageId(undefined)).toBeNull();
  });
});

describe("SendDedupe", () => {
  it("returns the first result for the same user and id", async () => {
    const dedupe = new SendDedupe<number>({ keep: () => true });
    const send = vi.fn(async () => 1);
    expect(await dedupe.run("u", "id-00001", send)).toBe(1);
    expect(await dedupe.run("u", "id-00001", send)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a duplicate in flight awaits the same promise", async () => {
    const dedupe = new SendDedupe<number>({ keep: () => true });
    let resolve: (value: number) => void = () => undefined;
    const send = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const a = dedupe.run("u", "id-00001", send);
    const b = dedupe.run("u", "id-00001", send);
    resolve(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keys by user: another person's identical id is their own send", async () => {
    const dedupe = new SendDedupe<string>({ keep: () => true });
    expect(await dedupe.run("u1", "id-00001", async () => "u1")).toBe("u1");
    expect(await dedupe.run("u2", "id-00001", async () => "u2")).toBe("u2");
  });

  it("without an id every call runs", async () => {
    const dedupe = new SendDedupe<number>({ keep: () => true });
    const send = vi.fn(async () => 1);
    await dedupe.run("u", null, send);
    await dedupe.run("u", null, send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("forgets results `keep` rejects, and thrown errors", async () => {
    const dedupe = new SendDedupe<{ ok: boolean }>({ keep: (r) => r.ok });
    const refused = vi.fn(async () => ({ ok: false }));
    await dedupe.run("u", "id-00001", refused);
    await dedupe.run("u", "id-00001", refused);
    expect(refused).toHaveBeenCalledTimes(2);

    const thrower = vi.fn(async (): Promise<{ ok: boolean }> => {
      throw new Error("boom");
    });
    await expect(dedupe.run("u", "id-00002", thrower)).rejects.toThrow("boom");
    await expect(dedupe.run("u", "id-00002", thrower)).rejects.toThrow("boom");
    expect(thrower).toHaveBeenCalledTimes(2);
  });

  it("expires after the TTL and stays within its size bound", async () => {
    const dedupe = new SendDedupe<number>({ keep: () => true, ttlMs: 1_000, maxEntries: 2 });
    const send = vi.fn(async () => 1);
    await dedupe.run("u", "id-00001", send, 0);
    await dedupe.run("u", "id-00001", send, 1_001);
    expect(send).toHaveBeenCalledTimes(2);

    await dedupe.run("u", "id-00002", send, 2_000);
    await dedupe.run("u", "id-00003", send, 2_000);
    // id-00001 was the oldest write and is gone; re-sending runs again.
    await dedupe.run("u", "id-00001", send, 2_000);
    expect(send).toHaveBeenCalledTimes(5);
  });
});
