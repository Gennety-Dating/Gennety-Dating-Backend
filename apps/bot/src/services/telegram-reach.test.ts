import { describe, it, expect } from "vitest";
import { pushReachable, telegramReachable } from "./telegram-reach.js";

/**
 * These two predicates decide who gets told things. The failure they exist to
 * prevent is silent: the wrong answer does not throw, it addresses a message
 * to someone who will never see it — and then the silence back is read as a
 * choice (the pre-date coordination offer, §Phase 4) or as a missing answer
 * (the post-date form, §Phase 4.3).
 */
describe("telegramReachable", () => {
  it("rejects the synthetic negative id of an app-only account", () => {
    expect(telegramReachable({ telegramId: -5000n, platform: "mobile" })).toBe(false);
  });

  /**
   * The whole reason this is not `telegramId > 0`. Telegram login stores a
   * REAL positive id on an account that has never pressed Start, and a bot
   * cannot open a chat with such a user.
   */
  it("rejects a real positive id belonging to an app-only account", () => {
    expect(telegramReachable({ telegramId: 782065541n, platform: "mobile" })).toBe(false);
  });

  it("accepts a Telegram user and a both-platform user", () => {
    expect(telegramReachable({ telegramId: 1001n, platform: "telegram" })).toBe(true);
    expect(telegramReachable({ telegramId: 1001n, platform: "both" })).toBe(true);
  });

  /**
   * A row predating the column falls back to the id, so no existing Telegram
   * user loses anything on the deploy that introduces this.
   */
  it("falls back to the id when platform is unknown", () => {
    expect(telegramReachable({ telegramId: 1001n })).toBe(true);
    expect(telegramReachable({ telegramId: 1001n, platform: null })).toBe(true);
    expect(telegramReachable({ telegramId: -1n, platform: null })).toBe(false);
  });
});

describe("pushReachable", () => {
  it("is the app rails and nothing else", () => {
    expect(pushReachable({ platform: "mobile" })).toBe(true);
    expect(pushReachable({ platform: "both" })).toBe(true);
    expect(pushReachable({ platform: "telegram" })).toBe(false);
    expect(pushReachable({ platform: null })).toBe(false);
    expect(pushReachable({})).toBe(false);
  });

  /**
   * `both` is the one value where the two predicates deliberately overlap:
   * that user is told on each rail, because either could be the one they are
   * actually looking at.
   */
  it("overlaps with telegramReachable on `both`, and only there", () => {
    for (const platform of ["telegram", "mobile", "both", null]) {
      const user = { telegramId: 1001n, platform };
      const overlap = telegramReachable(user) && pushReachable(user);
      expect(overlap).toBe(platform === "both");
    }
  });
});
