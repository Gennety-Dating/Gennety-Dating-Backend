/**
 * End-to-end simulation of the peer-aware calendar flow against the
 * local dev database. Runs the real `processCalendarSlotsUpdate` /
 * `getCalendarState` functions — the only thing stubbed out is the
 * grammY `Api`, replaced by a logger so we can see exactly what DMs
 * the bot would have sent (and to whom).
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/sim-calendar-flow.ts
 *
 * Each run scrubs and recreates two synthetic users with positive
 * `telegramId`s (Alice=901001, Bob=901002) and walks them through
 * three scenarios:
 *
 *   1. Alice marks 3 slots; Bob taps one of them → instant agree.
 *   2. Alice marks 3 slots; Bob marks 3 different slots → still
 *      negotiating, no DM spam.
 *   3. Alice marks 3 slots; Bob marks 3 with one overlap in the
 *      middle → earliest common slot wins.
 *
 * NOT for production. The seeded users have minimal profile data
 * and will be deleted/re-created on every run.
 */
// Load `.env.local` BEFORE importing `@gennety/db` — PrismaClient resolves
// `DATABASE_URL` at construction time, so the order matters.
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
const repoRoot = resolve(import.meta.dirname, "../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

const { prisma } = await import("@gennety/db");
const { startScheduling, processCalendarSlotsUpdate, getCalendarState } = await import(
  "../src/handlers/matching/scheduler.js"
);

const ALICE_TG_ID = 901001n;
const BOB_TG_ID = 901002n;

interface FakeApi {
  sendMessage(chatId: number, text: string, opts?: unknown): Promise<unknown>;
}

function createFakeApi(): { api: FakeApi; messages: Array<{ chatId: number; text: string }> } {
  const messages: Array<{ chatId: number; text: string }> = [];
  return {
    messages,
    api: {
      async sendMessage(chatId, text) {
        messages.push({ chatId, text });
        return undefined;
      },
    },
  };
}

function bar(): string {
  return "─".repeat(72);
}

function fmtSlot(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function visualiseGrid(
  proposed: string[],
  alice: string[],
  bob: string[],
  agreed: string | null,
): string {
  const A = new Set(alice);
  const B = new Set(bob);
  const lines: string[] = [];
  lines.push("    proposed slot                Alice  Bob   state");
  for (const iso of proposed) {
    const inA = A.has(iso);
    const inB = B.has(iso);
    const state =
      agreed === iso
        ? "🎉 AGREED"
        : inA && inB
          ? "🟢 overlap"
          : inA
            ? "🔵 alice"
            : inB
              ? "🟡 bob"
              : "⚪ empty";
    lines.push(
      `    ${fmtSlot(new Date(iso)).padEnd(28)}  ${inA ? "✓ " : "  "}    ${inB ? "✓ " : "  "}    ${state}`,
    );
  }
  return lines.join("\n");
}

async function dumpState(matchId: string, label: string): Promise<void> {
  const aState = await getCalendarState(ALICE_TG_ID, matchId);
  if (!aState.ok) {
    console.log(`  ${label}: getCalendarState failed → ${aState.reason}`);
    return;
  }
  const bState = await getCalendarState(BOB_TG_ID, matchId);
  if (!bState.ok) return;

  console.log(`\n  ${label}`);
  console.log(visualiseGrid(aState.proposedTimes, aState.mySlots, bState.mySlots, aState.agreedTime));
  console.log(`  Alice sees isFirstMover=${aState.isFirstMover}; Bob sees isFirstMover=${bState.isFirstMover}`);
  if (aState.agreedTime) {
    console.log(`  ✅ agreedTime = ${fmtSlot(new Date(aState.agreedTime))}`);
  }
}

async function seedUser(telegramId: bigint, firstName: string) {
  return prisma.user.upsert({
    where: { telegramId },
    create: {
      telegramId,
      firstName,
      universityDomain: "stanford.edu",
      language: "en",
      status: "active",
      onboardingStep: "completed",
      hasConsented: true,
      termsAccepted: true,
      isEmailVerified: true,
      gender: telegramId === ALICE_TG_ID ? "female" : "male",
      preference: "both",
      age: 22,
    },
    update: {
      status: "active",
      onboardingStep: "completed",
    },
    select: { id: true, telegramId: true, firstName: true },
  });
}

async function setupMatch(): Promise<{ matchId: string; aliceId: string; bobId: string }> {
  const alice = await seedUser(ALICE_TG_ID, "Alice");
  const bob = await seedUser(BOB_TG_ID, "Bob");

  // Wipe any previous match between the pair so each run starts clean.
  await prisma.match.deleteMany({
    where: {
      OR: [
        { userAId: alice.id, userBId: bob.id },
        { userAId: bob.id, userBId: alice.id },
      ],
    },
  });

  const match = await prisma.match.create({
    data: {
      userAId: alice.id,
      userBId: bob.id,
      status: "negotiating",
      // Decision tri-state: both accepted (mirroring real flow).
      acceptedByA: true,
      acceptedByB: true,
      dispatchedAt: new Date(),
    },
    select: { id: true },
  });

  return { matchId: match.id, aliceId: alice.id, bobId: bob.id };
}

async function scenario(
  name: string,
  body: (matchId: string, slots: string[], log: (s: string) => void) => Promise<void>,
): Promise<void> {
  console.log(`\n${bar()}\n  SCENARIO: ${name}\n${bar()}`);
  const { matchId } = await setupMatch();
  const fake = createFakeApi();

  await startScheduling(fake.api as never, matchId);
  console.log(`  ⤷ startScheduling done. Bot would have sent ${fake.messages.length} calendar buttons.`);
  for (const m of fake.messages) console.log(`     → DM chat=${m.chatId}: ${m.text.slice(0, 80)}`);

  const state = await getCalendarState(ALICE_TG_ID, matchId);
  if (!state.ok) {
    console.error(`  state load failed: ${state.reason}`);
    return;
  }
  const slots = state.proposedTimes;

  fake.messages.length = 0;
  await body(matchId, slots, (s) => console.log(`  ${s}`));

  if (fake.messages.length > 0) {
    console.log(`\n  Side-effect DMs during scenario:`);
    for (const m of fake.messages) console.log(`     → DM chat=${m.chatId}: ${m.text.slice(0, 80)}`);
  }
}

async function main(): Promise<void> {
  console.log(
    `\n${bar()}\n  Calendar flow simulation — using local dev DB\n${bar()}`,
  );

  // ── Scenario 1: instant agree on a peer's slot ─────────────────
  await scenario("Alice marks 3 slots, Bob taps one of them → INSTANT AGREE", async (matchId, slots, log) => {
    const fake = createFakeApi();
    log(`\n  Step 1: Alice (telegram=${ALICE_TG_ID}) marks slots [0, 2, 4]`);
    const aliceFirst = await processCalendarSlotsUpdate(
      fake.api as never,
      ALICE_TG_ID,
      matchId,
      [slots[0]!, slots[2]!, slots[4]!],
    );
    log(`    → ${JSON.stringify({ ok: aliceFirst.ok, agreedTime: aliceFirst.ok ? aliceFirst.agreedTime : null })}`);
    log(`    → fake bot DMed: ${fake.messages.length} (expecting 1: peer ping to Bob)`);
    for (const m of fake.messages) log(`         chat=${m.chatId}: ${m.text.slice(0, 70)}`);
    await dumpState(matchId, "Step 1 — after Alice's first submission");

    fake.messages.length = 0;
    log(`\n  Step 2: Bob (telegram=${BOB_TG_ID}) opens calendar — taps Alice's slot [2]`);
    const bobAgree = await processCalendarSlotsUpdate(
      fake.api as never,
      BOB_TG_ID,
      matchId,
      [slots[2]!],
    );
    log(`    → ${JSON.stringify({ ok: bobAgree.ok, agreedTime: bobAgree.ok ? bobAgree.agreedTime : null })}`);
    await dumpState(matchId, "Step 2 — after Bob taps Alice's slot");

    const finalMatch = await prisma.match.findUnique({
      where: { id: matchId },
      select: { status: true, agreedTime: true },
    });
    log(`\n  Final match status = ${finalMatch?.status}, agreedTime = ${finalMatch?.agreedTime?.toISOString() ?? "null"}`);
  });

  // ── Scenario 2: no overlap ─────────────────────────────────────
  await scenario("Alice marks [0,1,2], Bob marks [3,4,5] → NO OVERLAP, still negotiating", async (matchId, slots, log) => {
    const fake = createFakeApi();
    log(`\n  Step 1: Alice marks slots [0, 1, 2]`);
    await processCalendarSlotsUpdate(fake.api as never, ALICE_TG_ID, matchId, [slots[0]!, slots[1]!, slots[2]!]);
    log(`    → fake bot DMed: ${fake.messages.length} (expecting 1: peer ping to Bob)`);
    await dumpState(matchId, "Step 1 — only Alice has marked");

    fake.messages.length = 0;
    log(`\n  Step 2: Bob marks DIFFERENT slots [3, 4, 5]`);
    const bobRes = await processCalendarSlotsUpdate(fake.api as never, BOB_TG_ID, matchId, [slots[3]!, slots[4]!, slots[5]!]);
    log(`    → ${JSON.stringify({ ok: bobRes.ok, agreedTime: bobRes.ok ? bobRes.agreedTime : null })}`);
    log(`    → fake bot DMed: ${fake.messages.length} (expecting 0 — Alice already had availability, no first-mover trigger)`);
    await dumpState(matchId, "Step 2 — both marked, no overlap");

    const finalMatch = await prisma.match.findUnique({
      where: { id: matchId },
      select: { status: true, agreedTime: true },
    });
    log(`\n  Final match status = ${finalMatch?.status} (should still be 'negotiating')`);
  });

  // ── Scenario 3: multiple overlaps → earliest wins ──────────────
  await scenario("Alice marks [0,2,4], Bob marks [2,4,6] → TWO OVERLAPS, earliest (slot 2) wins", async (matchId, slots, log) => {
    const fake = createFakeApi();
    log(`\n  Step 1: Alice marks [0, 2, 4]`);
    await processCalendarSlotsUpdate(fake.api as never, ALICE_TG_ID, matchId, [slots[0]!, slots[2]!, slots[4]!]);
    await dumpState(matchId, "Step 1 — Alice's picks");

    fake.messages.length = 0;
    log(`\n  Step 2: Bob marks [2, 4, 6] — overlap on slots 2 and 4`);
    const bobRes = await processCalendarSlotsUpdate(fake.api as never, BOB_TG_ID, matchId, [slots[2]!, slots[4]!, slots[6]!]);
    log(`    → ${JSON.stringify({ ok: bobRes.ok, agreedTime: bobRes.ok ? bobRes.agreedTime : null })}`);

    if (bobRes.ok && bobRes.agreedTime) {
      log(`    → expected: agreed = ${slots[2]} (earliest common)`);
      log(`    → actual:   agreed = ${bobRes.agreedTime}`);
      log(`    → match: ${bobRes.agreedTime === slots[2] ? "✅" : "❌ MISMATCH"}`);
    }
    await dumpState(matchId, "Step 2 — after Bob's submission");

    const finalMatch = await prisma.match.findUnique({
      where: { id: matchId },
      select: { status: true, agreedTime: true },
    });
    log(`\n  Final match status = ${finalMatch?.status}, agreedTime = ${finalMatch?.agreedTime?.toISOString() ?? "null"}`);
  });

  console.log(`\n${bar()}\n  Done.\n${bar()}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    void prisma.$disconnect();
    process.exit(1);
  });
