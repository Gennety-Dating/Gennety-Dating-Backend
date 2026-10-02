/**
 * The date map against a REAL Postgres. The unit tests pin the query's shape;
 * only a database shows that the `OR` of per-side attendance, the status list
 * and the time bound select exactly the dates a person attended.
 *
 * Prerequisites (same as every integration file):
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test \
 *     pnpm --filter @gennety/db db:push
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  cleanDatabase,
  integrationPrisma as db,
  seedUser,
} from "../../../../packages/db/src/test-integration.js";
import { readAttendedPlaceIds, readDateMap } from "./date-map.js";

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await db.$disconnect();
});

const NOW = new Date("2026-10-02T12:00:00Z");

async function date(input: {
  a: string;
  b: string;
  status?: "scheduled" | "completed" | "cancelled";
  at?: Date;
  attendedA?: boolean | null;
  attendedB?: boolean | null;
  placeId?: string | null;
  name?: string;
}) {
  return db.match.create({
    data: {
      userAId: input.a,
      userBId: input.b,
      status: input.status ?? "completed",
      agreedTime: input.at ?? new Date("2026-09-20T17:00:00Z"),
      venueName: input.name ?? "Takava",
      venuePlaceId: input.placeId === undefined ? "p-takava" : input.placeId,
      venueLat: 50.45,
      venueLng: 30.52,
      venueMidpointLat: 50.44,
      venueMidpointLng: 30.51,
      dateAttendedA: input.attendedA ?? null,
      dateAttendedB: input.attendedB ?? null,
    },
  });
}

describe("readDateMap", () => {
  it("counts only the dates this side attended, held and in the past", async () => {
    const me = await seedUser();
    const other = await seedUser({ gender: "female", preference: "men" });
    const third = await seedUser({ gender: "female", preference: "men" });

    // Attended as side A, and again as side B at the same place.
    await date({ a: me.id, b: other.id, attendedA: true });
    await date({ a: third.id, b: me.id, attendedB: true, at: new Date("2026-09-25T17:00:00Z") });
    // The partner attended, I did not.
    await date({ a: me.id, b: other.id, attendedA: false, attendedB: true, placeId: "p-skip" });
    // Cancelled, and still in the future.
    await date({ a: me.id, b: third.id, attendedA: true, status: "cancelled", placeId: "p-skip" });
    await date({
      a: me.id,
      b: third.id,
      attendedA: true,
      status: "scheduled",
      at: new Date("2026-10-05T17:00:00Z"),
      placeId: "p-skip",
    });

    const map = await readDateMap(me.id, NOW);

    expect(map.confirmedDates).toBe(2);
    expect(map.places).toHaveLength(1);
    expect(map.places[0]).toMatchObject({ placeId: "p-takava", visits: 2 });
    expect(map.places[0]!.lastDateAt.toISOString()).toBe("2026-09-25T17:00:00.000Z");

    // The partner's own map answers for the partner's side only.
    expect((await readDateMap(other.id, NOW)).places.map((p) => p.placeId)).toEqual(["p-skip"]);
  });

  it("feeds the venue-change board the same place ids", async () => {
    const me = await seedUser();
    const other = await seedUser({ gender: "female", preference: "men" });
    await date({ a: me.id, b: other.id, attendedA: true });

    expect(await readAttendedPlaceIds(me.id)).toEqual(new Set(["p-takava"]));
  });
});
