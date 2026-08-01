#!/usr/bin/env node
// Subject-access / portability export for ONE user (GDPR Art. 15 + Art. 20).
//
//   pnpm gdpr:export -- --telegram=123456789
//   pnpm gdpr:export -- --user=<uuid> --prod
//   pnpm gdpr:export -- --email=someone@uni.edu --prod
//   pnpm gdpr:export -- --phone=+380991234567 --prod
//
// --prod loads production `.env` only (its DATABASE_URL wins). The output
// contains the subject's full personal data, so it is written OUTSIDE the repo
// and must be delivered over a channel the requester controls, then deleted.
//
// **Why this discovers tables instead of listing them.** A hand-written list is
// wrong the moment someone adds a table, and the failure is silent: the export
// looks complete and quietly omits a category. So every public table carrying a
// `user_id` column is found through `information_schema` and included
// automatically, and the few tables that reference a user by another key are
// enumerated explicitly below with a reason. Anything the script cannot
// classify is reported as SKIPPED with its name, so a new table shows up as a
// visible gap rather than an invisible one.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const PROD = process.argv.includes("--prod");

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

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

const selector = {
  user: arg("user"),
  telegram: arg("telegram"),
  email: arg("email"),
  phone: arg("phone"),
};
if (!selector.user && !selector.telegram && !selector.email && !selector.phone) {
  console.error(
    "Usage: pnpm gdpr:export -- --user=<uuid> | --telegram=<id> | --email=<addr> | --phone=<e164> [--prod]",
  );
  process.exit(1);
}

const dbHost = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/\/.*$/, "");
console.log(`\n▶ GDPR export — target DB host: ${dbHost || "(unset)"} ${PROD ? "[--prod]" : "[dev]"}`);

const { prisma } = await import("@gennety/db");

// ── Resolve the subject ────────────────────────────────────────────────────
const where = selector.user
  ? ["id = $1::uuid", selector.user]
  : selector.telegram
    ? ["telegram_id = $1::bigint", selector.telegram]
    : selector.email
      ? ["lower(email) = lower($1)", selector.email]
      : ["phone = $1", selector.phone];

const found = await prisma.$queryRawUnsafe(
  `SELECT id, telegram_id, email, phone, first_name FROM users WHERE ${where[0]}`,
  where[1],
);
if (found.length === 0) {
  console.error("✗ No user matched that selector. Nothing exported.");
  await prisma.$disconnect();
  process.exit(1);
}
if (found.length > 1) {
  console.error(`✗ ${found.length} users matched — refusing to guess. Use --user=<uuid>.`);
  await prisma.$disconnect();
  process.exit(1);
}
const subject = found[0];
const userId = subject.id;
console.log(`  subject: ${subject.first_name ?? "—"} (${userId})`);

// ── Discover which tables hold this user's rows ────────────────────────────
const allTables = (
  await prisma.$queryRawUnsafe(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
  )
).map((r) => r.table_name);

const columnsOf = async (table) =>
  prisma.$queryRawUnsafe(
    "SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name = $1 ORDER BY ordinal_position",
    table,
  );

/** `vector` cannot be deserialized by $queryRaw — cast it to text. */
const selectList = (cols) =>
  cols
    .map((c) =>
      c.udt_name === "vector"
        ? `"${c.column_name}"::text AS "${c.column_name}"`
        : `"${c.column_name}"`,
    )
    .join(", ");

/**
 * Tables that DO hold the subject's data but do not have a `user_id` column,
 * each with the predicate that finds their rows. Keep this list honest — an
 * entry removed here becomes a silent omission from every future export.
 */
const SPECIAL = {
  // The subject IS the row.
  users: () => ["id = $1::uuid", [userId]],
  // A match is shared between two people; both sides are the subject's data.
  matches: () => ["user_a_id = $1::uuid OR user_b_id = $1::uuid", [userId]],
  // Keyed by the contact rail, not by user — the funnel starts before a row
  // exists, which is exactly why the retention sweep has to cover them too.
  email_otps: () =>
    subject.email ? ["lower(email) = lower($1)", [subject.email]] : null,
  phone_otps: () => (subject.phone ? ["phone = $1", [subject.phone]] : null),
  // Free-form ids, no FK (mirrors how the tables are documented).
  rematch_purchases: () => ["user_id = $1::uuid", [userId]],
  venue_change_purchases: () => ["user_id = $1::uuid", [userId]],
  // Both sides of an event are the subject's data: what they did, and what was
  // done to them (an "ignored you" counter is about the target, not the actor).
  match_events: () => ["actor_id = $1::uuid OR target_id = $1::uuid", [userId]],
  // Relayed pre-date chat — the subject's own messages only. The partner's
  // half of that conversation is the PARTNER's personal data, and handing it
  // over would be a disclosure, not an access request.
  proxy_messages: () => ["sender_id = $1::uuid", [userId]],
  // Reports the subject filed AND reports filed about them. The latter is
  // theirs under Art. 15 — but `raw_text` is another user's account of events,
  // so it is redacted on that side below rather than shipped verbatim.
  reports: () => ["reporter_id = $1::uuid OR reported_id = $1::uuid", [userId]],
  // No user column — reachable only through the subject's matches.
  match_score_logs: () => [
    `match_id IN (SELECT id FROM matches WHERE user_a_id = $1::uuid OR user_b_id = $1::uuid)`,
    [userId],
  ],
  // grammY's session store, keyed by Telegram chat id as a bare string.
  bot_sessions: () =>
    subject.telegram_id ? ["key = $1", [String(subject.telegram_id)]] : null,
};

/**
 * Tables that legitimately contain nothing about a specific subject. Listed so
 * the "skipped" report stays short and every genuinely unclassified table is
 * visible.
 */
const NOT_PERSONAL = new Set([
  "curated_venues",
  "system_knowledge",
  "promo_codes",
  "venue_selection_logs",
  "_prisma_migrations",
  // Handled separately at the bottom: the subject appears inside a JSON
  // snapshot alongside OTHER users' profiles, so presence is reported rather
  // than the rows being dumped.
  "founder_reports",
]);

const exported = {};
const skipped = [];
let totalRows = 0;

for (const table of allTables) {
  const cols = await columnsOf(table);
  const names = new Set(cols.map((c) => c.column_name));

  let predicate = null;
  if (SPECIAL[table]) {
    predicate = SPECIAL[table]();
    if (predicate === null) {
      // e.g. no email on file → that OTP table genuinely holds nothing.
      exported[table] = [];
      continue;
    }
  } else if (names.has("user_id")) {
    predicate = ["user_id = $1::uuid", [userId]];
  } else if (NOT_PERSONAL.has(table)) {
    continue;
  } else {
    skipped.push(table);
    continue;
  }

  const [sql, params] = predicate;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${selectList(cols)} FROM "${table}" WHERE ${sql}`,
    ...params,
  );
  exported[table] = redactOthersData(table, rows);
  totalRows += rows.length;
  if (rows.length > 0) console.log(`  ${table}: ${rows.length}`);
}

/**
 * Art. 15(4): the right of access "shall not adversely affect the rights and
 * freedoms of others". Two places where the subject's row carries someone
 * else's personal data, and shipping it verbatim would be a disclosure rather
 * than an access response.
 */
function redactOthersData(table, rows) {
  if (table !== "reports") return rows;
  return rows.map((row) => {
    if (row.reporter_id === userId) return row; // their own report, verbatim
    // A report ABOUT the subject: they are entitled to know it exists, its
    // tier and its outcome, but the free text is another user's account of
    // events and often identifies them.
    return {
      ...row,
      reporter_id: "[redacted — another user]",
      raw_text: "[redacted — another user's free-text account, Art. 15(4)]",
      reason_summary: "[redacted — Art. 15(4)]",
    };
  });
}

// `founder_reports` has no user column at all — the subject appears inside a
// JSON snapshot. Report presence rather than dumping other people's pairs.
const founderHits = (
  await prisma.$queryRawUnsafe(
    "SELECT id, week_of, created_at FROM founder_reports WHERE data_json::text LIKE $1",
    `%${userId}%`,
  )
).map((r) => ({ id: r.id, weekOf: r.week_of, createdAt: r.created_at }));

const out = {
  _meta: {
    generatedAt: new Date().toISOString(),
    subjectId: userId,
    lawfulBasis: "GDPR Art. 15 (access) and Art. 20 (portability)",
    note:
      "Contains the full personal data held for one subject. Deliver over a channel " +
      "the requester controls, then delete this file. Photos and the verification " +
      "selfie are referenced by storage path / Telegram file_id, not embedded — " +
      "fetch those separately if the request asks for the images themselves.",
    skippedTables: skipped,
    founderReportsContainingSubject: founderHits,
  },
  data: exported,
};

const outPath =
  process.env.GDPR_EXPORT_OUT ||
  resolve(root, "..", `gdpr-export-${userId}-${new Date().toISOString().slice(0, 10)}.json`);

writeFileSync(
  outPath,
  JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2),
);

console.log(`\n✓ Export written: ${outPath}`);
console.log(`  tables with rows=${Object.values(exported).filter((r) => r.length).length} rows=${totalRows}`);
if (founderHits.length > 0) {
  console.log(`  ⚠ subject appears in ${founderHits.length} founder report snapshot(s)`);
}
if (skipped.length > 0) {
  console.log(`  ⚠ UNCLASSIFIED tables (check whether they hold subject data): ${skipped.join(", ")}`);
}
await prisma.$disconnect();
