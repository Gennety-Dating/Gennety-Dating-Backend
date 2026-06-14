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
});
