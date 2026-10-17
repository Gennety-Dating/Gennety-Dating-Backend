import { describe, expect, it, vi } from "vitest";

/**
 * Founder chat 2026-10-15: «Последний» → «не могу добавить его фото в профиль».
 * The ownership lookup matched `image_url` — the FIRST photo of a turn — so
 * every later photo of an album read as not the person's.
 */

const findFirst = vi.fn(async (_a: unknown): Promise<unknown> => ({ id: "m1" }));
vi.mock("@gennety/db", () => ({ prisma: { message: { findFirst: (a: unknown) => findFirst(a) } } }));

const { findOwnedChatImage } = await import("./chat-profile-tools.js");

describe("findOwnedChatImage", () => {
  it("looks in the album, not only at its first photo", async () => {
    expect(await findOwnedChatImage("u1", "u1/2.jpg")).toEqual({ imageUrl: "u1/2.jpg" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", OR: [{ imageUrl: "u1/2.jpg" }, { imageUrls: { has: "u1/2.jpg" } }] },
      select: { id: true },
    });
  });

  it("no row — not theirs", async () => {
    findFirst.mockResolvedValueOnce(null);
    expect(await findOwnedChatImage("u1", "u2/1.jpg")).toBeNull();
  });
});
