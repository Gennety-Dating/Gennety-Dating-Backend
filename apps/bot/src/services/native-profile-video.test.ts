import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  env: { PROFILE_MEDIA_VALIDATION_ENABLED: true },
  /** The one profile row the service reads and writes. */
  row: null as { photos: string[]; profileMedia: unknown[] } | null,
  validate: vi.fn(),
  probe: vi.fn(),
  upload: vi.fn(),
  deleteObjects: vi.fn(),
  sign: vi.fn(),
  grant: vi.fn(),
  lock: vi.fn(),
  failUpdate: false,
}));

vi.mock("../config.js", () => ({ env: h.env }));

vi.mock("@gennety/db", () => {
  const profile = {
    findUnique: vi.fn(async () => (h.row ? { ...h.row, userId: USER } : null)),
    update: vi.fn(async ({ data }: { data: { profileMedia: unknown[] } }) => {
      if (h.failUpdate) throw new Error("db down");
      h.row = { ...h.row!, profileMedia: data.profileMedia };
      return h.row;
    }),
  };
  const tx = { profile, $queryRawUnsafe: h.lock };
  return {
    prisma: {
      profile,
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
        const snapshot = h.row ? { ...h.row } : null;
        try {
          return await fn(tx);
        } catch (err) {
          h.row = snapshot;
          throw err;
        }
      }),
    },
  };
});

vi.mock("./storage.js", () => ({
  uploadProfileVideoAsset: h.upload,
  deleteProfileVideoObjects: h.deleteObjects,
  createProfilePhotoSignedUrl: h.sign,
}));
vi.mock("./profile-media-validation/profile-video-validation.js", () => ({
  validateUserProfileVideo: h.validate,
}));
vi.mock("./profile-media-validation/video-probe.js", () => ({ probeVideo: h.probe }));
vi.mock("./profile-media-validation/temp-media.js", () => ({
  withTempMediaDirectory: async (op: (dir: string) => Promise<unknown>) => op("/tmp/test"),
  writePrivateMediaFile: vi.fn(async () => undefined),
}));
vi.mock("./ticket-wallet.js", () => ({ grantVideoBonusIfEligible: h.grant }));

const {
  looksLikeIsoMedia,
  removeNativeProfileVideo,
  saveNativeProfileVideo,
  serializeOwnProfileVideo,
  serializePartnerProfileVideo,
} = await import("./native-profile-video.js");

/** Smallest buffer that passes the `ftyp` sniff. */
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypmp42", "latin1"),
  Buffer.alloc(16),
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const photos = ["u/p0.jpg", "u/p1.jpg", "u/p2.jpg", "u/p3.jpg"];
const photoItems = photos.map((photo) => ({ type: "photo", photo }));

beforeEach(() => {
  h.env.PROFILE_MEDIA_VALIDATION_ENABLED = true;
  h.failUpdate = false;
  h.row = { photos: [...photos], profileMedia: [...photoItems] };
  h.validate.mockReset().mockResolvedValue({
    ok: true,
    value: { durationSeconds: 24.46, sampledFrameCount: 12 },
  });
  h.probe.mockReset();
  let n = 0;
  h.upload.mockReset().mockImplementation(async (userId: string, role: string) => ({
    path: `${userId}/${role === "video" ? "video" : "video-thumb"}-${++n}.${role === "video" ? "mp4" : "jpg"}`,
  }));
  h.deleteObjects.mockReset().mockResolvedValue(undefined);
  h.sign.mockReset().mockImplementation(async (path: string) => `https://signed.test/${path}`);
  h.grant.mockReset().mockResolvedValue({ granted: true, balance: 3 });
  h.lock.mockReset().mockResolvedValue([]);
});

describe("looksLikeIsoMedia", () => {
  it("accepts an ftyp box and refuses anything else", () => {
    expect(looksLikeIsoMedia(MP4)).toBe(true);
    expect(looksLikeIsoMedia(JPEG)).toBe(false);
    expect(looksLikeIsoMedia(Buffer.alloc(4))).toBe(false);
  });
});

describe("saveNativeProfileVideo", () => {
  it("stores, attaches after the photos, grants the bonus and returns signed URLs", async () => {
    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG });

    expect(result).toEqual({
      ok: true,
      videoUrl: `https://signed.test/${USER}/video-1.mp4`,
      thumbUrl: `https://signed.test/${USER}/video-thumb-2.jpg`,
      duration: 24.5,
      bonusGranted: true,
    });
    const media = h.row!.profileMedia as Array<Record<string, unknown>>;
    expect(media.slice(0, 4)).toEqual(photoItems);
    expect(media[4]).toMatchObject({
      type: "video",
      video: `${USER}/video-1.mp4`,
      thumb: `${USER}/video-thumb-2.jpg`,
      duration: 24.5,
      mimeType: "video/mp4",
    });
    // The row lock is taken inside the transaction, like photo deletes.
    expect(h.lock).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE"), USER);
    expect(h.grant).toHaveBeenCalledWith(USER);
  });

  it("replaces a previous video and deletes only ITS stored objects", async () => {
    h.row!.profileMedia = [
      ...photoItems.slice(0, 2),
      { type: "video", video: `${USER}/video-old.mp4`, thumb: `${USER}/video-thumb-old.jpg` },
      ...photoItems.slice(2),
    ];

    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG });

    expect(result.ok).toBe(true);
    const media = h.row!.profileMedia as Array<{ type: string; video?: string }>;
    expect(media.filter((m) => m.type === "video")).toHaveLength(1);
    expect(media.filter((m) => m.type === "photo")).toHaveLength(4);
    expect(h.deleteObjects).toHaveBeenCalledWith([
      `${USER}/video-old.mp4`,
      `${USER}/video-thumb-old.jpg`,
    ]);
  });

  it("refuses a file that is not ISO media before any provider runs", async () => {
    const result = await saveNativeProfileVideo({ userId: USER, video: JPEG, thumb: JPEG });
    expect(result).toEqual({ ok: false, error: "invalid_media", retryable: false });
    expect(h.validate).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("refuses a poster that is not an image", async () => {
    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: MP4 });
    expect(result).toEqual({ ok: false, error: "invalid_media", retryable: false });
  });

  it("refuses a user without a profile row", async () => {
    h.row = null;
    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG });
    expect(result).toEqual({ ok: false, error: "profile_missing", retryable: false });
  });

  it("passes the validator's verdict through untouched", async () => {
    h.validate.mockResolvedValue({ ok: false, reason: "unsafe_content", retryable: false });
    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG });
    expect(result).toEqual({ ok: false, error: "unsafe_content", retryable: false });
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("refuses a clip under three seconds — the native floor", async () => {
    h.validate.mockResolvedValue({ ok: true, value: { durationSeconds: 2.4, sampledFrameCount: 3 } });
    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG });
    expect(result).toEqual({ ok: false, error: "video_too_short", retryable: false });
    expect(h.upload).not.toHaveBeenCalled();
  });

  it("still measures the duration when validation is off (local dev)", async () => {
    h.env.PROFILE_MEDIA_VALIDATION_ENABLED = false;
    h.probe.mockResolvedValue({ durationSeconds: 61, width: 720, height: 1280, videoCodec: "h264", hasAudio: true });
    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG });
    expect(result).toEqual({ ok: false, error: "video_too_long", retryable: false });
    expect(h.validate).not.toHaveBeenCalled();
  });

  it("reports a probe failure as retryable, not as a verdict on the clip", async () => {
    h.env.PROFILE_MEDIA_VALIDATION_ENABLED = false;
    h.probe.mockRejectedValue(new Error("ffprobe missing"));
    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG });
    expect(result).toEqual({ ok: false, error: "processing_unavailable", retryable: true });
  });

  it("cleans up the half-uploaded pair when storage fails", async () => {
    h.upload
      .mockResolvedValueOnce({ path: `${USER}/video-1.mp4` })
      .mockRejectedValueOnce(new Error("503"));
    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG });
    expect(result).toEqual({ ok: false, error: "storage_unavailable", retryable: true });
    expect(h.deleteObjects).toHaveBeenCalledWith([`${USER}/video-1.mp4`, undefined]);
    expect(h.row!.profileMedia).toEqual(photoItems);
  });

  it("deletes the new objects and rethrows when the row update fails", async () => {
    h.failUpdate = true;
    await expect(
      saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG }),
    ).rejects.toThrow("db down");
    expect(h.deleteObjects).toHaveBeenCalledWith([
      `${USER}/video-1.mp4`,
      `${USER}/video-thumb-2.jpg`,
    ]);
    expect(h.grant).not.toHaveBeenCalled();
  });

  it("keeps the saved video when the wallet throws", async () => {
    h.grant.mockRejectedValue(new Error("wallet down"));
    const result = await saveNativeProfileVideo({ userId: USER, video: MP4, thumb: JPEG });
    expect(result).toMatchObject({ ok: true, bonusGranted: false });
  });
});

describe("removeNativeProfileVideo", () => {
  it("drops the video item, keeps the photos and deletes stored objects", async () => {
    h.row!.profileMedia = [
      ...photoItems,
      { type: "video", video: `${USER}/video-1.mp4`, thumb: `${USER}/video-thumb-1.jpg` },
    ];
    expect(await removeNativeProfileVideo(USER)).toEqual({ removed: true });
    expect(h.row!.profileMedia).toEqual(photoItems);
    expect(h.deleteObjects).toHaveBeenCalledWith([
      `${USER}/video-1.mp4`,
      `${USER}/video-thumb-1.jpg`,
    ]);
  });

  it("is idempotent when there is no video", async () => {
    expect(await removeNativeProfileVideo(USER)).toEqual({ removed: false });
    expect(h.deleteObjects).toHaveBeenCalledWith([]);
  });
});

describe("serializers", () => {
  it("signs a stored video for its owner", async () => {
    const media = [
      ...photoItems,
      { type: "video", video: `${USER}/video-1.mp4`, thumb: `${USER}/video-thumb-1.jpg`, duration: 12 },
    ];
    expect(await serializeOwnProfileVideo(photos, media)).toEqual({
      url: `https://signed.test/${USER}/video-1.mp4`,
      thumbUrl: `https://signed.test/${USER}/video-thumb-1.jpg`,
      duration: 12,
    });
  });

  it("reports a Telegram video to its owner without a URL, and hides it from a partner", async () => {
    const media = [...photoItems, { type: "video", video: "BAACAgIAAxkBAAIFileId", duration: 8 }];
    expect(await serializeOwnProfileVideo(photos, media)).toEqual({
      url: null,
      thumbUrl: null,
      duration: 8,
    });
    expect(await serializePartnerProfileVideo(photos, media)).toBeNull();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("is null without a video", async () => {
    expect(await serializeOwnProfileVideo(photos, photoItems)).toBeNull();
  });
});
