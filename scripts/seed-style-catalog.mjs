#!/usr/bin/env node
/**
 * Vibe Check catalog seeder (decision journal 2026-10-08).
 *
 * `scripts/style-catalog.json` is the source of truth for `style_products`;
 * the database is never edited by hand. The file is validated with the same
 * rules the service reads rows with (`catalogItemProblems`), so a typo fails
 * here instead of silently dropping a card.
 *
 *   pnpm seed-style:import            # dry run: validate + show what would change
 *   pnpm seed-style:import --apply    # upsert every item on its slug
 *
 * Idempotent: an item is upserted on its id; a product that has left the file
 * is set `active = false` (never deleted — clicks reference its id).
 *
 * Targets whatever DATABASE_URL resolves to: an explicit shell export wins,
 * then `.env.local` (dev), then `.env` (prod) — the rule of `seed-venues.mjs`.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const SHELL_ENV = new Set(Object.keys(process.env));

function loadEnvFile(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim().replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if ((override && !SHELL_ENV.has(key)) || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const apply = process.argv.includes("--apply");
const inArg = process.argv.find((a) => a.startsWith("--in="))?.slice(5);
const file = inArg ? (isAbsolute(inArg) ? inArg : resolve(root, inArg)) : resolve(root, "scripts/style-catalog.json");

const { catalogItemProblems } = await import("../apps/bot/src/services/style-picks/catalog.js");

const items = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(items)) {
  console.error("✗ the catalog file must be a JSON array");
  process.exit(1);
}
const ids = new Set();
let bad = 0;
for (const item of items) {
  const problems = catalogItemProblems(item);
  if (ids.has(item?.id)) problems.push("duplicate id");
  ids.add(item?.id);
  if (problems.length > 0) {
    bad += 1;
    console.error(`✗ ${item?.id ?? "(no id)"}: ${problems.join("; ")}`);
  }
}
if (bad > 0) {
  console.error(`✗ ${bad} invalid item(s) — nothing written`);
  process.exit(1);
}

const { prisma, Prisma } = await import("@gennety/db");
try {
  const existing = await prisma.styleProduct.findMany({ select: { id: true, active: true } });
  const retired = existing.filter((row) => row.active && !ids.has(row.id)).map((row) => row.id);
  const fresh = items.filter((item) => !existing.some((row) => row.id === item.id)).length;
  console.log(
    `${items.length} item(s) in ${file}: ${fresh} new, ${items.length - fresh} updated, ${retired.length} to deactivate`,
  );
  if (!apply) {
    console.log("dry run — pass --apply to write");
  } else {
    for (const item of items) {
      const data = {
        category: item.category,
        brand: item.brand,
        name: item.name,
        gender: item.gender,
        priceTier: item.priceTier,
        priceEUR: item.priceEUR,
        notes: item.notes,
        tags: item.tags,
        url: item.url,
        urlUA: item.urlUA ?? null,
        imageUrl: item.imageUrl ?? null,
        sponsored: item.sponsored,
        affiliateParams: item.affiliateParams ?? Prisma.DbNull,
        badges: item.badges,
        active: item.active,
      };
      await prisma.styleProduct.upsert({ where: { id: item.id }, create: { id: item.id, ...data }, update: data });
    }
    if (retired.length > 0) {
      await prisma.styleProduct.updateMany({ where: { id: { in: retired } }, data: { active: false } });
    }
    console.log(`✓ upserted ${items.length}, deactivated ${retired.length}`);
  }
} finally {
  await prisma.$disconnect();
}
