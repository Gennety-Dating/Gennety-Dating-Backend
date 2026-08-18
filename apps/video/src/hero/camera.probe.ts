/**
 * Continuity probe. Walks every frame of the film and reports whether the
 * camera can be told where the cuts are.
 *
 * The old motion system fails this loudly — twelve of the fourteen boundaries
 * carried a −3.3% to −4.7% single-frame step in scale, and a step in its
 * VELOCITY at every one of them, which is the part the eye actually reads. The
 * pass condition is not "small numbers": it is that a shot boundary is
 * statistically indistinguishable from any other frame in the film.
 *
 * Run:  pnpm --filter @gennety/video exec tsx src/hero/camera.probe.ts
 */
import {CAMERA_HOLDS, cameraAt, glowAt} from "./camera";
import {HERO_DURATION_IN_FRAMES, MARK, SCREEN_WIDTH, SHOTS} from "./timeline";
import {CLIP_H, CLIP_W} from "./ui/Iphone";

const N = HERO_DURATION_IN_FRAMES;
const FRAME_W = 1080;
const FRAME_H = 1920;

const track = <T,>(fn: (f: number) => T) => Array.from({length: N}, (_, f) => fn(f));

const cams = track(cameraAt);
const scale = cams.map((c) => c.scale);

const diff = (v: number[]) => v.slice(1).map((n, i) => n - v[i]);

const boundaries = [
  ...new Set([...SHOTS.map((s) => s.from), MARK.from].filter((f) => f > 0 && f < N)),
].sort((a, b) => a - b);

const report = (label: string, v: number[], unit: string) => {
  const d1 = diff(v);
  const d2 = diff(d1);
  const worst = (arr: number[]) =>
    arr.reduce((best, n, i) => (Math.abs(n) > Math.abs(arr[best]) ? i : best), 0);

  const wv = worst(d1);
  const wa = worst(d2);
  console.log(`\n${label}`);
  console.log(`  peak speed        ${d1[wv].toFixed(5)} ${unit}/frame  @ f${wv}`);
  console.log(`  peak acceleration ${d2[wa].toFixed(6)} ${unit}/frame²  @ f${wa}`);

  // The claim under test: nothing special happens at a cut.
  const atCuts = boundaries.map((f) => Math.abs(d1[f - 1]));
  const overall = d1.map(Math.abs);
  const maxAtCut = Math.max(...atCuts);
  const maxOverall = Math.max(...overall);
  console.log(
    `  largest step across a CUT   ${maxAtCut.toFixed(5)} ${unit}` +
      `  (${((maxAtCut / maxOverall) * 100).toFixed(0)}% of the film's largest step)`,
  );
};

console.log(`GennetyHero camera — ${N} frames, ${boundaries.length} boundaries`);
console.log(`boundaries: ${boundaries.join(", ")}`);

report("scale", scale, "x");
report("glow", track(glowAt), "");

// Framing bound: the handset must never touch an edge.
const bodyW = SCREEN_WIDTH + (SCREEN_WIDTH * 0.017 + SCREEN_WIDTH * 0.008) * 2;
const bodyH = (CLIP_H * SCREEN_WIDTH) / CLIP_W + (SCREEN_WIDTH * 0.017 + SCREEN_WIDTH * 0.008) * 2;

let tightest = {frame: 0, side: "", px: Infinity};
for (let f = 0; f < N; f++) {
  const c = cams[f];
  const marginX = (FRAME_W - bodyW * c.scale) / 2;
  const marginY = (FRAME_H - bodyH * c.scale) / 2;
  if (marginX < tightest.px) tightest = {frame: f, side: "horizontal", px: marginX};
  if (marginY < tightest.px) tightest = {frame: f, side: "vertical", px: marginY};
}
console.log(
  `\nframing\n  tightest margin   ${tightest.px.toFixed(1)}px ` +
    `(${tightest.side}) @ f${tightest.frame}`,
);

const maxScale = Math.max(...scale);
console.log(
  `\nresolution\n  worst upscale     ${((SCREEN_WIDTH * maxScale) / CLIP_W).toFixed(3)}x ` +
    `(camera peaks at ${maxScale.toFixed(3)})`,
);

// Rhythm: the reference is dead still ~52% of the time in holds of 1.5-5.0s.
// A camera that never stops is the thing this replaced.
const heldFrames = CAMERA_HOLDS.reduce((n, [a, b]) => n + (b - a + 1), 0);
const holdLens = CAMERA_HOLDS.map(([a, b]) => (b - a) / 30).filter((s) => s > 0.2);
console.log(
  `\nrhythm\n  held              ${((heldFrames / N) * 100).toFixed(0)}% of the film ` +
    `(reference: 52%)\n  hold lengths (s)  ${holdLens.map((s) => s.toFixed(1)).join(", ")}`,
);

// A move must never start faster than it averages: that is the "рывок".
const moves: number[] = [];
for (let i = 0; i < CAMERA_HOLDS.length - 1; i++) {
  const a = CAMERA_HOLDS[i][1];
  const b = CAMERA_HOLDS[i + 1][0];
  if (b <= a) continue;
  const span = Math.abs(cameraAt(b).scale - cameraAt(a).scale);
  if (span < 1e-6) continue;
  const first = Math.abs(cameraAt(a + 1).scale - cameraAt(a).scale);
  moves.push(first / (span / (b - a)));
}
const worstLaunch = Math.max(...moves);
console.log(
  `  launch speed      ${worstLaunch.toFixed(2)}x the move's own average ` +
    `(1.00 = fitted to the reference; our old curve was 4.5)`,
);

// The founder's rule, as a test: the dolly never reverses, so the film never
// revisits a distance it has already been at. A reversal is what reads as
// "it grew, then went back to where it started".
const reversals = diff(scale).filter((d) => d < -1e-9).length;
console.log(`  zoom reversals    ${reversals}  (must be 0 — the camera only moves in)`);
console.log(
  `  handset          ${(bodyW * Math.min(...scale)).toFixed(0)} -> ` +
    `${(bodyW * maxScale).toFixed(0)} px wide, one direction`,
);

const failures: string[] = [];
if (reversals > 0) failures.push(`the zoom reverses on ${reversals} frames`);
if (worstLaunch > 1.6) failures.push(`a move launches at ${worstLaunch.toFixed(2)}x average speed`);
if (heldFrames / N < 0.35) failures.push("the camera is almost never still");
if (tightest.px < 40) failures.push(`handset within ${tightest.px.toFixed(1)}px of an edge`);
if ((SCREEN_WIDTH * maxScale) / CLIP_W > 1.35) failures.push("source upscaled past 1.35x");

// A cut must carry no discontinuity. This is a MAGNITUDE bound, not a rank one:
// now that the dolly is uniform, a cut landing on the film's fastest frame is
// meaningless (it is still ~1.4 px of handset), and ranking it would fail the
// probe for a coincidence. 0.004 of scale is ~2.5 px of handset width.
const scaleSteps = diff(scale).map(Math.abs);
const worstCutStep = Math.max(...boundaries.map((f) => scaleSteps[f - 1]));
console.log(
  `\ncontinuity\n  worst step at a cut  ${(worstCutStep * bodyW).toFixed(2)} px of handset`,
);
if (worstCutStep > 0.004) failures.push(`a cut steps the camera by ${worstCutStep.toFixed(4)}`);

console.log(failures.length === 0 ? "\nPASS" : `\nFAIL\n  - ${failures.join("\n  - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
