import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import {
  t,
  escapeMd,
  MIN_PHOTOS,
  MAX_PHOTOS,
  MIN_AGE,
  MAX_AGE,
  MAX_BIO_LENGTH,
  MAX_MAJOR_LENGTH,
} from "@gennety/shared";
import { validateSingleFace } from "../../services/vision/validate-face.js";
import { showMainMenu } from "./main.js";
import { startVisualScreening } from "../onboarding/visual-screening.js";

// ---------------------------------------------------------------------------
// Edit profile main screen
// ---------------------------------------------------------------------------

/**
 * Render the Edit Profile card (shared logic for callback and command entry).
 */
async function renderEditProfile(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      firstName: true,
      surname: true,
      age: true,
      universityDomain: true,
    },
  });
  if (!user) {
    await ctx.reply(t(lang, "myProfileNoBio"));
    return;
  }

  const body = t(lang, "editProfileBody", {
    firstName: escapeMd(user.firstName ?? "—"),
    surname: escapeMd(user.surname ?? "—"),
    age: user.age ?? 0,
    university: escapeMd(user.universityDomain ?? "—"),
  });

  const keyboard = new InlineKeyboard()
    .text(t(lang, "editBioBtn"), "menu:edit:bio")
    .row()
    .text(t(lang, "editPrefsBtn"), "menu:edit:prefs")
    .row()
    .text(t(lang, "editMajorBtn"), "menu:edit:major")
    .row()
    .text(t(lang, "editProfilePhotosBtn"), "menu:edit:photos")
    .row()
    .text(t(lang, "menuBack"), "menu:back");

  try {
    await ctx.reply(body, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {
    await ctx.reply(body.replace(/[\\*_`\[]/g, ""), { reply_markup: keyboard });
  }
}

/**
 * Show the expanded Edit Profile card (callback entry — via inline button).
 *
 * Per PRODUCT_SPEC Phase 2: "Core identity data (Name, Age, University) are FIXED."
 * Editable: Bio, Search Preferences, Major, Photos.
 */
export async function handleEditOpen(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await renderEditProfile(ctx);
}

/** Show the Edit Profile card (command entry — via /edit). */
export async function showEditProfileMenu(ctx: BotContext): Promise<void> {
  await renderEditProfile(ctx);
}

// ---------------------------------------------------------------------------
// Edit Bio
// ---------------------------------------------------------------------------

/** Enter the edit_bio FSM state. */
export async function handleEditBioStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  ctx.session.menuState = "edit_bio";
  await ctx.reply(t(lang, "editBioPrompt"));
}

/** Consume text message while menuState === "edit_bio". */
export async function handleEditBioInput(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const text = ctx.message?.text?.trim();
  if (!text) return;

  if (text.length > MAX_BIO_LENGTH) {
    await ctx.reply(t(lang, "editBioTooLong"));
    return;
  }

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;

  await prisma.profile.update({
    where: { userId: user.id },
    data: { psychologicalSummary: text },
  });

  ctx.session.menuState = "idle";
  await ctx.reply(t(lang, "editBioSaved"));
  await showMainMenu(ctx);
}

// ---------------------------------------------------------------------------
// Edit Major
// ---------------------------------------------------------------------------

/** Enter the edit_major FSM state. */
export async function handleEditMajorStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  ctx.session.menuState = "edit_major";
  await ctx.reply(t(lang, "editMajorPrompt"));
}

/** Consume text message while menuState === "edit_major". */
export async function handleEditMajorInput(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const text = ctx.message?.text?.trim();
  if (!text) return;

  if (text.length > MAX_MAJOR_LENGTH) {
    await ctx.reply(t(lang, "editMajorTooLong"));
    return;
  }

  const telegramId = BigInt(ctx.from!.id);
  await prisma.user.update({
    where: { telegramId },
    data: { major: text },
  });

  ctx.session.menuState = "idle";
  await ctx.reply(t(lang, "editMajorSaved"));
  await showMainMenu(ctx);
}

// ---------------------------------------------------------------------------
// Search Preferences sub-menu
// ---------------------------------------------------------------------------

/** Show the Search Preferences sub-menu. */
export async function handleEditPrefsOpen(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;

  const keyboard = new InlineKeyboard()
    .text(t(lang, "editPrefsAgeBtn"), "menu:edit:prefs:age")
    .row()
    .text(t(lang, "editPrefsVisualBtn"), "menu:edit:prefs:visual")
    .row()
    .text(t(lang, "editPrefsBack"), "menu:edit");

  await ctx.reply(t(lang, "editPrefsTitle"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

// ---------------------------------------------------------------------------
// Edit Age Range
// ---------------------------------------------------------------------------

/** Enter the edit_age_range FSM state. */
export async function handleEditAgeRangeStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  ctx.session.menuState = "edit_age_range";
  await ctx.reply(t(lang, "editAgeRangePrompt", { min: MIN_AGE, max: MAX_AGE }));
}

/** Consume text message while menuState === "edit_age_range". */
export async function handleEditAgeRangeInput(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const match = text.match(/^(\d{1,3})\s*[-–]\s*(\d{1,3})$/);
  if (!match) {
    await ctx.reply(t(lang, "editAgeRangeInvalid", { min: MIN_AGE, max: MAX_AGE }));
    return;
  }

  const rangeMin = Number(match[1]);
  const rangeMax = Number(match[2]);

  if (rangeMin < MIN_AGE || rangeMax > MAX_AGE || rangeMin > rangeMax) {
    await ctx.reply(t(lang, "editAgeRangeInvalid", { min: MIN_AGE, max: MAX_AGE }));
    return;
  }

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;

  await prisma.profile.update({
    where: { userId: user.id },
    data: { ageRangeMin: rangeMin, ageRangeMax: rangeMax },
  });

  ctx.session.menuState = "idle";
  await ctx.reply(t(lang, "editAgeRangeSaved"));
  await showMainMenu(ctx);
}

// ---------------------------------------------------------------------------
// Edit Visual Preferences (re-trigger carousel)
// ---------------------------------------------------------------------------

/** Start visual re-screening from edit mode. */
export async function handleEditVisualStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  ctx.session.menuState = "edit_visual_prefs";
  ctx.session.visualVotes = [];
  await ctx.reply(t(lang, "editVisualRestart"));
  await startVisualScreening(ctx);
}

// ---------------------------------------------------------------------------
// Edit Photos (existing logic, preserved)
// ---------------------------------------------------------------------------

/** Put the session into "edit_photos" mode and prompt for new photos. */
export async function handleEditPhotosStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;

  ctx.session.menuState = "edit_photos";
  ctx.session.pendingPhotos = [];
  ctx.session.pendingPhotoUniqueIds = [];

  await ctx.reply(t(lang, "editProfilePhotosStart", { min: MIN_PHOTOS, max: MAX_PHOTOS }));
}

/**
 * Collect incoming photos while `menuState === "edit_photos"`.
 * Auto-finishes at MAX_PHOTOS; otherwise offers a Continue button once MIN_PHOTOS is reached.
 */
export async function handleEditPhotosUpload(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;

  // Continue button → commit whatever is in pendingPhotos (if >= MIN).
  const data = ctx.callbackQuery?.data;
  if (data === "menu:edit:photos:continue") {
    await ctx.answerCallbackQuery();
    if (ctx.session.pendingPhotos.length >= MIN_PHOTOS) {
      await finishEditPhotos(ctx);
    }
    return;
  }

  const photo = ctx.message?.photo;
  if (!photo || photo.length === 0) {
    await ctx.reply(t(lang, "editProfilePhotosStart", { min: MIN_PHOTOS, max: MAX_PHOTOS }));
    return;
  }

  const largest = photo[photo.length - 1]!;
  const fileId = largest.file_id;
  const fileUniqueId = largest.file_unique_id;

  // Dedupe identical frames (album retries / double-delivery).
  if (ctx.session.pendingPhotoUniqueIds?.includes(fileUniqueId)) {
    return;
  }

  // Same face validation as onboarding (PRODUCT_SPEC Phase 1 Step 7).
  const result = await validateSingleFace(ctx, fileId);
  if (!result.ok) {
    await ctx.reply(t(lang, "photoVisionError"));
    return;
  }
  if (!result.valid) {
    await ctx.reply(t(lang, "photoRejected"), { parse_mode: "Markdown" });
    return;
  }

  ctx.session.pendingPhotos.push(fileId);
  ctx.session.pendingPhotoUniqueIds = [
    ...(ctx.session.pendingPhotoUniqueIds ?? []),
    fileUniqueId,
  ];
  const count = ctx.session.pendingPhotos.length;

  if (count >= MAX_PHOTOS) {
    await ctx.reply(t(lang, "photoReceived", { n: count, max: MAX_PHOTOS }));
    await finishEditPhotos(ctx);
    return;
  }

  await ctx.reply(t(lang, "photoReceived", { n: count, max: MAX_PHOTOS }));

  if (count >= MIN_PHOTOS) {
    const keyboard = new InlineKeyboard().text(
      t(lang, "btnContinuePhotos"),
      "menu:edit:photos:continue",
    );
    await ctx.reply(t(lang, "photosEnough", { max: MAX_PHOTOS }), { reply_markup: keyboard });
  }
}

async function finishEditPhotos(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;

  await prisma.profile.update({
    where: { userId: user.id },
    data: { photos: ctx.session.pendingPhotos },
  });

  ctx.session.pendingPhotos = [];
  ctx.session.pendingPhotoUniqueIds = [];
  ctx.session.menuState = "idle";

  await ctx.reply(t(lang, "editProfilePhotosSaved"));
  await showMainMenu(ctx);
}
