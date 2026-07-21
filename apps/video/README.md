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

- `gennety-ad-vertical.mp4` — Ukrainian, 1080×1920, 31 seconds, 30 fps.
- `gennety-ad-horizontal.mp4` — Ukrainian, 1920×1080, 31 seconds, 30 fps.
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
