import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — the raster itself is exercised by scripts/dev-coord-cards-demo.mjs;
// what matters here is which message form actually reaches the user.
// ---------------------------------------------------------------------------

const { mockRender } = vi.hoisted(() => ({ mockRender: vi.fn() }));
vi.mock("./index.js", () => ({ renderCoordinationCard: mockRender }));

import { sendCoordCard } from "./send.js";
import type { CoordCardInput } from "./index.js";

type MockFn = ReturnType<typeof vi.fn>;

function makeApi() {
  return {
    sendPhoto: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue({}),
  } as unknown as Parameters<typeof sendCoordCard>[0] & {
    sendPhoto: MockFn;
    sendMessage: MockFn;
  };
}

const CARD: CoordCardInput = {
  variant: "shared",
  personName: "Alice",
  language: "en",
  theme: "dark",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRender.mockResolvedValue(Buffer.from("png-bytes"));
});

describe("sendCoordCard", () => {
  it("sends ONE photo carrying the copy as its caption and the flow's keyboard", async () => {
    const api = makeApi();
    const keyboard = { inline_keyboard: [] } as never;

    await sendCoordCard(api, 1001n, CARD, "your date shared their Telegram", { keyboard });

    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    const [chatId, , extra] = api.sendPhoto.mock.calls[0]!;
    expect(chatId).toBe(1001);
    expect(extra).toMatchObject({
      caption: "your date shared their Telegram",
      reply_markup: keyboard,
    });
    // The copy must never be sent twice — the caption IS the message.
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  // `offer` / `ask` / `shared` render the other person's face. A partner photo
  // with a clear face must never be forwardable out of the chat — the same rule
  // the match card and the private date card already enforce at their send site
  // (PRODUCT_SPEC §3.7a, legal/privacy-policy.md §10). Asserted for EVERY
  // variant, so a face-carrying card added later cannot ship unprotected.
  it.each(["offer", "ask", "shared", "declined", "proxy"] as const)(
    "protects the %s card from forwarding and saving",
    async (variant) => {
      const api = makeApi();

      await sendCoordCard(api, 1001n, { ...CARD, variant }, "copy");

      const [, , extra] = api.sendPhoto.mock.calls[0]!;
      expect(extra).toMatchObject({ protect_content: true });
    },
  );

  it("keeps protect_content when the flow also attaches a keyboard", async () => {
    const api = makeApi();
    const keyboard = { inline_keyboard: [] } as never;

    await sendCoordCard(api, 1001n, CARD, "copy", { keyboard });

    // The spread of `extra` must not be able to drop the flag.
    const [, , extra] = api.sendPhoto.mock.calls[0]!;
    expect(extra).toMatchObject({ protect_content: true, reply_markup: keyboard });
  });

  // Every branch below must still deliver the copy: this DM lands ~1h before
  // the date and is the only way the pair can find each other.
  it("falls back to text when the render returns null", async () => {
    mockRender.mockResolvedValue(null);
    const api = makeApi();

    await sendCoordCard(api, 1001n, CARD, "copy");

    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(1001, "copy", undefined);
  });

  it("falls back to text when the copy exceeds the 1024-char caption limit", async () => {
    const api = makeApi();
    const long = "x".repeat(1025);

    await sendCoordCard(api, 1001n, CARD, long);

    // Truncating would drop the contact link, which is the whole payload.
    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledWith(1001, long, undefined);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("falls back to text when Telegram rejects the photo", async () => {
    const api = makeApi();
    api.sendPhoto.mockRejectedValue(new Error("PHOTO_INVALID_DIMENSIONS"));

    await sendCoordCard(api, 1001n, CARD, "copy");

    expect(api.sendMessage).toHaveBeenCalledWith(1001, "copy", undefined);
  });

  it("swallows a failure of the text fallback itself", async () => {
    mockRender.mockResolvedValue(null);
    const api = makeApi();
    api.sendMessage.mockRejectedValue(new Error("bot was blocked by the user"));

    await expect(sendCoordCard(api, 1001n, CARD, "copy")).resolves.toBeUndefined();
  });

  it("sends nothing to a mobile-only account (synthetic negative telegramId)", async () => {
    const api = makeApi();

    await sendCoordCard(api, -7n, CARD, "copy");

    expect(api.sendPhoto).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
  });
});
