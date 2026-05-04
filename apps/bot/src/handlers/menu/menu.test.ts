import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION } from "@gennety/shared";

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
    },
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

import { prisma } from "@gennety/db";
import { showMainMenu, buildMainMenuKeyboard } from "./main.js";
import { handleMyProfile } from "./my-profile.js";
import { handlePause, handleResume } from "./pause.js";
import {
  handleSettingsOpen,
  handleSettingsLanguageOpen,
  handleSettingsLanguageSet,
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
} from "./edit-profile.js";

function createMockCtx(overrides: {
  session?: Partial<SessionData>;
  callbackData?: string;
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

  const message = overrides.messageText
    ? { text: overrides.messageText }
    : overrides.photoFileIds
      ? { photo: overrides.photoFileIds.map((id) => ({ file_id: id })) }
      : undefined;

  return {
    session,
    from: { id: overrides.fromId ?? 12345 },
    callbackQuery: overrides.callbackData ? { data: overrides.callbackData } : undefined,
    message,
    reply: vi.fn().mockResolvedValue(undefined),
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

describe("Menu — My Profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders bio from Profile.psychologicalSummary", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockUser);
    const ctx = createMockCtx({ callbackData: "menu:profile" });
    await handleMyProfile(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body).toContain("Alice Smith");
    expect(body).toContain("21");
    expect(body).toContain("stanford.edu");
    expect(body).toContain("Curious introvert");
  });

  it("falls back to no-bio copy when summary is missing", async () => {
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockUser,
      profile: { psychologicalSummary: null },
    });
    const ctx = createMockCtx({ callbackData: "menu:profile" });
    await handleMyProfile(ctx);
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
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
    const body = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // Fixed fields are rendered read-only
    expect(body).toContain("Alice Smith");
    expect(body).toContain("21");
    expect(body).toContain("stanford.edu");
    // All editable actions present
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
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
  });

  it("handleEditPhotosUpload commits on continue button and resets state", async () => {
    const ctx = createMockCtx({
      session: {
        menuState: "edit_photos",
        pendingPhotos: ["file_1", "file_2", "file_3"],
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
        data: {
          photos: ["file_1", "file_2", "file_3"],
          photoFaceScores: [0, 0, 0],
        },
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
      messageText: "20-40",
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
    (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "active" });
  });

  it("handleSettingsOpen shows a delete account button", async () => {
    const ctx = createMockCtx({ callbackData: "menu:settings" });
    await handleSettingsOpen(ctx);
    const markup = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][1].reply_markup;
    expect(JSON.stringify(markup)).toContain("menu:settings:delete");
  });

  it("handleDeleteAccountConfirm shows confirmation prompt with Yes/Cancel", async () => {
    const ctx = createMockCtx({ callbackData: "menu:settings:delete" });
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
    // handler only needs a single prisma.user.delete call — no manual
    // cleanup of profiles or matches.
    const deleteCall = prisma.user.delete as ReturnType<typeof vi.fn>;
    deleteCall.mockClear();

    const ctx = createMockCtx({ callbackData: "menu:settings:delete:yes" });
    await handleDeleteAccountExecute(ctx);

    // Only user.delete should be called — cascade handles the rest.
    expect(prisma.user.delete).toHaveBeenCalledTimes(1);
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect((prisma as any).profile.findUnique).not.toHaveBeenCalled();
    expect((prisma as any).match.findMany).not.toHaveBeenCalled();
  });
});
