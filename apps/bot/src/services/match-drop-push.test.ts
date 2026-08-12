import { beforeEach, describe, expect, it, vi } from "vitest";

const sendPushToUser = vi.fn();
vi.mock("./push.js", () => ({ sendPushToUser }));

vi.mock("../config.js", () => ({
  env: { PUBLIC_BASE_URL: "https://dating-api.gennety.com", BOT_TOKEN: "test-bot-token" },
}));

const { MATCH_DROP_PUSH_TYPE, sendMatchDropPush } = await import("./match-drop-push.js");
const { partnerPhotoSignatureValid } = await import("../public/partner-photos.js");

function drop(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    userA: {
      id: "ua",
      language: "ru",
      platform: "mobile",
      profile: { photos: ["a1.jpg", "a2.jpg"] },
    },
    userB: {
      id: "ub",
      language: "en",
      platform: "telegram",
      profile: { photos: ["b1.jpg"] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  sendPushToUser.mockReset().mockResolvedValue(true);
});

describe("sendMatchDropPush", () => {
  it("notifies the app rail in that user's language and nobody else", async () => {
    await sendMatchDropPush(drop());

    // Side B is Telegram-only: it already got the pitch as a media group.
    expect(sendPushToUser).toHaveBeenCalledTimes(1);
    const [userId, payload] = sendPushToUser.mock.calls[0]!;
    expect(userId).toBe("ua");
    expect(payload.title).toBe("Твоя пара найдена");
    expect(payload.data.type).toBe(MATCH_DROP_PUSH_TYPE);
    expect(payload.data.matchId).toBe("m1");
    expect(payload.collapseId).toBe("match.proposed.m1");
  });

  it("carries a signed link to the PARTNER's first photo", async () => {
    await sendMatchDropPush(drop());

    const url = new URL(sendPushToUser.mock.calls[0]![1].data.image);
    expect(url.pathname).toBe("/v1/match-media/partner-photo");
    // Scoped to the viewer, not to the photo's owner: the bytes route resolves
    // "whose photos may this viewer see" itself, and hands back the partner's.
    expect(url.searchParams.get("v")).toBe("ua");
    expect(url.searchParams.get("m")).toBe("m1");
    expect(url.searchParams.get("i")).toBe("0");
    expect(
      partnerPhotoSignatureValid(
        "ua",
        "m1",
        0,
        Number(url.searchParams.get("e")),
        url.searchParams.get("sig")!,
      ),
    ).toBe(true);
  });

  // APNs holds an undelivered alert until the phone is back — which is the
  // case this push exists for. A ten-minute link would expire exactly there.
  it("signs the link for the life of the decision window, not ten minutes", async () => {
    await sendMatchDropPush(drop());

    const url = new URL(sendPushToUser.mock.calls[0]![1].data.image);
    const ttlMs = Number(url.searchParams.get("e")) - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000);
  });

  it("still notifies when the partner has no photo to blur", async () => {
    await sendMatchDropPush(
      drop({
        userB: { id: "ub", language: "en", platform: "telegram", profile: { photos: [] } },
      }),
    );

    const payload = sendPushToUser.mock.calls[0]![1];
    expect(payload.data.image).toBeUndefined();
    expect(payload.body).toBeTruthy();
  });

  it("says nothing about the person on the lock screen", async () => {
    await sendMatchDropPush(drop());

    const payload = sendPushToUser.mock.calls[0]![1];
    // Pinned as an exact key set, like the date-day activity's attributes: a
    // name or an age added here later has to be argued for in this test first.
    expect(Object.keys(payload.data).sort()).toEqual(["image", "matchId", "type"]);
    expect(`${payload.title} ${payload.body}`).not.toMatch(/\d/);
  });

  it("notifies both sides when both live in the app", async () => {
    await sendMatchDropPush(
      drop({
        userB: {
          id: "ub",
          language: "en",
          platform: "both",
          profile: { photos: ["b1.jpg"] },
        },
      }),
    );

    expect(sendPushToUser).toHaveBeenCalledTimes(2);
    expect(sendPushToUser.mock.calls[1]![1].title).toBe("Your match is here");
  });

  // A row loaded before `platform` existed, or a fixture that never carried it,
  // must not be addressed on a rail we cannot confirm the user is on.
  it("stays silent when the platform is unknown", async () => {
    await sendMatchDropPush(
      drop({
        userA: { id: "ua", language: "ru", profile: { photos: [] } },
        userB: { id: "ub", language: "en", profile: { photos: ["b1.jpg"] } },
      }),
    );
    expect(sendPushToUser).not.toHaveBeenCalled();
  });

  it("never rejects — a failed push cannot fail the drop", async () => {
    sendPushToUser.mockRejectedValue(new Error("apns down"));
    await expect(sendMatchDropPush(drop())).resolves.toBeUndefined();
  });
});
