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

const recordTransactionalInboxItem = vi.fn();
vi.mock("./inbox.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./inbox.js")>();
  return { ...original, recordTransactionalInboxItem };
});

const { sendPushToUser, sendLiveActivityStartToUser, sendLiveActivityUpdateToUser } =
  await import("./push.js");

beforeEach(() => {
  userFindUnique.mockReset();
  userUpdate.mockReset().mockResolvedValue({});
  laFindUnique.mockReset();
  laDelete.mockReset().mockResolvedValue({});
  apnsConfigured.mockReset().mockReturnValue(true);
  sendApnsNotification.mockReset();
  recordTransactionalInboxItem.mockReset().mockResolvedValue("inbox-1");
});

describe("sendPushToUser → inbox (decision 2026-09-13)", () => {
  const proposal = { title: "T", body: "B", data: { type: "match.proposed", matchId: "m1" } };

  it("writes the inbox row for an allowlisted type and rides its id on the push", async () => {
    userFindUnique.mockResolvedValue({ pushToken: "device-token", platform: "mobile" });
    sendApnsNotification.mockResolvedValue({ ok: true });

    await expect(sendPushToUser("u1", proposal)).resolves.toBe(true);

    expect(recordTransactionalInboxItem).toHaveBeenCalledWith({
      userId: "u1",
      type: "match.proposed",
      title: "T",
      body: "B",
      data: proposal.data,
    });
    expect(sendApnsNotification.mock.calls[0][1]).toMatchObject({ inboxItemId: "inbox-1", type: "match.proposed" });
  });

  // The bell is an app surface. Someone who declined notifications still opens
  // the app, so the row must not wait on a token.
  it("writes the row even when the person has no push token", async () => {
    userFindUnique.mockResolvedValue({ pushToken: null, platform: "both" });

    await expect(sendPushToUser("u1", proposal)).resolves.toBe(false);

    expect(recordTransactionalInboxItem).toHaveBeenCalledTimes(1);
    expect(sendApnsNotification).not.toHaveBeenCalled();
  });

  it("writes nothing for a Telegram-only account — it has no bell", async () => {
    userFindUnique.mockResolvedValue({ pushToken: "device-token", platform: "telegram" });
    sendApnsNotification.mockResolvedValue({ ok: true });

    await sendPushToUser("u1", proposal);

    expect(recordTransactionalInboxItem).not.toHaveBeenCalled();
  });

  it.each(["proxy.message", "match.nudge", "date.bump", "event.round"])(
    "keeps %s out of the inbox",
    async (type) => {
      userFindUnique.mockResolvedValue({ pushToken: "device-token", platform: "mobile" });
      sendApnsNotification.mockResolvedValue({ ok: true });

      await sendPushToUser("u1", { title: "T", body: "B", data: { type } });

      expect(recordTransactionalInboxItem).not.toHaveBeenCalled();
    },
  );

  it("skips the row when the caller already wrote it (the announcement fan-out)", async () => {
    userFindUnique.mockResolvedValue({ pushToken: "device-token", platform: "mobile" });
    sendApnsNotification.mockResolvedValue({ ok: true });

    await sendPushToUser("u1", proposal, { recordInbox: false });

    expect(recordTransactionalInboxItem).not.toHaveBeenCalled();
  });

  it("still pushes when the inbox write fails", async () => {
    userFindUnique.mockResolvedValue({ pushToken: "device-token", platform: "mobile" });
    recordTransactionalInboxItem.mockRejectedValue(new Error("db down"));
    sendApnsNotification.mockResolvedValue({ ok: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(sendPushToUser("u1", proposal)).resolves.toBe(true);

    expect(sendApnsNotification.mock.calls[0][1]).not.toHaveProperty("inboxItemId");
    warn.mockRestore();
  });
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
        aps: { alert: { title: "T", body: "B" }, sound: "default", category: "match" },
        type: "match",
      }),
      { pushType: "alert" },
    );
  });

  // Forwarded rather than dropped: it is the only thing standing between a
  // retried dispatch and two identical drop notifications on one lock screen.
  it("forwards a collapse id to the transport", async () => {
    userFindUnique.mockResolvedValue({ pushToken: "device-token" });
    sendApnsNotification.mockResolvedValue({ ok: true });

    await sendPushToUser("u1", {
      title: "T",
      body: "B",
      data: { type: "match.proposed" },
      collapseId: "match.proposed.m1",
    });

    expect(sendApnsNotification).toHaveBeenCalledWith(
      "device-token",
      expect.anything(),
      { pushType: "alert", collapseId: "match.proposed.m1" },
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

  it("omits content-state on an end event so the activity keeps its last look", async () => {
    laFindUnique.mockResolvedValue({ id: "row-3", token: "la-token" });
    sendApnsNotification.mockResolvedValue({ ok: true });

    await sendLiveActivityUpdateToUser("u1", "date_day", { event: "end" });

    const payload = sendApnsNotification.mock.calls[0]![1] as { aps: Record<string, unknown> };
    expect(payload.aps.event).toBe("end");
    expect(payload.aps).not.toHaveProperty("content-state");
  });
});

describe("sendLiveActivityStartToUser", () => {
  it("push-starts through the per-type start token, not the update token", async () => {
    laFindUnique.mockResolvedValue({ id: "row-4", token: "start-token" });
    sendApnsNotification.mockResolvedValue({ ok: true });

    await expect(
      sendLiveActivityStartToUser("u1", "date_day", {
        attributesType: "DateDayActivity",
        attributes: { matchId: "m1", startsAt: 1000, venueName: "Aroma", venueAddress: "", mapsUrl: "" },
        contentState: { stage: "icebreakers" },
        alert: { title: "Your date is today", body: "Everything you need." },
        staleDate: 1000,
      }),
    ).resolves.toBe(true);

    expect(laFindUnique).toHaveBeenCalledWith({
      where: {
        userId_activityType_kind: { userId: "u1", activityType: "date_day", kind: "start" },
      },
      select: { id: true, token: true },
    });
    const [token, payload] = sendApnsNotification.mock.calls[0]!;
    expect(token).toBe("start-token");
    const aps = (payload as { aps: Record<string, unknown> }).aps;
    expect(aps.event).toBe("start");
    // The type name is how ActivityKit finds the configuration; a mismatch is
    // a silent drop, so it is pinned rather than trusted.
    expect(aps["attributes-type"]).toBe("DateDayActivity");
    expect(aps.alert).toEqual({ title: "Your date is today", body: "Everything you need." });
    expect(aps["stale-date"]).toBe(1000);
  });

  it("is a no-op for a user with no start token", async () => {
    laFindUnique.mockResolvedValue(null);
    await expect(
      sendLiveActivityStartToUser("u1", "date_day", {
        attributesType: "DateDayActivity",
        attributes: {},
        contentState: {},
        alert: { title: "t", body: "b" },
      }),
    ).resolves.toBe(false);
    expect(sendApnsNotification).not.toHaveBeenCalled();
  });
});
