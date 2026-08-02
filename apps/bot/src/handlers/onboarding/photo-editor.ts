import { prisma } from "@gennety/db";
import { t, normalizeProfileMedia, type SessionData } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import {
  removePhotoCardMessage,
  renderPhotoCards,
  retirePhotoCards,
  type PhotoCardsSurface,
} from "../../services/photo-cards.js";
import { removeProfilePhotoByRef } from "../../services/profile-media-validation/identity-consensus.js";
import { alignPhotoHashes } from "../../services/profile-media-validation/photo-state.js";
import {
  sendPhotoStagePrompt,
  sessionHasProfileVideo,
} from "../../services/onboarding-photo-stage.js";

/**
 * The onboarding photo EDITOR — the way to reconsider a photo set during the
 * very first upload (PRODUCT_SPEC §1.3).
 *
 * Before this, that stage was write-only: photos could be added but never
 * removed, so a user who disliked their set could only pile more on top until
 * `MAX_PHOTOS`, then walk into verification with photos they never wanted.
 * Every other surface (the menu manager, the verification redo) already had
 * this; the one place where the set is actually FORMED did not.
 *
 * It is the same card manager those surfaces use — one message per photo, its
 * own 🗑 underneath — reached from the stage's persistent bottom panel. Three
 * deltas from the menu variant:
 *
 * - **No `MIN_PHOTOS` delete floor.** The user is not in the matching pool yet,
 *   and the floor's whole job is protecting a live profile. Under-filling is
 *   already handled by the stage itself: "Continue" simply doesn't appear and
 *   the bot says how many more are needed.
 * - **No ➕ Add button.** Photos are sent straight into the chat here; the stage
 *   is already listening for them, and a burst arriving while the editor is
 *   open re-renders the editor rather than the progress message.
 * - **Back returns to the upload stage**, not to a menu — and runs no
 *   verification rerun, because nothing is verified yet (the pipeline runs at
 *   finalization).
 */

export const ONBOARDING_PHOTO_DELETE_CALLBACK = "onb:ph:del";
export const ONBOARDING_PHOTO_BACK_CALLBACK = "onb:ph:back";

/** Card surface for the onboarding editor. See the deltas above. */
export function onboardingPhotoSurface(session: SessionData): PhotoCardsSurface {
  const lang = session.language;
  return {
    deleteCallback: ONBOARDING_PHOTO_DELETE_CALLBACK,
    deleteLabel: t(lang, "photoManagerCardDeleteBtn"),
    done: {
      callback: ONBOARDING_PHOTO_BACK_CALLBACK,
      label: t(lang, "photoEditorBackBtn"),
    },
  };
}

/**
 * Open the editor from the bottom panel: load the canonical photo set from the
 * database into the session, then render the cards.
 *
 * Reading from the DB rather than trusting the session is deliberate — the
 * upload stage persists after every burst, so the row is authoritative, and it
 * also picks up anything a concurrent surface changed.
 *
 * `expectingPhoto` stays TRUE throughout: the stage is still running, the
 * bottom panel must stay put, and photos sent while the editor is open should
 * keep flowing through the normal validation path.
 */
export async function openOnboardingPhotoEditor(ctx: BotContext): Promise<void> {
  if (!ctx.chat) return;
  const telegramId = BigInt(ctx.from!.id);

  // Anything tracked from a previous editor session points at messages the
  // session can no longer resolve — retire it before sending a fresh set.
  await retirePhotoCards(ctx.api, ctx.chat.id, ctx.session);

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

  ctx.session.onboardingPhotoEdit = true;
  ctx.session.pendingPhotos = [...existing];
  ctx.session.pendingProfileMedia = normalizeProfileMedia(
    profile?.profileMedia ?? [],
    existing,
  );
  // A stored `file_id` cannot be turned back into a `file_unique_id`, so the
  // exact-duplicate check starts fresh for the rest of onboarding. The
  // perceptual-hash check (DUPLICATE_HASH_DISTANCE) still catches re-sends,
  // which is the one that matters for a re-encoded/cropped copy anyway.
  ctx.session.pendingPhotoUniqueIds = existing.map(() => "");
  ctx.session.pendingPhotoHashes = alignPhotoHashes(
    existing,
    profile?.uploadedPhotoHashes ?? [],
  );
  // Keep `pendingPhotoScores` 1:1 with the photos; pad legacy short rows with
  // 0 so the `photos[i] ↔ photoFaceScores[i]` invariant holds.
  ctx.session.pendingPhotoScores = [
    ...existingScores,
    ...Array(Math.max(0, existing.length - existingScores.length)).fill(0),
  ];

  await ctx.reply(t(ctx.session.language, "photoEditorIntro"));
  await renderPhotoCards(
    ctx.api,
    ctx.chat.id,
    ctx.session,
    onboardingPhotoSurface(ctx.session),
  );
}

/**
 * Delete one photo's card. The tapped card is resolved by the message its
 * button lives on, never an index in the payload, so cards stay independently
 * deletable with no renumbering.
 */
export async function handleOnboardingPhotoDelete(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const cardMsgId = ctx.callbackQuery?.message?.message_id;
  const card =
    cardMsgId != null
      ? ctx.session.photoCards.find((c) => c.msgId === cardMsgId)
      : undefined;
  const idx = card ? ctx.session.pendingPhotos.indexOf(card.ref) : -1;
  if (!card || idx < 0) {
    // Stale tap — the card was already removed (double-tap, or the photo went
    // away through another path).
    await ctx.answerCallbackQuery();
    return;
  }

  await ctx.answerCallbackQuery({ text: t(lang, "photoManagerDeleted") });

  // Drop the card's own message immediately — its own tap is confirmation
  // enough, no need to wait for the panel re-render below.
  if (ctx.chat) {
    await removePhotoCardMessage(ctx.api, ctx.chat.id, cardMsgId!, lang);
  }
  ctx.session.photoCards = ctx.session.photoCards.filter(
    (c) => c.msgId !== cardMsgId,
  );

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
    // The locked service returns the canonical post-delete state, which may
    // retain photos added concurrently on another surface. Mirror it back so
    // this session's next action cannot overwrite them.
    ctx.session.pendingPhotos = committed.photos;
    ctx.session.pendingProfileMedia = committed.profileMedia;
    ctx.session.pendingPhotoHashes = committed.uploadedPhotoHashes;
    ctx.session.pendingPhotoScores = committed.photoFaceScores;
    ctx.session.pendingPhotoUniqueIds = committed.photos.map((photoRef) => {
      const priorIndex = priorPhotos.indexOf(photoRef);
      return priorIndex >= 0 ? priorUniqueIds[priorIndex] ?? "" : "";
    });
  }

  if (ctx.chat) {
    await renderPhotoCards(
      ctx.api,
      ctx.chat.id,
      ctx.session,
      onboardingPhotoSurface(ctx.session),
    );
  }
}

/**
 * Retire the editor if the upload stage has ended underneath it.
 *
 * The stage can end while the editor is open through paths that never touch it
 * — a typed "done", a tap on an older Continue button, the agent deciding
 * onboarding is finished. Their cards would then keep showing live 🗑 buttons
 * that the session can no longer resolve. Called from the same two message
 * senders that own the bottom panel's teardown, so every stage exit is covered
 * by one rule rather than a check per transition.
 *
 * The trigger is deliberately "the stage is over and cards are still tracked",
 * NOT the `onboardingPhotoEdit` flag alone. `markOnboardingComplete` clears
 * that flag synchronously when the agent finalizes, and it runs BEFORE the next
 * outgoing message — so a flag-only guard returned early on exactly the exit it
 * exists to handle, and the user finished onboarding staring at a stack of
 * photo cards whose 🗑 buttons silently did nothing (`pendingPhotos` is cleared
 * by then, so every tap resolves to a stale no-op). Keying off the tracked
 * cards makes the teardown independent of who clears the flag first.
 */
export async function closeStalePhotoEditor(
  api: BotContext["api"],
  chatId: number,
  session: SessionData,
): Promise<void> {
  if (session.expectingPhoto) return;
  const hasLiveSurface =
    session.onboardingPhotoEdit ||
    session.photoCards.length > 0 ||
    session.photoManagerMsgId != null;
  if (!hasLiveSurface) return;
  await retirePhotoCards(api, chatId, session);
  session.onboardingPhotoEdit = false;
}

/**
 * Close the editor and return to the upload stage. The cards stay in the chat
 * as the gallery the user just reviewed, minus their now-unresolvable buttons.
 *
 * The stage prompt that follows re-derives everything from the current count,
 * so a set taken below `MIN_PHOTOS` simply gets the "you need N more" copy and
 * no Continue button.
 */
export async function handleOnboardingPhotoBack(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!ctx.chat) return;

  await retirePhotoCards(ctx.api, ctx.chat.id, ctx.session);
  ctx.session.onboardingPhotoEdit = false;

  await sendPhotoStagePrompt(
    ctx.api,
    ctx.chat.id,
    BigInt(ctx.from!.id),
    ctx.session,
    ctx.session.pendingPhotos.length,
    sessionHasProfileVideo(ctx.session),
    env.TICKET_FEATURE_ENABLED,
  );
}
