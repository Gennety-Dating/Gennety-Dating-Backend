import { describe, it, expect, vi, beforeEach } from "vitest";
import { inspect } from "node:util";
import { Api, BotError, GrammyError, HttpError } from "grammy";

vi.mock("./services/founder-notify.js", () => ({
  notifyFounderHandlerError: vi.fn(),
}));

import { handleBotError } from "./bot-error.js";
import { notifyFounderHandlerError } from "./services/founder-notify.js";
import type { BotContext } from "./session.js";

/**
 * B-03: the BotError handed to the handler carries `ctx.api` (whose raw client
 * holds the bot token in a public field) and the whole update (PII). Neither may
 * reach the log — only the underlying error and the update id.
 */
const TOKEN = "123456789:AAFakeTokenValueThatMustNeverBeLogged_x";

function makeBotError(error: unknown): BotError<BotContext> {
  const ctx = {
    api: new Api(TOKEN),
    update: {
      update_id: 4242,
      message: { text: "my phone is +380501234567", from: { first_name: "Olena" } },
    },
    reply: vi.fn(async () => undefined),
  } as unknown as BotContext;
  return new BotError<BotContext>(error, ctx);
}

function loggedText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls
    .map((args) => args.map((a) => inspect(a, { depth: 10 })).join(" "))
    .join("\n");
}

describe("handleBotError", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the error and update id but never the token or the update body", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await handleBotError(makeBotError(new Error("boom")));
    const text = loggedText(spy);
    expect(text).toContain("boom");
    expect(text).toContain("4242");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("+380501234567");
    expect(text).not.toContain("Olena");
  });

  it("keeps the Telegram refusal's method and code", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refusal = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      "sendMessage",
      { chat_id: 1, text: "secret text" },
    );
    await handleBotError(makeBotError(refusal));
    const text = loggedText(spy);
    expect(text).toContain("sendMessage");
    expect(text).toContain("403");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("secret text");
  });

  it("redacts a token quoted inside a network error message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const net = new HttpError(
      "Network request for 'getMe' failed!",
      new Error(`request to https://api.telegram.org/bot${TOKEN}/getMe failed`),
    );
    await handleBotError(makeBotError(net));
    expect(loggedText(spy)).not.toContain(TOKEN);
    expect(vi.mocked(notifyFounderHandlerError)).toHaveBeenCalledWith(
      expect.stringContaining("4242"),
    );
  });
});
