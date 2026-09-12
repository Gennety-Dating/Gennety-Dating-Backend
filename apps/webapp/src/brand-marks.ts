/**
 * The partners' own marks, for the transit dock's buttons.
 *
 * A separate file from `icons.ts` on purpose: that set is the HOUSE set — one
 * 24×24 box, 1.6 stroke, `currentColor`, no fill — and it exists so the app's
 * glyphs look like one hand drew them. These do the opposite job. A maps button
 * is recognised before it is read, and it is recognised by a palette that is
 * not ours: the moment Google's pin is redrawn in our stroke weight and our
 * ink, it stops being the thing the thumb is looking for. So they keep their
 * own colours and their own fills, and they stay out of `IconName` so nobody
 * reaches for them where a house glyph belongs.
 *
 * They are marks, not logotypes: the map tile each app shows on a home screen,
 * pared down to what still reads at 22 px. Nothing here is traced from a brand
 * asset — the button names the app in `aria-label`, which is what a screen
 * reader announces; the colour is what the eye uses.
 */

const NS = "http://www.w3.org/2000/svg";

export type BrandMarkName = "apple-maps" | "google-maps";

function svg(className: string): SVGSVGElement {
  const node = document.createElementNS(NS, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("class", className);
  // The button carries the name; a second announcement of the same thing is
  // noise in a screen reader.
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("focusable", "false");
  return node;
}

function shape(
  parent: SVGSVGElement | SVGGElement,
  tag: "path" | "rect" | "circle",
  attrs: Record<string, string>,
): void {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  parent.appendChild(node);
}

/**
 * Both marks are a map tile clipped to the same rounded square, so the two
 * buttons read as a pair rather than as two unrelated stickers. The clip id is
 * per-instance: two of these live on one screen, and a shared id would make
 * whichever mounted second borrow the first one's clip.
 */
let clipSeq = 0;
function tile(node: SVGSVGElement, ground: string): SVGGElement {
  const id = `brand-clip-${++clipSeq}`;
  const defs = document.createElementNS(NS, "defs");
  const clip = document.createElementNS(NS, "clipPath");
  clip.setAttribute("id", id);
  const rect = document.createElementNS(NS, "rect");
  for (const [key, value] of Object.entries({
    x: "2",
    y: "2",
    width: "20",
    height: "20",
    rx: "5.5",
  })) {
    rect.setAttribute(key, value);
  }
  clip.appendChild(rect);
  defs.appendChild(clip);
  node.appendChild(defs);

  const group = document.createElementNS(NS, "g");
  group.setAttribute("clip-path", `url(#${id})`);
  node.appendChild(group);
  shape(group, "rect", { x: "2", y: "2", width: "20", height: "20", rx: "5.5", fill: ground });
  return group;
}

/**
 * Apple Maps: cream paper, a green park, the blue highway across it and one
 * amber street. No pin — Apple's tile has none, and that absence is what tells
 * this button from its neighbour at a glance.
 */
function appleMaps(className: string): SVGSVGElement {
  const node = svg(className);
  const g = tile(node, "#F7F4ED");
  shape(g, "path", { d: "M2 2h8.4L2 11.6Z", fill: "#A7DCA0" });
  shape(g, "path", { d: "M15.4 22 22 15v7Z", fill: "#9CD6F3" });
  shape(g, "path", {
    d: "M1 15.6c4.2.6 6.2-3.2 9.6-4.6 3-1.2 4.9-.2 7-2.6",
    fill: "none",
    stroke: "#4C97F1",
    "stroke-width": "2.5",
    "stroke-linecap": "round",
  });
  shape(g, "path", {
    d: "M5.4 22.5 11.8 12",
    fill: "none",
    stroke: "#F0B143",
    "stroke-width": "1.9",
    "stroke-linecap": "round",
  });
  return node;
}

/**
 * Google Maps: the grey tile with its green corner, the water, the yellow road
 * running corner to corner, and the red pin that is the half of this mark
 * everyone actually recognises — so the pin gets the room and sits where the
 * eye lands, right of centre.
 */
function googleMaps(className: string): SVGSVGElement {
  const node = svg(className);
  const g = tile(node, "#F1F0EB");
  shape(g, "path", { d: "M2 2h7.2L2 9.4Z", fill: "#34A853" });
  shape(g, "path", { d: "M2 16.4h6.2L5.8 22H2Z", fill: "#4285F4" });
  shape(g, "path", {
    d: "M1.4 2.6 22.6 21.4",
    fill: "none",
    stroke: "#FBBC04",
    "stroke-width": "2.6",
    "stroke-linecap": "round",
  });
  shape(g, "path", {
    d: "M14.9 5.6c2.6 0 4.7 2.1 4.7 4.7 0 3.4-4.7 8.4-4.7 8.4s-4.7-5-4.7-8.4c0-2.6 2.1-4.7 4.7-4.7Z",
    fill: "#EA4335",
  });
  shape(g, "circle", { cx: "14.9", cy: "10.3", r: "1.75", fill: "#F1F0EB" });
  return node;
}

const MARKS: Record<BrandMarkName, (className: string) => SVGSVGElement> = {
  "apple-maps": appleMaps,
  "google-maps": googleMaps,
};

export function brandMark(name: BrandMarkName, className = "brand-mark"): SVGSVGElement {
  return MARKS[name](className);
}
