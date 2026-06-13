/**
 * Date-card layout, expressed as a plain satori element tree (no JSX, so the
 * bot's tsconfig needs no React/JSX support). The aesthetic is modern and
 * intentionally casual: a tilted venue photo with an overlapping polaroid of
 * the partner, loose label/value detail rows, and a quiet Gennety wordmark.
 *
 * NOTE: rendered text is kept emoji-free on purpose — the bundled Roboto fonts
 * have no color-emoji glyphs and satori would drop them. Emoji live only in the
 * Telegram caption, not inside the PNG.
 */

export const CARD_W = 1080;
export const CARD_H = 1350;

const ACCENT = "#FF5B6E";
const INK = "#2A2024";
const MUTED = "#9B8E92";
const PAPER = "#FFFFFF";

/** Minimal satori-compatible node (cast to satori's ReactNode at the call site). */
export interface CardNode {
  type: string;
  props: {
    style?: Record<string, unknown>;
    children?: (CardNode | string)[] | CardNode | string;
    [key: string]: unknown;
  };
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
  partnerPhoto: Buffer | null;
  venuePhoto: Buffer | null;
  attribution: boolean;
  venueName: string;
  venueAddress: string;
  dateText: string;
  labels: {
    tagline: string;
    when: string;
    where: string;
  };
}

export function buildCardElement(input: CardElementInput): CardNode {
  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      width: `${CARD_W}px`,
      height: `${CARD_H}px`,
      padding: "72px 64px",
      backgroundColor: "#FBF6F2",
      backgroundImage:
        "linear-gradient(160deg, #FBF6F2 0%, #F8ECEF 55%, #F6E2E8 100%)",
      fontFamily: "Roboto",
      color: INK,
    },
    [header(input.labels.tagline), venueSection(input), detailsSection(input), footer(input)],
  );
}

function header(tagline: string): CardNode {
  return el(
    "div",
    {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "36px",
    },
    [
      el(
        "div",
        { display: "flex", fontSize: "40px", fontWeight: 700, letterSpacing: "1px", color: ACCENT },
        "Gennety",
      ),
      el(
        "div",
        {
          display: "flex",
          padding: "10px 22px",
          borderRadius: "999px",
          backgroundColor: ACCENT,
          color: PAPER,
          fontSize: "22px",
          fontWeight: 600,
          letterSpacing: "3px",
        },
        tagline,
      ),
    ],
  );
}

function venueSection(input: CardElementInput): CardNode {
  const venueImage = input.venuePhoto
    ? el("img", { width: "100%", height: "100%", objectFit: "cover" }, undefined, {
        src: dataUri(input.venuePhoto),
      })
    : el(
        "div",
        {
          display: "flex",
          width: "100%",
          height: "100%",
          alignItems: "center",
          justifyContent: "center",
          backgroundImage: "linear-gradient(135deg, #FF8DA1 0%, #FF5B6E 100%)",
          color: PAPER,
          fontSize: "180px",
          fontWeight: 700,
        },
        (input.venueName[0] ?? "G").toUpperCase(),
      );

  return el(
    "div",
    { display: "flex", position: "relative", width: "100%", height: "640px", marginBottom: "60px" },
    [
      // Tilted venue photo card
      el(
        "div",
        {
          display: "flex",
          width: "100%",
          height: "560px",
          borderRadius: "36px",
          overflow: "hidden",
          transform: "rotate(-2deg)",
          boxShadow: "0 30px 60px rgba(80, 30, 45, 0.22)",
        },
        [venueImage],
      ),
      // Overlapping partner polaroid
      polaroid(input),
    ],
  );
}

function polaroid(input: CardElementInput): CardNode {
  const inner = input.partnerPhoto
    ? el("img", { width: "260px", height: "300px", objectFit: "cover", borderRadius: "6px" }, undefined, {
        src: dataUri(input.partnerPhoto),
      })
    : el(
        "div",
        {
          display: "flex",
          width: "260px",
          height: "300px",
          borderRadius: "6px",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#EFE3E6",
          color: ACCENT,
          fontSize: "120px",
          fontWeight: 700,
        },
        (input.partnerName[0] ?? "?").toUpperCase(),
      );

  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      position: "absolute",
      right: "24px",
      bottom: "0px",
      padding: "18px 18px 14px 18px",
      backgroundColor: PAPER,
      borderRadius: "10px",
      transform: "rotate(6deg)",
      boxShadow: "0 24px 44px rgba(80, 30, 45, 0.28)",
    },
    [
      inner,
      el(
        "div",
        {
          display: "flex",
          justifyContent: "center",
          marginTop: "14px",
          fontSize: "30px",
          fontWeight: 500,
          color: INK,
        },
        input.partnerName,
      ),
    ],
  );
}

function detailRow(label: string, value: string, sub?: string): CardNode {
  const lines: (CardNode | string)[] = [
    el(
      "div",
      { display: "flex", fontSize: "22px", fontWeight: 600, letterSpacing: "4px", color: ACCENT },
      label,
    ),
    el("div", { display: "flex", marginTop: "6px", fontSize: "40px", fontWeight: 700, color: INK }, value),
  ];
  if (sub) {
    lines.push(el("div", { display: "flex", marginTop: "4px", fontSize: "26px", color: MUTED }, sub));
  }
  return el("div", { display: "flex", flexDirection: "column", marginBottom: "30px" }, lines);
}

function detailsSection(input: CardElementInput): CardNode {
  return el("div", { display: "flex", flexDirection: "column", flexGrow: 1 }, [
    detailRow(input.labels.when, input.dateText),
    detailRow(input.labels.where, input.venueName, input.venueAddress),
  ]);
}

function footer(input: CardElementInput): CardNode {
  const children: (CardNode | string)[] = [
    el("div", { display: "flex", fontSize: "24px", color: MUTED }, "Made with Gennety"),
  ];
  if (input.attribution) {
    children.push(el("div", { display: "flex", fontSize: "22px", color: MUTED }, "Photo · Google"));
  }
  return el(
    "div",
    {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      borderTop: "1px solid rgba(42, 32, 36, 0.12)",
      paddingTop: "22px",
    },
    children,
  );
}
