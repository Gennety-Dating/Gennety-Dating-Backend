import satori from "satori";
import { butterflyPng, type ButterflyMark } from "../match-card/collage.js";
import { cardFonts } from "../card-fonts.js";
import { grainPng, svgToPng } from "./image.js";
import { buildCardElement, CARD_W, CARD_H, type CardTheme } from "./template.js";
import { resolveCreditPlacement } from "./credit-placement.js";

/**
 * Date-card composition from ready image bytes: no Telegram, no storage, no
 * Places. `renderDateCard` resolves the photos and calls this; the offline
 * preview does the same with local files, so what is reviewed is what ships.
 *
 * Throws on a render failure — the caller owns the "never wedge scheduling"
 * fallback.
 */

export interface ComposeDateCardInput {
  /** Partner photo PNG (already blurred for the share copy). */
  partnerPhoto: Buffer | null;
  /** Venue photo PNG, already duotone-treated and cut to the hero box. */
  venuePhoto: Buffer | null;
  venueName: string;
  venueAddress: string;
  /** Headline; split on `\n` into stacked lines, last line accented. */
  slogan: string;
  theme: CardTheme;
  /** Partner's first name — not printed today, kept for the template input. */
  partnerName?: string;
}

/** Full-card film-grain tile, generated once and reused for every render. */
let cachedGrain: Buffer | null = null;
function grainTile(): Buffer {
  if (!cachedGrain) cachedGrain = grainPng(CARD_W, CARD_H, 9);
  return cachedGrain;
}

/**
 * Brand butterfly mark, rasterized once and reused for every render. The
 * burgundy radial gradient is baked into `butterfly-logo.svg`, so no tint is
 * applied here. Shared with the match-card renderer.
 */
let cachedLogo: ButterflyMark | null | undefined;
async function loadLogo(): Promise<ButterflyMark | null> {
  if (cachedLogo !== undefined) return cachedLogo;
  cachedLogo = await butterflyPng(600);
  return cachedLogo;
}

export async function composeDateCard(input: ComposeDateCardInput): Promise<Buffer> {
  const element = buildCardElement({
    partnerName: input.partnerName ?? "",
    partnerPhoto: input.partnerPhoto,
    venuePhoto: input.venuePhoto,
    // The dark film grain would dirty the cream light card — skip it there.
    grain: input.theme === "light" ? null : grainTile(),
    // Brand marks are best-effort; absent → the card renders without them.
    logo: await loadLogo(),
    venueName: input.venueName,
    venueAddress: input.venueAddress,
    // Beside the address when it fits, on the photo when it does not — the
    // measurement lives next to the layout constants it depends on.
    creditPlacement: resolveCreditPlacement(input.venueAddress),
    slogan: input.slogan,
    theme: input.theme,
  });
  const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
    width: CARD_W,
    height: CARD_H,
    fonts: cardFonts(),
  });
  return await svgToPng(svg, CARD_W);
}
