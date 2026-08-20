import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import satori from "satori";
import { buildCardElement, CARD_W, CARD_H } from "./template.js";

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

async function layout(venueName: string, venueAddress: string): Promise<Box[]> {
  const svg = await satori(
    buildCardElement({
      partnerName: "Анна",
      partnerPhoto: null,
      venuePhoto: null,
      grain: null,
      logo: null,
      venueName,
      venueAddress,
      slogan: "Error 404:\nChat not found.\nTry real life.",
      theme: "dark",
    }) as never,
    { width: CARD_W, height: CARD_H, fonts },
  );
  return [
    ...svg.matchAll(
      /<mask id="satori_om-id[^"]*"><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g,
    ),
  ].map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }));
}

/** The address that reproduced the report, and one far past anything real. */
const REPORTED = "Маріїнський парк, вулиця Михайла Грушевського, Київ, 02000";
const PATHOLOGICAL =
  "56 вулиця Велика Арнаутська пос. Нерубайское пос. Усатово пос. Фомина балка пос Jolodna Balka, Odesa, Odes'ka oblast, Ukraine, 67660";

describe("date card layout", () => {
  it.each([
    ["short", "Lviv Coffee", "Khreshchatyk 14, Kyiv"],
    ["the reported address", "Маріїнський парк", REPORTED],
    ["the catalog's longest address", "Ресторан Дуже По-Французьки", PATHOLOGICAL],
  ])("keeps every element inside the card with %s", async (_label, name, address) => {
    for (const box of await layout(name, address)) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(CARD_W);
      expect(box.y + box.h).toBeLessThanOrEqual(CARD_H);
    }
  }, 60_000);

  it("keeps the credit out of the flex flow, inside the photo box", async () => {
    // This is the mechanism, asserted directly: an absolutely positioned element
    // takes no part in the row, so NO address length can push it. A future edit
    // that puts it back beside the address would reintroduce the bug even if it
    // happened to fit the one address a geometry test samples.
    const card = buildCardElement({
      partnerName: "Анна",
      partnerPhoto: null,
      venuePhoto: null,
      grain: null,
      logo: null,
      venueName: "Маріїнський парк",
      venueAddress: REPORTED,
      slogan: "x",
      theme: "dark",
    });

    const credits = findNodes(card, (n) => childText(n) === "made with Gennety");
    expect(credits).toHaveLength(1);
    expect(credits[0].props.style?.position).toBe("absolute");

    // Mounted inside the photo box (the one that clips to a 30px radius), not
    // as a sibling of the venue text.
    const photoBox = findNodes(card, (n) => n.props.style?.borderRadius === "30px");
    expect(photoBox).toHaveLength(1);
    expect(findNodes(photoBox[0], (n) => childText(n) === "made with Gennety")).toHaveLength(1);
  });

  it("clips the venue name and address to one line each", async () => {
    // The bottom block sits behind a `flexGrow` spacer on a fixed-height card,
    // and that spacer is all the slack there is — one wrapped line and the block
    // pushes up into the partner polaroid, so the same card becomes two shapes.
    const card = buildCardElement({
      partnerName: "Анна",
      partnerPhoto: null,
      venuePhoto: null,
      grain: null,
      logo: null,
      venueName: "Ресторан Дуже По-Французьки",
      venueAddress: PATHOLOGICAL,
      slogan: "x",
      theme: "dark",
    });

    for (const text of ["Ресторан Дуже По-Французьки", PATHOLOGICAL]) {
      const [line] = findNodes(card, (n) => childText(n) === text);
      expect(line).toBeDefined();
      expect(line.props.style?.whiteSpace).toBe("nowrap");
      expect(line.props.style?.overflow).toBe("hidden");
      expect(line.props.style?.textOverflow).toBe("ellipsis");
    }
  });
});
