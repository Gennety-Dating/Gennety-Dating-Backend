import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import satori from "satori";
import { buildCardElement, CARD_W, CARD_H, CARD_PADDING_X, CREDIT_TEXT } from "./template.js";
import { resolveCreditPlacement, measureRoboto, CREDIT_MIN_GAP } from "./credit-placement.js";

/**
 * Geometry guard for the card's bottom block.
 *
 * The failure this pins is silent: a long venue address used to grow its flex
 * column until it hit the content width and then lay the "made with Gennety"
 * credit out AFTER itself, off the canvas — measured at x=1127 on a 1080px card
 * for a 57-character Kyiv address (around p75 of the real curated catalog).
 * Nothing threw, nothing logged, the PNG rendered fine; the credit was simply
 * clipped away. So the assertion has to be on the laid-out boxes, not on the
 * render succeeding.
 *
 * satori emits one `<mask>` rect per element, which is the laid-out box — that
 * is what these tests read.
 *
 * Since 2026-08-23 the credit has two homes — beside the address when it fits,
 * on the photo when it does not (`credit-placement.ts`) — so the geometry has
 * to hold in BOTH, and these tests resolve the placement the same way the
 * renderer does rather than being handed one.
 */

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../assets/fonts/${file}`, import.meta.url)));

const archivoBlack = read("ArchivoBlack-Regular.ttf");
const fonts = [
  { name: "Roboto", data: read("Roboto-Regular.ttf"), weight: 400 as const, style: "normal" as const },
  { name: "Roboto", data: read("Roboto-Medium.ttf"), weight: 500 as const, style: "normal" as const },
  { name: "Roboto", data: read("Roboto-Bold.ttf"), weight: 700 as const, style: "normal" as const },
  { name: "Archivo Black", data: archivoBlack, weight: 400 as const, style: "normal" as const },
  { name: "Archivo Black", data: archivoBlack, weight: 700 as const, style: "normal" as const },
];

interface Box { x: number; y: number; w: number; h: number }

type Node = ReturnType<typeof buildCardElement>;

function childNodes(node: Node): Node[] {
  const c = node.props.children;
  const list = Array.isArray(c) ? c : c === undefined ? [] : [c];
  return list.filter((x): x is Node => typeof x === "object" && x !== null);
}

function findNodes(node: Node, match: (n: Node) => boolean): Node[] {
  const here = match(node) ? [node] : [];
  return [...here, ...childNodes(node).flatMap((child) => findNodes(child, match))];
}

/** The node's own text, when it is a leaf carrying a single string. */
function childText(node: Node): string | null {
  const c = node.props.children;
  return typeof c === "string" ? c : null;
}

function card(venueName: string, venueAddress: string, slogan = "x") {
  return buildCardElement({
    partnerName: "Анна",
    partnerPhoto: null,
    venuePhoto: null,
    grain: null,
    logo: null,
    venueName,
    venueAddress,
    slogan,
    theme: "dark",
    // Resolved exactly as the renderer resolves it, so these tests exercise the
    // real pairing of rule and layout rather than a branch chosen by hand.
    creditPlacement: resolveCreditPlacement(venueAddress),
  });
}

async function layout(venueName: string, venueAddress: string): Promise<Box[]> {
  const svg = await satori(
    card(venueName, venueAddress, "Error 404:\nChat not found.\nTry real life.") as never,
    { width: CARD_W, height: CARD_H, fonts },
  );
  return [
    ...svg.matchAll(
      /<mask id="satori_om-id[^"]*"><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    ),
  ].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
}

/** A short address (credit goes inline), the one that reproduced the report,
 * and one far past anything real (both put the credit on the photo). */
const SHORT = "вул. Хрещатик, 14, Київ";
const REPORTED = "Маріїнський парк, вулиця Михайла Грушевського, Київ, 02000";
const PATHOLOGICAL =
  "56 вулиця Велика Арнаутська пос. Нерубайское пос. Усатово пос. Фомина балка пос Jolodna Balka, Odesa, Odes'ka oblast, Ukraine, 67660";

describe("date card layout", () => {
  it.each([
    ["short", "Lviv Coffee", SHORT],
    ["the reported address", "Маріїнський парк", REPORTED],
    ["the catalog's longest address", "Ресторан Дуже По-Французьки", PATHOLOGICAL],
  ])("keeps every element inside the card with %s", async (_label, name, address) => {
    for (const box of await layout(name, address)) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(CARD_W);
      expect(box.y + box.h).toBeLessThanOrEqual(CARD_H);
    }
  }, 60_000);

  it("keeps the long-address credit out of the flex flow, inside the photo box", () => {
    // This is the fallback branch's mechanism, asserted directly: an absolutely
    // positioned element takes no part in the row, so NO address length can
    // push it. A future edit that put it back beside a long address would
    // reintroduce the 2026-08-20 bug.
    const built = card("Маріїнський парк", REPORTED);
    expect(resolveCreditPlacement(REPORTED).kind).toBe("photo");

    const credits = findNodes(built, (n) => childText(n) === CREDIT_TEXT);
    expect(credits).toHaveLength(1);
    expect(credits[0].props.style?.position).toBe("absolute");

    // Mounted inside the photo box (the one that clips to a 30px radius), not
    // as a sibling of the venue text.
    const photoBox = findNodes(built, (n) => n.props.style?.borderRadius === "30px");
    expect(photoBox).toHaveLength(1);
    expect(findNodes(photoBox[0], (n) => childText(n) === CREDIT_TEXT)).toHaveLength(1);
  });

  it("bounds the address to a fixed width when the credit sits beside it", () => {
    // The inline branch's own mechanism. yoga defaults `flex-shrink` to 0, so a
    // `100%` address here would grow to the content width and lay the credit
    // out after itself — off the canvas, which is precisely the old bug. A
    // FIXED px width is what makes the credit's box independent of the text,
    // and it is why a mis-measured address can only ellipsize early.
    const built = card("Aroma Kava", SHORT);
    const placement = resolveCreditPlacement(SHORT);
    expect(placement.kind).toBe("inline");

    const [address] = findNodes(built, (n) => childText(n) === SHORT);
    expect(address.props.style?.width).toBe(
      `${placement.kind === "inline" ? placement.addressWidth : 0}px`,
    );

    // Exactly one credit, and it is NOT on the photo in this branch.
    const credits = findNodes(built, (n) => childText(n) === CREDIT_TEXT);
    expect(credits).toHaveLength(1);
    expect(credits[0].props.style?.position).toBeUndefined();
    const photoBox = findNodes(built, (n) => n.props.style?.borderRadius === "30px");
    expect(findNodes(photoBox[0], (n) => childText(n) === CREDIT_TEXT)).toHaveLength(0);
  });

  it("leaves the minimum gap between the address and an inline credit", async () => {
    const boxes = await layout("Aroma Kava", SHORT);
    const creditW = measureRoboto(CREDIT_TEXT, 22) ?? 0;

    // The bottom block only. The credit is the one box there that does not
    // start at the card's left text column.
    const bottom = boxes.filter((b) => b.y > CARD_H / 2 && b.w < CARD_W);
    const credit = bottom.find((b) => Math.abs(b.w - creditW) < 2 && b.x > CARD_PADDING_X + 1);
    expect(credit).toBeDefined();
    const addressBox = bottom.find(
      (b) => Math.abs(b.x - CARD_PADDING_X) < 1 && Math.abs(b.w - (creditW + CREDIT_MIN_GAP)) > 2 && b.w < CARD_W - 2 * CARD_PADDING_X,
    );
    expect(addressBox).toBeDefined();

    expect((credit?.x ?? 0) - ((addressBox?.x ?? 0) + (addressBox?.w ?? 0))).toBeGreaterThanOrEqual(
      CREDIT_MIN_GAP - 1,
    );
    expect((credit?.x ?? 0) + (credit?.w ?? 0)).toBeLessThanOrEqual(CARD_W - CARD_PADDING_X + 1);
  }, 60_000);

  it("clips the venue name and address to one line each", async () => {
    // The bottom block sits behind a `flexGrow` spacer on a fixed-height card,
    // and that spacer is all the slack there is — one wrapped line and the block
    // pushes up into the partner polaroid, so the same card becomes two shapes.
    const built = card("Ресторан Дуже По-Французьки", PATHOLOGICAL);

    for (const text of ["Ресторан Дуже По-Французьки", PATHOLOGICAL]) {
      const [line] = findNodes(built, (n) => childText(n) === text);
      expect(line).toBeDefined();
      expect(line.props.style?.whiteSpace).toBe("nowrap");
      expect(line.props.style?.overflow).toBe("hidden");
      expect(line.props.style?.textOverflow).toBe("ellipsis");
    }
  });
});
