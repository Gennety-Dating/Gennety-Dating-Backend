---
name: gennety-remotion-video
description: Plan, create, edit, render, or review Gennety Dating motion videos in the repository's Remotion workspace. Use whenever the user asks for a Gennety video, motion ad, launch video, product demo, social cut, website hero video, or says phrases such as “Сделай видео с Remotion”, “сделай видео с римаушен”, “запусти Remotion”, or “отрендери ролик”. Apply the fixed Gennety audience, product positioning, palette, and visual direction without re-asking them; run an adaptive per-video brief, choose appropriate Remotion tools, produce an implementation plan, build only when requested, and verify final renders.
---

# Gennety Remotion Video

Turn a short request into a complete Gennety video workflow: brief, creative contract, scene plan, Remotion implementation, render QA, and iteration.

## Load context

1. Read the repository `AGENTS.md` and obey its project-memory, approval, verification, documentation, and Git rules.
2. Read [brand-profile.md](references/brand-profile.md) for every task. Treat it as the fixed default and do not ask the user to repeat it.
3. Read [discovery-questionnaire.md](references/discovery-questionnaire.md) for a new video, a substantially new cut, or an incomplete brief.
4. Read [remotion-production.md](references/remotion-production.md) before planning technical implementation, editing Remotion code, adding media, or rendering.
5. Read [current-launch-ad.md](references/current-launch-ad.md) when the request concerns the current acquisition/launch ad or when a concrete example is useful.
6. Inspect `apps/video`, `apps/video/README.md`, current brand assets, the relevant production UI source, and `PRODUCT_SPEC.md` before making claims or recreating screens. Code and product docs override remembered behavior.

If project-local official Remotion skills are available, use them as the current technical layer:

- `$remotion-docs` before relying on an unfamiliar or version-sensitive API;
- `$remotion-best-practices` and `$remotion-markup` for implementation;
- `$remotion-captions` for subtitles;
- `$remotion-render` for final output.

Do not use `$remotion-create` when `apps/video` already exists.

## Select the operating mode

Infer the narrowest mode that satisfies the request:

- **Brief:** interview, summarize, and stop before implementation.
- **Plan:** complete the brief and write a production-ready creative and technical plan.
- **Build/edit:** plan, implement in `apps/video`, and verify the affected compositions.
- **Render/QA:** preserve approved creative, render requested variants, and inspect the output.

“Сделай видео” authorizes planning and implementation. “Помоги сформулировать”, “построй план”, “проанализируй”, or “предложи варианты” does not authorize editing video code.

## Run the adaptive brief

1. Extract every answer already present in the conversation and repository. Never ask it twice.
2. Apply the fixed brand profile silently. Ask about a fixed field only when the user explicitly proposes an override or the product source of truth conflicts with it.
3. Ask only missing, decision-changing questions. Use batches of one to three short questions; mirror the user's language.
4. Prioritize blocking decisions in this order: objective and CTA, placement/format, duration, message hierarchy, available assets and rights, audio, then delivery details.
5. Offer two or three concrete options when a user may not know the vocabulary. Put the recommended option first and explain its consequence in one sentence.
6. If the brief is already sufficient, do not perform a ceremonial questionnaire. State the inferred brief and proceed.
7. Separate facts into:
   - `Fixed brand profile`
   - `This video`
   - `Assumptions`
   - `Open decisions`
8. Pause only for a missing choice that would materially change the story, rights, production scope, or delivery. Otherwise use the documented defaults and identify them as assumptions.

## Create the creative contract

Before code, produce a compact contract containing:

1. Goal, audience action, placement, duration, languages, and deliverables.
2. One-sentence concept and emotional arc.
3. Hook, product proof, message order, and final CTA.
4. Scene-by-scene timing in seconds and frames.
5. Copy deck, UI/screens, portraits/footage, brand assets, and audio requirements.
6. Aspect-ratio strategy and social safe areas.
7. Technical component map and Remotion tool choices.
8. Acceptance criteria and unresolved decisions.

Recommend one direction. Include alternatives only when they represent genuinely different creative strategies. Never begin decorative polish before the story, copy hierarchy, and timing are coherent.

## Plan implementation

Build the plan in these passes:

1. **Audit:** inspect existing compositions and approved assets; identify what to reuse and what must remain untouched.
2. **Story:** lock the hook, beats, CTA, and timing budget.
3. **Styleframes:** create or render stills for the hook, a representative product scene, and CTA.
4. **Motion:** implement deterministic frame-driven animation and transitions.
5. **Product UI:** recreate truthful production-derived interactions and validate labels/states against current source.
6. **Media and sound:** add approved portraits, footage, music, SFX, voiceover, and captions only with clear rights and scope.
7. **Responsive variants:** design vertical and horizontal compositions independently from shared scene primitives; do not crop one master blindly.
8. **QA:** inspect key frames, transitions, safe areas, complete renders, duration, codec, and audio.
9. **Iteration:** change only the feedback surface, preserve approved scenes, and rerender affected variants first.

## Implement with guardrails

- Work inside `apps/video`; do not couple video tooling to the bot, API, database, or Mini App runtime.
- Reuse current assets and components when they fit. Do not overwrite an approved composition when a new campaign can use a new ID.
- Keep variants typed and validated. Prefer composition props for language, format, CTA, and replaceable media.
- Animate from frames. Do not use CSS transitions, CSS keyframes, wall-clock time, or nondeterministic randomness.
- Keep text readable without sound and keep essential vertical content outside platform overlay zones.
- Use actual product states and honest claims. Never invent a feature, metric, safety guarantee, “perfect match” promise, or human-service availability.
- Prefer user-supplied or explicitly approved portraits. Do not browse for people, generate people, or commit private user media without permission and usage rights.
- Do not add Remotion packages or other dependencies without approval. When approved, use the Remotion CLI so all `remotion` and `@remotion/*` versions remain aligned.
- Do not commit rendered outputs, build artifacts, raw source media, private data, or unlicensed music.

## Verify and hand off

Follow [remotion-production.md](references/remotion-production.md). At minimum:

1. Run Remotion version validation and composition discovery.
2. Run video-package typecheck and lint.
3. Render representative stills at scene starts, midpoints, transition boundaries, and CTA.
4. Review both aspect ratios visually, including social safe areas and text stability.
5. Render the requested final MP4 files and validate frame count, duration, dimensions, codec, and audio stream.
6. Report output paths, creative decisions, checks run, rights assumptions, and any remaining choice.
7. Complete the repository's documentation, Obsidian, commit, and push workflow after file changes.
