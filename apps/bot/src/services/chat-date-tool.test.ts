import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `get_my_date` (app audit 2026-11-15, item 3): what the app's agent may read
 * about the person's booked date — their own side, nothing about a decision.
 */

const env = { COORDINATION_FEATURE_ENABLED: true };
vi.mock("../config.js", () => ({ env }));

const db = {
  match: { findFirst: vi.fn() },
  profile: { findUnique: vi.fn() },
  curatedVenue: { findFirst: vi.fn() },
};
vi.mock("@gennety/db", () => ({ prisma: db }));

const { executeGetMyDate } = await import("./chat-date-tool.js");

const USER = "11111111-1111-4111-8111-111111111111";
const AT = new Date("2026-11-15T16:00:00.000Z");

const match = {
  id: "m1",
  status: "scheduled",
  agreedTime: AT,
  venueName: "Kavarnia",
  venueAddress: "Khreshchatyk 1",
  venuePlaceId: "places/abc",
  venueGoogleMapsUri: "https://maps.google.com/?cid=1",
  proxyClosedAt: null,
  iceBreakersA: ["What made you laugh this week?"],
  iceBreakersB: ["Partner's own opener"],
  userB: { firstName: "Anna" },
};

beforeEach(() => {
  for (const group of Object.values(db)) for (const fn of Object.values(group)) fn.mockReset();
  db.profile.findUnique.mockResolvedValue({ timeZone: "Europe/Berlin" });
  db.curatedVenue.findFirst.mockResolvedValue({
    name: "Kavarnia",
    address: "Khreshchatyk 1",
    category: "cafe",
    openingHours: { weekdayDescriptions: ["Sunday: 9:00 AM – 10:00 PM"] },
    hoursConfidence: "provider",
    priceLevel: "PRICE_LEVEL_MODERATE",
    editorialSummary: "Cosy specialty coffee",
    vibeTags: ["quiet", "cozy"],
    transitWalkM: 250,
  });
});

const read = async (now: Date) => JSON.parse(await executeGetMyDate(USER, now)) as Record<string, any>;

describe("get_my_date", () => {
  it("no booked date: says so and describes nothing", async () => {
    db.match.findFirst.mockResolvedValue(null);
    const out = await read(new Date("2026-11-15T09:00:00Z"));
    expect(out).toMatchObject({ success: true, scheduled: false });
    expect(out.venue).toBeUndefined();
  });

  it("the time in their zone, the catalogue facts and the chat window", async () => {
    db.match.findFirst.mockImplementation(async ({ where }: { where: { userAId?: string } }) => (where.userAId ? match : null));
    const out = await read(new Date("2026-11-15T09:00:00Z"));
    expect(out.when).toEqual({ local: "Sunday 15 November at 17:00", timeZone: "Europe/Berlin", past: false });
    expect(out.venue).toMatchObject({
      name: "Kavarnia",
      openingHours: ["Sunday: 9:00 AM – 10:00 PM"],
      priceLevel: "PRICE_LEVEL_MODERATE",
      about: "Cosy specialty coffee",
      vibe: ["quiet", "cozy"],
      walkFromTransitMetres: 250,
    });
    expect(out.anonymousChat).toMatchObject({ state: "not_open_yet", opensAt: "Sunday 15 November at 16:00" });
    expect(out.rules).toContain("never invent a dress code");
    expect(db.curatedVenue.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { placeId: "places/abc" } }));
  });

  it("their own ice-breakers only, never the partner's, and nothing about a decision", async () => {
    db.match.findFirst.mockImplementation(async ({ where }: { where: { userAId?: string } }) => (where.userAId ? match : null));
    const raw = await executeGetMyDate(USER, new Date("2026-11-15T12:00:00Z"));
    const out = JSON.parse(raw) as Record<string, any>;
    expect(out.iceBreakers).toEqual(["What made you laugh this week?"]);
    expect(raw).not.toContain("Partner's own opener");
    expect(out.partnerFirstName).toBe("Anna");
    expect(raw).not.toMatch(/accepted|declined|decision/i);
  });

  it("from side B the partner is A, and the ice-breakers are B's", async () => {
    const asB = { ...match, userB: undefined, userA: { firstName: "Max" } };
    db.match.findFirst.mockImplementation(async ({ where }: { where: { userBId?: string } }) => (where.userBId ? asB : null));
    const out = await read(new Date("2026-11-15T12:00:00Z"));
    expect(out.partnerFirstName).toBe("Max");
    expect(out.iceBreakers).toEqual(["Partner's own opener"]);
  });

  it("an unknown venue leaves the facts null instead of guessing", async () => {
    db.curatedVenue.findFirst.mockResolvedValue(null);
    db.match.findFirst.mockImplementation(async ({ where }: { where: { userAId?: string } }) => (where.userAId ? match : null));
    const out = await read(new Date("2026-11-15T09:00:00Z"));
    expect(out.venue).toMatchObject({ name: "Kavarnia", openingHours: null, priceLevel: null, about: null });
  });
});
