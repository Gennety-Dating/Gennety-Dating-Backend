import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  env: {
    REFERRAL_FEATURE_ENABLED: true,
    REFERRAL_LADDER: [] as const,
    REFERRAL_INVITEE_PREMIUM_MONTHS: 1,
    REFERRAL_DAILY_REWARD_CAP: 0,
    TICKET_PRICE_CENTS: 699,
    PREMIUM_PRICE_USD_DISPLAY: "$11.99",
    BOT_USERNAME: "gennetybot",
  },
  create: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    referralEvent: { create: h.create },
    user: { findUnique: h.userFindUnique },
  },
}));
vi.mock("../config.js", () => ({ env: h.env }));

const {
  recordInviteClickFromStartPayload,
  recordInviteLinkClicked,
  recordInviteSent,
  recordShareSheetOpened,
} = await import("./referral-events.js");

const P2002 = Object.assign(new Error("unique"), { code: "P2002" });

function lastCreateData(): Record<string, unknown> {
  return h.create.mock.calls.at(-1)?.[0].data as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.create.mockResolvedValue({});
  h.userFindUnique.mockResolvedValue({ id: "ref-1" });
});

describe("шеринг", () => {
  it("ключуется по id подготовленного сообщения — повтор не удваивает", async () => {
    await recordShareSheetOpened({
      referrerId: "ref-1",
      preparedMessageId: "pm-9",
      surface: "tg-mini",
    });
    expect(lastCreateData()).toMatchObject({
      kind: "share_sheet_opened",
      dedupeKey: "share:ref-1:pm-9",
      referrerId: "ref-1",
      surface: "tg-mini",
    });

    h.create.mockRejectedValueOnce(P2002);
    const second = await recordShareSheetOpened({
      referrerId: "ref-1",
      preparedMessageId: "pm-9",
      surface: "tg-mini",
    });
    expect(second).toBe(false);
  });

  it("отправка и открытие шторки — разные ключи одного и того же сообщения", async () => {
    await recordShareSheetOpened({
      referrerId: "ref-1",
      preparedMessageId: "pm-9",
      surface: "tg-mini",
    });
    const openedKey = lastCreateData().dedupeKey;
    await recordInviteSent({
      referrerId: "ref-1",
      preparedMessageId: "pm-9",
      surface: "tg-mini",
    });
    expect(lastCreateData().dedupeKey).not.toBe(openedKey);
    expect(lastCreateData().kind).toBe("invite_sent");
  });
});

describe("клик по ссылке", () => {
  it("схлопывает повторы одного человека в пределах суток", async () => {
    await recordInviteLinkClicked({
      referrerId: "ref-1",
      clickerKey: "12345",
      surface: "tg",
      at: new Date("2026-05-04T01:00:00Z"),
    });
    const morning = lastCreateData().dedupeKey;

    await recordInviteLinkClicked({
      referrerId: "ref-1",
      clickerKey: "12345",
      surface: "tg",
      at: new Date("2026-05-04T23:00:00Z"),
    });
    expect(lastCreateData().dedupeKey).toBe(morning);

    // Следующие сутки — уже другое событие: человек вернулся, подумав.
    await recordInviteLinkClicked({
      referrerId: "ref-1",
      clickerKey: "12345",
      surface: "tg",
      at: new Date("2026-05-05T01:00:00Z"),
    });
    expect(lastCreateData().dedupeKey).not.toBe(morning);
  });

  it("не кладёт идентификатор кликнувшего в ключ в открытом виде", async () => {
    await recordInviteLinkClicked({
      referrerId: "ref-1",
      clickerKey: "998877665544",
      surface: "tg",
      at: new Date("2026-05-04T01:00:00Z"),
    });
    expect(String(lastCreateData().dedupeKey)).not.toContain("998877665544");
  });

  it("разные люди по одной ссылке — разные ключи", async () => {
    await recordInviteLinkClicked({
      referrerId: "ref-1",
      clickerKey: "111",
      surface: "tg",
      at: new Date("2026-05-04T01:00:00Z"),
    });
    const first = lastCreateData().dedupeKey;
    await recordInviteLinkClicked({
      referrerId: "ref-1",
      clickerKey: "222",
      surface: "tg",
      at: new Date("2026-05-04T01:00:00Z"),
    });
    expect(lastCreateData().dedupeKey).not.toBe(first);
  });
});

describe("разбор start-payload", () => {
  it("узнаёт реферальную ссылку и записывает клик", async () => {
    const referrerId = await recordInviteClickFromStartPayload({
      payload: "referral_ref-1",
      channelPrefix: "tg",
      clickerKey: "42",
      surface: "tg",
      inviteeId: "invitee-1",
    });
    expect(referrerId).toBe("ref-1");
    expect(lastCreateData()).toMatchObject({
      kind: "invite_link_clicked",
      referrerId: "ref-1",
      inviteeId: "invitee-1",
    });
  });

  it("не трогает кампанийный payload — это не виральный переход", async () => {
    const referrerId = await recordInviteClickFromStartPayload({
      payload: "ig_story_may",
      channelPrefix: "tg",
      clickerKey: "42",
      surface: "tg",
    });
    expect(referrerId).toBeNull();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("клик по ссылке исчезнувшего реферера всё равно считается", async () => {
    h.userFindUnique.mockResolvedValue(null);
    const referrerId = await recordInviteClickFromStartPayload({
      payload: "referral_ghost",
      channelPrefix: "tg",
      clickerKey: "42",
      surface: "tg",
    });
    expect(referrerId).toBeNull();
    // Внешний ключ отверг бы строку с несуществующим реферером, поэтому она
    // пишется с `null` — потерять такой клик значило бы отдать его органике.
    expect(lastCreateData()).toMatchObject({
      kind: "invite_link_clicked",
      referrerId: null,
    });
  });

  it("пустой и слишком длинный payload игнорируются", async () => {
    expect(
      await recordInviteClickFromStartPayload({
        payload: "   ",
        channelPrefix: "tg",
        clickerKey: "42",
        surface: "tg",
      }),
    ).toBeNull();
    expect(
      await recordInviteClickFromStartPayload({
        payload: "referral_".concat("x".repeat(80)),
        channelPrefix: "tg",
        clickerKey: "42",
        surface: "tg",
      }),
    ).toBeNull();
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe("устойчивость", () => {
  it("сбой записи не выбрасывается наружу — это аналитика на горячем пути", async () => {
    h.create.mockRejectedValue(new Error("db is down"));
    await expect(
      recordShareSheetOpened({
        referrerId: "ref-1",
        preparedMessageId: "pm-1",
        surface: "tg-mini",
      }),
    ).resolves.toBe(false);
  });
});
