import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshAllDirtyEmbeddings: vi.fn(),
  userUpdateMany: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("../workers/embedding-refresh.js", () => ({
  refreshAllDirtyEmbeddings: mocks.refreshAllDirtyEmbeddings,
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      updateMany: mocks.userUpdateMany,
      findMany: mocks.userFindMany,
    },
  },
}));

import { runWeeklyBatch } from "./match-engine.js";

describe("weekly embedding preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshAllDirtyEmbeddings.mockResolvedValue({
      scanned: 24,
      refreshed: 23,
      failed: 1,
      stillDirty: 1,
    });
    mocks.userUpdateMany.mockResolvedValue({ count: 0 });
    mocks.userFindMany.mockResolvedValue([]);
  });

  it("refreshes the complete dirty snapshot before loading eligible users", async () => {
    await expect(runWeeklyBatch()).resolves.toEqual({
      eligible: 0,
      pairs: 0,
      matchIds: [],
      missedUserIds: [],
    });

    expect(mocks.refreshAllDirtyEmbeddings).toHaveBeenCalledTimes(1);
    expect(mocks.userFindMany).toHaveBeenCalledTimes(2);
    expect(
      mocks.refreshAllDirtyEmbeddings.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.userFindMany.mock.invocationCallOrder[0]!);
  });
});
