# Gennety Dating video workspace

This workspace contains the Remotion project for Gennety Dating videos. It is
deliberately isolated from the bot and Telegram Mini App so video tooling and
media assets do not affect production application bundles.

## Commands

From the repository root:

```sh
pnpm dev:video
pnpm render:video
pnpm --filter @gennety/video compositions
pnpm --filter @gennety/video versions
pnpm --filter @gennety/video typecheck
pnpm --filter @gennety/video lint
```

`dev:video` opens Remotion Studio. `render:video` creates all localized final-sized
drafts in the ignored `apps/video/out/` directory:

- `gennety-ad-vertical.mp4` — Ukrainian, 1080×1920, 43 seconds, 30 fps.
- `gennety-ad-horizontal.mp4` — Ukrainian, 1920×1080, 43 seconds, 30 fps.
- `gennety-ad-vertical-en.mp4` — English, 1080×1920, 30 seconds, 30 fps.
- `gennety-ad-horizontal-en.mp4` — English, 1920×1080, 30 seconds, 30 fps.

The Studio compositions are `GennetyAdVertical` and
`GennetyAdHorizontal` for Ukrainian, plus `GennetyAdVerticalEnglish` and
`GennetyAdHorizontalEnglish` for English. They share the same story beats but
use independent responsive layouts rather than cropping one master.

## Current ad structure

1. FOMO hook: old swipe/chat loop versus an actual date.
2. AI matchmaker: profile context, values, and vibe are analyzed.
3. Match reveal using the approved portrait assets.
4. Production-derived Calendar interaction with live overlap states.
5. Production-derived location confirmation in a public venue.
6. Date-card reveal based on the bot's real generated card language.
7. Registration CTA and the approved couple-photo finish.

All on-screen copy, including the Calendar and venue interfaces, is selected
through the typed `language` composition prop. The current build intentionally
has no music or voiceover so sound direction can be selected after the visual
cut is approved.

## `GennetyHero` — the product film

A second, separate deliverable: a **47 s** vertical product film cut entirely
from **six screen recordings of the running product** — no UI is recreated.
It shares this workspace's tooling and brand tokens and nothing else;
`GennetyAd` is untouched.

```sh
pnpm dev:video                                   # Studio, pick "GennetyHero"
pnpm render:hero                                 # 1080×1920 → out/gennety-hero.mp4
pnpm render:hero:poc                             # frames 660-1030, four boundaries
pnpm render:hero:preview                         # 40% scale, ~60s to render
```

| | |
|---|---|
| Composition | `GennetyHero` |
| Output | `out/gennety-hero.mp4`, 1080×1920, 30 fps, H.264, 1405 frames (46.8 s) |
| Source | `src/hero/` |
| Footage | `public/footage/` — 17 clips, 5.4 MB |
| Sources | `IMG_2588` / `2590` / `2604` / `2730` / `2731` / `2771` / `2772`, outside the repo |
| Plan | [`video-production-plan.md`](video-production-plan.md) — the cut |
| Camera | [`motion-audit.md`](motion-audit.md) — the motion system |

The film runs: the profile a person fills in (name, age, gender, who they want
to meet, height) → one honest question and its honest answer → Type Radar
reading their taste → the match decision → the calendar landing on a shared
17:00 → the venue, searched and described in the user's own words and read back
as structure → the date card, which closes on the product's own line, *Error
404: Chat not found. Try real life.* In Ukrainian, matching the capture.

> **The film states a date exactly once** — «вівторок, 25 серп. 17:00», in the
> calendar act. The venue act carries none, and the date card is trimmed to stop
> 0.1 s before its own date line scrolls in. That is what makes the date
> re-shootable from one 9 s recording; it is also perishable, so treat a re-shoot
> of the calendar as maintenance. Production plan §H.0 has the rules.

### The one rule

**No product UI is redrawn.** Every screen on camera is footage; the camera is a
CSS transform on a wrapper, so no product pixel is ever repainted. If a shot
needs a state that was never recorded, the answer is to record it — not to
rebuild it in React.

### The other one rule

**One phone, one world, one camera.** There is exactly one `<Iphone>` in the
film, mounted outside every `<Sequence>`, and exactly one camera transform, read
from a single timeline over absolute composition frames. A scene owns the pixels
on the screen and nothing else.

That is not style, it is the fix for a real defect: the film used to mount a
fresh handset per shot with its own `push()` starting at scale 1.0, so the
camera snapped back 3–5% at twelve of the fourteen cuts. `motion-audit.md` has
the arithmetic. The guard is the signatures — `Iphone` takes no `scale`/`y`,
`Shot` has no `push`/`y` — so the way back to it is a deliberate edit, not a
slip.

### Structure

```
src/hero/
  GennetyHero.tsx      assembly only — the shot list and the audio path
  timeline.ts          THE CUT: every from/duration/trim/width, with reasons
  theme.ts             brand tokens
  camera.ts            THE CAMERA: six held distances, one-way dolly
  camera.probe.ts      continuity check — run it after touching camera.ts
  motion.ts            fade / crossfade / enter / ease — opacity envelopes only
  ui/World.tsx         the one camera transform
  ui/Iphone.tsx        the one drawn handset, fixed at world (0,0)
  ui/Butterfly.tsx     the brand mark, inlined from public/brand
  ui/Texture.tsx       vignette + grain
  scenes/ScreenClip.tsx    one shot, as screen content only
  scenes/Mark.tsx      the end card
```

There is **one** scene component for footage rather than one per beat: every
beat is the same object — a captured screen inside a phone — and what differs is
which clip, where in it and how long. All of that is data. To **retime** any
shot, edit `SHOTS` in `timeline.ts`; to **re-frame** the film, edit the six held
distances in `camera.ts`. The two are independent by construction — the
camera has no idea where the cuts are, so retiming the cut cannot desynchronise
it.

**The phone is static; only the camera approaches.** No pan, no roll, and the
zoom never reverses — `CameraState` has no `x`/`y` at all, so there is nothing to
set. The camera holds still 61% of the time and steps closer five times, one
direction, 558 → 786 px of handset across the film. The cadence and the easing
are measured off the founder's reference (`motion-audit.md` §5a); the
one-direction rule is his (2026-08-18), after a version that oscillated read as
the phone growing and then snapping back to where it began.

**The phone never moves.** It sits at world (0, 0) at a constant 604 px, and
`Shot` has no `push`, `x`, `y` or `rotate` field so it stays that way. What
changes is where the camera is looking from — continuously, across every cut.
Sliding the handset itself between beats was tried and cost legibility: the eye
re-finds the screen on every cut instead of reading it.

Overlapping `from` values are the only thing that produces a dissolve (there are
two, 14 frames each). In a dissolve only the **incoming** shot fades: sequences
layer in array order, so fading both at once dips the picture to ~60% mid-
transition. A hard cut is `fadeIn: 0, fadeOut: 0`.

### Audio

**The film renders silent, on purpose.** No licensed track exists here and the
recordings carry only incidental phone audio — see the plan §G. The path is
wired: drop a track at `public/audio/score.m4a`, set `musicVolume: 0.8` in the
`GennetyHero` `defaultProps` in `src/Root.tsx`. Time it against the cut's
accents: **15.6 s**, **23.1 s**, **30.7 s**, **40.2 s**, **41.5 s**.

### The handset

`ui/Iphone.tsx` draws the BODY only. Every dimension is a fraction of the
screen's WIDTH, taken off a real iPhone 16 Pro — screen radius 0.145, a 0.017
black display border inside a 0.008 titanium rail. Those are measurements; the
first version was proportioned by eye and read as a generic phone. Change one
and check it against the device, not against how it looks alone on a black page.

**The screen, status bar included, is entirely the recording.** Two earlier
builds cropped the strip away (it carries the red screen-recording pill) and
drew a replacement; both read as pasted on, because a drawn strip keeps its own
colour while the app behind it changes. The single intervention now is `PILL` —
one opaque black rounded rect over the recording indicator, at bounds measured
off all three recordings. That shape is the Dynamic Island's own expanded state,
so covering it leaves an island rather than a patch. **Do not enlarge it**: it
is already 1px over the stroke's antialiased edge, and on the Telegram screens
the island's edge is visible against a light header, where excess shows as a
black fringe.

Consequence worth knowing: the clock and battery are real, so they differ
between recordings (02:04 / 02:05 / 19:39, and a red 17 % on the last one). The
change lands on the match-decision cut, where the story jumps forward anyway.

### Re-cutting the footage

`public/footage/` holds trimmed clips, not sources. Regenerate them with
`./scripts/extract-hero-footage.sh [source-dir]` — it reproduces all 15
byte-identically. There is **no crop at all**: the clips are the full 576×1280
phone screen, status bar included, which is what makes the chrome read as the
device's rather than as ours. The `trim` values in `timeline.ts` are measured
against these in-points, so changing a window means re-checking them.

## Couple-photo finish

The approved image is stored as a render-optimized copy at
`public/couple/final-couple.jpg` and configured through `couplePhoto` in both
composition `defaultProps` in `src/Root.tsx`:

```tsx
defaultProps={{
  format: "vertical",
  language: "uk",
  couplePhoto: "couple/final-couple.jpg",
}}
```

When `couplePhoto` is present, the split-profile fallback and its internal
draft label disappear automatically. Portraits are intentionally stored as
render-optimized JPEG copies; the user-supplied source files remain untouched.

## Documentation-based working rules

- Treat each video as a registered composition with explicit width, height,
  frames per second, and duration in frames. Frame `0` is the first frame.
- Drive animation from `useCurrentFrame()` and `useVideoConfig()`. Prefer
  `interpolate()` and `spring()` over wall-clock time or CSS transitions so
  previews and renders stay deterministic.
- Split the story into scene components and place them on the timeline with
  `<Sequence>` / `<Series>`. Keep timing constants close to the scene plan.
- Put local images, fonts, audio, and footage in `public/` and address them with
  `staticFile()`. Use Remotion media components rather than raw browser media
  tags so rendering waits for assets correctly.
- Expose intended creative variations as typed composition props. Validate
  external input before rendering and use `calculateMetadata()` when duration
  or dimensions depend on props or media metadata.
- Use `delayRender()` only for asynchronous work that must finish before a
  frame can render, always pair it with `continueRender()` or `cancelRender()`,
  and prefer Remotion helpers that already manage render delays.
- Keep all `remotion` and `@remotion/*` packages on the exact same version.
  Use the CLI `versions`, `add`, and `upgrade` commands instead of changing one
  Remotion package independently.
- Preview the full timeline in Studio, inspect boundary frames, then run lint,
  typecheck, and a local MP4 render before considering an iteration complete.
- Keep licensed fonts, music, stock footage, user photos, and private data out
  of Git unless their storage and usage rights are explicit.

## Creative planning checklist

Before implementation, define:

1. Goal and single audience action.
2. Platform, aspect ratio, resolution, frame rate, and maximum duration.
3. One-sentence concept, hook, scene beats, and final CTA.
4. Brand references, typography, palette, motion language, and examples to
   avoid.
5. Copy, voiceover, music, sound effects, screenshots, photos, and footage.
6. Caption and localization requirements.
7. Render deliverables: codec/container, audio, thumbnail, and variants.

Then work in passes: storyboard and timings; static art direction; key motion;
media and sound; polish; full render and review. Locking the story before
polishing motion keeps iteration fast.

## Primary references

- https://www.remotion.dev/docs/
- https://www.remotion.dev/docs/the-fundamentals
- https://www.remotion.dev/docs/animating-properties
- https://www.remotion.dev/docs/assets
- https://www.remotion.dev/docs/parameterized-rendering
- https://www.remotion.dev/docs/render
- https://www.remotion.dev/docs/cli
- https://www.remotion.dev/docs/performance
- https://www.remotion.dev/docs/delay-render
- https://www.remotion.dev/docs/license
