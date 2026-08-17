# Gennety — product film production plan (`GennetyHero`)

> Target: 1080×1920, 30 fps, H.264, ~45 s.
> This plan is the audit that precedes implementation. It records what footage
> actually exists, what it shows, what is unusable and why, and the editorial
> decision taken — so the cut can be argued with rather than re-derived.

---

## 0. The finding that shapes everything

**Gennety's own onboarding intro is already the pitch film.** The Mini App's
visual intro walks: loneliness → the cost of dating apps (5,073 swipes / $200)
→ competitor cards ("it feels more like scrolling a TikTok feed") → "So we
built Gennety" → the AI matchmaker promise → you pick when → the date. In the
product's own typography, on the product's own black, with the product's own
motion.

That reframes the job. This is **not** "assemble a montage of screens". It is
**camera-direct a film the product already performs**, cut it to a rhythm, and
bookend it with real life so the last thing the viewer sees is two people
meeting rather than an interface.

Consequence: almost nothing needs rebuilding. The plan is Priority 1
(recording) for ~85% of screen time, Priority 3 (new brand animation) for the
logo beat only, and **zero** Priority 2 — no production React component is
rendered directly, because the recordings already carry those states with
higher fidelity than a deterministic re-render would.

---

## A. Asset inventory

Nothing was newly recorded for this brief. Everything below already existed on
the machine and was located by a filesystem-wide sweep (no video anywhere is
newer than 2026-07-24).

### A.1 Video

| File | Res | Dur | fps | What it is | Verdict |
|---|---|---|---|---|---|
| `~/Downloads/IMG_1798.MP4` | 592×1280 | 8:23 | 30 | **Full onboarding walkthrough** — visual intro, AI handoff, chat profile, photos, verification, main menu | **PRIMARY.** Low-res but complete |
| `~/Downloads/Gennety Ads.mp4` | 1080×2336 | 0:42 | 60 | Conversational profile completion in Telegram chat | **HD chat source** |
| `~/Downloads/IMG_1800.MP4` | 592×1280 | 1:36 | 30 | Same session as above, lower res | Redundant — skip |
| `~/Downloads/Gennety Ad video.mp4` | 1920×1080 | 2:03 | 60 | Produced AI brand film (loneliness → meeting), **has a continuous score** | **LIFESTYLE + AUDIO** |
| `~/Downloads/dance scene.mp4` | 1920×1080 | 0:11 | 60 | Party/dance clip | Held in reserve |
| `~/Downloads/IMG_2325.MP4` | 848×480 | 0:44 | 30 | **The reference** — a competitor's ("Ditto") product film, screen-captured off a social post | Language reference only |
| `~/Downloads/Gennety Ad.mp4` | 1080×1920 | 1:53 | 60 | Previously produced Gennety ad (Ukrainian), mock UI | Prior art — not source |
| `~/Desktop/gennety-ad-vertical.mp4` | 1080×1920 | 0:43 | 30 | Output of the existing `GennetyAd` Remotion comp | Prior art |
| `~/Desktop/Figma Workspace/telegram_demo.mp4` | 1080×2212 | 0:10 | 30 | Generic "FeatureBot" Figma mock | **Not Gennety** — discard |

### A.2 Stills, brand, fonts (already in `apps/video/public/`)

- `brand/butterfly-logo.svg` — the brand mark, shared with the bot's date/match cards
- `brand/gennety-icon.png`, `brand/logo-wordmark.png`
- `fonts/` — Archivo Black, Roboto (Regular/Medium/Bold), Unbounded (cyr+lat)
- `portraits/`, `places/`, `couple/final-couple.jpg` — assets of the **existing** ad; not used here (this film uses real captures, not staged portraits)

### A.3 Design system (`gennety_design_system/DESIGN.md`, PRODUCT_SPEC §3.7a)

`INK #030303` · `SOFT #F5F5F5` · `WINE #8B253B` · `WINE_LIGHT #D16B80` ·
`MUTED #A7A2A6` · `SURFACE #161616`. Dark-first, borders over shadows,
generous negative space. The film inherits this verbatim.

### A.4 Audio — planned, then ruled out on measurement

No music library exists. `Gennety Ad video.mp4` carries first-party audio, and
the plan's first draft made it the soundtrack on the strength of a coarse check
(continuous, only two silences). **A proper profile killed that.** Measured in
5 s windows across all 123 s:

```
  0s −44.2   25s −44.1   50s −14.3   75s −50.7   100s −40.5
 10s −39.4   35s −43.2   60s −44.7   85s −33.2   110s −42.1
 15s −35.8   40s −42.3   65s −44.9   90s −35.4   115s −91.0
```

It is **sparse sound design, not a score**: mean level −35…−50 dB for most of
its length, one loud sting at 50–58 s, and a **30.4 LU** loudness range. Cut to
this picture it is inaudible for roughly thirty of the forty-six seconds, and
normalising a −50 dB bed to broadcast level is +34 dB of gain onto an unknown
noise floor — which cannot be judged without listening to it.

**Decision: the film ships silent, with the audio path wired.** That is this
workspace's existing convention (`apps/video/README.md`: *"no music/voiceover by
design — sound direction is chosen after the visual cut is approved"*), it
avoids shipping a licensing problem, and it is honest — thirty seconds of
inaudible ambient would be a gap disguised as a soundtrack. Dropping in a
licensed track is one file swap plus one prop; see §F.

The reference film's own music is categorically excluded: it is a competitor's
licensed track.

---

## B. Recording map — what each capture actually shows

### B.1 `IMG_1798.MP4` (the primary, timecoded)

| Timecode | Product state | Usable |
|---|---|---|
| 0:00–0:09 | ngrok geolocation permission dialog | ✗ dev artifact |
| 0:10–0:34 | Intro copy: "only 3% ever make it to a date" / "we're all wrapped up in work" / "we've stopped seeing each other" | ✓ |
| 0:34–0:40 | "But — what does it cost to find a relationship in 2026?" | ✓ |
| **0:41–0:48** | **Stat cards: `5073 swipes` → `$200 in in-app purchases`** | ✓✓ hero |
| 0:50–0:58 | "Modern dating apps eat up so much time…" / "We burn out before we find *our* person" | ✓ |
| **1:00–1:12** | **Competitor cards — Daniel 21 / Marco 26 / Mia 25, swipe-app UI, captions "It feels more like scrolling a TikTok feed" / "You spend weeks on chats that lead nowhere"** | ✓✓ hero |
| **1:13–1:17** | **"So we built Gennety"** — the brand turn | ✓✓ hero |
| 1:18–1:26 | "You get a personal AI matchmaker that works around the clock to find the person who perfectly fits you" | ✓ |
| 1:26–1:30 | "We search 24/7" | ✓ |
| **1:28–1:41** | **"Skip straight to the date" (dinner photo) / "You pick when" (calendar) / "Just before you meet" (sparkle)** | ✓✓ |
| 1:41–1:45 | AI-memory import screen (ChatGPT/Claude/Gemini icons) | ✓ |
| **1:44–1:52** | **AI handoff orb — "Passing context to the bot" → "Done"** | ✓✓ hero |
| 1:53–4:10 | Bot chat: phone confirmed → name → gender → preference → height → hobbies → partner qualities → Friday night | ✓ but low-res + keyboard |
| **4:10–4:50** | **Gemini app — user pasting the Magic Prompt** | ✗✗ breaks the illusion entirely |
| 4:55–5:10 | "Building your profile…" | ✓ |
| 5:10–6:30 | Photo upload, picker, face detection, rejections | ✓ (cluttered) |
| 6:50–7:20 | Verification CTA — "Verify now / Skip for now" | ✓ |
| 8:05–8:23 | Main menu (My Profile, Profile Video, My Tickets, …) | ✓ |

### B.2 `Gennety Ads.mp4` (HD chat)

| Timecode | State | Usable |
|---|---|---|
| 0:00–0:08 | Telegram chat list, keyboard, dictation UI | ✗ |
| **0:08–0:17** | **Clean chat, no keyboard: "In talking with a guy, what matters more to you — chatting about everything, or keeping it to the point?"** | ✓✓ the one HD product moment |
| 0:17–0:42 | Keyboard-dominated typing, autocorrect bar, visible typos | ✗ |

### B.3 `Gennety Ad video.mp4` (lifestyle + score)

| Timecode | Shot |
|---|---|
| 0:00–0:09 | Woman alone at a restaurant table, a man opposite, no connection |
| 0:09–0:20 | Empty office at night |
| **0:21–0:31** | **Rain, night street, walking alone** |
| **0:34–0:43** | **In bed, face lit by the phone** |
| 0:50–1:00 | Title cards: "LOVE / WILL NEVER COME" → "the best time is always now" |
| **1:02–1:12** | **Park bench at sunset — two people meeting** |
| **1:24–1:28** | **Running through a golden field** |
| **1:30–1:37** | **Festival, string lights, laughing** |
| 1:40–1:47 | Tent at dusk |
| 1:52–2:03 | Closing titles / "Join Gennety - Beta Access" |

---

## C. Recording quality audit

Stated plainly, because it constrains the cut rather than being cosmetic:

1. **Resolution.** The primary capture is **592×1280** against a 1080×1920
   delivery. Mitigation is compositional, not a filter: the phone is framed at
   ~62 % of frame width (≈670 px), so the screen upscales **1.13×** — invisible.
   The two screen-only close-ups are the only shots that would betray it, so
   both are taken from the **1080-wide** `Gennety Ads.mp4` instead.
2. **It is the DEV bot.** The chat carries "Gennety Deta dev" and a red
   `Beta Dev` badge. Any Telegram-chrome shot must crop or frame it out — the
   film never shows the chat header. (The Mini App intro screens carry no such
   badge, which is a further reason the intro carries the film.)
3. **Russian Telegram chrome** ("Закрыть", "Назад", "Сообщение") against
   English product copy. Cropped out by the device frame.
4. **Two hard-unusable regions**: the ngrok permission dialog (0:00–0:09) and
   the Gemini paste (4:10–4:50). The latter would show a Gennety user working
   inside a competitor's AI app — excluded categorically.
5. **Typing artifacts.** Real typed answers carry typos ("Bar or something more
   special likr rooftop") and an iOS autocorrect bar. The cut therefore uses
   the bot's **questions** and the settled state, never the act of typing.
6. **The reference is 848×480**, screen-captured from a social feed with a
   visible like-count. Language reference only — no frame of it is used.
7. **No new recording is requested.** Everything the film needs exists.

---

## D. What the reference actually taught

`IMG_2325.MP4` is a competitor's product film. Cut timings, measured:

```
6.2 → 17.1 → 20.8 → 25.0 → 26.6 → 27.3 → 32.8 → 35.1 → 37.6
→ 37.7 → 37.8 → 37.9 → 38.8 → 39.7 → 42.1 → 43.2 → 44.5
```

The shape is an **accelerando**: two very long opening holds (6.2 s, then
10.9 s), a middle that tightens to 4 s then 2.5 s, a **burst of six cuts inside
2.1 s** at 37.6–39.7, then lifestyle, then logo. The long holds are not static
— the product animates *inside* one continuous shot.

Adopted as language: long holds early where the UI performs itself; tighten
through the middle; one deliberate burst before the payoff; end on real life,
then the mark. Phone floating in generous negative space, composition varied
rather than one locked centre.

Explicitly **not** adopted: its palette, typography, iconography, copy, light
background, or scene composition. Gennety is black, burgundy, and its own type.

---

## E. Candidate scenes considered

Every state that could have earned a place, and why it did or did not:

| Candidate | Source | Decision |
|---|---|---|
| Stat cards (5073 / $200) | rec | **IN** — the sharpest problem statement in the product |
| Competitor swipe cards | rec | **IN** — differentiation, stated visually not verbally |
| "So we built Gennety" | rec | **IN** — the turn the whole film pivots on |
| AI handoff orb | rec | **IN** — the most beautiful frame in the capture |
| "You pick when" / "Skip straight to the date" | rec | **IN** — the outcome promise |
| Conversational profile (HD) | rec | **IN** — proves the AI actually listens |
| Butterfly logo reveal | **new** | **IN** — brand ending; no recording exists |
| Lifestyle: night/rain, bench, field, festival | rec | **IN** — the emotional bookends |
| Gender pick w/ particle burst | rec | OUT — buried mid-chat, costs 3 s for a UI flourish |
| Height drum | rec | OUT — mechanically nice, narratively inert |
| Photo upload / shimmer | rec | OUT — friction, not desire |
| Identity verification | rec | OUT — a trust feature; wrong beat for a 45 s film |
| Main menu | rec | OUT — a hub, not a moment |
| Weekly match drop / Synergy | — | **NOT AVAILABLE** — never captured |
| Mutual accept | — | **NOT AVAILABLE** |
| 3D date ticket (`Ticket3D.tsx`) | component | OUT — see below |
| Calendar overlap, venue board, partner voting | — | **NOT AVAILABLE** |

**On Priority 2 (rendering production components).** `Ticket3D.tsx`,
`butterfly-loader-react.tsx` and `onboarding-basics.tsx` are all technically
renderable. None is used. `Ticket3D` is a React+CSS-3D component whose gyro/drag
interaction is the point of it; rendered deterministically in Remotion it is a
still card, and it would be the only element in the film not captured from a
running product — a fidelity seam in exchange for a screen the story does not
need. The brief's own rule decides it: *visual fidelity is more important than
technical elegance*.

**On what is missing.** The entire second half of the product — match drop,
Synergy score, mutual acceptance, ticket, calendar overlap, venue board — has
**no capture at all**. The film therefore ends at the promise and cuts to real
life, rather than dramatising states that were never recorded. The alternative
(rebuilding them in Remotion) is precisely what the brief forbids.

---

## F. The cut — `GennetyHero`, ~45 s

Timings are the plan's intent; final frames live in `TIMELINE` in code.

| # | Time | Beat | Composition | Source | Strategy |
|---|---|---|---|---|---|
| 1 | 0.0–4.5 | **Alone** — rain, night street | Full-bleed, graded down, slow 1.06 push | Ad video 0:21–0:31 | RECORDING |
| 2 | 4.5–11.0 | **The cost** — `5073 swipes` → `$200` | Phone enters, centred, still camera. The product animates | IMG_1798 0:41–0:48 | RECORDING |
| 3 | 11.0–16.5 | **The friction** — Daniel / Marco / Mia | Screen-only close-up, ~1.8 s per card | IMG_1798 1:00–1:12 | RECORDING |
| 4 | 16.5–19.5 | **The turn** — "So we built Gennety" → butterfly mark | Hard cut to black; mark draws on | IMG_1798 1:13–1:17 + **new** | HYBRID |
| 5 | 19.5–25.0 | **The promise** — "a personal AI matchmaker…" | Phone returns, offset left, negative space right | IMG_1798 1:18–1:26 | RECORDING |
| 6 | 25.0–29.5 | **Understanding** — the bot asks a real question | Screen-only close-up, **HD** | Gennety Ads 0:08–0:17 | RECORDING |
| 7 | 29.5–33.0 | **The handoff** — glowing orb, "Passing context" | Large close-up, no camera move | IMG_1798 1:44–1:52 | RECORDING |
| 8 | 33.0–37.5 | **The date** — "Skip straight to the date" / "You pick when" | Phone offset right; **burst of cuts** (ref 37.6–39.7) | IMG_1798 1:28–1:41 | RECORDING |
| 9 | 37.5–43.0 | **Real life** — bench at sunset → golden field → festival | Full-bleed, phone gone, warm | Ad video 1:02–1:37 | RECORDING |
| 10 | 43.0–46.0 | **Mark** — butterfly + wordmark, one line | Black, centred | brand assets | NEW ANIMATION |

**Text.** Almost none. The product's own copy carries the argument, which is the
whole point of the finding in §0. Exactly two typographic beats exist outside
the UI: the logo lockup, and one closing line — **"Your AI matchmaker."** —
under it. Candidate lines "No swipes.", "One real date." were dropped: the
recording already says both, in the app's own words, better.

**Audio.** None, deliberately — see §A.4 for the measurement that ruled out the
only available bed. `<Audio>` is wired behind a `musicVolume` prop that defaults
to `0`, with the envelope already shaped (up over the first second, away under
the end card). A licensed track becomes a one-file swap at
`public/audio/score.m4a` plus `musicVolume: 0.8`; the cut's accents are at
16.5 s (the turn), 31.6 s (the burst) and 36.9 s (real life), which is what a
composer or a track selection should be timed against.

No SFX either. Taps and confirmations would have to be synthesised from nothing,
and invented UI sound on top of real product footage is exactly the "template
motion graphics" tell the brief rules out.

**Motion system.** One small set, reused: `fade`, `enter` (spring), and
`ease = bezier(0.22, 1, 0.36, 1)` — the same helpers the existing `GennetyAd`
uses, so the two films share a motion signature. Camera moves are ≤1.08 scale
and never more than one per shot.

---

## G. Technical strategy per scene

- **RECORDING (8 of 10 scenes, ~85 % of screen time).** Trimmed with ffmpeg
  into `public/footage/`, colour-preserved, no re-grading of UI. Rendered through
  Remotion `<OffthreadVideo>`; the camera is a CSS transform on the wrapper, so
  no product pixel is ever repainted.
- **HYBRID (scene 4).** The recording's "So we built Gennety" plays out, then
  cuts to black and the butterfly mark — the real screen, then a brand beat the
  product never had to render.
- **NEW ANIMATION (scene 10).** Logo lockup only. Justified by the brief's own
  Priority 3: it is not an existing product screen.
- **NOT USED: direct component render.** See §E.

**Device framing.** A minimal frame — rounded corners, a 1 px `#1a1a1a` border,
a diffused burgundy glow — matching the design system's "borders over shadows"
rule. It exists to crop Telegram's Russian chrome and the dev badge, not to
decorate. Two shots are screen-only with no frame at all.

---

## H. Risks accepted, stated up front

1. **592×1280 source.** Mitigated by framing (1.13× upscale). The two shots that
   could expose it use the 1080 capture.
2. **Dev-bot footage.** Cropped, never shown.
3. **Second half of the product is undocumented.** The film ends at the promise
   rather than inventing the match reveal, ticket and venue board.
4. **The film has no soundtrack.** The only available bed measured unusable
   (§A.4) and nothing here is licensed to replace it. This is the one open item
   on the deliverable, and it is a decision for the founder plus a track, not a
   code change — the path is already wired.

---

## I. What changed between plan and cut

Recorded because the plan is meant to be argued with, and three of its calls
did not survive contact with the footage:

1. **Scene 8 got richer.** The plan assumed the match reveal, mutual acceptance
   and venue selection had never been captured. They had — not as live states,
   but as the intro's own explainer carousel: "You both said yes", "You pick
   when", "We pick where", "Time and place are set". The burst plays four of
   them instead of the two the plan budgeted for.
2. **Scene 3 stopped being a screen-only close-up.** Overscanning the screen to
   132 % clipped the caption off both edges — "…crolling a TikTok fee" — and put
   a 1.82× upscale on the 592 px capture. It is a large framed phone now (1.49×),
   which keeps the caption whole and halves the enlargement.
3. **Scene 6 changed source.** The plan's window (0:08–0:17) spends almost its
   whole length typing and settles for ~0.4 s before the soft keyboard drags
   Telegram's Russian input bar into shot; it also carries a visible typo. The
   30.4–34.0 s window holds a settled question — *"Are you an early bird or a
   night owl?"* — for three full seconds, clean.

And one systematic bug worth naming: the scene fade helper was symmetric, so
every scene opened from black. With six of nine transitions being hard cuts,
that put a one-frame dip on each of them — a blink rather than an edit. `fade`
now takes independent in/out edges and a hard cut is `(0, 0)`.
