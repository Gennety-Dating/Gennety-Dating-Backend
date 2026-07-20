import { InlineKeyboard, InputMediaBuilder } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import {
  t,
  MIN_PHOTOS,
  MAX_PHOTOS,
  MIN_AGE,
  MAX_AGE,
  MAX_BIO_LENGTH,
  MAX_PARTNER_PREFERENCES_LENGTH,
  MAX_MAJOR_LENGTH,
  normalizeProfileMedia,
  escapeMd,
} from "@gennety/shared";
import { validateSingleFace } from "../../services/vision/validate-face.js";
import {
  fetchTelegramFileBuffer,
  gateProfilePhoto,
} from "../../services/face-match-gate.js";
import { triggerVerificationRerun } from "../../services/verification-pipeline.js";
import { showMainMenu } from "./main.js";
import { showMyProfile } from "./my-profile.js";
import {
  getMessageLivePhoto,
  incomingLivePhotoMedia,
  incomingPhotoMedia,
  type IncomingProfileMedia,
} from "../../services/telegram-profile-media.js";
import { profileMediaToJson } from "../../services/profile-media-json.js";
import { env } from "../../config.js";
import { validateUserProfilePhoto } from "../../services/profile-media-validation/profile-photo-validation.js";
import {
  commitProfilePhotoCandidate,
  removeProfilePhotoByRef,
  type PhotoConsensusCommitResult,
} from "../../services/profile-media-validation/identity-consensus.js";
import type { MediaValidationReason } from "../../services/profile-media-validation/types.js";
import { logMediaValidationRejection } from "../../services/profile-media-validation/rejection-log.js";
import {
  alignPhotoHashes,
  MISSING_PHOTO_HASH,
  photoUploadStatePatch,
} from "../../services/profile-media-validation/photo-state.js";
import { refreshUserEmbedding } from "../../workers/embedding-refresh.js";

async function embeddingRefreshStillPending(userId: string): Promise<boolean> {
  try {
    return (await refreshUserEmbedding(userId)).stillDirty > 0;
  } catch (err) {
    console.warn(
      `[edit-profile] immediate embedding refresh failed userId=${userId}:`,
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// Edit profile entry — merged into the combined My Profile screen
// ---------------------------------------------------------------------------
//
// The standalone "Edit Profile" card was removed: viewing and editing a dating
// profile is one screen. `renderMyProfile` (my-profile.ts) now renders the
// profile-as-a-match-sees-it plus the outcome-named edit buttons. These entry
// points stay for backwards-compat (the `/edit` command and any stale
// `menu:edit` keyboards) and delegate to that combined screen.

/**
 * Open the combined profile+edit screen (callback entry — stale `menu:edit`).
 *
 * Fixed identity data (Name, Age, University) stays read-only; editable via the
 * on-profile buttons: About me (bio), Who I want (prefs), What I do
 * (occupation), My photos.
 */
export async function handleEditOpen(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await showMyProfile(ctx);
}

/** Open the combined profile+edit screen (command entry — via /edit). */
export async function showEditProfileMenu(ctx: BotContext): Promise<void> {
  await showMyProfile(ctx);
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

  const syncPending = await embeddingRefreshStillPending(user.id);

  ctx.session.menuState = "idle";
  await ctx.reply(t(lang, "editBioSaved"));
  if (syncPending) await ctx.reply(t(lang, "profileEmbeddingSyncPending"));
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
  await showEditPrefsMenu(ctx);
}

async function showEditPrefsMenu(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: {
      profile: {
        select: { partnerPreferences: true, ageRangeMin: true, ageRangeMax: true },
      },
    },
  });
  const preferences =
    user?.profile?.partnerPreferences?.trim() || t(lang, "editPrefsNotSet");
  const ageRange =
    user?.profile?.ageRangeMin != null && user.profile.ageRangeMax != null
      ? `${user.profile.ageRangeMin}–${user.profile.ageRangeMax}`
      : t(lang, "editPrefsNotSet");

  const keyboard = new InlineKeyboard()
    .text(t(lang, "editPrefsDescriptionBtn"), "menu:edit:prefs:description")
    .row()
    .text(t(lang, "editPrefsAgeBtn"), "menu:edit:prefs:age")
    .row()
    .text(t(lang, "editPrefsBack"), "menu:edit");

  const body = `${t(lang, "editPrefsTitle")}\n\n${t(lang, "editPrefsCurrent", {
    preferences: escapeMd(preferences),
    ageRange,
  })}`;
  await ctx.reply(body, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

export async function handleEditPartnerPreferencesStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  ctx.session.menuState = "edit_partner_preferences";
  await ctx.reply(t(ctx.session.language, "editPrefsDescriptionPrompt"));
}

export async function handleEditPartnerPreferencesInput(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const rawText = ctx.message?.text;
  if (typeof rawText !== "string") return;
  const text = rawText.trim();
  if (!text) {
    await ctx.reply(t(lang, "editPrefsDescriptionEmpty"));
    return;
  }
  if (text.length > MAX_PARTNER_PREFERENCES_LENGTH) {
    await ctx.reply(t(lang, "editPrefsDescriptionTooLong"));
    return;
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;
  await prisma.profile.update({
    where: { userId: user.id },
    data: {
      partnerPreferences: text,
      embeddingDirty: true,
      embeddingDirtyAt: new Date(),
    },
  });
  const syncPending = await embeddingRefreshStillPending(user.id);
  ctx.session.menuState = "idle";
  await ctx.reply(t(lang, "editPrefsDescriptionSaved"));
  if (syncPending) await ctx.reply(t(lang, "profileEmbeddingSyncPending"));
  await showEditPrefsMenu(ctx);
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
  await showEditPrefsMenu(ctx);
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
  const telegramId = BigInt(ctx.from!.id);

  const profile = await prisma.profile.findFirst({
    where: { user: { telegramId } },
    select: {
      photos: true,
      profileMedia: true,
      photoFaceScores: true,
      uploadedPhotoHashes: true,
    },
  });
  const existing = profile?.photos ?? [];
  const existingScores = profile?.photoFaceScores ?? [];
  const existingHashes = profile?.uploadedPhotoHashes ?? [];
  const existingMedia = normalizeProfileMedia(profile?.profileMedia ?? [], existing);

  ctx.session.menuState = "edit_photos";
  ctx.session.pendingPhotos = [...existing];
  ctx.session.pendingProfileMedia = existingMedia;
  // We can't recover `file_unique_id` from a stored `file_id`, so dedupe
  // for newly-arriving photos starts fresh. The album-retry / double-delivery
  // dedupe path only matters within a single editing session.
  ctx.session.pendingPhotoUniqueIds = existing.map(() => "");
  ctx.session.pendingPhotoHashes = alignPhotoHashes(existing, existingHashes);
  // Mirror existing scores 1:1 with the preloaded photos. If the existing
  // arrays drift (legacy rows from before the face-match column existed),
  // pad with 0 so the invariant `pendingPhotoScores.length === pendingPhotos.length`
  // holds — the verification pipeline rerun will refill correct scores.
  ctx.session.pendingPhotoScores = [
    ...existingScores,
    ...Array(Math.max(0, existing.length - existingScores.length)).fill(0),
  ];

  await renderPhotoManager(ctx);
}

/**
 * Render the photo-manager screen: the current album followed by a control
 * message with a 🗑 button per photo, an ➕ add button (hidden at MAX), and a
 * ✅ done button.
 *
 * The previous control message's keyboard is stripped first (tracked via
 * `session.photoManagerMsgId`) so a stale 🗑 button from an earlier render can
 * never target the wrong index after the set changed.
 *
 * `showAlbum` re-sends the album (used on entry and after a delete, to reflect
 * the new set); on a fresh upload it's skipped — the user's own photo message
 * is already visible, so only the controls are refreshed to reduce chat noise.
 */
async function renderPhotoManager(
  ctx: BotContext,
  opts: { showAlbum?: boolean } = {},
): Promise<void> {
  const { showAlbum = true } = opts;
  const lang = ctx.session.language;
  const photos = ctx.session.pendingPhotos;

  // Strip the previous manager keyboard so its now-stale delete buttons can't
  // fire against a changed photo array.
  if (ctx.session.photoManagerMsgId != null && ctx.chat) {
    try {
      await ctx.api.editMessageReplyMarkup(
        ctx.chat.id,
        ctx.session.photoManagerMsgId,
      );
    } catch {
      // Message already gone or has no keyboard — nothing to strip.
    }
    ctx.session.photoManagerMsgId = null;
  }

  if (showAlbum && ctx.chat && photos.length > 0) {
    try {
      if (photos.length === 1) {
        await ctx.replyWithPhoto(photos[0]!);
      } else {
        await ctx.replyWithMediaGroup(
          photos.slice(0, 10).map((id) => InputMediaBuilder.photo(id)),
        );
      }
    } catch {
      // Stale file_ids — skip the album and still show the controls.
    }
  }

  const keyboard = new InlineKeyboard();
  photos.forEach((_, i) => {
    keyboard.text(
      t(lang, "photoManagerDeleteBtn", { n: i + 1 }),
      `menu:edit:photos:del:${i}`,
    );
    if ((i + 1) % 3 === 0) keyboard.row();
  });
  keyboard.row();
  if (photos.length < MAX_PHOTOS) {
    keyboard.text(t(lang, "photoManagerAddBtn"), "menu:edit:photos:add").row();
  }
  keyboard.text(t(lang, "photoManagerDoneBtn"), "menu:edit:photos:continue");

  const msg = await ctx.reply(
    t(lang, "photoManagerTitle", { min: MIN_PHOTOS, max: MAX_PHOTOS }),
    { reply_markup: keyboard },
  );
  ctx.session.photoManagerMsgId = msg?.message_id ?? null;
}

/**
 * Re-open the upload sub-mode from the manager's ➕ button. Stays in
 * `edit_photos`, so the next photo message flows to `handleEditPhotosUpload`.
 */
export async function handleEditPhotosAdd(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  if (ctx.session.pendingPhotos.length >= MAX_PHOTOS) {
    await ctx.reply(t(lang, "photoReceived", { n: MAX_PHOTOS, max: MAX_PHOTOS }));
    return;
  }
  await ctx.reply(
    t(lang, "editProfilePhotosStart", { min: MIN_PHOTOS, max: MAX_PHOTOS }),
  );
}

/**
 * Delete one photo from the manager (`menu:edit:photos:del:<index>`).
 *
 * Splices the index out of every index-aligned array so media, score, hash and
 * Telegram unique id always continue to describe the same photo. This also
 * permits a deliberately deleted photo to be uploaded again in the session.
 *
 * The reduced set is persisted immediately so it stays consistent with the
 * consensus upload path (`commitProfilePhotoCandidate` reads `photos` from the
 * DB); otherwise a later add would resurrect the deleted photo. Verification is
 * NOT rerun here — that fires once on Done via `finishEditPhotos`.
 */
export async function handleEditPhotosDelete(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const data = ctx.callbackQuery?.data ?? "";
  const idx = Number.parseInt(
    data.slice("menu:edit:photos:del:".length),
    10,
  );
  if (
    !Number.isInteger(idx) ||
    idx < 0 ||
    idx >= ctx.session.pendingPhotos.length
  ) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (ctx.session.pendingPhotos.length <= MIN_PHOTOS) {
    await ctx.answerCallbackQuery({
      text: t(lang, "photoManagerMinReached", { min: MIN_PHOTOS }),
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery({ text: t(lang, "photoManagerDeleted") });

  const deletedPhotoRef = ctx.session.pendingPhotos[idx]!;
  const priorPhotos = [...ctx.session.pendingPhotos];
  const priorUniqueIds = [...ctx.session.pendingPhotoUniqueIds];

  const media = normalizeProfileMedia(
    ctx.session.pendingProfileMedia,
    ctx.session.pendingPhotos,
  );
  media.splice(idx, 1);
  ctx.session.pendingProfileMedia = media;
  if (idx < ctx.session.pendingPhotoScores.length) {
    ctx.session.pendingPhotoScores.splice(idx, 1);
  }
  if (idx < ctx.session.pendingPhotoHashes.length) {
    ctx.session.pendingPhotoHashes.splice(idx, 1);
  }
  if (idx < ctx.session.pendingPhotoUniqueIds.length) {
    ctx.session.pendingPhotoUniqueIds.splice(idx, 1);
  }
  ctx.session.pendingPhotos.splice(idx, 1);

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (user) {
    const committed = await removeProfilePhotoByRef(user.id, deletedPhotoRef);
    // The locked service may retain photos added by a concurrent mobile/Aether
    // edit. Mirror that canonical state back into this Telegram session so its
    // next button cannot overwrite those additions.
    ctx.session.pendingPhotos = committed.photos;
    ctx.session.pendingProfileMedia = committed.profileMedia;
    ctx.session.pendingPhotoHashes = committed.uploadedPhotoHashes;
    ctx.session.pendingPhotoScores = committed.photoFaceScores;
    ctx.session.pendingPhotoUniqueIds = committed.photos.map((photoRef) => {
      const priorIndex = priorPhotos.indexOf(photoRef);
      return priorIndex >= 0 ? priorUniqueIds[priorIndex] ?? "" : "";
    });
  } else {
    await persistPendingPhotos(ctx);
  }
  await renderPhotoManager(ctx);
}

/**
 * Collect incoming photos while `menuState === "edit_photos"`.
 * Refreshes the photo manager after each accepted photo; commits on ✅ Done.
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
  const telegramId = BigInt(ctx.from!.id);
  const userRow = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });

  // Dedupe identical frames (album retries / double-delivery).
  if (ctx.session.pendingPhotoUniqueIds?.includes(fileUniqueId)) {
    if (userRow) {
      await logMediaValidationRejection({
        userId: userRow.id,
        mediaType: "photo",
        reason: "duplicate_exact",
      });
    }
    return;
  }

  if (ctx.session.pendingPhotos.length >= MAX_PHOTOS) {
    await ctx.reply(t(lang, "photoReceived", { n: MAX_PHOTOS, max: MAX_PHOTOS }));
    await finishEditPhotos(ctx);
    return;
  }

  let gateScore = 0;
  let photoHash: string | null = null;
  if (env.PROFILE_MEDIA_VALIDATION_ENABLED) {
    const photoBytes = await fetchTelegramFileBuffer(ctx.api, fileId);
    if (!userRow || !photoBytes) {
      await ctx.reply(t(lang, "photoVisionError"));
      return;
    }
    const validation = await validateUserProfilePhoto({
      userId: userRow.id,
      candidate: photoBytes,
      mime: "image/jpeg",
      existingPhotoRefs: ctx.session.pendingPhotos,
      existingPhotoHashes: ctx.session.pendingPhotoHashes,
      api: ctx.api,
    });
    if (!validation.ok) {
      await ctx.reply(photoValidationMessage(lang, validation.reason), {
        parse_mode: "Markdown",
      });
      return;
    } else {
      gateScore = validation.value.identitySimilarity ?? 0;
      photoHash = validation.value.fingerprint.differenceHash;
    }

    const priorPhotos = [...ctx.session.pendingPhotos];
    const priorUniqueIds = [...ctx.session.pendingPhotoUniqueIds];
    const consensus = await commitProfilePhotoCandidate({
      userId: userRow.id,
      photoRef: fileId,
      profileMedia: incoming.profileMedia,
      perceptualHash: photoHash,
      faceScore: gateScore,
      source: "telegram_edit",
      candidateBuffer: photoBytes,
      api: ctx.api,
    });
    syncEditSessionFromConsensus(ctx, consensus, {
      priorPhotos,
      priorUniqueIds,
      candidatePhotoRef: fileId,
      candidateUniqueId: fileUniqueId,
    });

    const consensusMessage = photoConsensusEditMessage(lang, consensus);
    if (consensusMessage) await ctx.reply(consensusMessage);
    const count = ctx.session.pendingPhotos.length;
    if (
      (consensus.status === "pending" || consensus.status === "capped") &&
      count < MIN_PHOTOS
    ) {
      return;
    }
    await ctx.reply(t(lang, "photoReceived", { n: count, max: MAX_PHOTOS }));
    await renderPhotoManager(ctx, { showAlbum: false });
    return;
  } else {
    // Legacy path retained behind the rollout flag.
    const result = await validateSingleFace(ctx, fileId);
    if (!result.ok) {
      await ctx.reply(t(lang, "photoVisionError"));
      return;
    }
    if (!result.valid) {
      await ctx.reply(t(lang, "photoRejected"), { parse_mode: "Markdown" });
      return;
    }

    if (!userRow) {
      await ctx.reply(t(lang, "photoVisionError"));
      return;
    }
    const photoBytes = await fetchTelegramFileBuffer(ctx.api, fileId);
    if (!photoBytes) {
      await ctx.reply(t(lang, "photoVisionError"));
      return;
    }
    const gate = await gateProfilePhoto(userRow.id, photoBytes);
    if (gate.kind === "blocked") {
      await ctx.reply(t(lang, "photoMatchMismatch"));
      return;
    }
    if (gate.kind === "unavailable") {
      await ctx.reply(t(lang, "photoVisionError"));
      return;
    }
    gateScore = gate.score ?? 0;
    // Legacy fallback only runs when unified media validation is explicitly disabled.
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
  ctx.session.pendingPhotoHashes = [
    ...alignPhotoHashes(
      ctx.session.pendingPhotos.slice(0, -1),
      ctx.session.pendingPhotoHashes ?? [],
    ),
    photoHash ?? MISSING_PHOTO_HASH,
  ];
  ctx.session.pendingPhotoScores = [
    ...(ctx.session.pendingPhotoScores ?? []),
    gateScore,
  ];
  const count = ctx.session.pendingPhotos.length;
  await ctx.reply(t(lang, "photoReceived", { n: count, max: MAX_PHOTOS }));
  await renderPhotoManager(ctx, { showAlbum: false });
}

function photoValidationMessage(
  language: Parameters<typeof t>[0],
  reason: MediaValidationReason,
): string {
  switch (reason) {
    case "invalid_media":
      return t(language, "photoInvalidMedia");
    case "duplicate_exact":
      return t(language, "photoDuplicate");
    case "duplicate_near":
      return t(language, "photoDuplicateNear");
    case "unsafe_content":
      return t(language, "photoUnsafeContent");
    case "face_obscured":
      return t(language, "photoFaceObscured");
    case "multiple_faces_photo":
      return t(language, "photoRejected");
    case "identity_mismatch":
    case "identity_uncertain":
      return t(language, "photoIdentityMismatch");
    case "no_face":
      return t(language, "photoRejected");
    default:
      return t(language, "photoVisionError");
  }
}

function syncEditSessionFromConsensus(
  ctx: BotContext,
  consensus: PhotoConsensusCommitResult,
  uniqueIds: {
    priorPhotos: readonly string[];
    priorUniqueIds: readonly string[];
    candidatePhotoRef: string;
    candidateUniqueId: string;
  },
): void {
  ctx.session.pendingPhotos = [...consensus.photos];
  ctx.session.pendingProfileMedia = [...consensus.profileMedia];
  ctx.session.pendingPhotoHashes = [...consensus.uploadedPhotoHashes];
  ctx.session.pendingPhotoScores = [...consensus.photoFaceScores];
  ctx.session.pendingPhotoUniqueIds = consensus.photos.map((photoRef) => {
    if (photoRef === uniqueIds.candidatePhotoRef) return uniqueIds.candidateUniqueId;
    const previousIndex = uniqueIds.priorPhotos.indexOf(photoRef);
    return previousIndex >= 0 ? uniqueIds.priorUniqueIds[previousIndex] ?? "" : "";
  });
}

function photoConsensusEditMessage(
  language: Parameters<typeof t>[0],
  consensus: PhotoConsensusCommitResult,
): string | null {
  if (consensus.status === "pending") return t(language, "photoConsensusPending");
  if (consensus.status === "capped") return t(language, "photoConsensusNoPairCap");
  if (consensus.status === "confirmed") {
    return [
      t(language, "photoConsensusConfirmed"),
      consensus.rejectedCount > 0 ? t(language, "photoConsensusOutlierRejected") : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");
  }
  return null;
}

/**
 * Persist the current pending photo set (photos + structured media + scores +
 * hash/reference state) to the profile. Shared by the manager's delete path
 * (immediate persist, so the consensus upload path never resurrects a deleted
 * photo) and by `finishEditPhotos`. Returns the user id, or null if unknown.
 * Does NOT rerun verification or reset the session — callers decide that.
 */
async function persistPendingPhotos(ctx: BotContext): Promise<string | null> {
  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      profile: {
        select: {
          referenceFaceEmbedding: true,
          uploadedPhotoHashes: true,
        },
      },
    },
  });
  if (!user) return null;

  // Pad/truncate scores to match photos length defensively (in case the session
  // started before the field existed, or the user re-uploaded photos without
  // the gate populating a score for each).
  const scores = [
    ...(ctx.session.pendingPhotoScores ?? []),
    ...Array(
      Math.max(
        0,
        ctx.session.pendingPhotos.length - (ctx.session.pendingPhotoScores?.length ?? 0),
      ),
    ).fill(0),
  ].slice(0, ctx.session.pendingPhotos.length);
  const photoState = photoUploadStatePatch({
    photos: ctx.session.pendingPhotos,
    uploadedPhotoHashes: alignPhotoHashes(
      ctx.session.pendingPhotos,
      ctx.session.pendingPhotoHashes,
    ),
    referenceFaceEmbedding: user.profile?.referenceFaceEmbedding ?? null,
  });

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
      ...photoState,
    },
  });
  return user.id;
}

async function finishEditPhotos(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;

  // With the unified validator on, every accepted upload and every deletion
  // has already committed through per-user locked services. A final full-array
  // save here would reintroduce the stale-session overwrite that those paths
  // deliberately prevent. Keep the legacy fallback for disabled rollouts.
  const userId = env.PROFILE_MEDIA_VALIDATION_ENABLED
    ? await prisma.user
        .findUnique({ where: { telegramId: BigInt(ctx.from!.id) }, select: { id: true } })
        .then((user) => user?.id ?? null)
    : await persistPendingPhotos(ctx);
  if (!userId) return;

  // Re-run face-match verification against the new photo set. The
  // per-frame `gateProfilePhoto` above blocked obviously-wrong photos
  // at upload time, but the *aggregate* verification status (verified /
  // pending_review / rejected) is a function of the WHOLE array — so a
  // rejected user who replaced their bad photos must be re-evaluated,
  // and the persisted `photoFaceScores` must stay aligned with `photos`.
  // Fire-and-forget; pipeline errors land in the bot logs.
  void triggerVerificationRerun(userId, ctx.api).catch((err) => {
    console.error("[edit-profile] verification rerun failed:", err);
  });

  ctx.session.pendingPhotos = [];
  ctx.session.pendingProfileMedia = [];
  ctx.session.pendingPhotoUniqueIds = [];
  ctx.session.pendingPhotoHashes = [];
  ctx.session.pendingPhotoScores = [];
  ctx.session.photoManagerMsgId = null;
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
