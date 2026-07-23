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
// Exit codes: 0 = schema matches (safe to restart); 2 = DRIFT (run db:push
// first); 1 = misconfiguration / connectivity error.
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

let status = 0;
try {
  execFileSync(
    prismaCmd,
    [
      "migrate",
      "diff",
      "--from-schema-datasource",
      "prisma/schema.prisma",
      "--to-schema-datamodel",
      "prisma/schema.prisma",
      "--exit-code",
    ],
    { cwd: dbDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  status = 0;
} catch (err) {
  status = typeof err?.status === "number" ? err.status : 1;
}

if (status === 0) {
  console.log("db:drift-check: OK — target database matches prisma/schema.prisma.");
} else if (status === 2) {
  console.error(
    "db:drift-check: DRIFT DETECTED — the target database does not match " +
      "prisma/schema.prisma.\n" +
      "Run `pnpm --filter @gennety/db db:push` (see deploy.md) BEFORE restarting " +
      "the bot,\notherwise the freshly generated Prisma client crashes with P2022 " +
      "on the first query\nthat reads a column the database is missing.",
  );
  process.exitCode = 2;
} else {
  console.error(
    `db:drift-check: \`prisma migrate diff\` failed (exit ${status}). ` +
      "Check DATABASE_URL and connectivity to the target database.",
  );
  process.exitCode = 1;
}
