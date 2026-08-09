import { GrammyError, type Api, type RawApi } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import {
  buildStatusBannerKeyboard,
  buildStatusBannerView,
  statusBannerRenderCache,
} from "./status-banner.js";
import { loadBannerStages } from "./status-banner-stage.js";
import { isMarketPending } from "../handlers/menu/city-switch.js";

/**
 * Re-render the pinned status banner for the given users RIGHT NOW, instead of
 * waiting for the next `status-timer` tick.
 *
 * The banner names the venue in its body (PRODUCT_SPEC §2.1 mode 2), and until
 * this existed the once-a-minute tick was its only writer — so a settled venue
 * change left the pin naming the OLD place for up to a minute while every other
 * surface (the updated venue cards, the My Date hub) was already correct. On the
 * one screen the pair is looking at in that moment, a minute reads as "it just
 * doesn't update".
 *
 * Deliberately narrow, in three ways:
 *
 * - **It only ever EDITS a banner that already exists.** A user with no
 *   `statusMessageId` is left to the tick, which owns creation, pinning and the
 *   compensation path when Telegram accepts a message the database then can't
 *   record. Duplicating that here would be a second way to create a pin.
 * - **It never records failures or clears pointers.** Recovery — the missing
 *   message, the unreachable chat, the backoff ladder — belongs to the tick,
 *   which will reach the same user within a minute anyway. A push that tried to
 *   heal state would race the very worker that owns it.
 * - **It cannot throw.** Every caller is a settled, irreversible product step;
 *   a cosmetic re-render must never be able to fail one.
 */
export async function refreshStatusBanners(
  api: Api<RawApi>,
  userIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  try {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (ids.length === 0) return;

    // Same filter the tick applies: a real Telegram chat we can reach
    // (`platform` is the canonical reachability check — a positive id alone is
    // not, see ARCHITECTURE.md → `users`), active, already carrying a banner.
    const users = await prisma.user.findMany({
      where: {
        id: { in: ids },
        status: "active",
        telegramId: { gt: 0n },
        platform: { in: ["telegram", "both"] },
        statusMessageId: { not: null },
      },
      select: {
        id: true,
        telegramId: true,
        language: true,
        statusMessageId: true,
        profile: { select: { homeCityKey: true, homeCity: true } },
      },
    });
    if (users.length === 0) return;

    const stageByUser = await loadBannerStages(
      users.map((user) => user.id),
      now,
    );

    for (const user of users) {
      const messageId = user.statusMessageId;
      if (messageId === null) continue;

      const cacheKey = String(user.telegramId);
      const language: Language = user.language ?? "en";
      const stage = stageByUser.get(user.id);
      const marketPending = isMarketPending(user.profile?.homeCityKey)
        ? { city: user.profile?.homeCity ?? user.profile?.homeCityKey ?? null }
        : undefined;
      const view = buildStatusBannerView(language, {
        now,
        ...(stage ? { stage } : {}),
        ...(marketPending ? { marketPending } : {}),
      });

      if (statusBannerRenderCache.get(cacheKey) === view.signature) continue;

      try {
        await api.editMessageText(
          Number(user.telegramId),
          messageId,
          view.text,
          { reply_markup: buildStatusBannerKeyboard(view) },
        );
        statusBannerRenderCache.set(cacheKey, view.signature);
      } catch (error) {
        // The body already matches — the tick beat us to it by a hair. Record
        // it so the next tick doesn't repeat the same wasted call.
        if (
          error instanceof GrammyError &&
          error.description.toLowerCase().includes("message is not modified")
        ) {
          statusBannerRenderCache.set(cacheKey, view.signature);
          continue;
        }
        console.warn(
          `[status-banner] push refresh failed for ${user.telegramId}:`,
          (error as Error).message,
        );
      }
    }
  } catch (error) {
    console.warn("[status-banner] push refresh failed:", (error as Error).message);
  }
}
