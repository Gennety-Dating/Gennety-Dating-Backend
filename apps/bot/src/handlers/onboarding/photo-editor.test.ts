import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION, MIN_PHOTOS, type SessionData } from "@gennety/shared";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    profile: { findFirst: vi.fn() },
  },
}));

const consensusMocks = vi.hoisted(() => ({ removeProfilePhotoByRef: vi.fn() }));
vi.mock("../../services/profile-media-validation/identity-consensus.js", () => ({
  removeProfilePhotoByRef: consensusMocks.removeProfilePhotoByRef,
}));

vi.mock("../../services/onboarding-agent.js", () => ({
  recordOnboardingAssistantReply: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../config.js", () => ({
  env: { TICKET_FEATURE_ENABLED: false },
}));

import { prisma } from "@gennety/db";
import {
  closeStalePhotoEditor,
  handleOnboardingPhotoBack,
  handleOnboardingPhotoDelete,
  openOnboardingPhotoEditor,
} from "./photo-editor.js";

function createCtx(overrides: Partial<SessionData> = {}, cardMsgId?: number) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    onboardingStep: "conversational",
    expectingPhoto: true,
    ...overrides,
  };
  let nextMsgId = 900;
  const api = {
    sendPhoto: vi.fn().mockImplementation(() =>
      Promise.resolve({ message_id: nextMsgId++ }),
    ),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    editMessageCaption: vi.fn().mockResolvedValue(undefined),
  };
  return {
    session,
    api,
    chat: { id: 4242 },
    from: { id: 4242 },
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    ...(cardMsgId !== undefined
      ? { callbackQuery: { message: { message_id: cardMsgId } } }
      : {}),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "uuid-user",
  });
});

describe("onboarding photo editor — opening", () => {
  it("loads the canonical set from the database and sends one card per photo", async () => {
    (prisma.profile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      photos: ["p1", "p2", "p3"],
      profileMedia: [],
      photoFaceScores: [0.9, 0.8, 0.7],
      uploadedPhotoHashes: ["h1", "h2", "h3"],
    });
    const ctx = createCtx();

    await openOnboardingPhotoEditor(ctx);

    expect(ctx.session.onboardingPhotoEdit).toBe(true);
    expect(ctx.session.pendingPhotos).toEqual(["p1", "p2", "p3"]);
    expect(ctx.api.sendPhoto).toHaveBeenCalledTimes(3);
    // Each card carries its own delete button, resolved by the card's message.
    for (const call of ctx.api.sendPhoto.mock.calls) {
      expect(JSON.stringify(call[2])).toContain("onb:ph:del");
    }
    expect(ctx.session.photoCards).toHaveLength(3);
  });

  it("offers no ➕ Add button — photos are sent straight into the chat here", async () => {
    (prisma.profile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      photos: ["p1"],
      profileMedia: [],
      photoFaceScores: [0.9],
      uploadedPhotoHashes: ["h1"],
    });
    const ctx = createCtx();

    await openOnboardingPhotoEditor(ctx);

    const panel = JSON.stringify(ctx.api.sendMessage.mock.calls.at(-1));
    expect(panel).toContain("onb:ph:back");
    expect(panel).not.toContain("photos:add");
  });

  it("keeps the stage running so uploads and the bottom panel survive", async () => {
    (prisma.profile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      photos: ["p1"],
      profileMedia: [],
      photoFaceScores: [0.9],
      uploadedPhotoHashes: ["h1"],
    });
    const ctx = createCtx();

    await openOnboardingPhotoEditor(ctx);

    expect(ctx.session.expectingPhoto).toBe(true);
  });

  it("retires a previous editor's cards before sending a fresh set", async () => {
    (prisma.profile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      photos: ["p1"],
      profileMedia: [],
      photoFaceScores: [0.9],
      uploadedPhotoHashes: ["h1"],
    });
    const ctx = createCtx({
      photoCards: [{ msgId: 111, ref: "old" }],
      photoManagerMsgId: 222,
    });

    await openOnboardingPhotoEditor(ctx);

    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(4242, 111);
    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(4242, 222);
  });
});

describe("onboarding photo editor — deleting", () => {
  it("deletes below MIN_PHOTOS — the user is not in the matching pool yet", async () => {
    const photos = Array.from({ length: MIN_PHOTOS }, (_, i) => `p${i + 1}`);
    consensusMocks.removeProfilePhotoByRef.mockResolvedValue({
      photos: photos.slice(1),
      profileMedia: [],
      uploadedPhotoHashes: ["h2", "h3"],
      photoFaceScores: [0.8, 0.7],
    });
    const ctx = createCtx(
      {
        pendingPhotos: [...photos],
        pendingPhotoScores: [0.9, 0.8, 0.7],
        pendingPhotoHashes: ["h1", "h2", "h3"],
        pendingPhotoUniqueIds: ["", "", ""],
        photoCards: photos.map((ref, i) => ({ msgId: 700 + i, ref })),
      },
      700,
    );

    await handleOnboardingPhotoDelete(ctx);

    // No "you need at least N photos" refusal — the tap went through.
    expect(ctx.answerCallbackQuery).not.toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
    expect(consensusMocks.removeProfilePhotoByRef).toHaveBeenCalledWith(
      "uuid-user",
      "p1",
    );
    expect(ctx.session.pendingPhotos).toEqual(["p2", "p3"]);
  });

  it("keeps photos, scores and hashes aligned 1:1 after a delete", async () => {
    consensusMocks.removeProfilePhotoByRef.mockResolvedValue({
      photos: ["p1", "p3"],
      profileMedia: [],
      uploadedPhotoHashes: ["h1", "h3"],
      photoFaceScores: [0.9, 0.7],
    });
    const ctx = createCtx(
      {
        pendingPhotos: ["p1", "p2", "p3"],
        pendingPhotoScores: [0.9, 0.8, 0.7],
        pendingPhotoHashes: ["h1", "h2", "h3"],
        pendingPhotoUniqueIds: ["u1", "u2", "u3"],
        photoCards: [
          { msgId: 700, ref: "p1" },
          { msgId: 701, ref: "p2" },
          { msgId: 702, ref: "p3" },
        ],
      },
      701,
    );

    await handleOnboardingPhotoDelete(ctx);

    const { pendingPhotos, pendingPhotoScores, pendingPhotoHashes, pendingPhotoUniqueIds } =
      ctx.session;
    expect(pendingPhotos).toEqual(["p1", "p3"]);
    expect(pendingPhotoScores).toHaveLength(pendingPhotos.length);
    expect(pendingPhotoHashes).toHaveLength(pendingPhotos.length);
    expect(pendingPhotoUniqueIds).toHaveLength(pendingPhotos.length);
    // The surviving photos keep THEIR own values, not shifted neighbours'.
    expect(pendingPhotoScores).toEqual([0.9, 0.7]);
    expect(pendingPhotoUniqueIds).toEqual(["u1", "u3"]);
  });

  it("drops the tapped card's own message and stops tracking it", async () => {
    consensusMocks.removeProfilePhotoByRef.mockResolvedValue({
      photos: ["p2"],
      profileMedia: [],
      uploadedPhotoHashes: ["h2"],
      photoFaceScores: [0.8],
    });
    const ctx = createCtx(
      {
        pendingPhotos: ["p1", "p2"],
        pendingPhotoScores: [0.9, 0.8],
        pendingPhotoHashes: ["h1", "h2"],
        pendingPhotoUniqueIds: ["u1", "u2"],
        photoCards: [
          { msgId: 700, ref: "p1" },
          { msgId: 701, ref: "p2" },
        ],
      },
      700,
    );

    await handleOnboardingPhotoDelete(ctx);

    expect(ctx.api.deleteMessage).toHaveBeenCalledWith(4242, 700);
    expect(ctx.session.photoCards.map((c: { ref: string }) => c.ref)).not.toContain("p1");
  });

  it("treats a replayed tap on an already-deleted card as a no-op", async () => {
    const ctx = createCtx(
      {
        pendingPhotos: ["p2"],
        pendingPhotoScores: [0.8],
        pendingPhotoHashes: ["h2"],
        pendingPhotoUniqueIds: ["u2"],
        photoCards: [{ msgId: 701, ref: "p2" }],
      },
      700, // card that is no longer tracked
    );

    await handleOnboardingPhotoDelete(ctx);

    expect(consensusMocks.removeProfilePhotoByRef).not.toHaveBeenCalled();
    expect(ctx.session.pendingPhotos).toEqual(["p2"]);
    expect(ctx.api.deleteMessage).not.toHaveBeenCalled();
  });
});

describe("onboarding photo editor — leaving", () => {
  it("strips the card buttons and returns the stage progress message", async () => {
    const ctx = createCtx({
      onboardingPhotoEdit: true,
      pendingPhotos: ["p1", "p2"],
      photoCards: [
        { msgId: 700, ref: "p1" },
        { msgId: 701, ref: "p2" },
      ],
      photoManagerMsgId: 800,
    });

    await handleOnboardingPhotoBack(ctx);

    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(4242, 700);
    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(4242, 701);
    expect(ctx.session.onboardingPhotoEdit).toBe(false);
    expect(ctx.session.photoCards).toEqual([]);
    // Back under the minimum → the "you need N more" copy, and no Continue.
    const lastSend = ctx.api.sendMessage.mock.calls.at(-1);
    expect(String(lastSend[1])).toContain(`2/${MIN_PHOTOS}`);
    expect(JSON.stringify(lastSend[2] ?? {})).not.toContain("photos:continue");
  });

  it("retires a still-open editor when the stage ended underneath it", async () => {
    const ctx = createCtx({
      expectingPhoto: false,
      onboardingPhotoEdit: true,
      photoCards: [{ msgId: 700, ref: "p1" }],
      photoManagerMsgId: 800,
    });

    await closeStalePhotoEditor(ctx.api, 4242, ctx.session);

    expect(ctx.api.editMessageReplyMarkup).toHaveBeenCalledWith(4242, 700);
    expect(ctx.session.onboardingPhotoEdit).toBe(false);
  });

  it("leaves the editor alone while the stage is still running", async () => {
    const ctx = createCtx({
      expectingPhoto: true,
      onboardingPhotoEdit: true,
      photoCards: [{ msgId: 700, ref: "p1" }],
    });

    await closeStalePhotoEditor(ctx.api, 4242, ctx.session);

    expect(ctx.api.editMessageReplyMarkup).not.toHaveBeenCalled();
    expect(ctx.session.onboardingPhotoEdit).toBe(true);
  });
});
