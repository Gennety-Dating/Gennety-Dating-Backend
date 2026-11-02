/**
 * Server-side timings for the 2026-11 screenshot/ideas audit. Synthetic rows in
 * the LOCAL test database only; it truncates `users`, so it refuses any other URL.
 *
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test \
 *   BOT_TOKEN=x OPENAI_API_KEY= pnpm --filter @gennety/bot exec tsx evals/screenshot-audit/bench.ts
 *
 * Prints, per scenario, wall time of each run. With `log_statement = all` on the
 * test server, the statements of one run are the log lines between its two
 * `bench-mark:` markers (see the audit report for the command). No model, no
 * storage: the indexer gets an empty queue.
 */
import { prisma } from "@gennety/db";

const url = process.env.DATABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(url) || !url.includes("gennety_test")) {
  console.error("Refusing: DATABASE_URL must be the local gennety_test database.");
  process.exit(2);
}

const { reconcilePlans } = await import("../../src/services/memory-planning.js");
const { indexBatch } = await import("../../src/workers/screenshot-library.js");

const RUNS = Number(process.env.BENCH_RUNS ?? 5);

/** A marker in the server log: count statements between two with `log_statement = all`. */
async function mark(label: string): Promise<void> {
  await prisma.$executeRawUnsafe(`SELECT 'bench-mark:${label}'`);
}

async function measure(name: string, run: () => Promise<unknown>): Promise<void> {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    await mark(`${name}#${i}:start`);
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
    await mark(`${name}#${i}:end`);
  }
  const sorted = [...times].sort((x, y) => x - y);
  console.log(`${name}: runs=${RUNS} ms=[${times.map((t) => t.toFixed(1)).join(", ")}] median=${sorted[Math.floor(RUNS / 2)]!.toFixed(1)}`);
}

async function seedUsers(count: number, from: number): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`
    INSERT INTO users (id, telegram_id, created_at, updated_at)
    SELECT gen_random_uuid(), ${from} + g, NOW(), NOW() FROM generate_series(1, ${count}) g
    RETURNING id`);
  return rows.map((r) => r.id);
}

await prisma.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");

/* 1. reconcilePlans with 200 booked dates, nothing left to plan. */
const people = await seedUsers(400, 880000000);
for (let i = 0; i < 200; i++) {
  const [x, y] = [people[2 * i]!, people[2 * i + 1]!];
  await prisma.$executeRawUnsafe(`
    INSERT INTO matches (id, user_a_id, user_b_id, status, venue_place_id, agreed_time, created_at, updated_at)
    VALUES (gen_random_uuid(), '${x}'::uuid, '${y}'::uuid, 'scheduled', 'place-${i}', NOW() + interval '2 days', NOW(), NOW())`);
}
await measure("reconcilePlans, 200 scheduled dates", () => reconcilePlans());

/* 2. An indexer tick with an empty queue over a large table. */
await seedUsers(Number(process.env.BENCH_LIBRARIES ?? 100), 880000400);
await prisma.$executeRawUnsafe(`
  INSERT INTO screenshot_libraries (user_id, status, generation, auto_import, consent_at, consent_version, updated_at)
  SELECT id, 'active', 1, true, NOW(), 'bench', NOW() FROM users WHERE telegram_id >= 880000401`);
await prisma.$executeRawUnsafe(`
  INSERT INTO screenshot_items (id, user_id, generation, source, source_key, content_hash, storage_path, state, indexed_at, updated_at)
  SELECT gen_random_uuid(), u.id, 1, 'auto', 'k' || g, md5(u.id::text || g), u.id || '/' || g, 'ready',
         NOW() - (g % 72) * interval '1 hour', NOW()
  FROM users u, generate_series(1, 2000) g WHERE u.telegram_id >= 880000401`);
await prisma.$executeRawUnsafe("ANALYZE screenshot_items");
const total = await prisma.screenshotItem.count();
await measure(`indexBatch, empty queue, ${total} rows`, () => indexBatch());

await prisma.$executeRawUnsafe("TRUNCATE TABLE users CASCADE");
await prisma.$disconnect();
