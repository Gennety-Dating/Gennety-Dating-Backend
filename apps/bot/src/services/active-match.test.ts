import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findFirst: vi.fn() },
  },
  // `Prisma` namespace is only used for a `satisfies` type in the source; a
  // bare object keeps the runtime import happy.
  Prisma: {},
}));

import { prisma } from "@gennety/db";
import { findActiveMatchForTelegramId, ACTIVE_MATCH_STATUSES } from "./active-match.js";

const mUser = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const mMatch = prisma.match.findFirst as ReturnType<typeof vi.fn>;

function participant(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    firstName: id === "uid-A" ? "Alice" : "Bob",
    telegramId: id === "uid-A" ? 1001n : 1002n,
    language: "en",
    theme: "dark",
    profile: { photos: [`${id}-photo`] },
    ...over,
  };
}

function scheduledMatch(over: Record<string, unknown> = {}) {
  return {
    id: "match-1",
    status: "scheduled",
    userAId: "uid-A",
    userBId: "uid-B",
    agreedTime: new Date("2026-04-16T16:00:00Z"),
    venueName: "Blur Cafe",
    venueAddress: "1 Main St",
    venueGoogleMapsUri: "https://maps.google.com/?q=blur",
    venueLat: 50.4,
    venueLng: 30.5,
    venuePhotoUrl: null,
    venuePhotoName: null,
    parsedCategoryA: "cafe",
    parsedCategoryB: "cafe",
    proxyOpenedAt: null,
    proxyClosedAt: null,
    proxyClosesAt: null,
    venueChangeStatus: null,
    ticketStatus: null,
    dateCardFileIdA: null,
    dateCardFileIdB: null,
    userA: participant("uid-A"),
    userB: participant("uid-B"),
    ...over,
  };
}

describe("findActiveMatchForTelegramId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when the user does not exist", async () => {
    mUser.mockResolvedValue(null);
    expect(await findActiveMatchForTelegramId(1001n)).toBeNull();
    expect(mMatch).not.toHaveBeenCalled();
  });

  it("returns null when there is no live match", async () => {
    mUser.mockResolvedValue({ id: "uid-A" });
    mMatch.mockResolvedValue(null);
    expect(await findActiveMatchForTelegramId(1001n)).toBeNull();
  });

  it("resolves side A and the partner (userB)", async () => {
    mUser.mockResolvedValue({ id: "uid-A" });
    mMatch.mockResolvedValue(scheduledMatch());

    const result = await findActiveMatchForTelegramId(1001n);
    expect(result).not.toBeNull();
    expect(result!.side).toBe("A");
    expect(result!.partner.id).toBe("uid-B");
    expect(result!.partner.firstName).toBe("Bob");
    expect(result!.self.id).toBe("uid-A");
    expect(result!.match.status).toBe("scheduled");
    expect(result!.match.venueName).toBe("Blur Cafe");
  });

  it("resolves side B and the partner (userA)", async () => {
    mUser.mockResolvedValue({ id: "uid-B" });
    mMatch.mockResolvedValue(scheduledMatch());

    const result = await findActiveMatchForTelegramId(1002n);
    expect(result!.side).toBe("B");
    expect(result!.partner.id).toBe("uid-A");
    expect(result!.partner.firstName).toBe("Alice");
    expect(result!.self.id).toBe("uid-B");
  });

  it("defaults a null language to en", async () => {
    mUser.mockResolvedValue({ id: "uid-A" });
    mMatch.mockResolvedValue(
      scheduledMatch({ userB: participant("uid-B", { language: null }) }),
    );
    const result = await findActiveMatchForTelegramId(1001n);
    expect(result!.partner.language).toBe("en");
  });

  it("queries only the four in-flight statuses", () => {
    expect([...ACTIVE_MATCH_STATUSES]).toEqual([
      "proposed",
      "negotiating",
      "negotiating_venue",
      "scheduled",
    ]);
  });
});
