#!/usr/bin/env node
/**
 * Dev-only E2E helper.
 *
 * Creates and dispatches a real `proposed` match between the two local
 * Telegram test accounts, bypassing the weekly batch wait while preserving
 * the downstream user journey: pitch DM, Accept/Decline buttons, Calendar
 * Mini App, venue negotiation, date lifecycle, feedback, and reports.
 *
 * Usage:
 *   pnpm dev:trigger-test-match
 *
 * Optional:
 *   --primary-tg=782065541 --secondary-tg=5986970093
 *   --replace-open     cancel current in-flight matches for either account
 *   --no-align-email   do not copy the primary verified domain to secondary
 *   --force            allow non-DEP bot / compatibility override
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

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
    if (override || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Load local dev env before importing anything that constructs Prisma.
loadEnvFile(resolve(root, ".env.local"), true);
loadEnvFile(resolve(root, ".env"), false);

const MIN_PHOTOS = 2;
const OPEN_STATUSES = ["proposed", "negotiating", "negotiating_venue", "scheduled"];

const args = new Map(
  process.argv.slice(2)
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
      const [key, value = "true"] = arg.slice(2).split("=");
      return [key, value];
    }),
);

if (args.has("help")) {
  console.log("Usage: pnpm dev:trigger-test-match [--replace-open] [--no-align-email] [--force]");
  process.exit(0);
}

const apply = args.get("apply") === "true";
const force = args.get("force") === "true";
const replaceOpen = args.get("replace-open") === "true";
const alignEmail = args.get("align-email") !== "false" && args.get("no-align-email") !== "true";
const primaryTg = BigInt(args.get("primary-tg") ?? "782065541");
const secondaryTg = BigInt(args.get("secondary-tg") ?? "5986970093");
let prisma;

function maskEmail(email) {
  if (!email || typeof email !== "string") return null;
  const [local, domain] = email.split("@");
  if (!local || !domain) return "[masked]";
  return `${local.slice(0, 2)}***@${domain}`;
}

function wants(preference, gender) {
  return preference === "both" ||
    (preference === "men" && gender === "male") ||
    (preference === "women" && gender === "female");
}

function assertReady(label, user) {
  if (!user) throw new Error(`${label} account not found. Complete /start first.`);
  if (user.status !== "active") {
    throw new Error(`${label} must be active; current status=${user.status}.`);
  }
  if (user.onboardingStep !== "completed") {
    throw new Error(`${label} onboarding must be completed; current step=${user.onboardingStep}.`);
  }
  if (!user.isEmailVerified || !user.universityDomain) {
    throw new Error(`${label} must have verified email and universityDomain.`);
  }
  if (!user.gender || !user.preference) {
    throw new Error(`${label} must have gender and preference set.`);
  }
  if (user.verificationStatus === "rejected" || user.verificationStatus === "pending_review") {
    throw new Error(`${label} is not match-eligible: verificationStatus=${user.verificationStatus}.`);
  }
  const photos = user.profile?.photos ?? [];
  if (photos.length < MIN_PHOTOS) {
    throw new Error(`${label} must have at least ${MIN_PHOTOS} photos; current=${photos.length}.`);
  }
}

function createTelegramApi(token) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, payload) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      const description = json?.description ?? `${res.status} ${res.statusText}`;
      throw new Error(`Telegram ${method} failed: ${description}`);
    }
    return json.result;
  }

  return {
    raw: {
      sendMessageDraft(payload) {
        return call("sendMessageDraft", payload);
      },
    },
    sendMessage(chatId, text, options = {}) {
      return call("sendMessage", { chat_id: chatId, text, ...options });
    },
    sendPhoto(chatId, photo, options = {}) {
      return call("sendPhoto", { chat_id: chatId, photo, ...options });
    },
    sendMediaGroup(chatId, media, options = {}) {
      return call("sendMediaGroup", { chat_id: chatId, media, ...options });
    },
  };
}

async function loadUser(telegramId) {
  return prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      telegramId: true,
      email: true,
      universityDomain: true,
      isEmailVerified: true,
      status: true,
      onboardingStep: true,
      firstName: true,
      gender: true,
      preference: true,
      verificationStatus: true,
      profile: {
        select: {
          photos: true,
          psychologicalSummary: true,
          embeddingDirty: true,
          eloScore: true,
        },
      },
    },
  });
}

async function maybeAlignSecondaryDomain(primary, secondary) {
  if (!alignEmail) return secondary;
  if (!primary?.isEmailVerified || !primary.universityDomain) return secondary;
  if (!secondary) return secondary;
  if (
    secondary.isEmailVerified &&
    secondary.universityDomain === primary.universityDomain
  ) {
    return secondary;
  }

  const syntheticEmail = `dev+${secondary.telegramId.toString()}@${primary.universityDomain}`;
  const existingEmailOwner = await prisma.user.findUnique({
    where: { email: syntheticEmail },
    select: { telegramId: true },
  });
  if (existingEmailOwner && existingEmailOwner.telegramId !== secondary.telegramId) {
    throw new Error(`Synthetic email ${maskEmail(syntheticEmail)} is already owned by another user.`);
  }

  if (!apply) {
    console.log("[dry-run] would align secondary email domain", {
      secondaryTg: secondary.telegramId.toString(),
      from: secondary.universityDomain,
      to: primary.universityDomain,
      email: maskEmail(syntheticEmail),
    });
    return {
      ...secondary,
      email: syntheticEmail,
      universityDomain: primary.universityDomain,
      isEmailVerified: true,
    };
  }

  await prisma.user.update({
    where: { id: secondary.id },
    data: {
      email: syntheticEmail,
      universityDomain: primary.universityDomain,
      isEmailVerified: true,
      emailOtp: null,
      emailOtpExpiresAt: null,
    },
  });
  return loadUser(secondary.telegramId);
}

async function main() {
  if (process.env.BOT_USERNAME !== "gennetytestbot" && !force) {
    throw new Error(
      "Refusing to run outside the DEP bot. Expected BOT_USERNAME=gennetytestbot; pass --force only if you are absolutely sure.",
    );
  }
  if (!process.env.BOT_TOKEN) {
    throw new Error("Missing BOT_TOKEN in local env.");
  }

  const db = await import("@gennety/db");
  prisma = db.prisma;
  const { createProposedMatch } = await import("../apps/bot/src/services/match-engine.js");
  const { dispatchMatches } = await import("../apps/bot/src/services/dispatch-queue.js");

  let primary = await loadUser(primaryTg);
  let secondary = await loadUser(secondaryTg);
  secondary = await maybeAlignSecondaryDomain(primary, secondary);

  assertReady("Primary", primary);
  assertReady("Secondary", secondary);

  if (primary.universityDomain !== secondary.universityDomain) {
    throw new Error(
      `University domains differ (${primary.universityDomain} vs ${secondary.universityDomain}). Run with email alignment or fix test data.`,
    );
  }

  const compatible =
    wants(primary.preference, secondary.gender) &&
    wants(secondary.preference, primary.gender);
  if (!compatible && !force) {
    throw new Error(
      `The accounts are not mutually compatible by gender/preference (${primary.gender}/${primary.preference} vs ${secondary.gender}/${secondary.preference}). Adjust profiles or pass --force.`,
    );
  }

  const openMatches = await prisma.match.findMany({
    where: {
      status: { in: OPEN_STATUSES },
      OR: [
        { userAId: { in: [primary.id, secondary.id] } },
        { userBId: { in: [primary.id, secondary.id] } },
      ],
    },
    select: { id: true, status: true, userAId: true, userBId: true },
  });

  if (openMatches.length > 0 && !replaceOpen) {
    throw new Error(
      `Found ${openMatches.length} in-flight match(es) for these accounts. Re-run with --replace-open to cancel them first.`,
    );
  }

  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    bot: process.env.BOT_USERNAME,
    primary: {
      tg: primary.telegramId.toString(),
      email: maskEmail(primary.email),
      domain: primary.universityDomain,
      status: primary.status,
      verificationStatus: primary.verificationStatus,
    },
    secondary: {
      tg: secondary.telegramId.toString(),
      email: maskEmail(secondary.email),
      domain: secondary.universityDomain,
      status: secondary.status,
      verificationStatus: secondary.verificationStatus,
    },
    openMatches: openMatches.map((m) => ({ id: m.id, status: m.status })),
  }, null, 2));

  if (!apply) {
    console.log("Dry run only. Re-run through `pnpm dev:trigger-test-match` to create and dispatch.");
    return;
  }

  if (openMatches.length > 0 && replaceOpen) {
    await prisma.match.updateMany({
      where: { id: { in: openMatches.map((m) => m.id) } },
      data: { status: "cancelled" },
    });
    console.log(`Cancelled ${openMatches.length} existing in-flight match(es).`);
  }

  const match = await createProposedMatch(primary.id, secondary.id, {
    explicit: 0.88,
    research: 0.78,
    league: 1,
    penalty: 0,
    embeddingDistance: 0.24,
    starvationBonus: 0,
  });

  const api = createTelegramApi(process.env.BOT_TOKEN);
  const dispatch = await dispatchMatches(api, [match.id], 0);
  if (dispatch.failed > 0) {
    throw new Error(`Match created (${match.id}) but dispatch failed: ${JSON.stringify(dispatch.errors)}`);
  }

  console.log(`Created and dispatched test match: ${match.id}`);
}

main()
  .finally(async () => {
    await prisma?.$disconnect();
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
