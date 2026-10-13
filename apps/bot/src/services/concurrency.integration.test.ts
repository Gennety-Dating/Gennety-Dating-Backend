/**
 * Two people acting on one match in the same instant — against a real
 * PostgreSQL, because the property under test is row locking, which a mocked
 * Prisma client cannot express.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test \
 *     pnpm --filter @gennety/db db:push
 */

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import type { Api, RawApi } from "grammy";
import { t } from "@gennety/shared";
import {
  integrationPrisma,
  cleanDatabase,
  seedUser,
  seedProfile,
} from "../../../../packages/db/src/test-integration.js";
import { processCalendarSlotsUpdate } from "../handlers/matching/scheduler.js";
import { cancelStalledMatch, STALL_TIMEOUT_MS } from "./match-stall.js";

const HOUR = 60 * 60 * 1000;

/** A grid slot comfortably past the five-hour lead, at midday UTC. */
function middaySlot(daysAhead: number): Date {
  const d = new Date(Date.now() + daysAhead * 24 * HOUR);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

function fakeApi() {
  let nextId = 1000;
  return {
    sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
    sendPhoto: vi.fn(async () => ({ message_id: nextId++ })),
    deleteMessage: vi.fn(async () => true),
    editMessageText: vi.fn(async () => true),
    sendMessageDraft: vi.fn(async () => true),
  };
}

async function seedPlanningPair(data: Record<string, unknown>) {
  const userA = await seedUser({ gender: "male", preference: "women" });
  const userB = await seedUser({ gender: "female", preference: "men" });
  await seedProfile({ userId: userA.id });
  await seedProfile({ userId: userB.id });
  const match = await integrationPrisma.match.create({
    data: {
      userAId: userA.id,
      userBId: userB.id,
      status: "negotiating",
      acceptedByA: true,
      acceptedByB: true,
      ...data,
    },
  });
  return { match, userA, userB };
}

describe("simultaneous calendar saves", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await integrationPrisma.$disconnect();
  });

  it("both pick the same slot in the same instant: one lock, one announcement", async () => {
    const x = middaySlot(2);
    const y = middaySlot(3);
    const { match, userA, userB } = await seedPlanningPair({
      proposedTimes: [x, y],
      schedulingOpenedAt: new Date(),
    });
    const api = fakeApi();

    const [resA, resB] = await Promise.all([
      processCalendarSlotsUpdate(api as unknown as Api<RawApi>, userA.telegramId, match.id, [x.toISOString()]),
      processCalendarSlotsUpdate(api as unknown as Api<RawApi>, userB.telegramId, match.id, [x.toISOString()]),
    ]);

    // Neither save is told "stale". Serialised, the first one in finds no
    // partner pick yet; the second one finds it and locks.
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(true);
    const agreedTimes = [resA, resB].map((r) => (r.ok ? r.agreedTime : null));
    expect(agreedTimes).toContain(x.toISOString());

    const row = await integrationPrisma.match.findUniqueOrThrow({ where: { id: match.id } });
    expect(row.status).toBe("negotiating_venue");
    expect(row.agreedTime?.getTime()).toBe(x.getTime());

    // The venue prompt went out once per person, not once per save.
    const intro = t("en", "venueConciergeIntro");
    const intros = api.sendMessage.mock.calls.filter((c) => (c as unknown[])[1] === intro);
    expect(intros).toHaveLength(2);
  });

  it("the same person saving from two surfaces at once: both answers say agreed, one announcement", async () => {
    const x = middaySlot(2);
    const { match, userA } = await seedPlanningPair({
      proposedTimes: [x],
      schedulingOpenedAt: new Date(),
      availableTimesB: [x],
    });
    const api = fakeApi();
    const save = () =>
      processCalendarSlotsUpdate(api as unknown as Api<RawApi>, userA.telegramId, match.id, [x.toISOString()]);

    const [first, second] = await Promise.all([save(), save()]);

    // The one that lost the claim used to answer `wrong-state` (409 → an error
    // screen over a date that had just been agreed).
    expect(first).toMatchObject({ ok: true, agreedTime: x.toISOString() });
    expect(second).toMatchObject({ ok: true, agreedTime: x.toISOString() });
    const intro = t("en", "venueConciergeIntro");
    expect(api.sendMessage.mock.calls.filter((c) => (c as unknown[])[1] === intro)).toHaveLength(2);
  });

  it("never locks a slot that is not in BOTH stored selections, however the saves interleave", async () => {
    const slots = [middaySlot(2), middaySlot(3), middaySlot(4)];
    for (let round = 0; round < 8; round++) {
      await cleanDatabase();
      const { match, userA, userB } = await seedPlanningPair({
        proposedTimes: slots,
        schedulingOpenedAt: new Date(),
        // B starts out offering everything; the racing saves below narrow it.
        availableTimesB: slots,
      });
      const api = fakeApi() as unknown as Api<RawApi>;
      const iso = (d: Date) => d.toISOString();

      await Promise.all([
        processCalendarSlotsUpdate(api, userA.telegramId, match.id, [iso(slots[0]!)]),
        processCalendarSlotsUpdate(api, userB.telegramId, match.id, [iso(slots[1]!), iso(slots[2]!)]),
        processCalendarSlotsUpdate(api, userA.telegramId, match.id, [iso(slots[1]!)]),
        processCalendarSlotsUpdate(api, userB.telegramId, match.id, [iso(slots[0]!)]),
      ]);

      const row = await integrationPrisma.match.findUniqueOrThrow({ where: { id: match.id } });
      if (row.status === "negotiating_venue") {
        const agreed = row.agreedTime!.getTime();
        // Whatever won, it is a time both people still had marked when it locked.
        expect(row.availableTimesA.map((d) => d.getTime())).toContain(agreed);
        expect(row.availableTimesB.map((d) => d.getTime())).toContain(agreed);
      } else {
        expect(row.status).toBe("negotiating");
        expect(row.agreedTime).toBeNull();
      }
    }
  });
});

describe("an answer that lands while the 48h cancellation is deciding", () => {
  beforeEach(async () => {
    await cleanDatabase();
  });

  it("waits for the answer and does not penalise the person who just gave it", async () => {
    const x = middaySlot(2);
    const { match, userA, userB } = await seedPlanningPair({
      proposedTimes: [x],
      // Both sides' 48h ran out a little while ago.
      schedulingOpenedAt: new Date(Date.now() - STALL_TIMEOUT_MS - HOUR),
    });

    // A's calendar save is mid-flight: it holds the row (as every calendar save
    // now does) and has written A's slot, not yet committed.
    let releaseAnswer!: () => void;
    const answerHeld = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    let answerWritten!: () => void;
    const written = new Promise<void>((resolve) => {
      answerWritten = resolve;
    });
    const answer = integrationPrisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe("SELECT id FROM matches WHERE id = $1::uuid FOR UPDATE", match.id);
        await tx.match.update({ where: { id: match.id }, data: { availableTimesA: [x] } });
        answerWritten();
        await answerHeld;
      },
      { timeout: 15_000 },
    );
    await written;

    const cancellation = cancelStalledMatch(fakeApi() as unknown as Api<RawApi>, match.id);
    // Give the worker every chance to read the stale row, if it could.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseAnswer();
    await answer;
    const result = await cancellation;

    // B really did go quiet, so the match still ends — but A answered, and is
    // neither blamed nor penalised for it.
    expect(result.cancelled).toBe(true);
    expect(result.ghostUserIds).toEqual([userB.id]);
    expect(result.waitingUserIds).toEqual([userA.id]);
    const profileA = await integrationPrisma.profile.findUniqueOrThrow({ where: { userId: userA.id } });
    expect(profileA.silentIgnoreCount).toBe(0);
  });
});
