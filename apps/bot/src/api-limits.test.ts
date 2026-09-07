import { describe, it, expect, vi } from "vitest";
import { Api, type RawApi } from "grammy";
import type { ApiResponse } from "grammy/types";
import { installApiLimits } from "./api-limits.js";

/**
 * These assert the two properties the audit found missing, on a real `Api`
 * rather than a mock of one: a 429 must be honoured and replayed instead of
 * surfacing as an ordinary rejection (which every call site swallows with a
 * `.catch(() => {})`), and a refusal that waiting cannot fix must NOT be
 * replayed — three retries of a blocked chat spend the rate budget the rest of
 * the batch needs.
 *
 * The transport is stubbed as the innermost transformer — which, because grammY
 * composes back to front, means it is installed FIRST. Everything
 * `installApiLimits` adds afterwards therefore sits outside the stub and is
 * exercised on the way through.
 */

const TOKEN = "123456:AAHtesttoken";

/** Canned `ApiResponse`s, newest call first, standing in for the network. */
function stubTransport(responses: ApiResponse<unknown>[]) {
  const calls: string[] = [];
  const queue = [...responses];
  const transformer = vi.fn(async (_prev, method: string) => {
    calls.push(method);
    return (queue.shift() ?? queue.at(-1)!) as never;
  });
  return { transformer: transformer as unknown as Parameters<Api<RawApi>["config"]["use"]>[0], calls };
}

const okMessage: ApiResponse<unknown> = {
  ok: true,
  result: { message_id: 7, date: 0, chat: { id: 1, type: "private" } },
};

describe("installApiLimits", () => {
  it("replays a 429 after the retry_after Telegram asked for", async () => {
    const api = new Api(TOKEN);
    const { transformer, calls } = stubTransport([
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 0",
        parameters: { retry_after: 0 },
      },
      okMessage,
    ]);
    api.config.use(transformer);
    installApiLimits(api);

    const sent = await api.sendMessage(1, "hello");

    expect(calls).toEqual(["sendMessage", "sendMessage"]);
    expect(sent.message_id).toBe(7);
  });

  it("does not replay a refusal that waiting cannot fix", async () => {
    const api = new Api(TOKEN);
    const { transformer, calls } = stubTransport([
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    ]);
    api.config.use(transformer);
    installApiLimits(api);

    await expect(api.sendMessage(1, "hello")).rejects.toThrow(/blocked/);
    expect(calls).toEqual(["sendMessage"]);
  });

  it("gives up rather than sleeping past the pre-checkout window", async () => {
    // `pre_checkout_query` must be answered inside Telegram's 10s window or the
    // payment cancels silently. A flood limit longer than `maxDelaySeconds` is
    // therefore raised immediately instead of slept through.
    const api = new Api(TOKEN);
    const { transformer, calls } = stubTransport([
      {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 300",
        parameters: { retry_after: 300 },
      },
    ]);
    api.config.use(transformer);
    installApiLimits(api);

    await expect(api.answerPreCheckoutQuery("q1", true)).rejects.toThrow(/Too Many Requests/);
    expect(calls).toEqual(["answerPreCheckoutQuery"]);
  });
});
