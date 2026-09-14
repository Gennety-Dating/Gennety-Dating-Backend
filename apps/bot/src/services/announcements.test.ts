import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  announcement: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  inboxItem: {
    count: vi.fn(),
    createMany: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  user: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  event: { count: vi.fn() },
};
vi.mock("@gennety/db", () => ({ prisma: db }));

const sendPushToUser = vi.fn();
vi.mock("./push.js", () => ({ sendPushToUser: (...a: unknown[]) => sendPushToUser(...a) }));

const uploadAnnouncementAsset = vi.fn();
vi.mock("./storage.js", () => ({
  uploadAnnouncementAsset: (...a: unknown[]) => uploadAnnouncementAsset(...a),
  createAnnouncementAssetSignedUrl: async (path: string) => `https://signed/${path}`,
}));

const {
  announcementFanoutTick,
  attachAnnouncementMedia,
  audienceWhere,
  parseAnnouncementFields,
  previewAnnouncement,
  scheduleAnnouncement,
} = await import("./announcements.js");

const ID = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-13T12:00:00Z");

beforeEach(() => {
  for (const model of Object.values(db)) for (const fn of Object.values(model)) fn.mockReset();
  sendPushToUser.mockReset().mockResolvedValue(true);
  uploadAnnouncementAsset.mockReset().mockResolvedValue({ path: `${ID}/media-1.mp4` });
  db.inboxItem.count.mockResolvedValue(0);
  db.inboxItem.updateMany.mockResolvedValue({ count: 0 });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("parseAnnouncementFields", () => {
  const valid = { title: "Launch Night", teaser: "Friday at Sens", body: "Come along." };

  it("fills the defaults of a create", () => {
    expect(parseAnnouncementFields(valid, false)).toEqual({
      ok: true,
      value: {
        ...valid,
        agentBrief: null,
        suggestedQuestions: [],
        eventId: null,
        audience: {},
        sendPush: true,
      },
    });
  });

  it.each([
    [{ ...valid, title: "" }, "title_required"],
    [{ ...valid, teaser: "x".repeat(141) }, "teaser_too_long"],
    [{ ...valid, suggestedQuestions: ["a", "b", "c", "d"] }, "suggestedQuestions_invalid"],
    [{ ...valid, eventId: "launch" }, "eventId_invalid"],
    [{ ...valid, audience: { languages: ["fr"] } }, "audience_invalid"],
    [{ ...valid, sendPush: "yes" }, "sendPush_invalid"],
  ])("names the broken field", (body, error) => {
    expect(parseAnnouncementFields(body, false)).toEqual({ ok: false, error });
  });

  it("lets a draft edit touch one field and nothing else", () => {
    expect(parseAnnouncementFields({ teaser: "Saturday now" }, true)).toEqual({
      ok: true,
      value: { teaser: "Saturday now" },
    });
  });
});

describe("audienceWhere", () => {
  // No token requirement: the inbox reaches people who declined notifications.
  it("reaches app users who can open the app, narrowed by city and language", () => {
    expect(audienceWhere({ cityKeys: ["kyiv"], languages: ["uk", "ru"] })).toEqual({
      platform: { in: ["mobile", "both"] },
      status: { in: ["active", "paused"] },
      language: { in: ["uk", "ru"] },
      profile: { homeCityKey: { in: ["kyiv"] } },
    });
  });
});

/** A minimal ISO-BMFF file: ftyp + moov/mvhd with the given length. */
function mp4(seconds: number): Buffer {
  const box = (type: string, payload: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + payload.length, 0);
    h.write(type, 4, "latin1");
    return Buffer.concat([h, payload]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  return Buffer.concat([box("ftyp", Buffer.from("isom0000", "latin1")), box("moov", box("mvhd", mvhd))]);
}

describe("attachAnnouncementMedia", () => {
  beforeEach(() => {
    db.announcement.findUnique.mockResolvedValue({ status: "draft" });
    db.announcement.updateMany.mockResolvedValue({ count: 1 });
  });

  it("refuses a video longer than ten seconds before uploading it", async () => {
    const result = await attachAnnouncementMedia(ID, { role: "media", buffer: mp4(12) });
    expect(result).toEqual({ ok: false, error: "video_too_long", status: 422 });
    expect(uploadAnnouncementAsset).not.toHaveBeenCalled();
  });

  it("refuses a video as the poster", async () => {
    const result = await attachAnnouncementMedia(ID, { role: "poster", buffer: mp4(3) });
    expect(result).toMatchObject({ ok: false, error: "poster_must_be_image" });
  });

  it("decides the type from the bytes, not from what the upload claims", async () => {
    const result = await attachAnnouncementMedia(ID, { role: "media", buffer: Buffer.from("<svg onload=alert(1)>") });
    expect(result).toMatchObject({ ok: false, error: "unsupported_media", status: 415 });
  });

  it("stores a short video on the draft", async () => {
    db.announcement.findUnique
      .mockResolvedValueOnce({ status: "draft" })
      .mockResolvedValueOnce(null); // afterCas reload → the route's 404 path is not under test here
    await attachAnnouncementMedia(ID, { role: "media", buffer: mp4(8) });
    expect(uploadAnnouncementAsset).toHaveBeenCalledWith(ID, "media", expect.any(Buffer), "video/mp4");
    expect(db.announcement.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: "draft" },
      data: { mediaPath: `${ID}/media-1.mp4`, mediaKind: "video" },
    });
  });

  it("will not touch an announcement that is no longer a draft", async () => {
    db.announcement.findUnique.mockResolvedValue({ status: "sent" });
    expect(await attachAnnouncementMedia(ID, { role: "media", buffer: mp4(3) })).toMatchObject({
      ok: false,
      status: 409,
    });
  });
});

describe("scheduleAnnouncement", () => {
  it("refuses a video without its poster", async () => {
    db.announcement.findUnique.mockResolvedValue({ status: "draft", mediaKind: "video", posterPath: null });
    expect(await scheduleAnnouncement(ID, undefined, NOW)).toEqual({
      ok: false,
      error: "video_needs_poster",
      status: 422,
    });
    expect(db.announcement.updateMany).not.toHaveBeenCalled();
  });

  it("is a CAS on draft, and a past time means now", async () => {
    db.announcement.findUnique.mockResolvedValue({ status: "draft", mediaKind: null, posterPath: null });
    db.announcement.updateMany.mockResolvedValue({ count: 0 });
    const result = await scheduleAnnouncement(ID, "2020-01-01T00:00:00Z", NOW);
    expect(db.announcement.updateMany).toHaveBeenCalledWith({
      where: { id: ID, status: "draft" },
      data: { status: "scheduled", scheduledAt: NOW },
    });
    expect(result).toMatchObject({ ok: false, error: "not_a_draft", status: 409 });
  });
});

describe("previewAnnouncement", () => {
  it("needs an app account", async () => {
    db.announcement.findUnique.mockResolvedValue({ id: ID, status: "draft", title: "T", teaser: "t" });
    db.user.findUnique.mockResolvedValue({ id: USER, platform: "telegram" });
    expect(await previewAnnouncement(ID, USER)).toMatchObject({ ok: false, error: "user_not_on_app" });
  });

  it("writes the same row the fan-out would, and pushes it without a second inbox row", async () => {
    db.announcement.findUnique.mockResolvedValue({
      id: ID,
      status: "draft",
      title: "Launch Night",
      teaser: "Friday",
      posterPath: `${ID}/poster.jpg`,
      mediaKind: "video",
      mediaPath: `${ID}/media.mp4`,
    });
    db.user.findUnique.mockResolvedValue({ id: USER, platform: "mobile" });
    db.inboxItem.upsert.mockResolvedValue({ id: "row-1" });

    expect(await previewAnnouncement(ID, USER)).toEqual({ ok: true, inboxItemId: "row-1", pushed: true });
    expect(db.inboxItem.upsert.mock.calls[0][0].where).toEqual({
      userId_announcementId: { userId: USER, announcementId: ID },
    });
    const [userId, payload, options] = sendPushToUser.mock.calls[0];
    expect(userId).toBe(USER);
    expect(options).toEqual({ recordInbox: false });
    expect(payload.data).toEqual({
      type: "announcement",
      inboxItemId: "row-1",
      announcementId: ID,
      poster: `https://signed/${ID}/poster.jpg`,
    });
    expect(payload.data).not.toHaveProperty("image");
  });
});

describe("announcementFanoutTick", () => {
  const deliverable = {
    id: ID,
    title: "Launch Night",
    teaser: "Friday at Sens",
    posterPath: null,
    mediaKind: null,
    mediaPath: null,
    audience: { cityKeys: ["kyiv"] },
    sendPush: true,
  };
  const deps = (quiet = false) => ({
    now: () => NOW,
    sleep: vi.fn(async () => undefined),
    quietHours: () => quiet,
  });

  beforeEach(() => {
    db.announcement.findMany
      .mockResolvedValueOnce([{ id: ID }]) // due
      .mockResolvedValueOnce([deliverable]); // sending
    db.announcement.updateMany.mockResolvedValue({ count: 1 });
    db.user.findMany.mockResolvedValueOnce([{ id: USER }, { id: "u2" }]);
    db.inboxItem.createMany.mockResolvedValue({ count: 2 });
    db.inboxItem.update.mockResolvedValue({});
  });

  it("claims, writes every inbox row, pushes, and closes the announcement", async () => {
    db.inboxItem.findMany
      .mockResolvedValueOnce([
        { id: "r1", userId: USER, readAt: null },
        { id: "r2", userId: "u2", readAt: null },
      ])
      .mockResolvedValueOnce([]);
    db.inboxItem.count.mockResolvedValueOnce(0).mockResolvedValueOnce(2);

    const d = deps();
    const result = await announcementFanoutTick({ ...d, send: sendPushToUser });

    expect(db.announcement.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: ID, status: "scheduled" },
      data: { status: "sending" },
    });
    expect(db.inboxItem.createMany).toHaveBeenCalledWith({
      data: [
        { userId: USER, announcementId: ID, type: "announcement", title: "Launch Night", body: "Friday at Sens" },
        { userId: "u2", announcementId: ID, type: "announcement", title: "Launch Night", body: "Friday at Sens" },
      ],
      skipDuplicates: true,
    });
    expect(sendPushToUser).toHaveBeenCalledTimes(2);
    expect(sendPushToUser.mock.calls[0][2]).toEqual({ recordInbox: false });
    expect(d.sleep).toHaveBeenCalledWith(100);
    expect(db.announcement.updateMany).toHaveBeenLastCalledWith({
      where: { id: ID, status: "sending" },
      data: { status: "sent", sentAt: NOW, recipientCount: 2 },
    });
    expect(result).toEqual({ claimed: 1, inboxRows: 2, pushed: 2, heldForQuietHours: false, completed: 1 });
  });

  // Quiet hours delay the phone, never the inbox: the rows land at once and the
  // announcement stays `sending` until the first tick after nine.
  it("holds the pushes through quiet hours but still writes the rows", async () => {
    const result = await announcementFanoutTick({ ...deps(true), send: sendPushToUser });

    expect(db.inboxItem.createMany).toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(result.heldForQuietHours).toBe(true);
    expect(db.announcement.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "sent" }) }),
    );
  });

  // A13-L27: a quiet-hours hold keeps the announcement `sending` all night and
  // the tick runs every minute. Each tick used to page the WHOLE audience again
  // to write rows that all already existed.
  it("after one full pass, only pages people who could have joined the audience since", async () => {
    const inboxMarks = new Map<string, Date>();
    await announcementFanoutTick({ ...deps(true), send: sendPushToUser, inboxMarks });

    const firstWhere = db.user.findMany.mock.calls[0]![0].where;
    expect(firstWhere).toEqual(audienceWhere({ cityKeys: ["kyiv"] }));
    expect(inboxMarks.get(ID)).toEqual(NOW);

    // Second minute of the same hold.
    db.announcement.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([deliverable]);
    db.user.findMany.mockResolvedValueOnce([]);
    await announcementFanoutTick({ ...deps(true), send: sendPushToUser, inboxMarks });

    expect(db.user.findMany.mock.calls[1]![0].where).toEqual({
      AND: [
        audienceWhere({ cityKeys: ["kyiv"] }),
        { OR: [{ updatedAt: { gte: NOW } }, { profile: { updatedAt: { gte: NOW } } }] },
      ],
    });
  });

  it("forgets the mark once the announcement is sent", async () => {
    const inboxMarks = new Map<string, Date>([[ID, new Date("2026-09-13T11:00:00Z")]]);
    db.inboxItem.findMany.mockResolvedValueOnce([]);
    db.inboxItem.count.mockResolvedValueOnce(0).mockResolvedValueOnce(2);

    await announcementFanoutTick({ ...deps(), send: sendPushToUser, inboxMarks });

    expect(db.announcement.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "sent" }) }),
    );
    expect(inboxMarks.has(ID)).toBe(false);
  });

  it("does not ring a phone about something already read in the app", async () => {
    db.inboxItem.findMany.mockResolvedValueOnce([{ id: "r1", userId: USER, readAt: NOW }]).mockResolvedValueOnce([]);
    db.inboxItem.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await announcementFanoutTick({ ...deps(), send: sendPushToUser });

    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(db.inboxItem.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { pushedAt: NOW } });
  });
});
