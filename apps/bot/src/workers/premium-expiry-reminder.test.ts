import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { findMany: vi.fn(), updateMany: vi.fn() };
vi.mock("@gennety/db", () => ({ prisma: { user } }));

vi.mock("../config.js", () => ({
  env: { PREMIUM_FEATURE_ENABLED: true, WEBAPP_URL: "https://app.example.com" },
}));

const {
  premiumExpiryReminderTick,
  premiumReminderDue,
  PREMIUM_REMINDER_EARLY_MS,
  PREMIUM_REMINDER_LATE_MS,
} = await import("./premium-expiry-reminder.js");

/** 13:00 Kyiv — comfortably outside the 23:00–09:00 quiet window. */
const NOW = new Date("2026-09-10T10:00:00.000Z");
const at = (ms: number): Date => new Date(NOW.getTime() + ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function candidate(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "u1",
    telegramId: 5000n,
    platform: "telegram",
    language: "en",
    theme: "dark" as const,
    premiumUntil: at(2 * DAY),
    premiumAutoRenew: false,
    premiumReminder3dAt: null,
    premiumReminder1dAt: null,
    ...over,
  };
}

beforeEach(() => {
  user.findMany.mockReset().mockResolvedValue([]);
  user.updateMany.mockReset().mockResolvedValue({ count: 1 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("premiumReminderDue", () => {
  it("warns three days out, then again inside the last day", () => {
    expect(premiumReminderDue(candidate({ premiumUntil: at(2 * DAY) }), NOW)).toBe("early");
    expect(premiumReminderDue(candidate({ premiumUntil: at(6 * HOUR) }), NOW)).toBe("late");
  });

  it("is silent while the provider is still charging", () => {
    // The whole gate. A live subscriber's access is not ending, so "your
    // Premium runs out on the 3rd" would simply be false — and it would be
    // said to the one cohort paying us every month.
    expect(premiumReminderDue(candidate({ premiumAutoRenew: true }), NOW)).toBeNull();
  });

  it("is silent outside the window and after the period has lapsed", () => {
    expect(premiumReminderDue(candidate({ premiumUntil: at(9 * DAY) }), NOW)).toBeNull();
    expect(premiumReminderDue(candidate({ premiumUntil: at(-HOUR) }), NOW)).toBeNull();
    expect(premiumReminderDue(candidate({ premiumUntil: null }), NOW)).toBeNull();
  });

  it("never sends the same touch twice for one period", () => {
    expect(
      premiumReminderDue(candidate({ premiumReminder3dAt: NOW }), NOW),
    ).toBeNull();
    expect(
      premiumReminderDue(
        candidate({ premiumUntil: at(6 * HOUR), premiumReminder1dAt: NOW }),
        NOW,
      ),
    ).toBeNull();
  });

  it("inside 24h sends ONLY the accurate one, even with no 3-day touch on record", () => {
    // A package bought with under three days of runway must not be told "three
    // days left" — it gets one honest warning rather than two contradictory
    // ones, and the early marker staying null never resurrects the early copy.
    const late = candidate({ premiumUntil: at(3 * HOUR), premiumReminder3dAt: null });
    expect(premiumReminderDue(late, NOW)).toBe("late");
  });

  it("skips someone the bot cannot message", () => {
    // A Telegram-login account carries a REAL positive id the bot cannot open a
    // chat with; `platform` is the canonical reachability check.
    expect(premiumReminderDue(candidate({ platform: "mobile" }), NOW)).toBeNull();
    expect(premiumReminderDue(candidate({ telegramId: -778_000_001n }), NOW)).toBeNull();
    expect(premiumReminderDue(candidate({ platform: "both" }), NOW)).toBe("early");
  });

  it("uses lead times of exactly 3 days and 24 hours", () => {
    expect(PREMIUM_REMINDER_EARLY_MS).toBe(3 * DAY);
    expect(PREMIUM_REMINDER_LATE_MS).toBe(DAY);
  });
});

describe("premiumExpiryReminderTick", () => {
  const api = () => ({ sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) });

  it("sends the 3-day DM with a button into the Premium Mini App", async () => {
    user.findMany.mockResolvedValueOnce([candidate()]);
    const bot = api();
    const r = await premiumExpiryReminderTick(bot as never, NOW);

    expect(r).toEqual({ sent3d: 1, sent1d: 0, failed: 0 });
    const [chatId, text, opts] = bot.sendMessage.mock.calls[0];
    expect(chatId).toBe(5000);
    expect(text).toContain("three days");
    const kb = (opts as { reply_markup?: { inline_keyboard: { url?: string }[][] } })
      .reply_markup;
    expect(kb?.inline_keyboard[0][0]).toMatchObject({
      web_app: { url: expect.stringContaining("premium.html") },
    });
  });

  it("claims the marker BEFORE sending, so a failed DM cannot loop forever", async () => {
    user.findMany.mockResolvedValueOnce([candidate()]);
    const bot = { sendMessage: vi.fn().mockRejectedValue(new Error("bot was blocked")) };
    const r = await premiumExpiryReminderTick(bot as never, NOW);

    expect(r.failed).toBe(1);
    // The marker is spent anyway: re-sending on every hourly tick forever is a
    // worse failure than losing one of two touches.
    expect(user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { premiumReminder3dAt: NOW } }),
    );
  });

  it("only the tick that wins the CAS sends", async () => {
    user.findMany.mockResolvedValueOnce([candidate()]);
    user.updateMany.mockResolvedValueOnce({ count: 0 }); // another tick got there first
    const bot = api();
    const r = await premiumExpiryReminderTick(bot as never, NOW);

    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(r).toEqual({ sent3d: 0, sent1d: 0, failed: 0 });
  });

  it("stamps the LATE marker for a last-day warning", async () => {
    user.findMany.mockResolvedValueOnce([candidate({ premiumUntil: at(5 * HOUR) })]);
    const bot = api();
    const r = await premiumExpiryReminderTick(bot as never, NOW);

    expect(r.sent1d).toBe(1);
    expect(user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { premiumReminder1dAt: NOW } }),
    );
  });

  it("says nothing during quiet hours, and does not even query", async () => {
    // 02:00 Kyiv. The guard can only ever DELAY a reminder: the quiet window is
    // 10h and the narrower bucket is 24h wide, so every eligible user has
    // waking hours inside their own window.
    const quiet = new Date("2026-09-10T23:00:00.000Z");
    const bot = api();
    const r = await premiumExpiryReminderTick(bot as never, quiet);

    expect(user.findMany).not.toHaveBeenCalled();
    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(r).toEqual({ sent3d: 0, sent1d: 0, failed: 0 });
  });

  it("asks the database only for non-renewing periods inside the horizon", async () => {
    await premiumExpiryReminderTick(api() as never, NOW);
    const where = user.findMany.mock.calls[0][0].where;
    expect(where.premiumAutoRenew).toBe(false);
    expect(where.premiumUntil).toEqual({
      gt: NOW,
      lte: new Date(NOW.getTime() + PREMIUM_REMINDER_EARLY_MS),
    });
  });

  it("writes the message in the recipient's own language", async () => {
    user.findMany.mockResolvedValueOnce([candidate({ language: "ru" })]);
    const bot = api();
    await premiumExpiryReminderTick(bot as never, NOW);
    expect(bot.sendMessage.mock.calls[0][1]).toContain("Premium");
    expect(bot.sendMessage.mock.calls[0][1]).toContain("три дня");
  });
});
