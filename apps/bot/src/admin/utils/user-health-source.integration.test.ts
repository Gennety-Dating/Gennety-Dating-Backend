/**
 * Integration test for the reply-timing aggregate in `user-health-source.ts`.
 *
 * It MUST run against a real PostgreSQL: the pairing rule now lives in a window
 * function, and the whole point of moving it there was to stop pulling
 * `chat_events` into the bot's heap. A mocked Prisma client cannot evaluate
 * `LAG` or `percentile_cont`, so a unit test would assert nothing about the
 * thing that changed.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test \
 *     pnpm --filter @gennety/db db:push
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  integrationPrisma,
  cleanDatabase,
  seedUser,
} from "../../../../../packages/db/src/test-integration.js";
import { medianResponseSeconds } from "./user-health-source.js";

const BASE = new Date("2026-01-01T10:00:00.000Z");

/** `at` is seconds after `BASE`, which keeps the sequences readable. */
async function seedEvents(
  userId: string,
  events: Array<{ direction: "in" | "out"; at: number }>,
): Promise<void> {
  for (const event of events) {
    await integrationPrisma.chatEvent.create({
      data: {
        userId,
        direction: event.direction,
        kind: event.direction === "in" ? "user_text" : "text",
        summary: "x",
        createdAt: new Date(BASE.getTime() + event.at * 1000),
      },
    });
  }
}

async function timingFor(...userIds: string[]) {
  const timing = await medianResponseSeconds(userIds);
  const first = timing.get(userIds[0]!);
  return { median: first?.medianSec ?? null, samples: first?.samples ?? 0 };
}

beforeEach(cleanDatabase);
afterAll(() => integrationPrisma.$disconnect());

describe("median reply time", () => {
  it("counts a second message in a row as part of the same reply, not a new one", async () => {
    const user = await seedUser({ status: "active" });
    await seedEvents(user.id, [
      { direction: "out", at: 0 },
      { direction: "in", at: 10 },
      { direction: "in", at: 40 },
    ]);

    expect(await timingFor(user.id)).toEqual({ median: 10, samples: 1 });
  });

  it("measures from the LAST thing the bot said, not the first", async () => {
    const user = await seedUser({ status: "active" });
    await seedEvents(user.id, [
      { direction: "out", at: 0 },
      { direction: "out", at: 30 },
      { direction: "in", at: 34 },
    ]);

    expect(await timingFor(user.id)).toEqual({ median: 4, samples: 1 });
  });

  it("ignores a message the user sent before the bot said anything", async () => {
    const user = await seedUser({ status: "active" });
    await seedEvents(user.id, [
      { direction: "in", at: 0 },
      { direction: "out", at: 10 },
      { direction: "in", at: 16 },
    ]);

    expect(await timingFor(user.id)).toEqual({ median: 6, samples: 1 });
  });

  it("averages the two middle gaps on an even number of replies", async () => {
    const user = await seedUser({ status: "active" });
    await seedEvents(user.id, [
      { direction: "out", at: 0 },
      { direction: "in", at: 2 },
      { direction: "out", at: 10 },
      { direction: "in", at: 18 },
    ]);

    expect(await timingFor(user.id)).toEqual({ median: 5, samples: 2 });
  });

  it("reports no median at all for someone who never replied", async () => {
    const user = await seedUser({ status: "active" });
    await seedEvents(user.id, [
      { direction: "out", at: 0 },
      { direction: "out", at: 5 },
    ]);

    expect(await timingFor(user.id)).toEqual({ median: null, samples: 0 });
  });

  it("keeps one person's replies out of another's median", async () => {
    const fast = await seedUser({ status: "active" });
    const slow = await seedUser({ status: "active" });
    await seedEvents(fast.id, [
      { direction: "out", at: 0 },
      { direction: "in", at: 1 },
    ]);
    await seedEvents(slow.id, [
      { direction: "out", at: 0 },
      { direction: "in", at: 600 },
    ]);

    // Asked together, exactly as the dashboard asks — a partition bug would
    // show up only here.
    expect(await timingFor(fast.id, slow.id)).toEqual({ median: 1, samples: 1 });
    expect(await timingFor(slow.id, fast.id)).toEqual({ median: 600, samples: 1 });
  });
});
