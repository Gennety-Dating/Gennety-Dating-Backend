# Current Gennety acquisition video: filled brief and plan

Use this reference for the specific video described in the originating conversation. It is a filled example, not a permanent requirement for all future videos.

## Creative contract

### Goal

Convince young viewers that Gennety can move them from dating-app fatigue to a real romantic date, then drive registration.

### Audience and feeling

- 18–30, urban, modern, women-first but inclusive.
- Feelings: credible novelty, romantic possibility, desire, and FOMO about time lost to swiping and long chats.

### Deliverables

| Placement | Composition | Resolution | Language | Target duration | Output |
|---|---|---:|---|---:|---|
| Instagram Reels, TikTok, paid vertical social | Vertical Ukrainian | 1080×1920 | Ukrainian | 25 seconds | MP4, H.264, 30 fps |
| Telegram advertising and website | Horizontal Ukrainian | 1920×1080 | Ukrainian | 25 seconds | MP4, H.264, 30 fps |

Treat 30 seconds as the hard ceiling. Design the two layouts separately. Do not produce an English version unless newly requested.

### Concept

`Поки інші свайпають, твій AI-метчмейкер уже веде тебе до реального побачення.`

Open with old-app fatigue, turn the interface into a confident autonomous flow, and end on attractive real people plus a clean registration CTA.

### Message hierarchy

1. `Поки ти свайпаєш, хтось уже йде на побачення.`
2. `Gennety — твій персональний AI-метчмейкер.`
3. The AI uses context, values, preferences, and vibe to find a strong match.
4. The product coordinates shared time and a suitable public venue.
5. A date card and support make the next step obvious.
6. `Менше чатів. Більше побачень.` followed by a fast-registration CTA.

Do not claim a guaranteed perfect partner or relationship. Confirm the exact wording for “24/7”, “verified venue”, “human personal concierge”, and “fast registration” against current product behavior before final copy.

## Scene plan

At 30 fps, 25 seconds equals 750 frames.

| Time | Frames | Beat | Visual proof | Primary copy |
|---:|---:|---|---|---|
| 0.0–2.5 | 0–74 | FOMO hook | Swipe cards and chat fragments collapse into a real-date image | `Поки ти свайпаєш…` / `Хтось уже йде на побачення.` |
| 2.5–6.0 | 75–179 | Autonomous matchmaker | Approved portraits orbit a profile-signal core; context/values/vibe lock in | `Твій AI-метчмейкер шукає за тебе.` |
| 6.0–9.0 | 180–269 | Match reveal | One confident match card, not a catalog | `Не випадковий лайк. Причина зустрітися.` |
| 9.0–13.0 | 270–389 | Shared time | Production-derived calendar selects a date and reveals overlap | `Знаходите спільний час.` |
| 13.0–16.5 | 390–494 | Venue | Map/venue confirmation in a public city location | `Gennety підбирає місце.` |
| 16.5–20.5 | 495–614 | Date ready | Date card assembles with person, time, venue, and support affordance | `Побачення заплановано.` |
| 20.5–25.0 | 615–749 | Romantic payoff and CTA | Approved couple image, logo, strong final hold | `Менше чатів. Більше побачень.` / `Швидка реєстрація →` |

Use a short overlap or graphic bridge between beats without reducing headline reading time below what the final styleframes support.

## Art direction

- Black/soft-white canvas with deep-wine highlights.
- Bold sans-serif headlines, large scale, short lines.
- Rounded borderless UI and restrained liquid glass.
- Modern AI launch-film precision with warm romantic photography.
- Approved attractive portraits; women-first opening and balanced inclusive match flow.
- Blue, green, brown, or yellow may appear as minor semantic accents.
- Show genuine product mechanics through production-derived UI, taps, focus changes, and selective zooms.

## Aspect-ratio strategy

- Vertical: keep headline and decisive UI states in the central safe column; move the phone/product surface lower where platform chrome will not hide it.
- Horizontal: use a two-column relationship between copy and device/UI; use the extra width for portrait choreography and flow, not empty margins.
- Share copy, scene data, palette, media slots, and timing. Use independent responsive layout values.

## Asset plan

- Reuse the official logo from `apps/video/public/brand`.
- Prefer the user's approved portraits and couple image already in `apps/video/public` only if their ad usage remains approved.
- Inspect production Calendar, venue, match-card, and support flows before recreating them.
- Do not search the web for replacement people. Request missing photos from the user.
- Keep raw source files outside Git; store only explicitly approved render-optimized copies.

## Sound direction

Lock the silent visual cut first. Then propose one recommended sound package:

- modern instrumental electronic/alt-pop pulse;
- warm lift at the match reveal and romantic payoff;
- restrained swipe, lock-in, calendar tap, venue confirmation, and date-card SFX;
- no voiceover for the first cut unless comprehension testing shows a need;
- full comprehension when muted;
- only music/SFX cleared for paid social, Telegram, and website use.

## Implementation plan

1. Audit the existing `GennetyAd` compositions and approved assets. Preserve the current 43-second Ukrainian and 30-second English outputs.
2. Add new 25-second Ukrainian composition IDs for this concise campaign rather than silently changing approved legacy timings.
3. Extract reusable brand tokens, media slots, phone shell, calendar, venue, and date-card primitives only where this removes real duplication.
4. Define a typed composition schema for format, CTA text, destination cue, portrait slots, couple image, and optional audio.
5. Implement the scene plan as named timing constants totaling 750 frames. Keep shared content and independent vertical/horizontal layout values.
6. Render hook, AI, calendar, venue, date-card, and CTA styleframes in both formats; review Ukrainian wrapping and social safe areas.
7. Animate the approved styleframes using frame-driven motion. Keep the interface stable during reading holds.
8. Recheck every product label and claim against current source before the copy lock.
9. After silent approval, add licensed music/SFX if authorized and make the audio track configurable.
10. Run version validation, composition discovery, typecheck, lint, key-frame/contact-sheet review, full renders, and ffprobe validation.

## Open decisions before final implementation

Ask only these if they have not been answered at build time:

1. What exact CTA destination cue should each placement show: bot handle, website URL, link in comments, or platform-native button support?
2. Are the current portrait and couple assets cleared for paid advertising in all requested placements?
3. Should the first production pass remain silent, or may a licensed music source be added immediately?
