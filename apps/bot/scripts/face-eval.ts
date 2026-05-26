/**
 * Face-match evaluation harness — manual sanity check of AWS Rekognition
 * against our verify / review thresholds on real face pairs.
 *
 * Walks `tmp/face-eval/{same,different,hard}/<case>/` (relative to repo root):
 *   - `selfie.{jpg|jpeg|png}` is the reference (Persona-equivalent)
 *   - any other image files in the same dir are candidate "profile photos"
 *   - the `same/` bucket should classify as `verified`
 *   - the `different/` bucket should classify as `rejected`
 *   - `hard/` is purely informational (no expected verdict)
 *
 * Usage:
 *   pnpm face-eval                       # use default thresholds (.env / .env.local)
 *   pnpm face-eval --verify=0.85 --review=0.75
 *   pnpm face-eval --case=same/me_glasses
 *
 * Calls real AWS Rekognition CompareFaces — every case costs ~$0.001 per photo.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { compareFaces, type FaceMatchResult } from "../src/services/face-match.js";

// ── Env loading (mirrors apps/bot/src/config.ts so .env.local wins) ───────
const repoRoot = resolve(import.meta.dirname, "../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const args = parseArgs(process.argv.slice(2));
if (args.help !== undefined || args.h !== undefined) {
  printHelp();
  process.exit(0);
}
const thresholdVerify = Number(args.verify ?? process.env.FACE_MATCH_THRESHOLD_VERIFY ?? "0.85");
const thresholdReview = Number(args.review ?? process.env.FACE_MATCH_THRESHOLD_REVIEW ?? "0.75");
const caseFilter = args.case ?? null;

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error("✖ AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set in .env / .env.local");
  process.exit(1);
}

const datasetRoot = join(repoRoot, "tmp", "face-eval");
if (!safeIsDir(datasetRoot)) {
  console.error(`✖ Dataset directory not found: ${datasetRoot}`);
  console.error("  Run `pnpm face-eval --help` for the expected layout.");
  process.exit(1);
}

const client = new RekognitionClient({
  region: process.env.AWS_REGION ?? "eu-central-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

type ExpectedVerdict = "verified" | "rejected" | null; // null = informational only

interface Case {
  name: string;
  expected: ExpectedVerdict;
  selfiePath: string;
  photoPaths: string[];
}

const cases = collectCases(datasetRoot).filter((c) =>
  caseFilter ? c.name.startsWith(caseFilter) : true,
);

if (cases.length === 0) {
  console.error("✖ No cases found under tmp/face-eval/.");
  console.error("  Run `pnpm face-eval --help` for the expected layout.");
  process.exit(1);
}

console.log(
  `Evaluating ${cases.length} case(s)  |  thresholds verify≥${thresholdVerify}, review≥${thresholdReview}\n`,
);

interface Row {
  caseName: string;
  expected: ExpectedVerdict;
  minScore: number | null;
  perPhoto: Array<{ name: string; score: number | null; note?: string }>;
  predicted: "verified" | "pending_review" | "rejected" | "error";
  errorReason?: string;
}

const rows: Row[] = [];
let apiCalls = 0;

for (const c of cases) {
  const selfieBuf = readFileSync(c.selfiePath);
  const perPhoto: Row["perPhoto"] = [];
  let infraError: string | null = null;

  for (const photoPath of c.photoPaths) {
    const photoBuf = readFileSync(photoPath);
    const result: FaceMatchResult = await compareFaces(selfieBuf, photoBuf, {
      provider: "rekognition",
      client,
    });
    apiCalls++;
    const photoName = photoPath.split("/").pop()!;
    if (!result.ok) {
      perPhoto.push({ name: photoName, score: null, note: result.error });
      infraError ??= result.error;
      continue;
    }
    perPhoto.push({
      name: photoName,
      score: result.faceFound ? result.similarity : 0,
      note: result.faceFound ? undefined : "no_face_in_photo",
    });
  }

  let row: Row;
  const numericScores = perPhoto
    .map((p) => p.score)
    .filter((s): s is number => typeof s === "number");

  if (infraError && numericScores.length === 0) {
    row = {
      caseName: c.name,
      expected: c.expected,
      minScore: null,
      perPhoto,
      predicted: "error",
      errorReason: infraError,
    };
  } else {
    const minScore = numericScores.length > 0 ? Math.min(...numericScores) : 0;
    let predicted: Row["predicted"];
    if (minScore >= thresholdVerify) predicted = "verified";
    else if (minScore >= thresholdReview) predicted = "pending_review";
    else predicted = "rejected";
    row = { caseName: c.name, expected: c.expected, minScore, perPhoto, predicted };
  }
  rows.push(row);
  printRow(row);
}

console.log("\n── Summary ──────────────────────────────────────────────────");
const judged = rows.filter((r) => r.expected !== null);
const correct = judged.filter((r) => isCorrect(r));
const reviewBucket = judged.filter((r) => r.predicted === "pending_review");
const falsePositives = judged.filter(
  (r) => r.expected === "rejected" && r.predicted !== "rejected",
);
const falseNegatives = judged.filter(
  (r) => r.expected === "verified" && r.predicted !== "verified",
);
console.log(`  Cases (judged): ${judged.length}`);
console.log(`  Correct:         ${correct.length}`);
console.log(`  → pending_review: ${reviewBucket.length}  (counted as wrong if expected was a hard verdict)`);
console.log(`  False positives  (rejected → verified/review): ${falsePositives.length}`);
console.log(`  False negatives  (verified → review/rejected): ${falseNegatives.length}`);
console.log(`  AWS CompareFaces calls: ${apiCalls}  (~$${(apiCalls * 0.001).toFixed(3)})`);

if (falsePositives.length > 0 || falseNegatives.length > 0) {
  console.log("\n  Misclassifications:");
  for (const r of [...falsePositives, ...falseNegatives]) {
    console.log(
      `    ✗ ${r.caseName}  expected=${r.expected}  predicted=${r.predicted}  min=${fmt(r.minScore)}`,
    );
  }
}

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

function printHelp(): void {
  console.log(`face-eval — manual sanity check of AWS Rekognition CompareFaces

  Usage:
    pnpm face-eval [--verify=0.85] [--review=0.75] [--case=<prefix>]

  Dataset layout (under tmp/face-eval/, ignored by git):
    same/<case>/        expected verdict: verified  (min ≥ verify threshold)
    different/<case>/   expected verdict: rejected  (min <  review threshold)
    hard/<case>/        informational only — no expected verdict

  Each case directory must contain:
    - selfie.{jpg|jpeg|png}   the reference shot (Persona-equivalent)
    - one or more other .jpg|.jpeg|.png files as candidate profile photos

  Verdict rules (mirror verification-pipeline.ts):
    min ≥ verify  → verified
    min ≥ review  → pending_review
    else          → rejected

  Each candidate photo = 1 CompareFaces call ≈ \$0.001.
`);
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isImage(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" || ext === ".png";
}

function collectCases(root: string): Case[] {
  const result: Case[] = [];
  const buckets: Array<{ dir: string; expected: ExpectedVerdict }> = [
    { dir: "same", expected: "verified" },
    { dir: "different", expected: "rejected" },
    { dir: "hard", expected: null },
  ];
  for (const b of buckets) {
    const bucketDir = join(root, b.dir);
    if (!safeIsDir(bucketDir)) continue;
    for (const caseName of readdirSync(bucketDir)) {
      const caseDir = join(bucketDir, caseName);
      if (!safeIsDir(caseDir)) continue;
      const files = readdirSync(caseDir).filter(isImage);
      const selfie = files.find((f) => f.toLowerCase().startsWith("selfie."));
      if (!selfie) {
        console.warn(`  ⚠ skipping ${b.dir}/${caseName} — no selfie.* file`);
        continue;
      }
      const photos = files.filter((f) => f !== selfie);
      if (photos.length === 0) {
        console.warn(`  ⚠ skipping ${b.dir}/${caseName} — no candidate photos`);
        continue;
      }
      result.push({
        name: `${b.dir}/${caseName}`,
        expected: b.expected,
        selfiePath: join(caseDir, selfie),
        photoPaths: photos.sort().map((p) => join(caseDir, p)),
      });
    }
  }
  return result;
}

function fmt(n: number | null): string {
  return n === null ? " n/a " : n.toFixed(3);
}

function isCorrect(r: Row): boolean {
  if (r.expected === null) return true;
  return r.expected === r.predicted;
}

function printRow(r: Row): void {
  const expected = r.expected ?? "info";
  const verdict =
    r.expected === null
      ? "·"
      : isCorrect(r)
        ? "✓"
        : r.predicted === "pending_review"
          ? "≈"
          : "✗";
  const perPhoto = r.perPhoto
    .map((p) => `${p.name}=${p.score === null ? p.note : p.score.toFixed(3)}`)
    .join(" ");
  const min = fmt(r.minScore);
  console.log(
    `  ${verdict} ${r.caseName.padEnd(30)} min=${min}  →${r.predicted.padEnd(15)} (expected=${expected})  [${perPhoto}]`,
  );
  if (r.errorReason) console.log(`      error: ${r.errorReason}`);
}
