import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION, MIN_PHOTOS, MAX_PHOTOS } from "@gennety/shared";

// Mock prisma before importing handlers.
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    profile: {
      update: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ photos: [] }),
    },
    match: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn().mockResolvedValue(null),
  },
}));

// Avoid loading config.ts (requires BOT_TOKEN) during tests.
vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    SMTP_FROM: "test@test.invalid",
    OPENAI_API_KEY: "",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    CUSTOM_EMOJI_MENU_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

vi.mock("../../services/vision/validate-face.js", () => ({
  validateSingleFace: vi.fn().mockResolvedValue({ ok: true, valid: true }),
}));

vi.mock("../../services/face-match-gate.js", () => ({
  fetchTelegramFileBuffer: vi.fn().mockResolvedValue(Buffer.from("photo-bytes")),
  gateProfilePhoto: vi.fn().mockResolvedValue({ kind: "allowed", score: 0.91 }),
}));

vi.mock("../../services/verification-pipeline.js", () => ({
  triggerVerificationRerun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/profile-video.js", () => ({
  prepareProfileVideo: vi.fn().mockResolvedValue({
    kind: "accepted",
    media: { type: "video", video: "vid-new" },
    statusAcknowledged: false,
  }),
  videoSavedAck: vi.fn().mockReturnValue("Video added ✅"),
}));

vi.mock("../../services/ticket-wallet.js", () => ({
  getBalance: vi.fn().mockResolvedValue(0),
  grantVideoBonusIfEligible: vi.fn().mockResolvedValue({ granted: false, balance: 0 }),
  grantPhotoBonusIfEligible: vi.fn().mockResolvedValue({ granted: false, balance: 0 }),
}));

vi.mock("../../services/ticket-reward.js", () => ({
  sendTicketRewardDM: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import { showMainMenu, buildMainMenuKeyboard } from "./main.js";
import { handleMyProfile } from "./my-profile.js";
import { handlePause, handleResume } from "./pause.js";
import {
  handleSettingsOpen,
  handleSettingsLanguageOpen,
  handleSettingsLanguageSet,
  handleSettingsThemeOpen,
  handleSettingsThemeSet,
  handleDeleteAccountStart,
  handleFreezeAccount,
  handleDeleteAccountConfirm,
  handleDeleteAccountExecute,
} from "./settings.js";
import { handleHelp } from "./help.js";
import {
  handleEditOpen,
  handleEditBioStart,
  handleEditBioInput,
  handleEditMajorStart,
  handleEditMajorInput,
  handleEditPrefsOpen,
  handleEditAgeRangeStart,
  handleEditAgeRangeInput,
  handleEditPhotosStart,
  handleEditPhotosUpload,
  handleEditPhotosAdd,
  handleEditPhotosDelete,
} from "./edit-profile.js";
import {
  handleEditVideoStart,
  handleEditVideoUpload,
  handleEditVideoRemove,
} from "./video.js";
import { prepareProfileVideo } from "../../services/profile-video.js";
import { grantVideoBonusIfEligible } from "../../services/ticket-wallet.js";
import { isPinnedMessageServiceUpdate, menuRouter } from "./router.js";
import { validateSingleFace } from "../../services/vision/validate-face.js";
import {
  fetchTelegramFileBuffer,
  gateProfilePhoto,
} from "../../services/face-match-gate.js";

function createMockCtx(overrides: {
  session?: Partial<SessionData>;
  callbackData?: string;
  message?: Record<string, unknown>;
  messageText?: string;
  photoFileIds?: string[];
  fromId?: number;
}) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    pendingPhotos: [],
    menuState: "idle",
    onboardingStep: "completed",
    ...overrides.session,
  };

  const message = overrides.message
    ? overrides.message
    : overrides.messageText
    ? { text: overrides.messageText }
    : overrides.photoFileIds
      ? { photo: overrides.photoFileIds.map((id) => ({ file_id: id })) }
      : undefined;
  const callbackQuery = overrides.callbackData ? { data: overrides.callbackData } : undefined;

  return {
    session,
    from: { id: overrides.fromId ?? 12345 },
    chat: { id: overrides.fromId ?? 12345 },
    callbackQuery,
    message,
    update: {
      ...(message ? { message } : {}),
      ...(callbackQuery ? { callback_query: callbackQuery } : {}),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
    api: {
      getFile: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendVideoNote: vi.fn().mockResolvedValue(undefined),
      unpinAllChatMessages: vi.fn().mockResolvedValue(undefined),
      token: "test",
    },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  } as any;
}

const mockUser = {
  id: "uuid-user-1",
  telegramId: BigInt(12345),
  firstName: "Alice",
  surname: "Smith",
  age: 21,
  universityDomain: "stanford.edu",
  language: "en",
  status: "active",
  profile: {
    psychologicalSummary: "Curious introvert who loves jazz.",
  },
};

describe("Menu — main keyboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "active" });
  });

  it("buildMainMenuKeyboard shows Pause label when status is active", () => {
    const ctx = createMockCtx({});
    const kb = buildMainMenuKeyboard(ctx, "active");
    const serialized = JSON.stringify(kb.inline_keyboard);
    expect(serialized).toContain("menu:pause");
    expect(serialized).not.toContain("menu:resume");
  });

  it("buildMainMenuKeyboard shows Resume label when status is paused", () => {
    const ctx = createMockCtx({});
    const kb = buildMainMenuKeyboard(ctx, "paused");
    const serialized = JSON.stringify(kb.inline_keyboard);
    expect(serialized).toContain("menu:resume");
    expect(serialized).not.toContain('"menu:pause"');
  });

  it("buildMainMenuKeyboard hides pause/resume for locked statuses", () => {
    const ctx = createMockCtx({});
    const kb = buildMainMenuKeyboard(ctx, "locked");
    const serialized = JSON.stringify(kb.inline_keyboard);
    expect(serialized).not.toContain("menu:pause");
    expect(serialized).not.toContain("menu:resume");
  });

  it("showMainMenu queries user status and sends the keyboard", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "paused" });
    const ctx = createMockCtx({});
    await showMainMenu(ctx);
    expect(prisma.user.findUnique).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledOnce();
    const callArgs = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[1].parse_mode).toBe("Markdown");
    expect(callArgs[1].reply_markup).toBeDefined();
  });
});

describe("Menu router — Telegram service messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "active" });
  });

  it("ignores the service update emitted when the status banner is pinned", async () => {
    const message = {
      message_id: 42,
      date: 1_775_712_000,
      chat: { id: 12345, type: "private" },
      pinned_message: {
        message_id: 41,
        date: 1_775_712_000,
        chat: { id: 12345, type: "private" },
        text: "Next match drops soon.",
      },
    };
    const ctx = createMockCtx({ message });
    const next = vi.fn();

    expect(isPinnedMessageServiceUpdate(ctx)).toBe(true);

    await menuRouter.middleware()(ctx, next);

    expect(ctx.reply).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});

describe("Menu — My Profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders bio from Profile.psychologicalSummary", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);
    const ctx = createMockCtx({ callbackData: "menu:profile" });
    await handleMyProfile(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    // calls[0] is the "how your match sees you" header; the body + edit
    // controls land in the following reply.
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(body).toContain("Alice Smith");
    expect(body).toContain("21");
    expect(body).toContain("stanford.edu");
    expect(body).toContain("Curious introvert");
    // Combined view+edit: outcome-named edit actions ride on the profile.
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[1][1].reply_markup;
    const serialized = JSON.stringify(markup);
    expect(serialized).toContain("menu:edit:bio");
    expect(serialized).toContain("menu:edit:prefs");
    expect(serialized).toContain("menu:edit:major");
    expect(serialized).toContain("menu:edit:photos");
  });

  it("renders occupation on its own line when set", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockUser,
      major: "Veterinarian",
    });
    const ctx = createMockCtx({ callbackData: "menu:profile" });
    await handleMyProfile(ctx);
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(body).toContain("💼 Veterinarian");
  });

  it("falls back to no-bio copy when summary is missing", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockUser,
      profile: { psychologicalSummary: null },
    });
    const ctx = createMockCtx({ callbackData: "menu:profile" });
    await handleMyProfile(ctx);
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(body).toContain("No bio yet");
  });
});

describe("Menu — Pause / Resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "paused" });
  });

  it("handlePause writes status=paused", async () => {
    const ctx = createMockCtx({ callbackData: "menu:pause" });
    await handlePause(ctx);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "paused" }),
      }),
    );
  });

  it("handleResume writes status=active", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "paused" });
    const ctx = createMockCtx({ callbackData: "menu:resume" });
    await handleResume(ctx);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "active" }),
      }),
    );
  });

  it("handleResume ignores non-paused users", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "banned" });
    const ctx = createMockCtx({ callbackData: "menu:resume" });
    await handleResume(ctx);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("Menu — Settings (language change)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "active" });
  });

  it("handleSettingsOpen shows the settings sub-menu", async () => {
    const ctx = createMockCtx({ callbackData: "menu:settings" });
    await handleSettingsOpen(ctx);
    expect(ctx.reply).toHaveBeenCalled();
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
    expect(JSON.stringify(markup)).toContain("menu:settings:lang");
  });

  it("handleSettingsLanguageOpen sets menuState=settings_lang", async () => {
    const ctx = createMockCtx({ callbackData: "menu:settings:lang" });
    await handleSettingsLanguageOpen(ctx);
    expect(ctx.session.menuState).toBe("settings_lang");
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
    expect(JSON.stringify(markup)).toContain("menu:lang:en");
    expect(JSON.stringify(markup)).toContain("menu:lang:ru");
    expect(JSON.stringify(markup)).toContain("menu:lang:uk");
    expect(JSON.stringify(markup)).toContain("menu:lang:de");
    expect(JSON.stringify(markup)).toContain("menu:lang:pl");
  });

  it("handleSettingsLanguageSet persists ru and resets menuState", async () => {
    const ctx = createMockCtx({
      session: { menuState: "settings_lang", language: "en" },
      callbackData: "menu:lang:ru",
    });
    await handleSettingsLanguageSet(ctx);
    expect(ctx.session.language).toBe("ru");
    expect(ctx.session.menuState).toBe("idle");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ language: "ru" }),
      }),
    );
  });

  it("handleSettingsLanguageSet ignores invalid language codes", async () => {
    const ctx = createMockCtx({
      session: { menuState: "settings_lang", language: "en" },
      callbackData: "menu:lang:xx",
    });
    await handleSettingsLanguageSet(ctx);
    expect(ctx.session.language).toBe("en");
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("Menu — Settings (theme change)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "active" });
  });

  it("handleSettingsOpen shows the theme entry", async () => {
    const ctx = createMockCtx({ callbackData: "menu:settings" });
    await handleSettingsOpen(ctx);
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
    expect(JSON.stringify(markup)).toContain("menu:settings:theme");
  });

  it("handleSettingsThemeOpen sets menuState=settings_theme + shows both themes", async () => {
    const ctx = createMockCtx({ callbackData: "menu:settings:theme" });
    await handleSettingsThemeOpen(ctx);
    expect(ctx.session.menuState).toBe("settings_theme");
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
    expect(JSON.stringify(markup)).toContain("menu:theme:dark");
    expect(JSON.stringify(markup)).toContain("menu:theme:light");
  });

  it("handleSettingsThemeSet persists light and resets menuState", async () => {
    const ctx = createMockCtx({
      session: { menuState: "settings_theme", language: "en" },
      callbackData: "menu:theme:light",
    });
    await handleSettingsThemeSet(ctx);
    expect(ctx.session.menuState).toBe("idle");
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ theme: "light" }),
      }),
    );
  });

  it("handleSettingsThemeSet ignores invalid themes", async () => {
    const ctx = createMockCtx({
      session: { menuState: "settings_theme", language: "en" },
      callbackData: "menu:theme:sepia",
    });
    await handleSettingsThemeSet(ctx);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("Menu — Edit Profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);
    (prisma.profile.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("handleEditOpen shows fixed fields and all editable actions", async () => {
    const ctx = createMockCtx({ callbackData: "menu:edit" });
    await handleEditOpen(ctx);
    // menu:edit now delegates to the combined My Profile screen: calls[0] is
    // the header, calls[1] carries the body + edit controls.
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[1][0];
    // Fixed fields are rendered read-only
    expect(body).toContain("Alice Smith");
    expect(body).toContain("21");
    expect(body).toContain("stanford.edu");
    // All editable actions present
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[1][1].reply_markup;
    const serialized = JSON.stringify(markup);
    expect(serialized).toContain("menu:edit:bio");
    expect(serialized).toContain("menu:edit:prefs");
    expect(serialized).toContain("menu:edit:major");
    expect(serialized).toContain("menu:edit:photos");
    // No buttons for fixed fields
    expect(serialized).not.toContain("menu:edit:name");
    expect(serialized).not.toContain("menu:edit:age");
    expect(serialized).not.toContain("menu:edit:university");
  });

  it("handleEditPhotosStart transitions menuState to edit_photos", async () => {
    const ctx = createMockCtx({ callbackData: "menu:edit:photos" });
    await handleEditPhotosStart(ctx);
    expect(ctx.session.menuState).toBe("edit_photos");
    expect(ctx.session.pendingPhotos).toEqual([]);
    expect(ctx.session.pendingProfileMedia).toEqual([]);
  });

  it("handleEditPhotosUpload commits on continue button and resets state", async () => {
    const ctx = createMockCtx({
      session: {
        menuState: "edit_photos",
        pendingPhotos: ["file_1", "file_2", "file_3", "file_4"],
      },
      callbackData: "menu:edit:photos:continue",
    });
    await handleEditPhotosUpload(ctx);
    // photoFaceScores is committed in lockstep with photos (Step 4 face-match
    // gate). Pending session has no scores yet, so we expect the array
    // padded with 0s to keep the index alignment invariant.
    expect(prisma.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "uuid-user-1" },
        data: expect.objectContaining({
          photos: ["file_1", "file_2", "file_3", "file_4"],
          profileMedia: [
            { type: "photo", photo: "file_1" },
            { type: "photo", photo: "file_2" },
            { type: "photo", photo: "file_3" },
            { type: "photo", photo: "file_4" },
          ],
          photoFaceScores: [0, 0, 0, 0],
          acceptedPhotoCount: 4,
          uploadedPhotoHashes: [],
          referenceFaceEmbedding: expect.objectContaining({
            kind: "reference_photo",
            photoRef: "file_1",
          }),
        }),
      }),
    );
    expect(ctx.session.menuState).toBe("idle");
    expect(ctx.session.pendingPhotos).toEqual([]);
  });

  it("handleEditPhotosUpload ignores continue with zero pending photos", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_photos", pendingPhotos: [] },
      callbackData: "menu:edit:photos:continue",
    });
    await handleEditPhotosUpload(ctx);
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(ctx.session.menuState).toBe("edit_photos");
  });

  it("handleEditPhotosUpload accepts Live Photo and stores static frame + structured media", async () => {
    const ctx = createMockCtx({
      session: {
        menuState: "edit_photos",
        pendingPhotos: [],
        pendingProfileMedia: [],
        pendingPhotoUniqueIds: [],
        pendingPhotoScores: [],
      },
      message: {
        live_photo: {
          file_id: "live_1",
          file_unique_id: "live_unique_1",
          duration: 5,
          width: 720,
          height: 1280,
          file_size: 2048,
          photo: [
            {
              file_id: "static_1",
              file_unique_id: "static_unique_1",
              width: 800,
              height: 800,
            },
          ],
        },
      },
    });

    await handleEditPhotosUpload(ctx);

    expect(validateSingleFace).toHaveBeenCalledWith(ctx, "static_1");
    expect(fetchTelegramFileBuffer).toHaveBeenCalledWith(ctx.api, "static_1");
    expect(gateProfilePhoto).toHaveBeenCalledWith(
      "uuid-user-1",
      Buffer.from("photo-bytes"),
    );
    expect(ctx.session.pendingPhotos).toEqual(["static_1"]);
    expect(ctx.session.pendingProfileMedia).toEqual([
      {
        type: "live_photo",
        photo: "static_1",
        livePhoto: "live_1",
        duration: 5,
        width: 720,
        height: 1280,
        fileSize: 2048,
      },
    ]);
    expect(ctx.session.pendingPhotoScores).toEqual([0.91]);
  });

  it("handleEditPhotosUpload does not add media beyond MAX_PHOTOS", async () => {
    const existingPhotos = ["file_1", "file_2", "file_3", "file_4", "file_5", "file_6"];
    const ctx = createMockCtx({
      session: {
        menuState: "edit_photos",
        pendingPhotos: existingPhotos,
        pendingProfileMedia: existingPhotos.map((photo) => ({ type: "photo", photo })),
        pendingPhotoUniqueIds: [],
        pendingPhotoScores: [0, 0, 0, 0, 0, 0],
      },
      message: {
        live_photo: {
          file_id: "live_extra",
          file_unique_id: "live_extra_unique",
          duration: 5,
          width: 720,
          height: 1280,
          photo: [
            {
              file_id: "static_extra",
              file_unique_id: "static_extra_unique",
              width: 800,
              height: 800,
            },
          ],
        },
      },
    });

    await handleEditPhotosUpload(ctx);

    expect(validateSingleFace).not.toHaveBeenCalled();
    expect(prisma.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          photos: existingPhotos,
          profileMedia: existingPhotos.map((photo) => ({ type: "photo", photo })),
          photoFaceScores: [0, 0, 0, 0, 0, 0],
        }),
      }),
    );
  });

  it("handleEditPhotosStart renders the manager with delete/add/done controls", async () => {
    (prisma.profile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      photos: ["file_1", "file_2", "file_3"],
      profileMedia: [],
      photoFaceScores: [0.1, 0.2, 0.3],
      uploadedPhotoHashes: [],
    });
    const ctx = createMockCtx({ callbackData: "menu:edit:photos" });
    await handleEditPhotosStart(ctx);

    expect(ctx.session.menuState).toBe("edit_photos");
    expect(ctx.session.pendingPhotos).toEqual(["file_1", "file_2", "file_3"]);
    // The last reply is the control message; it carries one delete button per
    // photo plus add + done.
    const replyCalls = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
    const markup = replyCalls[replyCalls.length - 1][1].reply_markup;
    const serialized = JSON.stringify(markup);
    expect(serialized).toContain("menu:edit:photos:del:0");
    expect(serialized).toContain("menu:edit:photos:del:2");
    expect(serialized).toContain("menu:edit:photos:add");
    expect(serialized).toContain("menu:edit:photos:continue");
  });

  it("handleEditPhotosDelete removes one photo and persists aligned arrays", async () => {
    // Start at MAX_PHOTOS, above the MIN_PHOTOS floor, so the delete is allowed.
    const photos = Array.from({ length: MAX_PHOTOS }, (_, i) => `p${i}`);
    const scores = photos.map((_, i) => (i + 1) / 10);
    const media = photos.map((photo) => ({ type: "photo" as const, photo }));
    const expectedPhotos = photos.filter((_, i) => i !== 1);
    const expectedScores = scores.filter((_, i) => i !== 1);
    const ctx = createMockCtx({
      session: {
        menuState: "edit_photos",
        pendingPhotos: [...photos],
        pendingProfileMedia: media.map((m) => ({ ...m })),
        pendingPhotoScores: [...scores],
      },
      callbackData: "menu:edit:photos:del:1",
    });

    await handleEditPhotosDelete(ctx);

    // photos[i] ↔ photoFaceScores[i] alignment preserved after the splice.
    expect(ctx.session.pendingPhotos).toEqual(expectedPhotos);
    expect(ctx.session.pendingPhotoScores).toEqual(expectedScores);
    expect(ctx.session.pendingProfileMedia).toEqual(
      expectedPhotos.map((photo) => ({ type: "photo", photo })),
    );
    // Persisted immediately so the consensus upload path can't resurrect it.
    expect(prisma.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "uuid-user-1" },
        data: expect.objectContaining({
          photos: expectedPhotos,
          photoFaceScores: expectedScores,
        }),
      }),
    );
  });

  it("handleEditPhotosDelete is blocked at the MIN_PHOTOS floor", async () => {
    const photos = Array.from({ length: MIN_PHOTOS }, (_, i) => `p${i}`);
    const ctx = createMockCtx({
      session: {
        menuState: "edit_photos",
        pendingPhotos: [...photos],
        pendingProfileMedia: photos.map((photo) => ({ type: "photo", photo })),
        pendingPhotoScores: photos.map(() => 0.1),
      },
      callbackData: "menu:edit:photos:del:0",
    });

    await handleEditPhotosDelete(ctx);

    expect(ctx.session.pendingPhotos).toEqual(photos);
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ show_alert: true }),
    );
  });

  it("handleEditPhotosAdd re-opens the upload prompt and stays in edit_photos", async () => {
    const ctx = createMockCtx({
      session: {
        menuState: "edit_photos",
        pendingPhotos: Array.from({ length: MIN_PHOTOS }, (_, i) => `p${i}`),
      },
      callbackData: "menu:edit:photos:add",
    });

    await handleEditPhotosAdd(ctx);

    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalled();
    expect(ctx.session.menuState).toBe("edit_photos");
  });
});

describe("Menu — Edit Bio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);
    (prisma.profile.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockUser,
      status: "active",
    });
  });

  it("handleEditBioStart sets menuState to edit_bio", async () => {
    const ctx = createMockCtx({ callbackData: "menu:edit:bio" });
    await handleEditBioStart(ctx);
    expect(ctx.session.menuState).toBe("edit_bio");
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("handleEditBioInput saves valid bio and returns to idle", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_bio" },
      messageText: "I love hiking and photography!",
    });
    await handleEditBioInput(ctx);
    // M-2: write also marks embedding dirty for the background worker.
    expect(prisma.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          psychologicalSummary: "I love hiking and photography!",
          embeddingDirty: true,
        }),
      }),
    );
    expect(ctx.session.menuState).toBe("idle");
  });

  it("handleEditBioInput rejects text exceeding 500 chars", async () => {
    const longText = "x".repeat(501);
    const ctx = createMockCtx({
      session: { menuState: "edit_bio" },
      messageText: longText,
    });
    await handleEditBioInput(ctx);
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(ctx.session.menuState).toBe("edit_bio"); // stays in flow
  });
});

describe("Menu — Edit Major", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockUser,
      status: "active",
    });
  });

  it("handleEditMajorStart sets menuState to edit_major", async () => {
    const ctx = createMockCtx({ callbackData: "menu:edit:major" });
    await handleEditMajorStart(ctx);
    expect(ctx.session.menuState).toBe("edit_major");
  });

  it("handleEditMajorInput saves valid major", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_major" },
      messageText: "Computer Science",
    });
    await handleEditMajorInput(ctx);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { major: "Computer Science" },
      }),
    );
    expect(ctx.session.menuState).toBe("idle");
  });

  it("handleEditMajorInput rejects text exceeding 100 chars", async () => {
    const longText = "x".repeat(101);
    const ctx = createMockCtx({
      session: { menuState: "edit_major" },
      messageText: longText,
    });
    await handleEditMajorInput(ctx);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(ctx.session.menuState).toBe("edit_major");
  });
});

describe("Menu — Edit Search Preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);
    (prisma.profile.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("handleEditPrefsOpen shows the age range button", async () => {
    const ctx = createMockCtx({ callbackData: "menu:edit:prefs" });
    await handleEditPrefsOpen(ctx);
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
    const serialized = JSON.stringify(markup);
    expect(serialized).toContain("menu:edit:prefs:age");
    expect(serialized).toContain("menu:edit");
  });

  it("handleEditAgeRangeStart sets menuState to edit_age_range", async () => {
    const ctx = createMockCtx({ callbackData: "menu:edit:prefs:age" });
    await handleEditAgeRangeStart(ctx);
    expect(ctx.session.menuState).toBe("edit_age_range");
  });

  it("handleEditAgeRangeInput parses valid range and saves", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_age_range" },
      messageText: "20-28",
    });
    await handleEditAgeRangeInput(ctx);
    expect(prisma.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { ageRangeMin: 20, ageRangeMax: 28 },
      }),
    );
    expect(ctx.session.menuState).toBe("idle");
  });

  it("handleEditAgeRangeInput accepts en-dash separator", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_age_range" },
      messageText: "19\u201325",
    });
    await handleEditAgeRangeInput(ctx);
    expect(prisma.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { ageRangeMin: 19, ageRangeMax: 25 },
      }),
    );
  });

  it("handleEditAgeRangeInput rejects range below MIN_AGE", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_age_range" },
      messageText: "15-25",
    });
    await handleEditAgeRangeInput(ctx);
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(ctx.session.menuState).toBe("edit_age_range");
  });

  it("handleEditAgeRangeInput rejects range above MAX_AGE", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_age_range" },
      messageText: "20-60",
    });
    await handleEditAgeRangeInput(ctx);
    expect(prisma.profile.update).not.toHaveBeenCalled();
  });

  it("handleEditAgeRangeInput rejects inverted range", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_age_range" },
      messageText: "28-20",
    });
    await handleEditAgeRangeInput(ctx);
    expect(prisma.profile.update).not.toHaveBeenCalled();
  });

  it("handleEditAgeRangeInput rejects non-numeric input", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_age_range" },
      messageText: "abc",
    });
    await handleEditAgeRangeInput(ctx);
    expect(prisma.profile.update).not.toHaveBeenCalled();
  });
});

describe("Menu — Help", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders static support text with no chat UI", async () => {
    const ctx = createMockCtx({ callbackData: "menu:help" });
    await handleHelp(ctx);
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toContain("@gennetysupport");
    // Ensure we're not accidentally building a chat feature
    expect(body.toLowerCase()).not.toContain("chat with");
  });
});

describe("Menu — Delete Account (GDPR Right to be Forgotten)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-user-1",
      status: "active",
    });
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("handleSettingsOpen shows a delete account button", async () => {
    const ctx = createMockCtx({ callbackData: "menu:settings" });
    await handleSettingsOpen(ctx);
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
    expect(JSON.stringify(markup)).toContain("menu:settings:delete");
  });

  it("handleDeleteAccountStart offers the freeze + delete fork", async () => {
    const ctx = createMockCtx({ callbackData: "menu:settings:delete" });
    await handleDeleteAccountStart(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
    const serialized = JSON.stringify(markup);
    expect(serialized).toContain("menu:settings:freeze");
    expect(serialized).toContain("menu:settings:delete:proceed");
    // Freeze is blue/primary, the delete path is red/danger.
    expect(serialized).toContain("primary");
    expect(serialized).toContain("danger");
  });

  it("handleFreezeAccount flips status to frozen and unpins the banner", async () => {
    const ctx = createMockCtx({
      callbackData: "menu:settings:freeze",
      fromId: 12345,
    });
    await handleFreezeAccount(ctx);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { telegramId: BigInt(12345) },
      data: { status: "frozen" },
    });
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(ctx.api.unpinAllChatMessages).toHaveBeenCalled();
  });

  it("handleFreezeAccount cancels an in-flight match and notifies the partner", async () => {
    (prisma.match.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "match-1",
        userAId: "uuid-user-1",
        userBId: "uuid-partner",
        userA: { telegramId: BigInt(12345), language: "en" },
        userB: { telegramId: BigInt(67890), language: "en" },
      },
    ]);
    (prisma.match.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const ctx = createMockCtx({ callbackData: "menu:settings:freeze", fromId: 12345 });
    await handleFreezeAccount(ctx);
    expect(prisma.match.update).toHaveBeenCalledWith({
      where: { id: "match-1" },
      data: { status: "cancelled" },
    });
    // The partner (telegramId 67890) gets a neutral notice.
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(67890, expect.any(String));
  });

  it("handleDeleteAccountConfirm shows the final confirmation with one delete + two back-outs", async () => {
    const ctx = createMockCtx({ callbackData: "menu:settings:delete:proceed" });
    await handleDeleteAccountConfirm(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toContain("permanently delete");
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
    const serialized = JSON.stringify(markup);
    expect(serialized).toContain("menu:settings:delete:yes");
    expect(serialized).toContain("menu:back");
  });

  it("handleDeleteAccountExecute calls prisma.user.delete with the correct telegramId", async () => {
    const ctx = createMockCtx({
      callbackData: "menu:settings:delete:yes",
      fromId: 99999,
    });
    await handleDeleteAccountExecute(ctx);
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { telegramId: BigInt(99999) },
    });
  });

  it("handleDeleteAccountExecute resets session to defaults", async () => {
    const ctx = createMockCtx({
      callbackData: "menu:settings:delete:yes",
      session: {
        onboardingStep: "completed",
        language: "ru",
        menuState: "idle",
        matchFlow: "idle",
        activeMatchId: "some-match-id",
      },
    });
    await handleDeleteAccountExecute(ctx);
    expect(ctx.session.onboardingStep).toBe("consent");
    expect(ctx.session.language).toBe("en");
    expect(ctx.session.activeMatchId).toBeNull();
    expect(ctx.session.pendingPhotos).toEqual([]);
  });

  it("handleDeleteAccountExecute sends farewell message", async () => {
    const ctx = createMockCtx({
      callbackData: "menu:settings:delete:yes",
      session: { language: "en" },
    });
    await handleDeleteAccountExecute(ctx);
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toContain("deleted");
    expect(body).toContain("/start");
  });

  it("cascade: deleting user removes profile and matches (schema contract)", async () => {
    // This test documents the schema-level contract: onDelete: Cascade
    // is set on Profile→User and Match→User relations. The actual DB
    // enforcement is tested via prisma db push; here we verify that the
    // handler relies on a single prisma.user.delete to wipe profile + match
    // rows. We DO query matches first — only to notify/comp any in-flight
    // partner before the cascade removes those rows — but we never manually
    // clean up profiles or matches.
    const deleteCall = prisma.user.delete as ReturnType<typeof vi.fn>;
    deleteCall.mockClear();

    const ctx = createMockCtx({ callbackData: "menu:settings:delete:yes" });
    await handleDeleteAccountExecute(ctx);

    // Only user.delete performs cleanup — cascade handles profiles + matches.
    expect(prisma.user.delete).toHaveBeenCalledTimes(1);
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect((prisma as any).profile.findUnique).not.toHaveBeenCalled();
    expect((prisma as any).match.update).not.toHaveBeenCalled();
  });
});

describe("Menu — Profile Video", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "active",
      profile: { videoBonusTicketAt: null },
    });
    (prisma.profile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      photos: ["p1", "p2"],
      profileMedia: [],
      videoBonusTicketAt: null,
    });
    (prepareProfileVideo as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "accepted",
      media: { type: "video", video: "vid-new" },
      statusAcknowledged: false,
    });
    (grantVideoBonusIfEligible as ReturnType<typeof vi.fn>).mockResolvedValue({
      granted: false,
      balance: 0,
    });
  });

  it("main keyboard always shows the profile-video button", () => {
    const ctx = createMockCtx({});
    const kb = buildMainMenuKeyboard(ctx, "active");
    expect(JSON.stringify(kb.inline_keyboard)).toContain("menu:video");
  });

  it("main keyboard adds the gift marker only when the video reward is available", () => {
    const ctx = createMockCtx({});
    const withReward = JSON.stringify(buildMainMenuKeyboard(ctx, "active", true).inline_keyboard);
    const noReward = JSON.stringify(buildMainMenuKeyboard(ctx, "active", false).inline_keyboard);
    expect(withReward).toContain("🎁");
    expect(noReward).not.toContain("🎁");
  });

  it("handleEditVideoStart enters edit_video and offers Remove when a video exists", async () => {
    (prisma.profile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      photos: ["p1", "p2"],
      profileMedia: [
        { type: "photo", photo: "p1" },
        { type: "photo", photo: "p2" },
        { type: "video", video: "vid-old" },
      ],
      videoBonusTicketAt: null,
    });
    const ctx = createMockCtx({ callbackData: "menu:video" });
    await handleEditVideoStart(ctx);
    expect(ctx.session.menuState).toBe("edit_video");
    const markup = JSON.stringify((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(markup).toContain("menu:video:remove");
  });

  it("handleEditVideoStart hides Remove when no video exists", async () => {
    const ctx = createMockCtx({ callbackData: "menu:video" });
    await handleEditVideoStart(ctx);
    expect(ctx.session.menuState).toBe("edit_video");
    const markup = JSON.stringify((ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]);
    expect(markup).not.toContain("menu:video:remove");
  });

  it("handleEditVideoUpload validates, persists the video, grants the bonus, and resets state", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-user-1",
      profile: { photos: ["p1", "p2"], profileMedia: [] },
    });
    const ctx = createMockCtx({
      session: { menuState: "edit_video" },
      message: {
        video: {
          file_id: "vid-new",
          file_unique_id: "u-new",
          duration: 10,
          width: 320,
          height: 240,
        },
      },
    });
    await handleEditVideoUpload(ctx);

    expect(prepareProfileVideo).toHaveBeenCalledTimes(1);
    const updateArg = (prisma.profile.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(JSON.stringify(updateArg.data.profileMedia)).toContain("vid-new");
    expect(grantVideoBonusIfEligible).toHaveBeenCalledWith("uuid-user-1");
    expect(ctx.session.menuState).toBe("idle");
  });

  it("handleEditVideoUpload re-prompts (no persist) when the message isn't a video", async () => {
    const ctx = createMockCtx({
      session: { menuState: "edit_video" },
      messageText: "not a video",
    });
    await handleEditVideoUpload(ctx);
    expect(prepareProfileVideo).not.toHaveBeenCalled();
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(ctx.session.menuState).toBe("edit_video");
  });

  it("handleEditVideoRemove clears the video from profileMedia and resets state", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "uuid-user-1",
      profile: {
        photos: ["p1", "p2"],
        profileMedia: [
          { type: "photo", photo: "p1" },
          { type: "photo", photo: "p2" },
          { type: "video", video: "vid-old" },
        ],
      },
    });
    const ctx = createMockCtx({ callbackData: "menu:video:remove" });
    await handleEditVideoRemove(ctx);

    const updateArg = (prisma.profile.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(JSON.stringify(updateArg.data.profileMedia)).not.toContain("vid-old");
    expect(ctx.session.menuState).toBe("idle");
  });
});
