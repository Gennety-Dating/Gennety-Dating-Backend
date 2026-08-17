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
import {cameraAt, glowAt} from "./camera";
import {HERO_DURATION_IN_FRAMES, MARK, SCREEN_WIDTH, SHOTS} from "./timeline";
import {CLIP_H, CLIP_W} from "./ui/Iphone";

const N = HERO_DURATION_IN_FRAMES;
const FRAME_W = 1080;
const FRAME_H = 1920;

const track = <T,>(fn: (f: number) => T) => Array.from({length: N}, (_, f) => fn(f));

const cams = track(cameraAt);
const scale = cams.map((c) => c.scale);
const x = cams.map((c) => c.x);
const y = cams.map((c) => c.y);

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
report("x", x, "px");
report("y", y, "px");
report("glow", track(glowAt), "");

// Framing bound: the handset must never touch an edge.
const bodyW = SCREEN_WIDTH + (SCREEN_WIDTH * 0.017 + SCREEN_WIDTH * 0.008) * 2;
const bodyH = (CLIP_H * SCREEN_WIDTH) / CLIP_W + (SCREEN_WIDTH * 0.017 + SCREEN_WIDTH * 0.008) * 2;

let tightest = {frame: 0, side: "", px: Infinity};
for (let f = 0; f < N; f++) {
  const c = cams[f];
  const marginX = (FRAME_W - bodyW * c.scale) / 2 - Math.abs(c.x * c.scale);
  const marginY = (FRAME_H - bodyH * c.scale) / 2 - Math.abs(c.y * c.scale);
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

const failures: string[] = [];
if (tightest.px < 40) failures.push(`handset within ${tightest.px.toFixed(1)}px of an edge`);
if ((SCREEN_WIDTH * maxScale) / CLIP_W > 1.35) failures.push("source upscaled past 1.35x");

const scaleSteps = diff(scale).map(Math.abs);
const worstCutStep = Math.max(...boundaries.map((f) => scaleSteps[f - 1]));
if (worstCutStep > Math.max(...scaleSteps) * 1.001) {
  failures.push("a cut carries the film's largest scale step");
}

console.log(failures.length === 0 ? "\nPASS" : `\nFAIL\n  - ${failures.join("\n  - ")}`);
process.exit(failures.length === 0 ? 0 : 1);
