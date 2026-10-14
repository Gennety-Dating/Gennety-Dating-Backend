/**
 * Unit tests for the welcome-gift pre-roll sender. The Telegram `Api` and the
 * env config are mocked so we can exercise the message-effect and effect-less
 * retry paths without any real I/O.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@gennety/shared";

const env = { MESSAGE_EFFECT_GIFT_ID: "fx-gift" };
vi.mock("../config.js", () => ({ env }));

const { sendWelcomeGiftPreroll } = await import("./welcome-gift.js");

function makeApi() {
  return {
    sendVideoNote: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as any;
}

beforeEach(() => {
  env.MESSAGE_EFFECT_GIFT_ID = "fx-gift";
});

describe("sendWelcomeGiftPreroll", () => {
  it("sends only the gift DM with effect — no founder video note", async () => {
    const api = makeApi();
    await sendWelcomeGiftPreroll(api, 555, "ru");

    expect(api.sendVideoNote).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(555, t("ru", "welcomeGiftTicket"), {
      parse_mode: "Markdown",
      message_effect_id: "fx-gift",
    });
  });

  it("omits the effect when MESSAGE_EFFECT_GIFT_ID is empty", async () => {
    env.MESSAGE_EFFECT_GIFT_ID = "";
    const api = makeApi();
    await sendWelcomeGiftPreroll(api, 555, "ru");

    expect(api.sendMessage).toHaveBeenCalledWith(555, t("ru", "welcomeGiftTicket"), {
      parse_mode: "Markdown",
    });
  });

  it("retries the DM without the effect when the effected send fails", async () => {
    const api = makeApi();
    api.sendMessage
      .mockRejectedValueOnce(new Error("bad effect id"))
      .mockResolvedValueOnce({ message_id: 2 });

    await sendWelcomeGiftPreroll(api, 555, "pl");

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[0][2]).toEqual({
      parse_mode: "Markdown",
      message_effect_id: "fx-gift",
    });
    expect(api.sendMessage.mock.calls[1][1]).toBe(t("pl", "welcomeGiftTicket"));
    expect(api.sendMessage.mock.calls[1][2]).toEqual({ parse_mode: "Markdown" });
  });
});
