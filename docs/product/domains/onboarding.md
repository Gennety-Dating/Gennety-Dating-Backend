<!-- WHEN_TO_READ: You are changing onboarding: consent, language, conversational profile capture, the voice prompt, identity verification, the re-engagement chain, or the Profiler (Phase 1 and Phase 1b). -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 122-2308) — migrated 2026-09-01 -->

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
  city (a **launched market** to continue — Kyiv today; any other catalog city
  ends registration on the waitlist screen, see §1.3 — mirrored to the client as
  `cityCatalog` / `cityWaitlist` in `/state`), a **light/dark theme picker** (right after the city gate, before the
  visual intro; default `dark`, changeable later in Settings — `POST /theme`
  records it), the **six profile screens** (name / age / gender / who you're
  looking for / height / what you're looking for — §1.3), and the final AI
  memory export choice, using
  Telegram `initData` HMAC auth for all writes (`POST /track` persists the
  re-choosable fork pick).
- **The Mini App collects the first six profile facts itself (2026-08-05; the
  sixth added 2026-08-24).**
  Name, age, gender, preference, height and relationship intent each have ONE
  correct answer out of a
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
  that part was always right. **The rise itself was not (fixed 2026-08-18).**
  That correction claimed the shrink easing was "smoothed rather than stepped",
  and it was neither: measured on the real render at a 336px keyboard, the pill
  covered **115px of its 336px travel in ONE 60Hz frame** — a third of the way
  in 16ms, then a crawl through the last 7% over the following 80ms. The cause
  is arithmetic rather than taste: `cubic-bezier(0.22, 1, 0.36, 1)` leaves at
  **4.55x its own average speed** (its initial slope is `y1 / x1` = 1 / 0.22),
  so the screen was always going to jump and then dawdle, in both directions —
  which is exactly how it was reported. The shrink now runs on one shared token
  (`--kb-ease`, `cubic-bezier(0.42, 0, 0.58, 1)` over 260ms): it starts at rest,
  accelerates, decelerates to rest — the shape the keyboard itself moves in —
  over about the time iOS spends animating it, so the pill travels WITH the
  keyboard rather than after it. Measured again on the same render: worst frame
  **38px (11.3%)**, three times gentler, and the guard is a curve test rather
  than a screenshot (`keyboard-ease.test.ts`).
  **It is one token because it is one keyboard.** The name screen, the
  gate cards (email / phone / city) and the city result list all shrink by the
  same `--kb-height`, and before this they eased three different ways — the
  gates at `200ms ease`, the profile screens at the 4.55x curve, and the result
  list not at all, so it snapped a frame before the card around it settled. A
  screen that made room differently from the gate one step earlier read as two
  different keyboards.
  **And only the screen with a field makes room at all (2026-08-20).** The
  shrink sat on the frame all five profile screens share, so whichever screen
  came next inherited whatever was left of the keyboard and finished the motion
  after the cut. That was invisible until the curve changed, and the arithmetic
  is why: the keyboard does not LEAVE in one step — iOS ramps `visualViewport`
  down over ~250ms, `--kb-height` therefore arrives as a stream of small
  writes, and a CSS transition **restarts on every one of them**. The old
  easeOut left at 4.55x its average speed, so each restart nearly caught its
  target and the rendered height tracked the ramp — 43px of the 336 still owed
  at the moment the keyboard was gone. `--kb-ease` starts at REST, so every
  restart cancels itself inside its own slow launch and the height barely moves
  for the whole ramp: **315px still owed at that same moment**, and a 250ms
  tail after the last write against 133ms. By then the next screen is usually
  mounted — the save is one round trip — and it was inheriting two thirds of a
  keyboard. Measured on the age screen at 375×812: the readout and the slider
  arrived **165px** high, the pill **331px** high, and the top-anchored title
  did not move at all. Three elements, three speeds, on a screen that has no
  keyboard and never will. The four keyboard-less screens (age, gender,
  preference, height) now sit at full height always, so the keyboard simply
  slides off and reveals a screen that is already in its final position, which
  is what a native app does. Nothing about `--kb-ease` changes: it is right for
  the screen that owns the field, and that is now the only screen it reaches
  (`keyboard-ease.test.ts` holds the scoping as well as the curve). The native
  iOS client already had purpose-built controls here via the `ui_hint`
  contract; this is Telegram catching up, and the `/v1/*` surface is untouched.
  **And the room is made against the SHELL, not against `window.innerHeight`
  (2026-08-22).** Everything above describes how much the screen shrinks; this
  is what it shrinks *from*, and getting it wrong made the name screen collapse
  into the top third — the field and its pill stacked under the header with a
  hand's width of dead black above the keyboard. Clients disagree about how a
  keyboard arrives: it FLOATS over an untouched layout viewport (iOS Safari's
  own behaviour), or the WebView is RESIZED for it (what Telegram's client
  does), and in the second case `100dvh` — and the shell below it — has
  **already** made room, so there is nothing left to reserve. `--kb-height` was
  measured against `window.innerHeight` and recomputed only when
  `visualViewport` fired, so on that path a full keyboard's worth of
  reservation was banked from the first event and then spent a second time on
  an already-shrunk screen. Measured on the reported render (393x852, a 298px
  keyboard): the screen came out **235px tall inside the 554px above the
  keyboard**, one keyboard short of the room it had. It is measured against the
  shell's own live height now — the element `calc(100% - var(--kb-height))`
  actually resolves against — so a layout viewport that has already shrunk
  shrinks the reference with it and the inset falls to zero on its own, with no
  branch on which kind of client this is. The shell is observed
  (`ResizeObserver`) as well as the viewport, because its box can change
  without `visualViewport` moving at all, which is the whole reason a stale
  value could survive. Reproduced and fixed on a real render rather than
  reasoned about: same probe, same page — old code 388px of the 554 available,
  new code 554px, and the floating case unchanged at 554 in both
  (`keyboard-viewport.ts`, `keyboard-viewport.test.ts`). The same correction
  reaches the email / phone / city gate cards, which subtract the same value.
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
  **Before either of them, the SHELL paints the syncing orb (2026-08-29).**
  The mascot is a module of a ~124 KB bundle, so it structurally cannot be the
  first frame — and the document's body was `<div id="root"></div>` and nothing
  else, so nothing else could be either. Measured on production over a 4G
  profile: first paint at **968 ms** was the background colour alone, and the
  first content arrived at **1256 ms**. That blank stretch after tapping *Open
  Gennety* is what the founder reported as the Mini App having frozen, and it is
  the one part of this screen nobody had ever looked at, because every
  measurement of the mascot starts from the moment it mounts.

  What the shell draws is **the app's own syncing orb, not a new shimmer**
  (founder decision): the same mark, the same breath, so React arriving replaces
  it with a copy of itself and the handover is invisible. Its styles are inline
  rather than in `onboarding.css`, which is a module import and would therefore
  arrive with the very bundle the orb exists to beat — the same reason
  `verification.html` inlines its own mark. It carries **no text**: the language
  is not known until `/state` answers, and the wrong language is worse than
  none. So it reserves 72 px where the heading and lead will be (36 + 12 + 24),
  because `.orb-wrap` centres the whole block rather than the orb, and without
  that reservation the orb would sit ~52 px lower before React than after it.
  A copy that drifts from `.loading-orb` turns the handover into a visible swap,
  which is what `onboarding-boot.test.ts` exists to prevent.

  **And the boot stops carrying a megabyte of icons.** This shell requested the
  full variable Material Symbols face — **1,127,204 bytes**, 3.8 s of the boot on
  that same profile — to draw **three** glyphs, and it is the only one of the
  Mini App's shells that asked for it at all. `font-variation-settings` appears
  nowhere and the CSS pins `font-weight: normal`, so the axes were never read.
  Subsetted to the three names it uses it is **2,260 bytes**. The cost is stated
  rather than discovered later: **an icon added to this screen must be added to
  `icon_names`**, or it renders as its own name in a fallback face — a silent
  failure, and the reason that list is held equal to the glyphs the code
  actually uses by a test. Two smaller things ride along: the Telegram SDK is
  `defer`red so the parser can reach the body at all, and the two font
  stylesheets stop blocking the first frame (they already carried
  `display=swap`, so text has always rendered in a fallback face until they
  land; at boot the orb has no text to flash). The three local stylesheets Vite
  injects stay blocking on purpose — same-origin, and asyncing them would buy
  ~150 ms at the price of a FOUC on the registration funnel.

  **The Mini App boots behind a mascot, not a spinner (2026-08-23).** The
  loading screen for the very first `/state` call is the Gennety butterfly with
  eyes and round white hands, shuffling through profile cards with its back
  turned —
  the loading indicator IS a picture of what the server is doing. When state
  arrives it notices it is being watched, turns, peers, rocks back, winks, and
  then **pulls the screen aside like a curtain**, revealing the first real
  screen underneath. The hand and the curtain edge read the same number, so the
  transition is one continuous motion rather than a cut, and the screen behind
  is already settled: the phase is set the instant `/state` resolves, so its
  ordinary 420 ms scene transition plays underneath the still-opaque mascot.

  **The full greeting plays ONCE per user** (founder decision), marked in
  DeviceStorage (`gennety.onboarding.welcomed`). Every later launch still gets
  the shuffling loop as its loading state and then simply fades — a 4.7 s
  performance on every resume would be charm the first time and a toll the
  fourth. Three conditions gate it (`shouldPlayWelcome`), and the third is the
  one a marker alone cannot express: the boot phase must be the **very start**
  of registration. Someone reinstalling halfway through has no marker and is
  not a new user, and a first-meeting greeting at the city gate reads as the app
  having forgotten them.

  **A tap skips it**, from the moment the greeting starts; during the loop a tap
  is deliberately inert, because there is nothing to skip to — the app is still
  loading. **Under `prefers-reduced-motion` the mascot is not mounted at all**
  and the ordinary loading screen shows instead: there is no reduced variant of
  a character performance, and the same rule the onboarding tap-burst follows.
  The syncing screen it covers is also the **error surface** — a boot failure
  fades the mascot out rather than leaving a cheerful loop over a message
  explaining that nothing is happening.

  **It is the product's first per-frame animation, and that is deliberate**
  (`apps/webapp/src/mascot-welcome.ts`). The loading and success marks are pure
  CSS keyframes and that remains the house rule; three properties here cannot be
  keyframes at all. The arm is a quadratic band that thins as it stretches, and
  the hand takes its tangent at the wrist. The hands grab REAL cards — each
  flies to where a specific card will be at the moment of contact, pulls it out
  of the stream and puts it back where the stream has got to by then — so the
  target is solved per frame against a stream that has its own clock. And the
  hands are anchored in the body's coordinate space and sample it ~60 ms late,
  which is what gives the rock-back its whip. Everything that can be a curve
  still is: the module evaluates real `cubic-bezier()`, so its easings are the
  ones a stylesheet would have.

  **The stream is a stack, and it dissolves at both ends (2026-08-26).** Three
  separate reports about the same screen, and the third is the one worth
  keeping. The loading loop was **too short** — it held for one `CYC` plus a
  little, which showed three examinations, and "he is working THROUGH profiles"
  is a plural claim; it is four seconds now, measured at six examinations across
  five distinct cards rather than asserted. The stream was **too thin** — nine
  cards over the travel left about six on stage at once, so it read as a
  trickle; sixteen puts about thirteen there, carrying the same depth
  correlation (smaller is fainter) so it stays a stream with depth rather than a
  flat scatter.

  And a card **appeared from nowhere and was cut in half on the way out**, which
  is the interesting one because it is invisible on the product's own surface.
  The SVG is fitted with `meet`, so at a phone's aspect it exactly fills the
  width: the whole of a card's life outside the viewBox happens off-screen, and
  a card entering and leaving at the screen edge is as natural as walking out of
  frame. In a browser the same fitting leaves letterbox either side, `.mw-svg`
  is `overflow: visible`, and the spawn point lands inside the window — so the
  seam is a *browser* artifact, which is exactly how it was reported ("я не
  знаю, как действительно это происходит на телефоне, но в веб-версии в браузере
  мне это не нравится").

  So **the two fade ramps ARE the off-viewBox margins**, and that is the whole
  design rather than a tuning: on a phone they sit entirely off-screen and
  nothing about the stream changes, while in a browser they are precisely the
  stretch that was showing the seam. They are deliberately different widths —
  the left runs from the spawn point to the stage edge, the right from the stage
  edge to the curtain clip — because the margins are, and matching them would
  mean either spawning further out or dissolving a card while it is still
  mid-screen on a phone. The right ramp reaches zero exactly at the clip, so
  there is nothing left to guillotine; the two numbers are one constant, not two
  that can drift. Both are **eased rather than linear**, the rule the gender
  screen's photo fade already states: a two-stop linear alpha ramp has a visible
  kink where it begins, and the eye reads that line as the edge of the thing
  being faded — the very seam this removes.

  **He is turned away, so his back occludes the card (2026-08-26).** The card he
  holds up was painted in FRONT of him, on the stated reasoning that "a card he
  is holding up to look at has to be in front of him". That is true of someone
  facing us and false of him: he has his back turned, so a card held up to read
  is between him and whatever he is facing, which is away from the camera.
  Drawn in front it slid across his own silhouette in **20% of held frames**,
  covering up to **40% of the card with himself** — reported as the cards
  "showing through him", and the measurement is what turned a vague oddness into
  one wrong line of paint order.

  Two orderings carry it and neither is arbitrary. **The body is over the
  card**; and **the arms stay under it**, untouched, because the bottom-outer
  grip exists so the arm runs along the card's lower edge and reads end to end
  — pushing the card behind the arms would trade one occlusion complaint for
  another. The other half is that it never hides what he is actually *reading*:
  at full examine the card sits clear of the silhouette (0% covered on average,
  8% at worst), so the body only ever occludes it on the way out and on the way
  back, which is the read — he draws one from the pile behind him, holds it out
  where it can be seen, and puts it back. Moving it also removed a jump nobody
  had reported: the stream is behind him too, so grabbing and releasing no
  longer flips a card from one side of him to the other.

  **A grab is a whole gesture, not a tap (2026-08-26).** The first version ran
  one every 190 ms and never took a card out of the stream: a hand flew to a
  card and rode it along. On screen that reads as clicking at the cards rather
  than looking at them, which is exactly how it came back (founder). A cycle is
  1.4 s now — reach, close, lift OUT, hold still while the rest keep flowing,
  put back, release — with the card following the HAND for the middle three
  rather than the other way round, and the two hands running at a deliberately
  un-round phase offset so part of the time he holds one card in each and the
  rhythm never reads as a metronome.

  Three properties of the pose are load-bearing, and each was found on a render
  rather than reasoned about. **The card is put back where the STREAM has got
  to**, never where it was taken from — the gap is the read. **It converges on a
  fixed size** rather than a multiple of its own: the deck's own scales run
  0.74–1.05, so a multiple made some examined cards smaller than their
  neighbours. And **the hand grips the outer BOTTOM corner** once the card is
  out, which is not framing: the shoulder sits inside the body and the hand
  beyond the card, so a top grip runs the whole arm behind a card drawn on top
  of it and the hand goes back to reading as a floating disc — the very
  complaint the burgundy arm was introduced to answer. From below, the arm runs
  along the card's bottom edge and is visible end to end. The arm's bow flips
  with the lift for the same reason.

  **What reads as "too fast" is usually one frame of jump, not the length of the
  move.** The turn was reported as a snap twice. Stretching it (80 → 300 ms in)
  was not enough on its own: measured per 60 Hz frame it still moved **30% of
  the whole swing in a single frame** at the crossing, because the squeeze ended
  fast and the recovery began at 3.09× its own average, so the two halves met at
  full speed. Both are on the rest-to-rest curve now — the same shape and the
  same measurement as the keyboard easing (§1.1 → `--kb-ease`) — which halves
  that to 17% at the original durations and reaches 13% at 360/220 ms. A test
  walks the real curve and fails past 20%, and a second one asserts he still
  goes edge-on, because the cheap way to pass the first is to stop turning.

  **The hand is a circle, and that is what removed a whole class of defect
  (founder decision 2026-08-23).** It was a five-digit glove — cuff, four
  two-segment fingers, a palm painted last to bury their roots — and it had to
  answer a question a circle does not have: which way the palm faces. Every
  frame where that came out even slightly wrong read as a sticker dragged
  across the screen, which is exactly how it was reported. The tangent survives
  and now only aims the hand's squash, so being wrong about it is no longer
  expressible. Three things carry the weight the fingers used to:

  - **The arm reads on its own.** With no large glove to carry the limb's
    shape, the band is mid-burgundy rather than the darkest stop, which sat ~2%
    off the dark page and left the hands looking like floating dots; it is also
    near-uniform in width now, because the strong taper existed to meet a wide
    palm.
  - **A grip is a squash, capped at 15%.** It is the only thing left that says
    "this is holding something", and past ~20% a circle stops reading as a hand
    and starts reading as a bouncing ball.
  - **The hand takes a card by its near TOP CORNER, never its centre.** It
    renders ~24 stage units across against a card ~18 wide, so a centred hand
    simply covers the card; the corner leaves most of it visible. The old glove
    could sit centred because its fingers closed *around* the card — a circle
    has to solve the same problem with placement. For the same reason the
    resting hands were pushed out and down: a disc parked where the glove used
    to sit read as a hole in the lower wing.

  **The body carries the CORRECTED logo and the shipped logo is untouched.**
  The mascot converges the two lower wings on a single point; every product
  surface keeps the 4-unit horizontal bar between them (founder decision
  2026-08-23, DECISIONS.md). The corrected geometry has one home for comparison
  at `apps/bot/src/assets/brand/butterfly-logo-v2.svg`, which nothing imports.
  So the product now draws two slightly different butterflies, knowingly, until
  that decision is taken.

  Telegram-only: the native client owns its own launch screen. Demo mode builds
  the same bundle and inherits this for free — no gate, no paid step, no puppet
  branch.

  **The intro is three scenes, and the six that argued about the market are
  gone (founder decision 2026-08-20, DECISIONS.md).** What plays now is Pivot
  ("dating should lead to a meeting, not to a chat log" → "so we built
  Gennety", with the brand mark rising as the line lands), Matchmaker ("you get
  a personal AI matchmaker…"), then the tap-paced How-it-works — about **15
  seconds** of auto-advancing copy against the ~50 seconds it replaces
  (measured, not estimated: scene boundaries at ~7.7s and ~15.2s).
  Deleted with them: the competitor-icon rise and its tile-by-tile crumble, the
  "what does a relationship cost in 2026" screen and its falling banknotes, the
  statistics drum, the "only 3% reach a date" line, and the swipe simulator —
  along with `onboarding-crumble.ts`, `onboarding-money.ts`, `seeded-noise.ts`
  and the three competitor PNGs. **Deleted rather than flagged off**, by the
  rule this file already applies to the dropped preference design: a decision
  that is made stops being a configuration, and the alternative lives in git
  history.
  The reasoning is about WHO is watching. Someone who has pressed Start has
  already decided to try; arguing that the old apps are bad is advertising's
  job, and it is finished before the install. It was also being argued to the
  wrong people at the wrong moment — the intro plays AFTER the contact gate
  (§1.1 order: language → consent → phone/email → city → theme → intro), so the
  film was shown to users who had already handed over a phone number, while the
  58% who leave before touching anything never heard a word about the product.
  Two smaller things ride along. The intro no longer opens on "we see these
  problems", a line that referred to problems no screen states any more. And
  How-it-works stops promising an import of ChatGPT memory: that branch is
  behind `AI_MEMORY_EXPORT_ENABLED`, off in production since 2026-07-26, so the
  screen was making a promise the flow never keeps — a guard now holds the copy
  ChatGPT-free until re-enabling the feature earns the sentence back.
  **The intro's position in the flow is deliberately unchanged.** Moving the
  hook ahead of the gates is a separate decision the founder has not taken; the
  three surviving scenes still play where the nine did.
  One consequence to hold onto: a visual-progress value stored before this cut
  is on the old nine-scene scale and is read on the new one, which is
  **deliberately not migrated** (`onboarding-route.ts` states the arithmetic).
  An old value ≥ 3 skips the intro instead of resuming a scene that no longer
  exists; 0–2 lands on the three that survived. Nobody in production is in that
  state, and the cost of being wrong is one explainer not shown, never a broken
  screen.
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
  **The gender screen shows two people rather than two rows (2026-08-20,
  reworked to photographs 2026-08-22).** It was two stacked rows carrying two
  words — the plainest control in the set, on the one question in it that is
  about who you ARE. It is now two heavily rounded 3:4 buttons side by side,
  each carrying a background-removed **photograph** over the button's own
  burgundy/blue gradient, with the label at the bottom. Same collector write,
  same burst, same tones: this is the control changing, not the question.

  **Photographs rather than illustration, and that is a consistency decision
  rather than a taste one** (founder, 2026-08-22). A drawn pair shipped here
  first. The screen one step later — "who do you want to meet?" — is
  photographs, so an illustrated fork followed by a photographic one read as a
  seam between two products rather than as two steps of one flow.

  **The portraits are monochrome at rest and bloom into colour on the tap**
  (founder decision) — a warm print, not a flat `grayscale(1)`, which reads as
  a photograph that failed to load. So until the user chooses, every saturated
  pixel on the screen belongs to the two buttons, and the colour of a person is
  the reward for choosing rather than decoration. Same rule the loading mark
  states from the other side: structure stays neutral, colour is spent only on
  what carries meaning. Under `prefers-reduced-motion` the colour is simply
  always there — the neutral state exists only as the setup for the reveal, so
  without the reveal it would be a desaturated picture for no reason.

  **Because the same tap also ends the screen, the advance is floored**
  (`GENDER_ADVANCE_HOLD_MS`, 600 ms): otherwise the bloom is cut off wherever
  the save happened to return, which is the failure the whole idea dies of. The
  hold starts BEFORE the request rather than after it, so the two run in
  parallel and a tap costs `max(request, hold)` rather than their sum. It is
  still real time added to the onboarding funnel for every user, so it is a
  named constant with a stated ceiling a test enforces — the same treatment the
  success mark's timings get, and for the same reason: a number like this
  otherwise creeps one retune at a time.

  **The shipped artwork is not a crop of its source, and could not be.** Each
  figure is PLACED into a canvas the shape of the button by measured landmarks
  (`prepare.mjs`, outside the repo). The arithmetic is worth keeping, because it
  is what rules out the obvious approach: at `object-fit: cover` in a 3:4 box the
  visible source height is 0.75x the visible width, so fitting a head that
  occupies the top 60% of a 9:16 photograph needs at least 80% of that
  photograph's width — and the camera in the woman's raised hand starts at 82%
  of it. Every crop that cleared the camera cut her chin; every crop that kept
  her chin kept a slice of camera. Placing by landmarks separates the two
  questions, so dropping the camera column stops being coupled to where the face
  sits.

  **Each photograph dissolves into the button's gradient on three sides**
  (founder decision 2026-08-22) — the handover from person to colour, and what
  leaves the label on clean colour rather than needing a scrim over it. Three
  rather than one: the bottom fade alone still let the shoulders run straight
  into the button's edge and stop there, which reads as a cut-out pasted on
  instead of someone standing inside the frame. The top is deliberately left
  alone — the head has its own headroom, so there is no edge there to soften,
  and fading a crown looks like a mistake.

  Two properties of that fade are load-bearing rather than styling. It is
  **eased, not linear**: a two-stop linear alpha ramp has a visible kink where
  it begins, and the eye reads that line as the edge of the photograph — the
  exact thing being removed. And the bottom ramp **begins BELOW the chin**, held
  there by a test against the placement constant, because the fade and the
  artwork live in different files (the prep script is outside the repo) and
  nothing else stops the fade from being moved back up and quietly eating a
  face. Telegram-only; the native iOS client owns its own controls here.

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
  **The screen arrives finished: the photographs are fetched three screens
  earlier (2026-08-13).** Twelve photographs (~530 kB) were created at the
  instant the screen mounted, so the user watched the composition assemble
  itself — a few prints landing, dark tiles where the rest would be, the last
  one about half a second later. `warmPreferencePhotos` now starts the fetch AND
  the `decode()` when the profile screens BEGIN, so the download happens while
  the user is typing a name and the bitmaps are in hand by the time the screen
  appears. Measured rather than assumed: on the name screen all twelve are
  already requested. `decode()` is what matters, not `img.src =` — the latter
  only starts the fetch. It is skipped for someone resumed PAST the screen, who would
  otherwise pay half a megabyte for a picture they are never shown.
  **A gate is the insurance, and it spans the whole screen rather than a
  column.** Someone resumed straight onto this screen gets no head start, so the
  scatter is held back until every photograph on BOTH sides is decoded and then
  fades in together (~260 ms). Per photo would be the same progressive assembly
  with softer edges; per column would populate one half of the screen and then
  the other, which is the same complaint one step smaller. What shows in the
  meantime is not a hole — it is the two gradient columns carrying their labels,
  i.e. a finished-looking button — and in the warm case the reveal lands a frame
  or two after mount, inside the scene's own 420 ms crossfade, so it is never
  seen at all. The gate reads `decode()` through a ref rather than `onLoad`,
  because a photograph already warmed can be decoded before React attaches a
  listener and `onLoad` would then never fire — which would leave the screen
  bare until the cap in exactly the case the warm-up was meant to make instant.
  A failed decode settles the gate too, and a `PREF_REVEAL_CAP_MS` (2.6 s) cap
  bounds a request that neither answers nor errors: past it the layer is shown
  and whatever is still in flight pops in as it always did. Telegram-only; the
  native iOS client owns its own controls here. Demo mode builds the same
  bundle, so it inherits this for free — no gate, no paid step, no puppet
  branch.
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
- **The last screen asks the one question about the FUTURE (2026-08-24).**
  "What are you looking for?" — four rows on a single ordered axis: `spark`
  (a bright story) → `open` (see where it goes) → `falling` (fall for someone)
  → `longterm` (something long-term). Deliberately ONE axis rather than a set of
  labels: the other two dimensions people reach for here are already measured
  (tempo and process-vs-person are the vibe axes, §3.2), and the ones usually
  bundled with the question — children, marriage — belong to a different
  product, since this one's horizon is one date on Thursday. Four points and not
  three or six: at three the middle swallows everyone who is unsure, and past
  four people stop distinguishing neighbours, so the answer becomes noise.

  **SEVERAL may be picked (founder decision 2026-08-26), and that is a better
  question rather than a looser one.** Plenty of people want a bright story AND
  would go somewhere serious if it turned out that way; forcing one point makes
  them guess which half to declare. The scoring survives it because the answer
  becomes a SET and the distance between two people is the **smallest** gap
  between their sets, so the factor fires only where both sides are specific
  and opposed — exactly where it should. Three consequences follow, and the
  second is the reason no cap was needed:

  - A broad answer scores 1.0 against nearly everyone, i.e. it reads as *do not
    filter me on this*, which is what someone unsure is actually saying.
  - Selecting all four is arithmetically identical to not answering, so
    "everything" costs the user nothing and buys them nothing; a limit would
    only stop people from saying something true.
  - The cost is stated rather than discovered later: if most people pick three
    or four the axis goes quiet. That makes **how many** were picked as worth
    watching as which ones, and it is the trigger for revisiting the floor.

  **Four options in ONE tone, and `spark` leads.** Everywhere else in this set a
  colour separates options that genuinely differ; here it would rank them, and
  the axis only measures anything while no answer looks like the respectable
  one. The wording is a product invariant rather than styling: the moment
  `spark` reads as "I'm not serious", social desirability drags the population
  rightward and the axis stops measuring. That is also why the product's own
  philosophy is the first tile rather than a footnote after the respectable
  answers — the positioning is never argued on this screen, it is simply made
  an equal answer.

  **A 2×2 grid of photographs, not four rows of text (2026-08-26).** This is the
  one question in the set that is about a FUTURE rather than a fact, and four
  words cannot show one — so each option carries a photograph of what it looks
  like. The grid is forced rather than chosen: the frames are 9:16, and a
  full-width row is roughly 2.7:1 at 390px, which leaves a horizontal ribbon
  with the heads cropped off. A 3:4 tile loses WIDTH instead, which these
  photographs have to spare. The label sits on its own scrim at the foot of the
  tile, because on an unselected tile the ground is a photograph rather than a
  colour.

  **Tapping shrinks the photograph inside a burgundy frame, and the option's
  other photographs then play behind it** (founder decision 2026-08-26). The
  picture insets by 7px, what shows in the gap is the tile's own accent ground
  lit by the house inner-edge sheen, a small white check lands on the top-left
  corner, and from then on the tile advances through that option's remaining
  frames every two seconds. Six properties are load-bearing:

  - **The frame is the tile's own background, not an extra element**, so it can
    never be a hair out of register with the picture it surrounds.
  - **The photograph is SIZED, never `inset`.** For an absolutely-positioned
    replaced element `width: auto` resolves to the intrinsic width and the
    `right` offset is dropped as over-constrained, which hangs a 540px picture
    381px off a 166px tile. Measured, not reasoned about.
  - **The crossfade keeps exactly two layers opaque** — the incoming frame and
    the one it is covering — so the burgundy ring never shows through the middle
    of a swap, and a frame can still fade in on its second lap. Keeping every
    shown frame opaque makes lap two a hard cut instead.
  - **The label and the check outrank every photograph.** The pictures stack
    while they cross-fade, and at a lower z-index the label vanished the moment
    a tile advanced past its first frame — visible only after two seconds, which
    is why nothing but running the page caught it.
  - **The label keeps its dark scrim and white ink in both states.** The ground
    under it is a photograph either way now, and burgundy ink on a photograph is
    the one thing this label may never be.
  - **An unselected tile mounts ONE `<img>`.** The other three frames are
    ~80–120 kB apiece; rendering them up front would put ~600 kB of pictures on
    every registration for options nobody chose. Mounting them on selection IS
    the preload, and the first advance is two seconds after their fetch starts.

  **The cycle order is the founder's, rotated to begin on the frame already on
  screen.** It is a loop, so rotating changes the phase and not the order — and
  what it buys is that the first advance lands two seconds after the tap rather
  than in the same instant, where a photograph swapping under the shrink reads
  as a glitch rather than as the cycle starting.

  Under `prefers-reduced-motion` the chosen state simply is — no shrink, no
  travelling check, and no cycle at all: there is no reduced variant of a moving
  picture, only its absence, the same rule the tap burst follows. Telegram-only;
  the native client owns its own controls.

  **A footnote under the options says nobody else sees it** (founder decision):
  the answer is never shown to the partner anywhere, and the screen has to say
  so where the choice is made or the honest answer is not safe to give. It is
  phrased positively — "only you can see this, it helps me match you better" —
  rather than as a bare "your matches can't see this", because on this screen
  the first question a reader has is *why are you asking*. The same line rides
  the chat fallback's question text and the My Profile row (§2.1).

  Written through the same `applyOnboardingFacts` path as the other five, so the
  canonical column, `onboarding_progress.currentQuestion` and the funnel rows
  are identical to a chat answer, and `/complete` does not require it — whatever
  the Mini App did not deliver, the chat asks for. The chat and the native rail
  answer with exactly one value and are unchanged by the move to a set: the
  collector accepts a bare string and canonicalises it into a one-member list,
  so `/v1/*` needs no change either. iOS renders it from the existing `ui_hint`
  contract (`choice_chips`).
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

Canonical order: name + age → gender → preference → height → **relationship
intent** → hobbies → partner
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

**The dating city must be a launched market — Kyiv only today (2026-07-28).**
`packages/shared/src/markets.ts` is the single source of truth, shared by the
bot, the Mini App and the `/v1/*` API. Registration used to accept any city
Google Places could name, which was a promise the product could not keep:
matching is strictly same-city (§3.2 filter 5), so a user who picked a city we
have not launched landed in a **pool of one** — no ad spend there, no curated
venue catalog, no operations, and no possible partner — while the app kept
counting down to a drop they could never be in.

**Since 2026-09-04 the picker offers more cities than we serve, and the extra
ones are a waitlist rather than a dating city.** The catalog has two tiers and
the difference is a hard product boundary, not a label:

| | `active` (launched market) | `waitlist` (expansion list) |
|---|---|---|
| Today | Kyiv | Odesa, Dnipro, Lviv, Kryvyi Rih + the 15 largest German cities |
| What the tap does | writes `Profile.homeCityKey`, registration continues | writes `city_waitlist_entries`, registration **stops** |
| Can be matched | yes | no — and nothing about them is ever paired, scored or scheduled |
| Venues, ads, ops | exist | do not |

The reason it is a separate table rather than a flag is the same reason the gate
exists at all: `homeCityKey` IS the matching boundary, so a waitlist key sitting
there would eventually pair the second person waiting in Berlin with the first,
for a date in a city with no venues. See
[`city_waitlist_entries`](../../architecture/data-model.md#city_waitlist_entries-11-with-users).

- **Search** offers the whole catalog (`searchCityCatalog`, matched on the city
  name and its local-language aliases), and every hit carries its `status`, so
  the picker can render a "coming soon" chip instead of an empty result. Before
  the waitlist a Berliner typing their own city got nothing back, which reads as
  "your city does not exist". The Google Places city lookup is gone entirely:
  with a curated set, a global geocoder can only ever propose cities the server
  must refuse. (`PLACES_API_KEY` is still required for venues.)
- **Geolocation** answers "which of our cities are you in" as pure geometry
  against each city's centroid + `radiusKm` (21 km for Kyiv — the city, not the
  commuter belt; see the note below — and a single coarse 25 km for every
  waitlist city, which only ever pre-selects a picker option and gates nothing).
  Outside the whole catalog it resolves to **nothing**, and the Mini App says so
  rather than saving a city the person is not in. This also ends a real bug: the
  old reverse-geocode silently resolved ANY coordinates to the first fallback
  city (Kyiv) whenever `PLACES_API_KEY` was unset.
- **The write is the enforcement point, and it did not move.**
  `validateHomeLocationPayload` is still the only writer of `homeCityKey` and
  still refuses every unlaunched city with `city-not-supported`, so one check
  covers Telegram (`POST /v1/telegram-onboarding/city/select`) and the native
  app (`POST /v1/me/home-location`) alike. A launched city is **canonicalized**
  to the market's own name and coordinates — the client only ever picks WHICH
  market, so a drifting or spoofed centroid can never land in
  `Profile.latitude/longitude` (which the venue picker and city analytics read).
  The waitlist branch sits **before** that validator, not inside it: it writes a
  different table and never touches `Profile`, so there is no exception to the
  `homeCityKey` rule to reason about later. iOS renders the constraint from
  `AppConfig.supportedCities` / `cityCatalog` (`GET /v1/app/config`) instead of
  discovering it as a 400; a client that only knows `supportedCities` is still
  correct, just without the waitlist screen.

**The waitlist screen is where registration ends, and it is a real stop.** The
person is told we are not open in their city yet, that their application is
saved, and that they will be among the first written to when it opens. That
"first" line is copy about intent — there is no queue, no position and no worker
(a priority algorithm was explicitly not built). They are held there on every
relaunch: the client routes on `cityWaitlist` before it looks at `homeLocation`,
the bot's `/start` card says "you're on the list" instead of "let's finish
signing up", and — the part that actually enforces it — every onboarding step
past the city gate requires a home location this account does not have, so
`/theme`, `/profile`, `/ai-memory` and `/complete` all answer
`409 location-required`. They can never be matched, because
`buildCandidateSql` requires `onboarding_step = 'completed'` and they can
never reach it.

**But it is not a dead end.** "Choose another city" drops the row
(`POST /v1/telegram-onboarding/city/waitlist/leave`) and returns to the picker;
picking a launched market drops it too. That escape hatch is what a mis-tap
needs, what someone who really would date in Kyiv needs, and why the demo bot
needs no special case for a visitor who taps Berlin mid-walkthrough — the demo
market is Kyiv, the screens are the same production code, and the way out is one
tap. Because the two states are mutually exclusive by construction, a person can
never hold both a dating city and a waitlist row.

**The radius is sized to the CITY, not the commuter belt (founder decision
2026-08-18).** It was 60 km until then, which reached Boryspil and most of the
oblast — while ads and acquisition target Kyiv proper, so an oblast pin is a
person the product cannot serve. It is 21 km now, and that number is a
compromise rather than a boundary: **a circle cannot draw a city.** Measured
from the Kyiv centroid, Vyshneve (oblast) sits 12.8 km out while
Pushcha-Vodytsia (a Kyiv district) sits 14.9 km, and Brovary (oblast) sits at
20.0 km — the same distance as the southern edge of Holosiivskyi. So no radius
takes the whole city and leaves the suburbs: 21 km covers Kyiv down to
~50.26°N (everything but the forest-and-cottage tail of Koncha-Zaspa at the
oblast border) and still admits Vyshneve, Vyshhorod, Brovary and Irpin.
Tightening below ~13 km would exclude them at the cost of four real Kyiv
districts. The only exact answer is a boundary polygon, which is a
cross-client change (`Market` gains the outline, `/v1/*` + OpenAPI carry it,
and the iOS client's `MapCircle` becomes a `MapPolygon`) and is deliberately
not done.

**One consequence to hold onto: the radius does NOT stop an oblast resident
registering.** City *search* is a separate list (`searchMarkets`), so someone
in Brovary who types "Kyiv" still registers with Kyiv — the radius only decides
what geolocation pre-selects, and where a departure point may be dropped.
Keeping the oblast out of the pool entirely is a different mechanism and is not
built.

**Launching a new city is a deliberate code change, not a flag.** A market is
only real once its curated venue catalog (`curated_venues.cityKey`), ad
campaign, and ops processes exist — all of which already ship as code/scripts.
An env toggle would let someone open a city before any of that is ready, which
is precisely the failure this gate removes. Promoting a waitlist city: seed +
review its venues, move the entry from `WAITLIST_CITIES` to
`SUPPORTED_MARKETS` with a measured `radiusKm` and `status: "active"` (its
`cityKey` must match the venue rows), confirm the timezone resolves — and the
people already waiting are that `cityKey`'s `city_waitlist_entries` rows, which
the admin waitlist view counts. Until then the product must never suggest the
service is available there; "coming soon" and "you're on the list" are the only
things it may say.

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
- **Relationship intent never reaches the embedding.** It is scored by its own
  `V_intent` multiplier (§3.2) from its own column, and folding it into
  `psychologicalSummary` — the cheap-looking way to make it "count" — would give
  it weight 0.65 through `V_explicit`, i.e. make the weakest factor in the
  formula the strongest. It would also be wiped on the next About-me edit, which
  replaces that field wholesale. Same rule, same reason, as the §1.3b voice
  transcript.
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
- `MIN_PHOTOS` (**4** since 2026-08-22 — it was 4 until 2026-07-27, spent that
  period at 3, and is back at 4 by founder decision) is a hard floor; anything
  beyond up to `MAX_PHOTOS` (10) is
  purely optional. In Telegram conversational onboarding, the media stage is
  deterministic rather than LLM-owned:
  before the minimum, the bot reports exactly how many valid photos are still
  needed; once 4 photos are valid, it keeps the stage open and shows one
  **Continue** action instead of finalizing automatically.
  **The number is written in exactly one place** (`packages/shared/src/constants.ts`)
  and read by the collector, the photo stage, both photo managers, the §1.4
  activation gate, `/v1/me/photos`, the `ui_hint` contract and
  `/v1/onboarding/interview.minPhotos` — so the native client renders the floor
  rather than knowing it, and moving it moves every surface at once.
  **Accounts that finished onboarding at the old floor are never demoted**: the
  verification pipeline writes `status` only when it ACTIVATES, so a legacy
  three-photo profile stays `active` and matchable, and merely cannot delete its
  way further down. It is asked for the missing photo the next time its photo
  set is re-verified (any photo edit fires that rerun), which is the one place
  the raised floor reaches an existing user at all. The user may keep
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
  inline keyboard. **It is HANDED OVER rather than removed (2026-08-29):** the
  voice step that follows owns the same one panel slot, so its ask carries the
  voice keyboard, which Telegram substitutes for this one — and only a path
  that ends the onboarding panels entirely emits `remove_keyboard`. That is a
  correction, not a refinement: this line used to claim the panel was "removed
  on the first message the bot sends after the stage ends", and no such message
  exists. Every send downstream — the voice ask, the verification card, the
  main menu, the pinned banner — sets an INLINE keyboard, and a message carries
  one `reply_markup`, so the removal had no carrier and the panel survived into
  the verification gate. One owner decides which panel is up
  (`services/reply-panel.ts`); two independent flags would each eventually emit
  a removal that kills the other step's panel. Before this the first upload was
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
  every third answer — spoken or typed alike — the bot holds one short
  "thinking" shimmer beat (~2.5 s, the `think` AIActions glyph) *before* the
  next question is composed.
  The pause runs strictly first: the "typing…" indicator and the next-question
  generation only start after the shimmer is torn down, so the thinking beat is
  never preceded by a typing indicator. Photo-stage continues, photo/video
  uploads, and context-dump pastes do not count toward the cadence.

  **A recording used as an ANSWER is never narrated, on any step (founder
  decision 2026-08-29, reversing 2026-08-24).** It gets the plain
  `record_voice` / `typing` chat action while the Bot API download and the
  Whisper round-trip run, exactly as a post-onboarding recording does, and it
  is counted by the periodic cadence beat above exactly like a typed answer.

  This is a correction rather than a refinement. The 2026-08-24 pass added a
  two-beat `<tg-thinking>` status over every spoken onboarding answer, on the
  reading that "этап онбординга" meant the whole of registration; the founder
  meant the one step where a recording is the deliverable. What it produced is
  the thing this section otherwise forbids — **a status on a step the user has
  already finished.** A shimmer here narrates transcription, which is
  plumbing: the user has answered, and what they are waiting for is the next
  question, not a report that we heard them. It also read as the product
  treating "spoke instead of typed" as an event worth announcing, which is the
  opposite of the intent — voice is a way of typing here, not a feature.

  So the shimmer belongs to the §1.3b **voice prompt** and nowhere else. Two
  things make that step different rather than merely earlier: the recording IS
  the profile element (it is kept as audio, never transcribed into the chat),
  and `voiceCheckSteps` covers a real validation pipeline — download, Whisper,
  moderation — that the user cannot see and that can genuinely refuse the clip.
  Narrating work with a verdict is a status; narrating work with no verdict is
  a delay with a picture on it.

  One consequence rides along: `earnsThinkingPause` loses its spoken-answer
  exception. That guard existed only because two shimmers would otherwise have
  stacked ~8 s of narration between a recording and the next question, and with
  the first one gone the reason went with it.

  The *content* streams that are NOT thinking-status beats — the match pitch,
  no-match notice, and ice-breaker DMs (`streamDraftsToChat(..., { rich: true })`
  → `streamRichDraftsToChat`) — also stream through the native rich AI-compose
  draft path (their lead "thinking" chunk renders as a `<tg-thinking>` shimmer),
  **but their final persisted message is sent as a plain `sendMessage`, not a
  rich message**: it must stay a normal, non-self-deleting text message, and for
  the pitch the proposal-countdown worker live-edits that final message via
  `editMessageText`. They degrade to the classic edited-message stream when a
  client can't render rich drafts.

### 1.3b Voice prompt (feature-flagged, the last onboarding question)

Gated by `VOICE_PROMPT_ENABLED` (default **off** → the collector marks the step
complete+skipped, exactly as it masks `ai_memory`, and the canonical order runs
`photos → complete` with nothing changed). Full design:
[VOICE_PROMPT_PRODUCT_SPEC.md](voice-prompts.md).

An optional 15-second recording the partner hears **inside the pitch, right
before the accept/decline question**. It is the only profile element that
carries tone, humour and cadence without opening a chat, so it argues for the
product's own thesis rather than against it.

**It is the LAST collector question, and that is a constraint rather than a
preference.** Past `finalize_onboarding` the §1.4 verification gate locks every
surface except verification and photo re-upload, so a question asked later never
reaches the user. The order becomes `… photos → voice_prompt → complete`. Two
things fall out for free: the photo stage's **Continue** already resolves
through `nextOnboardingQuestion`, so "done with photos" leads into the ask with
no new mechanism, and the ask is the message that takes the chat's bottom panel
off the photo stage.

**The panel is HANDED OVER, not removed, and that is forced rather than chosen
(2026-08-29).** This paragraph used to say the "🗂 My photos" keyboard was
"already removed by the first message the bot sends after the stage ends", which
was false in the strongest way: there is no such message. The ask, the
verification card, the main menu and the pinned banner all set an inline
keyboard, and Telegram allows one `reply_markup` per message — so the removal
had no carrier at all and the photo panel survived the whole way, still inviting
photos while the bot asked for a recording, still labelling the input field
"send more photos". A reply keyboard is REPLACED by a new one, so the ask
carries the voice step's own panel instead, in the same message, with no extra
bubble and with a placeholder that describes this step. The removal then rides
the step's own exit line, which is the one message on this path that is plain
text by construction.

**The skip moves onto that panel, and that is a cost paid for the review loop
below.** A reply-keyboard button is louder than a chip under the message, which
is the opposite of what this section wanted. It is worth it because after a
recording that button means *drop this*, and it has to outlive the user's own
voice message, the validation shimmer, a possible rejection and the confirmation
card — the same argument §1.3 makes for the photo panel. It also ends the
orphaned-inline-button problem the old skip handler had to clean up by hand.

**The recording is no longer the acceptance** (founder decision 2026-08-29,
DECISIONS.md). The step stays open after an accepted clip: sending another
replaces it, the panel button drops it — deleting the saved row, because the
button means "no voice note", not "no MORE voice notes" — and one inline
**✅ Done** on the confirmation keeps it and moves on. This reverses the rule
that stood here before ("recording IS the acceptance; an explicit yes would cost
a tap"), and the cost is real and stated rather than discovered: **one extra tap
on the last step of onboarding**, whose drop-off is measured
(`GET /admin/analytics/onboarding-funnel`), plus the re-record spiral
VOICE_PROMPT_PRODUCT_SPEC §4.1 names as a funnel leak. Two things bound it. The
confirmation **adds no bubble** — the inline button rides the message this path
already sent. And the label is **Done**, not "Keep it": the first reads as
forward motion, the second as approving an artefact, which is what invites
another take.

**One consequence for the funnel:** `markOnboardingField` now writes at Done or
at the drop rather than at the recording, so this step's `dwellMs` includes the
review loop and "recorded, then walked away" moves from `answered` to
`stuckHere`. A naive before/after comparison across the cutover is invalid.
There is a new terminal state — recorded and tapped nothing — and the insurance
is the one that already existed: `/start` re-asks through the same sender, so
the panel and the button come back.

The copy's central instruction is a **prohibition** ("don't read your
profile aloud"), because that is the default failure and the bio is already on
the partner's screen; the hook is the stake, stated plainly — *the person I find
for you hears this before they decide*.

**The copy must not ask for more than the time it names, and it must point at
the way out (2026-08-22).** It shipped doing neither. It said *about 15 seconds*
and then suggested "the story you always end up telling friends" — a story does
not fit in fifteen seconds at any length, so the message asked for two
incompatible things in adjacent sentences. And it opened on *it's optional*
without ever saying where the exit was: the skip button existed, sat under the
message, and was never named, so a reader scanning the text for how to leave
found nothing. The suggestion is now one that fits the time (*what's got you
hooked right now*), and the ask is three paragraphs rather than five — an
optional step is the wrong place to spend a screen.

**Where the pointer at the button lives is a rail question, not a wording one.**
The question text is what `runAgentTurn` returns, and the native client is
served that same string over `/v1/onboarding/interview`, where this keyboard
does not exist and the app draws its own skip. So the shared copy says the step
CAN be skipped, and the Telegram layer (`sendVoicePromptAsk`) appends the line
saying WHERE — the same split the radar gate already runs on. That line
interpolates `voicePromptSkipButton` rather than repeating it, so the sentence
cannot name a button the keyboard stopped using, and a test holds all of it:
the label appears in the Telegram ask, appears in no shared question text, and
the durations named across the five languages are one number.

**There is no prompt catalog** (founder decision 2026-08-21). A Hinge prompt is a
frame for ten seconds of a stranger's voice in a FEED; this product has no feed,
delivers one person per day inside a pitch that already argues who they are, and
— because the transcript reaches the embedding — lets the pitch generator name
what was said in its own words. The frame arrives anyway, per side, in the right
language.

**Recording, and why `voiceHandler` has to be told.** `handlers/voice.ts` is
mounted ahead of every router and replaces `ctx.message.text` with a Whisper
transcript, so without a claim the recording the user was just asked for would
reach the fact collector as a typed sentence and be mined for profile facts. The
claim (`services/voice-prompt-claim.ts`) makes that handler return early —
**before its own bounds**, since those describe a transcription request (300 s,
20 MB, "transcription failed") while this is a profile element with its own
product bounds and its own wording.

**The claim has two layers, and the second one is what makes it true.** The
session flag is armed by whoever sent the ask — and the ask has NINE senders,
because an onboarding agent reply reaches Telegram from `/start`'s resume, the
photo-batch flush, the photo editor, both context-dump paths, the radar resume,
the voice step's own resume, and the conversational handler. Eight shipped
without arming it, **including the photo-batch flush, which is what asks this
question first in the ordinary flow**: the user got a bare message with no skip
button, recorded into it, and the transcript was mined into their profile while
the question re-asked itself forever (`voice_prompt` is synthetic, so text can
never satisfy it and `currentQuestion` never moves). Observed live — one turn
wrote `accepted: [ 'gender', 'preference' ]` out of a voice prompt.

So the claim is additionally **derived from the collector's own
`currentQuestion`** (`services/voice-prompt-pending.ts`). A sender can forget to
arm a flag; it cannot forget the field that decides which question is pending,
so the flag becomes an optimization and the derived check the guarantee. Cost is
one indexed lookup per voice note, and only for a chat mid-onboarding with no
claim already — the concierge's voice notes pay nothing. `voiceHandler` **repairs
the session** when that check fires rather than merely deferring, because
`voicePromptRouter` re-reads the sync predicate to decide whether the recording
is its own: two readers disagreeing would drop the recording instead of
ingesting it. Every sender now routes the reply through one helper
(`sendVoicePromptAskIfRequested`), and a tenth that does not fails
`voice-prompt-senders.test.ts`.

**Validation is safety-only**, exactly like the profile video: no identity gate,
no comparison against the verification selfie, and **no voice-printing anywhere
in this product**. Cheap local bounds run before any provider call, so a
mis-held mic button costs nothing; then Whisper, then moderation. Bounds:
`VOICE_PROMPT_MIN_DURATION_SECONDS` (3 — anything shorter is a misfire, not a
terse answer) to `VOICE_PROMPT_MAX_DURATION_SECONDS` (60 — where a stranger
stops pressing play), and `VOICE_PROMPT_MAX_FILE_SIZE_BYTES` (2 MB).

**One rejection reason exists only because the medium is audio.**
`audio_contact_info` refuses a clip that hands out a way to contact the speaker
off-platform — a photo cannot dictate a phone number, but thirty seconds of
speech can route the whole match around the product, which is a NO-IN-APP-CHAT
bypass no other surface can perform. Deterministic rather than an LLM call,
because the failure modes are asymmetric: a miss degrades to the status quo, a
false positive destroys a recording someone just made. So a bare platform name
never triggers ("I work in Instagram" passes); what does is a real contact token
(a handle, a link, a 7+ digit run) or a platform name **plus** an invitation to
write there. A provider that cannot answer is `processing_unavailable` and
retryable — we decline to publish audio we could not read, we do not tell the
user their recording was bad.

**The transcript feeds matching, and lives in its own column.**
`voice_prompts.transcript` is read by `refreshDirtyEmbeddings` and appended to
the embedding input at refresh time — the same treatment `partnerPreferences`
and `negativeConstraints` already get. It is deliberately NOT folded into
`psychologicalSummary`: that field is replaced wholesale by the About-me editor
(§2.1), so folding would mean a silent wipe on every bio edit; and a transcript
changes on **every re-record**, so `appendVibeToSummary`'s `includes()`
idempotency would append rather than replace and multiply the voice's weight in
the vector. Every write path attempts `refreshUserEmbedding` immediately —
`embeddingDirty` is fail-closed, so marking dirty and walking away withholds the
user from matching until the cron (the `appendNegativeConstraint` bug). Deleting
the prompt re-dirties and refreshes too: a deleted recording that keeps
influencing matching is a ghost the user cannot see or clear.

**Playback in the pitch** sits between the pitch message and the decision
question (§3.3). That puts the voice after the verified trust note — which since
2026-08-22 is a blockquote at the END of the pitch message rather than a bubble
of its own — and the ordering is the point rather than an accident of where the
messages fell: the note is a fact about safety, the voice is the person, and the
last thing before *yes or no* should be the person. Folding the note into the
pitch only made that truer. It is its own `sendVoice` — a voice note
cannot join a media group — carrying a one-line caption naming the partner and
`protect_content: PROTECT_PARTNER_MEDIA`, the shared constant, so demo mode
drops the protection for a filmed walkthrough instead of recording silence.
Fail-open by rule: a missing or unplayable clip skips the message, because the
pitch must never fail for want of optional audio.

**The decision question stays its own message**, and deliberately not the voice
note's caption even though a caption would save a bubble. It is the pitch's
central call to action, it reads quieter under a player, and — decisively —
`sendPartnerVoicePrompt` returns early for a partner with no recording, so a
question living in that caption would vanish for everyone who skipped the step.
The wording is also load-bearing: `decision-text.ts` matches replies against a
closed keyword set that this copy is written to elicit.

**Both surfaces.** The native rail is `/v1/me/voice-prompt` (JWT) plus
`SerializedMatch.partnerVoicePrompt`, carrying the precomputed waveform so the
card draws bars before fetching audio, and no transcript — the product ships a
person's voice, not a machine's reading of it. On Telegram none of that HTTP
surface is needed: `sendVoice` is the recorder, the waveform, the player and the
store.

**Already-registered accounts are never asked** (founder decision): the step
lives in the collector's question order, so it is reachable only by an account
still in onboarding, and there is no retro-ask surface in v1.

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
handlers and the chat agent's `attach_profile_photo` tool fire
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
auto-reruns the pipeline (menu photo manager, mobile `/v1/me/photos`, chat),
so without this an active user re-read "verification passed, your profile is
live" every time they opened their photos. The suppression is scoped to
`verified → verified`; anything the user can act on (`rejected`,
`pending_review`) is always announced, including on a rerun. Mirrors the
existing `statusMessageId` guard that already stops the menu + pinned banner
from being re-sent on a rerun.

**The landing sequence a passing Telegram user gets is three things, in order**
(`surfaceVerifiedActivationDefault`): the §Phase 1b **Profiler heads-up**, the
main menu, then the pinned status banner. The heads-up leads because it belongs
under the "verified ✨" DM rather than below a keyboard, and because activation
is the moment the Profiler's dispatch sweep can first reach this user. All
three sit behind the same `statusMessageId` guard, so a photo-edit rerun
repeats none of them, and behind the outcome gate above, so none of them can
land under a shimmer still claiming the check is running. A failed heads-up is
swallowed — it never costs the user their menu.

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

**Every verification outcome reaches both rails (2026-08-23).** The pipeline
used to pick recipients with `telegramId > 0n` and send a DM and nothing else.
That is not reachability: "Continue with Telegram" stores a REAL positive id on
an app-only account the bot cannot open a chat with, so the DM came back
`400: chat not found`, and no push existed on this path at all. A `platform =
mobile` user whose face-match was rejected therefore learned **neither that it
failed nor that it passed** — and the app screen holding them can only re-run
liveness against the same photos, so if the photos were the problem it could
never clear. Found by walking registration on a real iPhone; the rule it broke
was already written ninety lines below it, in `surfaceVerifiedActivationDefault`.
The rail is now `platform`-derived via `telegramReachable` / `pushReachable`
(`services/telegram-reach.ts`), and every announcement the DM ever carried has a
push twin: the three terminal outcomes, the retry nudge, the under-`MIN_PHOTOS`
ask, and the photos-came-off notice. The decision logic is untouched — only who
hears about it. Three properties are worth stating:

- **One push type, `verification.outcome`, with the outcome in `data.status`.**
  Every one of them lands on the same surface the app already renders, and an
  unrouted type is a notification that opens nothing when tapped — so extra
  types would buy nothing and cost the client a route each. `status` is
  `verified` / `pending_review` / `rejected` / `retry` / `photos_needed` /
  `photos_dropped`.
- **Not time-sensitive.** `TIME_SENSITIVE_PUSH_TYPES` stays the closed pair of
  two (ARCHITECTURE → APNs). A verdict someone is waiting on is the most
  tempting thing to add and still not an emergency.
- **The push is NOT held behind the outcome gate**, unlike the DM. That gate
  coordinates with a shimmer running in a Telegram chat; a lock-screen banner
  does not land there, so holding it would only make a `both` user's push up to
  30 s late for a symmetry that buys nothing.
- **The copy is its own, not the DM reused.** The DM leans on an inline keyboard
  directly beneath it ("tap 📷 below to swap them") which has no counterpart on
  a lock screen, and it is long enough that iOS would truncate the sentence
  carrying the verdict. Meaning stays in lockstep — a `both` user gets both
  rails for one event — so a rejection leads with "these aren't your photos"
  on both.

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

**The nudge names the step the user actually stopped on (2026-08-12), which
`User.onboardingStep` cannot say.** That column has four values, and the entry
Mini App (§1.1) collapses into ONE of them: `/consent` and `/language` both
write `language`, and nothing moves it again until `/complete` writes
`conversational`. So the sign-up fork, the email/phone gate, the city step, the
theme pick, the five profile screens and the AI-memory choice — half the
registration — all read as *"agreed to the privacy policy but hasn't picked
their language yet"*, which is what the worker fed into its prompt. Every Mini
App drop-off was therefore told to go and choose a language it had already
chosen, in a message otherwise written to sound personal. Confirmed in
production: an account with `language = uk` and terms accepted received all
five touches about picking a language.

The stage is now derived from the state the Mini App itself routes on
(`services/onboarding-stage.ts`) — the server-side twin of the client's
`postVisualPhaseFromRemote`, kept in the same order, in a separate module
because `apps/webapp` deliberately does not depend on `@gennety/shared` and the
two cannot share code. It resolves the concrete next action — the fork, the
unconfirmed email code, the unshared phone, the city, the theme, *which* of the
five profile screens is unanswered, the AI-memory choice, the un-tapped
handoff — and past the handoff reads the collector's own `currentQuestion`, so
a chat-phase drop-off is described by the question actually pending rather than
by "email, name, photos, etc.". The prompt's standing rule is that a concrete
WRONG step is worse than staying generic: the model may point at the one thing
that is next or say nothing specific, but never name a step already behind the
user.

Two deliberate imprecisions, neither of which can misdescribe a task. **The
visual intro is invisible to the server** — its position lives in the client's
DeviceStorage — so a user parked mid-animation reads as whatever comes after
it, which is the next thing they actually owe. And **the welcome-gift screens
are not stages**: they ask for nothing (one tap on a reward) and resolving them
needs the referral/promo flags plus a promo-code lookup, so someone who stopped
there is reported one screen further along — an under-, never an over-statement
of what is left.

A second, quieter falsehood went with it: the fallback used when the LLM call
fails told **everyone** their "profile is almost ready", including someone who
had not got past the phone gate and had no profile at all. Registration-stage
users now get their own line — deliberately only two of them (ordinary + final
touch) rather than a full five-step ladder, because that path fires only on an
OpenAI failure and a user hitting it five times running is not worth ten more
strings.

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
- **The user is warned it is coming (2026-08-19).** Until this, the first
  Profiler question arrived out of nowhere, days after registration, with
  nothing saying who was asking or why it mattered — the batches are paced to
  local morning/evening windows, so a user meets them long after the chat has
  gone quiet. A short heads-up now rides the **verification landing sequence**
  (§1.4 → `surfaceVerifiedActivationDefault`, above the main menu, so it reads
  under the "verified ✨" DM): while I look for someone, I'll ask the odd simple
  question; answer honestly and don't sit on them.
  **Activation is the honest moment for it, not `finalize_onboarding`** where
  the schedule is armed: the dispatch sweep filters on `status = 'active'`, so
  a user who never clears verification is never asked, and telling them
  otherwise at finalize would promise something the gate withholds. It is
  therefore also once-only for free — the sequence's existing `statusMessageId`
  guard means a photo-edit rerun never repeats it.
  **The copy is bound to what the Profiler actually feeds** — the icebreakers
  and the pre-date wingman hint — and **must never claim it improves match
  quality**, which it is deliberately no input to (this section's own rule). It
  also names no cadence ("while I look for someone", never "this week"), because
  the drop interval is a `DropCadence` profile and production runs `daily`
  (§3.1); the same rule DEMO_MODE.md applies to its own narration.
  Reachability mirrors this worker's `platform in (telegram, both)` filter
  rather than the looser `telegramId > 0` test beside it — a "Continue with
  Telegram" account carries a REAL positive id the bot cannot message (§1.1), so
  that test alone would promise questions that never arrive. Telegram-only, like
  the Profiler itself; the native client owns its own onboarding shell.
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
  a standing claim on everything the user types. What bounds it is not a clock
  but the user's own behaviour: `Profile.profilerAnswerWindowUntil` is **cleared
  outright** the moment they do anything else — any command, menu tap, or other
  flow — because the next thing they type after that is for the assistant, not
  for the question. Once cleared, free text falls through to the menu agent, and
  the two explicit escapes still resolve the question: the Skip button stays
  live until the stall deadline, and a Telegram **reply** to the question
  message (anchored by `Profile.profilerQuestionMessageId`) is always recorded
  as its answer. Without this bound the Profiler mis-read ordinary conversation:
  a question asked hours earlier turned "when is my date?" into an answer,
  complete with an acknowledge shimmer and the next question, leaving the user's
  actual question unanswered.

  **A question is answerable for as long as it is visible (2026-08-13).**
  `PROFILER_ANSWER_WINDOW_MS` (90 min) used to be a hard second bound on top of
  that rule, and the two disagreed: the question is reclaimed at
  `PROFILER_STALL_TIMEOUT_MS` (6 h), when its message is *deleted*, so for the
  4.5 h in between it sat on screen with a working Skip button and could not be
  answered — typing the answer handed it to the concierge instead, and the
  question then died at the stall sweep and paused the rest of the batch. The
  reply-to escape hatch existed for exactly this and nobody uses it. Past the
  window, **with the window still uncleared** — i.e. nothing at all has happened
  since the question was sent, so the user's very next action is this message —
  plain text is still recorded, unless it reads as a **question aimed at the
  bot** (`isLikelyMetaQuestion`, the same predicate §1.3 uses to decide whether
  the photo stage should hand a message to the agent). That test applies only
  past the window: inside it a short genuine answer ending in "?" ("не знаю,
  может кино?") must keep counting, so the change is additive — nothing that
  captured before stops capturing.

  **"Doing something else" means a claim that is still LIVE, not one the user
  abandoned (2026-08-12).** The §2.1 menu editors (About me, Who I want, …) hold
  the chat's free text for 30–60 minutes, and that claim was released inside the
  menu router — which is mounted AFTER the Profiler. So a user who tapped "About
  me" hours earlier, walked away, and later answered a Profiler question hit the
  worst of both: the Profiler saw a stale non-idle `menuState`, refused the
  answer **and closed the answer window** (which disqualifies the live question
  from ever being answered by plain text again), and only then did the menu
  router drop the claim and hand the text to the concierge. The answer was lost
  to the agent and the question sat unresolved until the 6 h stall sweep recorded
  it as an implicit skip and paused the rest of the batch — a series of three
  ending on the first question. Stale claims are now released in `bot.ts` ahead
  of every router (`releaseStaleMenuClaim`), where the match-flow twin has always
  been released; that twin never had the bug because both of its release sites
  already sat ahead of the Profiler.
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
- **The humour question takes a meme (`acceptsImage`, 2026-09-03).**
  `f_humor` / `m_humor` ask "what actually makes you laugh? Feel free to just
  send your favourite meme" and are the only questions in the bank that read an
  image when one arrives. They also sit in the **high** block rather than the
  medium one: what a person finds funny turned out to be better icebreaker fuel
  than most of what ranked above it, and "good jokes" is not a signal while the
  specific thing someone laughs at is.

  A vision pass (`services/vision/read-meme.ts`, the cheap `visionFast` tier)
  turns the picture into ONE sentence in the sender's own language — the subject
  and the register (dry, absurd, wholesome, extremely online) — and that
  sentence is stored as the ordinary `answerText`. Nothing downstream changes:
  the icebreaker and wingman generators keep reading `question → answer` text
  lines.

  **The bytes are never persisted; the pointer is** (`ProfilerAnswer.memeFileId`
  / `memeKind`, 2026-09-04). We hold the Telegram `file_id` and Telegram holds
  the file — the arrangement `VoicePrompt.telegramFileId` and the profile photos
  already use. Nothing is written to a bucket, so there is no retention sweep
  and no `collectOwnedPaths` entry to keep in step, and a `User` cascade takes
  the pointer with the account. What the pointer buys is the §Phase 4 paid
  pre-date reveal (`docs/product/domains/scheduling-and-monetization.md`), which
  shows the real picture instead of paraphrasing it.

  The pointer is written **only on the path where the description came from the
  picture**. A caption fallback records the text and no pointer, which quietly
  gives the reveal a safety property it would otherwise need its own moderation
  pass for: an image the vision model refused as unsafe produces no description,
  so it falls to the caption, so it never gets a pointer, so it can never be
  shown to anybody. The only images that are re-sendable are the ones a vision
  pass already looked at and cleared.

  Three rules make this safe to have. Capture is **opt-in per question**
  (`profilerQuestionAcceptsImage`), so a photo that lands during "are you an
  early bird or a night owl" still falls through to the menu agent instead of
  burning that question. The bytes are **sniffed, not trusted** — Telegram's
  declared type is not evidence, SVG and HEIC are rejected, and anything over
  `PROFILER_IMAGE_MAX_BYTES` is not base64'd into a request. And a **caption is
  the fallback**: when vision is down, refuses the content, or returns nothing
  usable, the caption the user sent with the picture is recorded as the answer,
  because losing real typed text to a timed-out API call would be the worse
  failure. With no caption to fall back on the bot says so once
  (`profilerImageUnreadable`) and leaves the question live, so answering in
  words still works.

  Stickers, GIFs, videos and documents are read through the **thumbnail**
  Telegram generates (a still sticker is a WebP the model reads directly). That
  is what makes "send me something funny" work for a video without a video
  pipeline: one frame says what the joke is, at the cost of one cheap vision
  call.
- **A TikTok / Reels link answers it too (`SHORT_VIDEO_LINKS_ENABLED`,
  2026-09-04).** People share what they find funny as a link far more often than
  as a file, and before this the link went through the router's *text* branch
  and was stored verbatim: `answerText` became `https://vm.tiktok.com/ZM…`,
  which the icebreaker and wingman generators then read as if it said something
  about the person. That was already a bug; link support is the fix, and the fix
  is not a better string but the same kind of sentence a picture produces.

  **The cost design is that we never download the video.** A reel's caption is
  usually the setup and its cover frame is usually the punchline, so we read the
  post's public metadata — TikTok's unauthenticated oEmbed endpoint, Instagram's
  OG tags — and run the cover frame through the *same* `read-meme.ts` pass at
  the same `visionFast` tier, told that it is a cover frame and given the
  author's caption as context. One image, one call: the same cost as a sent
  photo. The expensive tiers (yt-dlp → `extractVideoAudio` → Whisper →
  `extractVideoFrames`) are deliberately NOT built, even though every primitive
  for them already exists in `services/profile-media-validation/`. They should
  be added when a measured miss rate asks for them, not on a hunch — and on a
  droplet with one static IP, Instagram's datacenter-range blocking makes the
  download tier a materially different operational proposition.

  **Analysis is cached per VIDEO, not per user** (`ShortVideoAnalysis`, unique
  on `[platform, externalId]`). Share stubs are resolved to the platform's own
  id first, so `vm.tiktok.com/ZM…`, `tiktok.com/t/…` and
  `tiktok.com/@u/video/<id>?is_from_webapp=1` all collapse onto one row. The
  second person to share a viral reel costs nothing at all — no fetch, no vision
  call, no upload (measured 28 ms against 4.6 s cold). Nothing in a row is
  private: it is derived from what the platform serves to anyone logged out, no
  user is attached, and GDPR deletion has nothing extra to sweep — what
  identifies the user is still their `ProfilerAnswer` row.

  **The cover frame is uploaded once, to mint a real `file_id`.** Both platforms
  sign poster URLs with a short expiry — a live TikTok poster checked on
  2026-09-04 expired on 2026-09-06 — and the §Phase 4 reveal fires shortly
  before a date scheduled days earlier, so a stored CDN URL would be reliably
  dead by the time somebody paid to see it. Uploading converts it into a
  permanent Telegram-hosted asset, which means `memeFileId` keeps meaning
  exactly one thing and the demo guard and the entitlement logic stay untouched:
  to everything downstream, a linked reel is a photo answer.

  **The reveal also sends the link** (`ProfilerAnswer.memeSourceUrl`,
  2026-09-04). The frame carries a still joke fine but flattens one that is
  spoken or unfolds over time — a talking-head skit's cover frame is just a
  face, and then the whole 25⭐ rests on one sentence. So the buyer gets the
  frame, the sentence, the advice, *and* the canonical URL. Three properties
  make this safe rather than a new refund surface: the link goes **last**, after
  everything guaranteed to work has landed; it is sent with **no `parse_mode`**,
  because an Instagram shortcode can contain `_` and a legacy Markdown parse
  failure would turn a delivered sale into a reversal; and its failure is
  **swallowed**, because by then the buyer already has what they paid for. A
  link that has since gone private or been deleted is likewise not a failed
  sale.

  The URL rides **with** the pointer and never alone: no pointer means no
  reveal to attach it to, so a bare URL on the row would be dead weight that
  still records what the user watches. It is also cleared on re-answer, like
  the pointer — a humour answer retyped in words must not leave the reveal
  selling a video the current answer is no longer about.

  This does mean `PROTECT_PARTNER_MEDIA` stops being absolute for link answers:
  the buyer can open the video and share it onward. That is the right trade. The
  protection exists for a **personal** picture — a screenshot, something the
  partner made or chose privately — and a public reel was never private in the
  first place. Withholding a public URL from the one person who paid to
  understand the joke protects nothing.

  **Failure degrades to the user's own words.** Everything that can go wrong —
  the post is private, deleted, geo-blocked, the platform rate-limits our IP,
  the cover frame is unsafe — falls back to whatever the user typed *around* the
  link, recorded with no pointer, exactly like the caption fallback above. A
  bare link that cannot be read records **nothing**: the bot says so once
  (`profilerLinkUnreadable`) and leaves the question live. The URL is never
  stored as the answer.

  **This is the only place in the bot that opens a URL a user typed**, so it
  carries its own perimeter (`services/short-video/safe-fetch.ts`): a host
  allowlist re-checked at every redirect hop, a public-unicast address check
  before each hop (loopback, RFC1918, CGNAT, link-local incl. `169.254.169.254`,
  multicast, and their IPv6 and v4-mapped equivalents), HTTPS only, and a byte
  cap enforced while streaming. Page hosts and poster-CDN hosts are separate
  allowlists, because the poster URL is read out of a page body — the one value
  in the flow a third party writes. Off by default; with the flag off a link is
  just text again and no outbound request is made on user input.
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
