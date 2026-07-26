/**
 * probe-face-liveness — verify the AWS side of identity verification without a
 * camera, a Mini App, or a user.
 *
 * Exercises all three permissions the Face Liveness flow needs and reports
 * which one is missing when something is off:
 *   1. rekognition:CreateFaceLivenessSession   (backend mints the session)
 *   2. sts:AssumeRole on LIVENESS_STS_ROLE_ARN (backend mints client creds)
 *   3. rekognition:GetFaceLivenessSessionResults (backend reads the result)
 *
 * Step 3 is expected to report `in_progress` — nobody streamed a selfie video
 * into the session, which is exactly the point: it proves we are allowed to
 * read results without spending a liveness check. A created-but-unused session
 * is not billed as a check and expires on its own after 3 minutes.
 *
 * Usage:
 *   pnpm probe-liveness            # against whatever .env.local/.env resolve to
 *
 * Env required:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *   FACE_LIVENESS_REGION (default eu-west-1 — NOT the same as AWS_REGION)
 *   LIVENESS_STS_ROLE_ARN
 */
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

const repoRoot = resolve(import.meta.dirname, "../../..");
loadEnv({ path: join(repoRoot, ".env.local") });
loadEnv({ path: join(repoRoot, ".env") });

// Imports below read process.env at module load (config.ts), so they must come
// after dotenv has populated it.
const { env } = await import("../src/config.js");
const { createLivenessSession, getLivenessResult } = await import(
  "../src/services/face-liveness.js"
);
const { mintLivenessCredentials } = await import(
  "../src/services/liveness-credentials.js"
);

function required(name: string, value: string): void {
  if (!value) {
    console.error(`✖ ${name} is not set — fill it in .env.local or .env`);
    process.exit(1);
  }
}

required("AWS_ACCESS_KEY_ID", env.AWS_ACCESS_KEY_ID);
required("AWS_SECRET_ACCESS_KEY", env.AWS_SECRET_ACCESS_KEY);

console.log(`liveness region: ${env.FACE_LIVENESS_REGION}`);
console.log(`face-match region: ${env.AWS_REGION}  (CompareFaces/moderation — unrelated)`);
console.log(`role:            ${env.LIVENESS_STS_ROLE_ARN || "(unset)"}`);
console.log("");

// ── 1. CreateFaceLivenessSession ───────────────────────────────
const session = await createLivenessSession();
if (!session.ok) {
  console.error(`✖ CreateFaceLivenessSession → ${session.error}`);
  if (session.error === "api") {
    // Learned the hard way (2026-07-26): in a region that does not serve Face
    // Liveness, Rekognition answers AccessDeniedException with an EMPTY message
    // — indistinguishable from an IAM denial. Check the region first; it is the
    // cheaper hypothesis to rule out.
    console.error(
      `  Two candidates, region first:\n` +
        `   1. FACE_LIVENESS_REGION=${env.FACE_LIVENESS_REGION} may not serve Face Liveness.\n` +
        `      A region without it returns a MESSAGE-LESS AccessDeniedException that\n` +
        `      looks exactly like an IAM problem. eu-west-1 is the only EU region that\n` +
        `      works for this account; eu-central-1 does NOT.\n` +
        `   2. The IAM user lacks rekognition:CreateFaceLivenessSession.\n` +
        `  Step 2 below distinguishes them: if AssumeRole succeeds, the policy is\n` +
        `  live and propagated, so the problem is the region.`,
    );
  }
  process.exit(1);
}
console.log(`✓ CreateFaceLivenessSession → ${session.sessionId}`);

// ── 2. sts:AssumeRole for the on-device component ──────────────
const creds = await mintLivenessCredentials("probe");
if (!creds.ok) {
  console.error(`✖ AssumeRole → ${creds.error}`);
  if (creds.error === "not_configured") {
    console.error("  Set LIVENESS_STS_ROLE_ARN (see deploy.md).");
  } else {
    console.error(
      "  Check the role's trust policy names the gennety-bot-rekognition user,",
    );
    console.error("  and that the user is allowed sts:AssumeRole on that role.");
  }
  process.exit(1);
}
console.log(
  `✓ AssumeRole → ${creds.credentials.accessKeyId.slice(0, 8)}… expires ${creds.credentials.expiration}`,
);

// ── 3. GetFaceLivenessSessionResults ───────────────────────────
const result = await getLivenessResult(session.sessionId);
if (!result.ok) {
  console.error(`✖ GetFaceLivenessSessionResults → ${result.error}`);
  console.error(
    "  Most likely the IAM user lacks rekognition:GetFaceLivenessSessionResults.",
  );
  process.exit(1);
}
console.log(`✓ GetFaceLivenessSessionResults → outcome=${result.outcome}`);

if (result.outcome !== "in_progress") {
  console.warn(
    `\n⚠ expected in_progress for an unused session, got "${result.outcome}" — not fatal, but worth a look.`,
  );
}

console.log("\nAll three AWS permissions are in place.");
