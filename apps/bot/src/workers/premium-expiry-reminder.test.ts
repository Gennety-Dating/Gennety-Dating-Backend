import { beforeEach, describe, expect, it, vi } from "vitest";

const user = { findMany: vi.fn(), updateMany: vi.fn() };
const subscriptionLedger = { findMany: vi.fn() };
vi.mock("@gennety/db", () => ({ prisma: { user, subscriptionLedger } }));

vi.mock("../config.js", () => ({
  env: { PREMIUM_FEATURE_ENABLED: true, WEBAPP_URL: "https://app.example.com" },
}));

const {
  premiumExpiryReminderTick,
  premiumReminderDue,
  premiumReminderKind,
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
    premiumProvider: "telegram_stars",
    premiumExternalId: null,
    premiumReminder3dAt: null,
    premiumReminder1dAt: null,
    ...over,
  };
}

beforeEach(() => {
  user.findMany.mockReset().mockResolvedValue([]);
  user.updateMany.mockReset().mockResolvedValue({ count: 1 });
  subscriptionLedger.findMany.mockReset().mockResolvedValue([]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("premiumReminderDue", () => {
  it("warns three days out, then again inside the last day", () => {
    expect(premiumReminderDue(candidate({ premiumUntil: at(2 * DAY) }), NOW)).toBe("early");
    expect(premiumReminderDue(candidate({ premiumUntil: at(6 * HOUR) }), NOW)).toBe("late");
  });

  it("still speaks to a live Stars subscriber — but as the top-up cohort", () => {
    // This is the behaviour that changed. A live subscriber's access is not
    // ending, so the lapse copy would be false — but the CHARGE is coming, and
    // it fails on an empty Star balance, so they are not silent either.
    const live = candidate({ premiumAutoRenew: true, premiumProvider: "telegram_stars" });
    expect(premiumReminderDue(live, NOW)).toBe("early");
    expect(premiumReminderKind(live)).toBe("topup");
  });

  it("says nothing to a live App Store subscriber", () => {
    // Apple runs its own billing retry and grace periods, and there is no Star
    // balance to top up — so both messages would be untrue for this rail.
    const apple = candidate({ premiumAutoRenew: true, premiumProvider: "app_store" });
    expect(premiumReminderKind(apple)).toBeNull();
    expect(premiumReminderDue(apple, NOW)).toBeNull();
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

  it("does NOT narrow the query by autoRenew — both cohorts live in the window", async () => {
    // Re-adding `premiumAutoRenew: false` here is the exact regression that
    // made this worker blind to recurring subscribers in the first place.
    await premiumExpiryReminderTick(api() as never, NOW);
    const where = user.findMany.mock.calls[0][0].where;
    expect(where.premiumAutoRenew).toBeUndefined();
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

describe("the Stars top-up cohort", () => {
  const api = () => ({ sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) });

  /** A live monthly Stars subscriber, three days from their next charge. */
  const subscriber = (over: Record<string, unknown> = {}) =>
    candidate({
      premiumAutoRenew: true,
      premiumProvider: "telegram_stars",
      premiumExternalId: "chg_abc",
      language: "ru",
      ...over,
    });

  it("names the exact Stars amount, the balance rule, and the consequence", async () => {
    user.findMany.mockResolvedValueOnce([subscriber()]);
    subscriptionLedger.findMany.mockResolvedValueOnce([
      { externalPaymentId: "chg_abc", amount: 750 },
    ]);
    const bot = api();
    const r = await premiumExpiryReminderTick(bot as never, NOW);

    expect(r.sent3d).toBe(1);
    const text = bot.sendMessage.mock.calls[0][1] as string;
    expect(text).toContain("750 ⭐");        // the exact charge
    expect(text).toContain("с карты");        // no card fallback
    expect(text).toContain("паузу");          // access pauses
    expect(text).toContain("пополнить");      // top up in advance
    // The lapse copy must never reach a live subscriber: it claims their plan
    // does not renew, which is the opposite of their situation.
    expect(text).not.toContain("не продлевается сам");
  });

  it("quotes the user's OWN charge, not the current env price", async () => {
    // A recurring subscription's amount is frozen at the invoice that created
    // it. deploy.md records a live 500⭐ sub still renewing at 500⭐ after the
    // env moved to 750⭐ — quoting 750 to that user would misstate their money.
    user.findMany.mockResolvedValueOnce([subscriber()]);
    subscriptionLedger.findMany.mockResolvedValueOnce([
      { externalPaymentId: "chg_abc", amount: 500 },
    ]);
    const bot = api();
    await premiumExpiryReminderTick(bot as never, NOW);

    const text = bot.sendMessage.mock.calls[0][1] as string;
    expect(text).toContain("500 ⭐");
    expect(text).not.toContain("750");
  });

  it("looks the charge up by the recurring ANCHOR, not by newest ledger row", async () => {
    // A 3/6-month package writes a priced `started` row on the same provider,
    // so "latest XTR row" would quote 3150⭐ to a monthly subscriber who once
    // bought a package.
    user.findMany.mockResolvedValueOnce([subscriber()]);
    await premiumExpiryReminderTick(api() as never, NOW);

    const where = subscriptionLedger.findMany.mock.calls[0][0].where;
    expect(where.externalPaymentId).toEqual({ in: ["chg_abc"] });
    expect(where.currency).toBe("XTR");
  });

  it("still warns when the amount is unknown, just without a figure", async () => {
    // An absent number is a weaker message; a wrong one is a lie about money.
    user.findMany.mockResolvedValueOnce([subscriber({ premiumExternalId: null })]);
    const bot = api();
    const r = await premiumExpiryReminderTick(bot as never, NOW);

    expect(r.sent3d).toBe(1);
    const text = bot.sendMessage.mock.calls[0][1] as string;
    expect(text).toContain("паузу");
    expect(text).not.toContain("⭐");
    expect(text).not.toMatch(/\{amount\}|\{stars\}/); // no leaked placeholder
  });

  it("carries no button — the plans screen is the wrong destination", async () => {
    // This user already has Premium, and Telegram exposes no deep link a bot
    // can use to open the Stars top-up screen.
    user.findMany.mockResolvedValueOnce([subscriber()]);
    const bot = api();
    await premiumExpiryReminderTick(bot as never, NOW);

    expect(bot.sendMessage.mock.calls[0][2]).toEqual({});
  });

  it("sends the last-day warning too, and marks it independently", async () => {
    user.findMany.mockResolvedValueOnce([subscriber({ premiumUntil: at(5 * HOUR) })]);
    subscriptionLedger.findMany.mockResolvedValueOnce([
      { externalPaymentId: "chg_abc", amount: 750 },
    ]);
    const bot = api();
    const r = await premiumExpiryReminderTick(bot as never, NOW);

    expect(r).toEqual({ sent3d: 0, sent1d: 1, failed: 0 });
    expect(user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { premiumReminder1dAt: NOW } }),
    );
    expect(bot.sendMessage.mock.calls[0][1]).toContain("Завтра");
  });

  it("asks for a charge amount only for the top-up cohort", async () => {
    // A lapse-cohort row has no renewal to price, so it must not widen the
    // ledger lookup.
    user.findMany.mockResolvedValueOnce([
      candidate({ premiumExternalId: "stale_anchor" }), // autoRenew: false
    ]);
    await premiumExpiryReminderTick(api() as never, NOW);

    expect(subscriptionLedger.findMany).not.toHaveBeenCalled();
  });

  it("does not send twice for one period", async () => {
    user.findMany.mockResolvedValueOnce([subscriber({ premiumReminder3dAt: NOW })]);
    const bot = api();
    const r = await premiumExpiryReminderTick(bot as never, NOW);

    expect(bot.sendMessage).not.toHaveBeenCalled();
    expect(r.sent3d).toBe(0);
  });
});

describe("empty reply_markup regression", () => {
  it("omits reply_markup entirely when there is no button to show", async () => {
    // grammY starts an InlineKeyboard at `[[]]`, so the natural
    // `inline_keyboard.length > 0` guard is always true and ships a malformed
    // empty row. Exercised here through the lapse cohort with the feature flag
    // off — the branch whose own comment promised the button was "omitted".
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      env: { PREMIUM_FEATURE_ENABLED: false, WEBAPP_URL: "https://app.example.com" },
    }));
    const mod = await import("./premium-expiry-reminder.js");

    user.findMany.mockResolvedValueOnce([candidate()]);
    const bot = { sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }) };
    await mod.premiumExpiryReminderTick(bot as never, NOW);

    expect(bot.sendMessage.mock.calls[0][2]).toEqual({});
    vi.doUnmock("../config.js");
  });
});
