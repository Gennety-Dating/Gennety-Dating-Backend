/**
 * The torn edge of the Date Ticket — two clip-paths that share ONE jagged line
 * along the perforation, so the two pieces fit back together exactly.
 *
 * Deterministic on purpose: a random edge would re-roll on every render (and
 * differ between the pieces if they were ever computed apart), which reads as
 * the paper changing shape rather than as a tear.
 */

export interface TearPolygons {
  /** `clip-path` for the main part — everything above the tear. */
  top: string;
  /** `clip-path` for the stub — everything below it. */
  stub: string;
  /** The perforation's Y, in px from the card's top. */
  perfY: number;
}

/** Teeth along the tear: ~11 px each on the 268 px card — paper, not a zipper. */
export const TEAR_TEETH = 24;
/** Half a tooth's height, px. */
export const TEAR_AMPLITUDE = 2.6;
/** The fixed irregularity added on top, px — so it is not a sawtooth. */
export const TEAR_JITTER = 0.9;

const round = (value: number): number => Math.round(value * 10) / 10;

/** The shared edge, left to right, as `[x, y]` pairs in px. */
export function tearEdge(width: number, perfY: number, teeth: number = TEAR_TEETH): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= teeth; i += 1) {
    const x = (width * i) / teeth;
    const y = perfY + (i % 2 === 0 ? -TEAR_AMPLITUDE : TEAR_AMPLITUDE) + Math.sin(i * 12.9898) * TEAR_JITTER;
    points.push([round(x), round(y)]);
  }
  return points;
}

export function tearPolygons(width: number, perfY: number): TearPolygons {
  const edge = tearEdge(width, perfY);
  const px = ([x, y]: [number, number]): string => `${x}px ${y}px`;
  const right = `${round(width)}px`;
  const top = ["0px 0px", `${right} 0px`, ...[...edge].reverse().map(px)];
  const stub = [...edge.map(px), `${right} 100%`, "0px 100%"];
  return { top: `polygon(${top.join(", ")})`, stub: `polygon(${stub.join(", ")})`, perfY };
}
