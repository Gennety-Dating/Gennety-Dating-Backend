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
  normalizeProfileMedia,
} from "@gennety/shared";
import { validateSingleFace } from "../../services/vision/validate-face.js";
import {
  fetchTelegramFileBuffer,
  gateProfilePhoto,
} from "../../services/face-match-gate.js";
import { triggerVerificationRerun } from "../../services/verification-pipeline.js";
import { showMainMenu } from "./main.js";
import {
  getMessageLivePhoto,
  incomingLivePhotoMedia,
  incomingPhotoMedia,
  type IncomingProfileMedia,
} from "../../services/telegram-profile-media.js";
import { profileMediaToJson } from "../../services/profile-media-json.js";

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
    // M-2: mark the embedding dirty so the background worker recomputes.
    // Without this, edits silently drift the user's match-score profile.
    data: {
      psychologicalSummary: text,
      embeddingDirty: true,
      embeddingDirtyAt: new Date(),
    },
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
// Edit Photos (existing logic, preserved)
// ---------------------------------------------------------------------------

/**
 * Put the session into "edit_photos" mode and prompt for new photos.
 *
 * M-3: preload existing photos into `pendingPhotos` so the user is *adding*
 * to their album, not starting from scratch. Pre-fix tapping "Edit photos"
 * silently wiped existing photos unless the user re-uploaded everything.
 */
export async function handleEditPhotosStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const profile = await prisma.profile.findFirst({
    where: { user: { telegramId } },
    select: { photos: true, profileMedia: true, photoFaceScores: true },
  });
  const existing = profile?.photos ?? [];
  const existingScores = profile?.photoFaceScores ?? [];
  const existingMedia = normalizeProfileMedia(profile?.profileMedia ?? [], existing);

  ctx.session.menuState = "edit_photos";
  ctx.session.pendingPhotos = [...existing];
  ctx.session.pendingProfileMedia = existingMedia;
  // We can't recover `file_unique_id` from a stored `file_id`, so dedupe
  // for newly-arriving photos starts fresh. The album-retry / double-delivery
  // dedupe path only matters within a single editing session.
  ctx.session.pendingPhotoUniqueIds = [];
  // Mirror existing scores 1:1 with the preloaded photos. If the existing
  // arrays drift (legacy rows from before the face-match column existed),
  // pad with 0 so the invariant `pendingPhotoScores.length === pendingPhotos.length`
  // holds — the verification pipeline rerun will refill correct scores.
  ctx.session.pendingPhotoScores = [
    ...existingScores,
    ...Array(Math.max(0, existing.length - existingScores.length)).fill(0),
  ];

  await ctx.reply(
    t(lang, "editProfilePhotosStart", { min: MIN_PHOTOS, max: MAX_PHOTOS }),
  );
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
  const livePhoto = getMessageLivePhoto(ctx.message);
  let incoming: IncomingProfileMedia | null = null;
  if (livePhoto) {
    const extracted = incomingLivePhotoMedia(livePhoto);
    if (!extracted.ok) {
      await ctx.reply(livePhotoRejectionMessage(lang, extracted.reason));
      return;
    }
    incoming = extracted.media;
  } else if (photo && photo.length > 0) {
    incoming = incomingPhotoMedia(photo);
  }

  if (!incoming) {
    await ctx.reply(t(lang, "editProfilePhotosStart", { min: MIN_PHOTOS, max: MAX_PHOTOS }));
    return;
  }

  const fileId = incoming.staticPhoto.file_id;
  const fileUniqueId = incoming.uniqueId;

  // Dedupe identical frames (album retries / double-delivery).
  if (ctx.session.pendingPhotoUniqueIds?.includes(fileUniqueId)) {
    return;
  }

  if (ctx.session.pendingPhotos.length >= MAX_PHOTOS) {
    await ctx.reply(t(lang, "photoReceived", { n: MAX_PHOTOS, max: MAX_PHOTOS }));
    await finishEditPhotos(ctx);
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

  // Face-match gate: for verified users every new photo must depict the
  // same person as the Persona-captured selfie. Fetch bytes from Telegram
  // and run the gate; on mismatch we bail before adding to pending list.
  const telegramId = BigInt(ctx.from!.id);
  const userRow = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  let gateScore = 0;
  if (userRow) {
    const photoBytes = await fetchTelegramFileBuffer(ctx.api, fileId);
    if (photoBytes) {
      const gate = await gateProfilePhoto(userRow.id, photoBytes);
      if (gate.kind === "blocked") {
        await ctx.reply(t(lang, "photoMatchMismatch"));
        return;
      }
      gateScore = gate.score ?? 0;
    }
    // photoBytes === null → fail open, no score available
  }

  ctx.session.pendingPhotos.push(fileId);
  ctx.session.pendingProfileMedia = [
    ...normalizeProfileMedia(ctx.session.pendingProfileMedia, ctx.session.pendingPhotos.slice(0, -1)),
    incoming.profileMedia,
  ];
  ctx.session.pendingPhotoUniqueIds = [
    ...(ctx.session.pendingPhotoUniqueIds ?? []),
    fileUniqueId,
  ];
  ctx.session.pendingPhotoScores = [
    ...(ctx.session.pendingPhotoScores ?? []),
    gateScore,
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

  // Pad scores to match photos length defensively (in case the session
  // started before the field existed, or the user re-uploaded photos
  // without the gate populating a score for each).
  const scores = [
    ...(ctx.session.pendingPhotoScores ?? []),
    ...Array(
      Math.max(
        0,
        ctx.session.pendingPhotos.length - (ctx.session.pendingPhotoScores?.length ?? 0),
      ),
    ).fill(0),
  ].slice(0, ctx.session.pendingPhotos.length);

  await prisma.profile.update({
    where: { userId: user.id },
    data: {
      photos: ctx.session.pendingPhotos,
      profileMedia: profileMediaToJson(
        normalizeProfileMedia(
          ctx.session.pendingProfileMedia,
          ctx.session.pendingPhotos,
        ),
      ),
      photoFaceScores: scores,
    },
  });

  // Re-run face-match verification against the new photo set. The
  // per-frame `gateProfilePhoto` above blocked obviously-wrong photos
  // at upload time, but the *aggregate* verification status (verified /
  // pending_review / rejected) is a function of the WHOLE array — so a
  // rejected user who replaced their bad photos must be re-evaluated,
  // and the persisted `photoFaceScores` must stay aligned with `photos`.
  // Fire-and-forget; pipeline errors land in the bot logs.
  void triggerVerificationRerun(user.id, ctx.api).catch((err) => {
    console.error("[edit-profile] verification rerun failed:", err);
  });

  ctx.session.pendingPhotos = [];
  ctx.session.pendingProfileMedia = [];
  ctx.session.pendingPhotoUniqueIds = [];
  ctx.session.pendingPhotoScores = [];
  ctx.session.menuState = "idle";

  await ctx.reply(t(lang, "editProfilePhotosSaved"));
  await showMainMenu(ctx);
}

type LivePhotoRejectReason = "missing_static" | "too_long" | "too_large";

function livePhotoRejectionMessage(
  language: Parameters<typeof t>[0],
  reason: LivePhotoRejectReason,
): string {
  switch (reason) {
    case "missing_static":
      return t(language, "livePhotoMissingStatic");
    case "too_long":
      return t(language, "livePhotoTooLong");
    case "too_large":
      return t(language, "livePhotoTooLarge");
  }
}
