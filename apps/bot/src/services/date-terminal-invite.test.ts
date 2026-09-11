import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: { WEBAPP_URL: "https://webapp.test" },
}));

let demoMode = false;
vi.mock("../demo/config.js", () => ({
  get DEMO_MODE_ENABLED() {
    return demoMode;
  },
}));

const findMany = vi.fn();
const updateMany = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { match: { findMany: (...a: unknown[]) => findMany(...a), updateMany: (...a: unknown[]) => updateMany(...a) } },
}));

const { sendDateTerminalBeats } = await import("./date-terminal-invite.js");

const AGREED = new Date("2026-09-11T16:00:00.000Z");
const MIN = 60_000;
const at = (minutes: number): Date => new Date(AGREED.getTime() + minutes * MIN);

const sendMessage = vi.fn();
const api = { sendMessage } as unknown as Parameters<typeof sendDateTerminalBeats>[0];

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-a",
    telegramId: 782065541n,
    platform: "telegram",
    language: "ru",
    theme: "dark",
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "match-1",
    agreedTime: AGREED,
    venueName: "ТРІШКИ БІЛЬШЕ",
    venueLat: 50.4486,
    venueLng: 30.5133,
    // Set → the V2 finalizer wrote it, so `venueLat/Lng` IS the venue.
    venueMidpointLat: 50.44,
    terminalInviteSentAt: null,
    terminalReminderSentAt: null,
    bumpSession: null,
    userA: user(),
    userB: user({ id: "user-b", telegramId: 5986970093n, language: "en", theme: "light" }),
    ...overrides,
  };
}

beforeEach(() => {
  demoMode = false;
  findMany.mockReset();
  updateMany.mockReset();
  sendMessage.mockReset();
  updateMany.mockResolvedValue({ count: 1 });
  sendMessage.mockResolvedValue({});
});

describe("sendDateTerminalBeats", () => {
  it("claims the invite at T-40m and sends each side a web_app button into the terminal", async () => {
    findMany.mockResolvedValueOnce([row()]);
    const claimed = await sendDateTerminalBeats(api, at(-40));

    expect(claimed).toBe(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "match-1", status: "scheduled", terminalInviteSentAt: null },
      data: { terminalInviteSentAt: at(-40) },
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);

    const [chatId, text, extra] = sendMessage.mock.calls[0] as [number, string, { reply_markup: { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> } }];
    expect(chatId).toBe(782065541);
    expect(text).toContain("ТРІШКИ БІЛЬШЕ");
    expect(text).toContain("45");
    const button = extra.reply_markup.inline_keyboard[0]![0]!;
    const url = new URL(button.web_app.url);
    expect(url.pathname).toBe("/date-terminal.html");
    expect(url.searchParams.get("match")).toBe("match-1");
    expect(url.searchParams.get("lang")).toBe("ru");
    expect(url.searchParams.get("theme")).toBe("dark");

    // Each side in its own language and theme.
    const second = sendMessage.mock.calls[1] as [number, string, { reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> } }];
    const secondUrl = new URL(second[2].reply_markup.inline_keyboard[0]![0]!.web_app.url);
    expect(secondUrl.searchParams.get("lang")).toBe("en");
    expect(secondUrl.searchParams.get("theme")).toBe("light");
  });

  it("sends nothing when another tick already claimed the message", async () => {
    findMany.mockResolvedValueOnce([row()]);
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await sendDateTerminalBeats(api, at(-40))).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends the reminder alone to a pair whose invite was missed", async () => {
    findMany.mockResolvedValueOnce([row()]);
    await sendDateTerminalBeats(api, at(-10));
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "match-1", status: "scheduled", terminalReminderSentAt: null },
      data: { terminalReminderSentAt: at(-10) },
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[0]![1]).toContain("Contact Sync");
  });

  it("claims but does not send the reminder to a pair that already synced", async () => {
    findMany.mockResolvedValueOnce([row({ bumpSession: { isVerified: true } })]);
    await sendDateTerminalBeats(api, at(5));
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("skips a legacy row whose coordinates are the route midpoint, not the venue", async () => {
    findMany.mockResolvedValueOnce([row({ venueMidpointLat: null })]);
    expect(await sendDateTerminalBeats(api, at(-40))).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not message an app-only side", async () => {
    findMany.mockResolvedValueOnce([row({ userB: user({ id: "user-b", platform: "mobile", telegramId: -5n }) })]);
    await sendDateTerminalBeats(api, at(-40));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toBe(782065541);
  });

  it("is silent outside both windows", async () => {
    findMany.mockResolvedValueOnce([row()]);
    expect(await sendDateTerminalBeats(api, at(-60))).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("never runs in the demo, which replays the lifecycle on a shifted clock", async () => {
    demoMode = true;
    expect(await sendDateTerminalBeats(api, at(-40))).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("survives a failed send without throwing", async () => {
    findMany.mockResolvedValueOnce([row()]);
    sendMessage.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));
    await expect(sendDateTerminalBeats(api, at(-40))).resolves.toBe(1);
  });
});
