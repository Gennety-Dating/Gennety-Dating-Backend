import { InlineKeyboard, type Api } from "grammy";
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
  PROFILE_VIDEO_MAX_FILE_SIZE_BYTES,
  DEFAULT_SESSION,
  normalizeProfileMedia,
  escapeMd,
  type Language,
  type SessionData,
  type PhotoManagerCard,
} from "@gennety/shared";
import { validateSingleFace } from "../../services/vision/validate-face.js";
import {
  fetchTelegramFileBuffer,
  gateProfilePhoto,
} from "../../services/face-match-gate.js";
import { triggerVerificationRerun } from "../../services/verification-pipeline.js";
import { buildVerificationKeyboard } from "../../services/verification-keyboard.js";
import { showMainMenu } from "./main.js";
import { showMyProfile } from "./my-profile.js";
import {
  getMessageLivePhoto,
  getMessageVideo,
  incomingLivePhotoMedia,
  incomingPhotoMedia,
  incomingVideoMedia,
  type IncomingProfileMedia,
} from "../../services/telegram-profile-media.js";
import { prepareProfileVideo, videoSavedAck } from "../../services/profile-video.js";
import { grantVideoBonusIfEligible } from "../../services/ticket-wallet.js";
import { sendTicketRewardDM } from "../../services/ticket-reward.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import { photoUploadSteps } from "../../services/analysis-status.js";
import { dispatchToChat } from "../../chat-queue.js";
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
import { VERIFY_PHOTOS_CLEAR_CALLBACK } from "../../services/verification-keyboard.js";
import { sendVerificationCTABare } from "../onboarding/verification.js";

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
// Edit Photos — card-based manager
// ---------------------------------------------------------------------------

/**
 * Callback data for a card's own delete button. Every card shares this SAME
 * constant — the tapped card is identified by the message the button lives on
 * (`ctx.callbackQuery.message.message_id`), never an index encoded in the
 * payload, so cards stay independently addable/removable with no renumbering
 * (the same "resolve by the exact tapped message" pattern already used by the
 * Freeze/Delete and Premium-cancel confirmation cards).
 */
const PHOTO_CARD_DELETE_CALLBACK = "menu:edit:photos:delcard";

/**
 * Gap between consecutive card sends. Opening a full 10-photo manager is 10
 * `sendPhoto` calls where the old design was a single `sendMediaGroup`, and an
 * unpaced burst risks a 429 — which would silently cost the user a card while
 * the photo still counts toward the total. Small enough to stay imperceptible
 * (~1s across a full set), large enough to keep the burst civil.
 */
const PHOTO_CARD_SEND_DELAY_MS = 120;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drop one card's message. Telegram only lets a bot delete its own messages
 * for 48 hours, so a manager opened, abandoned, and resumed days later cannot
 * always clean up after itself. In that case the card must at least stop
 * looking live: one `editMessageCaption` both marks it deleted and drops its
 * button (omitting `reply_markup` clears the keyboard).
 */
async function removePhotoCardMessage(
  api: Api,
  chatId: number,
  msgId: number,
  language: Language,
): Promise<void> {
  try {
    await api.deleteMessage(chatId, msgId);
  } catch {
    await api
      .editMessageCaption(chatId, msgId, {
        caption: t(language, "photoManagerCardRemoved"),
      })
      .catch(() => {});
  }
}

/**
 * Close the manager's live surface: strip the keyboards off every tracked card
 * and off the bottom panel, then stop tracking them.
 *
 * The card messages themselves stay in the chat on purpose — they are the
 * gallery the user just reviewed — but their delete buttons must not survive,
 * because after this the session no longer knows what they point at. Tapping
 * one is already a safe no-op (cards resolve by message id), yet a button that
 * does nothing is its own bug. The pre-card manager stripped its control
 * message's keyboard for exactly this reason.
 */
async function retirePhotoCards(
  api: Api,
  chatId: number,
  session: SessionData,
): Promise<void> {
  for (const card of session.photoCards) {
    await api.editMessageReplyMarkup(chatId, card.msgId).catch(() => {});
  }
  session.photoCards = [];
  if (session.photoManagerMsgId != null) {
    await api.editMessageReplyMarkup(chatId, session.photoManagerMsgId).catch(() => {});
    session.photoManagerMsgId = null;
  }
}

/**
 * Put the session into "edit_photos" mode and prompt for new photos.
 *
 * M-3: preload existing photos into `pendingPhotos` so the user is *adding*
 * to their album, not starting from scratch. Pre-fix tapping "Edit photos"
 * silently wiped existing photos unless the user re-uploaded everything.
 */
export async function handleEditPhotosStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  discardPhotoBatch(ctx.chat?.id);
  ctx.session.verifyPhotoRedo = false;
  await openPhotoManager(ctx);
}

/**
 * Load the current photo set into the session and render the manager. Split out
 * of {@link handleEditPhotosStart} so the verification redo entry point can
 * reuse it without acking the same callback query twice.
 *
 * Anything tracked from a PRIOR manager session (one abandoned without tapping
 * Done) is stale, so it is retired first — keyboards stripped, tracking
 * cleared — and this then sends a fresh set of cards rather than trying to
 * reuse the old ones. Without the retire step, reopening the manager twice
 * leaves the first run's cards in the chat still showing delete buttons that
 * no longer resolve to anything.
 */
async function openPhotoManager(ctx: BotContext): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);

  if (ctx.chat) {
    await retirePhotoCards(ctx.api, ctx.chat.id, ctx.session);
  }

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
 * "📷 Upload different photos" — the way back from any verification prompt
 * (`verify:photos`).
 *
 * Same manager, three deltas driven by `session.verifyPhotoRedo`: a
 * "delete all and start over" action, no `MIN_PHOTOS` delete floor, and a
 * finish path that returns to verification instead of the main menu. This is
 * the ONE menu surface reachable while the app is verification-locked (see
 * `services/verification-gate.ts`).
 *
 * The intro promises an automatic recheck ("no need to redo the selfie") ONLY
 * when a reference selfie is actually still on file — after the 90-day GDPR
 * scrub (PRODUCT_SPEC §1.4), or for a user who was never liveness-verified in
 * the first place, that promise would be false, and "will I have to film
 * myself again?" is exactly the worry that stalls someone on this screen.
 */
export async function handleVerifyPhotosRedo(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  discardPhotoBatch(ctx.chat?.id);
  ctx.session.verifyPhotoRedo = true;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { verifiedSelfiePath: true },
  });
  await ctx.reply(
    t(
      ctx.session.language,
      user?.verifiedSelfiePath ? "verifyPhotosRedoIntroRecheck" : "verifyPhotosRedoIntro",
    ),
  );
  await openPhotoManager(ctx);
}

/**
 * "🗑 Delete all and start over" — the one-tap path for the case this whole
 * flow exists to fix: every photo on the profile is of someone else. Deleting
 * them one by one would be up to ten taps, and at exactly `MIN_PHOTOS` the
 * per-photo button is refused outright.
 *
 * Each removal goes through the same per-user-locked service the manager's
 * delete button uses, so a concurrent mobile/Aether edit can't be clobbered.
 * The card MESSAGES themselves are torn down by {@link renderPhotoManager}'s
 * own reconciliation afterwards (`pendingPhotos` is empty, so every tracked
 * card gets pruned) rather than by this loop.
 */
export async function handleVerifyPhotosClear(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  await ctx.answerCallbackQuery();
  discardPhotoBatch(ctx.chat?.id);

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  // Snapshot first: `removeProfilePhotoByRef` returns the canonical post-delete
  // state, so we iterate the refs we started with rather than a shifting array.
  for (const photoRef of [...ctx.session.pendingPhotos]) {
    const committed = await removeProfilePhotoByRef(user.id, photoRef);
    ctx.session.pendingPhotos = committed.photos;
    ctx.session.pendingProfileMedia = committed.profileMedia;
    ctx.session.pendingPhotoHashes = committed.uploadedPhotoHashes;
    ctx.session.pendingPhotoScores = committed.photoFaceScores;
  }
  ctx.session.pendingPhotoUniqueIds = ctx.session.pendingPhotos.map(() => "");

  await ctx.reply(
    t(lang, "verifyPhotosCleared", { min: MIN_PHOTOS, max: MAX_PHOTOS }),
  );
  await renderPhotoManager(ctx);
}

/**
 * Reconcile `session.photoCards` against `session.pendingPhotos`: delete the
 * card message for any ref no longer present (a concurrent mobile/Aether edit,
 * or an explicit delete/clear-all that already spliced its own arrays before
 * calling this), and send a fresh card — the photo plus a single delete
 * button — for any ref that doesn't have one yet.
 *
 * Returns true when at least one card was newly SENT, which is the caller's
 * signal that the bottom panel must move below the new cards rather than
 * being edited in place (Telegram has no "move a message").
 */
async function ensurePhotoCards(
  api: Api,
  chatId: number,
  session: SessionData,
): Promise<boolean> {
  const wanted = new Set(session.pendingPhotos);
  const kept: PhotoManagerCard[] = [];
  for (const card of session.photoCards) {
    if (wanted.has(card.ref)) {
      kept.push(card);
    } else {
      await removePhotoCardMessage(api, chatId, card.msgId, session.language);
    }
  }

  const known = new Set(kept.map((c) => c.ref));
  let addedAny = false;
  for (const ref of session.pendingPhotos) {
    if (known.has(ref)) continue;
    // Pace the burst: a full set is up to 10 sends where the old design used
    // one media group (see PHOTO_CARD_SEND_DELAY_MS).
    if (addedAny) await sleep(PHOTO_CARD_SEND_DELAY_MS);
    try {
      const msg = await api.sendPhoto(chatId, ref, {
        reply_markup: new InlineKeyboard().text(
          t(session.language, "photoManagerCardDeleteBtn"),
          PHOTO_CARD_DELETE_CALLBACK,
        ),
      });
      kept.push({ msgId: msg.message_id, ref });
      addedAny = true;
    } catch (err) {
      // Stale file_id, or a rate limit we paced for but still hit. The photo
      // stays counted toward MIN/MAX either way and the next re-render retries
      // its card — but this must not stay silent, because the visible symptom
      // (panel says 10/10, fewer cards on screen) looks like a render bug.
      console.warn("[edit-profile] photo card send failed:", err);
    }
  }

  session.photoCards = kept;
  return addedAny;
}

/**
 * Render (or update) the bottom panel: a photo counter, then in order the
 * redo-only clear-all action, ➕ Add (hidden at MAX), and ✅ Done.
 *
 * `forceResend` is set whenever {@link ensurePhotoCards} just sent new cards:
 * since Telegram has no "move a message", the only way to keep the panel
 * BELOW the freshly-arrived cards is to delete the old one and send a new
 * one. Otherwise (a delete, or a re-render with no new cards) the panel is
 * already the newest message in the chat, so it is edited in place — cheaper,
 * and it avoids the panel visibly flickering out and back for a one-line
 * count change.
 */
async function renderPhotoManagerPanel(
  api: Api,
  chatId: number,
  session: SessionData,
  opts: { forceResend: boolean; lead?: string },
): Promise<void> {
  const { forceResend, lead } = opts;
  const lang = session.language;
  const photos = session.pendingPhotos;

  const keyboard = new InlineKeyboard();
  // Verification redo only: one tap to drop a whole set of someone else's
  // photos instead of deleting each card individually.
  if (session.verifyPhotoRedo && photos.length > 0) {
    keyboard.text(t(lang, "verifyBtnClearPhotos"), VERIFY_PHOTOS_CLEAR_CALLBACK).row();
  }
  if (photos.length < MAX_PHOTOS) {
    keyboard.text(t(lang, "photoManagerAddBtn"), "menu:edit:photos:add").row();
  }
  keyboard.text(t(lang, "photoManagerDoneBtn"), "menu:edit:photos:continue");

  const counter = t(lang, "photoManagerTitle", {
    count: photos.length,
    min: MIN_PHOTOS,
    max: MAX_PHOTOS,
  });
  const text = lead ? `${lead}\n\n${counter}` : counter;

  if (!forceResend && session.photoManagerMsgId != null) {
    try {
      await api.editMessageText(chatId, session.photoManagerMsgId, text, {
        reply_markup: keyboard,
      });
      return;
    } catch {
      // Either the message is gone, or the text is byte-identical and Telegram
      // rejects the no-op edit (the video path re-renders without changing the
      // count). Both are handled the same way — send a fresh panel below.
    }
  }

  if (session.photoManagerMsgId != null) {
    await api.deleteMessage(chatId, session.photoManagerMsgId).catch(() => {});
  }
  const msg = await api.sendMessage(chatId, text, { reply_markup: keyboard });
  session.photoManagerMsgId = msg?.message_id ?? null;
}

/**
 * Render the photo-manager screen: reconcile the per-photo cards, then render
 * the bottom counter/actions panel below them.
 */
async function renderPhotoManager(
  ctx: BotContext,
  opts: { lead?: string } = {},
): Promise<void> {
  if (!ctx.chat) return;
  await renderPhotoManagerCore(ctx.api, ctx.chat.id, ctx.session, opts);
}

/**
 * Ctx-free core of {@link renderPhotoManager}. `session` is mutated in place
 * (`photoCards`, `photoManagerMsgId`), so the caller owns persisting it — the
 * live `ctx.session` is written back by grammY, while the debounced batch
 * flush (which runs outside the update lifecycle) upserts the `bot_sessions`
 * row itself.
 *
 * `lead` prepends a summary line to the panel, which is how a whole upload
 * burst reports itself in ONE message instead of one reply per frame.
 */
async function renderPhotoManagerCore(
  api: Api,
  chatId: number,
  session: SessionData,
  opts: { lead?: string } = {},
): Promise<void> {
  const addedAny = await ensurePhotoCards(api, chatId, session);
  await renderPhotoManagerPanel(api, chatId, session, {
    // A `lead` is a burst summary the user has to actually SEE, and by the
    // time it exists the chat already holds their uploads plus any per-frame
    // rejection replies. Editing it into a panel that has scrolled above all
    // of that hides exactly the message that matters most — notably the
    // "nothing was added" case, where no new card forces a resend on its own.
    forceResend: addedAny || opts.lead !== undefined,
    ...(opts.lead !== undefined ? { lead: opts.lead } : {}),
  });
}

/**
 * Re-open the upload sub-mode from the manager's ➕ button. Stays in
 * `edit_photos`, so the next photo message flows to `handleEditPhotosUpload`.
 */
export async function handleEditPhotosAdd(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  discardPhotoBatch(ctx.chat?.id);
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
 * Delete one photo's own card (`menu:edit:photos:delcard`) — the tapped card is
 * resolved via the MESSAGE the button lives on
 * (`ctx.callbackQuery.message.message_id`), never an index in the payload, so
 * cards stay independently addable/removable with no renumbering.
 *
 * Splices the photo's index out of every index-aligned array so media, score,
 * hash and Telegram unique id always continue to describe the same photo. This
 * also permits a deliberately deleted photo to be uploaded again in the
 * session.
 *
 * The reduced set is persisted immediately so it stays consistent with the
 * consensus upload path (`commitProfilePhotoCandidate` reads `photos` from the
 * DB); otherwise a later add would resurrect the deleted photo. Verification is
 * NOT rerun here — that fires once on Done via `finishEditPhotos`.
 */
export async function handleEditPhotosDelete(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  discardPhotoBatch(ctx.chat?.id);

  const cardMsgId = ctx.callbackQuery?.message?.message_id;
  const card =
    cardMsgId != null
      ? ctx.session.photoCards.find((c) => c.msgId === cardMsgId)
      : undefined;
  const idx = card ? ctx.session.pendingPhotos.indexOf(card.ref) : -1;
  if (!card || idx < 0) {
    // Stale tap — the card was already removed (double-tap, or a concurrent
    // edit dropped this photo elsewhere).
    await ctx.answerCallbackQuery();
    return;
  }
  // The floor keeps a live profile from dropping below the minimum. It is
  // lifted for the verification redo: that user is not in the matching pool
  // yet, and someone whose four photos are all of another person could
  // otherwise delete none of them. `finishEditPhotos` still refuses to commit
  // below MIN_PHOTOS, so they cannot leave the flow under-filled.
  if (!ctx.session.verifyPhotoRedo && ctx.session.pendingPhotos.length <= MIN_PHOTOS) {
    await ctx.answerCallbackQuery({
      text: t(lang, "photoManagerMinReached", { min: MIN_PHOTOS }),
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery({ text: t(lang, "photoManagerDeleted") });

  // Drop the card's own message right away — its own tap is confirmation
  // enough, no need to wait for the panel re-render below.
  if (ctx.chat) {
    await removePhotoCardMessage(ctx.api, ctx.chat.id, cardMsgId!, lang);
  }
  ctx.session.photoCards = ctx.session.photoCards.filter((c) => c.msgId !== cardMsgId);

  const deletedPhotoRef = card.ref;
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
 *
 * Uploads are **coalesced into one burst**. A photo takes several seconds to
 * validate and, under `sequentializeByChat`, an album's frames are processed
 * serially — so replying per frame produced the reported mess: "Photo 1/10",
 * then "Photo 2/10", then a detached "your face is hard to make out", each
 * arriving seconds apart while later frames were still in flight. Instead one
 * shimmer status covers the whole burst, and a single control message reports
 * the result with the ✅ Done button. (The onboarding media stage has done this
 * since PRODUCT_SPEC §1.3; the menu manager never did.)
 */
export async function handleEditPhotosUpload(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;

  // Continue button → commit whatever is in pendingPhotos (if >= MIN).
  const data = ctx.callbackQuery?.data;
  if (data === "menu:edit:photos:continue") {
    await ctx.answerCallbackQuery();
    // Drop any in-flight burst: its summary would land after the flow ended.
    discardPhotoBatch(ctx.chat?.id);
    if (ctx.session.pendingPhotos.length >= MIN_PHOTOS) {
      await finishEditPhotos(ctx);
    } else {
      // Reachable once the verification redo lifts the delete floor — say why
      // nothing happened instead of going silent.
      await ctx.reply(t(lang, "photoManagerMinReached", { min: MIN_PHOTOS }));
    }
    return;
  }

  // A video sent into the photo manager used to fall through to "send me
  // photos" and be silently lost. It is display-only (never enters `photos[]`),
  // so it is accepted here through the same shared validator the Profile Video
  // menu entry uses — the manager is the only media surface reachable while the
  // verification gate is up.
  const video = getMessageVideo(ctx.message);
  if (video) {
    await flushPhotoBatchInline(ctx.chat?.id);
    await handlePhotoStageVideo(ctx, video);
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

  if (!ctx.chat) return;
  const batch = openPhotoBatch(ctx);
  const outcome = await processPhotoFrame(ctx, incoming);
  recordFrameOutcome(batch, outcome, ctx.message?.message_id);
  armPhotoBatchFlush(batch);
}

/** What one validated frame did, with no user-facing side effects. */
type PhotoFrameOutcome =
  | { kind: "accepted"; note?: string }
  | { kind: "rejected"; reason: MediaValidationReason }
  | { kind: "infra_error" }
  | { kind: "capped" };

async function processPhotoFrame(
  ctx: BotContext,
  incoming: IncomingProfileMedia,
): Promise<PhotoFrameOutcome> {
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
    return { kind: "rejected", reason: "duplicate_exact" };
  }

  if (ctx.session.pendingPhotos.length >= MAX_PHOTOS) {
    return { kind: "capped" };
  }

  let gateScore = 0;
  let photoHash: string | null = null;
  if (env.PROFILE_MEDIA_VALIDATION_ENABLED) {
    const photoBytes = await fetchTelegramFileBuffer(ctx.api, fileId);
    if (!userRow || !photoBytes) return { kind: "infra_error" };

    const validation = await validateUserProfilePhoto({
      userId: userRow.id,
      candidate: photoBytes,
      mime: "image/jpeg",
      existingPhotoRefs: ctx.session.pendingPhotos,
      existingPhotoHashes: ctx.session.pendingPhotoHashes,
      api: ctx.api,
    });
    if (!validation.ok) {
      return { kind: "rejected", reason: validation.reason };
    }
    gateScore = validation.value.identitySimilarity ?? 0;
    photoHash = validation.value.fingerprint.differenceHash;

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

    const note = photoConsensusEditMessage(ctx.session.language, consensus);
    return { kind: "accepted", ...(note ? { note } : {}) };
  }

  // Legacy path retained behind the rollout flag.
  const result = await validateSingleFace(ctx, fileId);
  if (!result.ok) return { kind: "infra_error" };
  if (!result.valid) return { kind: "rejected", reason: "no_face" };
  if (!userRow) return { kind: "infra_error" };

  const photoBytes = await fetchTelegramFileBuffer(ctx.api, fileId);
  if (!photoBytes) return { kind: "infra_error" };

  const gate = await gateProfilePhoto(userRow.id, photoBytes);
  if (gate.kind === "blocked") return { kind: "rejected", reason: "identity_mismatch" };
  if (gate.kind === "reference_expired") {
    return { kind: "rejected", reason: "reference_expired" };
  }
  if (gate.kind === "unavailable") return { kind: "infra_error" };
  gateScore = gate.score ?? 0;

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
  return { kind: "accepted" };
}

// ---------------------------------------------------------------------------
// Upload burst coalescing
// ---------------------------------------------------------------------------

/**
 * One in-flight upload burst per chat. A Telegram album arrives as N separate
 * messages and standalone photos sent back-to-back behave the same, so the
 * window measures "time since the last frame finished validating" — the timer
 * is re-armed after each frame, not when the first one landed.
 */
interface PhotoUploadBatch {
  chatId: number;
  api: Api;
  language: Language;
  accepted: number;
  capped: number;
  hadInfraError: boolean;
  notes: string[];
  /** Per-frame rejections, carrying the offending message so the reason can
   *  be replied to THAT photo (PRODUCT_SPEC §1.3 — a detached line leaves the
   *  user guessing which frame of an album failed). */
  rejections: Array<{ messageId?: number; reason: MediaValidationReason }>;
  timer: NodeJS.Timeout | null;
  /** Resolved on flush; the shimmer status is held until then. */
  finish: () => void;
  /** The shimmer itself, awaited before the summary so it is torn down first. */
  status: Promise<void>;
}

const photoUploadBatches = new Map<number, PhotoUploadBatch>();
const PHOTO_UPLOAD_DEBOUNCE_MS = 900;

function openPhotoBatch(ctx: BotContext): PhotoUploadBatch {
  const chatId = ctx.chat!.id;
  const existing = photoUploadBatches.get(chatId);
  if (existing) {
    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    return existing;
  }

  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const batch: PhotoUploadBatch = {
    chatId,
    api: ctx.api,
    language: ctx.session.language,
    accepted: 0,
    capped: 0,
    hadInfraError: false,
    notes: [],
    rejections: [],
    timer: null,
    finish,
    // One shimmer for the whole burst, held until the last frame settles.
    status: runStatusSequence(ctx.api, chatId, photoUploadSteps(ctx.session.language), {
      rich: true,
      until: done,
    }).catch(() => {}),
  };
  photoUploadBatches.set(chatId, batch);
  return batch;
}

function recordFrameOutcome(
  batch: PhotoUploadBatch,
  outcome: PhotoFrameOutcome,
  messageId: number | undefined,
): void {
  switch (outcome.kind) {
    case "accepted":
      batch.accepted += 1;
      if (outcome.note && !batch.notes.includes(outcome.note)) {
        batch.notes.push(outcome.note);
      }
      return;
    case "rejected":
      batch.rejections.push({ ...(messageId ? { messageId } : {}), reason: outcome.reason });
      return;
    case "capped":
      batch.capped += 1;
      return;
    case "infra_error":
      batch.hadInfraError = true;
      return;
  }
}

function armPhotoBatchFlush(batch: PhotoUploadBatch): void {
  if (batch.timer) clearTimeout(batch.timer);
  batch.timer = setTimeout(() => {
    batch.timer = null;
    photoUploadBatches.delete(batch.chatId);
    // Runs outside the update lifecycle — queue it on the chat so it cannot
    // interleave with a concurrent update's session write.
    dispatchToChat(batch.chatId, () => flushPhotoBatch(batch)).catch((err) =>
      console.error("[edit-profile] photo batch flush failed:", err),
    );
  }, PHOTO_UPLOAD_DEBOUNCE_MS);
}

/**
 * Tear down an in-flight burst without reporting it — used when the user takes
 * an explicit action (Done, delete, clear-all, ➕) that renders the manager
 * itself, so the pending summary would only duplicate it.
 */
function discardPhotoBatch(chatId: number | undefined): void {
  if (chatId === undefined) return;
  const batch = photoUploadBatches.get(chatId);
  if (!batch) return;
  if (batch.timer) clearTimeout(batch.timer);
  photoUploadBatches.delete(chatId);
  batch.finish();
}

/**
 * Flush an open burst from INSIDE an update (so `dispatchToChat` would
 * deadlock on the chat queue this update already holds). Used before the video
 * path so the two status shimmers never overlap.
 */
async function flushPhotoBatchInline(chatId: number | undefined): Promise<void> {
  if (chatId === undefined) return;
  const batch = photoUploadBatches.get(chatId);
  if (!batch) return;
  if (batch.timer) clearTimeout(batch.timer);
  photoUploadBatches.delete(chatId);
  await flushPhotoBatch(batch);
}

/**
 * Report a finished burst: tear the shimmer down, explain each rejected frame
 * on the frame itself, then re-render the manager ONCE with a summary lead and
 * the ✅ Done button.
 */
async function flushPhotoBatch(batch: PhotoUploadBatch): Promise<void> {
  batch.finish();
  await batch.status;

  const key = batch.chatId.toString();
  const row = await prisma.botSession.findUnique({ where: { key } });
  const session: SessionData = {
    ...DEFAULT_SESSION,
    ...((row?.data ?? {}) as Partial<SessionData>),
  };
  const lang = session.language ?? batch.language;

  // `reference_expired` is the one rejection that isn't about the photo it
  // arrived with — the account's verification selfie was scrubbed at 90 days,
  // so EVERY frame in the burst failed for the same account-level reason.
  // Replying it onto each frame would read as "these photos are bad" and give
  // the user nothing to act on, so it is hoisted out: one message, one Verify
  // button, and the per-frame replies cover only genuine per-photo problems.
  const expiredReference = batch.rejections.some(
    (r) => r.reason === "reference_expired",
  );
  for (const rejection of batch.rejections) {
    if (rejection.reason === "reference_expired") continue;
    await batch.api
      .sendMessage(batch.chatId, photoValidationMessage(lang, rejection.reason), {
        parse_mode: "Markdown",
        ...(rejection.messageId
          ? { reply_parameters: { message_id: rejection.messageId } }
          : {}),
      })
      .catch(() => {});
  }
  if (expiredReference) {
    await sendReferenceExpiredPrompt(batch.api, batch.chatId, lang);
  }
  if (batch.hadInfraError) {
    await batch.api.sendMessage(batch.chatId, t(lang, "photoVisionError")).catch(() => {});
  }

  const total = session.pendingPhotos.length;
  const leadLines: string[] = [];
  if (batch.accepted > 0) {
    leadLines.push(
      t(lang, "photoBatchAdded", { n: batch.accepted, total, max: MAX_PHOTOS }),
    );
  } else if (batch.rejections.length > 0 || batch.hadInfraError) {
    leadLines.push(t(lang, "photoBatchNoneAdded"));
  }
  if (batch.capped > 0) leadLines.push(t(lang, "photoBatchAtMax", { max: MAX_PHOTOS }));
  leadLines.push(...batch.notes);

  await renderPhotoManagerCore(batch.api, batch.chatId, session, {
    ...(leadLines.length > 0 ? { lead: leadLines.join("\n") } : {}),
  });

  await prisma.botSession.upsert({
    where: { key },
    create: { key, data: session as unknown as object },
    update: { data: session as unknown as object },
  });
}

/**
 * Accept a profile video sent into the photo manager. Display-only: it never
 * enters `photos[]`, so the `photos[i] ↔ photoFaceScores[i]` invariant is
 * untouched and no verification rerun is needed. Shares the validator and the
 * one-time ticket bonus with the Profile Video menu entry, then re-renders the
 * manager so ✅ Done stays reachable (the menu itself may be gate-locked).
 */
async function handlePhotoStageVideo(
  ctx: BotContext,
  video: NonNullable<ReturnType<typeof getMessageVideo>>,
): Promise<void> {
  if (!ctx.chat) return;
  const lang = ctx.session.language;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true, profile: { select: { photos: true, profileMedia: true } } },
  });
  if (!user) return;

  const extracted = incomingVideoMedia(video);
  if (!extracted.ok) {
    void logMediaValidationRejection({
      userId: user.id,
      mediaType: "video",
      reason: extracted.reason === "too_long" ? "video_too_long" : "video_too_large_to_check",
    });
    await ctx.reply(
      extracted.reason === "too_long"
        ? t(lang, "videoTooLong")
        : t(lang, "videoTooLarge", {
            mb: Math.round(PROFILE_VIDEO_MAX_FILE_SIZE_BYTES / (1024 * 1024)),
          }),
    );
    await renderPhotoManager(ctx);
    return;
  }

  const photos = user.profile?.photos ?? [];
  const existingMedia = normalizeProfileMedia(user.profile?.profileMedia ?? [], photos);
  const prepared = await prepareProfileVideo({
    api: ctx.api,
    chatId: ctx.chat.id,
    userId: user.id,
    language: lang,
    media: extracted.media,
    profilePhotoRefs: photos,
    reply: (text) => ctx.reply(text),
  });
  if (prepared.kind === "rejected") {
    await renderPhotoManager(ctx);
    return;
  }

  const nextMedia = [
    ...existingMedia.filter((item) => item.type !== "video"),
    prepared.media,
  ];
  await prisma.profile.update({
    where: { userId: user.id },
    data: { profileMedia: profileMediaToJson(normalizeProfileMedia(nextMedia, photos)) },
  });
  // Keep the editing session in step so a later ✅ Done doesn't drop the video.
  ctx.session.pendingProfileMedia = normalizeProfileMedia(
    [
      ...normalizeProfileMedia(ctx.session.pendingProfileMedia, ctx.session.pendingPhotos)
        .filter((item) => item.type !== "video"),
      prepared.media,
    ],
    ctx.session.pendingPhotos,
  );

  const reward = await grantVideoBonusIfEligible(user.id);
  if (reward.granted) {
    await sendTicketRewardDM(ctx.api, ctx.chat.id, lang, "video", reward.balance);
  } else {
    await ctx.reply(videoSavedAck(lang));
  }
  await renderPhotoManager(ctx);
}

/**
 * Ask for one more liveness check because the reference selfie is gone.
 *
 * The copy ends on a colon and is useless without the button under it, so the
 * two always travel together. Sent once per burst, never per photo.
 */
async function sendReferenceExpiredPrompt(
  api: Api,
  chatId: number,
  language: Language,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(chatId) },
    select: { id: true },
  });
  const keyboard = user
    ? await buildVerificationKeyboard(language, user.id, { withPhotoRedo: false })
    : null;
  await api
    .sendMessage(chatId, t(language, "verifyReferenceExpired"), {
      ...(keyboard ? { reply_markup: keyboard } : {}),
    })
    .catch(() => {});
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
    case "reference_expired":
      return t(language, "verifyReferenceExpired");
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
  // The call resolves once the rerun is KICKED OFF (not once it finishes), so
  // awaiting it costs nothing and tells us whether a Persona selfie is on file.
  let rerunStarted = false;
  let referenceExpired = false;
  try {
    const rerun = await triggerVerificationRerun(userId, ctx.api);
    rerunStarted = rerun?.kind === "started";
    // The 90-day scrub already removed the selfie we would re-score against,
    // and AWS cannot re-issue it. Nothing was lost — the rerun deliberately
    // left the user's verified status alone — but they need one more check
    // before the new photo set can be confirmed.
    referenceExpired = rerun?.kind === "reference_expired";
  } catch (err) {
    console.error("[edit-profile] verification rerun failed:", err);
  }

  const wasVerifyRedo = ctx.session.verifyPhotoRedo;
  ctx.session.pendingPhotos = [];
  ctx.session.pendingProfileMedia = [];
  ctx.session.pendingPhotoUniqueIds = [];
  ctx.session.pendingPhotoHashes = [];
  ctx.session.pendingPhotoScores = [];
  // The card messages stay in the chat as the gallery the user just reviewed,
  // exactly like the old album did after Done — but their delete buttons are
  // stripped, since nothing tracks what they point at once the manager closes.
  if (ctx.chat) {
    await retirePhotoCards(ctx.api, ctx.chat.id, ctx.session);
  } else {
    ctx.session.photoCards = [];
    ctx.session.photoManagerMsgId = null;
  }
  ctx.session.menuState = "idle";
  ctx.session.verifyPhotoRedo = false;

  if (wasVerifyRedo) {
    // Came from a verification prompt: return there, not to the main menu
    // (which may well still be locked behind the gate).
    if (rerunStarted) {
      // A stored reference selfie exists, so the pipeline re-scores the new
      // photos against it — no second liveness pass.
      await ctx.reply(t(lang, "verifyPhotosSavedRecheck"));
    } else if (referenceExpired && ctx.chat) {
      await sendReferenceExpiredPrompt(ctx.api, ctx.chat.id, lang);
    } else {
      await ctx.reply(t(lang, "verifyPhotosSavedNowVerify"));
      if (ctx.chat) {
        await sendVerificationCTABare(
          ctx.api,
          ctx.chat.id,
          BigInt(ctx.from!.id),
          lang,
        );
      }
    }
    return;
  }

  await ctx.reply(t(lang, "editProfilePhotosSaved"));
  if (referenceExpired && ctx.chat) {
    await sendReferenceExpiredPrompt(ctx.api, ctx.chat.id, lang);
  }
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
