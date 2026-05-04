/**
 * Integration test for the Persona webhook handler.
 *
 * Builds a minimal Express app that mounts only the webhook router and drives
 * it via supertest. The face-match pipeline is mocked out — it has its own
 * test suite (`services/verification-pipeline.test.ts`); here we only verify
 * the webhook does the *right things around* the pipeline:
 *   - Verified events flip status to `pending` and schedule the pipeline
 *     asynchronously (Persona gets 200 before Rekognition latency lands).
 *   - Rejected events still flip directly to `rejected` (no pipeline; no
 *     selfie-vs-photo check needed when liveness already failed).
 *   - Forged / stale signatures and intermediate events short-circuit before
 *     touching either DB or pipeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

vi.mock("../config.js", () => ({
  env: {
    PERSONA_TEMPLATE_ID: "itmpl_test",
    PERSONA_ENVIRONMENT_ID: "env_test",
    PERSONA_API_KEY: "persona_sandbox_test",
    PERSONA_WEBHOOK_SECRET: "wbhsec_test",
    PERSONA_HOSTED_URL_BASE: "https://withpersona.com/verify",
  },
}));

type ProfileRow = {
  id: string;
};
type Row = {
  id: string;
  telegramId: bigint;
  verificationStatus: string;
  status: string;
  verifiedAt: Date | null;
  personaInquiryId: string | null;
  profile: ProfileRow | null;
};
const store = new Map<string, Row>();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => store.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const u = store.get(where.id);
        if (!u) throw new Error("not found");
        Object.assign(u, data);
        return u;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status?: string | { not?: string; in?: string[] } };
          data: Partial<Row>;
        }) => {
          const u = store.get(where.id);
          if (!u) return { count: 0 };
          const cond = where.status;
          if (typeof cond === "string" && u.status !== cond) return { count: 0 };
          if (cond && typeof cond === "object") {
            if (cond.not !== undefined && u.status === cond.not) return { count: 0 };
            if (cond.in !== undefined && !cond.in.includes(u.status)) return { count: 0 };
          }
          Object.assign(u, data);
          return { count: 1 };
        },
      ),
    },
  },
}));

const runPipeline = vi.fn(async (..._args: unknown[]) => ({ kind: "verified" as const }));
vi.mock("../services/verification-pipeline.js", () => ({
  runFaceMatchVerificationDefault: runPipeline,
}));

const { createPersonaWebhookRouter } = await import("./routes/persona-webhook.js");
const { prisma } = await import("@gennety/db");

const sendMessage = vi.fn(async () => ({}));
const fakeApi = { sendMessage } as unknown as Parameters<typeof createPersonaWebhookRouter>[0];

function buildApp() {
  const app = express();
  app.use("/v1/webhooks/persona", createPersonaWebhookRouter(fakeApi));
  return app;
}

function sign(ts: string, body: string): string {
  return createHmac("sha256", "wbhsec_test").update(`${ts}.`).update(body).digest("hex");
}

function makePayload(
  status: string,
  referenceId: string = "user-1",
  inquiryId: string = "inq_abc",
  eventName: string = "inquiry.completed",
  refKey: "referenceId" | "reference-id" = "referenceId",
): string {
  return JSON.stringify({
    data: {
      type: "event",
      id: "evt_1",
      attributes: {
        name: eventName,
        payload: {
          data: {
            type: "inquiry",
            id: inquiryId,
            // Default to camelCase since that's what Persona actually emits
            // in the wild (verified against a real sandbox webhook 2026-05-03).
            attributes: { status, [refKey]: referenceId },
          },
        },
      },
    },
  });
}

/**
 * The webhook fires the pipeline via `setImmediate` so Persona gets its 200
 * before Rekognition latency lands. In tests we flush the immediate queue
 * after the request so the pipeline mock's invocation is observable.
 */
async function flushImmediate(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("Persona webhook", () => {
  beforeEach(() => {
    store.clear();
    store.set("user-1", {
      id: "user-1",
      telegramId: 999_001n,
      verificationStatus: "pending",
      status: "onboarding",
      verifiedAt: null,
      personaInquiryId: null,
      profile: { id: "profile-1" },
    });
    sendMessage.mockClear();
    runPipeline.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("schedules the face-match pipeline on completed inquiry (does not flip to verified yet)", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = makePayload("completed");
    const res = await request(buildApp())
      .post("/v1/webhooks/persona")
      .set("content-type", "application/json")
      .set("persona-signature", `t=${ts},v1=${sign(ts, body)}`)
      .send(body);

    expect(res.status).toBe(200);
    await flushImmediate();

    const u = store.get("user-1")!;
    // The webhook only sets `pending` and persists the inquiry id — the
    // pipeline owns the final `verified` / `pending_review` / `rejected`
    // write.
    expect(u.verificationStatus).toBe("pending");
    expect(u.status).toBe("onboarding");
    expect(u.personaInquiryId).toBe("inq_abc");
    expect(u.verifiedAt).toBeNull();

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith("user-1", "inq_abc", fakeApi);

    // The webhook does NOT DM the user — the pipeline does, after the
    // verification decision is final.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("accepts the legacy kebab-case `reference-id` field for backwards compat", async () => {
    // Persona currently emits the field as camelCase `referenceId`; older docs
    // (and earlier versions of the webhook handler) used the kebab-case form.
    // The handler reads both — drop this test only when we're sure no Persona
    // tier still uses kebab-case.
    const ts = String(Math.floor(Date.now() / 1000));
    const body = makePayload(
      "completed",
      "user-1",
      "inq_legacy",
      "inquiry.completed",
      "reference-id",
    );
    const res = await request(buildApp())
      .post("/v1/webhooks/persona")
      .set("content-type", "application/json")
      .set("persona-signature", `t=${ts},v1=${sign(ts, body)}`)
      .send(body);

    expect(res.status).toBe(200);
    await flushImmediate();
    expect(runPipeline).toHaveBeenCalledWith("user-1", "inq_legacy", fakeApi);
  });

  it("also schedules the pipeline on inquiry.approved (auto-approve template)", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = makePayload("approved", "user-1", "inq_xyz", "inquiry.approved");
    const res = await request(buildApp())
      .post("/v1/webhooks/persona")
      .set("content-type", "application/json")
      .set("persona-signature", `t=${ts},v1=${sign(ts, body)}`)
      .send(body);

    expect(res.status).toBe(200);
    await flushImmediate();

    expect(runPipeline).toHaveBeenCalledWith("user-1", "inq_xyz", fakeApi);
    expect(store.get("user-1")!.verificationStatus).toBe("pending");
  });

  it("flips user to rejected on declined inquiry — no pipeline run, liveness already failed", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = makePayload("declined");
    const res = await request(buildApp())
      .post("/v1/webhooks/persona")
      .set("content-type", "application/json")
      .set("persona-signature", `t=${ts},v1=${sign(ts, body)}`)
      .send(body);

    expect(res.status).toBe(200);
    await flushImmediate();

    const u = store.get("user-1")!;
    expect(u.verificationStatus).toBe("rejected");
    expect(u.status).toBe("onboarding"); // unchanged
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("rejects a forged signature with 401 (no pipeline run)", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = makePayload("completed");
    const res = await request(buildApp())
      .post("/v1/webhooks/persona")
      .set("content-type", "application/json")
      .set("persona-signature", `t=${ts},v1=deadbeef`)
      .send(body);

    expect(res.status).toBe(401);
    await flushImmediate();

    expect(store.get("user-1")!.verificationStatus).toBe("pending"); // unchanged
    expect(runPipeline).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a stale signature with 401", async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 10 * 60); // 10 minutes old
    const body = makePayload("completed");
    const res = await request(buildApp())
      .post("/v1/webhooks/persona")
      .set("content-type", "application/json")
      .set("persona-signature", `t=${staleTs},v1=${sign(staleTs, body)}`)
      .send(body);

    expect(res.status).toBe(401);
  });

  it("200-no-ops on unknown reference-id (no pipeline run)", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = makePayload("completed", "ghost-user");
    const res = await request(buildApp())
      .post("/v1/webhooks/persona")
      .set("content-type", "application/json")
      .set("persona-signature", `t=${ts},v1=${sign(ts, body)}`)
      .send(body);

    expect(res.status).toBe(200);
    await flushImmediate();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("returns 500 so Persona retries when the internal handler fails", async () => {
    (prisma.user.update as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    // Status update is wrapped in .catch() so a single update failure no
    // longer cascades to a 500 — instead, we drive the failure through
    // updateMany used by the rejected branch (still synchronous and not
    // catch-wrapped).
    (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    const ts = String(Math.floor(Date.now() / 1000));
    const body = makePayload("declined"); // rejected branch — still synchronous
    const res = await request(buildApp())
      .post("/v1/webhooks/persona")
      .set("content-type", "application/json")
      .set("persona-signature", `t=${ts},v1=${sign(ts, body)}`)
      .send(body);

    expect(res.status).toBe(500);
  });

  it("schedules pipeline regardless of admin-moderated status — admin re-checks let pipeline rerun", async () => {
    // Pre-pipeline regression test ensured that suspended/banned users
    // weren't auto-activated by the webhook. The pipeline now owns
    // activation (gated on status=onboarding internally), so the webhook
    // can fire it unconditionally — moderated states still survive.
    for (const blockedStatus of ["paused", "suspended", "banned", "pending_investigation"]) {
      runPipeline.mockClear();
      store.get("user-1")!.status = blockedStatus;
      store.get("user-1")!.verificationStatus = "pending";
      const ts = String(Math.floor(Date.now() / 1000));
      const body = makePayload("completed");
      const res = await request(buildApp())
        .post("/v1/webhooks/persona")
        .set("content-type", "application/json")
        .set("persona-signature", `t=${ts},v1=${sign(ts, body)}`)
        .send(body);
      expect(res.status).toBe(200);
      await flushImmediate();
      expect(runPipeline).toHaveBeenCalledTimes(1);
      // Webhook only sets verificationStatus=pending; status stays moderated.
      const u = store.get("user-1")!;
      expect(u.status).toBe(blockedStatus);
    }
  });

  it("M-9: ignores non-terminal events (e.g. inquiry.created with approved status)", async () => {
    // Regression: pre-M-9 the handler trusted ANY event name and acted on
    // its `status` field. Persona sometimes emits intermediate events
    // (`inquiry.created`, `inquiry.transitioned`, …) that carry
    // `status: "approved"` purely as state metadata. Acting on those would
    // activate users who haven't actually passed the flow. The allowlist
    // restricts trust to the terminal-decision events.
    const ts = String(Math.floor(Date.now() / 1000));
    const body = makePayload("approved", "user-1", "inq_premature", "inquiry.created");
    const res = await request(buildApp())
      .post("/v1/webhooks/persona")
      .set("content-type", "application/json")
      .set("persona-signature", `t=${ts},v1=${sign(ts, body)}`)
      .send(body);

    expect(res.status).toBe(200);
    await flushImmediate();
    const u = store.get("user-1")!;
    // Webhook short-circuits BEFORE the user lookup — nothing changes.
    expect(u.personaInquiryId).toBeNull();
    expect(u.verificationStatus).toBe("pending");
    expect(u.status).toBe("onboarding");
    expect(runPipeline).not.toHaveBeenCalled();
  });
});
