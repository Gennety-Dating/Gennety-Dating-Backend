import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Api, RawApi } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import { t, type Language } from "@gennety/shared";
import { downloadProfileImage } from "../storage.js";
import { butterflyPng, type ButterflyMark } from "../match-card/collage.js";
import { blurFacesInPhoto } from "./face-blur.js";
import { toPngBuffer, duotonePng, grainPng } from "./image.js";
import { resolveVenuePhoto } from "./photo-source.js";
import { buildCardElement, CARD_W, CARD_H, type CardNode, type CardTheme } from "./template.js";
import { resolveCreditPlacement } from "./credit-placement.js";

/**
 * Date-card renderer (PRODUCT_SPEC.md §3.7). Produces a shareable PNG for a
 * fully `scheduled` date. Two renders share one layout:
 *   - private card (`blur: false`) — real partner face, sent screenshot/
 *     forward-protected;
 *   - share card (`blur: true`) — partner's face pixelated so it can leave the
 *     platform.
 *
 * `renderDateCard` never throws: it returns `null` on any failure so callers
 * fall back to the plain-text scheduled DM (scheduling must never wedge).
 */

export interface DateCardInput {
  /** The *partner* shown on this card (recipient sees the other person). */
  partnerFirstName: string;
  /** First profile photo of the partner (Telegram file_id or Supabase path). */
  partnerPhotoRef: string | null;
  venueName: string;
  venueAddress: string;
  /** Google Places photo resource name — the single venue-imagery source. */
  venuePhotoName: string | null;
  agreedTime: Date;
  language: Language;
  /** Recipient's chosen theme — drives the card's light/dark chrome. */
  theme: CardTheme;
  /**
   * Headline override. The date card uses the brand `dateCardSlogan` line;
   * the venue-change wish card reuses this exact layout with its own line.
   */
  slogan?: string;
}

export interface RenderDateCardOptions {
  /** When true, the partner's face is blurred for an off-platform share copy. */
  blur: boolean;
  /**
   * A venue photo already prepared by `prepareVenuePhoto`. Both sides of a
   * match show the SAME venue, so the caller that renders two cards resolves
   * it once and hands the result to both — see that function for why sharing
   * it is a correctness fix and not just a saving.
   *
   * `undefined` means "resolve it yourself" (the share copy, the My Date hub
   * and the venue wish card each render one card and keep that path).
   * A Buffer or an explicit `null` means "already decided, do not re-fetch".
   */
  venuePhoto?: Buffer | null;
}

type SatoriFonts = Parameters<typeof satori>[1]["fonts"];
let cachedFonts: SatoriFonts | null = null;

function loadFonts(): SatoriFonts {
  if (cachedFonts) return cachedFonts;
  const read = (file: string) =>
    readFileSync(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)));
  const archivoBlack = read("ArchivoBlack-Regular.ttf");
  cachedFonts = [
    { name: "Roboto", data: read("Roboto-Regular.ttf"), weight: 400, style: "normal" },
    { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500, style: "normal" },
    { name: "Roboto", data: read("Roboto-Bold.ttf"), weight: 700, style: "normal" },
    // Archivo Black is a single heavy weight — register it under 400 and 700.
    { name: "Archivo Black", data: archivoBlack, weight: 400, style: "normal" },
    { name: "Archivo Black", data: archivoBlack, weight: 700, style: "normal" },
  ];
  return cachedFonts;
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

/**
 * Fetch the venue's Places photo and duotone it into the brand palette, ready
 * to drop into the card. Returns `null` when there is no usable photo — the
 * template then falls back to its branded gradient.
 *
 * **Call this ONCE per match, before rendering, when two cards are coming.**
 * Both sides show the same venue, so doing it per side fetched the same image
 * twice (two billed Places media requests per date) and duotoned it twice —
 * but the real cost was correctness, and it is worth stating because the
 * failure is invisible from the code:
 *
 * `Resvg.render()`, `satori`, `duotonePng` and `toPngBuffer` are synchronous
 * native work on the main thread. `deliverScheduledConfirmation` renders both
 * cards under one `Promise.all`, so while side A rasterizes, the event loop is
 * blocked — and side B's in-flight fetch cannot progress, while its
 * `AbortSignal.timeout` keeps counting in WALL-CLOCK time. Measured on a real
 * match: the fetch takes ~2.5s on a free loop and returns `null` when the loop
 * is blocked for 9s; one card alone rasterizes in ~45s, so the 8s budget never
 * stood a chance. Both delivered cards lost their venue photo and fell back to
 * the gradient, which reads exactly like a venue that has no picture.
 *
 * Resolving here, before any rasterize starts, is what puts the fetch back on a
 * free loop. Raising the timeout would not: the loop is blocked for far longer
 * than any sane budget, and a bigger number would only make the eventual
 * failure slower.
 */
export async function prepareVenuePhoto(
  venuePhotoName: string | null,
): Promise<Buffer | null> {
  const raw = await resolveVenuePhoto(venuePhotoName);
  if (!raw) return null;
  // Duotone into the brand palette so a stock Places photo reads as part of the
  // card; a plain PNG, then the gradient, are the fallbacks.
  return (
    (await duotonePng(raw.buffer, "#1C0710", "#F7E7EB", 1000, 690, 0.7)) ??
    (await toPngBuffer(raw.buffer))
  );
}

export async function renderDateCard(
  input: DateCardInput,
  opts: RenderDateCardOptions,
  api: Api<RawApi>,
): Promise<Buffer | null> {
  // 1. Partner photo (blurred for share). A blur that fails must never fall
  //    back to the clear original — abort the whole card instead.
  let partnerPhoto: Buffer | null = null;
  if (input.partnerPhotoRef) {
    const downloaded = await downloadProfileImage(input.partnerPhotoRef, api);
    if (downloaded) {
      // Normalize to real PNG so the data URI's `image/png` mime is honest
      // (Telegram photos are JPEG). The blur path already re-encodes via canvas.
      partnerPhoto = opts.blur
        ? await blurFacesInPhoto(downloaded)
        : await toPngBuffer(downloaded);
      // Blur that can't be produced must never leak the clear original.
      if (opts.blur && !partnerPhoto) return null;
    }
  }

  // 2. Venue photo — either handed in ready (both sides of one match share it)
  //    or resolved here for a single-card caller.
  const venuePhoto =
    opts.venuePhoto !== undefined
      ? opts.venuePhoto
      : await prepareVenuePhoto(input.venuePhotoName);

  // Brand logo (best-effort; absent → no logo, never blocks the render).
  const logo = await loadLogo();

  // 3. Compose + rasterize.
  try {
    const element = buildCardElement({
      partnerName: input.partnerFirstName,
      partnerPhoto,
      venuePhoto,
      // The dark film grain would dirty the cream light card — skip it there.
      grain: input.theme === "light" ? null : grainTile(),
      logo,
      venueName: input.venueName,
      venueAddress: input.venueAddress,
      // Beside the address when it fits, on the photo when it does not — the
      // measurement lives next to the layout constants it depends on.
      creditPlacement: resolveCreditPlacement(input.venueAddress),
      slogan: input.slogan ?? t(input.language, "dateCardSlogan"),
      theme: input.theme,
    });

    const svg = await satori(element as unknown as Parameters<typeof satori>[0], {
      width: CARD_W,
      height: CARD_H,
      fonts: loadFonts(),
    });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: CARD_W } })
      .render()
      .asPng();
    return Buffer.from(png);
  } catch (err) {
    console.warn("[date-card] render failed:", err);
    return null;
  }
}

/** The "Share this card" inline button appended to the private card. */
export function buildShareButton(matchId: string, language: Language): InlineKeyboardButton {
  return { text: t(language, "matchScheduledBtnShare"), callback_data: `datecard:share:${matchId}` };
}

export type { CardNode, CardTheme };
