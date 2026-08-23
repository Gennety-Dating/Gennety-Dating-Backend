/**
 * Date-card layout, expressed as a plain satori element tree (no JSX, so the
 * bot's tsconfig needs no React/JSX support).
 *
 * Aesthetic ("Partiful-glow", finalized 2026-06-20; recolored to the burgundy /
 * black / white design system 2026-07-09): a near-black card with two faint
 * burgundy corner discs, a soft burgundy glow behind the hero photo, and faint
 * film grain; a wide duotone venue photo as the hero; an
 * overlapping tilted polaroid of the partner; a bold Archivo Black headline
 * slogan whose last line is the burgundy accent; a compact venue detail block.
 * The "Gennety" wordmark sits top-left and the brand butterfly logo sits
 * top-right (slightly tilted, nudged toward the edge like the polaroid). The
 * "made with Gennety" credit sits beside the venue address when the address
 * leaves room for it, and is stamped into the hero photo's lower-left corner
 * when it does not — the caller resolves which (`credit-placement.ts`) and this
 * file only renders the branch it is handed.
 *
 * NOTE: rendered text is kept emoji-free on purpose — the bundled fonts have no
 * color-emoji glyphs and satori would drop them. Emoji live only in the
 * Telegram caption, not inside the PNG.
 *
 * Photo treatment (duotone of the venue, grain tile) is done upstream in
 * `index.ts` with @napi-rs/canvas and passed in as ready PNG buffers; this file
 * is pure layout.
 */

export const CARD_W = 1080;
export const CARD_H = 1350;
/** Card's own horizontal padding; `CONTENT_W` is derived from it. */
export const CARD_PADDING_X = 64;

/** The credit's text and size, exported so it can be measured before a render. */
export const CREDIT_TEXT = "made with Gennety";
export const CREDIT_FONT_PX = 22;
export const ADDRESS_FONT_PX = 30;

const BURGUNDY = "#8B253B";

/**
 * Where the credit goes on one card. Resolved by `credit-placement.ts`, which
 * measures the address; `addressWidth` is the fixed width the address line is
 * clipped to in order to reserve the credit's room.
 */
export type CreditPlacement =
  | { kind: "photo" }
  | { kind: "inline"; addressWidth: number };

export type CardTheme = "light" | "dark";

interface Palette {
  bg: string;
  ink: string;
  muted: string;
}

/** Card chrome colors per theme (the burgundy accent + photos are theme-agnostic). */
function palette(theme: CardTheme): Palette {
  return theme === "light"
    ? { bg: "#F5F5F5", ink: "#1D1D1D", muted: "#6B6670" }
    : { bg: "#030303", ink: "#F2EFF7", muted: "#8E8895" };
}

/** Minimal satori-compatible node (cast to satori's ReactNode at the call site). */
export interface CardNode {
  type: string;
  props: {
    style?: Record<string, unknown>;
    children?: (CardNode | string)[] | CardNode | string;
    [key: string]: unknown;
  };
}

/**
 * Rasterized brand mark (butterfly) with its real, alpha-trimmed pixel size, so
 * the layout can derive a non-squished display box from `width/height`.
 */
export interface LogoMark {
  png: Buffer;
  width: number;
  height: number;
}

function el(
  type: string,
  style: Record<string, unknown>,
  children?: (CardNode | string)[] | CardNode | string,
  extra?: Record<string, unknown>,
): CardNode {
  return { type, props: { style, ...(extra ?? {}), ...(children !== undefined ? { children } : {}) } };
}

function dataUri(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

export interface CardElementInput {
  partnerName: string;
  /** Partner photo PNG (already blurred for the share copy). */
  partnerPhoto: Buffer | null;
  /** Venue photo PNG, already duotone-treated and cover-fit upstream. */
  venuePhoto: Buffer | null;
  /** Film-grain overlay tile (full-card PNG). Optional. */
  grain: Buffer | null;
  /** Brand butterfly mark (rasterized, alpha-trimmed). Sits top-right. Optional. */
  logo: LogoMark | null;
  venueName: string;
  venueAddress: string;
  /** Headline slogan; split on `\n` into stacked lines, last line accented. */
  slogan: string;
  /** Recipient's chosen theme — drives the light/dark chrome palette. */
  theme: CardTheme;
  /** Resolved by `resolveCreditPlacement` — this file does not measure. */
  creditPlacement: CreditPlacement;
}

export function buildCardElement(input: CardElementInput): CardNode {
  const p = palette(input.theme);
  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: `${CARD_W}px`,
      height: `${CARD_H}px`,
      padding: `70px ${CARD_PADDING_X}px`,
      backgroundColor: p.bg,
      fontFamily: "Roboto",
      color: p.ink,
    },
    [
      ...(input.grain
        ? [
            el(
              "img",
              {
                position: "absolute",
                top: 0,
                left: 0,
                width: `${CARD_W}px`,
                height: `${CARD_H}px`,
                opacity: 0.5,
              },
              undefined,
              { src: dataUri(input.grain) },
            ),
          ]
        : []),
      header(p),
      heroSlogan(input.slogan, p),
      venueSection(input),
      el("div", { display: "flex", flexGrow: 1, minHeight: "0px" }),
      detailsSection(input, p),
      ...(input.logo ? [logoImg(input.logo)] : []),
    ],
  );
}

/**
 * Brand butterfly mark, top-right and slightly tilted. Width is fixed and the
 * height is derived from the mark's real aspect ratio so it never squishes.
 */
function logoImg(logo: LogoMark): CardNode {
  const displayW = 300;
  const displayH = Math.round(displayW * (logo.height / logo.width));
  return el(
    "img",
    {
      position: "absolute",
      top: "68px",
      right: "40px",
      width: `${displayW}px`,
      height: `${displayH}px`,
      transform: "rotate(13deg)",
    },
    undefined,
    { src: dataUri(logo.png) },
  );
}

function header(p: Palette): CardNode {
  return el(
    "div",
    {
      display: "flex",
      alignItems: "center",
      marginBottom: "34px",
    },
    [
      el(
        "div",
        { display: "flex", fontFamily: "Archivo Black", fontSize: "36px", color: p.ink },
        "Gennety",
      ),
    ],
  );
}

/** Archivo Black headline; the final line is the burgundy accent. */
function heroSlogan(slogan: string, p: Palette): CardNode {
  const raw = slogan.split("\n");
  const lines = raw.map((line, i) =>
    el("div", { display: "flex", color: i === raw.length - 1 ? BURGUNDY : p.ink }, line),
  );
  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      fontFamily: "Archivo Black",
      fontSize: "78px",
      lineHeight: 1.0,
      letterSpacing: "-2px",
      marginBottom: "10px",
    },
    lines,
  );
}

function venueSection(input: CardElementInput): CardNode {
  const venueImage = input.venuePhoto
    ? el("img", { width: "100%", height: "100%", objectFit: "cover" }, undefined, {
        src: dataUri(input.venuePhoto),
      })
    : el("div", {
        display: "flex",
        width: "100%",
        height: "100%",
        backgroundImage: `linear-gradient(135deg, #3A0E1C, ${BURGUNDY})`,
      });

  const partnerInner = input.partnerPhoto
    ? el("img", { width: "300px", height: "360px", objectFit: "cover", borderRadius: "4px" }, undefined, {
        src: dataUri(input.partnerPhoto),
      })
    : el("div", {
        display: "flex",
        width: "300px",
        height: "360px",
        borderRadius: "4px",
        backgroundColor: "#1A0A0F",
      });

  return el(
    "div",
    {
      display: "flex",
      position: "relative",
      width: "100%",
      height: "726px",
      marginTop: "8px",
      marginBottom: "8px",
    },
    [
      // Glow behind the hero photo.
      el("div", {
        display: "flex",
        position: "absolute",
        left: "180px",
        top: "90px",
        width: "680px",
        height: "470px",
        borderRadius: "999px",
        backgroundImage: `radial-gradient(closest-side, ${BURGUNDY}66, rgba(139,37,59,0))`,
      }),
      // Hero venue photo — wide, shifted left, small gap from the headline, long.
      el(
        "div",
        {
          display: "flex",
          position: "absolute",
          left: "-44px",
          top: "22px",
          width: "1000px",
          height: "690px",
          borderRadius: "30px",
          overflow: "hidden",
          boxShadow: "0 34px 80px rgba(0,0,0,0.6)",
        },
        // When the credit is on the photo it lives INSIDE this box, so the
        // box's own `overflow: hidden` + 30px radius clip it to the photograph.
        input.creditPlacement.kind === "photo" ? [venueImage, photoCredit()] : [venueImage],
      ),
      // Partner polaroid — lower-right, tilted, no caption text. Wide bottom
      // frame margin for an authentic polaroid look.
      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          position: "absolute",
          right: "-26px",
          bottom: "-36px",
          padding: "16px 16px 72px 16px",
          borderRadius: "10px",
          backgroundColor: "#FFFFFF",
          transform: "rotate(7deg)",
          boxShadow: "0 26px 64px rgba(0,0,0,0.5)",
        },
        [partnerInner],
      ),
    ],
  );
}

/**
 * Bottom block: venue name over its address, with the credit beside the address
 * when it fits (`creditPlacement`).
 *
 * Both lines are single-line and ellipsized, and that is structural rather than
 * styling. The block sits at the end of a fixed 1350px card behind a `flexGrow`
 * spacer, and the spacer is all the slack there is — measured at 46px on the
 * 3-line date-card slogan, i.e. ONE extra wrapped line (40px) and nothing more.
 * A venue whose name or address wrapped would push this block up into the
 * partner polaroid, so the card's silhouette would change with the venue's
 * paperwork. Measured over the real curated catalog (333 distinct venues across
 * the three launched-city files), the full content width holds the address for
 * 98.5% of them, so the ellipsis is the long tail rather than the common case.
 * Nothing is lost when it fires: the scheduled DM prints the name and the full
 * address verbatim in its caption one line below the photo, and the exact place
 * rides the "Open in Maps" button.
 *
 * Only the ADDRESS shares its line with the credit; the venue name keeps the
 * full content width in both branches. That is deliberate rather than
 * incidental — at their own sizes the name outgrows the address in the tail
 * (p90 927px against 799px), so putting the whole COLUMN beside the credit, as
 * the pre-2026-08-20 layout did, would have cut the inline branch from 79.6% of
 * that catalog to 59.8% and started ellipsizing names that are fine today.
 * Within Kyiv alone — the one launched market — the address goes inline for
 * 95.6% of venues, so the photo corner is genuinely the long tail there.
 */
function detailsSection(input: CardElementInput, p: Palette): CardNode {
  /** One clipped line: needs the width bound AND `overflow` for satori to ellipsize. */
  const line = (text: string, width: string, style: Record<string, unknown>): CardNode =>
    el(
      "div",
      {
        display: "flex",
        width,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        ...style,
      },
      text,
    );

  const inline = input.creditPlacement.kind === "inline" ? input.creditPlacement : null;

  const address = line(
    input.venueAddress,
    // A FIXED width in the inline branch, and this is what makes the credit's
    // box independent of the address. Measured on the real render rather than
    // assumed: with `100%` here the row does NOT overflow the card (yoga shrinks
    // both children), it degrades quietly instead — the address ellipsizes ~70px
    // early, the credit is squeezed from 188px to 157px and wraps onto two
    // lines, and the row grows 40px -> 58px, which pushes the whole block up
    // into the polaroid. So this is not the 2026-08-20 off-canvas failure in
    // miniature; it is the silhouette drift the block's own comment forbids.
    inline ? `${inline.addressWidth}px` : "100%",
    { fontFamily: "Roboto", fontSize: `${ADDRESS_FONT_PX}px`, color: p.muted },
  );

  // The credit is a plain muted line here, not the scrimmed pill it wears on
  // the photo: this ground is the card's own background, so it needs no scrim
  // and a chip floating on cream would read as pasted on.
  const addressRow = inline
    ? el("div", { display: "flex", width: "100%", marginTop: "6px", alignItems: "flex-end" }, [
        address,
        el(
          "div",
          {
            display: "flex",
            marginLeft: "auto",
            fontFamily: "Roboto",
            fontSize: `${CREDIT_FONT_PX}px`,
            color: p.muted,
          },
          CREDIT_TEXT,
        ),
      ])
    : el("div", { display: "flex", width: "100%", marginTop: "6px" }, [address]);

  return el(
    "div",
    { display: "flex", flexDirection: "column", width: "100%" },
    [
      line(input.venueName, "100%", {
        fontFamily: "Archivo Black",
        fontSize: "54px",
        color: p.ink,
      }),
      addressRow,
    ],
  );
}

/**
 * "made with Gennety", stamped into the hero photo's lower-left corner.
 *
 * It used to be a flex sibling of the venue name/address, right-aligned on the
 * address's baseline — and yoga defaults `flex-shrink` to 0, so a long address
 * did not yield: it grew until it hit the content width and laid the credit out
 * AFTER itself, off the canvas. Measured on the reported card (a 57-character
 * Kyiv address, around p75 of the real catalog): the credit's right edge landed
 * at x=1127 on a 1080px card — 47px past the card's own edge, hard-clipped.
 * Anything past ~45 characters did it, which is over half the catalog.
 *
 * Absolute positioning is the fix rather than a shrink factor: an element out
 * of the flow cannot be pushed by ANY text length, so the failure is gone by
 * construction instead of by tuning. It also hands the address block the full
 * content width back, which is what keeps ~88% of real addresses on one line.
 *
 * Placement is deliberate on two counts. The photo's lower-LEFT is the one
 * corner the tilted polaroid (lower-right) never reaches, and the inset aligns
 * the credit with the card's own left text column — the wordmark and the venue
 * name — so it reads as set, not as dropped.
 *
 * This is the FALLBACK branch, reached when the address is too long to leave
 * the credit room (2026-08-23; it was unconditional between 2026-08-20 and
 * then). What changed is not the geometry but that "does it fit" became
 * answerable: `credit-placement.ts` measures the address in the same font file
 * satori is handed. What did NOT change is why absolute positioning is used
 * here rather than a shrink factor — an element out of the flow cannot be
 * pushed by any text length.
 */
function photoCredit(): CardNode {
  return el(
    "div",
    {
      display: "flex",
      position: "absolute",
      left: "44px",
      bottom: "26px",
      // A duotone photo runs from near-black (#1C0710) to cream (#F7E7EB), so
      // neither a light nor a dark credit is legible on its own — and a text
      // shadow does not rescue it either: rendered over the cream end, white
      // text with a soft dark shadow is barely readable, which is why this is a
      // scrim rather than the subtler treatment. A fill, not an outline, per the
      // design system. The 0.6 is measured on the real render, not picked: over
      // the cream end the scrim resolves to rgb(100,96,96) and carries the 0.95
      // white at 5.79:1 — above WCAG AA for body text — while over the dark end
      // it is 17.99:1 and the pill itself all but disappears, reading as a
      // watermark rather than a chip. The first pass at 0.46 rendered the cream
      // case as a muddy grey blob, which is how the number was arrived at.
      paddingLeft: "18px",
      paddingRight: "18px",
      paddingTop: "8px",
      paddingBottom: "10px",
      borderRadius: "999px",
      backgroundColor: "rgba(3,3,3,0.6)",
      fontFamily: "Roboto",
      fontSize: `${CREDIT_FONT_PX}px`,
      color: "rgba(255,255,255,0.95)",
    },
    CREDIT_TEXT,
  );
}
