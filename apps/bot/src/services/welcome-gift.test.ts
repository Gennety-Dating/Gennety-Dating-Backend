/**
 * Unit tests for the welcome-gift pre-roll sender. The Telegram `Api`, the env
 * config, `node:fs.existsSync`, and grammY's `InputFile` are mocked so we can
 * exercise the video-note caching, graceful asset-skip, message-effect, and
 * text-only fallback paths without any real I/O or bundled assets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@gennety/shared";

const env = { MESSAGE_EFFECT_GIFT_ID: "fx-gift" };
vi.mock("../config.js", () => ({ env }));

const fsState = { exists: false };
vi.mock("node:fs", () => ({ existsSync: () => fsState.exists }));

class MockInputFile {
  constructor(public readonly path: string) {}
}
vi.mock("grammy", () => ({ InputFile: MockInputFile }));

const { sendWelcomeGiftPreroll } = await import("./welcome-gift.js");

function makeApi() {
  return {
    sendVideoNote: vi.fn().mockResolvedValue({ video_note: { file_id: "cached-fid" } }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as any;
}

beforeEach(() => {
  env.MESSAGE_EFFECT_GIFT_ID = "fx-gift";
  fsState.exists = false;
});

describe("sendWelcomeGiftPreroll", () => {
  it("skips the video note when no asset is recorded, still sends the gift DM with effect", async () => {
    const api = makeApi();
    await sendWelcomeGiftPreroll(api, 555, "en", "female");

    expect(api.sendVideoNote).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(555, t("en", "welcomeGiftTicket"), {
      message_effect_id: "fx-gift",
    });
  });

  it("omits the effect when MESSAGE_EFFECT_GIFT_ID is empty", async () => {
    env.MESSAGE_EFFECT_GIFT_ID = "";
    const api = makeApi();
    await sendWelcomeGiftPreroll(api, 555, "ru", "male");

    expect(api.sendMessage).toHaveBeenCalledWith(555, t("ru", "welcomeGiftTicket"), {});
  });

  it("uploads the bundled asset then reuses the cached file_id", async () => {
    fsState.exists = true;
    const api = makeApi();

    // First send: uploads the InputFile, captures the returned file_id.
    await sendWelcomeGiftPreroll(api, 555, "uk", "male");
    expect(api.sendVideoNote).toHaveBeenCalledTimes(1);
    expect(api.sendVideoNote.mock.calls[0][1]).toBeInstanceOf(MockInputFile);

    // Second send (same gender+lang): reuses the cached file_id string.
    await sendWelcomeGiftPreroll(api, 777, "uk", "male");
    expect(api.sendVideoNote).toHaveBeenCalledTimes(2);
    expect(api.sendVideoNote.mock.calls[1][1]).toBe("cached-fid");
  });

  it("never attempts a video note when gender is null", async () => {
    fsState.exists = true;
    const api = makeApi();
    await sendWelcomeGiftPreroll(api, 555, "de", null);

    expect(api.sendVideoNote).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("retries the DM without the effect when the effected send fails", async () => {
    const api = makeApi();
    api.sendMessage
      .mockRejectedValueOnce(new Error("bad effect id"))
      .mockResolvedValueOnce({ message_id: 2 });

    await sendWelcomeGiftPreroll(api, 555, "pl", "female");

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[0][2]).toEqual({ message_effect_id: "fx-gift" });
    expect(api.sendMessage.mock.calls[1][1]).toBe(t("pl", "welcomeGiftTicket"));
    expect(api.sendMessage.mock.calls[1][2]).toBeUndefined();
  });

  it("still sends the gift DM when the video note send throws", async () => {
    fsState.exists = true;
    const api = makeApi();
    api.sendVideoNote.mockRejectedValueOnce(new Error("telegram down"));

    await sendWelcomeGiftPreroll(api, 555, "en", "male");

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
  });
});
