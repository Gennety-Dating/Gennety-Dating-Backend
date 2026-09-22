import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deploy preflight guard: fail loudly when the target database schema does not
// match packages/db/prisma/schema.prisma. Run BEFORE `pm2 restart` on a full
// deploy — it converts the silent P2022 "missing column" crash-loop (deploy.md
// → "Schema drift is a real failure mode") into a clean pre-restart stop.
//
// Read-only: it introspects the target DB's schema via `prisma migrate diff`
// and never writes. Point it at any DB by exporting DATABASE_URL first, e.g.
//   export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '\"')"
//   pnpm db:drift-check
// Exit codes: 0 = schema matches (safe to restart; FOREIGN_TABLES below are
// tolerated); 2 = DRIFT (a migration is missing — write it, db:deploy, re-check;
// demo still uses db:push); 1 = misconfiguration / connectivity error.
//
// The DB URL is passed to prisma via --from-schema-datasource (the datasource's
// env("DATABASE_URL")), NEVER via --from-url: --from-url puts the password on
// the command line, where `ps` and pnpm's failure echo would leak it.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbDir = path.join(repoRoot, "packages", "db");

if (!process.env.DATABASE_URL) {
  console.error(
    "db:drift-check: DATABASE_URL is not set. Export the target DB URL first, e.g.\n" +
      "  export DATABASE_URL=\"$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '\\\"')\"",
  );
  process.exit(1);
}

// Prefer the workspace-local prisma binary (pnpm's isolated node_modules puts it
// here, same path the deploy uses); fall back to a PATH lookup.
const localBin = path.join(dbDir, "node_modules", ".bin", "prisma");
const prismaCmd = existsSync(localBin) ? localBin : "prisma";

// Tables that live in the production database but are NOT ours: no model in
// schema.prisma, no migration, never referenced by the code. Found by the
// 2026-09-22 deploy (canvas_* — written by some other app after the 2026-09-07
// baseline, with rows in them). An extra table cannot crash the Prisma client,
// so the only diff they produce — `DROP TABLE` — is reported and tolerated; any
// other statement is still DRIFT. They are never dropped from here: whose they
// are is the founder's question, not the deploy's.
const FOREIGN_TABLES = [
  "canvas_audit_logs",
  "canvas_project_shares",
  "canvas_project_versions",
  "canvas_projects",
  "canvas_workspaces",
];

let status = 0;
let script = "";
try {
  script = execFileSync(
    prismaCmd,
    [
      "migrate",
      "diff",
      "--from-schema-datasource",
      "prisma/schema.prisma",
      "--to-schema-datamodel",
      "prisma/schema.prisma",
      "--script",
      "--exit-code",
    ],
    { cwd: dbDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  status = 0;
} catch (err) {
  status = typeof err?.status === "number" ? err.status : 1;
  script = typeof err?.stdout === "string" ? err.stdout : "";
}

const statements = script
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("--"));
const foreignDrops = statements.filter((line) =>
  FOREIGN_TABLES.some((table) => line === `DROP TABLE "${table}";`),
);
const unexpected = statements.filter((line) => !foreignDrops.includes(line));

if (status === 0 || (status === 2 && unexpected.length === 0)) {
  console.log(
    foreignDrops.length > 0
      ? `db:drift-check: OK — schema matches; ${foreignDrops.length} foreign table(s) ` +
          "not managed by Prisma are present and left alone (FOREIGN_TABLES)."
      : "db:drift-check: OK — target database matches prisma/schema.prisma.",
  );
} else if (status === 2) {
  console.error(
    "db:drift-check: DRIFT DETECTED — the target database does not match " +
      "prisma/schema.prisma:\n" +
      unexpected
        .slice(0, 40)
        .map((line) => `  ${line}`)
        .join("\n") +
      "\nProduction runs on migrations: write the missing migration and apply it with " +
      "`pnpm --filter @gennety/db db:deploy`\n(never `db:push` against prod) BEFORE " +
      "restarting the bot, otherwise the freshly generated Prisma client\ncrashes " +
      "with P2022 on the first query that reads a column the database is missing.",
  );
  process.exitCode = 2;
} else {
  console.error(
    `db:drift-check: \`prisma migrate diff\` failed (exit ${status}). ` +
      "Check DATABASE_URL and connectivity to the target database.",
  );
  process.exitCode = 1;
}
