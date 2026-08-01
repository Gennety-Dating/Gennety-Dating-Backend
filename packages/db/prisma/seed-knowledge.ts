import { PrismaClient } from "@prisma/client";

/**
 * `system_knowledge` seeding.
 *
 * **This file no longer seeds product rules, and that is the point.** It used
 * to carry five rows describing photo limits, the emergency window, the
 * verification rail and the scheduling flow — and every one of them drifted
 * away from the product, silently, because nothing ties a DB row to the code
 * it describes. Production was still serving "minimum 2 photos, maximum 4"
 * (really 3/10), "3 hours before the date" (really 5), "all users must verify
 * a university email" (false since Registration v2's phone track) and "AI
 * proposes times, then calendar if needed" (that flow was removed 2026-05-07).
 * The repo copy had already been half-corrected, which made it worse: two
 * versions of the same wrong thing.
 *
 * Product knowledge now lives in `apps/bot/src/services/product-playbook.ts` —
 * code-owned, flag-aware, unit-tested, and reviewed alongside the behaviour it
 * describes. `system_knowledge` remains ONLY as an extension point for genuine
 * operator notes that have no home in code (a temporary launch caveat, a
 * support instruction). It is deliberately empty by default.
 *
 * `zero_chat_philosophy` is retired for the same reason as the rest: it
 * asserts users "NEVER message each other through our platform", which stopped
 * being unconditionally true once the pre-date proxy chat shipped
 * (PRODUCT_SPEC §Phase 4). The playbook states the carve-out correctly.
 *
 * NOTE: rows under `admin_cache:*` in this table are the admin dashboard's
 * analytics cache, not knowledge. `fetchKnowledgeBase` excludes them; never
 * add them here.
 */

const prisma = new PrismaClient();

/** Operator notes to (re)create. Empty by design — see the header. */
const entries: Array<{
  key: string;
  title: string;
  category: string;
  priority: number;
  content: string;
}> = [];

/**
 * Legacy product-rule rows to switch OFF wherever this runs.
 *
 * Deactivated rather than deleted so the historical content stays inspectable
 * and re-running is idempotent. `fetchKnowledgeBase` filters on `active`, so
 * flipping the flag is what actually removes them from the agent's prompt.
 */
const RETIRED_KEYS = [
  "zero_chat_philosophy",
  "match_timing_faq",
  "profile_rules",
  "emergency_protocol",
  "university_verification",
];

async function main() {
  console.log("Seeding system_knowledge...");

  for (const entry of entries) {
    await prisma.systemKnowledge.upsert({
      where: { key: entry.key },
      create: entry,
      update: {
        title: entry.title,
        content: entry.content,
        category: entry.category,
        priority: entry.priority,
        active: true,
      },
    });
    console.log(`  ✓ ${entry.key}`);
  }

  const retired = await prisma.systemKnowledge.updateMany({
    where: { key: { in: RETIRED_KEYS }, active: true },
    data: { active: false },
  });
  console.log(`  ✓ retired ${retired.count} legacy product-rule row(s)`);

  console.log("Done.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
