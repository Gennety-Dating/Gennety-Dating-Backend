# Gennety Remotion production playbook

## Current workspace

- Location: `apps/video`
- Stack: Remotion + React + TypeScript + Zod.
- Current installed Remotion line: `4.0.489`; verify rather than assume before each implementation.
- Existing entry: `apps/video/src/index.ts`
- Registered compositions: `apps/video/src/Root.tsx`
- Brand and media assets: `apps/video/public`
- Draft renders: `apps/video/out` and `apps/video/build`, both excluded from source control.

Use the repository scripts when the local workspace runtime is healthy:

```sh
pnpm dev:video
pnpm --filter @gennety/video compositions
pnpm --filter @gennety/video versions
pnpm --filter @gennety/video typecheck
pnpm --filter @gennety/video lint
pnpm --filter @gennety/video render:vertical
pnpm --filter @gennety/video render:horizontal
pnpm render:video
```

If an agent runtime exposes a different pnpm store and attempts an unrelated reinstall, stop that command and use the repository's intended Node/pnpm environment or the local Remotion CLI with a valid Node binary. Do not purge or recreate `node_modules` as a workaround.

## Documentation freshness

Use current official Remotion documentation for version-sensitive work. Remotion supports Markdown pages by appending `.md` to a documentation URL.

Primary pages:

- `https://www.remotion.dev/docs/the-fundamentals.md`
- `https://www.remotion.dev/docs/animating-properties.md`
- `https://www.remotion.dev/docs/sequence.md`
- `https://www.remotion.dev/docs/series.md`
- `https://www.remotion.dev/docs/transitions/transitionseries.md`
- `https://www.remotion.dev/docs/assets.md`
- `https://www.remotion.dev/docs/parameterized-rendering.md`
- `https://www.remotion.dev/docs/calculate-metadata.md`
- `https://www.remotion.dev/docs/render.md`
- `https://www.remotion.dev/docs/cli.md`
- `https://www.remotion.dev/docs/ai/skills.md`

Use `$remotion-docs` to search before adding or changing an unfamiliar API. Prefer official documentation and package source over memory.

## Tool selection

| Need | Preferred approach | Notes |
|---|---|---|
| Scene and UI animation | Core Remotion + React | Use `useCurrentFrame()`, `useVideoConfig()`, `interpolate()`, and intentional easing. |
| Timeline structure | `Sequence`, `Series`, or approved `@remotion/transitions` | Account for overlap when calculating total duration. |
| Images and logos | `public/` + `staticFile()` + `Img` | Waits for images before render; preserve aspect ratio. |
| Audio/video media | Approved Remotion media components | `@remotion/media` is not currently installed; ask before adding it. |
| Variable copy/media/formats | Typed props + Zod schema | Provide useful `defaultProps` for Studio. |
| Variable metadata | `calculateMetadata()` | Use when duration, dimensions, or props depend on input or media metadata. |
| Captions | Remotion `Caption` JSON workflow | Use `$remotion-captions`; keep captions editable and timed. |
| Media metadata, trim, transcode | `ffprobe`/`ffmpeg` or Mediabunny when appropriate | Do not add a browser media stack for a one-off local check. |
| Product UI evidence | Inspect current source and recreate deterministic states | Avoid rendering a live authenticated app or embedding an iframe. |
| New portrait or texture | User-supplied asset first; image generation only with permission | Confirm ad rights and avoid synthetic people by default. |

Do not add a package merely because an effect exists. Start with HTML/CSS/SVG and core Remotion. If a package materially improves the result, ask for dependency approval and install it with the Remotion CLI so package versions stay aligned.

## Composition architecture

1. Register every deliverable as a composition with explicit ID, width, height, fps, and duration.
2. Use frame `0` as the first frame and `durationInFrames - 1` as the last.
3. Keep campaign timing in a named scene plan; calculate total duration from it when practical.
4. Use shared data, tokens, and scene primitives across formats, but give 9:16 and 16:9 their own layout decisions.
5. Expose legitimate variants through typed props rather than scattered conditionals.
6. Keep scenes focused and named. Use one primary communication job per scene.
7. Preserve previously approved compositions. Add a new composition ID for a materially different campaign or duration unless the user asks to replace the old one.

## Animation rules

- Drive every changing value from the current frame.
- Clamp interpolations unless deliberate extrapolation is visible and tested.
- Prefer clean Bézier easing for product motion. Use springs only where physical response improves the feel.
- Avoid CSS transitions, keyframes, and time-based browser animation.
- Stabilize text after entrance; do not continuously transform rasterized text when a hold is intended.
- Keep blur, glow, and glass layers bounded; excessive full-frame blur is slow and can cause visual instability.
- Make taps/clicks, selected states, and screen transitions legible without turning the video into a slow tutorial.

## Layout and readability

- Render text at final resolution and review actual Ukrainian line breaks.
- Keep one dominant headline and one supporting layer per beat.
- Place essential 9:16 content away from the top app chrome, right-side action rail, and lower caption/CTA area of Reels/TikTok.
- Build a horizontal layout, not a center crop of the vertical phone.
- Test the first frame, final frame, and both sides of every scene boundary.
- Ensure the story and CTA remain understandable with audio muted.

## Asset and claim integrity

- Use `staticFile()` for local public assets.
- Make render-optimized copies only after preserving the source and confirming rights.
- Strip metadata from copied portrait assets where appropriate.
- Do not commit raw user photos, licensed audio source masters, private screenshots, or real user data.
- Recreate product screens from current code and labels. Mark stylized views as design representations when they are not production-exact.
- Verify all marketing claims against `PRODUCT_SPEC.md`, current code, and current runtime configuration.

## Quality gates

Run the narrowest checks while iterating, then complete all applicable gates:

1. `versions`: every `remotion` and `@remotion/*` package must match exactly.
2. `compositions`: verify IDs, resolution, fps, duration, and default props.
3. `typecheck` and `lint` for `@gennety/video`.
4. Still renders for hook, each major product state, transition boundaries, and CTA.
5. A contact sheet for each final aspect ratio.
6. Consecutive-frame checks around text/UI transitions when jitter is plausible.
7. Full affected MP4 renders.
8. `ffprobe` verification of dimensions, fps, frame count, duration, video codec, and audio stream.
9. Visual review of complete renders, not only Studio preview.
10. Muted comprehension, caption accuracy, audio level, loop/end behavior, and social safe areas.

Keep intermediate renders in `apps/video/out`. Never stage them.

## Iteration protocol

Translate feedback into a scoped change list. Preserve every explicitly approved element. Render affected stills first, then the affected composition, then all final variants only after the change is visually confirmed. Record durable creative or production decisions in the project session/changelog memory when required by `AGENTS.md`.
