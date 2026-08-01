import { InputFile, type Api, type RawApi } from "grammy";
import { GrammyError } from "grammy";
import { t, type Language, type TranslationKey } from "@gennety/shared";
import type { MatchExpiry, SideClassification } from "./match-expiry.js";
import { isTelegramTarget } from "../utils/telegram-target.js";
import { sendRematchOfferIfEligible } from "../handlers/matching/rematch.js";
import {
  renderExpiryCard,
  type ExpiryCardTheme,
  type ExpiryCardVariant,
} from "./expiry-card.js";

/**
 * Rate-limited dispatch of post-expiry DMs. Mirrors `dispatchMatches` /
 * `sendNoMatchNotices`: sequential sends with a fixed delay so we stay under
 * Telegram's per-user + per-second rate limits.
 *
 * For each expired match the caller hands us, we:
 *   1. Overwrite the pitch DM (if it had a message_id) with a final
 *      "expired" notice and strip the Accept/Decline keyboard, so a user
 *      reopening the chat doesn't tap a dead button.
 *   2. Send the appropriate notice per side:
 *        - silent + first offense (`offenseCount === 1`) →
 *          `matchExpiredSilentWarning` (no penalty, just a warning).
 *        - silent + repeat (`offenseCount >= 2`) →
 *          `matchExpiredSilentPenalty` ("rating lowered").
 *        - responder → `matchExpiredPeerIgnored` ("your match didn't
 *          reply, see you in the next drop").
 *
 * Since 2026-08-01 that notice is an **expiry card** (PRODUCT_SPEC §3.4):
 * a PNG carrying what happened, captioned with only the consequence, so
 * nothing is said twice. This was the driest surface in the product — a bare
 * `sendMessage` on one of its few genuinely emotional beats.
 *
 * The card is best-effort by construction. `renderExpiryCard` never throws and
 * returns null on any failure, and a caption over Telegram's 1024-char ceiling
 * declines the card too; either way we fall back to `composeBody`, the exact
 * plain text this function sent before. No sentence exists on only one branch.
 *
 * Mobile-only sides (synthetic negative `telegramId`) are skipped — the
 * Expo client renders its own state from the `proposalDeadlineAt` API
 * field, no Telegram DM exists for them.
 */

export const DEFAULT_NOTIFY_DELAY_MS = 2000;

export interface ExpiryNotifyResult {
  notified: number;
  skipped: number;
  failed: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ExpiryKey =
  | "matchExpiredSilentWarning"
  | "matchExpiredSilentPenalty"
  | "matchExpiredPeerIgnored";

function pickText(side: SideClassification): { key: ExpiryKey } {
  if (side.role === "responder") return { key: "matchExpiredPeerIgnored" };
  // First offense (offenseCount === 1) → warning. Anything beyond is the
  // penalty round. We trust the `penalised` flag rather than re-deriving
  // from the count so a failed Elo write (penalised=false even at count
  // ≥ 2) still gets the warning text instead of falsely claiming "your
  // rating has been lowered" — telling the user something we didn't do.
  if ((side.offenseCount ?? 1) <= 1 || !side.penalised) {
    return { key: "matchExpiredSilentWarning" };
  }
  return { key: "matchExpiredSilentPenalty" };
}

/**
 * Compose the final body for a silent side. If their peer had accepted
 * we prepend a "you missed a real date" line; otherwise we keep the
 * neutral warning/penalty text and reveal nothing about the peer's
 * decision (matching the blind-decision rule for the silent path).
 *
 * This is the FALLBACK text now — the card path (below) says the same things
 * split between the image and its caption. It is still the whole message
 * whenever a render fails, so no sentence is lost on that branch.
 */
function composeBody(side: SideClassification, lang: Language): string {
  const { key } = pickText(side);
  const base = t(lang, key);
  if (side.role === "silent" && side.peerAccepted === true) {
    return t(lang, "matchExpiredYouMissedDate") + base;
  }
  return base;
}

/**
 * Which card to draw (PRODUCT_SPEC §3.4). The variant tracks `pickText`, with
 * one override: a silent side whose peer had ACCEPTED gets the `missed_date`
 * card whatever the offence count, because that is the fact worth a picture.
 * The penalty is not lost — the caption still carries it, since the caption
 * follows `pickText` independently of the card.
 */
function pickCardVariant(side: SideClassification): ExpiryCardVariant {
  if (side.role === "silent" && side.peerAccepted === true) return "missed_date";
  const { key } = pickText(side);
  if (key === "matchExpiredPeerIgnored") return "peer_ignored";
  return key === "matchExpiredSilentPenalty" ? "penalty" : "expired";
}

/**
 * Caption = only what the card does NOT already say (founder decision): the
 * card states what happened, the caption adds the consequence. Keyed off
 * `pickText` rather than the card variant precisely so the `missed_date`
 * override above still carries the right consequence underneath it.
 *
 * Deliberately never claims a next-drop priority boost for the responder:
 * unlike the decline path and the §3.5c stall chain, `match-expiry.ts` does
 * not call `boostAcceptedSidePriority`, so saying so would be a promise the
 * code does not keep.
 */
function captionFor(side: SideClassification, lang: Language): string {
  const { key } = pickText(side);
  if (key === "matchExpiredPeerIgnored") return t(lang, "expiryCaptionPeerIgnored");
  return key === "matchExpiredSilentPenalty"
    ? t(lang, "expiryCaptionSilentPenalty")
    : t(lang, "expiryCaptionSilentWarning");
}

/** Telegram rejects a photo caption over 1024 chars — fall back to plain text. */
const MAX_CAPTION_CHARS = 1024;

/**
 * Spelled out rather than built by string concatenation so the keys are real
 * `TranslationKey`s: a typo or a deleted string fails the typecheck instead of
 * rendering a card with a blank headline in production.
 */
const CARD_KEYS: Record<
  ExpiryCardVariant,
  { overline: TranslationKey; headline: TranslationKey; subline: TranslationKey }
> = {
  expired: {
    overline: "expiryCardOverlineExpired",
    headline: "expiryCardHeadlineExpired",
    subline: "expiryCardSublineExpired",
  },
  penalty: {
    overline: "expiryCardOverlinePenalty",
    headline: "expiryCardHeadlinePenalty",
    subline: "expiryCardSublinePenalty",
  },
  peer_ignored: {
    overline: "expiryCardOverlinePeerIgnored",
    headline: "expiryCardHeadlinePeerIgnored",
    subline: "expiryCardSublinePeerIgnored",
  },
  missed_date: {
    overline: "expiryCardOverlineMissedDate",
    headline: "expiryCardHeadlineMissedDate",
    subline: "expiryCardSublineMissedDate",
  },
};

export async function buildCard(
  side: SideClassification,
  lang: Language,
): Promise<{ png: Buffer; caption: string } | null> {
  const caption = captionFor(side, lang);
  if (caption.length > MAX_CAPTION_CHARS) return null;

  const variant = pickCardVariant(side);
  const keys = CARD_KEYS[variant];
  const png = await renderExpiryCard({
    variant,
    overline: t(lang, keys.overline),
    headline: t(lang, keys.headline),
    subline: t(lang, keys.subline),
    // `User.theme` is non-null with a `dark` default, so anything that isn't
    // an explicit `light` is dark — including a legacy row read as null.
    theme: (side.theme === "light" ? "light" : "dark") satisfies ExpiryCardTheme,
  });
  return png ? { png, caption } : null;
}

async function clearPitchKeyboard(
  api: Api<RawApi>,
  side: SideClassification,
): Promise<void> {
  if (side.pitchMessageId == null) return;
  if (!isTelegramTarget(side.telegramId)) return;
  const lang: Language = (side.language as Language) ?? "en";
  try {
    await api.editMessageText(
      Number(side.telegramId),
      side.pitchMessageId,
      t(lang, "pitchExpired"),
      { reply_markup: { inline_keyboard: [] } },
    );
  } catch (err) {
    // 400 "message to edit not found" / 403 "bot was blocked" — log and
    // move on. The DM is dead but the user still needs the explanation
    // message, which goes through the normal `sendMessage` path below.
    if (err instanceof GrammyError) {
      console.warn(
        `[expiry-notify] keyboard clear skipped (${err.error_code}): ${err.description}`,
      );
      return;
    }
    console.warn("[expiry-notify] keyboard clear failed:", (err as Error).message);
  }
}

export async function sendExpiryNotifications(
  api: Api<RawApi>,
  matches: MatchExpiry[],
  delayMs: number = DEFAULT_NOTIFY_DELAY_MS,
): Promise<ExpiryNotifyResult> {
  let notified = 0;
  let skipped = 0;
  let failed = 0;

  // Flatten to a single ordered list so the rate-limiter paces evenly
  // across matches rather than bursting all sides of one match at once.
  const sides: SideClassification[] = matches.flatMap((m) => m.sides);

  for (let i = 0; i < sides.length; i++) {
    const side = sides[i]!;

    if (!isTelegramTarget(side.telegramId)) {
      skipped++;
      continue;
    }

    // Strip the keyboard first so a quick tap on a stale Accept/Decline
    // doesn't fire after we've sent the explanation. Sequential here is
    // fine — the edit is small and we're already paced.
    await clearPitchKeyboard(api, side);

    const lang: Language = (side.language as Language) ?? "en";
    // Card first; a render that returns null degrades to the plain-text
    // notice this function sent before the card existed. The render is pure
    // layout + rasterize (no network, no photos), so this is a cheap attempt.
    const card = await buildCard(side, lang);

    try {
      if (card) {
        await api.sendPhoto(Number(side.telegramId), new InputFile(card.png, "expiry.png"), {
          caption: card.caption,
        });
      } else {
        await api.sendMessage(Number(side.telegramId), composeBody(side, lang));
      }
      notified++;
      // Rematch offer (REMATCH_PRODUCT_SPEC.md, D4) — the second pain moment:
      // the match window closed with no date. The match is already terminal
      // (`expired`) by the time this runs, so the single-live-match eligibility
      // check inside the sender passes. Self-gating (flag, male-only, D3 limits)
      // lives there, so this is inert for anyone who can't or shouldn't buy.
      await sendRematchOfferIfEligible(api, side.userId, "failed").catch(() => {});
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[expiry-notify] ${i + 1}/${sides.length} userId=${side.userId} side=${side.side} FAILED: ${message}`,
      );
    }

    if (i < sides.length - 1) {
      await delay(delayMs);
    }
  }

  console.log(
    `[expiry-notify] done: notified=${notified} skipped=${skipped} failed=${failed}`,
  );

  return { notified, skipped, failed };
}
