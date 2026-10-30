import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputFile } from "grammy";
import { FounderOutbox, encodePayload, decodePayload, installFounderOutbox } from "./founder-outbox.js";

describe("founder durable transport", () => {
  it("retains a failed send and replays it after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "founder-outbox-"));
    try {
      const failed = new FounderOutbox(dir, async () => { throw new Error("network"); });
      const file = await failed.enqueue("sendMessage", { chat_id: 42, text: "notice" });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await expect(failed.deliver(file)).rejects.toThrow("network");
      const row = JSON.parse(await readFile(file, "utf8"));
      expect(row.attempts).toBe(1);
      expect(row.retryAt).toBeGreaterThan(Date.now());
      await writeFile(file, JSON.stringify({ ...row, retryAt: 0 }));
      const send = vi.fn().mockResolvedValue({ message_id: 7 });
      await new FounderOutbox(dir, send).drain();
      expect(send).toHaveBeenCalledWith("sendMessage", { chat_id: 42, text: "notice" });
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps binary photos replayable and suppresses duplicate pending admission", async () => {
    const dir = await mkdtemp(join(tmpdir(), "founder-outbox-"));
    try {
      const input = { media: [{ type: "photo", media: new InputFile(Buffer.from("bytes"), "card.png") }] };
      const encoded = await encodePayload(input);
      const decoded = decodePayload(encoded) as { media: [{ media: InputFile }] };
      expect(Buffer.from(await decoded.media[0].media.toRaw() as Uint8Array).toString()).toBe("bytes");
      const box = new FounderOutbox(dir, async () => ({}));
      const [a, b] = await Promise.all([box.enqueue("sendMediaGroup", encoded), box.enqueue("sendMediaGroup", encoded)]);
      expect(a).toBe(b);
      expect((await readdir(dir)).length).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("wraps the transport result in the Bot API envelope", async () => {
    // Use a real Api with a stubbed fetch: verify the installed transformer,
    // including the raw/result envelope, without sending a Telegram message.
    const { Api } = await import("grammy");
    const previous = process.env.NODE_ENV;
    const previousDir = process.env.FOUNDER_OUTBOX_DIR;
    const dir = await mkdtemp(join(tmpdir(), "founder-outbox-"));
    const transport = {raw:{sendMessage:vi.fn().mockResolvedValue({message_id:9})},config:{use:vi.fn()}} as unknown as InstanceType<typeof Api>;

    let stop: (() => void) | undefined;
    process.env.NODE_ENV = "production";
    process.env.FOUNDER_OUTBOX_DIR = dir;
    try {
      const api = new Api("123:fake");
      stop = installFounderOutbox(api, "123:fake", transport);
      const result = await api.sendMessage(42, "synthetic test");
      expect(result.message_id).toBe(9);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      stop?.();
      if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
      if (previousDir === undefined) delete process.env.FOUNDER_OUTBOX_DIR; else process.env.FOUNDER_OUTBOX_DIR = previousDir;

      await rm(dir, {recursive:true,force:true});
    }
  });
});
