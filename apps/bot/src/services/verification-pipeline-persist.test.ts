/**
 * The production persistence behind the face-match pipeline, driven through
 * `runFaceMatchVerificationDefault` against an in-memory user row.
 *
 * `verification-pipeline.test.ts` pins the decision logic with a stub `db`;
 * what it cannot see is whether the real writes honour the contract that logic
 * relies on. The defects these cases guard against lived exactly there:
 *   - A13-H12: the activating write never compared the photos it scored with
 *     the photos on the row, so an upload landing mid-run was activated with
 *     the account without ever being compared to the selfie.
 *   - A13-L18: the mismatched-photo drop rewrote the photo arrays without the
 *     per-user lock every photo writer takes.
 *   - A13-H11: a failed selfie upload overwrote a stored reference with null.
 *
 * Only the four identity-evidence deps are replaced (`depsOverride`, the same
 * seam demo mode uses), so the decision, the retry loop and the Prisma writes
 * all run as in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface ProfileRow {
  photos: string[];
  photoFaceScores: number[];
  uploadedPhotoHashes: string[];
  profileMedia: unknown[];
  eloSeededAt: Date | null;
}

interface UserRow {
  id: string;
  telegramId: bigint;
  platform: string;
  status: string;
  onboardingStep: string;
  registrationTrack: string | null;
  email: string | null;
  isEmailVerified: boolean;
  phoneVerifiedAt: Date | null;
  gender: string;
  language: string;
  verificationStatus: string;
  personaInquiryId: string | null;
  faceMatchedAt: Date | null;
  verifiedSelfiePath: string | null;
  profile: ProfileRow;
}

const state = vi.hoisted(() => ({
  row: null as UserRow | null,
  /** Ordered trace of transaction boundaries, locks and profile reads/writes. */
  events: [] as string[],
  /** Every `data` object written to the user row, in order. */
  userWrites: [] as Array<Record<string, unknown>>,
}));

function currentRow(): UserRow {
  if (!state.row) throw new Error("no row seeded");
  return state.row;
}

function copyRow(row: UserRow): UserRow {
  return { ...row, profile: { ...row.profile, photos: [...row.profile.photos] } };
}

vi.mock("@gennety/db", () => {
  const client = {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) state.events.push("lock");
      return [];
    }),
    user: {
      findUnique: vi.fn(async () => (state.row ? copyRow(state.row) : null)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.userWrites.push(data);
        Object.assign(currentRow(), data);
        return currentRow();
      }),
      // Honoured the way Postgres would, so the pre-fix activating write
      // (`updateMany where status = onboarding`) behaves as it did in production.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { status?: string | { not: string }; personaInquiryId?: string };
          data: Record<string, unknown>;
        }) => {
          const row = currentRow();
          if (typeof where.status === "string" && row.status !== where.status) return { count: 0 };
          if (typeof where.status === "object" && row.status === where.status.not) {
            return { count: 0 };
          }
          if (where.personaInquiryId !== undefined && row.personaInquiryId !== where.personaInquiryId) {
            return { count: 0 };
          }
          state.userWrites.push(data);
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    profile: {
      findUnique: vi.fn(async () => {
        state.events.push("profile.read");
        const profile = currentRow().profile;
        return { ...profile, photos: [...profile.photos] };
      }),
      update: vi.fn(async ({ data }: { data: Partial<ProfileRow> }) => {
        state.events.push("profile.write");
        Object.assign(currentRow().profile, data);
        return currentRow().profile;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { photos?: { equals: string[] } }; data: Partial<ProfileRow> }) => {
          const profile = currentRow().profile;
          if (where.photos && where.photos.equals.join("|") !== profile.photos.join("|")) {
            return { count: 0 };
          }
          state.events.push("profile.write");
          Object.assign(profile, data);
          return { count: 1 };
        },
      ),
    },
  };
  return {
    prisma: {
      ...client,
      $transaction: vi.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
        state.events.push("tx");
        return fn(client);
      }),
    },
  };
});

vi.mock("./push.js", () => ({ sendPushToUser: vi.fn(async () => true) }));
vi.mock("./founder-notify.js", () => ({ notifyFounderNewUser: vi.fn(async () => undefined) }));

const { runFaceMatchVerificationDefault } = await import("./verification-pipeline.js");

const USER_ID = "3f1c2b8e-7a4d-4e21-9b6f-0c5d8a7e1f22";
const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const SELFIE = Buffer.from("selfie");
const api = { sendMessage: vi.fn(async () => ({})) } as never;

function seed(overrides: Partial<UserRow> = {}): UserRow {
  state.row = {
    id: USER_ID,
    // An app account: nothing here is meant to reach Telegram.
    telegramId: -42n,
    platform: "mobile",
    status: "onboarding",
    onboardingStep: "completed",
    registrationTrack: "general",
    email: null,
    isEmailVerified: false,
    phoneVerifiedAt: new Date("2026-08-01T00:00:00Z"),
    gender: "female",
    language: "en",
    verificationStatus: "pending",
    personaInquiryId: null,
    faceMatchedAt: null,
    verifiedSelfiePath: null,
    profile: {
      photos: ["a", "b", "c", "d"],
      photoFaceScores: [],
      uploadedPhotoHashes: [],
      profileMedia: [],
      eloSeededAt: null,
    },
    ...overrides,
  };
  return state.row;
}

/**
 * Evidence deps. `onPassStart` runs when a scoring pass downloads its first
 * photo — the moment to play an upload committing while the run is scoring.
 */
function evidence(options: {
  onPassStart?: (pass: number) => void;
  similarityFor?: (photo: string) => number;
  uploadFails?: boolean;
}) {
  let pass = 0;
  return {
    fetchReferenceSelfie: async () => ({ ok: true as const, selfie: { buffer: SELFIE, mime: "image/jpeg" } }),
    uploadSelfie: async () => {
      if (options.uploadFails) throw new Error("storage down");
      return { path: `${USER_ID}/selfie-new.jpg` };
    },
    downloadProfileImage: async (path: string) => {
      if (path === "a") options.onPassStart?.(++pass);
      return Buffer.from(path);
    },
    compareFaces: async (_selfie: Buffer, photo: Buffer) => ({
      ok: true as const,
      similarity: options.similarityFor?.(photo.toString()) ?? 0.95,
      faceFound: true,
    }),
  };
}

beforeEach(() => {
  state.row = null;
  state.events = [];
  state.userWrites = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runFaceMatchVerificationDefault — photos changed under the run (A13-H12)", () => {
  it("never activates while the photos it scored are not the photos on the row", async () => {
    // An upload commits during EVERY scoring pass, so no verdict ever matches
    // the row. Before the fix the first verdict activated the account anyway.
    const row = seed();
    let uploads = 0;
    const outcome = await runFaceMatchVerificationDefault(USER_ID, SESSION_ID, api, {
      depsOverride: evidence({
        onPassStart: () => {
          uploads += 1;
          row.profile.photos.push(`upload-${uploads}`);
        },
      }),
    });

    expect(outcome).toMatchObject({ kind: "retry_required", reason: "photos_changed_during_run" });
    expect(row.status).toBe("onboarding");
    expect(state.userWrites.some((data) => data.status === "active")).toBe(false);
    expect(row.verificationStatus).toBe("pending");
    // Parked with the reference recorded, so the next photo edit reruns
    // against this selfie instead of answering `no_inquiry`.
    expect(row.personaInquiryId).toBe(SESSION_ID);
    expect(row.verifiedSelfiePath).toBe(`${USER_ID}/selfie-new.jpg`);
    expect(row.faceMatchedAt).toBeNull();
  });

  it("re-scores the upload and activates only over the set it scored, dropping the planted photo", async () => {
    const row = seed();
    const outcome = await runFaceMatchVerificationDefault(USER_ID, SESSION_ID, api, {
      depsOverride: evidence({
        onPassStart: (pass) => {
          if (pass === 1) row.profile.photos.push("impostor");
        },
        similarityFor: (photo) => (photo === "impostor" ? 0.2 : 0.95),
      }),
    });

    expect(outcome.kind).toBe("verified");
    expect(row.status).toBe("active");
    expect(row.verificationStatus).toBe("verified");
    // The impostor photo was scored — and removed — rather than activated
    // unseen, and the score array stayed aligned with what is left.
    expect(row.profile.photos).toEqual(["a", "b", "c", "d"]);
    expect(row.profile.photoFaceScores).toEqual([0.95, 0.95, 0.95, 0.95]);
  });
});

describe("runFaceMatchVerificationDefault — locking (A13-L18)", () => {
  it("drops mismatched photos under the per-user lock, before reading the arrays", async () => {
    const row = seed({
      profile: {
        photos: ["a", "b", "c", "d", "e"],
        photoFaceScores: [],
        uploadedPhotoHashes: [],
        profileMedia: [],
        eloSeededAt: null,
      },
    });
    await runFaceMatchVerificationDefault(USER_ID, SESSION_ID, api, {
      depsOverride: evidence({ similarityFor: (photo) => (photo === "e" ? 0.2 : 0.95) }),
    });

    expect(row.profile.photos).toEqual(["a", "b", "c", "d"]);
    // Two transactions: the verdict, then the drop. Each takes the lock before
    // it reads anything it is about to rewrite.
    const transactions = state.events.join(" ").split("tx").map((part) => part.trim()).filter(Boolean);
    expect(transactions).toHaveLength(2);
    for (const transaction of transactions) {
      expect(transaction.startsWith("lock")).toBe(true);
    }
    expect(transactions[1]).toBe("lock profile.read profile.write");
  });
});

describe("runFaceMatchVerificationDefault — stored reference (A13-H11)", () => {
  it("keeps the stored selfie when this run's upload fails", async () => {
    const row = seed({ verifiedSelfiePath: `${USER_ID}/selfie-old.jpg` });
    const outcome = await runFaceMatchVerificationDefault(USER_ID, SESSION_ID, api, {
      depsOverride: evidence({ uploadFails: true }),
    });

    expect(outcome.kind).toBe("verified");
    // Nulling it would answer every later photo upload with `reference_expired`.
    expect(row.verifiedSelfiePath).toBe(`${USER_ID}/selfie-old.jpg`);
  });

  it("parks a zero-photo run as retryable without touching the stored selfie", async () => {
    const row = seed({
      verificationStatus: "rejected",
      verifiedSelfiePath: `${USER_ID}/selfie-old.jpg`,
      profile: {
        photos: [],
        photoFaceScores: [],
        uploadedPhotoHashes: [],
        profileMedia: [],
        eloSeededAt: null,
      },
    });
    const outcome = await runFaceMatchVerificationDefault(USER_ID, SESSION_ID, api, {
      depsOverride: evidence({}),
    });

    expect(outcome).toMatchObject({ kind: "retry_required", reason: "no_profile_photos" });
    expect(row.verificationStatus).toBe("pending");
    expect(row.verifiedSelfiePath).toBe(`${USER_ID}/selfie-old.jpg`);
  });
});
