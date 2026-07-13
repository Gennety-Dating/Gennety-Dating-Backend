/**
 * Venue-change "wish card" (PRODUCT_SPEC §3.7b v2 — the she-asks-him-to-pay
 * moment): a rendered PNG carrying her polaroid photo over a duotone hero of
 * the agreed venue, sent to the male with the pay / not-this-time buttons.
 *
 * The layout IS the date card (services/date-card) — same composition, same
 * brand chrome, rendered in HIS theme/language — with the wish-specific
 * headline. Like the date card's brand slogan, the line is a fixed English
 * brand-voice string across all locales.
 *
 * Returns `null` on ANY failure — the caller (offerPartnerPay) degrades to a
 * text card, so the offer flow never wedges on a render hiccup.
 */

import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { renderDateCard, type CardTheme } from "./date-card/index.js";

/**
 * Fixed English brand-voice headline (mirrors `dateCardSlogan`'s policy). Split
 * onto two lines: as one line the 78px headline runs under the butterfly mark
 * top-right — two short lines clear it, and the last line takes the accent.
 */
const WISH_SLOGAN = "Her pick.\nYour move.";

const USER_SELECT = {
  id: true,
  firstName: true,
  language: true,
  theme: true,
  profile: { select: { photos: true } },
} as const;

export async function renderVenueWishCard(
  api: Api<RawApi>,
  matchId: string,
): Promise<Buffer | null> {
  try {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        agreedTime: true,
        venueChangeName: true,
        venueChangeAddress: true,
        venueChangePhotoUrl: true,
        venueChangePhotoName: true,
        venueChangeProposerId: true,
        userA: { select: USER_SELECT },
        userB: { select: USER_SELECT },
      },
    });
    if (!match?.venueChangeName || !match.agreedTime) return null;

    const her =
      match.venueChangeProposerId === match.userA.id ? match.userA : match.userB;
    const him = her.id === match.userA.id ? match.userB : match.userA;

    return await renderDateCard(
      {
        partnerFirstName: her.firstName ?? "",
        partnerPhotoRef: her.profile?.photos?.[0] ?? null,
        venueName: match.venueChangeName,
        venueAddress: match.venueChangeAddress ?? "",
        venuePhotoUrl: match.venueChangePhotoUrl,
        venuePhotoName: match.venueChangePhotoName,
        agreedTime: match.agreedTime,
        language: (him.language ?? "en") as Language,
        theme: (him.theme ?? "dark") as CardTheme,
        slogan: WISH_SLOGAN,
      },
      { blur: false },
      api,
    );
  } catch (err) {
    console.warn("[venue-wish-card] render failed:", err);
    return null;
  }
}
