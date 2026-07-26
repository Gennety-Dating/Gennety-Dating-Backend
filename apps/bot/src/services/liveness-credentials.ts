import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { env } from "../config.js";

/**
 * Short-lived AWS credentials for the on-device Face Liveness component.
 *
 * The Amplify `FaceLivenessDetector` (web and Swift) opens its own SigV4-signed
 * WebSocket to Rekognition streaming — the video never passes through our
 * server — so the client genuinely needs AWS credentials. Amplify's default
 * answer is a Cognito Identity Pool guest role, i.e. an anonymous credential
 * endpoint. We deliberately don't do that: our clients are already
 * authenticated (Telegram initData HMAC / mobile JWT), so the backend mints the
 * credentials itself behind that existing boundary.
 *
 * Containment, given Rekognition supports no resource-level ARN for the
 * streaming action:
 *   - the assumed role grants `rekognition:StartFaceLivenessSession` and
 *     nothing else (deploy.md carries the policy),
 *   - an inline session policy re-asserts that ceiling, so a future widening of
 *     the role does not silently widen what a browser holds,
 *   - 15-minute TTL (AWS's floor), against a liveness session that dies in 3.
 *
 * Amplify calls `fetchAWSCredentials` exactly once at the start of the flow and
 * never refreshes, so a short TTL costs nothing.
 */

/** AssumeRole's minimum. Also comfortably longer than a 3-minute session. */
const MIN_DURATION_SECONDS = 900;

/**
 * Session policy: the credentials can do this and only this, regardless of
 * what the role itself is granted later.
 */
const SESSION_POLICY = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: "rekognition:StartFaceLivenessSession",
      Resource: "*",
    },
  ],
});

export interface LivenessCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO-8601. The client shows/uses nothing past this. */
  expiration: string;
}

export type MintCredentialsResult =
  | { ok: true; credentials: LivenessCredentials }
  | { ok: false; error: "not_configured" | "api" };

export interface MintCredentialsOptions {
  /** Inject an STS client (or test double). */
  client?: Pick<STSClient, "send">;
}

let cachedClient: STSClient | null = null;

function getStsClient(): STSClient | null {
  if (cachedClient) return cachedClient;
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  cachedClient = new STSClient({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });
  return cachedClient;
}

/**
 * Mint credentials for one user's liveness attempt.
 *
 * `userId` only shapes the STS session name, which is what makes a CloudTrail
 * entry attributable to a person. AWS caps that field at 64 chars and allows
 * `[\w+=,.@-]`, so a UUID is passed through and anything else is sanitised.
 *
 * Never throws — branch on `ok`.
 */
export async function mintLivenessCredentials(
  userId: string,
  options: MintCredentialsOptions = {},
): Promise<MintCredentialsResult> {
  if (!env.LIVENESS_STS_ROLE_ARN) return { ok: false, error: "not_configured" };

  const client = options.client ?? getStsClient();
  if (!client) return { ok: false, error: "not_configured" };

  try {
    const output = await client.send(
      new AssumeRoleCommand({
        RoleArn: env.LIVENESS_STS_ROLE_ARN,
        RoleSessionName: buildSessionName(userId),
        DurationSeconds: Math.max(
          MIN_DURATION_SECONDS,
          env.LIVENESS_CREDENTIALS_TTL_SECONDS,
        ),
        Policy: SESSION_POLICY,
      }),
    );

    const creds = output.Credentials;
    if (
      !creds?.AccessKeyId ||
      !creds.SecretAccessKey ||
      !creds.SessionToken ||
      !creds.Expiration
    ) {
      console.error("[liveness-credentials] AssumeRole returned no credentials");
      return { ok: false, error: "api" };
    }

    return {
      ok: true,
      credentials: {
        accessKeyId: creds.AccessKeyId,
        secretAccessKey: creds.SecretAccessKey,
        sessionToken: creds.SessionToken,
        expiration: creds.Expiration.toISOString(),
      },
    };
  } catch (err) {
    console.error("[liveness-credentials] AssumeRole failed", { userId, err });
    return { ok: false, error: "api" };
  }
}

function buildSessionName(userId: string): string {
  const safe = userId.replace(/[^\w+=,.@-]/g, "-");
  return `gennety-liveness-${safe}`.slice(0, 64);
}

/** Test-only cache reset. */
export function __resetStsClientForTests(): void {
  cachedClient = null;
}
