import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { COORDINATION_FEATURE_ENABLED: true },
}));

vi.mock("../config.js", () => ({ env: mockEnv }));

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findMany: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "@gennety/db";
import {
  runCoordinationTick,
  resolveCoordRecipients,
  buildCoordOfferKeyboard,
  isProxyOpen,
} from "./coordination.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findMany: MockFn; update: MockFn };

function makeApi() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
}

function user(over: Record<string, unknown> = {}): any {
  return {
    id: "uid-A",
    telegramId: 1001n,
    language: "en",
    firstName: "Alice",
    gender: "female",
    telegramUsername: "alice",
    ...over,
  };
}

const NOW = new Date("2026-06-04T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.COORDINATION_FEATURE_ENABLED = true;
  // Default: every phase query returns empty.
  mMatch.findMany.mockResolvedValue([]);
  mMatch.update.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("resolveCoordRecipients", () => {
  it("M/F pair → only the female", () => {
    const a = user({ id: "A", gender: "female" });
    const b = user({ id: "B", gender: "male", telegramId: 1002n });
    const r = resolveCoordRecipients(a, b);
    expect(r.map((u) => u.id)).toEqual(["A"]);
  });

  it("same-sex pair (no female) → both, first tap wins later", () => {
    const a = user({ id: "A", gender: "male" });
    const b = user({ id: "B", gender: "male", telegramId: 1002n });
    const r = resolveCoordRecipients(a, b);
    expect(r.map((u) => u.id).sort()).toEqual(["A", "B"]);
  });

  it("F/F pair → both", () => {
    const a = user({ id: "A", gender: "female" });
    const b = user({ id: "B", gender: "female", telegramId: 1002n });
    expect(resolveCoordRecipients(a, b)).toHaveLength(2);
  });

  it("mobile-only partner (negative id) → nobody is offered", () => {
    const a = user({ id: "A", gender: "female" });
    const b = user({ id: "B", gender: "male", telegramId: -55n });
    expect(resolveCoordRecipients(a, b)).toEqual([]);
  });
});

describe("buildCoordOfferKeyboard", () => {
  function flat(kb: ReturnType<typeof buildCoordOfferKeyboard>) {
    return kb.inline_keyboard.flat().map((b: any) => b.callback_data);
  }

  it("shows all three when both have usernames", () => {
    const cbs = flat(buildCoordOfferKeyboard("m1", "en", true, true));
    expect(cbs).toEqual([
      "coord:method:m1:share_self",
      "coord:method:m1:request_partner",
      "coord:method:m1:proxy",
    ]);
  });

  it("hides share_self when the recipient has no username", () => {
    const cbs = flat(buildCoordOfferKeyboard("m1", "en", false, true));
    expect(cbs).toEqual(["coord:method:m1:request_partner", "coord:method:m1:proxy"]);
  });

  it("only proxy when neither has a username", () => {
    const cbs = flat(buildCoordOfferKeyboard("m1", "en", false, false));
    expect(cbs).toEqual(["coord:method:m1:proxy"]);
  });
});

describe("isProxyOpen", () => {
  it("true inside the window", () => {
    expect(
      isProxyOpen(
        { proxyOpenedAt: NOW, proxyClosedAt: null, proxyClosesAt: new Date(NOW.getTime() + 1) },
        NOW,
      ),
    ).toBe(true);
  });
  it("false once closed", () => {
    expect(
      isProxyOpen({ proxyOpenedAt: NOW, proxyClosedAt: NOW, proxyClosesAt: new Date(NOW.getTime() + 1) }, NOW),
    ).toBe(false);
  });
  it("false past the close time", () => {
    expect(
      isProxyOpen({ proxyOpenedAt: NOW, proxyClosedAt: null, proxyClosesAt: new Date(NOW.getTime() - 1) }, NOW),
    ).toBe(false);
  });
  it("false before it opened", () => {
    expect(isProxyOpen({ proxyOpenedAt: null, proxyClosedAt: null, proxyClosesAt: null }, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runCoordinationTick
// ---------------------------------------------------------------------------

describe("runCoordinationTick — feature flag", () => {
  it("is a no-op when the flag is off (no queries at all)", async () => {
    mockEnv.COORDINATION_FEATURE_ENABLED = false;
    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);
    expect(res).toEqual({ offers: 0, opened: 0, closed: 0 });
    expect(mMatch.findMany).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

describe("runCoordinationTick — offer (T-60m)", () => {
  it("DMs only the female and stamps coordOfferSentAt", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([
        {
          id: "m1",
          userA: user({ id: "A", gender: "female", telegramId: 1001n, telegramUsername: "alice" }),
          userB: user({ id: "B", gender: "male", telegramId: 1002n, telegramUsername: "bob" }),
        },
      ])
      .mockResolvedValueOnce([]) // open phase
      .mockResolvedValueOnce([]); // close phase

    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    expect(res.offers).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledWith(1001, expect.any(String), expect.any(Object));
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { coordOfferSentAt: NOW },
    });
  });

  it("stamps the marker even when nobody is eligible (mobile-only partner)", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([
        {
          id: "m1",
          userA: user({ id: "A", gender: "female", telegramId: 1001n }),
          userB: user({ id: "B", gender: "male", telegramId: -7n }),
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    expect(res.offers).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { coordOfferSentAt: NOW },
    });
  });
});

describe("runCoordinationTick — open proxy (T-30m, unconditional)", () => {
  it("opens for both with no consent gate and sets proxyClosesAt = agreed + 2h", async () => {
    const agreedTime = new Date(NOW.getTime() + 20 * 60 * 1000); // 20 min out
    mMatch.findMany
      .mockResolvedValueOnce([]) // offer phase
      .mockResolvedValueOnce([
        {
          id: "m1",
          agreedTime,
          userA: { telegramId: 1001n, language: "en" },
          userB: { telegramId: 1002n, language: "en" },
        },
      ])
      .mockResolvedValueOnce([]); // close phase

    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    expect(res.opened).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // both sides get Enter button
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: {
        proxyOpenedAt: NOW,
        proxyClosesAt: new Date(agreedTime.getTime() + 2 * 60 * 60 * 1000),
      },
    });
  });
});

describe("runCoordinationTick — close proxy (T+2h)", () => {
  it("stamps proxyClosedAt and DMs both", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([]) // offer
      .mockResolvedValueOnce([]) // open
      .mockResolvedValueOnce([
        {
          id: "m1",
          userA: { telegramId: 1001n, language: "en" },
          userB: { telegramId: 1002n, language: "en" },
        },
      ]);

    const api = makeApi();
    const res = await runCoordinationTick(api, NOW);

    expect(res.closed).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { proxyClosedAt: NOW },
    });
  });
});
