/**
 * face-eval-user — DRY-RUN end-to-end check of one real user's verification.
 *
 * Reads the user from the (dev) DB, fetches the Persona selfie via the real
 * Persona REST API, fetches each profile photo (from Telegram by file_id, or
 * from Supabase by path), and runs AWS Rekognition CompareFaces on every
 * pair. Dumps all images to tmp/face-eval-user/<userId>/ so you can eyeball
 * what Persona actually returned.
 *
 * Does NOT write to the DB and does NOT DM anyone — safe to re-run.
 *
 * Usage:
 *   pnpm face-eval-user --user=<id|email|telegramId> [--inquiry=<personaId>]
 *   pnpm face-eval-user --user=glebw2008@gmail.com --inquiry=inq_xxx
 *   pnpm face-eval-user --help
 *
 * Env required (typically from .env.local for the dev bot):
 *   DATABASE_URL                  → dev Postgres on :5434
 *   BOT_TOKEN                     → @gennetytestbot token (for Telegram getFile)
 *   PERSONA_API_KEY               → matching env of the inquiry (sandbox vs prod)
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 *   FACE_MATCH_THRESHOLD_VERIFY   (optional, default 0.85)
 *   FACE_MATCH_THRESHOLD_REVIEW   (optional, default 0.75)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (only if photos are Supabase paths)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

// Imports below this line read process.env at module load (config.ts), so
// they MUST come after dotenv has populated it.
const { prisma } = await import("@gennety/db");
const { Bot } = await import("grammy");
const { compareFaces } = await import("../src/services/face-match.js");
const { fetchInquirySelfie } = await import("../src/services/persona-api.js");
const { downloadProfileImage } = await import("../src/services/storage.js");
const { RekognitionClient } = await import("@aws-sdk/client-rekognition");

const args = parseArgs(process.argv.slice(2));
if (args.help !== undefined || args.h !== undefined) {
  printHelp();
  process.exit(0);
}

const userArg = args.user;
const inquiryArg = args.inquiry ?? null;
const noDump = args["no-dump"] !== undefined;
const thresholdVerify = Number(args.verify ?? process.env.FACE_MATCH_THRESHOLD_VERIFY ?? "0.85");
const thresholdReview = Number(args.review ?? process.env.FACE_MATCH_THRESHOLD_REVIEW ?? "0.75");

if (!userArg) {
  console.error("✖ --user=<id|email|telegramId> is required. Use --help.");
  process.exit(1);
}

requireEnv("DATABASE_URL");
requireEnv("BOT_TOKEN");
requireEnv("PERSONA_API_KEY");
requireEnv("AWS_ACCESS_KEY_ID");
requireEnv("AWS_SECRET_ACCESS_KEY");

const user = await resolveUser(userArg);
if (!user) {
  console.error(`✖ User not found by '${userArg}' (tried id, email, telegramId)`);
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`User:           ${user.id}`);
console.log(`Email:          ${user.email}`);
console.log(`Telegram id:    ${user.telegramId}`);
console.log(`Status:         ${user.status}  (verification=${user.verificationStatus})`);
console.log(`Persona inq id: ${user.personaInquiryId ?? "(none in DB)"}`);

const inquiryId = inquiryArg ?? user.personaInquiryId;
if (!inquiryId) {
  console.error(
    "\n✖ No Persona inquiry id available — pass --inquiry=<id> manually.\n" +
      "  (Locally the Persona webhook never reached the bot, so the DB row is empty;\n" +
      "  copy the inquiry id from the Persona dashboard after finishing the flow.)",
  );
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`Inquiry used:   ${inquiryId}\n`);

const photos = user.profile?.photos ?? [];
if (photos.length === 0) {
  console.error("✖ User has no profile photos.");
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`Profile photos: ${photos.length}`);
photos.forEach((p, i) => console.log(`  [${i}] ${truncate(p, 60)}`));
console.log("");

// ── Step 1: fetch Persona selfie ───────────────────────────────────────────
console.log("→ Fetching Persona selfie via REST API…");
const selfieResult = await fetchInquirySelfie(inquiryId);
if (!selfieResult.ok) {
  console.error(`✖ fetchInquirySelfie failed: ${selfieResult.error}`);
  await prisma.$disconnect();
  process.exit(1);
}
console.log(
  `  ✓ got selfie (${selfieResult.selfie.buffer.length} bytes, ${selfieResult.selfie.mime}, verificationId=${selfieResult.selfie.verificationId})`,
);

// ── Step 2: dump everything for visual inspection ──────────────────────────
const dumpDir = join(repoRoot, "tmp", "face-eval-user", user.id);
if (!noDump) {
  mkdirSync(dumpDir, { recursive: true });
  const selfieExt = mimeToExt(selfieResult.selfie.mime);
  writeFileSync(join(dumpDir, `persona-selfie.${selfieExt}`), selfieResult.selfie.buffer);
  console.log(`  ✓ dumped selfie → ${dumpDir}/persona-selfie.${selfieExt}`);
}

// ── Step 3: fetch each profile photo (Telegram file_id OR Supabase path) ──
// Both branches go through the same production helper now — the bug this
// script originally surfaced was that the pipeline only knew about the
// Supabase branch. Routing happens by the `/` heuristic inside
// downloadProfileImage.
const bot = new Bot(process.env.BOT_TOKEN!);

console.log("\n→ Fetching profile photos…");
const photoBuffers: Array<{ index: number; path: string; buffer: Buffer | null; source: string }> = [];
for (let i = 0; i < photos.length; i++) {
  const p = photos[i]!;
  const source = p.includes("/") ? "supabase" : "telegram";
  console.log(`  [${i}] (${source}) ${truncate(p, 50)}`);
  const buffer = await downloadProfileImage(p, bot.api);
  if (!buffer) {
    console.log(`      ✖ download failed`);
  } else {
    console.log(`      ✓ ${buffer.length} bytes`);
    if (!noDump) {
      writeFileSync(join(dumpDir, `photo${i}.jpg`), buffer);
    }
  }
  photoBuffers.push({ index: i, path: p, buffer, source });
}

// ── Step 4: compareFaces on each pair ─────────────────────────────────────
console.log("\n→ Running AWS Rekognition CompareFaces…");
const rekClient = new RekognitionClient({
  region: process.env.AWS_REGION ?? "eu-central-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

interface PerPhoto {
  index: number;
  source: string;
  ok: boolean;
  similarity: number | null;
  faceFound: boolean | null;
  error?: string;
}
const results: PerPhoto[] = [];

for (const ph of photoBuffers) {
  if (!ph.buffer) {
    results.push({ index: ph.index, source: ph.source, ok: false, similarity: null, faceFound: null, error: "download_failed" });
    continue;
  }
  const r = await compareFaces(selfieResult.selfie.buffer, ph.buffer, {
    provider: "rekognition",
    client: rekClient,
  });
  if (!r.ok) {
    results.push({ index: ph.index, source: ph.source, ok: false, similarity: null, faceFound: null, error: r.error });
  } else {
    results.push({
      index: ph.index,
      source: ph.source,
      ok: true,
      similarity: r.faceFound ? r.similarity : 0,
      faceFound: r.faceFound,
    });
  }
}

// ── Step 5: print table + verdict ─────────────────────────────────────────
console.log("\n── Per-photo scores ──────────────────────────────────────────");
for (const r of results) {
  const sim = r.similarity === null ? "  n/a" : r.similarity.toFixed(3).padStart(6);
  const face = r.faceFound === null ? "?" : r.faceFound ? "✓" : "✗";
  const note = r.error ? `  error=${r.error}` : "";
  console.log(`  [${r.index}] (${r.source.padEnd(8)}) similarity=${sim}  face=${face}${note}`);
}

const numeric = results.filter((r) => r.similarity !== null).map((r) => r.similarity!);
if (numeric.length === 0) {
  console.log("\n✖ No comparisons produced a numeric score. Verdict: pending_review (infra error).");
} else {
  const minScore = Math.min(...numeric);
  let verdict: "verified" | "pending_review" | "rejected";
  if (minScore >= thresholdVerify) verdict = "verified";
  else if (minScore >= thresholdReview) verdict = "pending_review";
  else verdict = "rejected";

  console.log("\n── Verdict ───────────────────────────────────────────────────");
  console.log(`  min score:    ${minScore.toFixed(3)}`);
  console.log(`  thresholds:   verify ≥ ${thresholdVerify}, review ≥ ${thresholdReview}`);
  console.log(`  predicted:    ${verdict}`);
  if (results.some((r) => !r.ok)) {
    console.log(`  ⚠ note:       some photos failed (would land in pending_review in prod)`);
  }
}

if (!noDump) {
  console.log(`\nDumped images for visual inspection: ${dumpDir}`);
}
console.log(`\nAWS calls: ${results.filter((r) => r.ok || r.error !== "download_failed").length}  (~$${(results.filter((r) => r.ok || r.error !== "download_failed").length * 0.001).toFixed(3)})`);

await prisma.$disconnect();

// ── helpers ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const eq = a.match(/^--([^=]+)=(.*)$/);
    if (eq) {
      out[eq[1]!] = eq[2]!;
      continue;
    }
    const flag = a.match(/^--?([^=]+)$/);
    if (flag) out[flag[1]!] = "";
  }
  return out;
}

function requireEnv(name: string): void {
  if (!process.env[name]) {
    console.error(`✖ Missing required env var: ${name}`);
    process.exit(1);
  }
}

async function resolveUser(arg: string): Promise<{
  id: string;
  email: string | null;
  telegramId: bigint;
  status: string;
  verificationStatus: string;
  personaInquiryId: string | null;
  profile: { photos: string[] } | null;
} | null> {
  const select = {
    id: true,
    email: true,
    telegramId: true,
    status: true,
    verificationStatus: true,
    personaInquiryId: true,
    profile: { select: { photos: true } },
  } as const;

  // UUID first
  if (/^[0-9a-f-]{36}$/i.test(arg)) {
    const u = await prisma.user.findUnique({ where: { id: arg }, select });
    if (u) return u;
  }
  // Email
  if (arg.includes("@")) {
    const u = await prisma.user.findFirst({ where: { email: arg }, select });
    if (u) return u;
  }
  // Numeric → telegramId
  if (/^-?\d+$/.test(arg)) {
    const u = await prisma.user.findFirst({ where: { telegramId: BigInt(arg) }, select });
    if (u) return u;
  }
  return null;
}

function mimeToExt(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function printHelp(): void {
  console.log(`face-eval-user — dry-run e2e check of one user's face verification

  Usage:
    pnpm face-eval-user --user=<id|email|telegramId> [options]

  Options:
    --inquiry=<personaId>   override personaInquiryId (when DB doesn't have it)
    --verify=0.85           verify threshold
    --review=0.75           review threshold
    --no-dump               skip writing images to tmp/face-eval-user/

  What it does:
    1. Resolves the user from DATABASE_URL (typically the dev DB)
    2. Pulls the verified selfie from Persona REST API
    3. Pulls each profile photo (Telegram file_id OR Supabase path)
    4. Dumps all images to tmp/face-eval-user/<userId>/ for visual inspection
    5. Runs AWS Rekognition CompareFaces on each pair
    6. Prints per-photo scores + the verdict our pipeline would render

  Read-only — does not write to DB, does not DM the user.
`);
}
