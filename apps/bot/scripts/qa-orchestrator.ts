/**
 * Local-dev E2E QA orchestrator for two real Telegram accounts.
 *
 * Watches a fixed QA pair in @gennetytestbot and advances only the gaps that
 * are awkward to trigger manually:
 *   - both users active + onboarding completed -> create/dispatch a proposal
 *   - mutual accept stuck without calendar slots -> restart scheduling
 *   - scheduled date -> compress time to exercise icebreakers, safety,
 *     wingman, and post-date feedback prompts
 *
 * It deliberately does not tap Accept/Decline, choose calendar slots, pick a
 * venue, cancel, report, or submit feedback for the user. Those remain real
 * Telegram/Mini App actions during QA.
 *
 * Usage:
 *   pnpm --filter @gennety/bot exec tsx scripts/qa-orchestrator.ts \
 *     <telegramIdA> <telegramIdB>
 *
 * Useful flags:
 *   --dry-run
 *   --once
 *   --interval-ms=5000
 *   --max-proposals=12
 *   --reseed-delay-ms=120000
 *   --lifecycle-dwell-ms=90000
 *   --no-auto-lifecycle
 *   --reseed-after-completed
 *
 * NOT for production.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Api as GrammyApi, RawApi } from "grammy";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../..");
const localEnv = resolve(repoRoot, ".env.local");
if (existsSync(localEnv)) loadEnv({ path: localEnv });
loadEnv({ path: resolve(repoRoot, ".env") });

const { Api } = await import("grammy");
const { prisma } = await import("@gennety/db");
const { dispatchMatches } = await import("../src/services/dispatch-queue.js");
const { runDateLifecycleTick } = await import("../src/services/date-lifecycle.js");
const { runPreDateSafetyTick } = await import("../src/services/pre-date-safety.js");
const { startScheduling } = await import("../src/handlers/matching/scheduler.js");
const {
  DATE_ALERT_HOURS,
  FEEDBACK_DELAY_HOURS,
  PRE_DATE_WINGMAN_HOURS,
} = await import("@gennety/shared");

type BotApi = GrammyApi<RawApi>;

type QaUser = {
  id: string;
  telegramId: bigint;
  firstName: string | null;
  status: string;
  onboardingStep: string;
  isEmailVerified: boolean;
  verificationStatus: string;
  verificationSkippedAt: Date | null;
};

type QaMatch = {
  id: string;
  status: string;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  proposedTimes: Date[];
  agreedTime: Date | null;
  venueName: string | null;
  icebreakersSentAt: Date | null;
  safetyNoteSentAt: Date | null;
  wingmanSentAt: Date | null;
  feedbackPromptedAt: Date | null;
  feedbackByA: string | null;
  feedbackByB: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type Options = {
  telegramIds: [bigint, bigint];
  dryRun: boolean;
  once: boolean;
  intervalMs: number;
  maxProposals: number;
  reseedDelayMs: number;
  lifecycleDwellMs: number;
  autoLifecycle: boolean;
  reseedAfterCompleted: boolean;
};

const ACTIVE_MATCH_STATUSES = new Set([
  "proposed",
  "negotiating",
  "negotiating_venue",
  "scheduled",
]);

function parsePositiveInt(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer, got "${raw}".`);
  }
  return value;
}

function parseOptions(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const withoutPrefix = arg.slice(2);
    const equalsAt = withoutPrefix.indexOf("=");
    if (equalsAt === -1) {
      flags.set(withoutPrefix, true);
    } else {
      flags.set(withoutPrefix.slice(0, equalsAt), withoutPrefix.slice(equalsAt + 1));
    }
  }

  if (positional.length !== 2) {
    throw new Error(
      "Usage: tsx scripts/qa-orchestrator.ts <telegramIdA> <telegramIdB> [--dry-run] [--once]",
    );
  }

  const tgA = BigInt(positional[0]!);
  const tgB = BigInt(positional[1]!);
  if (tgA === tgB) throw new Error("Telegram IDs must be distinct.");

  return {
    telegramIds: [tgA, tgB],
    dryRun: flags.has("dry-run"),
    once: flags.has("once"),
    intervalMs:
      typeof flags.get("interval-ms") === "string"
        ? parsePositiveInt(flags.get("interval-ms") as string, "interval-ms")
        : 5_000,
    maxProposals:
      typeof flags.get("max-proposals") === "string"
        ? parsePositiveInt(flags.get("max-proposals") as string, "max-proposals")
        : 12,
    reseedDelayMs:
      typeof flags.get("reseed-delay-ms") === "string"
        ? parsePositiveInt(flags.get("reseed-delay-ms") as string, "reseed-delay-ms")
        : 120_000,
    lifecycleDwellMs:
      typeof flags.get("lifecycle-dwell-ms") === "string"
        ? parsePositiveInt(
            flags.get("lifecycle-dwell-ms") as string,
            "lifecycle-dwell-ms",
          )
        : 90_000,
    autoLifecycle: !flags.has("no-auto-lifecycle"),
    reseedAfterCompleted: flags.has("reseed-after-completed"),
  };
}

function assertDevRuntime(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (
    !databaseUrl.includes("localhost:5434") ||
    !databaseUrl.includes("gennety_dev")
  ) {
    throw new Error(
      "Refusing to run: DATABASE_URL must target the local dev DB on localhost:5434/gennety_dev.",
    );
  }

  const botUsername = process.env.BOT_USERNAME ?? "";
  if (botUsername && botUsername !== "gennetytestbot") {
    throw new Error(
      `Refusing to run: BOT_USERNAME=${botUsername}, expected gennetytestbot.`,
    );
  }

  if (!process.env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN missing from .env.local/.env.");
  }
}

async function assertDevBot(api: BotApi): Promise<void> {
  const me = await api.getMe();
  if (me.username !== "gennetytestbot") {
    throw new Error(
      `Refusing to run: connected bot is @${me.username ?? "unknown"}, expected @gennetytestbot.`,
    );
  }
  console.log(`[qa] connected to @${me.username} (id=${me.id}).`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function pairWhere(aId: string, bId: string) {
  return {
    OR: [
      { userAId: aId, userBId: bId },
      { userAId: bId, userBId: aId },
    ],
  };
}

function isUserReady(user: QaUser): boolean {
  return user.onboardingStep === "completed" && user.status === "active";
}

function isFeedbackPending(match: QaMatch): boolean {
  return (
    match.status === "completed" &&
    match.feedbackPromptedAt !== null &&
    (match.feedbackByA === null || match.feedbackByB === null)
  );
}

function isCompletedFlowSettled(match: QaMatch): boolean {
  return match.status === "completed" && !isFeedbackPending(match);
}

function isActiveLike(match: QaMatch): boolean {
  return ACTIVE_MATCH_STATUSES.has(match.status) || isFeedbackPending(match);
}

function formatUser(user: QaUser | null, label: string): string {
  if (!user) return `${label}:missing`;
  const email = user.isEmailVerified ? "email=ok" : "email=pending";
  const persona =
    user.verificationSkippedAt !== null
      ? `${user.verificationStatus}:skipped`
      : user.verificationStatus;
  return [
    `${label}:tg=${user.telegramId}`,
    `status=${user.status}`,
    `step=${user.onboardingStep}`,
    email,
    `persona=${persona}`,
  ].join(" ");
}

function formatMatch(match: QaMatch | null): string {
  if (!match) return "match:none";
  const accepted = `accepted=${match.acceptedByA ?? "?"}/${match.acceptedByB ?? "?"}`;
  const venue = match.venueName ? `venue=yes` : "venue=no";
  const lifecycle = [
    match.icebreakersSentAt ? "ice" : "no-ice",
    match.safetyNoteSentAt ? "safety" : "no-safety",
    match.wingmanSentAt ? "wingman" : "no-wingman",
    match.feedbackPromptedAt ? "feedback-prompted" : "no-feedback",
  ].join(",");
  return `match:${match.id} status=${match.status} ${accepted} ${venue} ${lifecycle}`;
}

function logChanged(state: { lastLog: string | null }, value: string): void {
  if (state.lastLog === value) return;
  state.lastLog = value;
  console.log(`[qa] ${new Date().toISOString()} ${value}`);
}

async function loadUsers(options: Options): Promise<[QaUser | null, QaUser | null]> {
  const rows = await prisma.user.findMany({
    where: { telegramId: { in: options.telegramIds } },
    select: {
      id: true,
      telegramId: true,
      firstName: true,
      status: true,
      onboardingStep: true,
      isEmailVerified: true,
      verificationStatus: true,
      verificationSkippedAt: true,
    },
  });

  const byTelegram = new Map(rows.map((row) => [row.telegramId.toString(), row]));
  return [
    byTelegram.get(options.telegramIds[0].toString()) ?? null,
    byTelegram.get(options.telegramIds[1].toString()) ?? null,
  ];
}

async function loadPairMatches(userA: QaUser, userB: QaUser): Promise<QaMatch[]> {
  return prisma.match.findMany({
    where: pairWhere(userA.id, userB.id),
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      acceptedByA: true,
      acceptedByB: true,
      proposedTimes: true,
      agreedTime: true,
      venueName: true,
      icebreakersSentAt: true,
      safetyNoteSentAt: true,
      wingmanSentAt: true,
      feedbackPromptedAt: true,
      feedbackByA: true,
      feedbackByB: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

async function seedProposal(
  api: BotApi,
  userA: QaUser,
  userB: QaUser,
  options: Options,
): Promise<string | null> {
  if (options.dryRun) {
    console.log("[qa] dry-run: would create and dispatch a proposed QA match.");
    return null;
  }

  const match = await prisma.match.create({
    data: {
      userAId: userA.id,
      userBId: userB.id,
      status: "proposed",
      acceptedByA: null,
      acceptedByB: null,
    },
    select: { id: true },
  });

  console.log(`[qa] created proposed match id=${match.id}; dispatching pitch.`);
  const result = await dispatchMatches(api, [match.id], 0);
  if (result.failed > 0) {
    console.error(`[qa] dispatch failed for match=${match.id}:`, result.errors);
    return null;
  }
  return match.id;
}

async function ensureSchedulingStarted(
  api: BotApi,
  match: QaMatch,
  options: Options,
): Promise<void> {
  if (match.status !== "negotiating") return;
  if (match.proposedTimes.length > 0) return;

  if (options.dryRun) {
    console.log(`[qa] dry-run: would start calendar scheduling for match=${match.id}.`);
    return;
  }

  console.log(`[qa] starting calendar scheduling for match=${match.id}.`);
  await startScheduling(api, match.id);
}

async function updateAgreedTime(
  matchId: string,
  agreedTime: Date,
  options: Options,
  reason: string,
): Promise<void> {
  if (options.dryRun) {
    console.log(
      `[qa] dry-run: would set match=${matchId} agreedTime=${agreedTime.toISOString()} (${reason}).`,
    );
    return;
  }

  await prisma.match.update({
    where: { id: matchId },
    data: { agreedTime },
  });
  console.log(
    `[qa] time-compress ${reason}: match=${matchId} agreedTime=${agreedTime.toISOString()}.`,
  );
}

async function runLifecycleTick(
  api: BotApi,
  now: Date,
  options: Options,
): Promise<void> {
  if (options.dryRun) {
    console.log(`[qa] dry-run: would run lifecycle ticks at now=${now.toISOString()}.`);
    return;
  }

  const [lifecycle, safety] = await Promise.all([
    runDateLifecycleTick(api, now),
    runPreDateSafetyTick(api, now),
  ]);
  console.log(
    `[qa] lifecycle tick now=${now.toISOString()} icebreakers=${lifecycle.icebreakers} ` +
      `emergencies=${lifecycle.emergencies} wingmen=${lifecycle.wingmen} ` +
      `feedbacks=${lifecycle.feedbacks} safety=${safety.sent}`,
  );
}

async function maybeAdvanceLifecycle(
  api: BotApi,
  match: QaMatch,
  options: Options,
): Promise<void> {
  if (!options.autoLifecycle) return;
  if (match.status !== "scheduled") return;
  if (!match.agreedTime) return;

  const nowMs = Date.now();

  if (match.icebreakersSentAt === null) {
    if (nowMs - match.updatedAt.getTime() < options.lifecycleDwellMs) return;
    const now = new Date();
    const agreedTime = new Date(
      now.getTime() + DATE_ALERT_HOURS * 60 * 60 * 1000 - 30_000,
    );
    await updateAgreedTime(match.id, agreedTime, options, "T-3h icebreakers/emergency");
    await runLifecycleTick(api, now, options);
    return;
  }

  const wingmanReadyAt = match.icebreakersSentAt.getTime() + options.lifecycleDwellMs;
  if (match.wingmanSentAt === null || match.safetyNoteSentAt === null) {
    if (nowMs < wingmanReadyAt) return;
    const now = new Date();
    const agreedTime = new Date(
      now.getTime() + PRE_DATE_WINGMAN_HOURS * 60 * 60 * 1000 - 30_000,
    );
    await updateAgreedTime(match.id, agreedTime, options, "T-1h wingman/safety");
    await runLifecycleTick(api, now, options);
    return;
  }

  if (match.feedbackPromptedAt === null) {
    const lastPreDateAt = Math.max(
      match.wingmanSentAt?.getTime() ?? 0,
      match.safetyNoteSentAt?.getTime() ?? 0,
    );
    if (nowMs - lastPreDateAt < options.lifecycleDwellMs) return;
    const now = new Date();
    const agreedTime = new Date(
      now.getTime() - FEEDBACK_DELAY_HOURS * 60 * 60 * 1000 - 60_000,
    );
    await updateAgreedTime(match.id, agreedTime, options, "T+24h feedback");
    await runLifecycleTick(api, now, options);
  }
}

async function tick(
  api: BotApi,
  options: Options,
  state: { lastLog: string | null; seededCount: number },
): Promise<void> {
  const [userA, userB] = await loadUsers(options);
  let activeMatch: QaMatch | null = null;
  let latestMatch: QaMatch | null = null;
  let settledCompletedMatch: QaMatch | null = null;

  if (userA && userB) {
    const matches = await loadPairMatches(userA, userB);
    latestMatch = matches[0] ?? null;
    activeMatch = matches.find(isActiveLike) ?? null;
    settledCompletedMatch = matches.find(isCompletedFlowSettled) ?? null;
  }

  const visibleMatch =
    activeMatch ??
    (!options.reseedAfterCompleted && settledCompletedMatch
      ? settledCompletedMatch
      : null);
  const standdown =
    !activeMatch && !options.reseedAfterCompleted && settledCompletedMatch
      ? " | qa=completed-standdown"
      : "";

  logChanged(
    state,
    `${formatUser(userA, "A")} | ${formatUser(userB, "B")} | ${formatMatch(visibleMatch)}${standdown}`,
  );

  if (!userA || !userB) return;
  if (!isUserReady(userA) || !isUserReady(userB)) return;

  if (activeMatch) {
    await ensureSchedulingStarted(api, activeMatch, options);
    await maybeAdvanceLifecycle(api, activeMatch, options);
    return;
  }

  if (!options.reseedAfterCompleted && settledCompletedMatch) {
    return;
  }

  if (state.seededCount >= options.maxProposals) {
    console.log(`[qa] max proposals reached (${options.maxProposals}); standing down.`);
    return;
  }

  if (latestMatch) {
    const elapsed = Date.now() - latestMatch.updatedAt.getTime();
    if (elapsed < options.reseedDelayMs) {
      return;
    }
  }

  const seededId = await seedProposal(api, userA, userB, options);
  if (seededId) state.seededCount++;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  assertDevRuntime();

  const api = new Api(process.env.BOT_TOKEN!) as BotApi;
  await assertDevBot(api);

  console.log(
    [
      `[qa] orchestrator started for 2 Telegram QA accounts`,
      `dryRun=${options.dryRun}`,
      `once=${options.once}`,
      `intervalMs=${options.intervalMs}`,
      `maxProposals=${options.maxProposals}`,
      `autoLifecycle=${options.autoLifecycle}`,
      `lifecycleDwellMs=${options.lifecycleDwellMs}`,
      `reseedDelayMs=${options.reseedDelayMs}`,
      `reseedAfterCompleted=${options.reseedAfterCompleted}`,
    ].join(" "),
  );

  const state = { lastLog: null, seededCount: 0 };
  while (true) {
    await tick(api, options, state);
    if (options.once) break;
    await sleep(options.intervalMs);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("[qa] orchestrator failed:", err);
    void prisma.$disconnect();
    process.exit(1);
  });
