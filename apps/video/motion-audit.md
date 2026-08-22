# `GennetyHero` — motion audit and camera redesign

> Companion to `video-production-plan.md` (which owns the *cut*: which clip,
> which window, why). This file owns the *camera*: why the old motion read as a
> reset on every edit, and what replaced it.
>
> **The reference arrived after the first rebuild, and it changed the rhythm.**
> `IMG_2325 (1).MP4` — Ditto's iMessage-dating promo, 848x480, 44.5 s, a handset
> on white. §5a below is what tracking it frame by frame actually says, and §5b
> is what was changed as a result. The short version: the first rebuild fixed the
> reset and got the *cadence* wrong — it drifted on all 1356 frames, where the
> reference is dead still about half the time and moves decisively in between.
>
> Founder decisions taken on the reference (2026-08-17): **do not crop the
> handset** (they crop theirs in 85% of frames; that is how they afford a 5x zoom
> range and it is not a trade we are making) and **keep the background black**.
> So what was adopted is the rhythm and the easing, not the framing.

---

## 1. Current camera architecture

There was no camera. There were fifteen of them.

`motion.ts` exported one function that every shot called on its own:

```ts
export const push = (frame: number, duration: number, from = 1, to = 1.06) =>
  interpolate(frame, [0, duration], [from, to], { easing: Easing.linear });
```

Three properties of that signature are the whole problem:

1. **`frame` is scene-local.** Every shot lives in a `<Sequence>`, so
   `useCurrentFrame()` restarts at 0 for each of them. The camera therefore had
   no notion of composition time at all.
2. **`from` defaults to 1 and every shot passed `1`.** All fifteen entries in
   `SHOTS` carry `push: [1.0, 1.0x]`. So the scale is *by construction* exactly
   1.0 on the first frame of every shot.
3. **`Easing.linear`.** No acceleration, no deceleration — a constant-rate zoom
   that starts and stops instantly at both ends.

`ProductShot.tsx` then rebuilt the whole world per shot:

```tsx
const scale = push(frame, duration, pushFrom, pushTo) * (arrives ? … : 1);
const y     = (shot.y ?? 0) + (1 - rise) * 40;
return <AbsoluteFill …><Iphone scale={scale} y={y} … /></AbsoluteFill>;
```

and `Iphone.tsx` positioned itself from scratch on every render:

```tsx
transform: `translate(-50%, -50%) translateY(${y}px) scale(${scale})`
```

## 2. Current scene architecture

`GennetyHero.tsx` mapped `SHOTS` to fifteen sibling `<Sequence>`s, each mounting
its **own complete `<Iphone>`** — body, titanium rail, five side buttons, bezel,
glow, glass sheen, and one `<OffthreadVideo>`. Fifteen handsets existed over the
run of the film, one at a time, each believing it was the first.

The handset was therefore not an object in the film. It was a *decoration
redrawn identically fifteen times*, and the only reason it looked stable is that
all fifteen copies agreed on `SCREEN_WIDTH = 604`, `x = centre`, `rotate = 0`.
The moment any of them disagreed — which is what `push` did on scale — the
disagreement read as the object jumping.

Two further per-scene transforms compounded it:

- **`enter()`**, a spring that ran on any shot with a `fadeIn`, scaling the
  phone `0.978 → 1.0` and sliding it `+40px → 0`. Three shots had it (0, 8, 14),
  so the phone physically re-entered the frame three times mid-film.
- **`glow`**, a per-shot constant (0.7–1.0). At a hard cut the lighting on the
  object changed instantaneously.

## 3. Exactly where the reset occurs

Every hard cut. Twelve of the fourteen boundaries are hard cuts, and at each one
the composition renders these two adjacent frames:

| | frame 143 (`basics-age`, local 65/66) | frame 144 (`basics-gender`, local 0/78) |
|---|---|---|
| scale | `push(65, 66, 1, 1.035)` = **1.0344** | `push(0, 78, 1, 1.04)` = **1.0** |
| glow | 0.85 | 0.85 |
| phone | instance #2, unmounting | instance #3, mounting |

**−3.3% of scale in one frame**, i.e. the handset snaps ~21 px wider→narrower
between two consecutive frames after 2.2 s of it growing steadily. The same
arithmetic at every other boundary:

| boundary | frame | scale before | scale after | jump |
|---|---|---|---|---|
| name → age | 78 | 1.0395 | 1.0000 | −3.80 % |
| age → gender | 144 | 1.0344 | 1.0000 | −3.33 % |
| gender → preference | 222 | 1.0395 | 1.0000 | −3.80 % |
| preference → height | 306 | 1.0445 | 1.0000 | −4.26 % |
| height → chat | 378 | 1.0345 | 1.0000 | −3.34 % |
| chat → radar | 468 | 1.0396 | 1.0000 | −3.80 % |
| radar → done | 660 | 1.0497 | 1.0000 | −4.74 % |
| decision → cal-dates | 802 | 1.0446 | 1.0000 | −4.27 % |
| cal-dates → overlap | 862 | 1.0345 | 1.0000 | −3.33 % |
| overlap → time | 928 | 1.0443 | 1.0000 | −4.24 % |
| time → map | 1030 | 1.0446 | 1.0000 | −4.27 % |
| map → vibe | 1084 | 1.0393 | 1.0000 | −3.79 % |

The three *dissolves* (694, 1130, 1260) hide the snap behind a crossfade but do
not remove it — during the overlap two handsets at different scales are
composited on top of each other, so the phone's edges double for ~14 frames.

**The velocity discontinuity is worse than the position one, and is the thing a
viewer actually feels.** Because the easing is linear, each shot's zoom rate is
`(to − from) / duration` — constant, then instantly zero, then instantly a
*different* constant. At frame 660 the camera is moving at +0.026 %/frame, at
frame 661 at +0.063 %/frame. Nothing in the physical world changes speed
instantaneously, so the eye reads the boundary as a cut in the *camera*, not a
cut in the *content* — which is exactly the "assembled from independent scenes"
complaint.

Secondary resets, same cause:

- **Position**, at frames 0, 694 and 1130 — `enter()` slides the phone 40 px up
  from nothing.
- **Lighting**, at every boundary where `glow` differs (378, 468, 660, 694, 802,
  928, 1030, 1130): the halo behind a supposedly stationary object steps.

## 4. What needed to be refactored

The reset is not a bug in `push()`. `push()` is a correct function; it is being
asked the wrong question. Anything scoped to a `<Sequence>` **cannot** know the
state it is supposed to inherit, so no amount of tuning the per-shot values fixes
it — matching `pushTo[n]` to `pushFrom[n+1]` by hand would fix position and leave
the velocity break, and would have to be redone by hand on every retime.

Four things had to move:

| was | is now |
|---|---|
| 15 × `<Iphone>`, one per `<Sequence>` | **1** `<Iphone>` for the whole film, outside every sequence |
| `scale`/`y` computed per scene from a scene-local frame | one `cameraAt(frame)` over absolute composition frames |
| `glow` a per-shot constant | one continuous lighting curve |
| `enter()` spring on the phone | deleted — the phone never arrives, it is always there |

What did **not** need to move, and deliberately did not: the cut. `SHOTS` keeps
every `from` / `durationInFrames` / `trim` / `beat` byte-for-byte, so the film
shows exactly the same product frames at exactly the same times. This is a
motion change and nothing else.

## 5. The global camera architecture

```
AbsoluteFill (INK)
└── World                       ← ONE camera transform, for the world's 1323 frames
    └── Iphone                  ← ONE handset, fixed at world (0,0), never moves
        └── screen aperture
            ├── Sequence 0  → ScreenClip (basics-name)
            ├── Sequence 1  → ScreenClip (basics-age)
            └── …            (15 clips; only the CONTENT changes)
    Mark                        ← outro, inherits the camera's momentum
    Vignette + Grain
```

### The camera state

```ts
export type CameraState = {
  /** World point at the centre of the frame. */
  x: number;
  y: number;
  /** Zoom. 1.0 renders the phone screen at 604 px, ≈ native for a 576 px source. */
  scale: number;
  /** Always 0 — see below. */
  rotate: number;
};
```

`cameraAt(frame)` is a pure function of **absolute composition frame**. It is the
only thing in the film that decides what the viewer sees, and it is defined once,
as seventeen keyframes in `src/hero/camera.ts`. Scene boundaries are not inputs
to it and cannot be: it does not know where they are.

That single property is what makes the transition rule from the brief
— `camera(end of A) === camera(start of B)` — hold by construction rather than by
maintenance. There is no value to match up, because there is only one value.

### The interpolation: holds, and eased steps between them

The camera is **a list of distances it holds**, not a curve. Between two holds it
steps closer; the rest of the time it is dead still.

The step's easing was **fitted to the reference, not chosen**. Its two cleanest
camera moves were tracked frame by frame, normalised to 0..1, and a cubic-bezier
easing was least-squares fitted over a constrained monotone search:

| curve | RMS error vs the reference's own move | launch slope |
|---|---|---|
| **`bezier(0.18, 0.12, 0.20, 0.96)` — shipped** | **0.0529** | **0.67** |
| unconstrained best `(0.20, 0.20, 0.20, 0.92)` | 0.0525 | 1.00 |
| quad-out | 0.067 | 1.84 |
| cubic-out `(0.33, 1, 0.68, 1)` | 0.086 | 3.00 |
| the film's own `ease` `(0.22, 1, 0.36, 1)` | 0.178 | 4.50 |
| symmetric ease-in-out (what a spline gives) | 0.251 | 0.00 |

The **launch slope** is the number that decides whether a move reads as a flick.
The film's old `ease` leaves a standstill at 4.5x the move's own average speed;
cubic-out at 3.0. The unconstrained best fit to the reference sits at 1.00 — no
flick, but still a velocity step at the instant the camera sets off. Adding a
gentle-launch constraint to the same search costs essentially nothing (0.0529
against 0.0525) and buys 0.67, so the camera now eases **in** as well as out.
There is no frame anywhere in the film where its speed changes abruptly.

### The camera timeline: a dolly, one direction

**The phone is static. Only the camera approaches.** (Founder, 2026-08-18.) That
is stricter than the previous pass understood it, and it removed two things:

- **All lateral and vertical movement.** `x` and `y` are gone from `CameraState`,
  not set to zero. A handset sliding around the frame is a handset that moves,
  whichever object the code says is doing it — and the previous pass had
  reintroduced a ±39 px drift by calling it camera work, three days after the
  2026-08-16 decision that removed it.
- **Every reversal in the zoom.** The previous pass ran the handset
  545 → 647 → **583** → 723 → 786 → **558** → 660 → **609** → 761 px. Six changes
  of direction — and at 29 s it was within 13 px of its opening size, i.e. the
  film had visibly returned to a framing it already used. The founder read that
  as «увеличивается, потом обратно… возвращается в исходное положение», which
  the numbers support exactly.

So the camera is a **dolly straight down the lens axis**: six held distances,
five slow steps, one direction.

| hold | frames | time | scale | handset | covers |
|---|---|---|---|---|---|
| 1 | 0–210 | 0:00–0:07.0 | 0.88 | 558 px | the name, the age slider, the gender tap |
| 2 | 300–540 | 0:10.0–0:18.0 | 0.96 | 609 px | the photo columns, the height drum, the question |
| 3 | 640–830 | 0:21.3–0:27.7 | 1.05 | 666 px | the radar closing, and the decision |
| 4 | 930–1010 | 0:31.0–0:33.7 | 1.12 | 710 px | the butterfly, 17:00, the address search opening |
| 5 | 1140–1240 | 0:38.0–0:41.3 | 1.19 | 755 px | the vibe typed out and read back |
| 6 | 1323 | 0:44.1 | 1.24 | 792 px | still moving in as the world hands over |

Each step is ~45 px of handset over ~3–6 s — well under **0.5 px per frame** —
and the film never revisits a distance it has already been at. **59% of the film
is held**, in stretches of 3.7–8.0 s.

> The frame numbers in this table are absolute, so they move whenever the CUT
> does. They were re-spaced three times in three days — 2026-08-19 (the venue act
> grew from 3.4 s to 9.3 s), 2026-08-21 (the calendar act re-shot shorter and the
> date card trimmed), and again the same day when the table's end moved from the
> film's last frame to the WORLD's. **Only the spacing ever changed** — the same
> six distances, the same 0.88 → 1.24 range, the same fitted easing, and the probe
> still reports zero reversals, a 0.77× launch and a 1.38 px worst step at a cut.
> No seventh distance was added: inside the same range it would make every step
> smaller than the eye can register.
>
> **The table now ends with the world rather than with the film**, and that is
> the one change that is not spacing. The 543 frames after it are the drawn title
> act, which has no phone in it and therefore nothing for a dolly to approach;
> those cards creep 3.2 % across their own life instead (`camera.ts` →
> `titleTransform`), which keeps the film's *no parking* rule without pretending
> there is still a camera. `camera.probe.ts` measures over the world for the same
> reason: walking it across seventeen seconds it does not govern would report a
> camera that had gone quiet, when what happened is that it finished.

The five steps are placed to sit INSIDE a shot or to cross a cut mid-flight,
never to start on one: a move that begins exactly when the screen changes reads
as the cut having caused it.

The ceiling is the frame, not the resolution. At 1.24 there is ~109 px of
vertical air left, and the handset is never cropped (founder, 2026-08-17). The
reference affords 5x by cropping in 85% of its frames; that is the trade being
declined, and it is why this range is 1.41x rather than theirs.

### What the phone does

Nothing at all, and now that is enforced in three places rather than one.
`<Iphone>` is centred at world (0, 0) with no transform of its own and no
`scale`/`y` props; `Shot` has no `push`/`y`; and `CameraState` itself has no
`x`/`y`, so `World` renders a bare `scale()` with nothing to pan. Measured on the
rendered pixels, the handset's centre holds to **±0.5 px** across the whole film.

### Rotation is 0, on purpose

`rotate` exists on `CameraState` because a camera has one, and the track
interpolates like the others. Every keyframe is 0.

DECISIONS.md (2026-08-16) records a founder decision that the handset is
"centred, unrotated and the same size in every shot", made because moving it
between beats cost legibility. Half of that decision is now deliberately reversed
(the apparent size changes — that is the whole point of a camera), and it is
recorded there. The roll is not: a ±0.5° tilt on a 45-second film is either
invisible or reads as the *phone* leaning, which is the failure that decision was
about. The field is the seam if it is ever wanted; it is not free to spend.

### Lighting is continuous too

`glow` was a per-shot constant and is now a ninth keyframed track on the same
interpolator, because the halo is a property of the world's light, not of the
clip. It rises with the pushes, peaks at 1.0 on the butterfly/date reveal, and
carries through every cut.

### Screen transitions

Inside the phone, the screen changes. That is what screens do, so twelve of the
fourteen boundaries stay hard cuts — a crossfade between two app screens inside
one continuous handset would read as a *video* effect, not a product one.

The three dissolves survive as crossfades **of the screen content only**
(694, 1130, 1260), and keep the rule DECISIONS.md already records: in a dissolve
only the incoming clip fades, because fading both dips the picture to ~60 %
mid-transition.

The film's opening changed shape: the first shot's 20-frame fade-in is gone
(a black phone screen fading up inside a fully-lit handset reads as a fault) and
is replaced by an 18-frame fade of the **whole world** from black.

### The outro is not an exception

The end card is not in the world — it is not the phone. But the camera does not
stop for it. `Mark` is wrapped in the camera's *relative* motion since
`MARK.from`, so across the last 96 frames the mark inherits the same +5 % push
and the same upward tilt the world is under. The film ends with the camera still
moving.

---

## 5a. What the reference actually does (measured)

`IMG_2325 (1).MP4`, Ditto's iMessage-dating promo. A dark handset on a white
page, so its outer edges are the strongest transitions on any row: tracking them
frame by frame recovers the camera's own curve — width for scale, centre for x,
edge slope across rows for roll.

**One method note, because the first pass was wrong.** It clipped the search to
`x ∈ [20, 720]` to dodge the feed's like/comment furniture, which silently broke
every frame where the handset is wider than that window: the scan from the right
started INSIDE the phone, latched onto screen content, and reported ~450 px for
frames that are really ~790 px. It invented a dozen "fast moves" that do not
exist. The fix was to scan the full width and dodge the furniture by ROW instead.
Every number below is from the corrected pass.

| | reference | our first rebuild | now |
|---|---|---|---|
| camera moving | 48 % of frames, in bursts | **100 %, always** | 39 % |
| holds | 1.5–5.0 s dead still | none | 1.1–5.6 s |
| move duration | 0.3–0.7 s | 2–8 s | 1.8–2.3 s |
| easing | ease-out, **launch 1.0x** | symmetric, launch 4.5x | ease-out, launch 1.11x |
| zoom range | 5.1x (16 % → 84 % of frame width) | 1.32x | 1.45x |
| handset cropped | **85 % of frames** | never | never (founder call) |
| lateral | centred; median offset 3 px | continuous drift ±84 | held, ±34 |
| background | white | black | black (founder call) |
| roll | present on at least one beat | 0 | 0 (founder call) |

A single move, frame by frame — this is the whole language in one line
(handset width in px, f618–640):

```
476 476 476 476 476 476 | 433 386 364 313 308 295 283 278 265 262 257 255 253 | 154 ...
      held                 ← 0.57 s, steps 43,47,22,51,5,13,12,5,13,3,5,2,2 →    cut
```

Big steps first, tiny steps last, then absolute stillness. And it really is
absolute: from f300 to f510 the width reads exactly `355` for **seven seconds**.

**The reference contradicts one reading of the brief, and it is worth saying so.**
The brief asks for *"camera position continues smoothly… No snapping"*; the
reference snaps by 2.7x in 1.7 s. What it never does is **reset** — it arrives at
a framing and stays there. That is the sense in which it is continuous, and it is
what the architecture in §5 already guarantees. The cadence is the part the first
rebuild got wrong.

## 5b. The brightness flash — the other half of "моргание"

Tracking the camera proved it was continuous, and the founder still reported
sharp blinking. Measuring the *rendered pixels* rather than the camera found why,
and it was not the camera at all: **six cuts stepped the frame's mean luminance
in a single frame.**

| cut | shots | before | after |
|---|---|---|---|
| 378 | height → chat | 11.6 → **34.2** (+22.6) | +0.01 |
| 802 | decision → calendar | 36.3 → **15.9** (−20.4) | +0.00 |
| 1030 | time → map | 28.8 → 13.0 (−15.8) | +0.00 |
| 660 | radar → «Готово» | 27.0 → 12.3 (−14.7) | +0.01 |
| 306 | preference → height | 21.5 → 11.5 (−10.0) | +0.12 |
| 222 | gender → preference | 16.1 → 24.3 (+8.2) | +0.04 |

On a black page, inside a handset that no longer moves, a screen tripling in
brightness between two frames is a flash — and the stabler the phone got, the
more the eye had nothing else to look at. The reference has no such thing
because its screens change with real iOS transitions.

The fix is a **6–9 frame crossfade on exactly those six cuts**, sized to the
measured jump. They remain hard cuts: 0.2 s is short enough to read as one, and a
cut between two similarly-lit screens still gets nothing, because it needs
nothing.

Two mechanics make it honest rather than decorative:

- **The outgoing shot is extended to sit underneath the fade** (`tail()` in
  `GennetyHero.tsx`), derived from the incoming shot's `fadeIn` so the two cannot
  drift apart. Without it the incoming would fade in over black — a dark flash in
  place of a bright one. The footage has the slack; the tightest case is
  `time-reveal` using 126 of its 132 frames.
- **The crossfade is LINEAR** (`crossfade()` in `motion.ts`). The first attempt
  reused `fade()`, whose `ease` has an initial slope of 4.5 — so a 9-frame fade
  put most of the change into its first two frames and the flash survived at
  11.3 points on f803. A crossfade that eases is a crossfade that does not work.
  The same correction applies to the world→end-card handover, which was moving
  30 % of the way in one frame.

## 6. Verifying it

### The proof-of-concept render

A **frame range of the real composition**, not a separate one:

```sh
pnpm --filter @gennety/video render:hero:poc
# remotion render GennetyHero out/hero-poc-transitions.mp4 --frames=660-1030
```

Frames 660–1030 (12.3 s) cover four consecutive boundaries plus a dissolve,
including two of the six flashing cuts and the film's largest camera gesture.
Kept alongside it: `hero-poc-transitions-before.mp4` (the original per-scene
camera) and `hero-poc-prev-camera.mp4` (the first rebuild, continuous drift), so
all three rhythms can be watched on the same 12 seconds.

### Measured on the rendered pixels

**The founder's rule, checked on the film rather than on the code.** The
handset's edges are read off each rendered frame and the two things he asked for
are read straight out of them:

```
handset centre      539.0 .. 567.0 px  (frame centre 539.5)
  ... excluding the outro crossfade, where the tracker sees the END CARD:
handset centre      -0.5 .. +0.5 px from dead centre, for the whole film
handset width       572 -> 756 px, and it never gets smaller
width reversals     0   (the 8 flagged frames are all f1261-1267, the end card)
```

**The original defect, still fixed:**

```
                              step at the cut
original per-scene camera     22-32 px
now                            1.4 px  (worst of all 15 boundaries)
```

**Brightness**, whole film, largest single-frame jumps:

```
before   f585 27.97   f378 22.64 *CUT   f510 20.55   f802 20.38 *CUT
         f1261 16.02  f1030 15.80 *CUT  f660 14.71 *CUT  f306 10.02 *CUT
now      f585 23.55   f510 16.37        f552 11.55   f1261 5.54
```

Only two cuts appear anywhere in the top fourteen — f1084 at 4.55 and f862 at
4.06 — and both were already at that level before any of this work. Everything
above them (f510, f552, f585) is inside the Type Radar shot and is the product's
own content: profile cards being swiped. Not ours to remove.

### What to look for by eye

The handset dead centre and never moving sideways; no step in its width at a
boundary; no flash when a screen changes; and — the thing three passes were spent
on — the phone never once smaller than it was a moment ago.

## 7. What was deliberately not done

- **No new transitions.** The brief's rule is that the fix is spatial
  architecture, not more effects. Twelve of the fourteen boundaries are still
  hard cuts and the three dissolves are still 14 frames; nothing was added to
  cover a seam, because there is no seam left to cover.
- **No parallax, particles, or background motion.** The world contains one
  object. Adding a second plane to sell depth would be compensating for a camera
  that works.
- **No change to the cut.** Every `from`, `durationInFrames`, `trim` and `beat`
  in `timeline.ts` is byte-for-byte what it was. The film shows the same product
  frames at the same times; only the framing of them moved.
- **No rotation, and no pan**, for the reason in §5. Both are movements of the
  phone as far as a viewer is concerned.
- **No pull-outs.** One was kept as late as the second pass, on the reasoning
  that the calendar opening deserved a breath. Measured, that breath took the
  handset back to 558 px against an opening 545 px — a framing the film had
  already used, thirty seconds earlier. A reveal that lands somewhere the film
  has been is not a reveal.
- **No music.** Still `musicVolume: 0` by default and still the one genuinely
  open deliverable — see `video-production-plan.md` §G.
