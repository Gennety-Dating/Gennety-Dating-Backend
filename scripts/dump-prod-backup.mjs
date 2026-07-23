#!/usr/bin/env node
// One-shot logical backup of the target DB to a JSON file. No pg_dump needed —
// dumps every public table via raw `SELECT *`, so it is drift-proof: raw SQL
// returns the columns that actually exist, independent of the (possibly newer)
// generated Prisma client. Used as the safety net before a
// `db:push --accept-data-loss` schema reconciliation.
//
//   pnpm --filter @gennety/bot exec tsx ../../scripts/dump-prod-backup.mjs --prod
//
// --prod loads production `.env` only (its DATABASE_URL wins). Output path is
// printed at the end. The dump contains PII, so it is written outside the repo.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const PROD = process.argv.includes("--prod");

function loadEnvFile(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

if (PROD) {
  loadEnvFile(resolve(root, ".env"), true);
} else {
  loadEnvFile(resolve(root, ".env.local"), true);
  loadEnvFile(resolve(root, ".env"), false);
}

const outPath =
  process.env.BACKUP_OUT ||
  resolve(root, `prod-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const dbHost = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
console.log(`\n▶ Logical backup — target DB host: ${dbHost || "(unset)"} ${PROD ? "[--prod]" : "[dev]"}`);

const { prisma } = await import("@gennety/db");

const meta = await prisma.$queryRawUnsafe(
  "SELECT current_database() AS db, current_setting('server_version') AS version",
);
const [{ n: userCount }] = await prisma.$queryRawUnsafe("SELECT count(*)::int AS n FROM users");
console.log(`  database=${meta[0].db} pg=${meta[0].version} users=${userCount}`);
if (userCount === 0) {
  console.error("✗ users table is empty — this looks like the dev DB, refusing to write a prod backup. Pass --prod against production.");
  await prisma.$disconnect();
  process.exit(1);
}

const tables = await prisma.$queryRawUnsafe(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
);

const dump = { _meta: { takenAt: new Date().toISOString(), database: meta[0].db, pg: meta[0].version } };
let total = 0;
for (const { table_name } of tables) {
  // Build a column-aware SELECT so a `vector` column (Unsupported in Prisma) is
  // cast to text — $queryRaw cannot deserialize the raw vector type otherwise.
  const cols = await prisma.$queryRawUnsafe(
    "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name = $1 ORDER BY ordinal_position",
    table_name,
  );
  const selectList = cols
    .map((c) =>
      c.udt_name === "vector"
        ? `"${c.column_name}"::text AS "${c.column_name}"`
        : `"${c.column_name}"`,
    )
    .join(", ");
  const rows = await prisma.$queryRawUnsafe(`SELECT ${selectList} FROM "${table_name}"`);
  dump[table_name] = rows;
  total += rows.length;
  console.log(`  ${table_name}: ${rows.length}`);
}

writeFileSync(outPath, JSON.stringify(dump, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(`\n✓ Backup written: ${outPath}`);
console.log(`  tables=${tables.length} rows=${total}`);
await prisma.$disconnect();
