# `GennetyHero` — motion audit and camera redesign

> Companion to `video-production-plan.md` (which owns the *cut*: which clip,
> which window, why). This file owns the *camera*: why the old motion read as a
> reset on every edit, and what replaced it.
>
> Scope note, stated up front because it changes what "reference" means below:
> **no separate reference video was supplied in this workspace.** A filesystem
> sweep of `~/Desktop`, `~/Downloads` and `apps/video/out/` found only the three
> founder screen recordings the film is already cut from, the current render
> (`out/gennety-hero.mp4`, 45.25 s) and the earlier `GennetyAd` renders. So the
> target motion language below is derived from the brief plus the existing edit,
> not from footage. Everything it asks for — one continuous phone, one continuous
> camera, inherited state at every boundary — is fully specified in the brief and
> is what has been built. If a reference clip does turn up, the camera timeline is
> **17 numbers in one file** (`src/hero/camera.ts`) and can be re-timed against it
> without touching a single scene.

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
└── World                       ← ONE camera transform, for the entire 1356 frames
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

### The interpolation

Not `interpolate()` with an easing, which is C⁰ — position matches at a keyframe
and *velocity* does not, so a keyframe reads as a small snap even when the number
is continuous.

The tracks are **monotone cubic Hermite (PCHIP)** splines, which give:

- **C¹ continuity** — velocity is continuous everywhere, so the camera has
  inertia rather than a sequence of eased segments glued together;
- **no overshoot** — a monotone run of keyframes never bulges past them, which a
  Catmull–Rom spline would (and which on a zoom reads as a bounce);
- **automatic rest at a direction change** — a local extremum gets a zero
  tangent, so the camera decelerates *into* a turn and accelerates out of it,
  which is what a hand on a fluid head actually does;
- **a real hold from two equal keyframes** — the tangent is zero at both ends, so
  the camera genuinely stops rather than creeping.

Endpoint tangents are pinned to zero: the film starts and ends with the camera at
rest.

### The camera timeline

Seventeen keyframes over 1356 frames. Nine of them do **not** sit on a shot
boundary — deliberately, because a camera move that starts on a cut is a camera
move the cut caused.

| frame | time | x | y | scale | intent |
|---|---|---|---|---|---|
| 0 | 0:00 | 0 | −34 | 0.895 | establish — the whole handset with air around it |
| 144 | 0:04.8 | −32 | −20 | 0.952 | slow push begins; drift left |
| 222 | 0:07.4 | −52 | −6 | 0.980 | push completes as the preference columns land |
| 306 | 0:10.2 | −70 | 10 | **0.980** | **hold** — zoom stops, the drift keeps going |
| 378 | 0:12.6 | −84 | 26 | 1.006 | push resumes; the lateral drift reaches its far left and turns |
| 468 | 0:15.6 | 4 | 26 | 1.032 | sweeps back to centre as the radar opens |
| 560 | 0:18.7 | 44 | 8 | 1.128 | strong push — the AI reading a taste |
| 660 | 0:22.0 | 22 | −12 | 1.092 | easing off; the radar closes on «Готово» |
| 708 | 0:23.6 | 0 | −18 | 1.040 | pull out; the film turns |
| 762 | 0:25.4 | 0 | −6 | **1.152** | the strongest push in the film — «піти з ним на побачення?» |
| 862 | 0:28.7 | −18 | 22 | 0.995 | the biggest gesture: pull back as planning opens |
| 912 | 0:30.4 | −6 | 22 | 1.080 | punch in on 13:00 lighting up |
| 1000 | 0:33.3 | 14 | −26 | 0.958 | pull out to let the brand moment breathe |
| 1084 | 0:36.1 | 48 | 18 | 1.014 | drift right and down into the departure map |
| 1144 | 0:38.1 | 18 | 34 | **1.014** | **hold** — the venue question; only the drift continues |
| 1274 | 0:42.5 | 0 | −10 | 1.136 | the last push, onto the date card and its line |
| 1356 | 0:45.2 | 0 | −30 | 1.185 | keeps travelling through the outro |

Six changes of zoom direction, four of lateral direction, two genuine holds. The
brief's rule — *do not make the camera constantly zoom in* — is met by the
`scale` column changing sign six times and standing still twice, not by making
the moves smaller.

### What the phone does

Nothing. `<Iphone>` is centred at world (0, 0) with no transform of its own; the
`scale` and `y` props are gone from its signature entirely, so a future scene
*cannot* reintroduce a per-scene phone transform without changing the component.
`Shot` likewise lost its `push` and `y` fields.

### Rotation is 0 at every keyframe, on purpose

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

## 6. Verifying it

### The proof-of-concept render

It is a **frame range of the real composition**, not a separate one — a second
composition could drift from the film it is meant to prove:

```sh
pnpm --filter @gennety/video render:hero:poc
# remotion render GennetyHero out/hero-poc-transitions.mp4 --frames=660-1030
```

Frames 660–1030 (12.3 s, `out/hero-poc-transitions.mp4`) cover **four
consecutive boundaries plus a dissolve**, chosen because they include the three
worst offenders in §3 and the film's largest camera gesture:

| boundary | frame | POC frame | old | new |
|---|---|---|---|---|
| radar-swipe → radar-done | 660 | 0 | −4.74 % snap (32 px) | mid-pull, no step |
| radar-done → match-decision | 694 | 34 | two handsets at 1.021 / 1.000, edges doubled | one handset, still pulling |
| decision → cal-dates | 802 | 142 | −4.27 % snap (28 px) | mid-pull-back, no step |
| cal-dates → cal-overlap | 862 | 202 | −3.33 % snap (22 px) | the camera's own turn, no step |
| cal-overlap → time-reveal | 928 | 268 | −4.24 % snap (28 px) | push → pull reversal, no step |

### Measured, not eyeballed

The handset's width is read straight off the rendered pixels — one row through
the middle of the frame, thresholded against the near-black page — for the frame
before, at and after each boundary.

The **same range of the old composition** was re-rendered from a detached git
worktree at the pre-change commit and sits next to the new one as
`out/hero-poc-transitions-before.mp4`, so the two are the same measurement on the
same frames rather than a claim against a number in a document. (`out/` is
gitignored, so if either is missing, re-render: `git worktree add --detach <sha>`
plus `render:hero:poc`.)

```
                                   POC frames        step at the cut
BEFORE  out/hero-poc-transitions-before.mp4
  cut @ 802   f140=662 f141=662 f142=634 f143=634 f144=636      28 px
  cut @ 862   f200=656 f201=656 f202=634 f203=634 f204=636      22 px
  cut @ 928   f266=662 f267=662 f268=634 f269=634 f270=635      28 px

AFTER   out/hero-poc-transitions.mp4
  cut @ 802   f140=699 f141=697 f142=696 f143=695 f144=693       2 px
  cut @ 862   f200=632 f201=632 f202=631 f203=632 f204=632       1 px
  cut @ 928   f266=680 f267=679 f268=679 f269=677 f270=676       2 px
```

The boundary at 660 is POC frame 0, so its "before" step happened on the frame
*preceding* the range and is not visible in this clip; measured on the previous
full render it was **32 px** (f658=666 f659=666 f660=634), the largest of the
four. The new film reads 694 → 693 → 692 there.

The old numbers are the reset made literal: the handset was 22–32 px wider on
the last frame of a shot than on the first frame of the next, in **one frame**.
The new ones are the camera's ordinary per-frame travel, and are the same size
at a cut as anywhere else — which is the actual claim, not "small".

Two further things worth reading off that table. `f862` sits at 631–632 px while
`f660` sits at 692–694: the camera really does pull back ~9 % as planning opens,
which the old film could not do at all because every shot was pinned to 1.0.
And the widths *decrease* monotonically through 660 and 928 — the camera is
mid-pull across both, so the cut lands inside a move rather than restarting one.

### The machine check

```sh
pnpm --filter @gennety/video exec tsx src/hero/camera.probe.ts
```

It walks all 1356 frames and reports peak speed and peak *acceleration* for
every track, the largest step that lands on a cut as a fraction of the largest
step anywhere, the tightest framing margin, and the worst upscale. Current
output:

```
scale  peak speed 0.00311 x/frame @ f734   peak accel -0.000222 @ f760
       largest step across a CUT  0.00225 x   (72 % of the film's largest step)
x      peak speed 1.33830 px/frame @ f429  peak accel  0.050788 @ f378
       largest step across a CUT  0.62179 px  (46 % of the film's largest step)
y      peak speed -0.81804 px/frame @ f955  peak accel 0.036345 @ f998
       largest step across a CUT  0.60071 px  (73 % of the film's largest step)
framing      tightest margin 111.3 px (vertical) @ f1355
resolution   worst upscale 1.243x (camera peaks at 1.185)
PASS
```

The line that matters is *"largest step across a CUT ... % of the film's largest
step"*. Under 100 % means no boundary carries the film's fastest motion — i.e.
the cuts are not where the camera is doing anything special, which is the whole
target. The probe **fails** if a cut ever carries the largest scale step, if the
handset comes within 40 px of an edge, or if the source is upscaled past 1.35x.

### What to look for by eye

At each boundary in the POC: no step in the handset's width, no re-centre, no
doubled edge during the 694 dissolve, and — the one that actually matters — no
change in the *rate* the frame is travelling at the moment the screen content
changes.

---

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
- **No rotation**, for the reason in §5.
- **No music.** Still `musicVolume: 0` by default and still the one genuinely
  open deliverable — see `video-production-plan.md` §G.
