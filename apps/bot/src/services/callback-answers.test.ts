import { describe, it, expect, vi } from "vitest";
import { Api, type RawApi } from "grammy";
import type { ApiResponse } from "grammy/types";
import { installStaleCallbackAnswers } from "./callback-answers.js";

/**
 * `answerCallbackQuery` dismisses the spinner on a tapped button. It never
 * carries the RESULT of the tap — that arrives as an edited card or a new
 * message — so its failure changes nothing the person can see, except when it
 * escapes into `bot.catch` and answers "Something went wrong" to someone whose
 * tap actually worked.
 *
 * Seventy-nine of a hundred-and-six call sites had no `.catch`. This is the one
 * place the refusal arrives.
 */

const TOKEN = "123456:AAHtesttoken";

function stubTransport(response: ApiResponse<unknown>) {
  const transformer = vi.fn(async () => response as never);
  return transformer as unknown as Parameters<Api<RawApi>["config"]["use"]>[0];
}

describe("stale callback answers", () => {
  it("treats an expired query as answered", async () => {
    const api = new Api(TOKEN);
    api.config.use(
      stubTransport({
        ok: false,
        error_code: 400,
        description:
          "Bad Request: query is too old and response timeout expired or query id is invalid",
      }),
    );
    installStaleCallbackAnswers(api);

    await expect(api.answerCallbackQuery("q1")).resolves.toBe(true);
  });

  it("leaves a real refusal alone", async () => {
    // A 400 about something else is a bug worth seeing.
    const api = new Api(TOKEN);
    api.config.use(
      stubTransport({
        ok: false,
        error_code: 400,
        description: "Bad Request: message text is empty",
      }),
    );
    installStaleCallbackAnswers(api);

    await expect(api.answerCallbackQuery("q1")).rejects.toThrow(/text is empty/);
  });

  it("does not touch other methods", async () => {
    const api = new Api(TOKEN);
    api.config.use(
      stubTransport({
        ok: false,
        error_code: 400,
        description: "Bad Request: query is too old",
      }),
    );
    installStaleCallbackAnswers(api);

    await expect(api.sendMessage(1, "hi")).rejects.toThrow(/too old/);
  });

  it("passes a successful answer straight through", async () => {
    const api = new Api(TOKEN);
    api.config.use(stubTransport({ ok: true, result: true }));
    installStaleCallbackAnswers(api);

    await expect(api.answerCallbackQuery("q1")).resolves.toBe(true);
  });
});
