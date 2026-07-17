import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_PHOTOS, profilePhotoMedia } from "@gennety/shared";
import {
  cleanDatabase,
  integrationPrisma,
  seedProfile,
  seedUser,
} from "../../../../../packages/db/src/test-integration.js";
import {
  commitProfilePhotoCandidate,
  ProfilePhotoCommitConflictError,
} from "./identity-consensus.js";

describe("profile photo commit concurrency", () => {
  beforeEach(cleanDatabase);
  afterAll(() => integrationPrisma.$disconnect());

  it("serializes concurrent uploads at MAX_PHOTOS", async () => {
    const user = await seedUser();
    const existing = Array.from({ length: MAX_PHOTOS - 1 }, (_, index) => `old-${index}.jpg`);
    await seedProfile({ userId: user.id, photos: existing });

    const results = await Promise.allSettled([
      commitProfilePhotoCandidate({
        userId: user.id,
        photoRef: "new-a.jpg",
        profileMedia: profilePhotoMedia("new-a.jpg"),
        perceptualHash: "a".repeat(16),
        source: "mobile",
      }),
      commitProfilePhotoCandidate({
        userId: user.id,
        photoRef: "new-b.jpg",
        profileMedia: profilePhotoMedia("new-b.jpg"),
        perceptualHash: "b".repeat(16),
        source: "mobile",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ reason: "limit" }),
    });
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
      ProfilePhotoCommitConflictError,
    );
    const profile = await integrationPrisma.profile.findUniqueOrThrow({
      where: { userId: user.id },
      select: { photos: true },
    });
    expect(profile.photos).toHaveLength(MAX_PHOTOS);
  });

  it("prevents two concurrent commits with the same validated fingerprint", async () => {
    const user = await seedUser();
    await seedProfile({ userId: user.id, photos: [] });

    const upload = (photoRef: string) =>
      commitProfilePhotoCandidate({
        userId: user.id,
        photoRef,
        profileMedia: profilePhotoMedia(photoRef),
        perceptualHash: "same-fingerprint",
        source: "mobile",
      });
    const results = await Promise.allSettled([upload("a.jpg"), upload("b.jpg")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ reason: "duplicate" }),
    });
    const profile = await integrationPrisma.profile.findUniqueOrThrow({
      where: { userId: user.id },
      select: { photos: true, uploadedPhotoHashes: true },
    });
    expect(profile.photos).toHaveLength(1);
    expect(profile.uploadedPhotoHashes).toEqual(["same-fingerprint"]);
  });
});
