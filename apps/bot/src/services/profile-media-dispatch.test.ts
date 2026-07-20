import { describe, it, expect, vi } from "vitest";
import type { ProfileMedia } from "@gennety/shared";
import { sendProfileMediaCard } from "./profile-media-dispatch.js";

function mockApi() {
  return {
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    sendVideo: vi.fn().mockResolvedValue(undefined),
    sendMediaGroup: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const photo = (id: string): ProfileMedia => ({ type: "photo", photo: id });
const video = (id: string): ProfileMedia => ({
  type: "video",
  video: id,
  duration: 10,
  width: 720,
  height: 1280,
  fileSize: 1024,
});

describe("sendProfileMediaCard protect_content threading", () => {
  it("sets protect_content on a single photo when protect=true", async () => {
    const api = mockApi();
    await sendProfileMediaCard(api, 1, [photo("a")], {}, { protect: true });
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    expect(api.sendPhoto.mock.calls[0]![2]).toMatchObject({ protect_content: true });
  });

  it("sets protect_content on a media group when protect=true", async () => {
    const api = mockApi();
    await sendProfileMediaCard(api, 1, [photo("a"), photo("b")], {}, { protect: true });
    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(api.sendMediaGroup.mock.calls[0]![2]).toMatchObject({ protect_content: true });
  });

  it("omits protect_content by default (e.g. user viewing their own profile)", async () => {
    const api = mockApi();
    await sendProfileMediaCard(api, 1, [photo("a")]);
    expect(api.sendPhoto.mock.calls[0]![2]?.protect_content).toBeUndefined();
  });

  it("sends a profile video after all ten photo slots instead of truncating it", async () => {
    const api = mockApi();
    const media = [
      ...Array.from({ length: 10 }, (_, index) => photo(`p${index + 1}`)),
      video("profile-video"),
    ];

    await sendProfileMediaCard(
      api,
      1,
      media,
      { caption: "Profile" },
      { protect: true },
    );

    expect(api.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(api.sendMediaGroup.mock.calls[0]![1]).toHaveLength(10);
    expect(api.sendMediaGroup.mock.calls[0]![1][0]).toMatchObject({ caption: "Profile" });
    expect(api.sendVideo).toHaveBeenCalledWith(
      1,
      "profile-video",
      expect.objectContaining({ protect_content: true }),
    );
    expect(api.sendVideo.mock.calls[0]![2]?.caption).toBeUndefined();
  });
});
