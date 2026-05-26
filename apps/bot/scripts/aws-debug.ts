/**
 * One-shot AWS Rekognition debug — bypasses our compareFaces wrapper to
 * surface the real underlying error (the wrapper currently flattens
 * everything to `{error: "api"}`).
 *
 * Usage: pnpm --filter @gennety/bot exec tsx scripts/aws-debug.ts <selfie.jpg> <photo.jpg>
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { CompareFacesCommand, RekognitionClient } from "@aws-sdk/client-rekognition";

const repoRoot = resolve(import.meta.dirname, "../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

const [, , src, tgt] = process.argv;
if (!src || !tgt) {
  console.error("usage: aws-debug.ts <source.jpg> <target.jpg>");
  process.exit(1);
}

const client = new RekognitionClient({
  region: process.env.AWS_REGION ?? "eu-central-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

console.log("Region:", process.env.AWS_REGION);
console.log("Key ID:", (process.env.AWS_ACCESS_KEY_ID ?? "").slice(0, 6) + "***");

try {
  const out = await client.send(
    new CompareFacesCommand({
      SourceImage: { Bytes: readFileSync(src) },
      TargetImage: { Bytes: readFileSync(tgt) },
      SimilarityThreshold: 0,
      QualityFilter: "AUTO",
    }),
  );
  console.log("OK:", JSON.stringify(out, null, 2));
} catch (err) {
  console.log("ERROR name:", (err as { name?: string }).name);
  console.log("ERROR message:", (err as Error).message);
  console.log("ERROR full:", err);
}
