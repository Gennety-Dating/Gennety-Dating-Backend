# Gennety Dating — Product Specification

> **Version:** 2.2 (rewritten 2026-05-04 to reflect the actual code; clarified
> 2026-05-06 as product-invariants documentation; identity verification moved
> from Persona to AWS Rekognition Face Liveness 2026-07-26 — §1.4; the
> 1.x linear-FSM onboarding and visual-screening sections are obsolete.)
> Tech stack and coding rules are in [AGENTS.md](AGENTS.md).
> Database schema and system architecture are in [ARCHITECTURE.md](ARCHITECTURE.md).
> This file documents product invariants and major flows, not every
> implementation detail. Code, tests, and Prisma remain the source of truth for
> local mechanics.

## Project Overview

Gennety Dating is an AI-first romantic matchmaking service. It launched for
university students and (Registration v2, 2026-07) opens to a general adult
audience while keeping a first-class student community: students register
with a university email (and get loyalty perks), everyone else with a phone
number. It diverges from traditional dating apps by relying on deep context
extracted from each user's personal LLM (ChatGPT, Claude, etc.) and completely
eliminating user-to-user text communication before the first date. The system
acts as the matchmaker: it finds the match, pitches it, and negotiates the
logistics until both users meet in person.

The product surface is Telegram-first: `@gennetybot`, the Calendar Mini App,
and a shared `/v1/*` HTTP API for the native mobile client. This repo contains
the backend, Mini App, and public API (the native iOS client lives in the
separate `Gennety-iOS` repo); a full
`apps/mobile` workspace is not present here yet. Both Telegram and mobile users
share the same Postgres backend (`User.platform ∈ {telegram, mobile, both}`).
Mobile-only users carry a synthetic **negative** `telegramId` and are filtered
out of Telegram-only workers.

## Core Principles (Strict Rules)

- **Dual-Track Verified Registration (Registration v2)** — Every user MUST
  verify a contact rail at sign-up. The fork (gated by `PHONE_AUTH_ENABLED`;
  off → legacy email-only flow) offers two tracks recorded in
  `User.registrationTrack`: **student** — university email OTP (whitelist in
  `ALLOWED_EMAIL_DOMAINS`, e.g. `.edu`, `.ac.uk`), rewarded with
  `STUDENT_BONUS_TICKETS` (2) free Date Tickets; **general** — phone via
  Telegram one-tap `requestContact` (the bot receives a trusted
  `message.contact`; `User.phone` is `@unique` — one account per number).
  On the **native mobile app** (no Telegram one-tap there) the general track
  verifies the phone with a delivered code instead: **Twilio SMS by default**
  (founder decision 2026-07-18; Telegram Gateway remains an optional
  secondary rail behind `PHONE_CODE_PRIMARY_PROVIDER`)
  (`/v1/auth/phone/*`, same `PHONE_AUTH_ENABLED` gate; the verified number
  lands in the same unique `User.phone` + `phoneVerifiedAt`, so Telegram and
  mobile registrations can never duplicate an account). Because the number is
  the shared identity across both rails, **verifying it is also the login**: a
  uniqueness collision resolves to the existing account rather than a refusal
  (§1.1).
  **Third rail on iOS: "Continue with Telegram" (2026-08-02).** Telegram's
  official native Login SDK returns a signed OIDC ID token; the server verifies
  it against Telegram's public keys (`POST /v1/auth/telegram`). With the `phone`
  scope the token carries an already-**verified** `phone_number`, which is
  accepted as the general track's contact rail — so this login satisfies the
  same gate as an SMS code while costing nothing. It is not a fourth kind of
  account: the token's subject IS `User.telegramId`, so a bot user who installs
  the app lands in their existing profile, and an app user who verified by SMS
  is matched by that same number. A collision where the number and the Telegram
  identity belong to two different real accounts is refused (`account_conflict`)
  and routed to support, exactly like the Telegram-side `manual-merge`. Gated by
  `TELEGRAM_LOGIN_CLIENT_ID` (empty → the client hides the button).
  **One consequence to hold onto:** such an account carries a REAL positive
  `telegramId` while being reachable only by push, because a bot cannot message
  someone who never pressed Start. `platform` is the canonical reachability
  check; the id alone is not (ARCHITECTURE.md → `users`).
  Matching admits the union of the two valid cohorts (student + verified email,
  or general + verified phone); a credential from the other track never
  satisfies an individual's gate. The student
  community keeps its flavor via educational homogamy, shared-domain curated
  venues, and the 🎓 profile line.
- **NO IN-APP CHAT** — Users NEVER message each other through our platform. Do
  not build chat interfaces between users. The only chats are user↔bot,
  user↔Aether concierge (mobile), and the structured pitch / scheduling /
  emergency flows. **Narrow exception (feature-flagged):** the Variant C
  pre-date *anonymous proxy chat* (§Phase 4 — Pre-date coordination) relays
  text between an already-matched, already-scheduled pair. It is deliberately
  scoped so it does not reopen general user-to-user chat: post-match only,
  time-boxed (opens T-30m, auto-closes T+2h), text-only (media rejected),
  every message logged to `ProxyMessage`, an in-line Report button on each
  relayed message, and off by default (`COORDINATION_FEATURE_ENABLED`). It
  exists to solve "find each other at the venue", not conversation.
- **Deep Context over Questionnaires** — At the end of the Telegram entry Mini
  App the user chooses whether to enrich onboarding from ChatGPT, Claude,
  Gemini, or another personal LLM. Accepted users paste the *Magic Prompt* and
  return the long psychological analysis. Declined users continue without it;
  the backend generates a deterministic fallback summary + embedding from
  their ordinary onboarding answers.
- **Identity-Verified, Mandatory at Launch** — Liveness (AWS Rekognition Face
  Liveness, migrated off Persona 2026-07-26) + photo↔selfie face-match (AWS
  Rekognition `CompareFaces`) gate full match eligibility. With
  `MANDATORY_VERIFICATION_ENABLED` on (Registration v2), the CTA has no Skip
  button and activation happens ONLY through the pipeline's `verified`
  outcome; legacy skip callbacks refuse politely and pre-flip skippers are
  grandfathered with their `UNVERIFIED_ELO_PENALTY`. A production-like process
  refuses to boot when liveness is disabled or unconfigured (no AWS
  credentials, no `LIVENESS_STS_ROLE_ARN`), Rekognition is disabled, or
  profile-media validation is disabled. **There is no sandbox escape hatch any
  more:** the Persona era shipped `ALLOW_SANDBOX_PERSONA`, which let production
  run test-only KYC, and it is gone with the provider — Face Liveness has no
  sandbox/production key split, so a production-like config is either complete
  or it does not start. (Historical note: `verified` statuses granted during
  the sandbox window carry no real identity guarantee and were never
  retroactively cleared.)
- **Progressive Logistics** — The AI auto-proposes timeslots first; if both
  rounds fail it hands off to the Calendar Mini App; venue is chosen by an
  AI concierge from each user's free-text *vibe* + commute pin.
- **Native Telegram AI Experience** — Heavy use of Bot API 9.x/10.x:
  bottom-of-chat `sendMessage` + `editMessageText` streams (status, pitch,
  no-match, ice-breakers), `icon_custom_emoji_id` (menu and match-decision
  affordances), `message_effect_id` (match confirmations), `date_time`
  MessageEntity (timezone-aware date confirmation), and pinned status banner
  (live discrete countdown). Product flows intentionally avoid Telegram draft
  streams because clients treat them like generated AI replies and may reserve
  scroll space for a follow-up answer.
- **Blind Decision Invariant** — A user must never learn their partner's
  Accept/Decline before committing to their own.

## Phase 1 — Onboarding

> The legacy "strict linear FSM" sequence is **gone**. After the email gate,
> onboarding uses a server-owned fact collector shared by Telegram and
> `/v1/onboarding/interview*`. The server persists every confirmed fact
> immediately and deterministically chooses the next missing field. An LLM may
> extract multiple explicitly stated facts from free text, but it does not own
> progress, question order, photo gates, or finalization.

### 1.1 Initialization, Language & Consent (`onboardingStep = consent`)

- `/start` (or first mobile launch) creates a `User` row and captures any deep
  link as `referralSource` (`tg:<start_param>` / `mobile:utm=…` /
  `referral:<USER_ID>`). The Telegram entry Mini App first asks for the
  language, then renders the consent + ToS card in that selected language.
- Telegram `/start` now opens a full-screen Onboarding Mini App before the
  conversational agent takes over. The Mini App presents the visual intro,
  language, legal consent, the **sign-up fork** (when `PHONE_AUTH_ENABLED`,
  mirrored to the client as `phoneAuthEnabled` in `/state`): student →
  corporate-email OTP gate; general → phone one-tap gate (PhoneGate polls
  `/state` until the bot records the trusted `message.contact`); then dating
  city (a **launched market** only — Kyiv today, mirrored to the client as
  `supportedCities` in `/state`; see §1.3), a **light/dark theme picker** (right after the city gate, before the
  visual intro; default `dark`, changeable later in Settings — `POST /theme`
  records it), the **five profile screens** (name / age / gender / who you're
  looking for / height — §1.3), and the final AI memory export choice, using
  Telegram `initData` HMAC auth for all writes (`POST /track` persists the
  re-choosable fork pick).
- **The Mini App collects the first five profile facts itself (2026-08-05).**
  Name, age, gender, preference and height each have ONE correct answer out of a
  finite set, and a Telegram chat has no way to ask for that: the bot asked in
  prose and then recovered the value with a regex or an LLM classifier. They now
  sit on their own screens between the welcome-gift screen and the AI-memory
  choice — one bold question, one control (a text field, a slider, tinted choice
  buttons, a two-column photo fork, a scroll-snap drum), nothing else — and the
  chat resumes at
  `hobbies`. **The name screen carries no question at all** (founder decision
  2026-08-06): it is a single empty field labelled "Твоё имя", which already
  says everything the heading did, so the heading was the one line on these
  screens that added nothing. The question survives as the input's accessible
  name for a screen reader. **The typed name does not change size when the
  keyboard opens (2026-08-07):** with the heading gone, the field IS the screen,
  and its size was measured against the viewport HEIGHT — which the soft
  keyboard shrinks — so the name shrank the instant the user tapped to type it
  and snapped back when the field blurred on Continue. It is measured against
  the width now, the one axis a long name actually runs out of and the one the
  keyboard never touches. The Continue pill still rises above the keyboard;
  that part was always right, and the shrink easing is smoothed rather than
  stepped. The native iOS client already had purpose-built
  controls here via the `ui_hint` contract; this is Telegram catching up, and
  the `/v1/*` surface is untouched.
  **The screens write through the collector** (`applyOnboardingFacts`,
  `POST /v1/telegram-onboarding/profile`), not straight to Prisma, so the
  canonical columns, `onboarding_progress.currentQuestion` and the funnel
  telemetry stay identical to a chat answer. One screen = one request, so
  closing the Mini App mid-way loses nothing and reopening resumes on the first
  unanswered screen (routed from `/state.profileBasics`, never from local
  storage). Values are re-validated server-side against the same
  `validateFactValue` rules the chat uses.
  **`/complete` deliberately does NOT require them.** Whatever the Mini App
  didn't deliver, the chat asks for — which is what keeps a cached older bundle,
  the iOS rail and a legacy mid-flight account from dead-ending at the handoff.
  The change is additive by construction.
  **The two tap-to-answer screens burst on tap (2026-08-06).** Gender and
  preference are the only screens in the set where a single tap commits the
  answer — no slider to drag, no drum to spin, no Continue pill afterwards — so
  the tap was the whole interaction and produced nothing but a 1.5% scale before
  the screen swapped. Tapping now throws a burst of objects themed to the option
  from the point the finger landed on: football, boxing glove, race car, trophy,
  dumbbell and gamepad on the male rows; butterfly, flower, heart, diamond,
  crown and sparkle on the female ones; the shared symbols only on "both", which
  must not read as a third gender. The picked row also lifts and holds its glow
  for the beat the save takes, rather than dimming with the others.
  Purely decorative and scoped as such (`apps/webapp/src/onboarding-burst.ts`):
  it never gates or delays the save, the particles are authored vectors rather
  than emoji (same rule as `icons.ts` — a rotating platform emoji rasterizes),
  the palette is the button's own gradient plus one gold, and it is skipped
  outright under `prefers-reduced-motion` or on a client with no Web Animations
  API. Telegram-only; the native iOS client owns its own controls here.
  **"Who do you want to meet?" shows the answer instead of naming it
  (2026-08-06).** It was three stacked rows carrying three words, which asked
  the one question in the set that is *about people* and put no people on the
  screen. Men and women are now two tall columns splitting the screen in half —
  a target you hit without aiming, and wide enough to carry photographs of the
  people behind the choice — with "both" underneath, smaller and quieter: a
  real answer, but not the headline one, and three equal rows made it compete
  with the two most users are actually deciding between. Inside each column sit
  six ordinary photographs, tilted, a few hanging past its side, over the
  column's own burgundy/blue gradient.
  **A second design was built to be compared against it, and dropped
  (2026-08-07).** It put one finished group image per side — people already
  standing together, background removed, white contour drawn — inside a
  near-black panel under a heavy white word, and for two days both shipped
  behind a dev `?v=` switch that could also stack them on one scrolling page.
  The founder settled on the photographs. The switch, the review page, the
  second design's CSS and its artwork are **deleted**, not flagged off: a
  decision that is made stops being a configuration, and the alternative lives
  in git history where a reverted design belongs. What the comparison taught is
  worth keeping, because it is a constraint on anything that replaces this
  screen: **a taller button does not draw people any bigger.** Group artwork
  runs out of column WIDTH long before it runs out of height, so every extra
  pixel of button height lands as headroom, never as scale — at half a phone
  wide, five people across are ~32px each, and the only way past that is to show
  fewer of them. The scatter sidesteps it by showing one person per frame.
  The photo placements are authored, not random (`preference-layout.ts`):
  a scatter re-rolled per render would shuffle under the user's finger and could
  never be reviewed twice. It is four bands read from the bottom up —
  two small, one large, two small, one large-ish — and the sixth photo is
  deliberately the LAST slot, the bottom row's outer corner, so a five-photo set
  still renders a composition rather than half a band. Each frame shows a
  **whole person**: the tile carries the photos' own 9:16, which is the ratio
  `prepare.mjs` prepares them at, so filling it crops nobody.
  **The photographs are unframed and reach their own edges (2026-08-07).**
  They shipped in white 2px frames, and the frame cost more than it bought: with
  `box-sizing: border-box` it shrank the tile's *content* box to a ratio the
  photo no longer matched, so `object-fit: contain` letterboxed every one of
  them — a dark hairline along the top and bottom of all twelve tiles, reading
  as a rendering fault rather than as a border. The tiles now paint edge to edge
  (`object-fit: cover`, which absorbs the sub-pixel rounding of a 1152×2048
  original scaled to 338×600 and would crop an odd-sized photo rather than
  letterbox it — so the folder stays 9:16). They remain **opaque**, and what
  separates one print from the next where they cross is now the shadow under it
  rather than a white edge: a photograph seen through another photograph reads
  as a rendering fault rather than as depth, so where they overlap the paint
  order is still the whole of what you see.
  **The label owns the bottom strip, and no photo may enter it (2026-08-07).**
  The bottom band ran through the button's floor and sat behind «Парней» /
  «Девушек» — the one word the button is asking about, legible only because of
  the scrim over it. The scatter's coordinate space is now the button *minus*
  that strip (`.ob-pref-art`, `--pref-label-zone`), so the rule is structural
  rather than a per-slot reminder, and the bottom pair is authored to clear the
  floor at the **tightest** column rather than the one that was screenshotted:
  the pair is elastic (`flex: 1`, 15–32rem) while a tile is sized from the
  column's WIDTH, so a short screen makes each tile a bigger fraction of the
  height — a `y` that clears on a 390×844 phone can still cross the word on a
  320×568 one. `maxCentreY` states that bound, tilt included, and a test holds
  every slot to it. The word itself is the heaviest type on the screen (Inter
  800, the top weight the page loads — 900 would be synthesised and smear rather
  than thicken): it is the answer, and it sits on a photograph-backed column
  rather than on the page. **The strip and the type move together** — the
  reservation is sized to the tallest the label gets, so growing the word
  without growing the strip puts the photos back on it. The right column is the left one mirrored, which is
  also what keeps every sideways overhang pointing at the screen's own margin
  rather than into the gutter the two columns share; because a tilted tile is
  wider than its own box (`slotSpanX`, and with full-length photos the tilt term
  dominates), that clearance is computed rather than eyeballed. Photos are `alt=""` and
  take no pointer, so an overhang cannot become a tap target sitting outside the
  button it belongs to, and the label alone carries the accessible name. Same
  save, same burst, same collector write as before — this is the control
  changing, not the question. Telegram-only.
  **The height drum ticks per row, and turns a little freer (2026-08-06).**
  It is the one screen answered by a continuous gesture rather than a tap, and
  it gave no feedback until the gesture ENDED: one haptic pulse on settle, which
  reads as a list that happened to land somewhere rather than a drum you aimed.
  A `selectionChanged` pulse now fires as each value passes under the capsule —
  the tick is how you count rows while your eyes stay on the number — thinned by
  a 30 ms floor so a violent fling cannot fire ~80 bridge calls in a second
  (ticks that close together are one continuous buzz anyway, and a deliberate
  scroll never reaches the floor). The *value* is still committed on settle, not
  per row: every option re-renders on a change, and doing that each scroll frame
  is the jank the native scroll was chosen to avoid. Separately, the row height
  is the drum's gearing, and the only honest one — a native scroll moves 1:1
  with the finger, so that one number decides how many values a swipe crosses —
  and the 56px it shipped at made a deliberate 175 → 190 a long drag; at 38px
  the same gesture travels ~47% further and a flick genuinely spins. That is
  near the floor rather than a midpoint: 38px is about where a native iOS
  picker row sits, and the 28px numerals leave only a few px of air, so going
  lower would start costing the thing the screen exists for — being able to
  stop ON a value and read it. Both pure decisions live in
  `onboarding-wheel.ts` so they are testable away from the DOM. Telegram-only;
  the native iOS client owns its own picker.
- **The phone gate is also the LOGIN (2026-07-25).** A trusted `message.contact`
  is Telegram vouching that the number belongs to the current Telegram account,
  and Telegram allows one active account per number — so a `User.phone` unique
  collision means the row already holding that number is the *same human*, and
  the product answer is to log them in, not to refuse. Sharing the contact
  therefore **adopts** that account: its `telegramId`/`telegramUsername` are
  re-pointed at the sharing Telegram account, a `mobile` row becomes `both`, the
  stale pinned-banner id is cleared, the fresh touch's `referralSource` is kept
  when the account had none, and the empty registration row that was just
  created is deleted (`services/account-linking.ts`). This is what makes the two
  rails one product: someone who verified their number in the iOS app and then
  opens the bot lands in their existing profile instead of a dead end, and so
  does someone who re-created their Telegram account. Accepted tradeoff
  (founder decision): a carrier-recycled number hands the new holder the
  previous profile — the phone rail already makes exactly this trade, since
  `/v1/auth/phone/verify` logs whoever proves the number into the row. The one
  case that is never automated is a collision where **both** rows carry real
  data (finished onboarding, photos, matches, tickets, premium, a redeemed
  promo, a verified email): that is a merge of two populated accounts and is
  routed to @gennetysupport. An adopted account that is already past onboarding
  re-enters through the same path `/start` uses (unfreeze → verification gate →
  menu + pinned banner), and the Mini App closes instead of replaying gates.
  Deleting the chat, deleting the bot, or clearing history never loses an
  account — `/start` resolves it by the permanent `telegramId`.
- **No website onboarding handoff (removed 2026-07-19).** The website
  (`gennety.com`) no longer runs any slice of onboarding. Its `Log in` / `Join`
  CTAs route to the `/app` platform chooser (Telegram vs App Store); the visitor
  onboards entirely inside their chosen client. There is no browser
  pre-registration flow, no `auth_`/`web_` Telegram deep-link handoff, no
  `web_registration_links` table, and no `/v1/web-registration/*` API — every
  user resolves language, consent, the sign-up fork, and the contact rail
  natively in the Telegram Onboarding Mini App (or the iOS app). The generic
  phase machine still skips whatever is already resolved (e.g. a dev-bypass or a
  returning mobile-first user), but no pre-filled state ever originates from the
  web. The student ticket bonus is granted at native university-email
  verification, gated on the track — not on any handoff.
- When the Mini App reaches its handoff step, it calls
  `/v1/telegram-onboarding/complete` with the visual-flow token issued by
  `/v1/telegram-onboarding/state`; the bot immediately resumes the chat through
  the onboarding collector. This does **not** mark onboarding complete by
  itself — required profile fields, photos, and verification CTA still follow
  the normal product rules. Magic Prompt context is required only when
  `aiMemoryExportPreference = accepted`.
- The user MUST flip `termsAccepted` (legal click) and MAY opt into
  `researchOptIn` (analytics use of anonymised data, default false per GDPR
  norms).

### 1.2 Language (`onboardingStep = language`)

- Five options: `English`, `Русский`, `Українська`, `Deutsch`, `Polski` →
  persists `User.language` and `BotSession.language`. (The shared i18n `Language`
  type and the onboarding Mini App picker both carry all five; `en` is the
  fallback.)
- In the Telegram entry Mini App, language selection precedes legal consent so
  the consent screen is immediately understandable. Email and every later gate
  remain blocked until terms are accepted.
- **`consent` and `language` are Mini App-owned states with no chat screens of
  their own (2026-07-27).** Telegram used to carry its own consent card and
  language picker, and the router's step switch had no Mini App gate at all, so
  a user who typed anything instead of tapping the button entered a second,
  divergent onboarding: it skipped the sign-up fork (a general-track user was
  never offered the phone rail), the dating city, the theme pick and the
  AI-memory choice, then dead-ended at the finalize gate, which requires a
  `homeCityKey` the chat flow cannot collect. Both screens are deleted; every
  touch on either step — `/start`, a stray message, a stale inline button from a
  previous account — answers with the one current Mini App entry card
  (`handlers/onboarding/mini-app-entry.ts`). The card is self-healing for an
  account with no `User` row: the Mini App's `/v1/telegram-onboarding/state`
  resolves the caller through `findOrCreateTelegramUser`, so tapping it creates
  the row and starts the current flow. The chat only regains ownership at
  `conversational`, after the Mini App hands off (§1.3).
- Server-owned question templates match the user's language thereafter and are
  forbidden from injecting English enum words ("male/female/men/women") into
  non-English replies.

### 1.3 Conversational profile capture (`onboardingStep = conversational`)

Email OTP remains handled by the onboarding agent. Once email is verified, the
fact collector owns profile capture:

| Stage / action | Effect |
|---|---|
| `send_otp_email(email)` | Validate domain, mint OTP, send via email provider |
| `verify_otp(code)` | Check the 6-digit code, flip `isEmailVerified` |
| `resend_otp()` | Re-send to the email already on file |
| `extract + validate` | Require exact user-message evidence; validate age, height, enums, and placeholders |
| `partial save` | Transactionally persist each accepted fact to `User` / `Profile` after every text or voice answer |
| `advance` | Choose the first actually missing field from the canonical order |
| `context gate` | Surface and save the Magic Prompt only when AI memory export was accepted |
| `photo gate` | Preserve early photos but do not skip unfinished profile questions |
| `finalize gate` | Activate only after required profile data, AI-memory branch, city, a verified contact rail (email or phone, per track), and minimum photos are complete |

Canonical order: name + age → gender → preference → height → hobbies → partner
requirements → **vibe (ideal Friday night →
process-vs-who follow-up)** → AI memory → photos. (An optional
nationality/ethnicity step used to sit before the vibe questions; it was
**removed 2026-08-01** — see the note under the hard rules below.) Questions come from server
templates for `en`, `ru`, `uk`, `de`, and `pl`.

**On Telegram the first five of those are collected in the Mini App, not the
chat (2026-08-05).** `nextOnboardingQuestion` is unchanged and still owns the
order; the difference is only WHERE the answer comes from, so the chat opens on
`hobbies` for a user who completed the Mini App screens and on whatever is
actually missing for anyone who didn't. That fallback is load-bearing, not a
nicety — see the `/complete` note in §1.1. Each screen posts one field to
`POST /v1/telegram-onboarding/profile`, which goes through the collector's own
save path (`applyOnboardingFacts`): canonical columns, `onboarding_progress`
under its revision guard, one `onboarding_step_events` row per real transition.
So `first_name_age` still resolves only when BOTH name and age are in, exactly
as it does when someone types "Максим, 24" into the chat. The controls mirror
the `ui_hint` contract the native client already renders
(`apps/bot/src/public/ui-hints.ts`): a name field, an age slider, choice
buttons, a height drum. The bounds behind them (`MIN_AGE`/`MAX_AGE`,
`MIN_HEIGHT_CM`/`MAX_HEIGHT_CM`) are served from `/state.profileLimits` rather
than inlined in the bundle, because `apps/webapp` deliberately does not depend
on `@gennety/shared` and a bound in two places eventually disagrees with
itself.

**Vibe questions (matching signal, asked of everyone).** Two short free-text
questions sit right before the Magic Prompt step so *every* user — including
those who decline AI-memory export — supplies real psychological signal, not
just demographics:

- `friday_vibe` — "describe your ideal Friday night, money/logistics no object,
  honestly (not what sounds 'right')".
- `vibe_focus` — "what matters most — the experience itself, or who's with you?".

At `finalize_onboarding` one LLM pass (`services/vibe-axes.ts`) maps the two
answers into structured columns: `Profile.energyAxis` (internal↔external
"tempo"), `orientationAxis` (experience↔connection), `socialRole`
(initiator/participant/observer — **stored, not scored in v1**), and
`anchorTags[]`. The raw Friday text is folded into `psychologicalSummary` so it
also feeds the embedding (`V_explicit`) and survives `embedding-refresh`.
Extraction is best-effort: a failure never blocks finalize (matching simply
skips the vibe factor). These answers replace the duplicated Profiler questions
(§Phase 1b) and feed icebreakers. See §3.2 for how the axes are scored.

Before the Telegram Mini App hands off to the conversational bot, the user
must also choose a **dating city** (`Profile.homeCityKey`). This is framed as
"where you want to receive matches", not as a home address. Users can search
for a city manually or let the Mini App resolve their browser geolocation to a
city; raw coordinates alone do not satisfy the matching gate.

**The city must be a launched market — Kyiv only today (2026-07-28).**
`packages/shared/src/markets.ts` (`SUPPORTED_MARKETS`) is the single source of
truth, shared by the bot, the Mini App and the `/v1/*` API. Registration used to
accept any city Google Places could name, which was a promise the product could
not keep: matching is strictly same-city (§3.2 filter 5), so a user who picked a
city we have not launched landed in a **pool of one** — no ad spend there, no
curated venue catalog, no operations, and no possible partner — while the app
kept counting down to a drop they could never be in. Now:

- **Search** offers only launched markets (`searchMarkets`, matched on the city
  name and its local-language aliases). The Google Places city lookup is gone
  entirely: with a curated market set, a global geocoder can only ever propose
  cities the server must refuse. (`PLACES_API_KEY` is still required for
  venues.)
- **Geolocation** answers one question — "are you inside a launched market?" —
  as pure geometry against the market centroid + `radiusKm` (60 km for Kyiv,
  generous so the commuter belt counts). Outside every market it resolves to
  **nothing**, and the Mini App explains that Gennety has not launched there yet
  and leaves the choice open, rather than saving a city the person is not in.
  This also ends a real bug: the old reverse-geocode silently resolved ANY
  coordinates to the first fallback city (Kyiv) whenever `PLACES_API_KEY` was
  unset.
- **The write is the enforcement point.** `validateHomeLocationPayload` is the
  only writer of `homeCityKey`, so one check covers Telegram
  (`POST /v1/telegram-onboarding/city/select`) and the native app
  (`POST /v1/me/home-location`) alike: an unlaunched city is refused with
  `city-not-supported`, and a launched one is **canonicalized** to the market's
  own name and coordinates — the client only ever picks WHICH market, so a
  drifting or spoofed centroid can never land in `Profile.latitude/longitude`
  (which the venue picker and city analytics read). iOS renders the constraint
  from `AppConfig.supportedCities` (`GET /v1/app/config`) instead of discovering
  it as a 400.

**Launching a new city is a deliberate code change, not a flag.** A market is
only real once its curated venue catalog (`curated_venues.cityKey`), ad
campaign, and ops processes exist — all of which already ship as code/scripts.
An env toggle would let someone open a city before any of that is ready, which
is precisely the failure this gate removes. Adding a market: seed + review its
venues, add the `SUPPORTED_MARKETS` entry (its `cityKey` must match the venue
rows), confirm the timezone resolves. Until then the product must never suggest
the service is available there.

**Accounts registered before the gate keep their data and are offered the
move.** Nothing is rewritten, frozen, or deleted: status, profile, photos,
verification, tickets and Premium are untouched, and they were already
unmatchable under the same-city rule. What changes is that the product stops
promising them a match it cannot deliver, and gives them a one-tap way into a
launched market — the conditional menu row and the honest weekly DM in §2.1 /
§3.1. On iOS the same move is `POST /v1/me/home-location` with a supported city.

**Kill switch (`AI_MEMORY_EXPORT_ENABLED`, default on).** The whole AI-memory
branch can be turned off with one env var while it is reworked, without a
schema change, a backfill, or any other flow moving. When off, every surface
behaves exactly as it already does for a user who **declined**: the onboarding
Mini App skips the AI-memory choice screen (the server mirrors the flag as
`aiMemoryExportEnabled` in `/state`), `POST /v1/telegram-onboarding/ai-memory`
404s, the collector marks `ai_memory` + `context_dump` complete/skipped so the
canonical order runs vibe → photos, the legacy onboarding agent never requests
or accepts a Magic Prompt paste (a paste still in flight when the flag flips is
dropped rather than saved), and finalization uses the deterministic fallback
summary + embedding. The flag never writes to the database:
`User.aiMemoryExportPreference` keeps whatever it held (including `accepted`),
so flipping it back on restores the branch for everyone as-is.

The final Mini App screen records `User.aiMemoryExportPreference` through
`POST /v1/telegram-onboarding/ai-memory`:

- `accepted` keeps the existing Magic Prompt flow and server-side ordering
  guards (`save_context_dump` before photos/finalization).
- The pasted AI response is processed automatically after a short idle pause;
  there is no separate paste-confirmation button.
- The Magic Prompt uses the evidence-first V2 JSON contract. It asks the
  personal AI for dating-relevant signals only when backed by an explicit
  disclosure, repeated pattern, or concrete episode; generic AI-use
  preferences, forced personality/attachment labels, and gap-filling are
  forbidden. Every section may be `[]`, and `grounded_summary` may be `null`.
- Complete legacy V1 Magic Prompt JSON remains accepted so an already-copied
  prompt never strands a user. Partial/prose responses get one server-side
  evidence-only repair pass; unparseable long text is rejected instead of
  being stored as a profile.
- The raw pasted response is transient. Only the redacted signal summary and
  its embedding are persisted; onboarding history records a non-sensitive
  receipt marker. If V2 contains no supported dating signal, finalization uses
  the ordinary onboarding answers + vibe as the fallback profile rather than
  inventing context.
- `declined` suppresses the Magic Prompt for the current onboarding run,
  permits photo collection directly after the ordinary profile fields, and
  generates `Profile.psychologicalSummary` + embedding from those fields at
  finalization.
- `undecided` cannot pass `/v1/telegram-onboarding/complete`.

Hard rules enforced by the collector:
- Required fields (`firstName`, `age`, `gender`, `preference`,
  `partnerPreferences`) are NEVER skipped — keep asking until concrete.
- Gender is accepted only from a direct answer and is never inferred from a
  name.
- Multiple explicit fields in one message are all saved. The last explicit
  correction replaces the previous canonical value.
- Real user text is distinct from `resume`, `context_dump`, and
  `photos_updated`; synthetic events, assistant text, summaries, and tool
  arguments are never mined as profile facts.
- **Nationality/ethnicity is not collected at all (removed 2026-08-01).** The
  question was optional and skippable, but the answer was folded into
  `psychologicalSummary` → the embedding → `V_explicit`, so ethnic origin
  materially influenced who a user was paired with. That is GDPR Art. 9(1) data
  driving an Art. 22 automated decision with no Art. 9 basis available for it.
  The question, the `Profile.ethnicity` column, the founder-feed line and the
  admin audience breakdown are all gone. The Type Radar taxonomy was checked at
  the same time and is clean: it scores hair, build, style and tattoos, never
  skin tone or any ethnic proxy (`TYPE_RADAR_PRODUCT_SPEC.md`).
- "No hobbies" / a single hobby is a valid answer; the agent must NOT chain
  "one more, one more" requests.
- `MIN_PHOTOS` (3, lowered from 4 on 2026-07-27) is a hard floor; anything
  beyond up to `MAX_PHOTOS` (10) is
  purely optional. In Telegram conversational onboarding, the media stage is
  deterministic rather than LLM-owned:
  before the minimum, the bot reports exactly how many valid photos are still
  needed; once 3 photos are valid, it keeps the stage open and shows one
  **Continue** action instead of finalizing automatically. The user may keep
  sending photos one-by-one or as a Telegram album, send a short profile video,
  tap Continue, or type a localized equivalent such as "done" / "дальше".
  **Continue means "I'm done sending photos", never "finalize" (2026-08-08).**
  It resolves through the collector's own question order, exactly like a typed
  "done": onboarding finalizes only when the collector says every question is
  answered, and otherwise the bot replies with the question that is actually
  next and closes the photo stage. Before this it called the finalize routine
  directly, so a session that believed the stage was open while profile
  questions were still outstanding turned one tap into a refused finalize —
  and, because the refusal changed no state and the stage stayed open, the
  account was stuck there permanently with no way back to the missing
  question. That the stage was open at all traces to a chat session surviving
  an account deletion (ARCHITECTURE.md → `bot_sessions`), which is fixed at the
  source; routing Continue through the collector is what makes any such
  disagreement recoverable rather than terminal.
  **The finalize guard's own message is never shown to the user.** It is
  written for the model — English, internal field keys, "call
  finalize_onboarding" — so a refusal answers with localized copy
  (`onboardingFinalizeBlocked`), releases the photo stage so the chat is not
  held hostage by the upload handler, and logs the guard's text, which is the
  only place the divergence can be diagnosed. One such divergence is known and
  reachable: `home_city` is required by finalize and is not a collector
  question at all.
  **The typed equivalent is a phrase, not a single word (2026-08-07)**, and
  **a question asked at this stage now reaches the agent.** The matcher took
  bare words only (`хватит`, `готово`), so the ways people actually finish —
  "мне хватит", "не хочу больше", "это всё", "я закончил" — matched nothing;
  and every unmatched message was answered with the progress card without the
  agent being called at all. So "а кто увидит мои фото?" — the question this
  screen is most likely to provoke — got a photo counter back, while the SAME
  question below the minimum was answered properly. The bot listened worse the
  further the user had actually got. Two bounds keep the fix safe. The
  continue list matches the **whole utterance**, never a substring, so a
  sentence that merely contains a done-phrase ("мне хватит трёх, но давай ещё
  гляну") does not end the stage. And only **question-shaped** text is handed
  to the agent (`isLikelyMetaQuestion`, the same predicate the collector's own
  no-advance guard reads): past `MIN_PHOTOS` the next question is `complete`,
  so an ordinary message would advance the collector and finalize onboarding —
  which is exactly what "keeps the stage open instead of finalizing
  automatically" forbids. A question therefore gets answered and the photo
  request re-posed; anything else still gets the progress card.
  Albums and rapid standalone photos are coalesced into one progress response,
  so a 4- or 10-photo burst does not produce one reply per frame. Because that
  one response only lands after every frame has been through vision validation
  (seconds per photo), the burst is covered by a single held **"looking at your
  photos" shimmer** (`photoReviewSteps`, `runStatusSequence` with
  `until: <batch flush>`, so it ends when the work does rather than on a timer)
  — the same treatment the §2.1 photo manager already gives an upload burst.
  Without it the user sends three photos at once and sits in silence with only
  the typing indicator, which reads as the bot having missed them.
  **The shimmer counts (2026-08-07).** It has two scripts of the same length —
  plural, and a singular one ("смотрю твоё фото") for a burst that is still one
  photo — because the stage accepts photos **one at a time** and the plural read
  as the bot having miscounted what it was just handed. An album is known to be
  several from its very first frame (`media_group_id`); a standalone photo is
  one until another joins. A burst that GROWS past one frame while the shimmer
  is still on screen has its remaining beats revised in place, so "send, then
  send another" ends in the plural rather than being stranded in the singular
  for the rest of the burst — the beat already drawn is left alone, since
  rewriting what the user is currently reading is worse than a stale line. The
  §2.1 photo manager carries the same split (it shipped a few hours later, in
  the same shape, off the same `reviseStatusScript`).
  At 5 photos the
  bot uses a short progress reminder rather than repeating the full pitch.
  **The stage is an editor, not an append-only log (2026-07-27).** A persistent
  bottom panel (Telegram *reply* keyboard, one button — "🗂 My photos") sits
  under the chat for the whole stage and opens the **photo editor**: the same
  card manager as §2.1 — one message per photo with its own 🗑 — and a
  "← Back to uploading" action. Deleting is available from the first photo
  onward, with **no `MIN_PHOTOS` floor** (the user is not in the matching pool,
  and going under the minimum simply withholds Continue and restores the
  "you need N more" copy). New photos sent while the editor is open flow
  through the ordinary validation/coalescing path but re-render the editor
  instead of the progress message, so "delete one, send its replacement" stays
  one continuous screen. The panel is a reply keyboard rather than an inline
  button because the progress message scrolls away the moment the next batch
  (plus any per-frame rejection reply) lands below it — and because Telegram
  allows one `reply_markup` per message, the panel attaches to the stage's
  first plain-text message and persists chat-wide, while Continue keeps its own
  inline keyboard. It is removed on the first message the bot sends after the
  stage ends, whichever path ended it. Before this the first upload was
  write-only: a user who disliked a photo could only pile more on top until
  `MAX_PHOTOS`, then walk into verification with photos they never wanted —
  the one place where the photo set is actually FORMED was the one place with
  no way to revise it. Telegram-only; the editor runs no verification rerun
  (nothing is verified yet — the pipeline runs at finalization).
  Exact duplicates (same Telegram `file_unique_id` within a batch) and
  re-encoded / cropped copies (perceptual `differenceHash` within
  `DUPLICATE_HASH_DISTANCE` (8) of any accepted hash) are not counted and
  receive an explicit explanation. **Identity is enforced only by liveness
  verification, not by an upload-time gate before it (simplified 2026-06-23).**
  Before the user has a `verifiedSelfiePath`, each static photo that passes
  safety, usable-face presence (Rekognition face confidence ≥ 0.55 and face
  area ≥ 0.8% of the frame, lenient by design — angled / partially-turned /
  full-body shots are normal; lowered from 0.75/1.5% after a calibration run
  found legit photos bounced as `no_face`; pose / lighting / sharpness /
  obstruction are deliberately NOT gated, since extreme turned-away / dark /
  blurred / cropped shots already fail the presence floor. **The whole
  `face_obscured` obstruction gate was removed — sunglasses 2026-07-26, the
  remaining `FaceOccluded` mask/covering branch 2026-07-27.** A production
  audit of `media_validation_rejections` plus the PM2 logs found
  `face_obscured` was 9 of the 11 real rejections ever recorded across prod and
  dev — **~82% of all upload friction**, the single largest source of
  registration drop-off — while `unsafe_content` had never fired once and
  `no_face` had fired exactly once in six weeks. Removing only the sunglasses
  branch did not move that number: `FaceOccluded` is ONE signal covering masks,
  scarves, hands, hair and frames alike, so the same photos kept bouncing under
  a new explanation (a hand near the face is among the most common real dating
  poses). The signal was never trustworthy enough to gate on either — in
  calibration it read 0.93 on a completely clear face, which is why the floor
  had to sit at 0.99: we were not filtering confidently, only where false
  positives thinned out. The gate protected neither safety (that is the
  separate moderation layer) nor identity (liveness-only since 2026-06-23); its
  one real justification was that a covered face can score low at verification,
  where a single `fail` used to hard-reject the entire account — and that
  justification was removed at the source by the §1.4 quorum change below, which
  now drops the offending photo instead of the account. With the account no
  longer at stake, an upload-time obstruction gate protects nothing. What
  remains is only "is there a usable human face here at all", and the duplicate
  checks; such a photo is accepted and counted toward `MIN_PHOTOS`
  **immediately**: there is
  no cross-photo "same person" clustering and no self-photo identity anchor.
  (The earlier hidden `pendingPhotoCandidates[]` consensus pool — which held the
  first photos invisible until two of them clustered at
  `FACE_SIMILARITY_THRESHOLD` — was removed because it stranded legitimate users
  whose genuine same-person photos scored just below the CompareFaces
  threshold, leaving them with zero accepted photos and no way to finish
  onboarding. `pendingPhotoCandidates` / `referenceFaceEmbedding` columns are
  retained but no longer written by the upload flow.) Once the user is
  liveness-verified, every uploaded or edited photo is compared against the
  verified selfie — the real identity gate — and the verification pipeline
  re-runs on every photo edit (§1.4), so a wrong-person photo on a verified
  profile is caught there. Unsafe, no-face, duplicate, and technical-processing
  failures are rejected before accepted-profile persistence, logged to
  `media_validation_rejections`, and keep the user in the same retryable upload
  session. **A rejection is always explained on the offending photo itself**: the
  bot replies to that frame's own message with the concrete reason (sunglasses /
  covering, duplicate, no face, …) and marks it with a 🤔 reaction. An album
  arrives as N separate messages, so a single batch-level line could not say
  *which* frame failed — a 4-photo album coming back as "3/4" with one detached
  sentence left the user guessing (and re-sending). The reasons are also handed
  to the onboarding agent, so pushback ("but I sent 4!") is answered with the
  actual rejection rather than a repeated request.
- When `TICKET_FEATURE_ENABLED`, the first post-minimum offer explains both
  rewards: reaching `PHOTO_BONUS_TICKET_THRESHOLD` (6) face-validated photos
  grants a free Date Ticket, and adding a profile video grants another. A batch
  that already reaches 6+ photos receives the photo reward immediately, but the
  media stage remains open so the user can still add optional photos up to 10
  and the optional video. Each
  bonus is one-time/idempotent (`Profile.photoBonusTicketAt` /
  `videoBonusTicketAt`) and explains the mechanic in the reward DM (each date
  costs 1 ticket; tickets normally cost money). See §3.5b.
- Profile media may be a mix of static photos, Telegram Live Photos, and a
  profile **video**. A Live Photo counts as one profile media item toward
  `MIN_PHOTOS` / `MAX_PHOTOS`, but its static frame is still stored in
  `Profile.photos[]` and must pass the same safety, usable-face, and duplicate
  checks as a normal profile photo (identity only against the liveness selfie,
  once verified). Live Photos without a static frame are rejected.
  A **video** (`ProfileMedia` `{ type: "video" }`) remains display-only and is
  NOT added to `photos[]` or counted toward `MIN_PHOTOS`, preserving the
  `photos[i] ↔ photoFaceScores[i]` invariant. The video is validated for
  **safety only** (simplified 2026-06-23 — it carries no identity gate, since
  it is display-only and the old face-presence / owner-match checks reused the
  same brittle CompareFaces path and bounced legitimate friends / scenery /
  party clips). Before persistence, `VIDEO_SAMPLE_TARGET_FRAMES` (12) frames are
  sampled evenly and independently moderated (OpenAI + AWS), and the audio
  transcript is moderated; any confidently unsafe frame or an unsafe audio
  transcript is rejected. Friends, groups, parties, and scenery are allowed,
  and the owner need not appear. Videos over 60 seconds or 100 MB are rejected.
  The video is display-only (stored + re-sent by Telegram `file_id`), so the
  size ceiling is a product choice rather than a hard platform cap — but note
  that when `PROFILE_MEDIA_VALIDATION_ENABLED` is on the safety check downloads
  the clip via Bot API `getFile`, and the standard cloud Bot API cannot supply
  files over 20 MB, so 20–100 MB videos can only be safety-validated behind a
  self-hosted Telegram Bot API server. A rejected replacement never overwrites the existing valid video
  and never grants the ticket bonus. Accepted video metadata stores only
  validation version/time; extracted frames, audio, and transcripts are
  temporary and never persisted.
- For accepted export, photos MAY NOT start until the context dump is saved.
  Declined export skips context collection and uses the fallback analysis.
- After a pasted AI memory dump is parsed and saved, the bot plays a
  self-replacing "analysing" status line (one message edited in place through
  a few steps, each held a beat, then deleted before the photo request) to
  surface the psychological-summary + embedding work that just ran. The same
  `runStatusSequence` primitive (`services/ai-stream.ts`,
  `services/analysis-status.ts`) backs the equivalent "agent is working"
  beats at verification submission, the verification soft-skip, each Profiler
  batch boundary, every Profiler question's compose beat (§Phase 1b),
  concierge venue selection, the profile-video
  upload check, the **onboarding photo-burst check** (below), the
  **Type Radar close** (`TYPE_RADAR_PRODUCT_SPEC.md`),
  and the date-card PNG render (§3.7a). Most of these are cosmetic pacing only —
  fixed-duration stubs that narrate real but usually sub-second work and never
  gate the flow. The **Type Radar close** is the one that narrates no work at
  all: it plays after the radar Mini App submits (never after a Skip — nothing
  was rated), the verdicts are already persisted before it starts, and at ~10.7s
  it is by far the longest of these beats. It is also the only one whose copy
  describes something that has not happened yet — "looking for matches" /
  "scanning profiles N" fires mid-onboarding, before photos and liveness, days
  before the Thursday batch. That is a deliberate, founder-approved labor
  illusion, and `RADAR_THINKING_ENABLED` is its kill switch. Concierge venue
  selection is hybrid: the first three beats
  always play out, then the final atmosphere beat tracks
  `until: <venue promise>` and is held until the venue is ready. The
  **date-card render** remains the genuinely slow render
  wait: its status is passed a `until: <render promise>` and the last step is
  **held on screen until the PNG is actually ready** (then torn down before the
  card is sent), rather than running on a timer.

  **A tracked `until` may EXTEND a script, never truncate it
  (`NEVER_CUT_SHORT`, 2026-08-02).** The primitive's default is to cut the
  narration short the moment the work settles — right for a burst check whose
  per-frame verdicts must land immediately, wrong for every beat above that the
  user is meant to read. The date-card render takes anywhere from a fraction of
  a second (a cached photo, a venue with no Places image) to several seconds,
  so under the default the beats a user actually saw varied with it: often only
  the first line, for a couple of hundred milliseconds. On screen that read as
  the flow *stalling* rather than finishing early — the preceding venue-search
  shimmer sat on its final "matching your vibe" beat (a rich draft lingers on
  its own ~30s TTL, and nothing between the two sequences replaces it) and the
  card beats appeared never to arrive at all. The date card (scheduled DM, My
  Date hub, and the blurred Share copy) and the verification check now always
  play their script in full; `until` only ever holds the last beat longer.
  The **profile-video upload
  check** is the other genuinely-slow held wait: while it runs (frame sampling +
  Rekognition face/identity + image/audio moderation + Whisper transcript) its
  first two beats play as pacing and the final "last checks" beat tracks
  `until: <validation promise>` **plus a short deliberate pad**, held until the
  check settles and then torn down before the accept/reject verdict lands in its
  place. All of these `runStatusSequence` "agent is working / analysing" beats
  render through the native rich `<tg-thinking>` shimmer + AI Actions `<tg-emoji>`
  draft path (each call site opts in with `rich: true`; there is **no** global
  env toggle — see deploy.md), and degrade to the classic bottom-of-chat
  edited-message stream when a client can't render rich drafts. The AI-compose
  feel is the intended look for these status beats, so they accept the rich-draft
  tradeoff (the client may treat it as a generated AI reply / reserve scroll
  space). Two flows use the same rich path for streamed *questions*, not just a
  status beat: (1) the Profiler in-batch flow (§Phase 1b), so the post-onboarding
  Q&A reads as an AI composing each question for the user; and (2) the **periodic
  profile-survey "thinking" pause** — during the conversational profile survey,
  every third typed answer the bot holds one short "thinking" shimmer beat
  (~2.5 s, the `think` AIActions glyph) *before* the next question is composed.
  The pause runs strictly first: the "typing…" indicator and the next-question
  generation only start after the shimmer is torn down, so the thinking beat is
  never preceded by a typing indicator. Photo-stage continues, photo/video
  uploads, and context-dump pastes do not count toward the cadence. The
  *content* streams that are NOT thinking-status beats — the match pitch,
  no-match notice, and ice-breaker DMs (`streamDraftsToChat(..., { rich: true })`
  → `streamRichDraftsToChat`) — also stream through the native rich AI-compose
  draft path (their lead "thinking" chunk renders as a `<tg-thinking>` shimmer),
  **but their final persisted message is sent as a plain `sendMessage`, not a
  rich message**: it must stay a normal, non-self-deleting text message, and for
  the pitch the proposal-countdown worker live-edits that final message via
  `editMessageText`. They degrade to the classic edited-message stream when a
  client can't render rich drafts.

### 1.4 Identity verification (Phase 6.3 in code)

**Biometric consent is its own screen (added 2026-08-01).** Before any liveness
session is minted, the user passes an explicit consent step stating what is
captured, who processes it (AWS Rekognition Face Liveness, in the EU), how long
the reference still is kept (90 days), and what declining means (no matching;
the account can be deleted). GDPR Art. 9(2)(a) requires an explicit act for
biometric processing *specifically* — the ToS tick at sign-up is not one, and
neither is tapping a button labelled "Verify now" under copy that never
mentions biometrics, which is what the flow did until this change. The consent
is recorded on `User.biometricConsentAt` + `biometricConsentVersion`, and
**the gate lives in `beginLivenessCheck`, not in the UI**: a client that skips
its own screen gets `409 consent-required` instead of a session, on both the
Mini App (`/v1/verification/mini-app/consent`) and the native rail
(`POST /v1/me/verification/consent`). The first consent's timestamp is
preserved across retries; only the version is refreshed. Withdrawal is a
support path (`legal/privacy-policy.md` §18), because it must also erase the
reference selfie and drop the user out of matching.

After `finalize_onboarding` the bot sends the **verification CTA**
(`handlers/onboarding/verification.ts`):

- **Verify now** — opens the **Verification Mini App**
  (`apps/webapp/verification.html`) via `InlineKeyboardButton.web_app`, so the
  liveness check runs inline inside the native Telegram WebView (no redirect
  anywhere, no in-app browser frame). `/v1/verification/mini-app/init` mints an
  AWS Face Liveness session plus short-lived, single-action AWS credentials and
  writes `verificationStatus → pending`; the Mini App mounts Amplify's
  `FaceLivenessDetectorCore`, which streams the selfie video **device → AWS**
  (it never passes through our server). Terminal detector events POST to
  `/v1/verification/mini-app/event`, and that request reads AWS's verdict
  server-side. **The session is bound to the user who minted it**
  (`User.pendingLivenessSessionId`, written at `/init` and released at any
  terminal outcome): the verdict is always AWS's, but the session *id* is
  client-supplied, so a `complete` naming a session the caller does not own is
  refused with `409 session-mismatch` before AWS is called — otherwise someone
  else's reference selfie could be fed into this user's face-match run
  (added 2026-07-26). **The detector's on-screen copy renders in the user's own
  `User.language`** (all five, `services`-side default English): its single
  line — "move closer", "hold still", "centre your face" — IS the instruction,
  read at a glance while the camera is up, so an untranslated one does not make
  the check harder, it makes it unpassable. The face-detection model and its
  wasm backend are served from our own origin rather than the component's
  default third-party CDNs, which could not load inside the Telegram WebView on
  a mobile connection within the component's fixed timeout. **There is no non-Mini-App fallback:** when `WEBAPP_URL` isn't a
  real HTTPS host (dev without a tunnel) the CTA refuses to send rather than
  render a dead button, because unlike Persona's hosted page the check only
  exists inside our own page. The native iOS client runs the same two steps
  through `/v1/me/verification/native-init` + `native-event`. Passing
  verification grants no free Date Ticket (the `verification_bonus` reward was
  retired); the CTA copy only frames the ELO cost of skipping. Historical
  `verification_bonus` `TicketLedger` rows granted before the change stay valid
  and are never clawed back.
- **📷 Upload different photos** — the way BACK, present on every screen that
  asks for verification (the CTA, the mandatory notice, the stall reminder, the
  gate card, the liveness-retry nudge, and the rejection DM). The verification
  CTA is the first place a user learns their photos will be face-matched, so
  someone who uploaded another person's photos must be able to retreat and swap
  them instead of being stranded in front of a check they know they will fail.
  It reopens the existing photo manager (§2.1 My Profile → My photos, now
  card-based) in a **redo mode** with three deltas: a one-tap **🗑 Delete all
  and start over**, no `MIN_PHOTOS` delete floor (the user is not in the
  matching pool, and at exactly `MIN_PHOTOS` the ordinary per-photo delete is
  refused outright), and a finish path that returns to verification rather than
  the main menu. Finishing still requires `MIN_PHOTOS`. The entry line
  (`verifyPhotosRedoIntro*`) promises the automatic recheck — "no need to redo
  the selfie" — only when a reference selfie is actually still on file; after
  the 90-day GDPR scrub, or for a user who was never liveness-verified, that
  promise would be false, and "will I have to film myself again?" is exactly
  the worry that stalls someone on this screen. Which follow-up lands after
  Finish depends on whether a **stored reference selfie** exists: with one (a
  `rejected` user), the pipeline re-scores the new photos against it — **no
  second liveness pass**; with none, the verification CTA follows.
  **The button's framing is context-aware** (2026-07-26): on the `rejected`
  outcome — a face WAS detected there and didn't match — it leads, above
  Verify, labelled `verifyBtnRedoPhotos`; on the liveness-retry nudge (photos
  are never even looked at on that path) it appears second, labelled
  `verifyBtnRedoPhotosSecondary` ("📷 It's my photos instead") so it reads as an
  unrelated escape hatch rather than a second attempt at the same fix.
  Telegram-only.
- **Skip for now** — *(retired production path — hidden when
  `MANDATORY_VERIFICATION_ENABLED` is on: the CTA then carries only the Verify
  button with the `verifyPitchMandatory` copy, and taps on pre-flip
  Skip / Skip-anyway buttons refuse with `verifyMandatoryNotice` + a fresh
  Verify button — no penalty, no unverified activation; already-skipped users
  stay grandfathered.)* The implementation remains available only for explicit
  local/test configurations so historical callbacks and fixtures can be tested.
  Its old behavior was a *two-step soft skip*. The first tap did **not** apply
  any penalty: the bot plays a short personal **voice note** (native Telegram
  `sendVoice`, OGG/Opus, language-aware across all five onboarding languages
  `en`/`ru`/`uk`/`de`/`pl`) explaining why skipping
  hurts the user's rating, and offers a fork — **reconsider** (re-opens the
  Verification Mini App / hosted flow) or **Skip anyway**. Only **Skip anyway**
  flips `verificationSkippedAt`, drops `Profile.eloScore` by
  `UNVERIFIED_ELO_PENALTY` (= 150 from a 500 default), and activates the user as
  `unverified`. Telegram's native inline-button styles
  render the reconsider action as `success` (green) and the final skip action as
  `danger` (red), with emoji labels retained for older clients. Reversible by
  later passing the liveness check. The voice assets are
  bundled in the bot (`apps/bot/src/assets/verify-skip/`) and sent with an
  in-memory `file_id` cache; a missing asset or send failure degrades
  gracefully to a text message carrying the same fork.

**The 3-minute rule — the constraint the whole flow is shaped around.** An AWS
Face Liveness `SessionId` **expires 3 minutes after it is created, and all
liveness data with it** (confidence score, reference image). Unlike Persona,
there is no webhook and no way to re-read a session later. Two consequences run
through everything below: the `/event` request is the ONLY chance to read the
verdict, so it does that work synchronously before answering; and the reference
selfie must be persisted immediately, because our storage becomes its only
copy.

When `/event` reports `complete`, the server calls
`GetFaceLivenessSessionResults`. A pass (`Status: SUCCEEDED` and
`Confidence/100 ≥ FACE_LIVENESS_MIN_CONFIDENCE`) hands the reference image to
the verification pipeline (`services/verification-pipeline.ts`). Anything else
— `FAILED`, `EXPIRED`, still in progress, a pass with no reference frame, or an
AWS outage — is **retryable**: the user is DM'd a nudge with a fresh Verify
button and stays `pending`. It is deliberately neither `rejected` (that status
is reserved for a real detected face in the photo set that isn't the verified
person) nor `pending_review` (there is nothing for an admin to adjudicate on a
shaky camera capture).

**The retry nudge is split by outcome (2026-07-26), not one generic line.**
Profile photos are never even looked at on this path — `CompareFaces` only
runs after a `passed` result — so every variant states that as a **fact about
where the check stopped**, then gives advice that actually matches what
happened: `not_live` (the check
ran to completion but confidence didn't clear the bar — `verifyRetryNotLive`,
lighting/framing/obstruction tips); `expired`/`in_progress` (the check never
finished at all — `verifyRetryUnfinished`, "go through it without switching
away"); `no_reference` (a genuine pass, but OUR side dropped the frame —
`verifyRetryTechnical`, an apology and "try again", no advice owed). AWS
returns no failure-reason code, so these three are the full granularity
available — a single "shaky camera or low light" guess used to cover all of
them, which was wrong for the two cases where the user did nothing wrong.
**The copy states "we haven't looked at your photos yet", never "your photos
aren't the problem" (corrected 2026-07-27).** All three variants used to open
with the latter, which is a verdict the system has no basis for: `CompareFaces`
has not run, so nothing is known about the photos either way. It is also
straightforwardly false whenever a photo genuinely is someone else — found by
uploading two real photos plus one of a different person, failing liveness at
0.79 confidence, and being told the photos were fine. The reassurance the
variants exist to give (don't go re-upload anything, the camera is what needs
another try) survives intact; the unfounded verdict does not.

1. Take the reference selfie — the bytes AWS just returned on a fresh check, or
   the stored copy on a rerun (`services/identity-selfie.ts`) — and, when it is
   fresh, upload it to `SUPABASE_SELFIE_BUCKET` as `verifiedSelfiePath`. A
   rerun reuses the existing path rather than writing a duplicate object on
   every photo edit.
2. AWS Rekognition `CompareFaces` against every profile photo; record each
   score in `Profile.photoFaceScores` (1:1 with `photos[]`). Each photo is
   bucketed as **pass** (≥ `FACE_MATCH_THRESHOLD_VERIFY`), **borderline**
   (∈ `[FACE_MATCH_THRESHOLD_REVIEW, FACE_MATCH_THRESHOLD_VERIFY)`),
   **fail** (face detected but score below `FACE_MATCH_THRESHOLD_REVIEW`),
   or **no_face** (`faceFound=false`: group photo, scenery, etc.).
3. Decide using the **quorum rule** over detected-face photos. The
   no_face bucket is excluded from the decision (group photos aren't
   informative either way; their 0 score is still persisted so admins
   can spot the offending photo):
   - `verified` — pass count ≥ `FACE_MATCH_MIN_VERIFIED_PHOTOS` (default 1).
     The account holder is provably in the photo set. Auto-activate if still
     onboarding; seed `eloScore` via one cold-start AI vision request
     containing every profile photo. The model returns an independent score for
     each photo; the server uses their arithmetic mean for the 0..100
     attractiveness score and stores both the aggregate and per-photo audit
     details in `eloSeedDetails`. **Any `fail` photos in a verified set are
     removed from the profile** rather than held against the account
     (`photos`, `photoFaceScores`, `uploadedPhotoHashes`, `profileMedia` and
     `acceptedPhotoCount` are rewritten together, guarded on the photo array
     still matching the snapshot taken at pipeline start, so a concurrent edit
     makes it a no-op instead of deleting by a stale index). The drop is
     best-effort and runs AFTER the user is committed as verified — an outage
     must leave the photo in place, never unwind an approval — and the user is
     DM'd `verifyPhotosDropped`, including on an otherwise-silent re-confirm
     rerun, because photos vanishing with no explanation is its own bug. The
     Elo seed and appearance tagging score only the kept photos.
     **Activation is withheld when the drop leaves the profile under
     `MIN_PHOTOS`.** Dropping photos must not become a back door into the
     matching pool with a near-empty profile: every other surface (menu photo
     manager, mobile `/v1/me/photos`) enforces the same floor on a live
     profile, and `buildCandidateSql` has no photo-count filter of its own to
     catch it. Such a user keeps `verificationStatus='verified'` — that is
     permanent and never undone — but stays `status='onboarding'` with
     `onboardingStep='completed'`, i.e. behind the verification gate below,
     and receives ONE combined message (`verifyPhotosBelowMinimum`, notify kind
     `photos_needed`) carrying the outcome, the shortfall, and the photo-manager
     button — not the plain success copy, which would claim they are live. No
     menu, no pinned banner. The Elo seed and appearance tagging are also
     deferred: both are once-only, so seeding attractiveness off a single
     surviving photo would permanently miscalibrate the user's league. Adding
     photos re-runs the pipeline (§1.4 photo-edit rerun), which activates them
     and seeds off the complete set. `/start` in this state surfaces the same
     card via `sendVerificationGateNotice`.
   - `rejected` — at least one `fail` photo **and no pass quorum**: nothing in
     the set identifies this person, while something in it is a different
     person's face.
     **Narrowed 2026-07-27 from "any `fail` is a hard reject".** The old rule
     let one weak score destroy an account that also carried solid matches, and
     its blast radius reached back into upload: the photo gate had to
     pre-emptively bounce anything that *might* score low (a covered face, a
     hand near the mouth), which the audit in §1.3 found was ~82% of all upload
     friction. The anti-impostor property is intact in both directions — a set
     with no genuine match still rejects, and a planted photo never survives on
     the profile either way. What changed is only who pays for one bad photo:
     that photo, not the whole account.
   - `pending_review` — anything else: all-borderline, mixed pass +
     borderline under quorum, or zero detected-face photos
     (`no_detected_faces` reason).
4. Any *infrastructure* failure routes the user to `pending_review`, never
   `rejected` — we don't penalise users for our outages — **except when the
   failure was getting the reference selfie at all**, which is retryable
   instead (corrected 2026-07-26). The distinction is whether a verdict was
   even possible: a Rekognition error or a photo that wouldn't download still
   leaves per-photo evidence for an admin to look at, but with no reference
   selfie nothing was compared, so there is nothing to adjudicate.
   `pending_review` is a deliberate dead end for the user — no button, the
   verification-stall re-engagement sweep skips it (§1.5), and the gate below
   keeps the app locked — so a user routed there over our own storage blip or
   an already-scrubbed reference was stuck permanently behind
   "we're double-checking your photos", with nothing in the product able to
   move them. Such a run now writes `pending` and DMs the ordinary
   `verifyReminderNudge` **with the Verify button**, exactly like a shaky
   liveness capture. One exception, mirroring rule 5: if the user was already
   `verified` going into the run, that status is *restored* rather than
   downgraded — our outage must never drop a verified user out of the match
   pool — and they are not nudged at all.
5. `selfie-retention` cron deletes `verifiedSelfiePath` 90 days after
   `verifiedAt` (GDPR Article 9). The user stays `verified`; only the
   reference image is scrubbed — and because AWS cannot re-issue it, that
   genuinely ends the reference's life. A verified user who edits their photos
   after the scrub is asked for **one more liveness check** rather than being
   refused with a dead-end error (`reference_expired`, surfaced once per upload
   burst with a Verify button, not per rejected photo). Their `verified` status
   and match eligibility are untouched while they do it: the rerun bails
   *before* flipping anything, so deleting a photo can never silently drop a
   long-tenured user out of matching.
   **The re-run is actually reachable (fixed 2026-07-30).** `beginLivenessCheck`
   refused every `verified` user outright — "re-running would burn a check for
   no decision" — which was true of a user whose reference selfie still exists
   and false of exactly the cohort this rule is about. So both surfaces asked
   the user to verify again and then the only call that could do it answered
   `409 already_verified`: the Telegram `verifyReferenceExpired` prompt, its
   Verify button, and the iOS `409 reference_expired` path all dead-ended in the
   same place. The refusal is now conditional on `verifiedSelfiePath` still
   being there. Nothing else about the rule changes — in particular the session
   mint does **not** write `pending` for such a user, because matching admits
   `verified` and nothing else (§3.2), so a downgrade for the duration of the
   check would take a long-tenured user out of the pool over a photo edit — the
   same demotion `triggerVerificationRerun` already refuses to make.
   **Sequencing the client must respect:** the new reference selfie is written
   at the END of the pipeline (`persistOutcome`), not when the check passes, so
   `native-event` answering `processing` does not yet mean a photo upload will
   pass the gate. The retry belongs on the client, as a short bounded wait —
   never as a re-prompt for the photo the user already chose.

For Telegram Live Photos, verification always uses the static photo frame
stored in `Profile.photos[]`; the short video part is display-only for
profile and match cards.

The same pipeline runs again on every photo edit. The bot/mobile photo
handlers and Aether's `attach_profile_photo` tool fire
`triggerVerificationRerun` after every add/delete/replace,
which clears the `(personaInquiryId, faceMatchedAt)` idempotency marker (the
column keeps its historical name and now holds the liveness session id),
flips `verificationStatus` back to `pending`, and re-launches the
pipeline against the new photo array. Persistence of `photoFaceScores`
is gated on the photo array still matching the snapshot taken at
pipeline start — if the user edits photos again mid-run the stale scores
are discarded rather than corrupting the `photos[i] ↔ photoFaceScores[i]`
alignment. The admin "rerun verification" endpoint shares the same code
path.

**Outcome DM.** Every terminal outcome is DM'd in the user's own
`User.language` (shared i18n `verifyOutcome*`; the copy used to be hardcoded
English). `rejected` is the one outcome the user can act on, so it carries both
recoveries inline — **📷 Upload different photos** (leading, above Verify —
the more likely fix when a face WAS detected and didn't match) and
**🟢 Verify now** — rather than sending them hunting through menus. The copy
itself states both branches explicitly: if the photos aren't the user, swap
them and the pipeline re-checks automatically; if they are, the match just
came out weak and re-running verification in better light is the fix (rewritten
2026-07-26 — the two-branch split used to be far less explicit). One
exception, so the success copy is
not repeated at users who have nothing to do with it: a **rerun that merely
re-confirms an already-`verified` user** sends no DM. Every profile-photo edit
auto-reruns the pipeline (menu photo manager, mobile `/v1/me/photos`, Aether),
so without this an active user re-read "verification passed, your profile is
live" every time they opened their photos. The suppression is scoped to
`verified → verified`; anything the user can act on (`rejected`,
`pending_review`) is always announced, including on a rerun. Mirrors the
existing `statusMessageId` guard that already stops the menu + pinned banner
from being re-sent on a rerun.

**The DM waits for the "analysing your check" status to leave the screen
(2026-08-02).** Passing liveness starts two independent async chains — the
face-match pipeline, and the ~7s shimmer narrating it — and nothing connected
them, so whichever finished first decided what the user read. AWS answers fast
and `CompareFaces` over three photos is often faster than the script, so the
common case was the verdict ("the photos on your profile don't match your
verification selfie") landing *underneath* a shimmer still saying the check was
being completed: the bot contradicting itself on the one screen where the user
is being told they failed. A gate (`services/outcome-gate.ts`) now carries both
signals — the pipeline holds every user-facing message (the outcome DM, the
dropped-photo notice, the menu + pinned banner) until the status is torn down,
and tells the status when it is ready to speak so a *slow* run holds its last
beat instead of ending in silence. It is scoped to the fresh-liveness path,
the only caller that narrates: photo-edit reruns, the admin recheck and the
native rail are unchanged and DM immediately. Both directions are bounded, so
a status that dies before its teardown can never swallow a verdict and a run
that hangs can never keep a shimmer alive forever.

**Verification gate (the app stays locked).** `status='onboarding'` with
`onboardingStep='completed'` means the profile is finished but liveness is not,
and since verification is mandatory that user is NOT in the app yet. The one
exception — same state, but `verificationStatus='verified'` — is the
under-`MIN_PHOTOS` case above: liveness passed, the photo set did not survive
it, and the same gate holds them until they refill the profile. While they
are in that state the ONLY reachable actions are the two that can clear it:
running/retrying verification, and re-uploading photos. Every other Telegram
surface — the main menu, My Profile, pause/resume, Settings, tickets, premium,
referral, the free-text menu agent, and the `/menu` `/edit` `/profile`
`/settings` commands — answers with the verification card instead. `/start`
likewise surfaces their verification state and stops there (no menu, no pinned
banner). Matching, date, and Profiler workers already filter on `status='active'`
and never touch them.

**Match-pool inclusion.** A user is eligible only when
`verificationStatus='verified'`, or when they belong to the explicit legacy
cohort `verificationStatus='unverified' AND verificationSkippedAt IS NOT NULL`.
New `unverified`, `pending`, `pending_review`, and `rejected` users never enter
candidate or weekly-batch queries. The photo-edit auto-rerun handles
rehabilitation and admin moderation handles borderline cases.

### 1.5 Re-engagement chain

Drop-off during onboarding triggers a 5-step retention loop
(`workers/re-engagement.ts`). Steps fire at +15 min, +2 h, day-of 19:00,
day-of+1 19:00, day-of+2 14:00 (Kyiv). Quiet hours **23:00–09:00 Kyiv** are
deferred to the next 13:00. Any user activity (consent click, language pick,
agent reply, photo upload) resets the chain to step 0; finishing onboarding
nulls `reEngagementNextAt` permanently.

**Verification-stall nudges (Registration v2).** With
`MANDATORY_VERIFICATION_ENABLED` on, a user who finalized onboarding but
hasn't passed liveness (`status='onboarding'`, `onboardingStep='completed'`,
`verificationStatus ∈ {pending, unverified}`) would otherwise fall outside the
chain above. The verification CTA re-arms the chain, and the same worker runs
a second sweep that sends the localized `verifyReminderNudge` (with the Verify
button) on the same decaying cadence until the pipeline activates the user or
the chain exhausts. `pending_review`/`rejected` users are deliberately NOT
nudged — they already did their part (or got rejection guidance).

**Re-`/start` while still verification-gated.** Whenever a finalized-but-not-yet
activated user (`status='onboarding'`, `onboardingStep='completed'`) reopens the
bot, `/start` must NOT show the `onboardingComplete` "your AI is already looking
for a match" greeting — the matchmaker has not started for them. It instead
surfaces their real verification state (`handlers/onboarding/verification.ts`
`sendVerificationGateNotice`): the `verifyReminderNudge` + Verify/photo buttons
for `pending`/`unverified`, `verifyOutcomePendingReview` for `pending_review`,
`verifyOutcomeRejected` + both recovery buttons for `rejected` — and it stops
there. The menu is **not** shown and the next-match banner is not pinned; the
gate above owns everything until verification clears. This holds independent of
`MANDATORY_VERIFICATION_ENABLED` (the same `onboarding`/`completed` state exists
whenever liveness verification is enabled and the user hasn't yet cleared it).

## Phase 1b — Profiler

The **Profiler** (`workers/profiler.ts` + `services/profiler.ts`,
`services/profiler-schedule.ts`) collects gender-specific Q&A *after*
onboarding to fuel the §Phase 4 icebreakers and wingman hints. It is
**not** an input to the matching algorithm — purely fuel for icebreakers/hints.
Telegram-only in v1.

- **Entry.** The first question fires **~10 min after onboarding completes**
  (`PROFILER_ENTRY_DELAY_MS`), armed at `finalize_onboarding`; the scheduler
  defers it out of the user's local quiet hours. Existing/legacy users are
  lazily seeded by the worker, their first batch landing at the next window.
- **Batches.** Questions are sent in **batches of 3** (`PROFILER_BATCH_SIZE_NORMAL`).
  **Every** question — the first of a batch and every follow-up — is delivered
  through the same **native Telegram AI-compose** path (Bot API 10.1 rich
  messages, `streamComposedRich`), so the experience is uniform. Each question is
  **one** rich-message draft (a single `draft_id`) carrying, in order: a
  `<tg-thinking>` **shimmer status**, then the question persisted as a real
  message carrying the Skip button. Because it's a single draft, the client
  reserves/collapses the "AI is composing" scroll space exactly **once** per
  question — no mid-stream jump. The status beats differ only by context: a
  **follow-up** (after an answer/skip) shows acknowledge → "thinking"
  (`profilerNextQuestionSteps`, 1.2s + 1.2s); the **batch opener** (after a
  long window pause, nothing to acknowledge) shows just "thinking"
  (`profilerOpenQuestionSteps`, 1.25s). The between-batch confirmation
  ("Preference card updated ✅") uses the same shimmer path. If a client can't
  render rich drafts every path falls back to the classic edited-message stream.
  Two deliberate departures from the other rich-status flows (§1.3), both
  because the Profiler repeats this beat several times per batch rather than
  once per rare event: the shimmer is **bare** — no `<tg-emoji>` glyph and no
  leading emoji in the label — and the **question text is NOT streamed**. It is
  sent as a single chunk, so it lands whole as an ordinary message instead of
  typing itself out; the old word-by-word reveal read as latency, and a question
  the user has to think about is better shown at once.
  Between batches the Profiler pauses to the next **morning (09:00) / evening
  (18:00) window in the user's local time** (`Profile.timeZone`, derived from
  the dating city; `Europe/Kyiv` fallback). When the next drop is within
  `CADENCE.profilerRushWindowMs` (**48 h** under `weekly`; 4h under the inert
  `daily` profile — a fixed 48h would be permanently true under a 24h interval,
  so this value is cadence-sourced rather than a flat constant) it switches to
  **rush mode**: batches shrink to **2** to fill the profile before the event.
- **Date-negotiation gate.** The Profiler stays **silent while the user is
  mid date-planning** so its icebreaker questions never interrupt the flow they
  are meant to fuel. A due batch is held (deferred to the user's next local
  window) whenever the user is on either side of a match in an in-progress
  negotiation — `proposed` (pitch decision), `negotiating` (calendar
  scheduling), or `negotiating_venue` (venue selection)
  (`PROFILER_BLOCKING_MATCH_STATUSES` / `hasActiveDatePlanning`). `scheduled` is
  intentionally **not** a blocking state: once the date is locked in, the wait
  before it is a fine moment to gather icebreaker fuel. The gate also applies
  mid-batch — if a negotiation starts while a batch is in flight, the answer in
  hand is saved but the remaining questions pause to the next window. So the
  questions only ever land when the user is idle-and-waiting or simply waiting
  on a `scheduled` date, never during the pitch/scheduling/venue steps.
- **Skip.** Every question has a **Skip** button. A skipped question returns
  **once** at the end of the current cycle; skipped twice in a cycle, it drops
  until the next drop cycle. Answered questions are never re-asked (except the
  situational ones below). **Silence is an implicit skip**: a question left
  unanswered for `PROFILER_STALL_TIMEOUT_MS` (**6 h**) is recorded with the same
  return-once semantics, **the question message is deleted**, and the schedule
  re-opens at the user's next local window — without this the Profiler
  dead-locked, since the dispatch sweep only picks users with no active
  question, so one ignored question silenced it permanently. The deadline is
  sized to the daily window rhythm: at a full day, one ignored morning question
  cost the user the whole day of Profiler; at 6 h it is reclaimed in time for
  the evening window.
- **An expired question is removed from the chat, not just de-buttoned
  (2026-07-28).** Reclaiming used to only strip the Skip keyboard, leaving the
  question text sitting there — which reads exactly like an open question the
  bot is waiting on. Nothing on the server still pointed at it (the active-question
  claim was released), so a user who came back and answered it fell through to
  the menu agent, which replied with no idea what they were referring to. The
  missing button was the only visible signal, and it is not one a user reads as
  "this is dead". Deleting the message is what makes the chat agree with the
  server. Telegram only lets a bot delete its own message for 48 h — the 6 h
  deadline clears that comfortably, but the worker's legacy backlog arm can
  reclaim far older questions, so a refused delete falls back to stripping the
  keyboard. A **resolved** question (answered or explicitly skipped) is never
  deleted: it is the context for the answer below it, and the user knows they
  dealt with it — only its Skip button goes.
- **A question owns the chat only while it is live.** An active question is NOT
  a standing claim on everything the user types. Plain text is recorded as its
  answer only when the question still owns the conversation:
  - the **implicit window** (`PROFILER_ANSWER_WINDOW_MS`, 90 min from sending,
    `Profile.profilerAnswerWindowUntil`) is still open, AND
  - the user hasn't done anything else since — any command, menu tap, or other
    flow closes the window immediately, because the next thing they type is for
    the assistant, not for the question.

  Outside that, free text falls through to the menu agent as normal. Two
  explicit escapes keep a slow answer working regardless of the window: the Skip
  button stays live until the stall deadline, and a Telegram **reply** to the
  question message (anchored by `Profile.profilerQuestionMessageId`) is always
  recorded as its answer. Without this bound the Profiler mis-read ordinary
  conversation: a question asked hours earlier turned "when is my date?" into an
  answer, complete with an acknowledge shimmer and the next question, leaving
  the user's actual question unanswered.
- **One reply per question.** A question is resolved by an atomic claim on
  `Profile.profilerActiveQuestionId`, so exactly ONE answer or skip can ever
  advance the batch. The Skip keyboard is stripped from a question once it is
  resolved — skipped or answered — so a dead question stops looking like it is
  still waiting; a question reclaimed as an implicit skip is deleted outright
  (above). A stale/replayed tap on an
  older question's button is a no-op — it
  neither records a second skip nor pushes out an extra question. Free-text
  answers are coalesced over a short debounce window
  (`PROFILER_ANSWER_DEBOUNCE_MS`), so an answer split across several messages
  is one answer to one question rather than one answer per message.
- **A refusal is recorded as a skip, not as an answer (2026-08-07).** Free text
  used to be written verbatim by `recordProfilerAnswer` with no check that it
  was an answer at all, so "не хочу отвечать" was stored as the ANSWER to "what
  are you watching right now?" with `skipped: false`. That cost twice: answered
  questions are never re-asked, so the refusal burned the question permanently,
  and the text became icebreaker / wingman-hint fuel — the bot could hand a
  partner "не хочу отвечать" as though it were an interest. `isProfilerRefusal`
  (`services/profiler-intent.ts`) now classifies the coalesced text first;
  a refusal goes through `skipTransition` exactly like a tapped Skip, so the
  question returns once.
  **It also ends the batch**, releasing the active question and deferring the
  rest to the user's next local window — the same release the date-negotiation
  gate performs. Someone who just said they don't want to answer is the last
  person to ask two more questions of. Deliberately a **pause, not an opt-out**:
  it self-heals at the next window, so a one-word "потом" can never silently
  retire the Profiler for an account. A permanent "stop asking me these" is
  **not** built — it needs a Settings surface and a way back, which is a
  separate product decision.
  Classification is deterministic, not an LLM call: it runs on every Profiler
  reply, and the failure modes are asymmetric — a missed refusal degrades to
  the old behaviour, while a false positive discards a real answer. So matching
  is on the **whole utterance** ("не хочу в кино, а вот на концерт хочу" is an
  answer), and **bare negatives are deliberately excluded** — "нет" / "no" /
  "ні" answer a large part of the question bank ("do you play any sport?") and
  must stay answers.
- **Cross-cycle persistence.** Unanswered questions carry into the next drop
  cycle in priority order; the Profiler never resets. Completion is **silent**
  (no "profile complete" ping). No progress indicator, no "why we ask" copy.
- **Questions.** Women are asked from the "what you want in a partner/date"
  angle (fuels the man's *hints*); men from the "who you are" angle (fuels the
  woman's *icebreakers*). The bank lives in `packages/shared/profiler-questions.ts`
  (~14 per gender) and covers icebreaker flavor that onboarding does not capture:
  chronotype, sport, turn-offs, shared interests, media, food, humor, travel,
  pets, surprises, communication style. Questions the onboarding §1.3 vibe
  answers already cover were **removed** to avoid duplication: `f_activity_pref`
  ("active vs calm" = the energy axis) and `m_ideal_evening` (≈ the ideal-Friday
  question).
- **Situational questions repeat (`refresh: "cycle"`).** A question is one of
  two kinds. **Stable** traits (lark/owl, sport, turn-offs) are asked once and
  answered forever. **Situational** ones — "what are you watching / reading /
  listening to", "plans for the coming weekend", "best part of your week" —
  describe *right now*, so they are re-asked once per drop cycle and their new
  answer overwrites the previous one. This is what makes a weekly cadence worth
  having: without it the bank simply runs out after a couple of days and the
  Profiler goes quiet, and the icebreakers keep quoting a month-old answer.
  Selection order is unchanged for the first two passes (never-asked, then a
  skipped question eligible to return); the refresh pass comes last, so a stale
  situational question never crowds out something never asked. Once every
  once-question is answered and the current cycle's refreshables are also
  answered, the scheduler does not go permanently silent: it keeps a silent,
  cost-free check at each daily window (`finishOrAwaitNextCycle`) so a
  refreshable question becomes due again the moment the cycle rolls over — a
  true `finish()` (which nulls the schedule forever) fires only for the
  theoretical case of a bank with no refreshable question at all.
- **Storage.** One `ProfilerAnswer` row per (user, question): `priority`,
  `answerText`, `skipped`, `skipReturned`, `cycleId`. A refreshed answer
  overwrites the row (only the current snapshot matters for icebreakers).
  `cycleId` (`profilerCycleId`, `services/profiler.ts`) is an **ISO-8601
  calendar-week key** ("2026-W31"), deliberately independent of the matching
  batch date: it used to derive from `getNextBatchDate`, which changes daily
  under the `daily` cadence profile and would make every situational question
  eligible to re-ask once a day instead of once a week regardless of how often
  matching actually runs.
- **Weighting.** Icebreaker/wingman-hint generation emphasises a partner's
  answers by priority weight (`high 1.0 / medium 0.5 / low 0.2`,
  `PROFILER_PRIORITY_WEIGHTS`). Profiler answers are the **primary** source;
  generation falls back to `psychologicalSummary` when a user has no answers
  (see §3.7 wingman and §Phase 4 icebreakers).
- **Off switch.** `PROFILER_CRON_SCHEDULE` (default `*/15 * * * *`).

## Phase 2 — Main Menu & Persistent Surface

### 2.1 Telegram bot menu (`handlers/menu/main.ts`)

The persistent inline menu uses a `custom_emoji` entity for the 🎓 title icon
when `CUSTOM_EMOJI_MENU_ID` is set. **Bot API limitation:** inline keyboard
button labels CANNOT carry `custom_emoji` entities — buttons fall back to
plain Unicode emoji.

Layout: a conditional **Switch city** row leads when the account's city is not
a launched market (see below), then a conditional **My Date** row (only while a live match
exists — see below), then the combined **My Profile** row, the paired
**Pause/Resume Matching · Settings** row, followed by the single-button
rows in order: **Profile Video**, **My Tickets** (feature-flagged),
**Report / Help**.

- **Switch city to a launched market** (`menu:city`) — a conditional
  native-`primary` first row, present **only** for an account whose
  `Profile.homeCityKey` is not a launched market (§1.3). Registration can no
  longer create one, so this exists for accounts made before that gate: matching
  is same-city, so nothing else in this menu can work for them until they move.
  It leads because it is the only thing standing between them and a match, and
  it never competes with the My Date anchor below — such a user cannot have a
  live match. Tapping it opens a card naming their city and explaining why, with
  one confirm (`menu:city:switch`) that moves the dating city to the launched
  market. **Deliberately not a city picker**: it is a one-way move to the one
  place Gennety operates, and the only city change the product offers after
  onboarding. Non-destructive — only `Profile.home*`/coordinates/`timeZone`
  change; status, profile, photos, verification, tickets and Premium are
  untouched, so the user lands in the next Thursday drop as they are. A failed
  save says so rather than claiming success. Telegram-only; iOS uses
  `POST /v1/me/home-location`.
- **My Date** — a conditional row, present **only** while the user has an
  in-flight match (`proposed` / `negotiating` / `negotiating_venue` /
  `scheduled`, via `services/active-match.ts`). A `proposed` match becomes
  visible to each side only after that side's own `pitchMessageIdA/B` exists;
  creation or delivery to the other side never reveals it early. It is the visual anchor of the
  menu: native **`primary`** style (blue) + an optional animated icon
  (`CUSTOM_EMOJI_DATE_ID`) so it stands apart from the ordinary gray rows. A
  `scheduled` date shows a live countdown in the label (💫 "My date · in Xd Yh",
  reusing the status-banner rounding); the earlier stages show "⏳ Date being
  planned". Tapping it (`menu:date`) opens the **My Date hub**
  (`handlers/menu/my-date.ts`) — the single durable re-entry to a date whose
  original chat messages have scrolled away. It re-surfaces:
  - the partner **date card** (re-sent instantly from the cached Telegram
    `file_id` in `Match.dateCardFileIdA/B`; re-rendered on demand and re-cached
    when absent and `DATE_CARD_FEATURE_ENABLED`; a protected partner-photo album
    + text otherwise), carrying the venue block + the tappable `date_time`
    phrase;
  - every still-relevant action, each reusing an existing handler (the date /
    matching routers run before the menu router, so their callbacks are already
    live from a hub keyboard): 📍 Open in Maps, **Change venue** (while the paid
    board is open), **Share** (blurred off-platform copy), **Enter chat** (while
    the coordination proxy window is open), **Cancel date** (native `danger`;
    available for the whole `scheduled` window — the emergency handler keeps its
    own two-step red confirmation), **Report**, **Back**.

  The hub deliberately does **not** surface ice-breakers or the wingman hint:
  those are time-gated *pre-date* content the lifecycle drops shortly before the
  meeting (T-5h / T-1.5h, §Phase 4), and their whole point is that arrival right
  before the date. They are not durable "date details" to browse from the menu,
  so the hub is a status/actions surface only.

  For the pre-`scheduled` stages the hub is a lightweight card re-surfacing the
  one Mini App entry the user might have lost: the match-specific Ticket CTA
  while `ticketStatus` is `pending`, `partial`, or `refund_pending`; Calendar
  when it is `completed`, `refunded`, `expired`, or absent; or the Location
  picker for `negotiating_venue`. Every restored link carries the caller's
  current language and theme. No new product mechanic is introduced; the
  hub is purely a second entry point to existing flows.
- **A menu edit owns the chat only while its claim is live (2026-08-08).** Five
  menu sub-flows read the next plain message as their answer — About me, Who I
  want, What I do, the partner age range, and the post-cancellation "why did you
  leave?" — and until now none of them had a deadline. The state lives in
  `bot_sessions`, so it survived restarts, deploys and weeks of silence: a user
  who tapped **About me**, got distracted and closed Telegram had their NEXT
  message, on any topic and any number of days later, written verbatim into
  `Profile.psychologicalSummary` — the profile's accumulated psychological
  signal and the dominant embedding input (`V_explicit`, 0.65) — with no
  snapshot to restore from, while the question they actually asked went
  unanswered. This is the same rule §Phase 1b already states for the Profiler
  ("an active question is NOT a standing claim on everything the user types")
  and §Phase 4 applies to the emergency-cancellation reason; the menu router was
  the side of the product it had never reached. Each claim now carries a
  deadline sized by what the answer costs to get wrong
  (`services/menu-text-claim.ts`): 30 minutes for the two states that feed the
  matching embedding, 60 for the ones whose mistake is on screen and one tap
  from being fixed. A command, or any button that is not the claim's own, closes
  it immediately. **Expiring is a soft failure by construction** — the message
  falls through to the concierge agent, which can see the profile and offer the
  editor straight back, so an over-short window costs one tap while an over-long
  one costs the profile. The photo and video managers are deliberately outside
  the rule: they consume media, and a stray photo lands in a gallery the user
  can see and delete rather than silently over a field.
- **The About me editor shows the text it is about to replace (2026-08-08).**
  Whatever the user sends next replaces `psychologicalSummary` in full, which is
  why the concierge's own `update_bio` tool **refuses** a rewrite that collapses
  a substantial existing text and hands the user a button here instead — on the
  stated grounds that "the editor shows the current text so they can edit it
  themselves". It did not. Someone arriving from that refusal is the one person
  the product already knows is about to shorten a long bio, and that button
  skips the profile screen, so they saw "write a few lines" and no sight of what
  they were deleting. The prompt now carries the current text (plain, uncapped
  by Markdown, truncated only to stay inside Telegram's message ceiling).
  Deliberately **not** a second collapse guard: the agent's guard exists to move
  that decision here, so refusing it here as well would leave no way to shorten
  a bio at all. The fix is to make the editor's premise true, not to close the
  door behind it.
- **My Profile** — the single combined view/edit surface: generated bio + photos
  (and profile video when present), followed by **About me**, **Who I want**,
  **What I do**, and **My photos** actions. **Who I want** shows both the
  current preferred-partner age range and the free-text `partnerPreferences`
  (max 500 characters) and edits them independently. `firstName`, `age`,
  `email`, and `universityDomain` remain fixed post-onboarding. When no video
  is set, a one-line hint points to the Profile Video entry.
  **My photos** opens the photo manager: each photo is its own message (a
  "card") with a single 🗑 delete button directly under it, followed by a
  persistent counter + actions panel (➕ add, ✅ Done — plus 🗑 Delete all in
  redo mode, §1.4). Deleting a card drops only that one message and updates
  the panel's count in place; the panel is replaced rather than edited
  whenever new cards were just sent **or the panel carries a burst summary**,
  since Telegram cannot move a message below newer ones and a summary the user
  must read may not stay quietly above their own uploads and rejection replies.
  Closing the manager (✅ Done, or reopening it, **or abandoning it by tapping
  any other menu button** — corrected 2026-08-03) leaves the cards in the chat as
  the reviewed gallery but **strips their delete buttons** — nothing tracks what
  they point at once the session ends, and a button that does nothing is its own
  bug. The abandon path used to only clear the tracking, which lost the message
  ids for good: every card kept a live-looking 🗑, the panel kept its ➕ / ✅, all
  of them silently no-ops, and no later reopen could retire them because there
  was nothing left to retire. A card whose message can no longer be deleted
  (Telegram allows that for 48 h only) is instead captioned as deleted and loses
  its button.
  (Replaced 2026-07-26: the previous design put a numbered
  delete button per photo under one shared album, which required counting
  positions in a Telegram-arranged grid — a wrong tap was easy — and re-sent
  the whole album on every single delete.) Uploads
  into it are **coalesced into one burst**, matching the onboarding media stage
  (§1.3): a single held "uploading your photos" shimmer covers the whole batch,
  and one control message reports the result — `n` added, the running
  `total/MAX`, and a per-frame rejection replied to the offending photo. Before
  this the manager answered every frame separately, so a 4-photo album produced
  four "Photo k/10" messages interleaved with detached rejection lines while
  later frames were still validating (each photo takes seconds), which read as
  the bot losing track.
  **That shimmer counts too (2026-08-07).** It carries the same two scripts as
  the onboarding one — plural, and a singular one for a burst that is still a
  single photo — chosen from `media_group_id` on the first frame and revised in
  place if the burst grows (§1.3 states the mechanics; `reviseStatusScript` is
  shared by both). This surface needed it MORE than onboarding, not less: it is
  reached to swap one bad photo, and from the §1.4 verification gate's "upload
  different photos", so a lone upload is the usual case here rather than an edge
  one — and "uploading your photos" over a single frame is simply false. The
  closing beat ("almost there") says nothing about how many and is shared by
  both scripts rather than duplicated. A **video** sent into the manager is accepted here too
  (same shared display-only, safety-only validator and one-time ticket bonus as
  the Profile Video entry) — it used to fall through to "send me photos" and be
  silently dropped, which strands a user whose menu is locked behind the §1.4
  verification gate. Reaching `MAX_PHOTOS` no longer auto-commits and ejects the
  user from the editor; the cap is reported and ✅ Done stays theirs to press.
- **Pause Matching** — uses an atomic compare-and-set transition and permits
  only `active → paused`; Resume permits only `paused → active`. Menu actions
  cannot overwrite onboarding or moderation-owned states (`suspended`,
  `pending_investigation`, `banned`).
- **Settings** — change `language`; **change theme** (a light/dark inline
  toggle mirroring the language flow — persists `User.theme`, which every Mini
  App and both PNG cards honor). A successful language/theme change atomically
  clears only that user's side of the scheduled date-card cache; a concurrent
  stale render is prevented from writing the old variant back. The shared Mini
  App URL builder always carries current `lang` + `theme` for Calendar,
  Feedback, Location, Onboarding, Verification, Ticket, Ticket Store, and Venue
  Change. Settings also provides **Delete Account**, which now offers a softer
  alternative first (Telegram-only, see below). It carries **no "Verify your
  account" entry** (removed 2026-07-24): verification is mandatory, so it is not
  a setting — a user who hasn't passed it never reaches this screen (§1.4's gate
  holds them), and one who has has nothing to do there. The two cases that used
  to need it now carry their own affordances: the verification card itself and
  the `rejected` outcome DM. Consequence: the legacy pre-flip skip cohort
  (`verificationSkippedAt != null`) no longer has a self-serve way to clear
  their `UNVERIFIED_ELO_PENALTY` — an accepted trade for a cohort that can no
  longer be created.
- **Profile Video** — the first single-button row: an **always-visible**
  main-menu entry to add, replace, or
  remove the optional display-only profile **video** *after* onboarding (the same
  upload + safety-only validation as the §1.3 media stage, via the shared
  `services/profile-video.ts`). The video is never added to `photos[]` and never
  triggers a verification rerun, so the `photos[i] ↔ photoFaceScores[i]`
  invariant is untouched. When `TICKET_FEATURE_ENABLED` and the one-time video
  bonus is unclaimed, the button shows a 🎁 marker and the screen promises a free
  Date Ticket; the bonus is granted idempotently via `Profile.videoBonusTicketAt`
  (same claim as onboarding, so it pays at most once across both surfaces).
  Removing the video does not reverse an already-granted bonus.
- **My Tickets** — (only when `TICKET_FEATURE_ENABLED`) shows the user's
  `ticketBalance` and a `web_app` button into the ticket store Mini App
  (`tickets.html`) to pre-purchase bundles ahead of any date. See §3.5b.
- **Report / Help** — opens the support handle.

**The concierge answers in the context of the last thing on screen
(2026-07-28).** Free text (and a transcribed voice note) goes to the menu
agent, and until now that agent could see only its OWN previous replies:
`User.messageHistory` is written by the agent, while everything else a user
sees — the pitch, the date card, the calendar prompt, a venue-change notice, a
nudge — is sent from ~276 other call sites. So a user who tapped "Keep this
place" in the venue-change Mini App, got "You're keeping Aroma Kava, as
originally planned", and asked **"Почему?"** was answered about their
onboarding profile being complete: the most recent thing in the agent's history
was the tail of onboarding, days earlier, and it answered that instead.

The agent now reads a **chat timeline** (`ChatEvent`, ARCHITECTURE.md) of the
last ~12 things that happened in the chat, rendered into its system prompt
after the live match status. Each entry says who acted, **in what form** (a
plain message, a photo card, a video note, a Mini App action), **what buttons
were on offer** by their visible labels, and what the user did next — a tap is
recorded as *"tapped «📍 Сменить место»"*, not as raw callback data. Mini App
submissions are included, because that is where much of the product actually
happens and none of it passes through the chat. The prompt states the rule
explicitly: a bare follow-up with no subject of its own ("почему?", "и что
теперь?", "это точно?") refers to the LAST timeline entry, and when the
timeline does not say why something happened the agent says what it can see and
asks, rather than inventing a reason.

The timeline is **read-only context in v1**: the agent understands the last
screen but presses nothing on the user's behalf; every action still needs the
user's own tap. Rows are swept after 30 days (§GDPR).

**The whole chat is recorded, from `/start` (founder decision 2026-07-31).**
Recording used to begin only at `onboardingStep = 'completed'`, which kept the
typed OTP code and a pasted AI-memory export out of the table by construction.
The cost was that **registration — the funnel most worth being able to read —
was the one stretch of the conversation the admin dialog reader could not
see**: no photos, no buttons, no Mini App steps, nothing but the onboarding
agent's own turns. The founder owns that data and reads it in a
single-operator dashboard, so the tradeoff was taken deliberately. What it
costs, stated rather than discovered later: a typed OTP code lands in
`summary` (expired long before anyone reads it, gone in 30 days), and a pasted
AI-memory export lands as a **≤300-character excerpt** via the existing
summary truncation — so §1.3's "the raw pasted response is transient" now
means "except for that excerpt". The phone number itself still never lands
there: the contact share is recorded as the event, not the digits. Onboarding
rows are subject to the same untrusted-data fence as everything else in the
timeline. The same change stops the agent replaying onboarding-era
turns from `messageHistory` at all: only its own turns from the last 24 h are
replayed, while the full column is retained for the admin conversation viewer
and the re-engagement worker. The **timeline** is Telegram-only; the mobile
Aether concierge keeps its own `Message`-row history unchanged. The menu agent
itself is *not* Telegram-only, despite what this paragraph used to claim: the
same `runMenuAgentTurn`, with the same tools, also backs the JWT
`/v1/assistant/{ask,voice}` routes (corrected 2026-07-29 — the mistake had a
cost, see the access gate below).

**What the agent is allowed to know, and in which language (2026-08-01).**
Three corrections, all from an audit of what the concierge could actually see:

- **It knows the account facts users ask about most.** `ticketBalance`,
  Premium state, dating city and verification status are rendered into the live
  context (the paid two only under their feature flags). "How many tickets do I
  have?" previously had no answer path at all — not in the context, not in a
  tool — so the only honest move was to send the user to a menu screen to read
  a number one column away. Prices in the playbook are read from
  `TICKET_PRICE_CENTS` / `PREMIUM_PRICE_USD_DISPLAY` / `REMATCH_PRICE_USD_DISPLAY`
  rather than written into the prose, where an env change would have left the
  agent quoting a stale one.
- **It knows about Rematch (§3.11), including who must never hear about it.**
  The feature was live in production while the playbook had no entry for it, so
  the agent's own "only describe what is listed here" rule made it deny a paid
  feature the user could buy. The section carries the asymmetry as a hard rule:
  a woman is never told the feature, its price, or that a pitch was paid for —
  the gift framing is the product, and describing it as a purchase is what
  would spoil it.
- **Language is no longer the model's call.** The instruction was "respond in
  the user's preferred language unless they switch", which on a message
  carrying no language — an emoji, "ок", a link, digits — handed the decision
  to the model, and it flipped to English. The rule is now unconditional, with
  the non-signals named explicitly; the language changes only through an
  explicit request routed to `set_language`. The turn's fallback line is
  localized for the same reason: an empty completion used to answer a
  Russian-speaking user with a hardcoded English sentence, which reads exactly
  like the bot switching languages on its own.

The agent is also told to **check before it asserts** — read the live match
block and timeline rather than infer — and a `scheduled` date whose time has
passed is labelled as already happened, since the row stays `scheduled` until
the T+24h feedback flow closes it. Brevity remains per bubble (§2.1); a third
bubble is explicitly allowed for a condition, cost, deadline or next step that
genuinely applies to this user, so an answer is not left half-given.

**What the agent may do, and what it may only offer (2026-07-29).** Every tool
carries a class, and the turn loop enforces it, so a tool's blast radius is a
property of the registry rather than of how carefully its description was
worded:

- **read** — `get_my_profile`, `get_my_standing`, `explain_my_match`. Touch
  nothing. The last two are what make "your personal AI matchmaker" more than a
  persona line: `get_my_standing` answers *"why am I not getting matched?"*
  from the fields that actually decide it (missed batches, a pending embedding
  rebuild that silently withholds the profile from the pool, photo count,
  verification, and a coarse bucket of the local candidate pool), and
  `explain_my_match` answers *"why this person?"* from the `match_score_logs`
  breakdown frozen at pairing time — data that existed since the engine shipped
  and was readable only from the admin dashboard. Both are rendered as
  qualitative bands, never raw multipliers: the numbers are internal mechanics
  (Elo distance, cosine similarity) that read as a rating OF THE PARTNER, and
  the blind-decision invariant still forbids revealing their choice.
- **write** — the profile edits, pause/resume, rejection feedback, plus
  `update_hobbies` (the Telegram side had no hobby tool while Aether did) and
  `set_language` / `set_theme` (the same DB write the Settings menu's pickers
  perform, factored into `services/user-preferences.ts` so both paths keep the
  invariant that a switch clears only this user's own cached scheduled-date PNG
  render — the card bakes language/theme into the image, so a stale cached
  `file_id` would keep re-sending the old one after a switch). At most **one
  write per turn**: one message is one intent, and a turn issuing several
  writes is the model improvising over a profile. A rejected edit does not
  spend the budget. Each landed write is followed by a **code-owned receipt**
  ("✓ About me updated") rather than trusting the model's own prose, so a
  change to matching-relevant state is a visible fact and an unintended one is
  noticed — for a language switch the receipt is read back from the database
  AFTER the write, so it renders in the new language rather than the one the
  request arrived in.
- **confirm** — `offer_cancel_premium`, `propose_cancel_date`,
  `propose_close_account`. These mutate **nothing**. They surface the button the
  menu would have shown, carrying the *existing* callback, and the user's tap
  enters the untouched handler with its own guards, nonces and confirmation
  copy. So "cancel my date" — by voice, or as a sentence, without hunting for a
  card that scrolled away — reaches exactly the two-step green/red confirmation
  the Cancel button has always produced, and account closure lands on the fork
  that offers freezing first. No second destructive code path exists.
- **open** — `open_screen` (profile, photos, edit_bio, settings, tickets,
  premium). Also mutates nothing; hands over a real menu callback the agent
  cannot invent, gated on the same feature flags as the menu row.

`update_bio` gained one rule of its own: `psychologicalSummary` is not a
caption but the profile's accumulated psychological signal and the dominant
embedding input (`V_explicit`, 0.65), so a rewrite that collapses a substantial
existing text is **refused** and the user is handed the editor, where they can
read what they would be replacing. "Add that I like coffee" used to be enough
for the model to send a one-line bio and wipe the AI-memory analysis, with
nothing to restore from.

**Voice comes free.** A voice note is transcribed by Whisper into the same
turn, so every tool above is reachable by speaking to the bot — no separate
voice surface exists or is needed.

**It answers in two messages, and it is a man (2026-07-29).** Two voice
corrections, both `VOICE.md`-owned (§1.1, §3.1):

- The reply arrives as **two Telegram bubbles by default** — a short reaction to
  what the user just said, then the substance; three only when there is a third
  thought, one when there is nothing to react to. Brevity is measured per
  message, so each bubble stays 1–2 short sentences and the reply overall may
  run slightly longer than the single line it used to be. The delivery already
  split on blank lines with a `typing` beat between bubbles
  (`splitReplyIntoBubbles`); the persona was the thing telling the model that
  *"most replies are ONE bubble"*, so it never happened. The sender now also
  cuts an over-long single block in two at an interior sentence boundary, as a
  floor under a non-compliant reply. Scoped to the concierge: onboarding is
  unchanged (a founder decision — and those questions are deterministic
  templates, not model output), and the pitch / no-match / ice-breaker streams
  keep their single final message, which `proposal-countdown` live-edits by
  `pitchMessageId`.
- The bot **refers to itself in the masculine** in every language that inflects
  it (ru «понял / нашёл», uk «зрозумів», pl «zrozumiałem»). `VOICE.md` had
  described the archetype as male since it was written, but only in English, so
  nothing reached the output and the model produced «поняла» about half the
  time. Encoded once as `VOICE_SELF_GENDER` and injected into every prose
  surface — the concierge, Aether, the onboarding agent, and the pitch /
  scheduling / venue / wingman prompts. The brand "we" in static copy is
  unaffected: that is the company speaking and is already gender-neutral.

**Access gate.** `services/agent-access.ts` decides who may run a turn at all,
and BOTH doors ask it. Previously each had its own partial idea: the Telegram
side enforced the verification gate but nothing else, so a `banned` /
`suspended` / `pending_investigation` account (whose `status` is not
`onboarding`, so the gate never saw it) walked into the agent and its
profile-writing tools; and the JWT side checked only that onboarding was
complete, so a user the entire Telegram surface holds behind the verification
card reached the same agent by switching transport. `paused` and `frozen` are
deliberately admitted — those are the user's own choices, not enforcement.

**The chat timeline is untrusted data, and is fenced as such.** It is rendered
into the system prompt inside an explicit data block whose standing rule is
that nothing inside it is ever an instruction — the model may not call a tool
because timeline text asked it to. The fence marker and markdown headings are
neutralised in the rendered rows so a row cannot close the block early and have
the rest read as prompt. Separately, the two flows that deliberately relay one
user's free text into another's chat — the verbatim emergency-cancellation
reason (§Phase 4) and every proxy-chat message (§Phase 4 Variant C) — record a
neutral marker instead of the body (`withRedactedSummary`). The timeline needs
to know *that* a relayed message arrived, never to quote it; sanitising was
rejected because the relay is verbatim by product rule and no filter is a trust
boundary. Without this, a partner's text sat inside this user's prompt next to
tools that write to this user's profile.

**Account deletion → Freeze fork (Telegram-only).** Tapping **Delete Account**
no longer goes straight to a destructive confirm. The bot first plays a
per-language founder **video note** (кружок) explaining why freezing beats
deleting, then offers a two-button fork with native styles so the destructive
path is visually distinct: a blue (`primary`) **❄️ Freeze account** over a red
(`danger`) **Delete anyway**.
- **Freeze** sets `User.status = frozen` — a soft-delete that keeps the User,
  Profile, embedding, verification, photos, and coordinates intact, removes the
  user from the matching pool (the engine matches only `active`), cancels any
  in-flight matches (the partner gets a neutral notice + the small emergency-cancel
  priority/Elo comp, **and any Date Ticket they paid for back in their wallet** —
  §3.5b; the freezing user is refunded too, and keeps it for when they return),
  and unpins the status banner. On the user's next `/start`
  they are **silently reactivated** to `active` straight into their ready
  profile — no re-onboarding, no re-verification, no re-embedding.
  Freeze is offered only from `active` or `paused`; the status transition and
  all in-flight match cancellations commit in one transaction, and partner
  effects run only after commit. Return uses the sole `frozen → active`
  transition. Concurrent moderation always wins.
- **Delete anyway** leads to a final confirmation that isolates the destructive
  option: one red **Yes, I'm 100% sure** against two green back-out buttons. Only
  the red path runs the GDPR hard delete. Telegram and mobile share one deletion
  service: it strictly erases known user-owned Supabase selfies/profile
  media/chat attachments first, then atomically compare-and-set cancels every
  in-flight match, removes any founder-report snapshot containing that user,
  and deletes the User and all relational data by Prisma cascade. Only after
  that commit does it notify/compensate the partner on their actual channel
  (Telegram and/or APNs push). A storage failure therefore leaves both the
  account and live matches intact for a safe retry instead of creating a
  half-deleted account with real partner effects.
  The founder receives the departing user's full profile, phone number, and
  photos in the private founder-ops DM (`services/founder-notify.ts`
  `notifyFounderAccountClosed`, gated by `FOUNDER_NOTIFY_ENABLED`) — mirroring
  the new-registration notification. Because a hard delete cascades the row
  and its Supabase-hosted photos away, the profile snapshot and any photo
  bytes are captured immediately before deletion/storage cleanup runs, and
  the founder DM itself is sent only after the deletion commits. Freeze uses
  the same notifier with a plain post-commit read, since the row survives a
  freeze. (2026-07-16 → 2026-07-28: this briefly sent an anonymous
  lifecycle-only event instead, over a GDPR "right to be forgotten" concern —
  reverted as a deliberate founder decision: this is a private, single-operator
  ops channel, not a second public copy of the erased data, and it mirrors the
  same profile+photos disclosure the founder already gets on every new
  registration.)
- Freeze/Delete confirmation keyboards are bound to a cryptographically random
  nonce, the exact Telegram message, a single stage, and a 10-minute expiry.
  They are one-use: Back, another menu action, free text, a wrong/replayed tap,
  or expiry burns the token and strips the old keyboard. GDPR delete itself
  remains available regardless of the current account status.
- The кружок assets live at `apps/bot/src/assets/delete-freeze/<lang>.mp4`
  (square, ≤60 s, same mechanics as the welcome-gift video note); a missing
  language degrades gracefully to the text + buttons. Mobile keeps the plain
  `DELETE /v1/me` entry point (no freeze) but uses the same deletion service.

A pinned **status banner** is created on activation
(`services/status-banner.ts`) and reconciled every minute by the
`status-timer` worker. Its single blue (`primary`) inline button carries a live
discrete countdown ("Xd Yh", "Xh Ym", "Xm"); the message body is a short
heading naming **what that countdown is for**. The countdown deliberately lives
on the button and is never repeated in the body: Telegram renders the button as
its own block in the pinned message, so it is the timer the user actually reads.

**The split between the two halves is load-bearing, not cosmetic (2026-07-30).**
Telegram's collapsed pinned bar shows the body's first line on the left and the
button as a badge on the right, and **the badge truncates**. So on the stage
banners the button holds the bare time and nothing else — no label, no emoji —
while the body's FIRST LINE names what is being counted and ends with a colon.
The bar then reads as one sentence: "Time left to reply:" ▸ "23h 39m". Putting
the label inside the badge is what this rule exists to prevent: it consumed the
badge's whole width and the number never rendered at all, leaving two truncated
halves of the same phrase ("Your match is wai…" ▸ "⌛ Time left to r…") and no
visible timer anywhere. The drop mode (5) is the one exception and is
deliberately left as it was — its label is short enough to survive the badge.

**The banner is stage-aware (2026-07-29): it counts down whatever is actually
next for this user, not always the weekly drop.** A user occupying a live-match
slot is *excluded from the Thursday batch* (§3.2 filter 8), so a pinned
"your next drop in Xd Yh" above every conversation was the same kind of promise
the product cannot keep as the unlaunched-city case below — and it pointed at
the wrong thing anyway, since on a `proposed` match the user's whole attention is
on a 24-hour accept/decline decision. `resolveBannerStage`
(`workers/status-timer.ts`) resolves one mode per user per tick, first match
winning:

1. **Unlaunched city** (below) — outranks every stage; unchanged.
2. **Date** — `scheduled` with `agreedTime` in the future. Body: "Time until
   your date:" + the venue name. Button: the bare time ("2d 7h"), ceiled exactly
   like `computeStatusSnapshot` so it can never disagree with the My Date menu
   row about the same date → the My Date hub.
3. **Decision** — `proposed`, *this* side hasn't answered, TTL not yet elapsed.
   Body: "Time left to reply:" + answer yes or no in the chat. Button: the bare
   remaining time, fed from the same `minutesLeftFromDispatch` the pitch
   keyboard's own deadline button uses, so both timers on screen show the same
   number even though only the pitch one carries a label → My Date hub.
4. **Planning** — `negotiating`, `negotiating_venue`, or `proposed` where this
   side **accepted** and the peer is still silent. There is no countdown here at
   all, so the badge is an action ("Details") rather than a status: repeating the
   body's own first line in it would just print the same phrase twice in the
   pinned bar → My Date hub.
5. **Drop** — no live match: the original next-batch countdown. It buckets
   `nextDropAt − now` into days/hours/minutes (`computeStatusSnapshot`), so a
   same-day next drop renders correctly with no banner-specific change.
   **But the countdown itself is withheld when drops outpace the notices that
   explain them** (`dropOutpacesNotices`, §3.1): the banner then states a steady
   search ("I'm looking — I check every evening") with a plain "open menu"
   button and no timer anywhere. A countdown is only honest if reaching zero
   resolves into something — under `weekly` it always does (a match, or the
   famine DM fifteen minutes later), but under `daily` the famine notice stays
   throttled to one a week, so six evenings out of seven the timer would hit
   zero and nothing would arrive. That silence is deliberate; a timer counting
   down to it is what would turn it into a broken promise. The condition is
   *derived* from the two intervals rather than hardcoded per profile, so a
   future cadence cannot acquire a silent-drop regime without the banner
   noticing. Live-match modes 2–4 are untouched — their countdowns run to real,
   known events and stay honest at any cadence.

Three states fall back to mode 5 on purpose. Two because the next drop is
genuinely the relevant thing again: a `scheduled` date that has already happened
(the row lingers until the T+24h feedback flow closes it) and a `proposed` match
past its TTL (the expiry cron is at most 15 minutes behind). The third is the
side that **declined**: a first decider leaves the row `proposed` whichever way
they went (§3.4), so a pass arrives here looking exactly like an accept, and
anything other than the ordinary drop countdown would be a pinned banner about a
date they just turned down.

**Blind-decision safe, and the planning copy is where that is actually load-
bearing.** Mode 3 reads only *this* side's `acceptedBy` column — to know whether
an answer is still owed, never what the other side picked. Mode 4 covers an
accepted-but-unanswered proposal, where the partner may yet decline, so its body
states only that details are still coming together: it must never say the two
sides agreed, because at that moment the product does not know it and the user is
not entitled to it. A `proposed` match is also invisible to a side until that
side's own `pitchMessageIdA/B` exists, the same visibility rule the My Date row
uses, so the banner cannot announce a match mid-dispatch.

The pitch message itself is deliberately **not** pinned. It already carries a
live deadline button (the `proposal-countdown` worker re-renders it every
minute), but pinning it would mean unpinning and restoring the banner on every
stage transition while `unpinAllChatMessages` is already called from banner
creation, pause, and account deletion — a race with orphaned pins as its failure
mode. One dedicated self-healing message covers every stage with no new state.
It is also the only option for the `scheduled` stage: that countdown runs to
`agreedTime`, and the date card is an immutable `file_id`-cached PNG (§3.7a).

Telegram-only delivery follows the same `MATCH_CRON_SCHEDULE` + `CRON_TIMEZONE`
source as `/v1/countdown`; the native iOS surface keeps rendering its own
countdown from that API and is unaffected.

**One account state gets no countdown at all**: a dating city that is not a
launched market (§1.3). That user is not in the pool, so a live "your next drop
in Xd Yh" pinned above every conversation is the product's most persistent
false promise. The banner instead names their city, says Gennety has not
launched there, and points at the menu's switch row; the button drops the timer
for a plain "open menu" (same `menu:open` target). It outranks every live-match
stage above — a live match is impossible without a same-city partner, so a stage
there would mean corrupt data. The `status-timer` worker resolves this per user
each tick, so a legacy banner self-heals within a minute without touching any
other call site.

**A settled venue change pushes the banner instead of waiting for the tick
(2026-08-09).** Mode 2 prints the venue, and until now the once-a-minute
`status-timer` was the banner's ONLY writer — so changing the venue left the pin
naming the old place for up to a minute while the updated venue cards and the My
Date hub were already correct. A minute is nothing in the abstract and very loud
here: it is the one moment the pair is looking straight at the pinned message,
and the lag reads as the banner simply not updating. (It also reads as *"it
updates when you tap it"* — tapping opens the hub, which is correct instantly,
and by the time you are back the tick has fired.) Both settle paths — the paid
one and the free Premium/demo one — now re-render the banner for both sides
immediately (`services/status-banner-refresh.ts`).

**Every other stage transition the tick used to be the sole writer for is
pushed the same way (2026-08-09).** Once the venue-change gap was fixed the
obvious question was where else the identical bug lived, and the answer was:
everywhere a handler writes the columns `resolveBannerStage` reads. Five more
call sites push now: a match's first venue assignment (`services/scheduled-
confirmation.ts` — the moment `status` becomes `scheduled` and mode 2's
countdown + venue name appear for the first time, flipping off the no-countdown
"planning" mode shown throughout negotiation); every successfully claimed
accept or decline (`handlers/matching/decision.ts` — mutual accept flips
"decision" → "planning"; a mixed verdict or a second decline flips either mode
back to the plain drop countdown); the 24h reply-deadline TTL
(`services/match-expiry.ts` — same drop-countdown fallback, for a match nobody
answered in time); and emergency cancellation of a scheduled date
(`services/emergency-cancel.ts`, shared by the Telegram flow and the native
`/v1/matches/{id}/cancel` rail — the countdown was counting toward a date that
no longer exists). One of the five is smaller than a status transition: the
FIRST decider's own accept or decline already flips **their own** banner mode
the instant `claimMatchDecision` writes `acceptedByA/B`, independent of whether
`status` ever moves off `proposed` — so that push fires for the actor alone,
before the row's status is touched at all.

The push is deliberately **narrow, and is not a second banner mechanism**: it
only ever EDITS a banner that already exists, it never records failures or
clears pointers (the missing message, the unreachable chat and the backoff
ladder stay the worker's, which reaches the same user within a minute anyway),
and it shares the worker's render cache, so a pushed render simply satisfies the
next tick rather than being re-sent. It cannot fail a settled change: the
irreversible step never depends on a cosmetic re-render. Two of the five new
call sites have no handler `ctx.api` to push through at all — `match-expiry.ts`
runs off a cron tick, and `emergency-cancel.ts` is shared by two transports — so
both read the process-wide bot handle via `getMainBotApi()`
(`services/main-bot-api.ts`), the same idiom `founder-notify.ts` and
`proxy-chat.ts` already use for this exact shape of problem, and both no-op
before the bot has finished booting.

The banner is otherwise self-healing: active Telegram users with a null/stale
message id
get a replacement, deleted messages are recreated in the same tick, and an
hourly physical-pin audit re-pins a tracked message that is no longer on top.
Full render state (text + button) is de-duplicated in memory. Leaving `active`
removes the pin; resume recreates it. Account deletion unpins the exact tracked
message before erasing the row, while first-touch re-registration clears any
physical orphan left by a Telegram outage during deletion.

### 2.2 Mobile API (native iOS client)

The public `/v1/*` API is the integration surface for the native SwiftUI
client (Bearer JWT, refresh-token rotation; separate `Gennety-iOS` repo,
machine contract in `openapi/gennety-v1.yaml`). The Expo era is over: push is
direct APNs, the general track verifies phones with a Twilio-first code, and
the hybrid-chat `ui_hint` field names the native control per interview step.
Supported first-class flows:

- Onboarding / consent / OTP / liveness via `/v1/onboarding/*`,
  `/v1/auth/*`, `/v1/me/verification/*`.
- **Aether Concierge** (`/v1/chat/*`) — multimodal AI chat that gathers
  profile facts in the background via `update_profile` / `attach_profile_photo`
  tools. Distinct from the legacy onboarding-agent: persists each turn as a
  `Message` row and supports image attachments. Post-onboarding fixed identity
  fields such as age cannot be changed through the tool. Attaching a chat image
  to the dating profile re-runs the same upload-time safety, face-presence,
  identity, duplicate-hash, profile-bucket copy, metadata, and
  verification-rerun path as a normal profile-photo upload.
- Match decision, vibe-location, safety-ack, report endpoints under
  `/v1/matches/:id/*`.
- `/v1/me/push-token` registers Expo/APNs/FCM tokens; the bot dispatches
  push via `services/push.ts` for the same events that DM Telegram users.
- `/v1/me/home-location` persists canonical dating city + coordinates for
  match eligibility; `/v1/me/location` remains raw coordinate storage for
  Meet-Halfway and does not by itself unlock matching. The city must be one of
  `AppConfig.supportedCities` (§1.3) — anything else is `city-not-supported`
  (400), and a launched one is canonicalized server-side. The client renders
  the constraint from `GET /v1/app/config` rather than discovering it as an
  error. The same endpoint is how an existing account moves to a launched city.
- `/v1/me/preferences` (`matchRadius` ∈ `campus_only` / `citywide`) stores
  the user's future radius preference.

## Phase 3 — Matching Engine & Progressive Scheduling

### 3.1 Cadence

**The cadence itself is a swappable profile (`packages/shared/src/cadence.ts`),
not a scattering of hardcoded constants (2026-08-01).** `DropCadence` bundles
every timing knob the matching engine and its surrounding workers read — the
batch cron, the proposal-decision deadline strategy, the match cooldown, the
starvation-bonus rate, nudge offsets, the famine-notice interval, the Profiler
rush window, and Rematch's blackout/limits — into one object, selected once at
boot by the `DROP_CADENCE` env var (`weekly` | `daily`, default `weekly`).
Everything below in this section describes the **`weekly` profile, which is
what production runs today** — `DROP_CADENCE` is not set in `/opt/gennety/.env`
and flipping it to `daily` is a separate, later decision gated on pool size,
not on anything documented here. The `daily` profile exists in code (nightly
cron `"0 18 * * *"`, a 30-minute-before-next-drop decision deadline instead of
a flat 24h, a 6h cooldown, and the §D10 pool-exhaustion pause below) but is
inert until that env var changes.

**Match daily, apologise weekly (founder decision 2026-08-02).** The notice
cadence is deliberately NOT tied to the drop cadence: `famineNoticeIntervalMs`
is **7 days in both profiles**, so switching to `daily` changes how often we
*look*, not how often we *write*. A drop that finds nobody sends **nothing at
all** — the user simply doesn't hear from us that evening — and the empathetic
check-in keeps the weekly rhythm and the same tier ladder it has today, with
the discount still landing on the second notice. At small pool sizes most
evenings genuinely have nothing to report, and a nightly "sorry, still no one"
would turn a background search into a daily reminder of failure. Two
consequences follow, and both are load-bearing:

- **Tiers count notices, not batches.** `computeTier` is denominated in
  `famineNoticeIntervalMs`, so a tier is "which message in this streak is
  this" — which is exactly what the tier-2 copy ("second time in a row")
  claims, and what makes `famineDiscountMinTier = 2` mean the same thing under
  any cadence. Denominating it in the batch interval instead (the original
  `daily` draft) would have made the second notice a user ever received arrive
  as tier 7 and select the most apologetic tier-3 copy, skipping tier 2
  entirely.
- **The pinned banner drops its countdown** whenever drops outpace the notices
  explaining them (`dropOutpacesNotices`) — see §2.1 mode 5. A timer is only
  honest if reaching zero resolves into something; under `daily` it would hit
  zero into deliberate silence six evenings out of seven.

See
`DAILY_MATCHING_MIGRATION_AUDIT.md` / `DAILY_MATCHING_IMPLEMENTATION_PLAN.md`
for the full migration design. Internal names were deliberately NOT renamed to
track this (`standbyCount`, `Profile.missedWeeks`, `Match.source = "weekly"`,
`runDropBatch`'s log prefix `[drop-batch]`) — the `/v1/*` API and Prisma schema
are cadence-agnostic by construction, so a future cadence flip is an env
change, not a migration.

- **No pre-drop teaser (removed 2026-07-27).** There is no Wednesday "your match
  is coming tomorrow" DM, and no pre-drop notification of any kind — the pitch
  itself is the first thing a user hears about a given cycle. The retired worker
  ran the FULL matching engine a day early (`previewWeeklyBatch`) and DM'd only
  the users that dry run happened to pair, which made the message a promise the
  Thursday batch could not keep: nothing reserved the previewed pair, so 24 h of
  new registrations, status changes, profile edits, or a paid Rematch could
  re-route either side. The gap was structural rather than a rare race —
  `runWeeklyBatch` refreshes dirty embeddings and auto-unsuspends *before*
  pairing while the teaser did neither, so Thursday's pool was systematically
  larger than Wednesday's preview. A user could therefore be promised a match
  and then receive the no-match notice. Framing the teaser as a neutral
  "drop is tomorrow" line was considered and rejected as well: the pinned status
  banner (§2.1) already carries a live countdown to the exact drop time, so a
  second reminder would restate it while adding a weekly full-pool matching run.
  The agent's product playbook must not describe a teaser
  (`services/product-playbook.ts`).
- **Weekly batch** — Thursday 18:00 Europe/Kyiv (`MATCH_CRON_SCHEDULE = "0 18 * * 4"`).
- **No-match notice** — Thursday 18:15 Kyiv (`NO_MATCH_NOTICE_CRON_SCHEDULE = "15 18 * * 4"`).
  An empathetic DM goes to every eligible-but-unpaired user. Tier escalates
  with consecutive famine count (1 / 2 / 3+); idempotent via
  `NoMatchNotice@@unique([userId, dropDate])`. **The cron is not the throttle**
  — `CADENCE.famineNoticeIntervalMs` (7 days, both profiles) is a query-level
  filter, so the real guarantee is at most one notice a week per user however
  often this schedule fires. Under `weekly` the two coincide and every drop
  that leaves someone unpaired sends exactly one notice; under `daily` the cron
  ticks nightly and most evenings send nothing (§3.1). The DM is delivered through the
  native rich AI-compose draft stream (`streamDraftsToChat(..., { rich: true })`,
  the same primitive as the match pitch), so it reads as personally composed
  rather than a mass-blast template. It is a deliberately **short** 2-chunk
  stream — one "thinking" lead beat (`noMatchStreamStart`, a `<tg-thinking>`
  shimmer) then the full message as the plain final `sendMessage` — so bad news
  is never spelled out slowly. Degrades to the classic edited stream when a
  client can't render rich drafts. Telegram-only (mobile/Expo accounts are skipped here).
  When `TICKET_FEATURE_ENABLED` and the famine streak reaches **tier ≥ 2**
  (2nd consecutive week+), the same DM also grants and announces a one-time
  **single-ticket discount** (see §3.5b — *Famine discount*).
  **One branch is not a famine message at all (2026-07-28):** an account whose
  city is not a launched market (§1.3) was never in the drop, so "no match this
  week" would misdescribe what happened and the escalating tiers would sell
  patience for a queue they are not in. Such a user gets
  `noMatchCityNotLaunched` — a plain `sendMessage` (not the "we really looked"
  rich stream, which would be a lie: nothing was searched) naming their city,
  saying we have not launched there, and carrying the one-tap switch to a
  launched market. The famine discount and the paid Rematch offer are both
  skipped — a paid re-run cannot find them anyone either. The `NoMatchNotice`
  row is still written, so the drop stays idempotent.

### 3.1b Pool exhaustion: honest pause + auto-resume (2026-08-01, code shipped, inert under `weekly`)

A famine-tier DM is honest about "no match yet" but says nothing once the
pool has genuinely run dry — under `weekly` cadence that's rare enough not to
matter, but a faster cadence makes "keep waiting" a promise the product
increasingly can't keep. Rather than escalate tiers forever, a user whose
`computeTier` day-count reaches `FAMINE_PAUSE_AFTER_DAYS` (28 —
`packages/shared/src/constants.ts`, a flat day-count deliberately independent
of `CADENCE`, chosen so it clears tier 3 under `weekly` before ever firing)
is transitioned `active → paused` by the SAME compare-and-set the menu's own
Pause button uses (`services/account-status-transitions.ts`), with
`Profile.starvationPausedAt` stamped to mark it as system-initiated (distinct
from an ordinary user-chosen pause, which never sets this column). The user
gets one honest DM (`poolExhaustedPauseNotice`, all 5 locales) instead of
another famine tier: the pool is empty right now, the account is paused (not
broken), and it resumes automatically or via the ordinary Resume button at
any time. A market-pending user (§1.3) is never a candidate for this — they
have their own city-switch messaging and were never really "in the pool".

Auto-resume (`services/pool-exhaustion.ts`, `autoResumeStarvedUsers`) runs in
the same cron tick as the famine-notice sweep: for every system-paused user it
probes `findCandidatesFor(userId, 1, { allowPausedSeeker: true })` — the exact
single-seeker check Rematch already uses, widened by one opt-in option so a
`paused` seeker can be probed without the ordinary `status === "active"` gate
rejecting it outright. A non-empty result CAS-resumes the account, clears
`starvationPausedAt`, and sends `poolExhaustedResumeNotice`. An ordinary
manual Resume (menu button, any reason) also clears the marker, so a user who
resumes themselves is never later swept up by the auto-resume probe as if
nothing had happened.

### 3.2 Scoring (`services/match-engine.ts`)

Hybrid SQL + Node.js re-rank.

```
MatchScore = ((w₁·V_explicit) + (w₂·V_research)) · V_league · V_agePref − (w₃·V_penalty)
                                                + starvationBonus
```

- `V_explicit` (cosine similarity of the 1536-dim profile embedding), weight
  0.65 (lowered from 0.80 on 2026-06-21). The embedding now carries only
  open-ended psychological prose: demographics (age/gender/height/city) that
  duplicate `V_research`/hard filters were stripped from the declined-profile
  fallback text, and the §1.3 vibe answers were folded in, so the embedding
  finally has real signal for users who skip the Magic Prompt.
- `V_research` (structured compatibility heuristics), weight 0.35 (raised from
  0.20). Sub-factors (weighted, renormalised over whichever are present):
  **vibe quadrant proximity** 0.40 (PRIMARY), age gradient 0.20, height norm
  0.20, educational homogamy 0.20. The quadrant factor scores *proximity*
  between the two users' `energyAxis`/`orientationAxis` (§1.3) — similar tempo
  lands in the same/adjacent quadrant, a big tempo gap is penalised harder than
  an orientation gap. This **replaces** the old keyword-scanned "social energy"
  factor (which was phantom — it scanned `psychologicalSummary` for the English
  words introvert/extrovert and almost never fired). `socialRole` complementarity
  is intentionally NOT scored yet (Phase 2 — needs accept/decline data).
- The explicit/research re-split is **inside** the positive bracket, so it does
  not change `V_league`'s role: beauty still multiplies the whole bracket
  identically. `V_league` is unchanged.
- `V_league` — universal Elo-distance multiplier and the **primary
  (assortative) match gate**. Elo is seeded from the AI vision attractiveness
  pass (0..100 → Elo 200..800, 6 Elo per attractiveness point), so this is in
  practice an *attractiveness-similarity* multiplier. Same league = 1.0,
  decays linearly past `LEAGUE_TOLERANCE = 60`, floors at `LEAGUE_FLOOR = 0.05`.
  Tightened 2026-06-06 so similar attractiveness decides *whether* a pair is
  viable, while psychology (embedding/research) ranks pairs *within* a tier:
  a ~10pt looks gap still gives 1.0, ~20pt → 0.70, ~30pt → 0.40, ~40pt → 0.10,
  and a "90 vs 30" pairing floors at 0.05 (effectively never matched unless the
  starvation bonus rescues a long-unpaired user). Example: an Elo gap of 180
  (≈ a 30-attractiveness-point difference) yields `V_league ≈ 0.40`, so a pair
  that is far apart on looks must have an exceptional psychological/embedding
  fit to outrank a same-tier pair.
  - **Male upward reach (hetero pairs only).** `V_league` is *asymmetric* for
    M/F pairs (`pairLeagueScore`): when the woman out-scores the man, the gap
    is discounted by `MALE_REACH_ELO` (env, default 36 Elo ≈ 6 attractiveness
    points) before the decay — so a less-attractive man is paired with a
    somewhat *more*-attractive woman without the league penalty crushing the
    match. With the default reach a man matches at full strength (1.0) with
    women from his level up to ~16 attractiveness points above him. Matching
    "down" (man already more attractive) is unchanged, and same-gender /
    unknown-gender pairs keep the symmetric `leagueScore(|Δ|)`. This stacks on
    top of the gender-calibrated vision scoring (§1.4), so the reach is kept
    deliberately small to avoid women systematically receiving visibly
    less-attractive partners.
- `V_agePref` — **stated preferred-partner age-band** multiplier
  (`ageRangePreferenceScore`, `Profile.ageRangeMin/Max`). Applied to the
  positive bracket alongside `V_league`. It is a **soft preference, not a hard
  filter**: a candidate whose *actual* age is inside the seeker's stated band
  scores `1.0` (neutral); outside, the bracket is damped by
  `1 − yearsOutside·AGE_RANGE_PREF_DECAY_PER_YEAR` (default 0.1/yr), floored at
  `AGE_RANGE_PREF_FLOOR` (default 0.6) so a far-out-of-band partner is dampened
  but never excluded — an exceptional embedding/league fit can still surface
  them, and a thin city pool is never starved. Symmetric: `scorePair` evaluates
  each side's band against the other's age and averages. **Neutral (1.0) when
  the user never set a band** — the band is not collected at onboarding, so the
  common path is unchanged; only users who explicitly edit the range opt into
  the dampening. Distinct from the `V_research` *age gradient* (which scores the
  closeness of the two real ages); both can apply at once. Tunable via env
  (`AGE_RANGE_PREF_FLOOR` / `AGE_RANGE_PREF_DECAY_PER_YEAR`); set the floor to
  `1.0` to disable.
- `V_penalty` — negative-constraint penalty (subtracted), weight 0.30.
- `starvationBonus` — α = `CADENCE.starvationAlpha` per missed batch (0.05 under
  `weekly`; `0.05/7` per missed day under `daily`, same ~35-day saturation
  point either way), capped at 0.25 (strictly below `V_penalty` so it never
  overrides a real negative-constraint hit).

Hard SQL filters (`buildCandidateSql`):
1. `status = 'active'` and `onboardingStep = 'completed'`.
2. Embedding present, `gender` and `preference` set.
3. Mutual gender compatibility (a's preference includes b's gender AND vice versa).
4. Track-valid contact rail present — `(registration_track = 'general' AND
   phone_verified_at IS NOT NULL) OR (registration_track IS DISTINCT FROM
   'general' AND is_email_verified AND email IS NOT NULL)`. The union is over
   valid student/legacy and general cohorts; one track cannot borrow the
   other's credential.
5. Same canonical dating city (`Profile.homeCityKey`) and saved city
   coordinates. Different university domains can match inside the same city.
   This exact-equality join is *why* registration is restricted to launched
   markets (§1.3): an unlaunched city can only ever be a pool of one. The
   engine itself is unchanged and deliberately carries no market list — an
   account left over from before that gate simply finds no candidate, exactly
   as it always did.
6. **Lifetime ban** — exclude any pair that EVER appeared in a `matches` row,
   regardless of terminal status. Backed by the canonical-pair functional
   index. A user never sees the same partner twice.
7. Cooldown — `Profile.lastMatchedAt < now − CADENCE.cooldownMs` (24h under
   `weekly`; 6h under `daily` — see §3.1). Strict `<`, so a candidate matched
   exactly at the cutoff is still excluded.
8. **Single-live-match invariant** — exclude anyone participating in
   `proposed`, `negotiating`, `negotiating_venue`, or `scheduled`. Match creation
   locks both user rows in canonical order and re-checks this invariant inside
   the transaction, so overlapping batch runs cannot allocate either user twice.

Score breakdown for every created pair is frozen into `match_score_logs`
for the dashboard's algorithm-quality view.

### 3.3 The Pitch & Synergy

- The orchestrator generates a personalised pitch + **Synergy Score**
  (clamped to a motivating 70..99 range) + a 1–2 sentence positive
  rationale. The score is pair-level (one number, taken from side A's
  generation); the **rationale is per side, each in that side's own
  language** (`synergyReason` = A's, `synergyReasonB` = B's — mirroring
  `pitchForA`/`pitchForB`), so the synergy header never renders a foreign
  sentence inside the localized message it heads. Corrected 2026-07-25:
  the reason used to be pair-level too, so a mixed-language pair saw side
  A's sentence spliced into side B's otherwise-localized pitch (Telegram
  header and the mobile `synergyReason` alike). Legacy rows with no side-B
  reason fall back to side A's text rather than dropping the header.
- **Match card set (feature-flagged, `MATCH_CARD_FEATURE_ENABLED`, default
  off).** When on, the partner photo media-group that leads the pitch is
  replaced by a rendered collage **card set** (`services/match-card`,
  satori/resvg/canvas — same stack as §3.7a): card 1 is the partner photo with
  an opaque rounded panel (name/age, one vibe line + one short paragraph from a
  dedicated compact copy pass — NOT the streamed pitch), each following card is
  one nearly full-bleed torn-collage photo; branding beyond the first card is
  limited to butterfly accents. The "paper" set renders in the **recipient's
  `User.theme`** (light cream / dark near-black card + panel; the burgundy
  accent, white photo frames and wine halftone dots are theme-agnostic). Sent
  as one protected album with the same
  name/age/✓ caption; collage jitter is seeded by match id + side. Any copy /
  render / send failure falls back to the plain protected media group, so
  pitch dispatch never wedges. Telegram-only.
- A successful PNG Match Card album is followed by the profile's motion-only
  assets: the standalone profile video and the video part of each Live Photo,
  protected with `protect_content`. Static photos/poster frames are not sent a
  second time. A rejected motion group falls back to individual videos, and a
  motion-delivery failure never blocks the pitch stream.
- Pitches are queued through `services/dispatch-queue.ts` (rate-limited,
  default 2 s between sends ≈ 30/min). When a first-match welcome gift is
  actually delivered, the queue sends those gift pre-rolls first, waits
  `MATCH_PREROLL_DELAY_MS` (default 2 min), then reveals the match cards so the
  gift effect and pitch stream do not visually stack.
- For Telegram users the pitch streams through the native rich AI-compose draft
  path (`streamDraftsToChat(..., { rich: true })` → `streamRichDraftsToChat`):
  the headline/deadline/pitch chunks render as growing rich-message drafts with a
  `<tg-thinking>` shimmer beat (`matchStreamStart`), then the FINAL chunk is
  persisted as a **plain `sendMessage`** carrying the pitch keyboard — it stays
  a normal text message so the countdown worker's `editMessageReplyMarkup` keeps
  re-rendering the live countdown button against the same `pitchMessageId{A,B}`.
  Degrades to the classic edited-message stream when a client can't render rich
  drafts.
- An explicit `matchDeadlineNotice` follows the headline: **24 h** to reply,
  decision is final once committed.
- **Conversational decision (no Accept button, 2026-07-05).** The pitch
  message itself carries only the `[Report]` affordance — there is NO permanent
  Accept/Decline keyboard. After the pitch (and trust card) the bot asks a
  natural question in the recipient's locale — "Want to go on a date with
  him/her? Just answer yes or no." (`matchDecisionQuestionM/F`, gendered by the
  partner) — and the
  user answers in their own words. `handlers/matching/decision-text.ts`
  classifies the reply (keyword fast-path across all five locales, small LLM
  fallback; unrelated messages fall through to the menu agent; active
  matchFlow/menuState sub-flows are never hijacked) and the styled
  confirmation button "flows out" of the answer as a reply to the user's own
  message:
  - yes-intent → confirm card with the native-`success` `[💫 Yes, I'm going]`
    button (`match:accept:` — the commit) over `[← Go back]`;
  - no-intent → the guarded decline confirmation card
    (`matchDeclineConfirmPrompt`, `[❌ Yes, pass]` `match:do:decline:` native
    `danger` over `[← Go back]` `match:keep:`) — a pass stays irreversible
    (lifetime-ban invariant §3.2), so it always needs the explicit red tap;
  - unsure → a no-rush nudge, no state change.
  Text alone NEVER commits a decision — the commit is always a button tap on
  the surfaced card. Replies are static copy revealing nothing about the
  partner's choice, so the §3.4 blind-decision invariant is untouched. The
  `match:accept:` / `match:decline:` callback handlers stay live for legacy
  in-flight pitches dispatched before this change. Telegram-only; the mobile
  `POST /v1/matches/:id/decision` path is unchanged (client-side confirmation
  is the app's concern).
- The `proposal-countdown` worker re-renders a live **reply-deadline button**
  on the pitch keyboard **every minute** via `editMessageReplyMarkup` (styled
  `primary`, and on the same cadence as the pinned status-banner countdown).
  The label shows hours+minutes ("⏳ Time left to reply: Xh Ym"), so it moves on every pass
  across the whole 24 h window rather than freezing between ticks — a markup
  edit sends no notification, so the cost is API calls, not user noise;
  tapping it (`match:countdown:`) answers an
  informational toast (the decision stays conversational). Because only the
  keyboard is edited, the pitch body (synergy header + streamed text) is never
  rewritten. Mobile users render their own countdown from the public API.

### 3.4 Blind Decision Invariant + Peer Nudge

A user MUST NOT learn what their partner picked until they themselves have
committed.

- **First commit** — row stays `proposed` (even on a single decline). The
  peer's keyboard is still live until both have decided or 24 h elapses.
  Peer receives a neutral nudge `matchPeerDecided` ("your match has answered,
  your turn") that is **identical** for accept and decline. A first decider who
  **accepted** keeps that card and gets the §3.6b waiting shimmer under it, held
  for the whole window — the countdown worker goes silent for a side that has
  already accepted, so this was the longest wait in the product with no live
  affordance at all.
- **Mutual accept** — atomic `proposed → negotiating`; both sides get
  `matchBothAccepted` with symmetric reveal. On Telegram, the **Date Ticket
  card** — the message that carries the "It's mutual 🤍" copy when the §3.5b
  gate is on — plays a **falling-hearts message effect**
  (`MESSAGE_EFFECT_MUTUAL_ID`, Bot API 7.6+, default ❤️
  `5159385139981059251`, empty disables). It rides that card and nothing else.
  Two deliberate exclusions: the individual "you accepted, waiting on them"
  receipt (separate `MESSAGE_EFFECT_MATCH_ID`) must stay quiet, since hearts
  there would hint at an outcome the user has not earned yet (blind-decision
  invariant); and the **celebratory Calendar card** on the ticket-off path
  carries no effect either (founder decision 2026-07-28) — that card's job is
  to get a time picked, and it is also the one card that gets *edited* in place
  from the waiting receipt, which Telegram cannot attach an effect to, so the
  animation would land for one side and not the other.
- **Mixed / both declined** — second decider gets their own
  `matchAccepted`/`matchDeclined` ack PLUS a follow-up
  `matchPeerWasAccepted`/`matchPeerWasDeclined` reveal; the first decider
  (who only saw their ack earlier) is also DM'd the outcome at this moment.
  Status flips to `cancelled`. In the mixed case, the user who accepted but
  whose peer declined receives a softer, accepted-side-specific reveal and
  gets a compensating priority boost for the next batch. The terminal
  `proposed → cancelled` compare-and-set is the ownership boundary: only its
  winner applies Elo, priority, and final reveal side effects, while each
  successfully claimed decision still records its own event/acknowledgement.
- **TTL expiry asymmetry** — if the silent side ghosted a partner who had
  *accepted*, the expiry message includes `matchExpiredYouMissedDate` ("you
  missed a real date") on top of the standard rating warning. If the
  partner declined or also ghosted, the message stays neutral — preserving
  the blind rule even at expiry. Match flips to `expired`.
- **Forgive-once on silence** — first `silentIgnoreCount` increment is a
  warning only; from the second onwards Elo decrements as if the user had
  declined, and a `EXPIRED_SILENT` `MatchEvent` is logged.

**Expiry card (always-on, Telegram-only, added 2026-08-01).** The expiry notice
is one of the few genuinely emotional beats in the product — you ghosted
someone who said yes, or someone ghosted you — and it was the driest surface
shipped: a bare `sendMessage`. It is now a square PNG
(`services/expiry-card.ts`, satori + resvg, same design system as the date,
time and match cards: recipient's `User.theme`, Gennety wordmark, tilted
butterfly, burgundy accent, film grain on dark only) with one vector motif per
branch of the asymmetry above — an hourglass with the sand run out, falling
bars under a descending arrow, one closed circle beside one dashed and empty,
and a heart split in two.

- **The card says WHAT HAPPENED; the caption adds only the consequence**
  (founder decision). Nothing is stated twice: the card carries "TIME'S UP /
  24 hours passed with no answer", the caption carries "next time we'll lower
  your rating". Same rule the §3.6 locked-time card follows when it refuses to
  repeat the date phrase its own caption already holds.
- **Which card**: `expired` (silent, first offence) / `penalty` (silent,
  repeat, Elo actually deducted) / `peer_ignored` (this side answered, the
  partner never did) / `missed_date` (silent AND the partner had accepted).
  The last one is a visual override that replaces either silent card — it is
  the fact worth a picture — while the **caption still follows the underlying
  outcome**, so a repeat offender who ghosted an accepting partner is still
  told their rating moved. The `penalty` card is drawn only when the Elo write
  actually landed, mirroring the existing text rule: never draw "RATING
  LOWERED" over a deduction that failed.
- **Blind-decision safe.** `missed_date` is reachable only from
  `peerAccepted === true`, which the user has already earned by the window
  closing; a peer who declined or also went silent produces the neutral card,
  exactly as the text did.
- **It claims no priority boost.** Unlike the decline path (§3.4 mixed) and the
  §3.5c stall chain, the expiry sweep does **not** call
  `boostAcceptedSidePriority`, so no surface here may promise one.
- **Photo-free by rule.** Partner photos are `protect_content` wherever they
  appear with a clear face (§3.7a); a terminal match is the wrong place to
  re-surface them, and it would put a network dependency on a path that must
  not fail. The motifs carry the emotion instead.
- **Never wedges.** The render is pure layout + rasterize (no network, no
  photos) and returns null rather than throwing; a null render — or a caption
  over Telegram's 1024-character ceiling — falls back to the plain-text notice
  that shipped before, which remains self-sufficient. No sentence exists on
  only one branch.
- **Headline typography is the full Unbounded, not the subsets the other cards
  load.** Those are the Google Fonts `latin` + `cyrillic` subsets and Polish is
  in neither, so `CZAS MINĄŁ` silently renders ĄŁ in Roboto mid-word. Satori
  reports no error for a missing glyph, which is why this went unnoticed — it
  is still live in the §3.6 time card's Polish dates (`WRZEŚNIA`,
  `PAŹDZIERNIKA`, `ŚR`), the match card and the referral card.

After a decline (and once the user has seen the partner's verdict, if any),
the bot asks why. The card carries four one-tap reasons — appearance, vibe,
interests, lifestyle — plus **Something else**, which opens the free-text /
voice path: that text falls through to the menu agent, which distils it via
`record_rejection_feedback` and appends the result to the *decliner's*
`Profile.negativeConstraints`.

**Only the free-text path reaches matching, and the copy now says so
(2026-08-07).** A preset tap records the canonical reason on the match row and
the `MatchEvent` with `updateNegativeConstraints: false` — deliberately, not
as an oversight. `V_penalty` is a **literal word-match of each stored trait
against the candidate's `psychologicalSummary`**, so it needs a trait with
content; a preset is a *category*, and "не мой тип" does not say which type.
Feeding it in yields one of two failures: the whole line becomes a single
trait that can never match any summary (dead weight), or the LLM distiller
manufactures a specific trait out of a content-free label and that invention
then penalises real candidates. The buttons are therefore analytics — read in
the admin dashboard — and the message no longer promises them a place in the
next drop. **Do not "fix" this by routing presets into `negativeConstraints`.**
If preset reasons are ever to influence matching, each button names a
*different* axis that already has a structured representation (appearance →
`typePrefTags`/`appearanceTags`, vibe → the energy/orientation quadrant,
interests → `hobbies`/`anchorTags`), a single decline is far too weak a signal
to mutate any of them, and learning appearance preference from rejections is a
consent question the Type Radar's opt-in calibration does not cover.

**The first button names appearance explicitly.** The four presets are four
axes, so the one meaning "looks" has to say it: "Не мой тип" alone reads just
as easily as personality and competed with the three buttons beside it.

### 3.5 Match nudges

`workers/match-nudge.ts` sends two cadence pairs plus a deadline heads-up
(`MATCH_NUDGE_CRON_SCHEDULE = "0 * * * *"`), all honouring quiet hours. The
offsets below are the `weekly` `DropCadence` profile's values
(`CADENCE.proposalNudgeOffsetsMs` / `schedNudgeOffsetsMs` — §3.1); the `daily`
profile halves the proposal/venue offsets and is inert in production:

- **Proposal phase** (status `proposed`, awaiting decision) — ≥3 h after
  `dispatchedAt`, then ≥10 h.
- **Scheduling phase** (status `negotiating`, both accepted, no agreed slot)
  — ≥6 h after the Calendar opened, then ≥12 h. It goes to **whichever side
  still owes the move**, and there are two ways to owe it (`schedulingOwedKind`,
  the same predicate §3.5c's check-in and cancellation read, so all three agree
  on whose turn it is):
  - **never opened the calendar** → the ordinary generated "pick a time" line.
  - **both picked and nothing overlaps** (added 2026-08-05) → static copy
    (`matchScheduleNoOverlapYet`) **plus the Calendar button**. A generated
    "pick a time" would be flatly wrong — this person did pick; what they need
    is to widen the selection or take one of the partner's slots, and the
    Calendar card scrolled away hours ago. This state used to match neither
    branch of the old "has this side marked anything" rule, so it received no
    reminder, no check-in and no cancellation at all — see §3.5c.

  Sent only to a side that has actually marked no availability *for the first
  case* (corrected 2026-07-29: it keyed off `pickedTimeA/B`, the deprecated
  pre-2026-05 columns nothing writes any more, so it nagged BOTH sides). A pair
  still inside the §3.5b Date Ticket gate is excluded, because `negotiating`
  also covers the gate and the Calendar has not been sent yet — "pick a time"
  pointed at a screen the user did not have. The discriminator is an empty
  `proposedTimes` (written by `startScheduling` when and only when the Calendar
  opens), **not** `ticketStatus`, which keeps its `pending` default even with
  tickets switched off entirely and so needed a flag-conditional filter to avoid
  suppressing every scheduling nudge. Same rule the stall chain already ran on.
- **Deadline nudge** (status `proposed`) — one final "your window closes in
  about Xh, decide now" DM fired **~2 h before the decision deadline
  (`services/proposal-deadline.ts` `deadlineFor` — a flat 24h TTL from dispatch
  under `weekly`; see §3.1)** (`PROPOSAL_DEADLINE_NUDGE_LEAD_MS`), anchored to
  the *deadline* rather than dispatch. Sent only to sides still genuinely
  undecided (`acceptedBy* IS NULL`
  — a side that already declined committed irreversibly and is never nagged),
  Telegram-only, static i18n copy so the "Xh" stays accurate. Idempotent via
  `Match.proposalDeadlineNudgeSentAt`.

Each cadence has its own timestamp column(s)
(`proposalNudge1/2SentAt`, `schedNudge1/2SentAt`, `proposalDeadlineNudgeSentAt`)
so a row that already got a proposal nudge cannot dead-letter the
scheduling-phase or deadline cadence.

### 3.5b Date Ticket Gate (feature-flagged monetization)

An optional premium step sits between mutual accept and the Calendar. It is
gated by `TICKET_FEATURE_ENABLED` (default **off** → the bot hands off straight
to the Calendar exactly as documented in §3.6).

**Both surfaces, since 2026-08-06.** This section used to say the gate was
Telegram-only and that the mobile mutual-accept path scheduled directly. The
second half had not been true for some time — `matches-service.ts` calls
`sendTicketOffer` whenever the flag is on, whichever client committed the
decision — so an iOS-only pair *did* enter the gate and then found nothing on
`/v1/*` able to read or settle it: the Mini App routes below are `initData`-
authed, and an app user has no Telegram session to sign with. They sat in
`negotiating` with no Calendar until the partial window lapsed and the expiry
cron opened scheduling for free. The native surface is
`/v1/matches/{id}/ticket-gate[/use|/seen]` (JWT), and
`SerializedMatch.ticketGate` is what tells the client to route there.

**On iOS the wallet is the only rail.** StoreKit credits it
(`POST /v1/tickets/appstore/transaction`, three consumables) and the gate spends
from it; there is no per-scope charge. An App Store consumable is a fixed-price
SKU, so charging per scope would need a product per scope and another per
discount state, each created by hand in App Store Connect and impossible to
re-price server-side. With the wallet in between, every gate action is
expressible with the products that already exist, and a settle that loses its
race refunds a ticket rather than a dollar. The famine single-ticket discount is
USD-only and so does not apply on iOS at all — the same rule Stars already
follows. The welcome gift, the store bundles and the wallet bonuses below stay
Telegram-only in v1.

When enabled, mutual accept creates one live **post-accept status/CTA** per
Telegram side (tracked in `Match.calendarMessageIdA/B`): accepted/waiting →
premium **Date Ticket** card → Calendar. The ticket card carries a `web_app`
button opening the Ticket Mini App (`apps/webapp/ticket.html`, React +
pure-CSS 3D). Each ticket is **$6.99** (mock) or **350 ⭐** (Telegram Stars).
**Payment (production): Telegram Stars (XTR).** With `TICKET_STARS_ENABLED` the
date gate and the store both pay natively in Telegram Stars — the Mini App opens
a server-issued invoice link (`createInvoiceLink`, empty provider token,
`currency: "XTR"`; no merchant account needed) via `WebApp.openInvoice`, and the
bot's `successful_payment` handler (`handlers/payments.ts`) is the trust boundary
that settles: `store:<count>` credits the wallet (exactly-once via the unique
`TicketLedger.externalPaymentId` = `telegram_payment_charge_id`), and
`gate:<matchId>:<scope>` settles the ticket slot(s) via `applyStarsTicketPayment`
(the charge id is first recorded as a zero-delta `TicketLedger` audit row; its
settlement outcome commits atomically with the slot CAS. The unique charge id
makes redelivery exactly-once and retains the provider key needed for a later
refund; a partial pay-for-both overpayment remains a durable pending wallet
credit until granted exactly once).
`pre_checkout_query` re-validates payload + Star amount within Telegram's 10 s
window. The famine single-ticket discount is **USD-only** and never applies to a
Stars purchase. Star prices are env-tunable (`TICKET_BUNDLE_STARS`, default
`1:350,3:830,6:1350`; the gate derives its per-scope price from the 1-ticket
entry — self/partner 1×, both 2×).
**Payment (fallback): mock.** When `TICKET_STARS_ENABLED` is off, the legacy
mock (`TICKET_PAYMENT_MODE=mock`) fully simulates a Stripe-style flow that
updates the DB but moves no money; `mock`→`stripe` remains the alternate
production switch (`services/ticket-payment.ts`). Mock payment intents are
server-issued, expire after 15 minutes, are bound to the exact payer,
match/bundle, scope, and amount, and can be consumed only once. While Stars is
on, the mock `intent`/`confirm` routes 404 (PAY-1 guard) so Stars is the sole
purchase rail; the free wallet "Use a ticket" path is unaffected.

- **Pricing.** Male users get "Pay for us both — $13.98" (settles BOTH tickets,
  sets `paidForPartnerBy*`) plus "Pay only mine — $6.99". Female users get a
  single "Pay my ticket — $6.99". The server re-validates that pay-for-both is
  male-only.
  **The covering option is always the hero button** — the one burgundy rung of
  the Mini App's button ladder — at every wallet balance
  (corrected 2026-07-29; it also **shimmered** until 2026-08-08, when the
  travelling white bar was replaced by the house inner-edge sheen — see the
  ticket-card note below). It used to invert at exactly `balance === 1`, where
  "use my ticket for myself" became the hero and covering dropped to the quiet
  secondary. That is the single most common state a man reaches this screen in:
  the welcome gift (§3.5b) is exactly one ticket, so for most first-time payers
  the nudge pointed the wrong way. Covering is offered, never forced — see the
  decline path below.
- **After he settles only his own ticket: a result, then an offer** (reworked
  2026-07-29). A male who paid just his own slot lands on the "cover your date"
  screen, and that screen now **leads with his own outcome** ("Ticket secured 🎟️
  — waiting on {name}", plus her remaining window), with the cover proposal as a
  distinct card below it carrying her photo, and the hero button carrying her
  avatar. Declining is a **real bordered button** (`I'll let them grab it`) that
  moves him to the ordinary `waiting` screen — the same one a female sees — with
  a quiet text link back in case he changes his mind. Before this the screen was
  an upsell dead end: his payment was reframed as the headline of another request
  for money, the only alternative was a 14px ghost text link under a shimmering
  burgundy button, and tapping it just closed the Mini App. The `waiting` screen
  was literally unreachable for a male, so his own purchase never resolved into a
  state of its own. The decline is deliberately **not persisted** (session-only,
  no schema): being asked again on a later open is harmless now that the screen's
  first message is his status rather than the ask.
- **A self-only settle is announced in chat, on both sides** (added 2026-07-29).
  Paying just your own ticket used to leave **no chat trace at all** — the Mini
  App jumped straight to the cover offer, so closing it lost the fact that you
  had paid, and the peer learned nothing even though the settle silently resets
  *their* deadline to 24 h from that moment. The payer now gets
  `ticketGateWaiting`, and the peer gets `ticketPeerTookTheirs` ("{name} just
  grabbed their ticket — yours is the last one") with a button back to the ticket
  Mini App. Both ride the same CAS that claimed the slot, so each fires exactly
  once per real payment with no extra idempotency column. A **cover** payment is
  excluded: it completes the gate and would spoil the §3.5b surprise. The
  persistent chat card itself is still never edited.
- **Persistent ticket card + Calendar follows.** The ticket card is a
  **standalone, re-openable** message sent once per side and **never edited or
  deleted** — it is intentionally NOT tracked in `calendarMessageId*`. Tapping
  it always opens the Mini App, which re-derives the live state (offer →
  pay/use; or the "your match paid ❤️" surprise; or both-secured). Ticket
  progress (first paid, both paid) is reflected **inside the Mini App**, not by
  rewriting the chat card. Once both tickets settle, the Calendar arrives as a
  **separate** message that *follows* the ticket card (`startScheduling` sends a
  fresh `calendarMessageId*` card), and the scheduling/venue/time-lock flows
  only ever touch that Calendar card — so the ticket entry survives to the end
  of the flow and the covered woman can always reopen it for the surprise. This
  is a deliberate, scoped exception to the one-live-post-accept-card rule
  (§3.6): the ticket card and the Calendar card are two distinct, coexisting
  buttons. It also carries the **mutual-match reveal** ("It's mutual 🤍"), so
  it is the message that plays the falling-hearts `message_effect_id`
  (`MESSAGE_EFFECT_MUTUAL_ID`, default ❤️) — see §3.4.
- **Welcome gift.** Every new user is gifted **one free Date Ticket** as a
  personal "your first date is on me" gesture, delivered as a **pre-roll before
  their first-ever match pitch** (`handlers/matching/pitch.ts` →
  `services/welcome-gift.ts`): an optional gender-specific Telegram **video
  note** (кружок, founder message) followed by the gift DM (the
  `welcomeGiftTicket` copy, $6.99 value anchor + optional
  `MESSAGE_EFFECT_GIFT_ID` effect). The `sendVideoNote` API carries no caption,
  so the text is a separate message; a missing video asset degrades gracefully
  to the DM only. The weekly dispatch queue intentionally waits before sending
  the match card after a delivered gift so the confetti/effect moment stays
  visually separate from the pitch stream. The grant is one-time/idempotent — a
  `welcome_gift`
  `TicketLedger` row is the claim marker, so the FIRST qualifying pitch becomes
  the gift moment automatically (no separate "first match" detection) and
  retries/subsequent pitches never re-gift. Telegram-only in v1 — the gift is a
  video note plus a DM, neither of which has a mobile surface — and inert unless
  `TICKET_FEATURE_ENABLED`. (The gate itself is NOT Telegram-only; see the head
  of this section.)
- **Ticket wallet (pre-purchase + bonuses).** Users carry a `User.ticketBalance`
  topped up by onboarding bonuses (§1.3: 6+ photos, adding a video;
  Registration v2: the one-time
  **student bonus** — `STUDENT_BONUS_TICKETS` (2) tickets granted at
  university-email verification via the idempotent `student_bonus` ledger
  claim, announced with the `ticketRewardStudent` DM — the student track's
  welcome perk; the general/phone track gets none), the welcome gift above, and by bundle
  purchases in the store
  Mini App (`tickets.html`, opened from the
  **My Tickets** menu): **1 / $7.00**, **3 / $16.47** ($5.49 ea), **6 / $26.94**
  ($4.49 ea). Every balance change is written atomically with an append-only
  `TicketLedger` audit row (`services/ticket-wallet.ts`). At the gate, a user
  with tickets sees **"Use a ticket"** instead of paying:
  - female / single-self → "Use my ticket" when `balance ≥ 1`;
  - male with `balance ≥ 2` → "Use 2 tickets (you + your date)" or "Use 1 (self)";
  - male with `balance = 1` → "Pay for both 🎟️ + $6.99" (his ticket on his own
    slot + one ticket's price for hers — never the doubled `both` price) as the
    hero, "Use 1 (self)" as the alternative; either way he may still
    **additionally** pay or use a ticket for his date afterwards (the post-self
    "cover your date" screen, scope `partner`).
  Spends are atomic and guarded against going negative; a spend whose match-slot
  claim doesn't apply is refunded to the ledger. New TMA endpoints:
  `POST /v1/matches/:id/ticket/use` (gate spend) and `/v1/tickets/*`
  (wallet + store). Store purchases and the gate share the mock/stripe
  abstraction in `services/ticket-payment.ts`.
- **Famine discount (single ticket).** A one-time loyalty perk for a user the
  weekly batch left unpaired for a **2nd consecutive week or more** (no-match
  `tier ≥ FAMINE_DISCOUNT_MIN_TIER`). The §3.1 no-match DM grants and announces
  a **`FAMINE_DISCOUNT_PCT` (77%) discount on one ticket**, valid
  `FAMINE_DISCOUNT_TTL_DAYS` (30) days. It applies to a **single** ticket
  purchase only — the date gate's `self` scope and the store's "1 ticket"
  bundle — and is **consumed on the first such purchase** in either surface
  (`services/ticket-discount.ts`; persisted on `User.ticketDiscount*`). The
  Mini Apps render a "−77%" badge + the reduced price; `both`/`partner` scopes,
  the 3/6 store bundles, and the free wallet "Use my ticket" path are
  unaffected. The server always re-derives the charged price (the mock intent is
  amount-bound, so a stale discount auto-fails verify) and consumes via a CAS so
  a double-confirm redeems exactly once. Re-granted/refreshed each later famine
  week until used. Inert unless `TICKET_FEATURE_ENABLED`; Telegram-only in v1.
- **Hard gate.** The Calendar is not sent until *both* tickets are paid
  (`ticketStatus = completed`), at which point `startScheduling` runs and sends
  the Calendar as a **separate** message that follows each side's persistent
  ticket card (it does not replace it).
- **Partner-paid surprise screen.** When a male covers both, the gate completes
  for both. Because the ticket card is a standalone, never-edited message (see
  *Persistent ticket card* above), the covered partner's "buy ticket" entry
  simply stays in chat — no spoiler — so she opens the Mini App still braced to
  pay and instead lands on a dedicated, softly-animated **"{name} already paid
  your ticket ❤️"** reveal (`partner-paid` screen, `PartnerPaidCard`, Lavender
  Glass: glowing covered ticket with a ❤ "PAID" seal, drifting hearts, minimal
  copy), whose single CTA continues her to the Calendar. The ticket card stays
  re-openable (every open re-derives the right screen) for both sides until the
  date is fully scheduled; the Calendar simply follows it as its own button.
- **Goodwill cover read-receipt (his dopamine loop).** So the man's gesture is
  not a silent settle, covering the partner drives a three-beat loop
  (`ticket-gate.ts`): (1) the instant he covers her — via pay/use `both` or
  `partner` — he gets a confirmation DM (`ticketCoveredHerConfirm`, with the
  `MESSAGE_EFFECT_TICKET_ID` heart when set) and his own Mini App success screen
  celebrates it (`iCoveredPartner` → *"you covered {name}'s ticket 💛"*) instead
  of the neutral both-secured copy; (2) the read-receipt — the first time she
  actually sees the reveal (her `GET /ticket/state` returning `partnerPaidForMe`)
  stamps `Match.partnerPaidSeenAt` once (CAS) and DMs him
  `ticketPartnerSawItDm` (*"{name} saw that you covered her ticket ❤️"*), his
  "she was notified" proof; (3) the guaranteed fallback — because she may never
  reopen the ticket card before the Calendar arrives, gate completion sends her a
  warm `ticketPartnerPaidDm` nudge (with a button back to the ticket card) and
  stamps `Match.partnerPaidNudgedAt`, so the notification always lands. The nudge
  deliberately does NOT stamp `partnerPaidSeenAt`, keeping his read-receipt honest
  (it still waits for a genuine open — e.g. tapping the nudge button). All three
  are idempotent and best-effort (a DM failure never blocks settlement).
- **`ticketStatus` lifecycle.** `pending` → `partial` (one paid; `ticketExpiresAt`
  is the second side's deadline) → `completed`; or `refund_pending` → `refunded`
  / `expired` on timeout. `refund_pending` is an internal retry state and renders
  as closed in the Mini App. **Refund/expiry policy:** the hourly `ticket-expiry`
  cron returns the original Telegram Stars charge (or restores the wallet
  ticket), durably retries provider failures, and only after a successful refund
  **opens the Calendar for free**. An already-accepted match is never killed by
  a payment stall, and a failed refund is never announced as successful.
- **The date didn't happen → the ticket comes back (2026-07-29).** One rule, no
  fault-finding: whenever a live match dies before the date, every ticket that
  was actually paid for returns to whoever paid for it. **The person who
  cancelled is refunded exactly like the person who was cancelled on.** The
  penalty for flaking already exists in Elo / `silentIgnoreCount`; taking the
  money on top would make an honest cancellation more expensive than a silent
  no-show, which is precisely backwards. Before this, a paid ticket burned in
  every one of these paths — a partner cancelling an hour before the meeting
  simply destroyed both tickets — and the ONLY refund in the product was the
  §3.5b expiry rail, which covers just the gate failing to close on time.
  - **The refund lands in the ticket WALLET** (`grantTickets`, reason `refund`),
    not as a reverse Telegram Stars transaction. A Stars reversal is a provider
    call that fails, and making it durable needs its own purchase table plus an
    hourly sweep (the `venue_change_purchases` / `rematch_purchases` pattern).
    A wallet credit is immediate, local, and exactly-once — the user keeps the
    value they paid for and spends it on the next date. Deliberately NOT a
    money-back path: this is scoped as "you don't lose what you paid for", not
    as a cash refund rail.
  - **Who gets what.** Slot A refunds to user A and slot B to user B, EXCEPT
    when `paidForPartnerBy*` records that one side covered the other — then the
    covered slot refunds to the coverer, who gets **two** tickets back. Without
    that exception the "I'm paying for us both" gesture (§3.5b) would quietly
    turn into gifting the partner a ticket she never bought.
  - **Every path that kills a live match** refunds: freeze, GDPR hard delete,
    and moderation suspend/ban/investigation (all four share
    `services/cancel-in-flight-matches.ts`), plus emergency cancellation of a
    `scheduled` date (§Phase 4) and the §3.5c 48-hour planning-stall end. The
    24 h proposal TTL needs no hook — every slot claim is guarded on
    `status = 'negotiating'` and the gate only opens after mutual accept, so a
    `proposed` row can never hold a paid slot.
  - **Exactly once, and never negative.** Idempotency is a synthetic unique
    `TicketLedger.externalPaymentId` (`refund:match:<matchId>:<userId>:<slot>`),
    so a re-run, a retry, or two paths firing on the same match credit nothing
    twice; each slot is its own transaction, so a partial failure is resumable
    rather than lost. A payer whose account no longer exists (hard delete) is
    skipped, and their partner is still refunded — which is why the plan is read
    inside the cancelling transaction, while the match row still exists, and
    applied after it commits.
  - **Not silent.** A refund nobody notices isn't a refund: the partner's
    cancellation notice carries the localized "your ticket is back in your
    wallet" line (all five languages), and a refunded user this rail sends
    nothing else to gets that line as its own short DM.
  - **The expiry rail keeps ownership of its own cases.** A `ticketStatus` of
    `refunded`, `refund_pending`, or `expired` means `ticket-expiry` has already
    returned the money, is mid-retry, or found nothing paid — this rail stands
    down on all three. `partial` (one side paid, the other never did) IS
    refunded here, since a cancelled match never reaches the expiry sweep's
    `negotiating` filter.
- **The ticket card, and what it may print (reworked 2026-08-08, Telegram-only).**
  One `Ticket3D` component renders the hero card on BOTH ticket screens — the
  gate and the store — so what follows is true of each. It carries the wordmark,
  the brand butterfly, and the wallet count under its own printed field name,
  and it deliberately carries nothing else.
  - **It is a portrait object, at a fixed proportion** (268 × 392, ~1:1.46 —
    revised the same day from 300 × content, which summed to roughly square).
    The height is a property of the CARD, not of its contents: `.ticket-main`
    flexes and the mark is centred in whatever is left. Before that, the gate's
    card (which prints a name row) and the store's (which does not) were
    literally different shapes, and any line added or removed silently changed
    the silhouette.
  - **"Admit two" / "На двоих" is gone from the header and the stub**, because
    it was false: one ticket admits ONE person, and a man paying $13.98 "for us
    both" is buying TWO. On the male's "pay only mine" path the card was telling
    him his partner was already covered.
  - **The names are the gate's alone.** The store used to print a fabricated
    pair ("Участник & Твоя пара") — the one place in the app where invented
    people were shown as issued. Its card now carries none; the gate keeps the
    real pair, small, under the mark (founder decision — the alternative was
    dropping them everywhere and making the ticket a pure object).
  - **The printed serial is gone** (removed the same day it was reseeded from
    the match id). It was the last small grey type on the card and it referred
    to nothing — no record carries it, so a user who reads it learns a hex
    string. Its space went to the mark, which is now **148px**: the card's one
    piece of art, stamped into the stock, rather than a logo sitting above a
    caption.
  - **The "curated date ticket" label and the marketing tagline are cut**
    (founder decision). The perforation, the real notch cutouts and the stub
    say what the object is; the screen's own headline says the rest.
  - **The barcode is gone, and the stub prints a field instead (2026-08-08).**
    It was the last purely decorative element on the card: seeded stripes that
    scan to no record, sitting opposite a number the card never explained. The
    stub now reads as a real ticket stub does — the field's name on the left
    (`balanceLabel`, one word, uppercased in CSS: БАЛАНС / BALANCE / GUTHABEN /
    SALDO), its value on the right — which is the same idiom doing an actual
    job: it says that the figure in the corner is how many Date Tickets the
    user holds. The number takes the weight the label gives up (17px near-white
    against a dim tracked 11px), because it is now a value in a field rather
    than a mark in a corner. Two consequences worth stating: the ticket's
    `seed` prop and its stripe generator are deleted with it, and the stub
    carries a **`min-height` floor** so a blank stub — the gate past the offer
    screen, where the balance is deliberately withheld — leaves the tear line
    exactly where a printed one does. Without that floor the perforation would
    sit at a different height per screen, which is the silhouette drift the
    fixed 268 × 392 card exists to end.
  - **The wallet count moved onto the stub**, replacing a glass pill under the
    card that on the light theme was grey-on-cream and barely legible — the
    always-dark stock gives it a ground to read against, so the theme problem
    disappears rather than being restyled. It stays hidden wherever it was
    hidden before (the gate shows it only on `offer` / `cover-partner`), and
    additionally at a **zero** balance: "× 0" printed on a ticket reads as a
    rendering fault, and in the store an empty wallet is what the bundles below
    are for.
  - **There is no specular highlight at all**, in either of the two forms it
    took — first a soft blob half the card wide, then a narrow raking band
    parked off-centre. The second was better and still wrong, and the reason is
    structural rather than a matter of tuning: a highlight is a reflection OF
    something, and this card sits on a flat page with no light source to
    reflect, so anything drawn is a guess the eye reads as paint on the surface.
    What survives is the **holographic film at 0.22** (down from 0.55), because
    foil is a genuine property of the stock and can shift with the angle
    honestly. The drag / gyro / inertia interaction is untouched — the card
    still turns, it just stops pretending to catch a lamp.
- **One light, everywhere (2026-08-08, Telegram-only).** The store's bundle rows
  and the gate's hero button carry the house **inner-edge sheen** — four inset
  shadows pulled back past the border by a negative spread, so the light reads
  as coming from the border inward (the same recipe as onboarding's action pill,
  referral's share button and the height drum's capsule). The one-time famine
  deal carries warm rose, so there the temperature IS the meaning. On the light
  theme the geometry
  survives but the polarity inverts (a white card cannot be lit whiter from its
  own edges, so the light becomes a shading inward) and a hairline is added, for
  the same reason `.ob-wheel-capsule` needed one. The hero button's travelling
  white bar is retired with it: a hard-edged rectangle sweeping a static button
  on a loop is the same "light doing what light does not" problem as the card's
  old glare. The saving badges are unchanged; the trailing `›` is dropped, since
  the whole row is the button and the chevron sat a few pixels from the badge.
  - **The recommended rung is a FILLED burgundy button carrying WHITE light**
    (founder decision, revised the same day). The first pass stripped its fill
    and gave it burgundy light on glass, arguing that a colour plus a
    temperature says "this one" twice. That held on the dark theme and failed on
    cream: burgundy light shading inward on a white card is a smudge, not an
    emphasis, so the strongest offer on the screen read as the weakest row. It
    is the same object as `.btn-hero` — the two-layer burgundy fill, white light
    held inside its own edges, white type (an outer burgundy glow was tried for
    separation and dropped: it haloed the row and re-created the washed
    look). This does not break "exactly one loud button per screen" — the store
    has no hero of its own, since its action bar appears only after a purchase.
    Applied in **both** themes deliberately: a rung that is a filled button on
    one and a glass row on the other is two components, and every later edit
    would have to be checked twice. Two consequences inside the row: the
    per-ticket line and the "best value" tag drop to translucent white rather
    than going grey (which turns muddy on this fill), and the saving pill
    inverts to near-white with burgundy type — it used to be a burgundy gradient
    on burgundy, i.e. the single best saving on the screen, invisible.
    **Its fill is one gradient, and its edge light differs by theme** (revised
    the same day). It shipped with a second layer on top — a 90° white wash
    bright at both ends — which was doing the job of edge light in the one place
    edge light must not land: the left end is where the count emblem sits (18px
    of padding plus a 52px tile falls inside the first ~19% of the row), so the
    layer washed out the very number the row is selling. That layer is gone, and
    the *horizontal* pair of the inset sheen is cut to a whisper for the same
    reason, while the vertical pair — which crosses only fill — is untouched.
    This is a real divergence from `.btn-hero` and it is structural rather than
    a matter of taste: the hero button is centred text on empty fill, so light
    hugging its sides lands on nothing, and it keeps the full recipe. On the
    **light** theme the row carries **no inner light at all**: on cream, a white
    rim held just inside a burgundy button does not read as light coming from
    the edge, it reads as a white FRAME drawn around the fill. What separates it
    from the page there is the page itself plus the shadow underneath.
  - **On the dark theme, light is a signal rather than a finish** (added the
    same day). The two ordinary rungs carry **no edge light**: they are lifted
    off the near-black page by being a step lighter than it (about `#1a1a1a` —
    black, but visibly grey) and by the shadow underneath, which is tint and
    elevation, exactly what the shared theme rules allow structure to use. The
    sheen then belongs only to the two rows that have something to say — the
    recommendation and the one-time deal — instead of being worn by every row,
    which is what made it read as a finish. On the cream page the sheen stays on
    all of them: there it is a shading inward, and without it a white row on a
    white page has no edge at all.
  - **The count emblem sets the number, not a formula.** It printed "×3" as one
    17px string, so the multiplication sign carried as much weight as the digit
    — and the digit is the only part anyone reads. The digit is now 26px with
    the "×" a small mark beside it, optically centred against the digit's
    x-height rather than sat on the baseline. On dark it is a properly saturated
    burgundy tile with no white halo inside its edges: `--accent-soft` is 0.18
    alpha, which over a near-black row resolves to roughly `#2b1017` — a tile
    that is technically burgundy and reads as dark grey — and once the row
    around it went flat, the tile was the only thing left carrying colour. A lit
    tile inside an unlit row is also one object saying two things about where
    the light comes from.
- **The action bar floats; it is an island, not a welded footer (2026-08-08,
  Telegram-only).** Both ticket screens pin their own buttons to the bottom —
  the store's **Готово** after a purchase, the gate's pay/use pair — and the bar
  used to sit in the page's flex flow. That made the scroll area end exactly at
  its top edge, so content was cut off against a hard horizontal line belonging
  to no object on screen: a panel edge the design system does not otherwise
  have (*depth from fills, inset light and shadow, never outlines*). The bar now
  paints **over** the scroll, and content dissolves under it through a scrim —
  opaque page colour beneath the buttons, fading to nothing above them. Same
  construction as the venue board's own CTA (`.vc-bar`, §3.7b), which is where
  the pattern already worked; that screen is untouched.
  Two details are load-bearing rather than styling. The fade is a fixed
  **72px length**, not the percentage `.vc-bar` uses, because this bar's height
  is not fixed — one button, two, three, more when a long RU/UK label wraps —
  and a percentage would make the softness a function of how many buttons
  happen to be on screen, giving the *shortest* bar the harshest edge. And the
  scroll reserves the bar's **measured** height at its end (`--bar-space`,
  `apps/webapp/src/ticket/action-bar.ts`) rather than a constant: too little
  hides the last row of content behind the buttons, too much leaves a dead
  strip at the end of a short list, and the right number is only knowable at
  runtime for the same wrapping reason. A screen with no bar (the store before
  a purchase) reserves nothing.
  **The ramp lives entirely ABOVE the buttons, outside the bar's own box
  (corrected 2026-08-08).** The first version ran one gradient across the whole
  bar — solid at the bottom, fading over the top 72px — but the buttons start
  only 16px below that top, so the first one sat almost wholly in the
  transparent end of the ramp. A glass secondary is `--fill`, **6% white**, so
  whatever the bar passed over was read straight *through* it: on the waiting
  screen the countdown line showed burgundy inside the grey Close button, which
  reads as two controls stacked on each other. The bar's own background is now
  plain `--bg` (invisible against the page, so still no panel — but genuinely
  opaque) and the 72px ramp is a `::before` sitting above it. Keeping the ramp
  out of the box is also what keeps `--bar-space` honest: it is `offsetHeight`,
  so folding the fade into padding would reserve 72px of dead strip at the end
  of every short list. Content is meant to dissolve under the ramp; it only has
  to clear the buttons.
- **The countdown moved into the header, and says whose it is (2026-08-08,
  Telegram-only).** The partner's remaining window used to be the LAST item in
  the gate's scroll, under a ticket that already fills the screen — i.e. inside
  the one band the floating bar passes over, which is how it ended up legible
  through the Close button. It now sits under `waitingSub`, the sentence that
  explains it, where it cannot be occluded and reads as one thought with the
  line above. Three things travel with the move. Its **subject is named**: the
  English line always said "They have {time} left", while the four translations
  had been cut to a bare «Осталось {time}» in the course of making them
  gender-neutral — a number on screen saying neither what was running out nor
  for whom. **The units are localized**: `formatCountdown` baked in `h`/`m`, so
  a Russian sentence carried English letters spliced into its middle
  («Осталось 23h 59m»); the units are now `{n}`-templates per locale. And it
  drops the burgundy for muted text at the sub's size — a countdown was the
  loudest thing on a screen whose whole message is "nothing to do, we'll tell
  you".
- **On the waiting screen the way back to the cover offer is the button, and
  Close is the text under it (2026-08-08, Telegram-only).** It shipped
  inverted: **Закрыть** held the full-width glass rung while "Всё-таки оплатить
  за пару" — the only thing on that screen that *does* anything — was a 14px
  grey link beneath it. That is the same inversion this section already
  corrected once on the cover screen itself, and Close is not an action in any
  case: Telegram renders its own ✕ in the chrome directly above. A user with
  nothing to reconsider (a woman, or a man whose partner already settled) sees
  Close alone and it keeps the rung, since the "exactly one loud button" rule is
  about which action is loudest, not about denying the only one a shape.
- **The store's heading carries no 🎟️, and gets its weight from size
  (2026-08-08, Telegram-only).** A rendered ticket is the largest thing on that
  screen, so an emoji of one above it restated the picture in a platform font we
  do not control — the same rule `marks.tsx` applies to the card itself — while
  competing with the heading at roughly equal optical weight. Both `title` and
  `successTitle` lose it in all five locales. "Heavier" then could not come from
  the weight axis: Space Grotesk's variable range stops at **700**, and asking
  for 800 gets a synthesised smear (the trap onboarding's headline already hit,
  §1.3). It comes from **31px and tighter tracking** instead, which thickens the
  strokes ~15% in absolute terms. The size is on the shared `.ticket-header h1`,
  so the gate's own heading grows with it — deliberate, since two header scales
  across one flow would be worse than one.
  **The gate's headings were cleared the same day, on the same reasoning**:
  `waitingTitle`, `successTitle` and the cover card's `coverPartnerTitle` all
  printed 🎟️ above the same rendered ticket. **Button** labels keep theirs —
  🎟️ there is what tells "use a wallet ticket" apart from "pay money", which is
  a job rather than decoration — and the two non-ticket glyphs stay (`heading`'s
  🤍 is the match, `closedTitle`'s 📅 the calendar). A test holds the four
  headings emoji-free in all five locales.
- **State machine.** The whole gate runs while `Match.status = negotiating`;
  `ticketStatus` is a sub-state so the scheduling/venue/lifecycle code is
  untouched. Blind-decision and all other invariants are unaffected.

### 3.5c Planning stall: the check-in and the 48h end (always-on, Telegram-only)

The decision deadline (§3.1/§3.5, a flat 24h TTL under `weekly`) covers only
the pitch decision. Once both sides accept, the scheduling (§3.6) and venue
(§3.7) steps had **no deadline of any kind** — a partner who went quiet left
the other person waiting indefinitely, with no chat to ask through and, before
this, no way to cancel either (the emergency button only exists once a date is
`scheduled` and within T-5 h).

**The cost was never the silence.** Both sides occupy a live match, and the
single-live-match invariant (§3.2 filter 8) excludes them from every drop
batch until it resolves. One ghost therefore cost the other person an entire
cycle — and nothing in the product could end it. Freeing both sides for the next
drop is what this section is actually for; the reminders are the polite part.

**The chain below is the `weekly` `DropCadence` profile's values
(`CADENCE.stallCheckInMs`/`stallTimeoutMs`/`venueNudgeOffsetsMs` — §3.1); the
`daily` profile halves the check-in to 12h and the end to 24h, and is inert in
production.** Per side, counted from when the phase opened:

| When | Who | What |
|---|---|---|
| 6 h / 12 h | the side that still owes an action | gentle nudge (the venue step's is new; scheduling already had this pair) |
| 24 h | same | **check-in: 🟢 "Still on" / "Plans changed"** — and the side that already did its part is told it happened |
| 48 h | — | the match is cancelled; both are freed |

- **The anchor is the phase, not the pitch.** Venue counts from
  `venuePromptAskedAt`; scheduling from the new `Match.schedulingOpenedAt`,
  written by `startScheduling`. The scheduling nudges used to count from
  `dispatchedAt`, which also covers the up-to-24 h decision window — a pair that
  accepted at hour 23 was already "6 h past dispatch", so the first "pick a time"
  nudge could land right behind the Calendar card. Rows predating the column keep
  the dispatch anchor.
- **`negotiating` with no `proposedTimes` is not a stall.** That state is the
  §3.5b Date Ticket gate, which has its own deadline, refund policy and expiry
  worker. `proposedTimes` is the honest discriminator because `startScheduling`
  writes it when (and only when) the Calendar opens; `ticketStatus` cannot be
  used — it defaults to `pending` even with tickets switched off entirely.
- **"Both picked, nothing overlaps" IS a stall, on both sides (2026-08-05).**
  `sideOwesAction` used to ask only whether a side had marked *anything*, so
  once both had, neither owed an action — and the whole chain keys off that
  predicate. The consequence was not a cosmetic gap: the pair got no 6 h/12 h
  reminder, were never asked "still on?", and **the 48 h cancellation never
  fired**, so two people whose calendars simply didn't line up sat in a live
  match indefinitely — held out of every drop by the single-live-match rule
  (§3.2 filter 8), which is the exact failure this whole section exists to
  prevent. The state was reachable in one ordinary move: pick a slot, have your
  partner counter with a different one. Both sides owe it now, because either
  of them can end it alone (widen, or take one of the other's slots — a shared
  slot auto-locks the date). It is also the reason §3.6b shows no status there.
- **🟢 commits instantly, 🔴 always confirms.** Green needs no confirmation:
  it changes nothing the user could regret, pushes that side's 48 h out from now,
  and re-arms the question **once** (gated on it being the first confirmation, so
  the chain is bounded at two questions and green cannot hold a match open
  forever). Each sent question can be confirmed exactly once — the write is a CAS
  on the confirmation timestamp and requires it to predate the question — so a
  tap on a stale button is a no-op rather than another 48 h. Red opens a
  confirmation card with a way back, like passing on a pitch: cancelling is
  irreversible under the lifetime pair ban (§3.2 filter 6).
- **Penalties are asymmetric on purpose.** An honest "plans changed" costs
  **nothing** — that is the behaviour the check-in exists to produce, and pricing
  it would make silence the cheaper move. Running the clock out is treated as a
  **silent ignore**: `silentIgnoreCount++` with the same forgive-once rule the
  pitch stage uses (§3.4), then the decline-grade Elo penalty. Either way the
  other side gets next-batch priority (`boostAcceptedSidePriority`), because
  their week is gone regardless.
- **A paid Date Ticket comes back on both endings** (§3.5b), and this is the
  stage where that matters most: the ticket gate sits inside `negotiating`, so a
  stall here is the likeliest way a paid ticket dies. The ghost is refunded too —
  their silence is already priced in Elo above, and charging a ticket on top
  would make going quiet cost money that the honest red button does not, which
  inverts the whole point of this chain. The line is appended to each side's
  existing notice / ack.
- **The notices say what actually happened**, and never guess. Someone who did
  their part hears that the partner never answered, framed as the save it is
  ("better now than on the day"). Someone whose partner cancelled hears that
  their plans changed, plus the existing "this isn't about you". The quiet side
  hears why it lapsed and — the part that matters next time — that telling us is
  a normal thing to do. The copy says **priority in the next drop**, never
  "rating": what moves is `standbyCount`, not attractiveness Elo.
- **Cancellation by text and voice, at every stage.** The agent's
  `propose_cancel_date` (§2.1, class **confirm**) used to filter on `scheduled`
  alone and told the model to "explain that instead", so a user who wrote *"I
  want to cancel"* mid-planning got a polite explanation and zero ways out. It
  now also resolves the two planning phases and hands over the same confirmation
  card. Text and voice still never commit anything — the irreversible step is
  always the user's own red tap on a real handler. When the message is ambiguous
  between *how does cancelling work* and *cancel it*, the agent asks one short
  clarifying question first. The agent also learns when a check-in is open, so
  someone who types "да, всё в силе" instead of tapping gets pointed at the green
  button rather than a blank stare.
- **Telegram-only, and fail-safe about it.** The check-in is an inline-keyboard
  question, so a mobile-only participant (synthetic negative `telegramId`) could
  never answer it. A stall whose owing side is unreachable is therefore left
  **completely alone** — never asked, never timed out. Cancelling on someone we
  never asked would be indefensible.
- Quiet hours (23:00–09:00 Kyiv) suppress the whole chain, cancellation
  included — that outcome is a real notification. A few hours of extra grace on a
  two-day deadline costs nothing. Runs on the existing hourly `match-nudge` cron;
  no new schedule.

### 3.6 Calendar Scheduling

After mutual accept (or, when the Date Ticket gate of §3.5b is enabled, after
both tickets are paid) the bot DMs both users a button that opens the
**Calendar Mini App** (`apps/webapp`, Vite + Telegram Web Apps SDK).

**The native client has the same grid on `/v1/matches/{id}/calendar` (JWT,
2026-08-06).** `startScheduling` has always written `proposedTimes` for every
`negotiating` match whichever client accepted, but the only way to read or
answer it was the `initData`-authed routes below — so an iOS-only pair reached
scheduling with no calendar at all. Everything in this section applies to both
surfaces unchanged: the mechanics are the same `processCalendarSlotsUpdate` /
`getCalendarState`, so the two clients cannot drift on when a date locks in.
The native response additionally carries the pair's city `timeZone`, because
the grid is a set of instants and a device drawing them on its own wall clock
would let a traveller agree to a time neither side meant — the same reasoning
behind the canonical-Kyiv locked-time card below. The
legacy three-iteration flow (two rounds of "pick one of three slots"
inline keyboards before falling back to the calendar) was removed
2026-05-07 — landing straight on a peer-aware calendar is strictly
better UX than three separate retries.

- **Server-side slot grid.** When the match enters `negotiating` the
  bot writes **6 consecutive dates** (next 6 days starting tomorrow)
  with **14 time slots per date** into `Match.proposedTimes`: every 30
  minutes from 13:00 through 19:30 local. Both users see the same exact
  DateTime allowlist; the public API rejects any submission whose ISO
  isn't on it. Pre-2026-05-10 the grid was 12 slots with Sun/Mon
  pre-skipped; pre-2026-05-11 it was 6 dates at only 18:00; the earliest
  slot was 17:30 until 2026-07-07, then a 6-slot 17:00–19:30 evening band
  until 2026-07-18, when the start was pulled forward to 13:00 (14 slots
  per date) so afternoon dates are offered, not just evening ones.
- **Multi-pick with live peer visibility.** Each user marks any subset
  of slots as "I'm free" — stored in `Match.availableTimesA` /
  `availableTimesB`. The Mini App polls `GET /v1/calendar/state` every
  ~4 s while open, so each side sees the partner's marks land in
  near-real-time.
- **Four visual states.** The grid renders each slot as **empty** /
  **mine** / **peer-only** / **overlap**. When the partner has marked
  slots and the current user hasn't, a banner reads *"Tap one to
  instantly agree, or pick your own — they'll see it live."* Tapping a
  peer-only slot and saving locks in the date in a single round-trip.
- **Initiator-offers / responder-decides.** The intersection of
  `availableTimesA` and `availableTimesB` after each update routes one
  of three ways:
  - **0 overlaps** — nothing locks. Bot DMs (see below).
  - **1 overlap** — auto-lock to that slot, write `Match.agreedTime`,
    and run `startVenueNegotiation` (the "instant agree" fast path).
  - **>1 overlaps** — do NOT auto-lock. Server returns
    `overlapCandidates: string[]` and the Mini App shows a confirm
    card to the actor; tapping a slot re-POSTs that single iso, which
    collapses the intersection to size 1 and hits the lock path. The
    asymmetry "initiator offers, responder decides" is deliberate UX —
    earliest-wins would silently steal user agency.
- **First-mover DMs.** When the actor's first non-empty submission
  finds zero overlap and the peer hasn't picked yet, the bot fires two
  DMs: peer gets `matchSchedulePeerProposed` with the calendar button;
  actor gets **no message at all** — the §3.6b waiting shimmer replaces the old
  `matchScheduleSavedConfirmation` receipt and is held until the peer picks.
  Started fire-and-forget: this call's return value IS the Mini App's save
  response, so it must not wait on a cosmetic draft.
- **One live post-accept card per side.** Telegram post-accept prompts are
  tracked in `Match.calendarMessageIdA/B`. The same message can move from
  accepted/waiting → Date Ticket → Calendar; new peer proposals and
  counter-proposals edit it in place, falling back to a replacement only if
  Telegram says the stored message is gone. Both cards are removed when a time
  is locked, so repeated scheduling updates do not accumulate identical "Open
  Calendar" messages in the chat.
- **No-overlap-yet ping.** When both sides have submitted but no slot
  is shared, the bot updates the peer's live calendar card with
  `matchSchedulePeerSuggestedAlternative`. This is gated on the actor's
  set actually changing — re-saving the same set is a no-op, so a
  redundant Save cannot ping the peer again. Subsequent reminders also
  rely on the existing scheduling-phase `match-nudge` cadence.
- **Mini App view states.** The default picker is a two-step flow:
  `dates` first, then `times` for the selected date. After Save, the
  Mini App shows one of:
  - `agreed` — locked-in success card (only state where the peer also
    sees the lock via polling).
  - `multi-overlap` — radio-list confirm card listing the candidates;
    Confirm uses the Telegram MainButton.
  - `waiting` — first-mover success card with peer-still-empty copy;
    `Close` and `Change my picks` buttons.
  - `grid` — default editing view with the 4-state slot rendering.
- **The time list opens at the LATEST slot, not the earliest (2026-08-08,
  Telegram-only).** Tapping a date slides up a sheet holding all 14 slots
  (13:00 → 19:30), which is taller than the sheet on every phone, and it used
  to open at 13:00 — the top of a scrollable list, where the first row sits
  flush against the top edge and reads as though the list simply *starts*
  there. Nothing else on that screen says it scrolls. It now opens scrolled to
  the bottom: the evening is where the answer usually is (a first date is
  planned for the evening far more often than for mid-afternoon), so the
  common case needs no scroll at all, and the row cut in half at the top edge
  is the affordance that says an earlier time is one swipe away. A
  poll-triggered rebuild — the peer marking a slot while the sheet is open —
  **preserves** the user's scroll position rather than re-anchoring, since the
  rule is about where a fresh open lands, not about overriding where the user
  scrolled to. The native iOS client draws its own grid and is unaffected.
- **Auth.** The Mini App is opened via `InlineKeyboardButton.web_app`
  in production, where `Telegram.WebApp.sendData` is silently a no-op.
  Both `GET /v1/calendar/state` and `POST /v1/calendar/pick` therefore
  authenticate via `Authorization: tma <initData>` (HMAC verified
  against `BOT_TOKEN`).
- **Locked-time card (always-on, Telegram-only).** The slot locks
  *automatically* on the first single overlap, so the side that didn't act
  last never explicitly learns **which** slot won — and the very next thing
  they receive is the §3.7 departure-point Mini App prompt, about something
  else entirely. Entering `negotiating_venue` therefore DMs each Telegram
  side a minimal PNG banner (`services/time-card.ts`, ~1000×420 so Telegram
  renders it as a compact strip) carrying only a small label, the localized
  date, and the time in the burgundy accent — rendered in the recipient's
  `User.theme` (light: cream + burgundy; dark: graphite + a lifted burgundy,
  since the date card's near-black would sink the accent at preview size)
  and in the canonical `Europe/Kyiv` both sides share. The caption is a single
  short line ("Время вашего свидания закреплено ✨") — **no repeated date
  phrase, no `date_time` entity, no "tap the date to add it to your calendar"
  explanation** (simplified 2026-07-25): the card already shows the time, and
  the §3.7 scheduled confirmation carries that exact add-to-calendar
  affordance, so repeating it here delivered the same tappable date twice with
  the same instruction. It is sent **before** the concierge prompt, per side,
  and is purely a framing/visual-break device — no state, no decision, no
  button. A render or send failure degrades to text, and that fallback DOES
  keep the localized date phrase + `date_time` entity (with no card there is
  nothing else stating when the date is); the departure-point prompt goes out
  either way. Mobile users are skipped (they render their own scheduling UI).
- **Backwards-compat.** `Match.schedulingIteration` and
  `pickedTimeA/B` are retained as deprecated columns until a follow-up
  cleanup migration drops them; mid-deploy taps on legacy
  `sched:pick:*` callbacks are caught by a graceful fallback that
  re-delivers the calendar button instead of failing silently.

### 3.6b Peer-wait shimmer (always-on, Telegram-only)

The two-sided negotiation steps share a shape: one participant commits their
side, and the flow then blocks on the other. Until 2026-07-28 those moments
answered with one flat line ("saved, we'll tell you when they reply") and then
nothing at all. Open the chat an hour later and there is no sign the process is
alive rather than stuck — and on the pitch decision it is worse than that: the
proposal-countdown worker deliberately stops re-rendering for a side that has
already accepted, so the single longest wait in the product (up to 24 h) was the
one with the least feedback.

**A `<tg-thinking>` shimmer now plays for the WHOLE wait**, its wording climbing a
time ladder, and it disappears when the partner answers and the flow moves on. On
the calendar and venue steps it *replaces* the waiting message entirely — nothing
is sent to the chat at all.

**A status is shown ONLY to someone with nothing left to do (founder decision
2026-08-05).** This is the invariant the whole feature lives under, and it is
what decides every predicate below. The shimmer exists so a *wait* doesn't read
as a dead product — "we haven't forgotten you, the work is happening". The
moment the next move is the user's own — pick a time, settle the ticket, mark
the departure point — a line saying work is under way is not reassurance, it is
misdirection: it tells them to sit still while the flow is blocked on them.
Those states get a **reminder** instead (§3.5, and the §3.5c check-in), which
says whose move it is and carries the way back into the screen. Nothing in
between: never a status on a step the user owes.

`services/peer-wait.ts` owns the two primitives: which line to show
(`peerWaitLabel`) and how to put it on screen once (`issuePeerWaitDraft`).
`workers/peer-wait-shimmer.ts` keeps it there.

**The wording is a function of how long THIS side has waited (2026-07-30), not of
a rotation counter.** The first revision rotated three phrasings on a global 60 s
clock, so minute two and hour twenty read identically — which made the shimmer
decorative, and made the copy wrap onto two lines in a block meant to hold one.
Five tiers replace it, one line each:

| Tier | Elapsed | Reads (RU) |
|---|---|---|
| 1 | < 5 min | `Передали {name}, ждём ответа` |
| 2 | 5 min – 1 h | `{name} ещё думает над ответом` |
| 3 | 1 – 6 h | `{name} пока молчит, ждём` |
| 4 | 6 – 24 h | `Напомнили {name} о вас, ждём ответа` |
| 5 | > 24 h | `{name} долго не отвечает` |

**Rewritten 2026-07-31 from a first pass that was too terse.** The first
five-tier ladder (`Ждём {name}` / `От {name} пока тихо` / …) was compact enough
to fit one line, but a user opening the chat several times in an hour couldn't
tell WHAT was being waited on or WHY from the noun phrase alone. Every line now
states the mechanic explicitly — "ждём ответа" / "ждём решения" — instead of
just naming the partner, chosen after a live founder review of three candidate
ladders sent to a dev chat and held on screen long enough to actually read.
Tier 5 also drops the "время поджимает" / "time's running short" tail that the
2026-07-30 pass added: a founder call that the bare fact ("{name} долго не
отвечает") carries the urgency on its own without an explicit pressure phrase.

**The separate "no-overlap" ladder is gone (2026-08-05) — that state was never a
wait.** Between 2026-07-30 and this change, a calendar where both sides had
picked and nothing intersected showed BOTH of them a second two-step ladder
(`Согласовываем время с {name}` → `Всё ещё согласовываем…`). The wording was
accurate about the machinery and wrong about the person: whoever countered had
just acted and was told their answer was being processed, while the side that
received the counter — the one message in the flow that exists to say *your
turn* — got a status telling them work was under way. Two people each waiting
for a matchmaker that was, in fact, waiting for them. It also skipped the
reminder that would have said so, because the whole state fell outside
`sideOwesAction` (below). Both sides now get **no status at all** there, and the
§3.5 scheduling reminder covers them instead.

**These lines carry no icon — no leading emoji and no animated `<tg-emoji>`
glyph** (founder decision 2026-07-30). An intermediate revision gave each tier
its own AIActions glyph, on the reasoning that the icon should escalate with the
wording; that was dropped because a status here is a *description of state*, and
an icon on it is decoration the state does not need. The `<tg-thinking>` shimmer
already carries "something is in progress" on its own, which is exactly the job
an icon would have been doing. This is deliberately narrower than the rest of
§1.3: the "agent is working" beats elsewhere keep their glyphs, because those
narrate work the bot is doing, while these describe another human not having
answered yet.

The two late tiers are **claims about machinery that really ran**, and that is why
their boundaries are where they are: the §3.5 scheduling/venue nudge fires at 6 h,
and the §3.5c "still on?" check-in at 24 h with cancellation at 48 h. Move a
boundary and you are asserting something about those workers — check them first.
Copy constraints: one line (~30 chars), and **no gendered verb about the
partner**, since a gendered ladder would double the key count in ru/uk/pl; the bot
referring to itself stays masculine per `VOICE_SELF_GENDER` (§2.1).

Tiers need an anchor, and nothing existing answers "how long has this side been
waiting" (`acceptedByA/B` are booleans, `availableTimesA/B` carry no submission
time, the row's `updatedAt` moves for unrelated reasons), so
`Match.peerWaitStartedAtA/B` carries it. The worker is its **only** writer —
stamped on the first tick a side is seen waiting, released when the wait ends so a
later wait on the same match restarts at tier 1 rather than opening on the
deadline copy. The action handlers deliberately write no anchor: they only ever
fire the instant the user commits, so tier 1 is true for them by construction.

**Why a worker.** A rich draft is ephemeral — it dies ~30 s after it is issued,
and the only way to hold one is to re-issue the same `draft_id`. So a shimmer
that lasts hours means a tick on a wall-clock interval shorter than that TTL:
`PEER_WAIT_TICK_MS` (default 20 s, `0` disables the feature). It is a
`setInterval` rather than a cron because node-cron's finest granularity is one
minute — already too slow. That per-waiter heartbeat (~3 API calls a minute) is
the real cost of this feature and was accepted deliberately; the tick is paced at
25 calls/s like the countdown worker. **A previous revision of this section
argued the opposite — that a shimmer must cover only the moment of the action and
never the wait. That was overruled (founder decision 2026-07-28) after a live
probe held one draft across 15 consecutive re-issues over 5 minutes with no
throttling.**

Each tick re-derives who is waiting rather than tracking it, so there is no state
to leak and nothing to "stop": when the partner answers, the side stops matching
the predicate, the draft stops being re-issued, and it expires on its own. Per
side (`isSideWaitingOnPeer`):

| Step | Waiting when |
|---|---|
| Pitch decision | `proposed`, this side accepted, peer hasn't answered |
| Calendar | `negotiating`, `proposedTimes` non-empty, this side marked slots, peer hasn't opened it |
| Venue | `negotiating_venue`, this side submitted, peer hasn't |
| Venue change — board | `scheduled` + `liking`, this side hearted places, peer has none |
| Venue change — payment | `scheduled` + `agreed`, this side is not the payer |
| Venue change — wish card | `scheduled` + `agreed`, she handed the payment over (`venueChangeOfferPaySentAt`) |

Notes on the edges, each of which is a real trap:
- **Only an accept waits.** A decline is irreversible (§3.2 lifetime pair ban)
  and the decliner's next screen is the "what was the main reason?" prompt.
- **Both picked and nothing overlaps is a wait for NEITHER side (2026-08-05).**
  A picks Monday, B counters with Tuesday. Each of them can now end it alone —
  widen the selection, or tap one of the other's slots, which auto-locks the
  date (§3.6). That is the definition of "your move", so it gets the §3.5
  reminder and never a status. The 2026-07-30 revision had it the other way
  round (a dedicated ladder shown to both), reading the state off the machinery
  — each side is technically blocked on the other — rather than off what the
  person can do; the result was a status contradicting the very message that had
  just told them their partner countered. The predicate is now simply *the peer
  hasn't opened the calendar yet*, which is the only calendar state where a user
  genuinely has nothing left to try.
- **The calendar gate is `proposedTimes`, not `ticketStatus`.** `negotiating`
  also covers the Date Ticket gate, whose waiting state its Mini App owns by
  design. `proposedTimes` is written by `startScheduling`, which runs only once
  the gate settles or when the feature is off — while `ticketStatus` defaults to
  `pending` even with tickets disabled entirely, so gating on it would have
  silenced the calendar shimmer for everyone.
- **Venue "submitted"** means a confirmed Venue Intent V2 snapshot, or — on the
  legacy concierge path — both the vibe text and the departure pin.
- **The venue-change board is covered (2026-07-30), reversing an earlier
  exclusion.** It was left out on the grounds that its Mini App already polls at
  ~4 s — true only while that Mini App is OPEN. Close it and the chat said
  nothing at all, which is the exact silence this feature exists to end. Three
  rules keep it honest: the **payer never waits** (they owe the Stars, that is an
  action); a hetero **female initiator does not start waiting merely because she
  isn't the payer** — while she can still offer she holds a live decision of her
  own, and her wait begins at the moment she actually hands it over; and a hidden
  **express mint shimmers for nobody**, since it is invisible to the partner until
  paid and a shimmer in their chat would announce that something is pending. The
  payer matrix is not reimplemented — `isHeteroPair` / `payerSide` are shared from
  `handlers/matching/venue-change.ts` through a narrow structural row type, so the
  20 s tick never has to load the board's full select.

**The action handlers start it immediately** (`startPeerWaitShimmer`) so the chat
isn't empty for up to a tick; the worker takes over from there. Quiet hours do
not apply: a draft is not a message and raises no notification, the same
reasoning that exempts the pinned status banner and the pitch countdown.

**Fallback for clients that can't render rich drafts.** They would otherwise see
nothing at all, so they get one ordinary message whose text is rewritten as the
wording climbs — at most once a minute, since an edit is a real API call on a
real message (and raises no notification); that budget is comfortably finer than
the narrowest tier (5 min), so a tier change is never visibly late there either.
It is deleted when the wait ends. Its id lives in `Match.peerWaitMessageIdA/B`
(+ `peerWaitEditedAtA/B`) rather than in memory: a PM2 restart would otherwise
strand a permanent "waiting for them…" line in someone's chat. Once a side is on
the fallback it stays there for that wait — retrying the draft every tick would be
a guaranteed failing call forever.

**What is NOT replaced.** On the pitch decision the "you accepted" card **stays**
and the shimmer sits under it. Unlike the calendar and venue lines that card is
not a throwaway receipt: it is tracked in `calendarMessageIdA/B`, carries
`MESSAGE_EFFECT_MATCH_ID`, and later morphs in place into the Date Ticket card
and then the Calendar (§3.6). Blind-decision safe either way — the shimmer is
shown only to someone who has already committed, and says only that we are
waiting, never what the partner chose.

Deliberately not applied to: the other two venue ack branches (`venueVibeNoted` /
`venueLocationNoted`, which hand the turn straight back to the same user) and the
Date Ticket gate (no chat-side waiting line exists — the Mini App owns that
state).

**One known interaction, on the venue-change branch only.** A rich draft is
collapsed by a real message landing in the chat, and the other three scenarios sit
on statuses where the waiting side's chat is quiet by construction — nudges and
check-ins go to the side that owes an action, and the Profiler is gated on
`PROFILER_BLOCKING_MATCH_STATUSES`. Venue change runs on `scheduled`, which is
deliberately **not** a blocking status, so a Profiler question or a date-lifecycle
DM can land mid-wait. The next tick re-issues the draft below it (≤20 s), so the
shimmer returns rather than dying — but it is the one place where it can visibly
blink.


### 3.7 Concierge Venue Negotiation (`negotiating_venue`)

Once `agreedTime` is locked, both users are asked for two things, **in
order** — the Telegram opening prompt (`venueConciergeIntro`) asks **only**
for the departure point so "what am I marking on the map?" is unambiguous;
the vibe is a separate, later message requested only after the departure
point is saved:

1. A **departure (commute) origin** — asked **first**, on its own. The
   prompt states plainly that the user marks *where they'll be setting off
   from* for the date and *why* (so the concierge can pick a convenient
   meeting spot easy for both to reach, near that point). Captured via the
   Location Mini App (`apps/webapp/location.html`). The legacy
   `request_location` reply keyboard was retired 2026-05-10 — it doesn't
   work on Telegram Desktop (no GPS) and only supports the user's *current*
   GPS, not "the metro I'll leave from" or "my friend's place tonight". The
   Mini App offers four input modes: one-tap browser geolocation,
   Places-backed autocomplete (type "Lukyanivska metro" or "Khreshchatyk
   14"), tap-on-map, and drag the marker. Stored in `vibeLat{A,B}` /
   `vibeLng{A,B}`; the human-readable label from autocomplete is stored in
   `vibeAddress{A,B}` (display only — the matching pipeline runs on
   lat/lng). Telegram users who share a raw location pin via the attach
   menu still flow through the legacy `handleVenueLocation` path;
   `vibeAddress*` stays null in that case.
2. A free-text **vibe** ("cafe / quiet / vegan / park walk / ..."),
   requested **only after** the departure point is on file, which
   `services/vibe-parser.ts` normalises to a strict whitelist
   (`cafe | restaurant | coffee_shop | park | museum | lounge`). Anything
   outside the whitelist is overridden and audited in `parsedCategoryA/B`.
   Free text that arrives **before** the departure pin is not banked as a
   vibe: `handleVenueVibe` redirects it back to the map
   (`venueLocationFirst`) so the location-first order holds.

**The venue stage claims a message only from a side that still owes one
(2026-07-29).** The stage used to consume EVERY plain message for as long as the
match sat in `negotiating_venue`, including from someone who had already
submitted both fields and was only waiting on their partner. For that user there
is nothing to collect, so the handler answered with the fixed
`venueConciergeIntro` card + "Pick on map" button — a prompt they had already
completed. Asking "so what happens now?" therefore got the opening instruction
back, which reads as the flow having reset, and the question never reached the
concierge agent at all. (Nothing was ever actually lost: that branch only
replied, it wrote no state, and the server separately refuses to let a stray
message overwrite a confirmed intent — see *Venue Intent V2* below.)
`resolveVenueRoutingState` now decides ownership from whether the caller's OWN
side has a complete submission, so a submitted side's text falls through to the
menu agent like it does at every other stage. "Complete" is read off the legacy
`vibeText`/`vibeLat`/`vibeLng` columns because both write paths land there — the
chat handler directly, and the V2 Mini App confirm mirrors the confirmed origin
and text onto them — so one check covers every rollout mode. A **location pin**
is still always consumed by the stage regardless: falling through would leave it
silently unanswered. The agent is told which sides have submitted
(`describeActiveMatch`), so "what now?" is answered with the real state —
waiting on the named partner, still owing a pin, or the concierge already
picking — instead of a restatement of the mechanic.

**Reopening the Location Mini App after confirming restores the submission.**
A confirmed intent used to reopen on a blank map centred on the city default,
with nothing on screen acknowledging what had already been saved — on the one
screen where being wrong about that is most alarming. The Mini App now restores
the vibe stage with the saved origin and chips for a `confirmed` intent exactly
as it already did for a `draft`. This also gives the stage its first way to
change your mind before the partner submits: re-confirming overwrites this
side's intent and is otherwise a no-op.

**Per-side "what's next" ACK.** The underlying collector stays idempotent —
either field can technically land first (e.g. a mobile submission, or a raw
attach-menu pin) — but the Telegram *prompts* are sequenced, and each save
fires a side-aware nudge so a user doesn't sit there wondering if anything
happened:
- location done, vibe not yet → "Starting point saved ✅ Now — what *vibe*
  are you after? e.g. _quiet cafe_, _park walk_." (text-only, the Mini App
  isn't relevant here). This is the normal next step after the departure pin.
- vibe done, location not yet → "Vibe noted ✅ Now pick where you'll
  be coming from:" + 🗺️ Pick on map inline button (re-surfacing the
  Mini App entry point in the chat). Defensive — the Telegram bot path no
  longer reaches it, but a vibe-first mobile/legacy save still can.
- both done → **no message**: this is the branch where the user has finished
  their side and has nothing left to do, so it gets the §3.6b waiting shimmer
  instead of the old `venueWaitingPeer` line, held until the partner submits.

The same `sendVenuePostSaveAck` helper drives all three paths
(`handleVenueLocation` / `handleVenueVibe` / `POST /v1/location/select`)
so the wording stays consistent regardless of which surface the user
saved through.

**The departure point must be inside a launched market (added 2026-08-05).**
Until this gate, the only validation on the pin was that the coordinates were
numbers — so a user could mark a point in another city or another country, and
the flow accepted it. The registration city has had a real gate since §1.3
(`validateHomeLocationPayload`); the departure point had none, on the same
data.

Nothing fake was ever assigned — `scoreVenueCandidate` discards anything beyond
the commute cap, so the run simply found nothing and the pair sat in
`negotiating_venue` until the §3.5c chain cancelled them 48 h later, with a
lifetime pair ban (§3.2 filter 6) as the parting gift. **The failure was
silent and terminal, which is why this is a gate and not a warning:** a pin
outside the market provably cannot yield a candidate, so accepting it only
defers the same dead end to a screen that can no longer fix it.

- **The screen refuses it, and says why.** The Location Mini App centres on the
  user's own city (not a hardcoded default), recomputes the distance on every
  pan, and while the pin sits outside the market it disables Confirm and shows
  a card naming the city. `GET /v1/location/venue-intent/state` serves the
  market (centroid + `radiusKm`) rather than the bundle carrying it, so a second
  launched city needs no Mini App redeploy. The pin is never *moved* — someone
  panning is exploring, and snapping them back would fight the gesture.
- **Search cannot offer one either.** `/v1/location/search` restricts Places to
  the market circle instead of merely biasing toward it, so an out-of-market
  address never appears. A bias only reorders, which meant the block card had to
  explain a result the search had just offered.
  **The restriction goes to Places as a RECTANGLE, and the circle is restored by
  a per-result filter (fixed 2026-08-09).** `searchText` accepts a circle for
  `locationBias` but **not** for `locationRestriction`, and it does not quietly
  widen the search when handed one — it answers `400 INVALID_ARGUMENT`, which
  the route's catch reports as an empty result list. So from the day this gate
  shipped (2026-08-05) until the fix, typing anything into the departure-point
  search returned **nothing at all** for every user in a launched market, and it
  read as "no such place" rather than as a fault: HTTP 200, `results: []`, no
  error on screen. It went unnoticed for four days because no production user
  had yet reached the venue step (0 dates ever), so the failure had never once
  been executed. The box is the smallest one containing the market circle — it
  necessarily over-includes at the corners, which is why the existing
  `checkDepartureOrigin` pass over the results is load-bearing rather than
  belt-and-braces: it is what keeps the offered results and the circular write
  gate in agreement, so search can never surface a place that Confirm would
  refuse. Over-including is the safe direction; a box narrower than the circle
  would hide real addresses inside the market. Nothing about the product rule
  changes — the gate is still exactly the market circle.
- **`services/venue-origin.ts` is the enforcement point**, and every write goes
  through it: `POST /v1/location/select`, `interpretVenueIntent` /
  `confirmVenueIntent` (Telegram Mini App *and* the iOS `/v1/matches/:id/*`
  pair), the legacy mobile `POST /v1/matches/:id/vibe-location`, and the raw
  Telegram attach-menu pin (`handleVenueLocation`, which had no validation at
  all). Refused with `400 origin-outside-market` carrying the market, so the
  native client can name the city too — never as `wrong-state`, which would
  misreport why the write failed.
- **Fail-open on missing data.** An account whose dating city is absent or not a
  launched market is not gated. Blocking someone over a gap in OUR data is never
  right, and such an account cannot hold a match anyway (matching joins on an
  exact `homeCityKey`), so the permissive branch is unreachable in practice.
- **Demo (DEMO_MODE.md):** the gate is NOT waived — the visitor sees the real
  card with the real reason — but it gains one extra button that drops the pin
  in the city, because a demo visitor is often genuinely abroad and would
  otherwise be asked to lie about where they are.
- **Both surfaces since 2026-08-06.** The `market` field was added for iOS on
  2026-08-05, but declared in the OpenAPI as `oneOf: [$ref Market, "null"]` —
  the shape swift-openapi-generator drops silently — so it never reached the
  generated client and the live gate existed on Telegram only. For that day the
  native client centred its map on a hard-coded constant and let any pin
  through to the server's refusal. The schema is now a bare `$ref` (an explicit
  JSON `null` still decodes to absent, so nothing on the wire changed), and iOS
  centres on the market, draws the radius, gates Confirm locally and names the
  city — including on the "use my location" branch, which is the likeliest way
  to set a bad point. The native client repeats the server's haversine
  deliberately, R = 6371 and all: `CLLocation.distance` measures on the
  ellipsoid and would disagree with this module by ~100 m at a 60 km radius,
  producing a band where the client allows what the server refuses.

**Curated-first venue selection.** When all four pairs are present, the bot
first consults the hand-curated venue base (`CuratedVenue`, currently scoped by
`universityDomain` when both sides share one) via `services/curated-venue.ts`.
Curated venues are operator-vetted first-date spots, so they are the PRIMARY
source when available; Google Places is the fallback for cross-domain city
matches or when no curated venue is in commute range. Ranking is
**fairness-aware** — it minimises `max(distA, distB)` (the worse of the two
commutes) rather than distance to the geometric midpoint — weighted by a manual
`priority` (1 best … 3 acceptable) and a small bonus when the venue's `vibeTags`
match the merged keywords. A venue whose worse commute exceeds
`CURATED_VENUE_MAX_COMMUTE_KM` (8 km) is discarded. Category selection mirrors
`mergeParsed`: exact merged category → `cafe` default → any. The base is
populated by `scripts/seed-venues.mjs` (Places-backed pull → manual review →
import); it shares the exact production quality gate via `searchVenueCandidates`,
so a curated spot can never be something the live gate would reject.

**A date is never lost to geometry (the geo ladder, added 2026-08-05).** The
selector needs a venue within `maxCommuteKm` (8) of BOTH origins, with the two
commutes within 3 km of each other. Two people at opposite ends of one city
cannot satisfy that — Kyiv's market radius is 60 km and Troieshchyna ↔ Vyshneve
is roughly 30 km apart — and the engine's answer used to be *no venue at all*.
That is legal input producing a cancelled date, so the selector now retries
with progressively wider tolerances instead of failing:

| Rung | Worse commute | Fairness gap | When |
|---|---|---|---|
| 1 | the pair's own `maxCommuteKm` (8 km) | 3 km | the ordinary case |
| 2 | 12 km | 5 km | rung 1 found nothing |
| 3 | the market radius | — | still nothing: the best available in the city |

**Only the two geographic caps move.** Quality floors, opening hours, the
price policy and every hard constraint (indoor/outdoor) are identical on each
rung, so a widened run is a longer trip, never a worse venue. Rung 3 is bounded
by the market radius, which the departure-point gate above guarantees both
origins sit inside — so a pair inside a launched city can always be served,
worst case a venue ~30 km from one of them. That is not a good date; a
cancelled one is worse.

The scoring scales follow the active rung rather than staying fixed, so a
widened pass still discriminates: at a 60 km cap a venue 5 km from both must
still outrank one 40 km from one of them. The rung that actually produced the
pick is recorded in `venueSelectionReason` and in the `poolSizes` funnel
(`geoRung`), so "how often does the engine have to stretch?" is a query rather
than a guess — if it stops being rare, the city's catalog is too thin.

One consequence for the failure path: **commute can no longer be the reason a
run found nothing**, so `minimalRelaxation` lost its `commute_12_km` branch and
the no-candidates notice no longer suggests relaxing a distance the user cannot
see a control for.

**Only `base`-tier venues are ever auto-assigned.** `CuratedVenue.tier` decides
which pool a venue belongs to, and the automatic first assignment reads `base`
only (§Premium for `premium`; §3.7b for the board). The third value,
**`alternative`**, is the operator's *heavier-cuisine* pool — Georgian, Uzbek,
Azerbaijani, Middle-Eastern, Central-Asian and similar. These are good venues,
but not the call Gennety makes FOR a pair sight-unseen on a first date, so the
concierge never proposes one: they exist purely as options the couple can pick
themselves in the post-assignment Venue Change board (§3.7b), where they are
unlocked and priced exactly like base (it is a *cuisine* classification, not a
price tier, and carries no Premium gate). Because neither `premium` nor
`alternative` is ever auto-assigned, neither is held to the ≤ MODERATE
student-friendly price cap — that cap exists to protect the automatic
assignment. Operator classification lives in the replayable Kyiv manifest
(`scripts/curated-venues.kyiv.expansion.json`).

Operator-blocked brands are excluded at every venue boundary: curated ranking,
candidate seeding/import, and live Google Places fallback. The Kyiv catalog
currently blocks all Musafir locations. Kyiv's reviewed additions and explicit
rejections are tracked by stable Google `placeId` in
`scripts/curated-venues.kyiv.expansion.json`; `pnpm sync-venues:kyiv` refreshes
their Places metadata before reconciling the replayable approved JSON.

A curated venue that is **closed at the agreed date/time** (per its stored
Places `openingHours`, evaluated in the venue's local time via
`utcOffsetMinutes`) is skipped at selection.

**Unknown hours are a refusal on the automatic assignment, and an admission on
the paid board (corrected 2026-08-09).** This paragraph used to say missing
hours were "treated as open, never a reason to exclude", which described
`isVenueOpenAt` — the predicate the §3.7b board still uses — and had been
untrue of the live selector since Venue Intent V2 reached 100%.
`hoursEvidenceAdmits` (`services/venue-intent-v2.ts`) fails closed instead, and
that asymmetry is deliberate: the board offers a venue the couple is choosing
with their eyes open, while the concierge picks one FOR them, sight unseen, and
"we have no idea when it is open" is not a good enough basis for that.

The consequence is that **public space needs an explicit operator mark**, since
Google publishes hours for a café and none at all for a street, an embankment
or a park. `CuratedVenue.hoursConfidence` carries it: `always_open` admits the
venue at any slot, `operator_confirmed` clears the evidence bar while still
honouring a recorded schedule, and anything else (`provider`, `unknown`, null)
needs real hours. Six Kyiv parks — Воздвиженка, Андріївський узвіз, Оболонська
набережна, Маріїнський парк, Міст закоханих and the botanical garden — sat in
the catalog looking healthy and were **never once assigned** because nothing had
ever written that field; the rule that dropped them was an unnamed inline
expression, so neither the catalog playbook nor the operator could see it. Five
are now marked, and the botanical garden is deliberately **not**: it is gated,
ticketed grounds with real closing hours, and the reason rides on the row
(`reviewNote`) so the next reviewer does not read the omission as an oversight.
The mark lives in the replayable city manifest rather than only on the built
row, because `sync-venues:kyiv --apply` regenerates those rows from Places and
would otherwise revert it silently — `--check` now fails on that divergence and
warns about any venue left with neither hours nor a mark.

The curated base is kept fresh by the
daily **venue re-validation** cron (`services/venue-revalidation.ts`): it
re-checks the oldest-verified active venues against Google Places by stored
`placeId`, deactivates ones that closed or dropped below the rating/review
floor, and refreshes opening hours. An infra failure never deactivates a venue.

**Season and weather sink an unsuitable venue, they never remove it
(feature-flagged `VENUE_SEASON_WEATHER_ENABLED`, added 2026-07-31).** A park in
a January downpour is a worse date than the same park in June, and the engine
had no way to know it. The founder decision is explicit about the shape of the
fix: this is a **ranking** signal, not a filter. A rained-out park drops a few
places among venues the ranker already considers comparable and stays fully
selectable — because a forecast can be wrong, a provider can be down, and
neither is allowed to withhold a venue from a couple. It is the same principle
the catalog already applies to unknown opening hours (unknown → treated as open,
never as grounds to exclude), and the same one behind removing the hard
constraints in §Venue Intent V2: a need this specific belongs to the pair, who
can change the venue on the §3.7b board or simply agree to walk somewhere else.

Two independent inputs multiply, and the product is clamped to **[0.8, 1.1]**:

- **Season** — a pure function of the date's month, so it costs nothing, cannot
  fail, and keeps working when the forecast does not. Winter sinks outdoor
  venues (mixed indoor/outdoor ones less), summer lifts them, and a scenic
  outdoor spot gets a small extra summer amplifier. **Spring and autumn are
  deliberately neutral** — in Kyiv they are exactly the seasons where the
  calendar predicts nothing and only the real weather is informative.
- **Weather** — the hourly forecast for the agreed slot (Open-Meteo, no key).
  Heavy rain or severe conditions sink exposed venues, freezing or extreme heat
  sinks them further, clear and mild weather lifts them. **An unknown forecast
  scores exactly like perfect weather, never like bad weather**, so an outage
  can never delete the outdoor half of the catalog.

Indoor venues — most of the catalog — are untouched by both, exactly 1.0. A
venue whose exposure the catalog does not record is also untouched: exposure is
read from the venue's indoor/outdoor capability, falling back to the category
**only for parks**, where the category alone settles it. Guessing "indoor" for
an untagged restaurant would be inventing evidence.

The clamp is the product guarantee, and it is a code constant rather than a
tunable: context can never outrank fit or quality (the same rule that bounds the
§3.7 diversity mechanics). Unclamped, a cold severe winter day compounds to
~0.69 — enough to push a genuinely better venue below a worse one, which is the
one trade this whole area of the product refuses to make. When the flag is off,
the multiplier is a constant 1.0 and no forecast is ever requested.

When no curated venue qualifies (no rows for the domain, or all out of range),
the bot computes the great-circle midpoint (`services/geo.ts`) and queries the
**Google Places API (New) v1**
`places:searchNearby` endpoint at `places.googleapis.com/v1/...`
(`services/venue.ts`). The legacy `maps.googleapis.com/maps/api/place/nearbysearch/json`
path was retired 2026-05-10 — it returned long-closed places when
`business_status` was `undefined` and offered no native price-level
filter, both root-cause issues for the "place doesn't exist / wrong
price tier" complaints.

Quality gate (strict tier):
- `businessStatus === "OPERATIONAL"` (strict — `undefined` is rejected)
- place type ∉ a hard deny-list (`gas_station`, `lodging`/hotels,
  `supermarket`/`convenience_store`, clinics, banks, gyms, car services,
  etc.) — enforced in BOTH strict and relaxed tiers. `searchNearby` already
  constrains by `includedTypes`, but the tier-3 `searchText` fallback does
  not, so without this a high-rated petrol station with a coffee corner
  used to leak through and get pitched as a date venue.
- `userRatingCount >= 30`
- `rating >= 4.0`
- For `cafe`/`coffee_shop`/`restaurant`/`lounge`, price evidence is mandatory
  and `priceLevel ∈ {FREE, INEXPENSIVE, MODERATE}`. Unknown and premium
  commercial prices fail closed. V2 museums likewise need provider or
  operator-confirmed price evidence; public parks may have no commercial price.

Candidates that pass the gate are ranked by
`rating × log10(userRatingCount + 10) × distanceFactor` (linear
1.0 → 0.5 over the search radius), and the top-1 is picked. This
beats Google's default ordering, which would pick the
closest-but-mediocre place over a slightly-further-but-popular one.

The compatibility picker tries `searchNearby`, then midpoint-biased
`searchText`, under the same strict gates and fails closed when neither returns
an eligible real place. Production has no relaxed expensive tier and no local
venue stub.

Persisted columns on success: `venueName`, `venueAddress`, `venueLat`,
`venueLng`, **`venueGoogleMapsUri`** (deep-link to the picked place).
The final `scheduled` DM is a compact, structured block — `📍 venue name`,
the full address, then a short (1–2 line) **grounded venue blurb** describing
what kind of place it is. The blurb is generated per-side in the user's
language by `services/venue-blurb.ts` using ONLY real facts (Google's
`editorialSummary`, rating, place category, and the vibe both users asked for)
— never inventing specifics — and degrades to a generic per-language line if
the model is unavailable, so finalization never blocks. The `googleMapsUri`
is **no longer inlined in the body** (it would duplicate the affordance); it
rides the "📍 Open in Maps" keyboard button only, so users still tap to verify
the venue exists, check hours, and pre-plan transit. For **seated** categories
(`cafe`/`coffee_shop`/`restaurant`/`lounge`, not `park`/`museum`) the block also
carries a one-line **busy-venue expectation-setter** (`matchScheduledNoReservation`):
the spot isn't reserved, so if it's packed at peak time it warmly nudges both
sides to grab a coffee and walk or drop into another place nearby (plain text —
the card is sent without `parse_mode`; voice per `VOICE.md`). The parallel safety
reinforcement rides the female-only T-1.5h pre-date safety brief (`safetyNoteFemale`
gains an "if it's crowded, stay somewhere busy and well-lit" bullet). The confirmation also wraps a localized date phrase
(`📅 Sat, 16 May, 19:00`, rendered in `Europe/Kyiv`) in a
**`date_time` MessageEntity** so the whole phrase is a visibly
unmistakable tap target — Telegram does not auto-style `date_time`
entities, so a bare ⏰ glyph reads as a regular emoji on iOS. Tapping
opens the user's local-timezone add-to-calendar sheet via the
entity's `unix_time`.

### 3.7a Date Card (feature-flagged shareable PNG)

Gated by `DATE_CARD_FEATURE_ENABLED` (default **off** → the scheduled
confirmation is the plain-text DM above). **Telegram-only, and deliberately so
— see the end of this section for what iOS does instead.** When on, each
side's `scheduled` confirmation is a rendered **PNG date card** (the recipient
sees their *partner*). The look ("Partiful-glow", 2026-06-20; recolored to the
burgundy / black / white design system 2026-07-09; **theme-aware 2026-07-11**)
renders in the **recipient's `User.theme`** — dark (near-black `#030303`,
light ink) or light (cream `#F5F5F5`, dark ink) — with the burgundy (`#8B253B`)
accent, a soft burgundy glow behind the hero photo, and faint film grain on the
dark card only (skipped on the light one). (The two burgundy corner discs were
removed.) It carries
a wide **duotone**-treated venue photo as the hero (the stock Places/curated
image is remapped into the burgundy brand palette so it reads as part of the card), an
overlapping tilted **polaroid** of the partner, a bold Archivo Black headline
**slogan** whose last line is the burgundy accent (`dateCardSlogan`; the brand
voice is intentionally a fixed English line —
"Error 404: Chat not found. Try real life." — across all five locales), the
"Gennety" wordmark top-left, the brand **butterfly** logo (`butterfly-logo.svg`,
shared with the match card) tilted top-right, and the venue name + address. The card
deliberately **omits the
date/time** — the exact slot already lives in the Telegram caption right below,
so repeating it on the card adds nothing and the freed space is spent on a
cleaner keepsake. Rendered server-side with `satori` (→ SVG) + `@resvg/resvg-js`
(→ PNG), with `@napi-rs/canvas` doing the venue duotone and grain tile; the
partner-face blur uses AWS Rekognition `DetectFaces` boxes + pixelation.
Rendered text is emoji-free (the bundled Roboto + Archivo Black fonts carry no
color-emoji glyphs, so all card accents are vector shapes, not emoji); emoji
live only in the Telegram caption.

- **Live render progress.** The render (partner-photo download + Places venue
  photo + rasterize) takes several seconds, so each side sees a per-side
  "shine" status (`dateCardSteps`: confirming details → building the card →
  final touches) while it runs. Unlike the other status beats this is **not** a
  fixed-duration stub — it is held on screen until the PNG is actually ready,
  then torn down before the card lands, so the chat never looks frozen. It is a
  normal edited status line; the render itself never depends on it (§1.3).
  The three beats always play through even when the render beats them to it
  (`NEVER_CUT_SHORT`, §1.3) — a fast render used to collapse the status to a
  sub-second flash of its first line, leaving the venue-search shimmer above it
  as the last thing visibly on screen.

- **Two renders, one layout.** The **private** card is sent with
  `protect_content: true` (blocks forwarding / saving / download) and carries
  the same `date_time`-entity caption + Maps / venue-change keyboard, plus a
  **Share** button. Tapping Share re-renders the card with the partner's
  **face blurred** and sends it *without* `protect_content`, so it can leave
  the platform without exposing the partner's identity. (`protect_content`
  does not block OS screenshots in a normal bot chat — only secret chats do —
  so the blurred share copy is the actual privacy guarantee.) The blur
  re-render is slow too — it adds Rekognition `DetectFaces` + pixelation on top
  of the same photo/venue/rasterize work — and the Share tap has no other
  feedback, so it gets its own held "shine" status (`dateCardShareSteps`, a
  star-led 4-beat sequence, uneven cadence) the instant Share is tapped. Like
  the private render it is held `until` the blurred PNG is ready, then torn down
  before the share copy is sent, so the user sees progress immediately instead
  of re-tapping into stacked renders.
- **Privacy fail-safe.** A blur that cannot be produced never falls back to the
  clear original; the share send is aborted and the user is told to retry.
- **Partner photos are forward/save-protected everywhere they appear with a
  clear face.** Both the match-pitch photo card (§3.3, the first place a user
  sees the partner) and the private date card are sent with `protect_content`,
  so the partner's images can't be forwarded, saved, or downloaded out of the
  chat. (OS screenshots still can't be blocked in a normal bot chat — that is a
  Telegram platform limit, not a toggle — so the blurred share copy remains the
  actual off-platform privacy guarantee.)
- **Venue photo — Google Places, single source (2026-07-25).** Every venue's
  hero image is the place's Google Places **cover** photo, credited on the card;
  Google's bytes are fetched at render time and never persisted (only the photo
  *resource name* is stored). This holds regardless of how the venue was chosen:
  Places-sourced venues carry the resource name from the search response, and
  **curated** venues — which store no imagery of their own — have theirs
  resolved from their stable `placeId` at the moment the venue is assigned
  (auto-assign, and the §3.7b venue-change agreement / express mint alike). One
  lookup per scheduled date, so the pointer is always fresh rather than a stored
  ref that can rotate and 404. No photo → a branded gradient backdrop.
  The previous "curated-first, operator-owned `CuratedVenue.photoUrl`" rule was
  removed: not one curated row was ever photographed, so the primary assignment
  path always fell through to a photo-less card. Operator-supplied photos are
  not part of the product today; if reintroduced they must be an explicit
  override with a seeding path, never a silently-null field.
  **The §3.7b board resolves them the same way, per board open (2026-08-03).**
  A curated venue's board card and its detail gallery were blank for the same
  structural reason as the date card once was — curated rows carry no imagery —
  and it went unnoticed because until the catalog was scoped by `cityKey` the
  curated branch never ran in production at all, so every board fell through to
  the Places sweep, whose search response already carries photos. The board now
  resolves each curated card's photos from its `placeId` in one Place Details
  request (which returns the whole gallery, not just a cover), after the 12-card
  cap and cached in-process by place id — a day for a real answer, minutes for a
  failed lookup, so an outage costs pictures rather than becoming a retry storm.
  Best-effort by rule: an unresolved photo leaves the category glyph the client
  already draws, and a board is never held up or failed for imagery. Only the
  board *read* pays for this; the like/confirm calls rebuild the same catalog
  purely to re-resolve a submitted key and skip the lookups entirely.
  **Delivering those bytes is retried, on both hops (2026-08-08).** "Best-effort"
  was being read as "one attempt", and one attempt is not enough on this path:
  the droplet hits occasional TCP connect timeouts reaching Google's photo CDN —
  measured at roughly one request in ten under a parallel burst, in **production
  as well as the demo**, and invisible until now only because production has
  never had a date reach this board. The board opens ~13 tiles at once, so a
  single blip landed on several of them, and the client's fallback was terminal:
  it swapped in the category glyph, marked the tile settled and never asked
  again, so one dropped connection cost a permanently blank tile until the Mini
  App was closed and reopened. The proxy now spends its existing 10-second
  budget on up to 3 attempts (≤4s each, 150ms apart) instead of one long wait,
  and the client retries once more after 600ms — so a tile has to fail twice, on
  two different hops, before anyone sees a glyph. **Only transient failures are
  retried**: a thrown fetch, a 5xx, a 429 or a 408. A 4xx, a non-image body and
  an over-ceiling file are verdicts that do not change on the second ask, and
  re-downloading an oversized image is not a fix. The client's retry asks for a
  marked URL and paints the one that actually decoded, never the one it started
  from — otherwise a rescued tile would immediately re-request the bytes that
  just failed.
  **And a failed photo is always logged now.** The two non-throwing failures —
  a non-OK upstream and a non-image body — used to answer 502 in complete
  silence, so a systematic upstream problem (a quota, a revoked key, a 429
  storm) was indistinguishable from "photos just don't work" and left almost
  nothing in the logs to go on. Every exhausted request logs its attempt count
  and last reason; a blip that a retry rescues logs one line too, because a
  rescue is rare by definition and is the only early warning that the path is
  degrading before it starts costing users actual photographs.
- **Never wedges.** Any render/send failure degrades per-side to the existing
  plain-text scheduled card, so one side's hiccup never denies the other their
  card and scheduling always completes.

**The native client does not receive this PNG, and should not (2026-08-06).**
iOS renders the scheduled state as a live SwiftUI card off `SerializedMatch` —
no new route, no render job, no `DATE_CARD_FEATURE_ENABLED`. The PNG exists
because a Telegram chat cannot draw a countdown, honour Dynamic Type, or read
itself out under VoiceOver; shipping the same image to a client that can do all
three would be a regression, and the shareable-with-blurred-face copy is a
Telegram affordance with no App Store equivalent yet. What the server owes the
native card instead is one field: **`SerializedMatch.timeZone`**, the caller's
own city zone. `agreedTime` is an instant and the card has to draw it on a wall
clock — the device's is wrong for a traveller, who would read and turn up at a
time neither side meant. It is the same choice this PNG already makes by
rendering in the canonical city zone, and the same reason `CalendarState`
carries the field (§3.6).

### 3.7b Venue Change v2 (feature-flagged, paid multiplayer board)

An optional post-schedule step lets the pair swap the auto-assigned venue via
a **shared likes board** — the couple's first joint activity before the date.
Gated by `VENUE_CHANGE_FEATURE_ENABLED` (default **off** → the scheduled-date
DM carries no venue-change button and nothing below fires). Telegram-only.
Implemented as a string sub-state (`Match.venueChangeStatus`: null → `liking` →
`agreed` → `settled` | `lapsed`) layered on a `scheduled` match — like the Date
Ticket and Coordination gates, it adds no `MatchStatus` enum value. The v1
propose/veto flow (female-exclusive, mandatory comment, decline-cancels-match)
was replaced wholesale in 2026-07 before ever launching; design doc:
`VENUE_CHANGE_PRODUCT_SPEC.md`.

- **Entry — no disclaimers.** BOTH sides' scheduled cards carry a passive
  "📍 Change venue" `web_app` button (no proactive "does the venue suit you?"
  question, no hint DM). The board is open from `scheduled` up to
  **T − `DATE_ALERT_HOURS` (T-5h)** — the ice-breaker / emergency cutoff.
- **The board (calendar mechanics, verbatim).** The Mini App
  (`apps/webapp/venue-change.html`, Liquid Glass tokens) opens straight into
  the catalog: the **current venue pinned on top** ("Picked for you" — the
  eternal default that stands whenever nothing settles), then alternatives
  within **`VENUE_CHANGE_RADIUS_KM` (3 km)** of the original venue center —
  **except `premium`, which reaches `VENUE_CHANGE_PREMIUM_RADIUS_KM` (5 km)**
  (below) — **curated-first** with the Places fallback under the production
  quality gate.
  This board is the ONLY place `alternative`-tier venues (§3.7 — the operator's
  heavier-cuisine pool) ever appear: they are always included, unlocked, and
  priced like base, independent of `PREMIUM_FEATURE_ENABLED` and of whether
  either side subscribes. Only `premium` venues are shown-locked (§3.8).
  **One card per real venue (2026-08-03).** The curated base stores one row per
  university domain, so a city holds several identical copies of each place —
  Kyiv: 538 active rows for 127 actual venues, 90 premium rows for 18. While the
  catalog was scoped by `universityDomain` that was invisible (the scope took
  exactly one copy); scoping it by `cityKey` took all five, and since copies
  share coordinates they sort adjacently — the board became the same three
  places repeated four times each, with the pinned premium slots all holding one
  venue. The catalog now collapses rows on the same key the board already
  resolves picks by (`placeId`, falling back to name+address), keeping the
  copy the re-validation cron confirmed most recently. The automatic assignment
  has deduped by place id since it shipped; this is the board catching up.
  **The assigned venue is not among the alternatives (2026-08-03).** It is
  already the pinned "keep this place" card, and it is normally a curated row in
  its own city, so it used to render twice — and the two cards did different
  things. Agreeing on the pinned one (`KEEP_KEY`) keeps the venue for free and
  closes the session; agreeing on the identical place under its own key took the
  **paid** path, charging `VENUE_CHANGE_STARS` to "change" to the venue the pair
  already had. The exclusion is server-side and applied before the 12-card cap,
  so the freed slot goes to a real alternative and the like/confirm calls refuse
  that key as `invalid-venue` rather than trusting the client to hide it.
  **The pinned card has a photo too (2026-08-08).** It was the one card on this
  board without one — a consequence of the exclusion above, since the card is
  not a catalog row and had nothing to inherit pictures from, so the board asked
  the pair to compare places while showing them everything except the place they
  already had. `original.photoRefs` on the board state carries it: the cover
  stored at assignment (`Match.venuePhotoName`, the same image the date card
  showed them), falling back to one cached Place Details lookup from
  `venuePlaceId` when a row carries no cover. The state is polled every ~4 s, so
  the common path is deliberately network-free; a failed lookup leaves the
  category glyph exactly as before. **The "Picked for you" badge moved onto its
  own line to make room.** A 68px photo takes 82px out of a ~350px card, and the
  badge sits in what is left — at which point no locale's wording fits
  ("Obecne miejsce spotkania" is 203px against 176px), so it wrapped into a
  two-line pill and pushed the venue's own name into an ellipsis. Heading the
  card instead, it fits on one line at any width in every language, and the row
  under it is the same picture / words / heart an alternative uses. The name on
  this card wraps rather than truncating — it is the one card whose venue is
  already yours; the twelve alternatives keep their ellipsis, because an even
  row height is what makes that list scannable.
  **The premium tier searches a wider radius** than the rest of the board,
  because the pinned slots must hold *different* venues and the premium pool is
  small and hand-picked: from Podil only 10 of Kyiv's 18 premium venues sit
  inside 3 km, while all 18 sit inside 5 km. A slightly longer trip is a fair
  trade for a nicer venue someone is deliberately choosing; it is never imposed
  on the automatic assignment, which keeps its own commute rules (§3.7).
  **Board ordering is pin-then-scatter** (deliberate conversion mechanic): the
  `VENUE_CHANGE_PREMIUM_PINNED` (3) nearest `premium` venues lead the list
  unconditionally, so a non-subscriber meets the locked tier before anything
  else; any further premium (to `VENUE_CHANGE_PREMIUM_MAX` (5) total) is then
  **shuffled into the remainder** alongside base/alternative rather than stacked
  on top, so a locked card keeps resurfacing as the user scrolls instead of the
  board reading as a paywall wall. The tail shuffle is seeded by the match id,
  so the order is stable across re-fetches (Mini App reopen, post-unlock
  repaint) — an unseeded shuffle would re-deal the cards under the user.
  **The board is never a wall of tables (2026-08-09).**
  `VENUE_CHANGE_WALK_RESERVED` (3) of the remaining slots are held for the
  nearest **outdoor walking spots** — the `park` category, which is what the
  curated base uses for the whole open-air set: parks, embankments, Andriivskyi
  descent, Volodymyrska Hirka, the Lovers' Bridge. All of them are free, need no
  booking, and work as a place to meet at a time the couple picks. Before this
  the order was decided by proximity alone, and in a city centre that means
  cafés: measured across every possible board centre in the live Kyiv catalog,
  **38% carried no outdoor spot at all** and the rest averaged one card in
  twelve — while the median centre had **ten** parks sitting inside the same
  3 km radius. They were never out of reach; they were losing a race they cannot
  win, because a promenade is one venue along a kilometre of riverfront while a
  café cluster is thirty doors on one street. With the reservation that goes to
  **93% of boards and 2.8 cards**, with board size unchanged.
  Three properties are deliberate. It is a **floor, not a cap** — an outdoor
  spot that would have earned a slot on distance still takes one, so a green
  district shows more than three. It **changes which cards make the cut, never
  where they sit**: the held cards join the same shuffled tail as everything
  else, the exact opposite of the premium pin above, because the point is that
  one is on the board at all, not that it leads. And it **degrades rather than
  shrinking**: the 7% of centres with no park in range keep a full board of
  twelve, exactly as today. Ticketed, timed venues are a different product
  answer and stay out — `museum` remains excluded from this board outright, and
  the reservation is not a back door for it. The radius is untouched (widening
  it to 5 km rescues only 3 of those 8 centres, so it buys a second knob for
  almost nothing). The Places fallback already sweeps `park`, so it inherits the
  same guarantee for free. Telegram-only; no new env, no schema.
  Each side hearts any number of places (full-set submissions, server-resolved
  against the catalog — client venue data is never trusted); the partner's
  hearts land live (~4 s polling). The FIRST like of a session claims the
  **initiator** (`venueChangeProposerId`) and sends the partner one
  positively-framed, liker-gendered board-invite DM (guarded per recipient).
  **Agreement**: tapping a venue the partner already liked — or a single like
  overlap — agrees instantly; several simultaneous overlaps return an
  `overlapCandidates` list and the actor picks one (initiator-offers /
  responder-decides, exactly like the Calendar §3.6). No free text anywhere —
  no comment channel, so NO IN-APP CHAT needs no carve-out here.

  **A venue's photos open full-screen (2026-08-05).** Tapping any photo in a
  venue's detail gallery opens the ordinary lightbox — edge-to-edge on an opaque
  dark backdrop in both themes, swipeable across the whole set, with a `n / N`
  counter, its own ×, and Telegram's BackButton bound to closing it rather than
  leaving the venue. It exists because this board asks the couple to *choose* a
  place, and until now the largest a venue was ever shown was a 340px rail tile
  — you could not actually see the room you were agreeing to meet in. It opens
  on the tapped photo (never rewound to the first) and paints instantly from the
  copy the rail already decoded, then sharpens the slide being looked at to the
  photo proxy's 1600px ceiling; the upgrade is per slide, so a 10-photo venue
  never pulls ten full-size images on one tap. Vertical swipes are disabled
  while it is open — a fixed overlay has no scroll of its own, which is exactly
  when Telegram reads a downward drag as "close the Mini App", so dragging a
  photo would otherwise drop the user out of the app. A venue with no photos
  shows the category glyph and is deliberately not tappable: there is nothing to
  enlarge. Telegram-only; the same gallery (and viewer) backs both the detail
  page and the read-only venue preview reached from the agreed/settled screens.
- **Payment (150⭐, `VENUE_CHANGE_STARS`).** A settled change costs one flat
  Telegram Stars price; browsing/liking/agreeing are free and no one pays
  before an agreement, so **no refund path is needed** (the only refund is the
  parallel-pay race below). Payer matrix — **hetero: the man pays, whoever
  initiated**; same-sex: the initiator pays. The finalizer (whoever completed
  the agreement, definitionally the first to see the final screen) resolves it:
  - *he initiated* → he pays "no questions": invoice right in his Mini App if
    he finalized, else a pay-prompt DM. **That DM opens the board, not a bare
    invoice (2026-07-28).** Whoever finalizes decides inside the Mini App, on a
    screen that shows the venue and carries "keep this place" beside the pay
    button; this side wasn't in the Mini App when the agreement landed, so a
    chat message is the only way to reach them — and while it carried a
    `url`-to-invoice button it was a one-way door: the tap jumped straight to
    Telegram's native payment sheet, with no venue to look at and no way to say
    "actually, let's stay where we were". The way back did exist, but only on the
    earlier "📍 Change venue" message, which by then had scrolled off — so the
    product silently required knowing that an older message was the real
    surface. Same decision, same screen, whichever side you are. The DM is
    deliberately two lines — the news, then the venue — and names **no price**
    (founder call): the button no longer charges anything, so pricing it would
    misdescribe the tap, and the real number is stated on the pay button one
    screen later, before any money moves. The wish card
    (below) is deliberately NOT changed — it renders the venue itself and
    carries an explicit decline, so it is neither blind nor a dead end. Opening
    the board cold this way also loads no catalog, so the agreed screen pulls
    it in the background to fill its venue photo instead of showing a bare pin.
  - *she initiated, he finalized* → his in-app fork `[⭐ Lock it in]` /
    `[Not this time]`;
  - *she initiated, she finalized* → her fork `[Lock it in myself — ⭐]` /
    `[Ask him to lock it in 💌]`. The offer sends him the **wish card** — the
    date-card layout re-rendered with HER polaroid over the new venue's duotone
    hero (`services/venue-wish-card.ts`, headline "Her pick. Your move.",
    protected; text fallback so the offer never wedges) with pay/decline
    buttons. Its caption is **her ask only** — the card already renders the venue
    name and address, so repeating them in text was pure duplication
    (`venueWishText`, two short lines split by a paragraph break). The
    no-PNG fallback keeps the venue line (`venueWishTextFallback`): with no card
    there is nothing else naming the place he is being asked to pay for.
    One offer per session. **Handing the payment over is confirmed to
    her, not silent (2026-07-27).** Rendering the wish card and delivering it
    takes seconds inside her request, so the tap holds a named spinner
    ("sending your ask to {name}…") and then lands on a success screen of its own
    — the same treatment every other committing act on the board gets — stating
    that he now has this place in chat with a button to lock it in, and that her
    own "lock it in myself" path is still open. Before this the one moment where
    she hands the decision to someone else produced no reaction at all: the
    button sat dead for the render, then the same agreed screen redrew with one
    small note at the bottom, so the honest read was "nothing happened". Because
    that screen now asserts the card *landed*, the assertion is made true: a
    failed send releases the one-shot stamp and answers `send-failed`, so she is
    told it did not go through and can retry, instead of being told it arrived
    while the single offer is spent (previously the send error was swallowed and
    the API still answered ok).
  - His "not this time" (wish card button or Mini App fork) is **single and
    final, and ENDS the change**: the session closes, the originally-assigned
    venue simply stands, and she gets a neutral notice (`venueDeclinedKeepDm` —
    no price, no pay button) that never mentions a refusal. She is **never
    pushed to foot the bill** for a change he wouldn't. **While the fork is still
    open** (before he decides) both invoices can be open in parallel — her
    pay-self path and his — and the settle CAS makes the first payment win, with
    `refundStarPayment` returning the Stars of a lost race. **Every Stars charge
    is recorded in `venue_change_purchases` (unique `telegram_payment_charge_id`)
    BEFORE the settle CAS runs**, so the invariant is the same one Rematch
    states: a payment either changes the venue or comes back, never neither.
    That record is also what tells a *redelivered* payment (duplicate charge id →
    idempotent no-op) apart from a genuinely *second* charge (new charge id →
    always refunded, including when the same person paid twice). A refund whose
    provider call fails is parked in `refund_failed` for the hourly
    `venue-change-refund` sweep and is **never announced to the user as
    completed** (corrected 2026-07-26: previously the charge id was not stored at
    all, a failed refund was a fire-and-forget `console.error`, and a second
    charge from the same payer was silently kept). `pre_checkout_query`
    re-validates amount + that the swap is still `agreed`, so stale (reusable)
    invoice links are declined before any Stars move (a decline having closed the
    session also invalidates any open link). She never sees a price anywhere in
    the shared flow — the reveal ("{name} covered the venue change ❤️") is part
    of the product.
  - **Express (hers alone, hetero).** On any venue's detail page the female
    gets "⚡ Change right now — 150⭐": a unilateral swap with no agreement.
    The mint stamps the pick (`venueChangeExpressAt`), stays **invisible to the
    partner until paid**, and an abandoned mint quietly reverts to the open
    board after ~30 min. On payment the partner gets the positive-frame
    surprise card ("she picked a cozier spot ✨"). In same-sex pairs express is
    available to either side (the veto asymmetry is hetero-only).
- **Settle.** `successful_payment` is the trust boundary: a status CAS flips
  `agreed → settled`, copies the venueChange\* snapshot onto the canonical
  `venue*` fields (incl. `venuePhotoUrl/Name` so a re-rendered date card shows
  the new venue), and both sides get updated venue cards with the `date_time`
  entity + Maps button — plus the payer-gendered reveal / express surprise.
  **The pinned status banner is re-rendered in the same breath** rather than
  left to the once-a-minute tick, since it names the venue too (§2.1). The free
  Premium/demo settle does exactly the same.
- **A finished session can be started over, up to `VENUE_CHANGE_MAX_PER_DATE`
  (2) settled changes per date (2026-08-09).** The board used to close for good
  on the first settle, which made "we picked, then we reconsidered" — an
  ordinary thing for a couple to do — structurally impossible. Two is the whole
  allowance: enough to change your mind once, not enough to become a venue
  carousel the partner gets a new card for every hour. **A lapse restarts on the
  same terms and costs no allowance** (nothing was paid); the asymmetry that
  left it terminal was never a decision — the male's "not this time" has always
  reset the status to null outright, so a second attempt already existed on one
  path out of three. Each change is a separate purchase at the full flat price,
  and the T−5h cutoff bounds every round exactly as it bounds the first.
  - **The restart is a session RESET, not a reopened flag.** The `venueChange*`
    columns are one slot, not a history, so a fresh round wipes both sides'
    likes, the initiator, the wish-card and decline stamps, the paid stamps and
    the board-ping ids — in the SAME compare-and-set that writes the new round's
    first like, so there is no instant at which the row is half-cleared. Two
    consequences are load-bearing rather than tidy: clearing only the
    restarter's likes would let the very first heart of round two "overlap" the
    partner's round-one heart into an agreement nobody is currently making, and
    leaving `venueChangePaidAt` set would keep the §3.6b peer-wait shimmer dead
    for the whole round.
  - **Nothing else about the board learns the word "restart".** Only the four
    entry points that know how to perform that reset — the state view, the
    catalog, the like submission and the express mint — ask whether a new round
    may start (`evaluateVenueChangeRestart`). Keep-original, offer-pay,
    confirm-overlap and pay-decline keep reading the ordinary live-session gate
    and so still refuse a finished session outright, which is what stops any of
    them running against columns describing a round that is over.
  - **A finished session reports an EMPTY board.** A settle leaves both sides'
    hearts in place and a lapse does not clear them either, so the state view
    zeroes them: otherwise the restart would open showing marks the next tap
    deletes.
  - **The success screen stays the landing, and the offer on it is quiet.** The
    board never reopens by itself under a result the user is still reading;
    "change the venue again" is a tertiary text link under Open in Maps, absent
    once the allowance is spent. It is deliberately NOT added to the settle DM:
    that card's job is to confirm what was just paid for, not to sell the next
    change. The durable way back in is the **My Date hub**, whose venue row now
    appears for a restartable session as well as a live one — the scheduled
    card's own button also still works, for as long as that card is findable.
  - **The cap is a counter on the row (`Match.venueChangeCount`), not a derived
    count of purchases**, because a Premium pair settles free and writes no
    purchase row — and so does every demo visitor (DEMO_MODE.md settles the
    board free, Stars having no mock rail). Those are exactly the cohorts money
    does not bound, so they are the ones the counter has to.
- **The way back (`keep-original`).** At any point before a change is paid for,
  either side can say "actually, let's just stay where we were": it withdraws
  that user's marks and, if an agreement was already reached, calls the
  agreement off (the partner gets a neutral `venueKeepOriginalDm`; a cancelled
  *express* mint stays silent, since they never saw it). The original venue was
  never touched, so dropping the change IS the restore. The session stays open
  while the partner still has marks; once neither side has any it retires
  completely. The sticky offer/decline stamps are deliberately NOT reset while a
  session lives, so the way back can't be used to re-nag him with a fresh wish
  card. Surfaced as "Keep this place" on the pinned current venue and as a quiet
  action on the agreed/payment screen — without it, the only exit from an
  unwanted agreement was to let it rot until the lapse below.
- **Lapse — the match is NEVER cancelled.** An `agreed` swap unpaid by
  `min(agreedAt + VENUE_CHANGE_TTL_HOURS (12h), T − DATE_ALERT_HOURS)` lapses
  on the date-lifecycle tick (before ice-breakers): the original venue stands,
  both get a neutral notice, and the session ends. No Elo, no priority comp —
  nothing was lost, which is also why a lapse spends no part of the per-date
  change allowance and the board can be started over (above). The v1 "decline =
  cancel the match" branch is gone entirely, and with it the v1 disclaimer.

### 3.8 Gennety Premium (feature-flagged recurring subscription)

An optional **$17.99/month** subscription (Gennety Premium), gated by
`PREMIUM_FEATURE_ENABLED` (default **off**). **The price is denominated in
Telegram Stars, not in dollars**: the charge is `PREMIUM_STARS` (750⭐), and
$17.99 is exactly what Telegram's own Star store bills for 750⭐, so the label
states what the user actually pays rather than a marketing number. The two move
together — changing one without the other makes the button lie. The iOS rail is
Apple's own price for `premium_monthly` (StoreKit `displayPrice`, set in App
Store Connect), which is the only place that number lives; nothing in this repo
can set it, so keeping the two surfaces at the same price is an operator step,
not a code one. It is a **standalone per-user
entitlement** owned by `services/premium.ts` and deliberately decoupled from any
one feature — its first (v1) benefit is venue-change, but the entitlement is the
seam future perks plug into. Active ⇔ `User.premiumUntil > now`; the
append-only `subscription_ledger` (unique `externalPaymentId`) is the
source of truth and makes every grant/renewal exactly-once. An entitlement a
user already paid for stays valid regardless of the flag.

- **Two payment rails, one entitlement.** Telegram: a native **Telegram Stars
  recurring subscription** (`createInvoiceLink` with
  `subscription_period = 2592000` — Telegram supports only the 30-day period;
  empty provider token + `XTR`, no merchant account). The `sub:premium` payload
  is settled by the `successful_payment` handler on the first charge AND every
  auto-renewal, exactly-once via the recurring `telegram_payment_charge_id`;
  `premiumUntil` advances to Telegram's `subscription_expiration_date`.
  Cancellation is native (Telegram → Settings → Subscriptions) OR **in-chat via
  the menu agent** (below) and the entitlement simply lapses. iOS: a **StoreKit 2
  auto-renewable subscription**
  (`POST /v1/premium/appstore/transaction` + App Store Server Notifications V2)
  reusing the ticket-rail trust model (JWS/notification is only a pointer; the
  authoritative transaction is re-fetched from Apple). The subscription's
  `originalTransactionId` is stored on `User.premiumExternalId` so a renewal
  webhook (which carries no user id) finds the owner.
- **Purchase surface.** Telegram: a ✨ **Gennety Premium** main-menu row → the
  Premium hub (benefits, or "active until …") → the Premium Mini App
  (`apps/webapp/premium.html`, `WebApp.openInvoice`). iOS: a native paywall
  (designed in parallel; `features.premium` in `GET /v1/app/config`).
  **The hub names no price and its button does not ask for the sale**
  (2026-08-01). It used to open with the monthly price and a `Subscribe — $X/mo`
  button — a request for money made in the first message after the menu tap,
  before the product had shown what Premium does. The button is now a plain
  "Learn more" and the price appears one tap later, inside the Mini App, next to
  the benefits it buys. The hub's closing line is the reassurance, not a
  procedure: cancelling is one message to the concierge, which is the real
  mechanic (below) — the Telegram → Settings → Subscriptions walkthrough is
  gone from here and survives only where it is load-bearing, as the honest
  fallback when the Stars API cancel fails. An **App Store** subscriber viewing
  the hub gets Apple's own steps instead, since the concierge cannot cancel
  their subscription and must not imply otherwise.
- **In-chat cancellation (Telegram, agent-driven), two-stage confirm
  (2026-08-01).** When a user tells the menu agent they want to cancel / stop /
  turn off Premium — or asks how — the agent calls the `offer_cancel_premium`
  tool (`services/menu-agent.ts`); it never cancels from raw text. For a
  **Telegram Stars** sub the bot posts a nonce-bound, one-use **offer** card
  (`❄️ Keep` over `Yes, cancel`). Tapping **Yes, cancel** does **not** cancel
  anything yet: it burns the offer token and posts a second, freshly
  nonce-bound **final** card that isolates the destructive option exactly like
  the Freeze/Delete fork (§2.1) — one red **Yes, I'm 100% sure, cancel**
  against two green back-out buttons that both just navigate back to the main
  menu, relying on the router's existing pending-token cross-invalidation to
  burn the stale card rather than a dedicated decline handler. Only the final
  card's red button calls Bot API `editUserStarSubscription(is_canceled: true)`
  to stop the renewal at Telegram, then `recordInChatCancellation` flips
  `premiumAutoRenew=false` and appends a `cancelled` `subscription_ledger` row.
  Both cards share the same token mechanics as Freeze/Delete — a fresh
  10-minute, single-use nonce bound to its own message
  (`handlers/menu/premium-cancel.ts`). Access is **never** revoked early —
  `premiumUntil` stands, so the user keeps Premium until the paid period ends,
  and there is no mid-period refund. If the Stars API cancel fails (or no
  recurring anchor is on file) the bot does NOT claim success — it points the
  user to Telegram → Settings → Subscriptions. An **App Store** sub can't be
  cancelled server-side (Apple owns it), so the agent shows the exact
  iOS-Settings steps instead of a button — this can surface at either hop,
  since Premium state is re-checked both when advancing to the final card and
  again right before the mutation (it can drift during the up-to-10-minute
  window between the two cards). After a confirmed cancel the bot politely
  asks **why** (one line, skippable); the free-text answer is stored on that
  `cancelled` ledger row's `note` for churn analysis. Telegram-only (the menu
  agent is Telegram-only); iOS cancels natively via Apple.

**Benefit #1 — venue-change (v1).** Inside the §3.7b board:

- **Premium venues.** Curated venues carry a `tier` (`base` | `premium`).
  Premium venues are hand-picked nicer spots that **may exceed the ≤ MODERATE
  student-friendly price cap** — a deliberate, documented exception to the
  §3.7/§3.7b price gate that applies **only** to the premium tier and **only**
  in the paid venue-change board. The **auto-assign concierge picker stays
  base-only** (§3.7), so the default date can never break the price cap; premium
  is always an opt-in change, never the automatic first assignment.
- **Selection gate (either-party unlock).** Premium venues are always **shown**
  in the board (with a "Premium" plate on the card face + a lock badge on the
  select button) but are **selectable only when either participant has an active
  subscription** (`pairPremiumActive`). The gate is enforced server-side (the
  tier is re-resolved from the catalog; the client is never trusted) across
  likes, the multi-overlap confirm, and the express mint — a locked pick returns
  `premium-locked` (HTTP 402), which the Mini App turns into a subscribe-in-place
  CTA. Tapping the locked button opens the subscription flow; the card is still
  tappable to view details / open in Maps.
  **The Premium screen has a way back when it was reached from the board
  (2026-08-03).** Every premium affordance on the board hands off to
  `premium.html` with an ordinary same-origin navigation, and Premium used to be
  a one-way door: someone who read the price and decided against it had to close
  the Mini App entirely and reopen "Change venue" from the chat. It now carries
  a return target (`services`-free, client-side: `apps/webapp/src/return-to.ts`)
  and shows Telegram's native BackButton, which reopens the exact board they
  left. The button appears **only** on that arrival — a Premium screen opened
  cold from the main menu is the first screen of its session and has nowhere to
  go back to, so it shows none, and any BackButton the previous page left
  visible is explicitly hidden rather than left dead. The return is a fresh
  navigation rather than a history entry, which is what makes a *successful*
  subscription land correctly too: the board re-reads `pairPremiumActive` on
  open, so the premium cards come back unlocked. The return target is validated
  against an allowlist of known pages, never taken as a URL from the query
  string.
  **Back walks the whole chain, not one hop (2026-08-05).** The first version
  stored a single target, so each hand-off overwrote the previous one: board →
  Premium → referral (the referral cross-promo link, §3.9) left only
  "referral came from Premium", and the board was erased. Back therefore worked
  exactly once at any depth — the user landed on a Premium screen that now
  believed it had been opened cold, showed no button, and the only way out was
  to close the Mini App and reopen "Change venue" from chat. The trail is now a
  stack: every screen returns to the one that actually sent the user there, all
  the way down to the page opened from a chat button, which correctly has no
  back. Three rules keep it honest — a page already in the trail is treated as
  a **return** to it rather than a new level (so a loop between two screens
  cannot grow the URL forever or make back replay a path never walked), the
  depth is bounded, and every entry is re-validated against the same allowlist
  on the way out, so a hand-edited trail degrades to a shorter one instead of
  becoming a redirect. The top of the trail stays in the original query keys,
  so a client still running the previous bundle keeps its one working level
  rather than losing back entirely.
- **Fee waiver + counterfactual.** A settled change normally costs
  `VENUE_CHANGE_STARS` (§3.7b). With Premium it is **free**: a premium venue is
  always free (the pair has premium), and a base venue is free when the settling
  actor is themselves premium — a free change settles instantly at agreement with
  no invoice and no wish-card fork. A **non-premium** payer settling a base venue
  still pays the flat price AND sees an in-flow **counterfactual** ("with Premium
  this is free ✨", `premiumWouldWaive`) right at the pay step, so the limit is
  felt in the real moment. The "man pays for the woman → surprise reveal"
  gesture (§3.7b) is preserved for non-subscribers.

The blind-decision, no-in-app-chat, 3 km commute, open-at-slot, and fairness
invariants are all unaffected; premium venues still pass every non-price gate.
Telegram-first; iOS in parallel.

### 3.9 Referral Program (feature-flagged)

An optional referral program ("Give a date, get a date"), gated by
`REFERRAL_FEATURE_ENABLED` (default **off**); it pays rewards in Date Tickets
AND complimentary Premium months, so it rides the already-on
`TICKET_FEATURE_ENABLED` + `PREMIUM_FEATURE_ENABLED`. Full spec:
[REFERRAL_PRODUCT_SPEC.md](REFERRAL_PRODUCT_SPEC.md).

- **Killer angle.** A ticket is a real date and matching is same-city, so every
  verified friend also grows the local pool that decides whether the referrer
  themselves gets matched — the reward is framed as *"give a date, get a date"*.
- **Trigger = verification.** The referrer is paid only when an invited friend
  reaches `verificationStatus='verified'` — the same anti-fraud gate (liveness +
  `phone @unique`) that admits a user to matching, so the reward condition IS
  the "real, matchable human" condition. The `verified` settlement
  (`grantReferralRewardsForVerifiedInvitee`) is exactly-once across every path
  (pipeline `verified` branch + pull/rerun short-circuit) and covers mobile
  invitees (not gated on `telegramId`).
- **Invitee reward.** A fixed **1 month of Gennety Premium**
  (`REFERRAL_INVITEE_PREMIUM_MONTHS`), granted + active at a wow screen shown as
  the second-to-last screen of the first onboarding Mini App (before the
  AI-memory choice). Safe pre-verification because Premium's only benefit
  (venue-change) requires a scheduled date.
- **Referrer reward.** A milestone ladder (`REFERRAL_LADDER`, default cumulative
  1/1, 2/2, 3/3, 5/5 tickets+months at 1/3/5/10 verified friends), each rung
  idempotent via a unique ledger id. The referral Mini App shows the ladder with
  the dollar value at each rung. A per-referrer 24h velocity guard
  (`REFERRAL_DAILY_REWARD_CAP`) **holds** (never denies) rewards during a
  suspicious burst; held rungs self-heal on the next event.
- **Attribution.** First-touch `User.referralSource = referral:<referrerId>`
  from a `?start=referral_<id>` deep link (Telegram) or `POST /v1/me/referral/claim`
  code (iOS); never overwritten. Self-referral (by id or shared verified phone)
  is blocked.
- **Rewards reuse the wallet/entitlement ledgers** (`ticket_ledger`
  `referral_milestone` + `subscription_ledger` `referral`) with the additive
  `grantComplimentaryPremiumMonths` (extends `premiumUntil` additively without
  clobbering a real recurring anchor). No new tables; the blind-decision,
  no-in-app-chat, and ledger exactly-once invariants are unaffected.
- **Cross-promo entry points (paying screens → referral.html).** The Ticket
  Store, the Date Ticket gate, Premium, and the Venue Change board (twice — the
  pay step and a locked premium venue) each show a quiet, secondary "invite a
  friend instead" affordance — never a button competing with the real
  pay/subscribe CTA — only when the user is genuinely short (empty ticket
  wallet, not subscribed, or paying Stars for a venue swap) and
  only while `REFERRAL_FEATURE_ENABLED` is on (mirrors `starsEnabled`, exposed
  per-screen as `referralEnabled` on the wallet/ticket-gate/premium/
  venue-change state endpoints). Tapping it opens `referral.html`, which
  carries a native Telegram BackButton back to the exact screen the user came
  from (`apps/webapp/src/return-to.ts`) — no dead end, no lost payment context.
  When that screen was itself reached from another (board → Premium → here),
  back keeps walking rather than stopping one hop up; see §3.8 for the trail
  and its bounds.
  **It is a compact chip, and two rules keep it that way (2026-08-08).** It
  shipped as five hand-copied full-width rows of sentence-length text — four
  identical CSS blocks under four class names — and each of the three ways that
  shape failed is now a rule in `apps/webapp/src/referral-hint.ts`, the single
  module all five call sites share. **(a) Never in an action bar.** On Premium
  it sat inside the pinned footer, which is `flex: none`, so it grew that footer
  by ~39px and pushed the subscribe CTA and its price line up the screen — the
  one surface where the hint MOVED the thing the user came to tap. It is now the
  tail of the scroll and the footer holds the CTA and the price alone.
  **(b) One line of copy.** The Premium string ran 59 characters, ~415px at
  13px/600 against ~350px of usable width on a 390px phone — two lines on every
  device, i.e. a paragraph rather than a link. Every string is now ≤31
  characters, one statement rather than a question ("Не хватает билетов?" made
  the reader answer a question before they could skip the line), one wording for
  all five surfaces, and a test holds the bound. **(c) Never full width.** A
  30px auto-width pill on a faint fill, against a 52px hero CTA; on the venue
  board's pay step it also loses half its top gap, because two equal full-width
  rows under each other — the Premium counterfactual and this — read as a list
  of two options rather than as an offer plus its footnote. Telegram-only; the
  native client owns its own paywall.

### 3.10 Promo Codes (feature-flagged, independent campaign links)

An optional **independent promo-code** program, gated by `PROMO_FEATURE_ENABLED`
(default **off**). Distinct from Referral (§3.9): the code belongs to a
*campaign*, not a referrer, so ad bulletins / promo materials can hand a new user
a richer welcome gift. Full spec:
[PROMO_CODES_PRODUCT_SPEC.md](PROMO_CODES_PRODUCT_SPEC.md); it rides the already-on
`TICKET_FEATURE_ENABLED` + `PREMIUM_FEATURE_ENABLED`.

- **Gift.** A **1 free Date Ticket + 3 months of Gennety Premium** (both per-code
  configurable), granted + active at a **richer, visually distinct wow screen**
  (three confirmed-status rows — "Status confirmed · Promo active · Subscription
  activated" — plus the ticket + months) shown as the second-to-last onboarding
  screen (Telegram Mini App) or a native paywall-style screen (iOS). Deliberately
  *more* than the referral welcome screen (which grants only 1 month, no ticket),
  so it renders differently.
- **New users only, first-touch.** Recorded as `User.referralSource =
  promo:<CODE>` on the creating touch (Telegram `?start=promo_<CODE>` /
  `startapp`, or the iOS deferred-attribution claim). Never applies to an
  existing user. **Mutually exclusive with Referral** — a single `referralSource`
  holds one program's value; `parseReferrer` ignores `promo:*` and
  `parsePromoCode` ignores `referral:*`, and the promo wow screen takes
  precedence over the referral one.
- **Grant timing = the wow screen** (like the invitee-Premium), which sits after
  the onboarding contact gate (unique verified phone / verified email), so
  farming the gift needs fresh phone numbers. Codes additionally carry `active`,
  `expiresAt`, and `maxRedemptions`; the grant is exactly-once + cap-safe (an
  atomic guarded `redeemedCount++` alongside a unique `PromoRedemption` row, then
  unique-`externalPaymentId` ticket + Premium grants).
- **iOS attribution.** A custom Apple-native deferred deep link (no external
  SDK): the promo landing (`GET /v1/promo/:code`) stashes a coarse device
  fingerprint + copies `GENNETY:<CODE>` to the clipboard, then bounces to the App
  Store; first launch resolves the code via clipboard and/or a fingerprint match
  (`POST /v1/me/promo/claim-deferred`), and the native wow screen grants via
  `POST /v1/me/promo/claim`. Best-effort by product decision — **no manual-entry
  fallback** (a `PROMO_MANUAL_ENTRY_ENABLED` server seam exists if the miss rate
  proves painful). Telegram's start-param path is fully reliable.
- **Management.** Reusable codes are created/managed out-of-band via
  `scripts/promo-codes.mjs` (`pnpm promo:create|disable|stats|list`). Rewards
  reuse the wallet/entitlement ledgers (`ticket_ledger` `promo`,
  `subscription_ledger` `promo`); the blind-decision, no-in-app-chat, and ledger
  exactly-once invariants are unaffected.

### 3.11 Rematch (feature-flagged, paid on-demand re-run)

An optional **$2.99** (150 ⭐) purchase that re-runs the matching engine for
**one man**, gated by `REMATCH_FEATURE_ENABLED` (default **off**). Telegram-only
in v1. Full spec: [REMATCH_PRODUCT_SPEC.md](REMATCH_PRODUCT_SPEC.md).

- **The asymmetry is the product.** Only men buy. A woman never buys, never sees
  a price, and never opts in — she becomes the **candidate** of a man's run and
  receives an ordinary pitch prefixed with **gift framing** ("I kept looking, and
  found someone"). One code path monetizes one side and gifts the other.
- **Not a new algorithm.** `findCandidatesFor()` is already a single-seeker
  engine, so a rematch inherits every §3.2 invariant unchanged: the lifetime pair
  ban (so "rematch" always means *someone new*, including after a decline), the
  single-live-match rule, the verification/contact-rail gates, city scoping, and
  the 24 h candidate cooldown. **A paid run never lowers the admission bar and
  never buys a score boost.** The cooldown is deliberately kept: right after the
  Thursday batch the only available candidates are the *unpaired* women, which is
  exactly the cohort the famine gift is meant for.
- **Pain-triggered entry points only** (no menu row): the Thursday no-match DM,
  and any match that died without a date — an explicit decline (his, hers, or
  both; the primary case), the same decision taken from the iOS app, or a 24 h
  TTL expiry. The offer fires only once the match is terminal and the outcome
  reveals have landed, never to a first decider whose match is still live. It
  states before payment that it buys an introduction, not a date.
- **Money rule.** Payment buys a pitch. A decline, a ghost, or a failed
  negotiation is **not** refunded (stated in the offer copy). The only refundable
  outcome is "the engine found nobody", and it is automatic. The flow is
  check → pay → re-check → deliver-or-refund, with a durable hourly retry so a
  failed refund is never announced as successful and never silently kept.
- **Limits.** 2 purchases per rolling 7 days with a 24 h cooldown between them
  (the cooldown is what stops decline-and-instantly-retry, preserving the weight
  of a decision); a candidate who already received a rematch pitch within 7 days
  is protected from another; and a blackout window before the weekly batch keeps
  a single-seeker run from taking a candidate the globally-optimal Thursday
  allocation needed. A rematch pairing clears both sides' famine counters exactly
  like the weekly batch.
- `Match.source` (`weekly`/`rematch`) is stamped inside the creating transaction;
  weekly-optimizer analytics filter to `weekly` so on-demand runs never pollute
  the scoring A/B. The blind-decision, no-in-app-chat, single-live-match, and
  ledger exactly-once invariants are unaffected.
- **Cadence.** The purchase-count rolling window and the famine gift-framing
  lookback both read `CADENCE.rematchWindowMs` (7 days under `weekly`). The
  three env-backed knobs above (`REMATCH_MAX_PER_WEEK`, `REMATCH_COOLDOWN_HOURS`,
  `REMATCH_PRE_BATCH_BLACKOUT_HOURS`) are deliberately NOT sourced from
  `CADENCE` — they stay plain env reads in `config.ts` — so they need manual
  review (and almost certainly new values) before Rematch is ever enabled
  under a `daily` cadence; `REMATCH_FEATURE_ENABLED` itself was left untouched
  by the daily-cadence migration and remains **off** in production.

## Phase 4 — Date Lifecycle

Driven by `services/date-lifecycle.ts` + `services/pre-date-safety.ts`,
`setInterval` every 2 min. All actions are idempotent via timestamp
columns on `matches`.

| When | Action | Idempotency marker |
|---|---|---|
| Activation → `scheduled` | Generate **wingman hints** (one short imperative tip per side about the other) and persist on the row | `wingmanHintA/B` |
| T − 5 h | Send personalised AI **ice-breakers** (3 starters per side, language-aware, fallback to static lists). For Telegram users the DM is delivered through the native rich AI-compose draft stream (`streamDraftsToChat(..., { rich: true })`, same primitive as the pitch): a "thinking" lead beat (`icebreakerStreamStart`, a `<tg-thinking>` shimmer), each starter revealed one-by-one as growing drafts, then the full set of starters as the plain final `sendMessage` — the emergency-window DM lands right after. Degrades to the classic edited stream when a client can't render rich drafts. Mobile gets the same content via `iceBreakersA/B` (no streaming). | `icebreakersSentAt` |
| T − 5 h | Open the **emergency window** — DM both sides with the cancel button (callback `emerg:start:{matchId}`) | shared with above |
| T − 5 h | **Start the native «date day» Live Activity** on both sides (`services/date-day-activity.ts`, iOS §4.2) — APNs *push-to-start*, so the card appears on a locked phone whose owner has not opened the app, which is the entire reason the gate is at T-5h. No-op for anyone with no registered start token, i.e. every Telegram-only account. | shared with above |
| T − 1.5 h | **Advance the Live Activity to the `wingman` stage.** | shared with `wingmanSentAt` |
| T + 2 h | **End the Live Activity.** A time window (T+2h … T+2h30) rather than an idempotency column: ending an activity that is already gone is a no-op, so a repeated sweep costs one wasted push. | — (idempotent by nature) |
| T − 1.5 h | **Pre-date safety brief** to the female user (Telegram DM only — mobile gets push). Skipped when no female participant has a Telegram presence. | `safetyNoteSentAt` |
| T − 1.5 h | **Wingman hint reveal push** — the asymmetric tip is unmasked at this gate (the mobile serializer enforces it independently) | `wingmanSentAt` |
| T − 1 h | **Pre-date coordination offer** (feature-flagged) — DM the initiator the contact-exchange / anonymous-chat menu (see below) | `coordOfferSentAt` |
| T − 30 min | **Anonymous proxy chat opens** (feature-flagged, Variant C only) — DM both the "Enter chat" button | `proxyOpenedAt` |
| Date moment | (no automated action — users meet in person) | — |
| T + 2 h | **Anonymous proxy chat auto-closes** (feature-flagged) | `proxyClosedAt` |
| T + 24 h | **Feedback prompt** to both sides; LLM parses positives/negatives and updates `negativeConstraints` accordingly | `feedbackPromptedAt` |

### Post-date Feedback UX

The T+24h DM is a structured invitation, not a single 📝 button. It carries
two stacked inline buttons in the user's language and an optional Bot API 7.6
`message_effect_id` (`MESSAGE_EFFECT_FEEDBACK_ID`) so the moment reads as
something more than a tech ping:

- **`[✍️ Open feedback form]`** — `web_app` button opening the post-date
  Feedback Mini App (`apps/webapp/feedback.html`). The form shows three
  cards: a custom 1–10 chemistry slider, a `Yes / Maybe / No` segmented
  control for "second date?", and a free-text textarea with cycling
  placeholders. Slider value, second-date pick, and text are auto-saved to
  `DeviceStorage` so a swipe-down dismiss doesn't wipe a draft. On submit,
  the Mini App POSTs `{ matchId, chemistry, wantsSecondDate, text, language }`
  to `/v1/feedback/post-date` (auth: `tma <initData>`); the bot composes
  the structured fields into a single text blob for the LLM analyst — no
  schema additions to `Match`. Second-date pick is required to send.
- **`[🎤 Send voice instead]`** — callback `feedback:voice:{matchId}` puts
  the session into `awaiting_feedback`, sends a `record_voice` chat action,
  and asks for a voice note (or typed text — both accepted). The upstream
  `voiceHandler` transcribes via Whisper, then the same shared
  `recordPostDateFeedback` pipeline persists `Match.feedbackByA/B` and
  appends new negative constraints. Same pipeline as the form path.

### Pre-date Coordination (feature-flagged)

Gated by `COORDINATION_FEATURE_ENABLED` (default **off**). Solves the "find each
other at the venue / signal a delay" gap. Driven by `services/coordination.ts`
on the date-lifecycle tick; handlers in `handlers/date/coordination.ts`.

**The anonymous chat (Variant C) reaches both surfaces since 2026-08-07;
contact exchange (A/B) stays Telegram-only.** This section used to say the whole
flow was Telegram-only, and the gap was not one missing endpoint but a missing
*initiation*: the offer requires both sides in a bot chat, and `openProxies`
only opens a window for a match whose `coordMethod` was set by tapping an inline
keyboard — so a pair with an app participant never got the offer, never got a
method, and never got a window. Two changes close it:

- A pair the Telegram fork cannot reach has **variant C selected for them** at
  T-60m. That is the right default rather than a second menu, because the other
  two variants exchange `t.me/` handles — meaningless to someone who has none —
  and the MVP scope already keeps only variant C on the app.
- The relay moved into `services/proxy-chat.ts`, shared by the Telegram handler
  and `GET/POST /v1/matches/{id}/chat` (JWT), so the two surfaces cannot drift
  on the window, the log, or what the partner receives. Delivery follows the
  partner's OWN rail — a DM, an APNs push carrying the message text, or both.
  Before this the relay only ever DM'd, so a mobile partner learned of a message
  by opening the app.

The window is derived from `agreedTime` (T-30m … T+2h) rather than read from
`proxyOpenedAt`/`proxyClosesAt`: those are written by the 2-minute tick, which
would open a thirty-minute window up to two minutes late. The stamps keep their
real job — the pair was told — and `proxyClosedAt` is still a force-close.

**Reachability is `platform`, not `telegramId > 0`.** The offer used to filter
on the id alone, which stopped being a reachability test when Telegram login
shipped: that rail stores a REAL id on an app-only account the bot cannot
message. It would have offered an inline keyboard to someone who could never
see it, then read the silence as a choice.

- **Initiator (T-60m).** ~1h before the date the bot offers the **female**
  participant three ways to coordinate. A same-sex pair with no female
  participant is offered to both sides, and whoever taps first becomes the
  initiator (first-tap-wins; the second tap gets an "already chosen" notice).
  Idempotent via `Match.coordOfferSentAt`.
- **Username-aware menu.** Contact exchange uses a `t.me/<username>` link
  (Telegram gives bots no phone number, and `text_mention` to a stranger is
  unreliable). The captured `User.telegramUsername` therefore gates which
  options appear: **A** only if the initiator has a username, **B** only if the
  partner has one, **C** always. If neither has a username the offer says
  contact exchange isn't possible and only C is shown.
- **Variant A — share my contact.** Initiator reveals her own Telegram; the
  partner is DM'd her `t.me/` link. Single consent (her tap).
- **Variant B — request partner's contact.** Bot asks the partner's consent
  (`coordPartnerConsent`); on **approve** the initiator is DM'd the partner's
  `t.me/` link, on **decline** she's told (and pointed at C). Only B asks for
  partner consent.
- **Variant C — anonymous proxy chat.** Opens **unconditionally** at T-30m
  (no partner consent — an offline partner must never strand the initiator),
  auto-closes at agreed time **+ 2h**. The cron DMs both an **Enter chat**
  button; tapping it sets the `coordination_chat` session state (entry is
  explicit, so normal bot use — `/menu`, settings, photos — is never hijacked
  into the relay). While in the chat, plain text is relayed bot→partner; every
  relayed message carries **Leave chat** + **Report** controls and is logged to
  `ProxyMessage`. Media is rejected (text-only, closes the face/metadata-leak
  bypass). The relay re-checks the window per message, so a stale session
  self-heals after close. See the "NO IN-APP CHAT" carve-out in Core Principles.

**Every step of this flow is a rendered PNG card, not a bare text DM
(2026-08-01, `services/coordination-card`).** The hour before the date was the
product's most visually silent stretch, on the one flow that is entirely about
a next step. Five cards, one per real send — the T-60m offer, the Variant B
consent ask, a revealed contact (Variant A, or B after approval), a Variant B
decline, and the Variant C window opening. They ship as ONE message each:
the card, the existing localized copy as its **caption**, and the step's own
inline keyboard, exactly like the date card (§3.7a) and the venue wish card
(§3.7b). The Variant C **close** notice keeps its plain text — there is no card
for "it's over".

Two rules give the family its meaning:

- **Every variant renders the same white polaroid frame in the same place;
  only its contents change.** `offer`/`ask`/`shared` hold a real profile photo —
  the partner on the offer ("this is who you're about to meet"), the *asker* on
  the consent card (so the partner sees who wants their contact), the contact
  owner on the reveal. `declined` holds a clock instead of a face, because that
  card is about a decision rather than a person, and the clock points at the
  anonymous chat 30 minutes out. `proxy` holds the portrait **withheld** behind
  a burgundy halftone with the brand mark reading through it — the anonymity of
  the relay stated in the exact frame the contact cards use for a face, which is
  also why that one card carries no photo at all.
- **The card carries the beat; the message carries what you act on.** Nothing on
  a PNG is tappable, selectable, or reachable by a screen reader, so the `t.me/`
  link, the instructions and the buttons all stay in the caption and the
  keyboard. `shared` and `declined` therefore print no sub-line on the card at
  all — theirs already exists verbatim in `coordRevealToInitiator` /
  `coordSharedToPartner` and `coordPartnerDeclined` — and the card spends that
  height on air instead of on a duplicate.

Cards render in the **recipient's** `User.theme` and language, like the other
PNG cards. Delivery is fail-open by construction (`coordination-card/send.ts`):
a null render, a caption over Telegram's 1024-char photo limit, or a rejected
`sendPhoto` all fall through to the plain text DM the flow sent before. This is
not decoration-grade tolerance — the DM lands ~1h before the date and is the
only way the pair can find each other, so it must degrade rather than fail.
Telegram-only, and inert with `COORDINATION_FEATURE_ENABLED` off.

### Emergency Protocol

`handlers/date/emergency.ts`:

**Both surfaces since 2026-08-07.** Everything irreversible — the status
compare-and-set, the peer's priority boost, the ticket refunds — lives in
`services/emergency-cancel.ts`, shared by the Telegram handler and the native
`POST /v1/matches/{id}/cancel` (JWT). Each surface owns only how it *asks* and
how it *tells the partner*: Telegram quotes the reason verbatim into a chat,
iOS has no chat to quote into and shows it in the app. They must not disagree
about anything else, which is why the split is where it is.

The same change fixed something that had been quietly false: the Telegram
handler's comment claimed a mobile peer got "a push notification dispatched
separately", and no such push existed anywhere. A mobile-only partner learned
their date was off only by opening the app. The service now pushes the peer on
either rail — **without the reason**, which is someone else's free text and
does not belong on a lock screen; it is shown where the recipient chose to look.

- Tap → an explicit **confirmation guard** that makes the lower-risk choice
  visually easier: `[Keep the date]` first with native `success` styling, then
  `[Yes, cancel the date]` with native `danger` styling (callbacks
  `emerg:abort:*` / `emerg:confirm:*`). The copy briefly checks for nerves,
  minor lateness, or uncertainty, reminds the user the match already cleared
  time, and states that cancellation is irreversible (the match can never be
  restored). A stray tap on the emergency button is a pure no-op until the red
  path is confirmed. Backing out touches no state and leaves the date on.
- Confirm → `awaiting_emergency_reason` session state.
- The user MUST type a free-text explanation; the bot quotes the **exact
  text** to the other person as a Telegram blockquote (no AI rewrite, no
  stripping) and appends a short Gennety soft note. Match flips to
  `cancelled`, `emergencyCancelledBy` records the actor, the verbatim text
  lands in `emergencyReason`.
- **The reason step keeps its own way back, and its claim on the chat expires
  (2026-08-03).** It used to have neither, which made it the one irreversible
  confirm in the product with no escape *and* the one that could fire by
  accident. `awaiting_emergency_reason` read the next plain message as the
  reason with no deadline and nothing that ever released it — not `/menu`, not a
  menu tap, not time — so a user who tapped "Yes, cancel", thought better of it
  and simply closed the chat had their **next unrelated message, days later,
  cancel a scheduled date and be quoted verbatim to their partner**. Two fixes,
  one shape (`services/match-flow-claim.ts`): the prompt now carries the same
  green `[Keep the date]` the previous screen offers (same `emerg:abort:`
  handler, which releases the claim), and the claim itself is bounded — 30
  minutes here, the shortest window in the product because this is the only text
  state that destroys something. A callback tap that isn't one of the step's own
  buttons, or any command, releases it immediately (the rule §Phase 1b already
  states for the Profiler: an open question is not a standing claim on
  everything the user types). Past the window the message falls through to the
  concierge agent, which sees the live match and can still offer the real cancel
  card (§3.5c) — so nothing is lost, it just stops happening by itself. The same
  bound covers the post-date feedback text path (24 h — invited a day after the
  date, and it only writes to the answerer's own profile) and the report details
  step (§Phase 5).
- The partner who was cancelled on receives a very small Elo/priority bump
  (`EMERGENCY_CANCEL_PEER_ELO_BOOST = 5`). The canceller is not penalised
  because emergency reasons may be legitimate; `eloMatchesPlayed` is not
  incremented because no accept/decline contest resolved.
- **Both sides get their Date Ticket back** (§3.5b — the date didn't happen, so
  every paid ticket returns to its payer, the canceller included). The refund
  line rides each side's existing message: the canceller's confirmation, and —
  appended *after* the verbatim quote, so the blockquote entity still covers the
  exact reason — the partner's notice.

## Phase 5 — Trust & Safety (Reports + Strikes)

Post-match the bot offers `[Report]` (callback `report:open:{matchId}`).
Free-text reason is LLM-triaged into a `tier`:

| Tier | Meaning | Action (`services/moderation.ts`) |
|---|---|---|
| **1 — Preference** | Personal preference mismatch, not unsafe | Append to *reporter's* `negativeConstraints`. No penalty on reported. |
| **2 — Ethical** | Unethical / boundary issues | `reported.strikes += 1`. **Strike 1** → warning DM. **Strike 2** → `status = suspended`, `suspendedUntil = now + 14 d`. **Strike ≥3** → `status = banned`. Cancel in-flight matches at strike ≥2. |
| **3 — Safety** | Safety threat | `status = pending_investigation` immediately, cancel in-flight matches, report row stays `adminReviewed = false` for the manual queue. |

**The reported category bounds the tier in BOTH directions (2026-07-26).** The
reporter picks a category, and that category sets a floor *and* a ceiling; the
LLM only refines within the band. The floor has always existed (the classifier
can never downgrade below what the category implies). The ceiling is new, and
closes a real escalation path: the classifier's only input beyond the category
label is the reporter's free text, so before this a reporter could choose the
mildest category and write text engineered to produce Tier 3 — freezing an
innocent partner's account and cancelling their in-flight matches on the
classifier's word alone. **Tier 3 is now reachable only from the three
categories the reporter themselves marked safety-grade** (`wrong_person`,
`unsafe_red_flag`, `spam_or_fraud`), where floor and ceiling coincide and the
LLM has no say. `fake_photos` / `offensive_behavior` / `inappropriate_profile`
cap at 2; `other` caps at 2 as well — an unclassified free-text report can still
produce a strike, but cannot auto-freeze anyone. Nothing is lost for genuine
safety reports filed under a mild category: Tier 2 already suspends at strike
≥2, and the row reaches the moderation queue either way. The report text is
additionally fenced as untrusted data in the triage prompt, but the clamp — not
the prompt — is what bounds the outcome.

**Every step of the report flow can be backed out of, and the details step stops
owning the chat (2026-08-03).** Choosing a category put the session into
`awaiting_report_details`, where the next plain message became the report body —
with no deadline, and nothing that ever released the state. Two consequences,
both real: an abandoned report turned a user's **next unrelated message, days
later, into a filed report** on their partner (LLM-triaged, up to a strike or a
suspension); and the step offered no way out at all — the category screen has a
"← Back" (`rb:`), but the details screen had only "send without details", and
for **Other** literally no button, so the only exits were filing something or
walking away and leaving the claim open. The details prompt now carries that
same cancel on every category, and the claim expires after an hour or the moment
the user taps anything that isn't one of its own buttons (shared with the
emergency-reason and feedback paths — see §Phase 4 → Emergency Protocol).

Other safeguards:
- `(reporterId, matchId)` is unique — duplicate reports rejected at write
  time and surfaced as `reportDuplicate` to the user.
- `autoUnsuspendElapsed` runs hourly so a 14-day Tier-2 suspension that
  expires mid-week reactivates within the hour rather than waiting for the
  next Thursday batch.
- `MatchEvent` rows (`ACCEPTED`, `DECLINED`, `EXPIRED_SILENT`,
  `EXPIRED_PEER_IGNORED`, `CHEMISTRY_POSITIVE`, `CHEMISTRY_NEGATIVE`) drive Elo
  updates and the admin dashboard's behavioural views. The enum also declares
  `PROPOSAL_SHOWN` and `DATE_COMPLETED`, and **nothing writes either**
  (ARCHITECTURE.md → `match_events`) — a completed date leaves no
  `DATE_COMPLETED` row, so read completion from `Match.status`. Emergency
  cancellation's small peer boost is applied directly by
  `handlers/date/emergency.ts` and does not increment `eloMatchesPlayed`.

## Cross-Cutting Concerns

### The loading mark: butterflies in the stomach (2026-08-06)

Every Mini App full-screen wait renders one shared mark
(`apps/webapp/src/butterfly-loader.ts` + `.css`): a faint line-drawn waist with
three of the brand's own logo butterflies flying inside it. It replaced the
generic spinning ring on the Verification, Date Ticket, Ticket Store, Premium,
Referral, Venue Change and Type Radar screens. The idiom is the product — no
chat, one real date, the nerves before it — so the wait is the one moment that
can say something instead of only measuring time.

Three decisions are load-bearing rather than decorative:

- **The butterfly is the logo's path** (`assets/brand/butterfly-logo.svg`),
  split once down the body axis so the wings flap independently. The split
  forces the gradient to `userSpaceOnUse` over the whole-butterfly bbox: an
  `objectBoundingBox` gradient restarts at each wing and quietly turns the mark
  symmetric, losing the logo's off-centre magenta glow.
- **Structure stays neutral, colour is spent only on the butterflies** — the
  same rule the two-party palette follows (ARCHITECTURE.md → theme tokens). The
  torso is a grey hairline; the butterflies are the only saturated thing on
  screen. The bloom sits INSIDE the outline, so the warmth reads as coming from
  inside the belly rather than as a halo around a figure, and light gets its own
  much weaker alpha (the dark value reads as a pink smudge on cream).
- **The wings hold open for about half of each beat.** A butterfly beats and
  glides; an evenly-eased fold spends most of its time half-closed, which at
  128px reads as a flickering sliver. The mark is read at a glance, so the pose
  it is usually caught in has to be the recognisable one.

`prefers-reduced-motion` keeps the mark and drops all travel and wingbeat,
leaving a slow fade — still "working", with nothing moving across the screen.
Telegram-only: the native iOS client draws its own loading states and no
`/v1/*` shape changed. Demo mode (DEMO_MODE.md) builds the same bundle, so it
inherits this for free — no gate, no paid step, no puppet branch.

Deliberately NOT replaced: the contextual boot screens that say something the
generic mark cannot — the Location Mini App's map pin with its sonar pings, the
Type Radar deck's card-stack skeleton, and the onboarding orb — plus the 16px
in-button spinners, where a butterfly is unreadable.

### Quiet Hours

23:00–09:00 Europe/Kyiv. Enforced inside the **re-engagement** and
**match-nudge** workers (deferred to next 13:00 / next allowed window).
Pinned status-banner edits and the proposal-countdown button re-render are
exempt (no notifications) — they only re-edit an existing message's markup.
(The match-nudge deadline heads-up IS a notification, so it stays under the
quiet-hours guard like the other nudges.)

### Standby / Starvation

`Profile.standbyCount` (canonical) + `missedWeeks` (legacy alias) increment
on every weekly batch where the user was eligible but unpaired, and also as
a compensating boost when the user accepted a proposal but the peer declined.
They reset to 0 on a successful pairing. `lastMissedAt` powers the "priority
boosted" UX ping. The matching score adds `starvationBonus(standbyCount)`
capped at 0.25 — strictly below the negative-constraint penalty so priority
breaks ties without forcing bad pairings.

### Embedding freshness (M-2)

Every code path that mutates `psychologicalSummary`, `partnerPreferences`,
`negativeConstraints`, or `hobbies` flips `Profile.embeddingDirty = true`, and
**every one of them then attempts an immediate user-scoped refresh with a
30-second deadline**; failure leaves the dirty marker intact and the user is
told that automatic synchronization will finish later. The
`embedding-refresh` cron (every 5 min, ≤20 rows/tick) remains the retry path.

**`negativeConstraints` only joined that rule on 2026-08-08 — until then it
marked dirty and walked away.** The flag is not a scheduling hint: eligibility
below is fail-closed on the *seeker's own* dirty flag, so between the write and
the next cron tick the user is withheld from matching entirely. Every other
writer closed that window; `appendNegativeConstraint` is the one that fires
seconds before the product may want to match the same person again, because it
is what records a **decline reason** — and the paid Rematch offer (§3.11) is
sent on exactly that path. A man who explained why he passed and then bought a
re-run inside the window was told the engine found nobody, and refunded, when
in truth it had refused to look. (The same window is what stopped the demo:
it pitches seconds after the reason is given, so it lost that race every time.)
A caller appending several constraints at once — post-date feedback — refreshes
once at the end rather than per line.
Before every weekly batch, matching takes and processes the complete dirty
snapshot without the cron's 20-row cap, logging only aggregate counts.
Eligibility requires `embeddingDirty = false`: a still-dirty profile is skipped
fail-closed, receives no stale match, and does not gain a false standby penalty.
The embedding write clears the flag only when `embeddingDirtyAt` still matches,
so a concurrent edit is retried rather than overwritten. Pre-M-2 the embedding silently went stale on
every profile edit, slowly degrading match quality. Initial embedding failures
during either AI-memory analysis or fallback-profile finalization also leave
the profile dirty, so the same worker retries them instead of silently
excluding an otherwise-complete user from matching.

### GDPR

- Account deletion (`/v1/me` `DELETE`, or admin) cascades through Prisma
  (`onDelete: Cascade` on every relation), **plus one store no cascade can
  reach: the grammY chat session** (`bot_sessions`, keyed by Telegram chat id
  with no relation to `users`; erased explicitly since 2026-08-08). It holds
  `pendingPhotos` — Telegram `file_id`s of the profile being erased — plus a
  buffered AI-memory paste and the current match id, so leaving it behind was
  not erasure. See ARCHITECTURE.md → `bot_sessions` for why a Telegram caller
  must also reset the live session. That erasure is **forward-only**, so the
  `retention` cron additionally sweeps sessions whose chat id matches no user
  and that nothing has touched for 7 days — the rows left by every deletion
  before the fix, and by any future path that removes a user without going
  through `deleteUserAccount`.
- Liveness-captured reference selfies are auto-deleted 90 days after `verifiedAt`
  (`selfie-retention` cron); the user stays `verified`, only the reference
  image is scrubbed.
- **Retention windows (added 2026-07-26, `retention` cron).** Four tables used
  to accumulate rows forever — nothing deleted from them and no cron touched
  them. Now: OTP challenges (`email_otps`, `phone_otps`) are deleted after
  **7 days**; refresh sessions (`user_sessions`) **30 days** after they became
  unusable; relayed proxy-chat messages (`proxy_messages`) after **90 days**;
  chat-timeline events (`chat_events`, §2.1) after **30 days**.
  Two of these are load-bearing rather than housekeeping:
  - `phone_otps` is keyed by NUMBER, not by user, because the phone funnel
    starts before a `User` row exists. A number belonging to someone who never
    finished signing up therefore has no row for the account-deletion cascade to
    reach, and was retained indefinitely. This sweep is the only thing that
    erases it.
  - The `user_sessions` window is pinned to `JWT_REFRESH_TTL` (30 d) **on
    purpose**: refresh-token reuse detection works by finding an already-revoked
    session by its hash and revoking the whole family, so deleting revoked rows
    earlier would silently downgrade that defence to "token not found". Raising
    `JWT_REFRESH_TTL` means raising this window with it.
  - The `proxy_messages` window is a moderation-policy choice, not a technical
    one — PRODUCT_SPEC names that log as the justification for the narrow
    carve-out to NO-IN-APP-CHAT. 90 days matches the reference-selfie window.
  - `chat_events` gets the shortest window of the five because it is the only
    one holding ordinary message text. It exists so the concierge can answer a
    follow-up against the message right above it — minutes, occasionally days —
    and the agent reads 12 events per turn, so a month is already far past
    anything it uses. Since 2026-07-31 it also covers onboarding (§2.1), so the
    30-day sweep is additionally what bounds the retention of a typed OTP code
    and of the ≤300-char AI-memory excerpt.
- `researchOptIn` is opt-in; default false. Audit is via `User.consentedAt`,
  `User.termsAcceptedAt`.

### Languages

`en` / `ru` / `uk` / `de` / `pl` (the `Language` enum and
`SUPPORTED_LANGUAGES`; `en` is the fallback). User-facing strings live in
`packages/shared/src/i18n.ts`, which aggregates `en`/`ru`/`uk` inline plus the
`de`/`pl` blocks from their own modules. Onboarding/menu/Aether agents
auto-detect the user's language and forbid English enum injection into
non-English replies.
# Venue Intent V2 (2026-07-21)

Venue negotiation is a two-step concierge flow on Telegram and iOS: departure
origin → free-text vibe → editable canonical chips → one explicit confirmation.
The initial venue is always selected automatically; users never browse a venue
catalog in this flow. Confirmed V2 intent is stored per participant and is the
only input to finalisation; ordinary Telegram messages cannot overwrite it and
the server never re-parses it at selection time.

On **Telegram** the whole two-step flow runs inside the Location Mini App (a
branded **liquid-glass** screen — `apps/webapp` `location.html` + `location.ts`,
theme-aware via the shared `theme.css` tokens), not as chat buttons: step 1 marks
the departure origin on the map, then the SAME Mini App advances to step 2 — a
free-text vibe field plus the editable canonical chips grouped as Experience /
Atmosphere / Format / Must-haves (selection is the bright "self" signal, not a
faint ✓) — and one in-app Confirm. Confirm runs the V2 finalizer; when the
partner hasn't confirmed yet the bot DMs the classic "waiting for the other
side" cue (`venueWaitingPeer`), and when both have, finalisation delivers the
scheduled confirmation. The Mini App uses the initData-authed
`/v1/location/venue-intent/{state,interpret,confirm}` routes. (A short-lived
2026-07 variant presented the chips as **inline Telegram buttons in chat**
(`handlers/matching/venue-intent-chat.ts`); it was reverted 2026-07-23 —
inline buttons cannot carry the brand's liquid-glass design or a comfortable
text field, and origin capture already required the Mini App, so there was
nothing left to keep in chat.) The **iOS** client keeps its own native chip
screen via `/v1/matches/:id/venue-intent` (OpenAPI contract unchanged).
Finalisation of a
live-mode match delivers the FULL shared scheduled confirmation — the date-card
PNG (§3.7a), the tappable `date_time` entity, the Maps/Change-venue keyboard, the
grounded venue blurb, and the founder feed (`services/scheduled-confirmation.ts`,
shared with the legacy concierge path) — never a bare "venue ready + link" text.

Experience IDs: `conversation`, `coffee_treats`, `meal_discovery`, `walk_view`,
`art_culture`, `drinks_evening`, `playful_activity`, `surprise_me`. Ambience IDs:
`quiet`, `cozy_public`, `lively`, `design_forward`, `scenic`,
`romantic_public`. Format IDs: `seated`, `walking`, `interactive`, `indoor`,
`outdoor`. These are soft preferences. The only hard constraints are the
**required setting** (indoor/outdoor) and the **commute relaxation**.

**Dietary, alcohol-free and step-free were retired 2026-07-30** (founder
decision) — removed from the Mini App's Must-haves group and neutralized
server-side by `applyInitialVenueConstraintPolicy`, so a cached bundle or an
older native client resolves to the same state (the `/v1/*` fields stay in the
shape, marked `deprecated`, exactly like `maxPrice`). They were enforced as hard
filters requiring **positive** evidence on the venue — "unknown" counted as a
refusal — while the curated catalog carried that evidence for **0 of 1207
rows**, because Google publishes none of it and no operator pass had marked any.
Every one of those seven chips was therefore a guaranteed `no_candidates`, and
the failure copy then named the user's own requirement as the thing to relax:
a wheelchair user was told to drop step-free access, someone keeping halal was
told to drop halal. `minimalRelaxation` no longer has those branches. The
product's position is that needs this specific belong to the person rather than
to the matchmaker: if the assigned venue doesn't suit them, they change it on
the §3.7b board, or the couple simply agrees to walk somewhere else. The
enforcement code in `satisfiesVenueHardConstraints` is left intact and goes
inert on empty/false input, so re-enabling any of them is a one-line change once
the catalog can actually back it.

**Museums are not offered at all (founder decision 2026-07-31).** `museum` is
listed in `EXCLUDED_VENUE_CATEGORIES` (`services/curated-venue.ts`), which both
surfaces filter on: the automatic first assignment never picks one, and the
§3.7b venue-change board never lists one. A museum is a poor default for a
first meeting — timed, ticketed, quiet in the wrong way, and closing early
enough to rule out most of the evening slot grid. The catalog rows stay
`active` rather than being deleted, so the category is re-enabled by removing
one entry from that list. This does **not** empty the `art_culture` experience:
that facet is also carried through `vibeTags` by book cafes, art bars and
historic streets (7 Kyiv venues at the time of the decision), which are
arguably the better first-date answer anyway.

The automatic first assignment has a separate server-owned baseline policy:
only quality-eligible `base` inventory is considered; commercial venues need
positive price evidence at `FREE`, `INEXPENSIVE` or `MODERATE`; `EXPENSIVE`,
`VERY_EXPENSIVE`, `premium` and `exclusive` candidates are excluded before
ranking. Public parks may have no commercial price. (`museum` also sits outside
`PRICE_EVIDENCE_REQUIRED` — Google reports no `priceLevel` for museums at all —
but that is now moot while the category is excluded outright.) This is
not written as a participant preference and the initial clients show no price
chips. Price/exclusivity choice belongs to the post-assignment Venue Change.

Incompatible preferences use a deterministic bridge lane and max-min pair fit;
they never silently collapse to café. Every assigned V2 venue must be a real,
operational, open-at-slot public place with provenance, stable place/curated ID,
actual coordinates and Maps URI. Unknown evidence fails hard constraints and
unknown hours fail closed. If no candidate satisfies the pair, the match stays
`negotiating_venue` and the concierge identifies one constraint to relax. A
provider outage uses an eligible curated venue or durable 1/5/15-minute retries;
it never schedules a placeholder. The paid post-assignment Venue Change remains
unchanged.

Post-date feedback records `yes | partly | no` for whether the venue matched
the confirmed vibe, with optional structured reason chips. Only positive or
unrated historical intents can become future smart suggestions; historical
hard constraints are never reactivated.

Release is controlled by `VENUE_INTENT_V2_ENABLED`, deterministic live rollout
percentage and independent shadow percentage. Shadow ranking writes only the
append-only structured selection log and cannot mutate a match or notify users.
