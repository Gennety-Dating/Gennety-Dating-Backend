import { afterEach, describe, expect, it, vi } from "vitest";
import { AssumeRoleCommand, type STSClient } from "@aws-sdk/client-sts";

const env = {
  AWS_ACCESS_KEY_ID: "AKIA_TEST",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_REGION: "eu-central-1",
  LIVENESS_STS_ROLE_ARN: "arn:aws:iam::147010141827:role/GennetyLivenessClient",
  LIVENESS_CREDENTIALS_TTL_SECONDS: 900,
};

vi.mock("../config.js", () => ({ env }));

const { mintLivenessCredentials, __resetStsClientForTests } = await import(
  "./liveness-credentials.js"
);

const EXPIRY = new Date("2026-07-26T12:15:00.000Z");

function makeClient(output: Record<string, unknown> | Error): {
  client: Pick<STSClient, "send">;
  commands: AssumeRoleCommand[];
} {
  const commands: AssumeRoleCommand[] = [];
  const client = {
    send: vi.fn(async (command: AssumeRoleCommand) => {
      commands.push(command);
      if (output instanceof Error) throw output;
      return { $metadata: {}, ...output };
    }) as unknown as STSClient["send"],
  };
  return { client, commands };
}

const GOOD_CREDS = {
  Credentials: {
    AccessKeyId: "ASIA_TEMP",
    SecretAccessKey: "temp-secret",
    SessionToken: "temp-token",
    Expiration: EXPIRY,
  },
};

afterEach(() => {
  __resetStsClientForTests();
  env.LIVENESS_STS_ROLE_ARN = "arn:aws:iam::147010141827:role/GennetyLivenessClient";
  vi.restoreAllMocks();
});

describe("mintLivenessCredentials", () => {
  it("returns temporary credentials with an ISO expiry", async () => {
    const { client } = makeClient(GOOD_CREDS);

    const result = await mintLivenessCredentials("user-1", { client });

    expect(result).toEqual({
      ok: true,
      credentials: {
        accessKeyId: "ASIA_TEMP",
        secretAccessKey: "temp-secret",
        sessionToken: "temp-token",
        expiration: EXPIRY.toISOString(),
      },
    });
  });

  it("clamps the credentials to StartFaceLivenessSession via a session policy", async () => {
    // The browser holds these credentials. Even if the role is widened later,
    // the session policy is the ceiling the client actually gets.
    const { client, commands } = makeClient(GOOD_CREDS);

    await mintLivenessCredentials("user-1", { client });

    const policy = JSON.parse(commands[0]!.input.Policy!) as {
      Statement: Array<{ Action: string }>;
    };
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]!.Action).toBe("rekognition:StartFaceLivenessSession");
  });

  it("uses the configured role and AWS's 900s floor", async () => {
    const { client, commands } = makeClient(GOOD_CREDS);

    await mintLivenessCredentials("user-1", { client });

    expect(commands[0]!.input.RoleArn).toBe(env.LIVENESS_STS_ROLE_ARN);
    expect(commands[0]!.input.DurationSeconds).toBe(900);
  });

  it("builds an attributable, AWS-legal session name", async () => {
    const { client, commands } = makeClient(GOOD_CREDS);

    await mintLivenessCredentials("abc/def ghi", { client });

    const name = commands[0]!.input.RoleSessionName!;
    expect(name).toBe("gennety-liveness-abc-def-ghi");
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[\w+=,.@-]+$/);
  });

  it("truncates a long session name to AWS's 64-char cap", async () => {
    const { client, commands } = makeClient(GOOD_CREDS);

    await mintLivenessCredentials("x".repeat(200), { client });

    expect(commands[0]!.input.RoleSessionName!.length).toBe(64);
  });

  it("reports not_configured when no role ARN is set", async () => {
    env.LIVENESS_STS_ROLE_ARN = "";
    const { client, commands } = makeClient(GOOD_CREDS);

    const result = await mintLivenessCredentials("user-1", { client });

    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(commands).toHaveLength(0);
  });

  it("fails closed when STS returns an incomplete credential set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeClient({
      Credentials: { AccessKeyId: "ASIA_TEMP", Expiration: EXPIRY },
    });

    const result = await mintLivenessCredentials("user-1", { client });

    expect(result).toEqual({ ok: false, error: "api" });
  });

  it("swallows an AssumeRole throw into ok:false", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeClient(new Error("AccessDenied"));

    const result = await mintLivenessCredentials("user-1", { client });

    expect(result).toEqual({ ok: false, error: "api" });
  });
});
