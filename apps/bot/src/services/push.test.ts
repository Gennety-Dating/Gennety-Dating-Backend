import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const laFindUnique = vi.fn();
const laDelete = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate },
    liveActivityToken: { findUnique: laFindUnique, delete: laDelete },
  },
}));

const apnsConfigured = vi.fn(() => true);
const sendApnsNotification = vi.fn();
vi.mock("./apns.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./apns.js")>();
  return {
    ...original,
    apnsConfigured,
    sendApnsNotification,
  };
});

const { sendPushToUser, sendLiveActivityUpdateToUser } = await import("./push.js");

beforeEach(() => {
  userFindUnique.mockReset();
  userUpdate.mockReset().mockResolvedValue({});
  laFindUnique.mockReset();
  laDelete.mockReset().mockResolvedValue({});
  apnsConfigured.mockReset().mockReturnValue(true);
  sendApnsNotification.mockReset();
});

describe("sendPushToUser", () => {
  it("sends an alert push with the composed payload", async () => {
    userFindUnique.mockResolvedValue({ pushToken: "device-token" });
    sendApnsNotification.mockResolvedValue({ ok: true });

    await expect(
      sendPushToUser("u1", { title: "T", body: "B", data: { type: "match" } }),
    ).resolves.toBe(true);

    expect(sendApnsNotification).toHaveBeenCalledWith(
      "device-token",
      expect.objectContaining({
        aps: { alert: { title: "T", body: "B" }, sound: "default" },
        type: "match",
      }),
      { pushType: "alert" },
    );
  });

  it("is a no-op without a registered token", async () => {
    userFindUnique.mockResolvedValue({ pushToken: null });
    await expect(sendPushToUser("u1", { title: "T", body: "B" })).resolves.toBe(false);
    expect(sendApnsNotification).not.toHaveBeenCalled();
  });

  it("clears the token when APNs reports it dead", async () => {
    userFindUnique.mockResolvedValue({ pushToken: "stale" });
    sendApnsNotification.mockResolvedValue({ ok: false, status: 410, reason: "Unregistered" });

    await expect(sendPushToUser("u1", { title: "T", body: "B" })).resolves.toBe(false);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { pushToken: null },
    });
  });

  it("keeps the token on transient failures", async () => {
    userFindUnique.mockResolvedValue({ pushToken: "fine" });
    sendApnsNotification.mockResolvedValue({ ok: false, status: 500, reason: "InternalServerError" });

    await expect(sendPushToUser("u1", { title: "T", body: "B" })).resolves.toBe(false);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("sendLiveActivityUpdateToUser", () => {
  it("pushes the content state through the registered update token", async () => {
    laFindUnique.mockResolvedValue({ id: "row-1", token: "la-token" });
    sendApnsNotification.mockResolvedValue({ ok: true });

    await expect(
      sendLiveActivityUpdateToUser("u1", "date_day", {
        event: "update",
        contentState: { stage: "proxy_open" },
      }),
    ).resolves.toBe(true);

    expect(laFindUnique).toHaveBeenCalledWith({
      where: {
        userId_activityType_kind: {
          userId: "u1",
          activityType: "date_day",
          kind: "update",
        },
      },
      select: { id: true, token: true },
    });
    const [token, payload, options] = sendApnsNotification.mock.calls[0]!;
    expect(token).toBe("la-token");
    expect((payload as { aps: Record<string, unknown> }).aps["content-state"]).toEqual({
      stage: "proxy_open",
    });
    expect(options).toEqual({ pushType: "liveactivity" });
  });

  it("returns false when no update token is registered", async () => {
    laFindUnique.mockResolvedValue(null);
    await expect(
      sendLiveActivityUpdateToUser("u1", "match_decision", {
        event: "end",
        contentState: {},
      }),
    ).resolves.toBe(false);
    expect(sendApnsNotification).not.toHaveBeenCalled();
  });

  it("deletes a dead activity token", async () => {
    laFindUnique.mockResolvedValue({ id: "row-2", token: "gone" });
    sendApnsNotification.mockResolvedValue({ ok: false, status: 400, reason: "BadDeviceToken" });

    await expect(
      sendLiveActivityUpdateToUser("u1", "date_day", {
        event: "update",
        contentState: {},
      }),
    ).resolves.toBe(false);
    expect(laDelete).toHaveBeenCalledWith({ where: { id: "row-2" } });
  });
});
