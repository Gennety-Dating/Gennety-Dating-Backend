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

A second, separate deliverable: a ~46 s vertical product film cut from **real
screen recordings of the running product**, not from recreated UI. It shares
this workspace's tooling and brand tokens and nothing else — `GennetyAd` is
untouched.

```sh
pnpm dev:video                                   # Studio, pick "GennetyHero"
pnpm render:hero                                 # 1080×1920 → out/gennety-hero.mp4
pnpm render:hero:preview                         # 40% scale, ~45s to render
```

| | |
|---|---|
| Composition | `GennetyHero` |
| Output | `out/gennety-hero.mp4`, 1080×1920, 30 fps, H.264, 1380 frames (46.0 s) |
| Source | `src/hero/` |
| Footage | `public/footage/` (11 clips), `public/audio/score.m4a` |
| Plan | [`video-production-plan.md`](video-production-plan.md) |

### The one rule

**No product UI is redrawn.** Every screen on camera is footage trimmed from a
real capture; the camera is a CSS transform on a wrapper, so no product pixel is
ever repainted. If a shot needs a state that was never recorded, the answer is
to record it — not to rebuild it in React. `video-production-plan.md` §E records
why even the renderable production components (`Ticket3D` and friends) are
deliberately unused.

### Structure

```
src/hero/
  GennetyHero.tsx   assembly only — ten <Sequence>s and the audio path
  timeline.ts       the cut: every from/duration/trim, with the reasons
  theme.ts          brand tokens + the captured screen's ratio
  motion.ts         fade / enter / push / ease — the whole motion system
  ui/               Phone (device frame), Butterfly (brand mark), Texture
  scenes/           one file per shot
```

To **retime** a shot, edit `TIMELINE` in `timeline.ts`. Overlapping `from`
values are the only thing that produces a dissolve; everything else is a hard
cut, and a hard-cut scene passes `fade(frame, duration, 0, 0)`. To **reframe**
one, edit its scene file. Nothing about timing lives in a scene component.

### Audio

**The film renders silent, on purpose.** There is no licensed track here, and
the only first-party bed available (the sound design from `Gennety Ad video.mp4`)
measured unusable — mean level −35…−50 dB across most of its length with a
30.4 LU range, i.e. inaudible for ~30 of the 46 seconds. See the plan §A.4.

The path is wired and the envelope is shaped. Adding a track is:

1. drop it at `public/audio/score.m4a`
2. set `musicVolume: 0.8` in the `GennetyHero` `defaultProps` in `src/Root.tsx`

Time it against the cut's three accents: **16.5 s** (the brand turn), **31.6 s**
(the outcome burst), **36.9 s** (real life).

### Re-cutting the footage

`public/footage/` holds trimmed clips, not sources. The sources live outside the
repo (see the plan §A.1) and are the founder's own recordings. Every clip was
cut with `ffmpeg`, crop-first, to remove Telegram's Russian nav row and the red
`Beta Dev` badge — that crop is the reason the device frame exists at all. The
exact windows are in the plan §B; re-extracting with different ones means
re-checking `TRIM` in `timeline.ts`, which is measured against them.

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
