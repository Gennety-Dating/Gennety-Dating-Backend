<!-- WHEN_TO_READ: You are touching a concern that spans every flow: the loading/success marks, quiet hours, standby/starvation, embedding freshness, GDPR, or languages. -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 7328-7583) — migrated 2026-09-01 -->

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

### The success mark: the butterfly spins away, the tick draws (2026-08-17)

Every Mini App success screen renders one shared mark
(`apps/webapp/src/butterfly-success.ts` + `.css`), and it is one gesture in four
parts: the brand logo sits **still** at full size, winds back to the right, then
spins **left with acceleration**, shrinking as it turns until it is a point — and
the checkmark draws itself in the space it vacated. The resting frame is a plain
bold tick and nothing else.

It is the fourth version of this mark, and all four have argued about one thing:
whether the frame people look at longest should carry the logo or the outcome.
Two versions put a butterfly ON a tick, one removed the tick entirely, and this
one removes the butterfly instead. The founder's brief was "more minimal and
classic", with the spin as the route to it.

**What the earlier finding was, and why this does not re-break it.** The
butterfly-only version (2026-08-15) was arrived at by measuring the one before
it: a butterfly flying ALONG the tick's path rendered **29 x 29 px**, and the
logo is an abstract four-lobe shape with no body, head or antennae, so at that
size it was a pink smudge. "The branded moment is the MOTION" failed on its own
terms, because the moving object was never recognisable. That finding stands.
This mark does not contradict it: the butterfly is never small while it is meant
to be READ. It holds still at 143px, and shrinking is what makes it LEAVE rather
than what it does while performing.

**What is knowingly given up:** the resting frame is a generic checkmark carrying
no brand. That cost was named before this was built and accepted (DECISIONS.md).
It also means the mark says "done" on its own again — so, unlike the
butterfly-only version, a surface rendering it with neither a `label` nor a
heading is merely quiet rather than meaningless. The accessible name still
matters: the drawing is `aria-hidden`, so a mark with no caption needs
`ariaLabel` or the success is announced to nobody.

Six decisions are load-bearing rather than styling:

- **The acceleration lives in keyframe SPACING, not in an easing function.** The
  animation runs `linear` and each equal slice of time covers more degrees
  (roughly `u^2.4` of the sweep), because the gesture reverses direction: a
  single eased rotation cannot swing right and then away to the left. A test
  walks the stops and fails if any slice is not faster than the one before.
- **One animation drives the whole butterfly.** Wind-up, spin and shrink layered
  as three declarations would all write `transform`, and that property is not
  composited — the last declaration simply wins and the other two vanish.
- **The frame is SQUARE, and sized to the widest turning frame rather than to
  the peak scale.** A rotating rectangle reaches `(w + h) / 2√2 = 53.8` units
  from its centre at 45°, far past the 44.3 it occupies upright, so the old
  104 x 76 viewBox would have sheared a wing on the first quarter-turn. The test
  samples the INTERPOLATION between keyframes, not just the stops: the widest
  frame of this animation falls between two of them. Measured on the real render
  at 4.3px of clearance at its worst, at t=460ms.
- **The tick starts 80ms BEFORE the butterfly is gone.** Queued back to back it
  reads as two animations; overlapped it reads as one thing becoming another.
  Both live in ONE `<svg>` so the point the butterfly shrinks into and the point
  the stroke grows from share a coordinate space by construction.
- **The tick's burgundy is lifted on the dark page** (`--accent-bright`) and is
  the plain accent on cream — the same correction the date card makes, and here
  it was settled by rendering all three candidates rather than by eye: at
  `#8b253b` the tick visibly sinks into the near-black background.
- **The tick alone takes its colour from CSS**, while everything else is painted
  from attributes. Giving it a hardcoded `stroke` as a late-stylesheet floor
  would be worse than not: without CSS there is no dash geometry either, so the
  fallback would flash a COMPLETE tick and then rewind it. Unstroked-until-styled
  is the right failure — invisible for a frame, never wrong.

The mark's timing is exported rather than hand-tuned per screen:
`SUCCESS_ARRIVE_MS` (1180) is when the tick finishes and the haptic fires,
`SUCCESS_TOTAL_MS` (1300) is when the bloom and caption come to rest, and the two
self-dismissing screens derive their close from it plus `SUCCESS_READ_MS`. That
is ~600ms longer than the butterfly-only mark and close to the drawn-tick era's
1200ms, so those screens are back to roughly the budget they were built around —
but it is real added time in the onboarding funnel, and a test pins the ceiling.
The bloom and the caption are deliberately held back until the tick is arriving:
they used to rise with the mark's entrance, and here the entrance is a butterfly
that is about to leave, so a caption reading "verified" over it gives the ending
away before the gesture has made it.

Under `prefers-reduced-motion` the mark is drawn already finished — the tick
complete, the bloom at rest, no butterfly and no spin — and the whole thing does
one short fade, so the success still ARRIVES rather than appearing to have always
been there. That falls out of the base states rather than being restated: the CSS
base values ARE the final ones, so killing the animations is the whole rule, and
the media query says nothing but `animation: none`.

The two brand marks stay deliberate siblings and deliberately different pictures.
The loader is three small butterflies flying INSIDE a waist — nerves, the feeling
before. This one is the butterfly leaving and the answer landing. Both read their
silhouette and gradient from `brand-butterfly.ts`.

Deliberately NOT converted, and each for a reason: the calendar's `waiting`
screen keeps its own saved-tick (it means "your picks are saved", not "the date
is locked in", and giving both the celebratory mark would make the two states
look identical); the venue-change `renderSuccess` medallion, whose glyph answers
"what happened" rather than "you succeeded"; selection and progress ticks; and
`PartnerPaidCard`'s "PAID" rubber stamp, which is a different idiom.

Telegram-only: the native iOS client draws its own success states and no `/v1/*`
shape changed. Demo mode (DEMO_MODE.md) builds the same bundle and inherits it —
no gate, no paid step, no puppet branch.

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
  chat-timeline events (`chat_events`, §2.1) after **30 days**; client funnel
  events (`client_events`, iOS 6.2) after **90 days**.
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
  - `client_events` is swept by **`receivedAt`, not `occurredAt`** — the second
    is the device clock, so a phone with a wrong date would otherwise either
    outlive the window or be erased on the day it was received. Its 90 days are
    a **promise, not a technical figure**: that is the number the iOS privacy
    manifest and the App Privacy questionnaire state, and the sweep exists so
    the statement is true. Rows belonging to a signed-in person also leave
    earlier, by cascade on account deletion; the window covers what a cascade
    cannot reach — events recorded before an account existed at all.
- `researchOptIn` is opt-in; default false. Audit is via `User.consentedAt`,
  `User.termsAcceptedAt`.

### Languages

`en` / `ru` / `uk` / `de` / `pl` (the `Language` enum and
`SUPPORTED_LANGUAGES`; `en` is the fallback). User-facing strings live in
`packages/shared/src/i18n.ts`, which aggregates `en`/`ru`/`uk` inline plus the
`de`/`pl` blocks from their own modules. Onboarding/menu/chat agents
auto-detect the user's language and forbid English enum injection into
non-English replies.
