import { t, type Language } from "@gennety/shared";
import { PUSH_PHOTO_URL_TTL_MS, partnerPhotoUrls } from "../public/partner-photos.js";
import { sendPushToUser } from "./push.js";
import { pushReachable } from "./telegram-reach.js";

/**
 * The Thursday drop notification for the native app (iOS task §5.3) — the one
 * push in the product that carries a picture.
 *
 * **It did not exist.** `pitch.ts` skips anyone it cannot address as a Telegram
 * chat, with a comment saying their pitch "goes via the push path". That path
 * was never built: an app-only user was told about the single most important
 * event of their week by nothing at all, and found out whenever they happened
 * to open the app next. Same class of hole as the ticket gate, the calendar and
 * the proxy chat before it — the mechanic existed on one surface only.
 *
 * **What it carries is deliberately little.** The lock screen is public — the
 * reason the decision Live Activity shows no name, no age and not even a
 * silhouette (§4.1) — so the copy names nobody, and the only thing about the
 * partner is a photo the client's Notification Service Extension blurs before
 * it is ever drawn. Blur is the product's language for "not yours to see yet"
 * (DESIGN.md), and it is what makes a picture admissible on that surface at
 * all. The blur is not rendered here: the bytes leave untouched and come back
 * blurred on the device, because a blurred copy on our disk would be a second
 * artifact to keep in step with the first.
 *
 * The picture is optional by design. A partner with no photos, an expired
 * signature, a phone that cannot reach us — each ends with a plain
 * notification rather than a missing one, because the words are the part that
 * has to arrive.
 */

/** Matches the client's `PushCategories`/`PushPayload` type strings. */
export const MATCH_DROP_PUSH_TYPE = "match.proposed";

interface DropSide {
  id: string;
  language: string | null;
  platform?: string | null;
  profile: { photos: string[] } | null;
}

export interface MatchDrop {
  id: string;
  userA: DropSide;
  userB: DropSide;
}

/**
 * Notify both participants of a freshly dispatched proposal on the app rail.
 * Never throws and never rejects: pitch delivery is not allowed to fail
 * because a push did.
 *
 * Takes the row the caller already loaded instead of an id, and does not
 * re-check `status`. Both are deliberate: `sendMatchProposal` reads the match,
 * gates on `proposed` and starts this in the same tick, so a second query
 * would re-answer a question asked microseconds earlier — and it would make
 * this function's behaviour depend on the *order* of the caller's database
 * calls, which is precisely how a stubbed test starts lying.
 */
export async function sendMatchDropPush(match: MatchDrop): Promise<void> {
  await Promise.all([
    notifySide(match.id, match.userA, match.userB),
    notifySide(match.id, match.userB, match.userA),
  ]);
}

async function notifySide(
  matchId: string,
  viewer: DropSide,
  partner: DropSide,
): Promise<void> {
  if (!pushReachable(viewer)) return;
  const lang = (viewer.language ?? "en") as Language;
  // Only the first photo. The pitch screen fetches the rest with a JWT once
  // the app is open; a notification shows one image and no more.
  const hasPhoto = (partner.profile?.photos.length ?? 0) > 0;
  const image = hasPhoto
    ? partnerPhotoUrls(viewer.id, matchId, 1, PUSH_PHOTO_URL_TTL_MS)[0]
    : undefined;

  await sendPushToUser(viewer.id, {
    title: t(lang, "matchDropPushTitle"),
    body: t(lang, "matchDropPushBody"),
    data: {
      type: MATCH_DROP_PUSH_TYPE,
      matchId,
      ...(image ? { image } : {}),
    },
    // The dispatcher retries a whole match when either Telegram side throws,
    // and this rail rides along with it. One drop is one notification.
    collapseId: `${MATCH_DROP_PUSH_TYPE}.${matchId}`,
  }).catch((err: unknown) => {
    console.warn(
      `[match-drop-push] failed for ${viewer.id}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  });
}
