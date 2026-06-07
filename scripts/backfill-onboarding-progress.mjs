#!/usr/bin/env node
/**
 * Backfill server-owned onboarding progress from canonical DB fields and raw
 * user-authored chat messages. Dry-run by default; pass --apply to persist.
 *
 * Output is aggregate-only and contains no Telegram IDs, names, messages, or
 * other personal data.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function loadEnv(path, override) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim().replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (override || process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv(resolve(root, ".env.local"), true);
loadEnv(resolve(root, ".env"), false);

const apply = process.argv.includes("--apply");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const parsedLimit = Number(limitArg?.slice("--limit=".length) ?? "0");
const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

const { prisma } = await import("@gennety/db");
const { collectOnboardingInput } = await import(
  "../apps/bot/src/services/onboarding-collector.ts"
);

try {
  const users = await prisma.user.findMany({
    where: {
      onboardingStep: "conversational",
      status: "onboarding",
    },
    orderBy: { createdAt: "asc" },
    ...(limit ? { take: limit } : {}),
    select: {
      telegramId: true,
      onboardingProgress: {
        select: { backfilledAt: true },
      },
    },
  });

  const pending = users.filter((user) => !user.onboardingProgress?.backfilledAt);
  const summary = {
    mode: apply ? "apply" : "dry-run",
    eligible: users.length,
    alreadyBackfilled: users.length - pending.length,
    pending: pending.length,
    applied: 0,
    failed: 0,
    nextQuestions: {},
  };

  if (apply) {
    for (const user of pending) {
      try {
        const snapshot = await collectOnboardingInput(user.telegramId, {
          kind: "resume",
        });
        summary.applied += 1;
        summary.nextQuestions[snapshot.currentQuestion] =
          (summary.nextQuestions[snapshot.currentQuestion] ?? 0) + 1;
      } catch {
        summary.failed += 1;
      }
    }
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!apply) {
    console.log("Dry run only. Re-run with --apply to persist the backfill.");
  }
  if (summary.failed > 0) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
