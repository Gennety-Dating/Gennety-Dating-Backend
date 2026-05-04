import type { Api, RawApi } from "grammy";
import { GrammyError } from "grammy";
import { t, type Language } from "@gennety/shared";
import type { MatchExpiry, SideClassification } from "./match-expiry.js";
import { isTelegramTarget } from "../utils/telegram-target.js";

/**
 * Rate-limited dispatch of post-expiry DMs. Mirrors `dispatchMatches` /
 * `sendNoMatchNotices`: sequential sends with a fixed delay so we stay under
 * Telegram's per-user + per-second rate limits.
 *
 * For each expired match the caller hands us, we:
 *   1. Overwrite the pitch DM (if it had a message_id) with a final
 *      "expired" notice and strip the Accept/Decline keyboard, so a user
 *      reopening the chat doesn't tap a dead button.
 *   2. Send the appropriate text per side:
 *        - silent + first offense (`offenseCount === 1`) →
 *          `matchExpiredSilentWarning` (no penalty, just a warning).
 *        - silent + repeat (`offenseCount >= 2`) →
 *          `matchExpiredSilentPenalty` ("rating lowered").
 *        - responder → `matchExpiredPeerIgnored` ("your match didn't
 *          reply, see you next week").
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
 */
function composeBody(side: SideClassification, lang: Language): string {
  const { key } = pickText(side);
  const base = t(lang, key);
  if (side.role === "silent" && side.peerAccepted === true) {
    return t(lang, "matchExpiredYouMissedDate") + base;
  }
  return base;
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
    const body = composeBody(side, lang);

    try {
      await api.sendMessage(Number(side.telegramId), body);
      notified++;
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
