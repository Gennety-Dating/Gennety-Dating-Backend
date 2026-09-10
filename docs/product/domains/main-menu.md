<!-- WHEN_TO_READ: You are changing the Telegram bot menu / persistent surface, or the mobile API consumed by the native iOS client (Phase 2). -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 2309-3025) — migrated 2026-09-01 -->

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
  one costs the profile.
- **So does a photo or video manager (2026-08-13).** `edit_photos` /
  `edit_video` were left out of the rule above because they consume media, and
  a stray photo lands in a gallery the user can see and delete rather than
  silently over a field. That is still true of the photo — and it was never the
  thing that needed bounding. What needed bounding is the claim on the CHAT: an
  open manager consumes any message carrying no callback data, so plain text
  got "send me photos" back instead of reaching the concierge, and `menuState`
  is one of the four fields the Profiler reads to decide the chat is idle
  enough to record an answer (§Phase 1b). The state lives in `bot_sessions`, so
  **someone who tapped "My photos" once and walked away had a bot that never
  answered them again** — no deadline, and the only thing that ever closed it
  was tapping another menu button. A deadline says exactly what that tap says,
  so expiring runs the **same close**: cards retired, staged arrays dropped,
  redo mode off. Dropping the state alone would leave every card's 🗑 and the
  panel's ➕/✅ on screen pointing at a session that no longer exists, which is
  the orphaned-button bug this section already records. The window is longer
  than any text claim (`MEDIA_CLAIM_TTL_MS`, 2 h) and is **re-armed on every
  interaction with the manager**, so it bounds abandonment rather than the
  length of an upload session; it must stay well under Telegram's 48 h edit
  limit, past which the cards can no longer be retired at all and the manager
  is dead on screen whatever the session says. One consequence to hold onto: a
  verification-gated user in the "📷 upload different photos" redo (§1.4) who
  leaves for two hours comes back to the verification card and re-enters with
  one tap, because that gate is keyed on the manager being open.
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
  **What I do**, **My photos**, and **What I'm looking for** actions.
  **The relationship intent (§1.3) sits BELOW the preview block and outside
  it**, on its own line, always carrying "only you can see this" — set or unset.
  That placement is the point rather than layout: the block above is framed as
  *"this is how your match sees you"*, and this is the one profile fact a match
  never sees, so folding it in would make the preview a lie. The partner is
  never shown it — not in the pitch, not on the match card, not in
  `SerializedMatch` (founder decision): a label read before the person turns the
  decision into a filter, which is the thing this product does not have, and it
  would make the honest answer the expensive one to give. It is editable
  because intent changes with time in a way height and gender do not — four
  buttons, one tap, no text state. **Who I want** shows both the
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
- **My Tickets** — (only when `TICKET_FEATURE_ENABLED`) a `web_app` row that
  opens the ticket store Mini App (`tickets.html`) directly, to pre-purchase
  bundles ahead of any date. The store draws the user's `ticketBalance` on its
  own hero card, so since 2026-09-07 the row no longer sends a balance message
  first (same pattern as Premium / Invite a friend). The old message survives
  behind the `menu:tickets` callback for the two cases a `web_app` button
  cannot serve: a dev environment whose `WEBAPP_URL` isn't HTTPS, and the
  concierge agent's `open_screen("tickets")`. See §3.5b.
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
The mobile chat agent keeps its own `Message`-row history unchanged. The menu agent
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
  `update_hobbies` (the Telegram side had no hobby tool while the chat agent did) and
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
  surface — the assistant, the mobile chat agent, the onboarding agent, and the pitch /
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
   button and no timer anywhere. **One exception on the button only
   (2026-08-09):** a user who could buy a paid Rematch right now (§3.11) gets
   that entry instead of the menu button — same body, no timer, and
   deliberately **no price**, since a pinned message sits above every
   conversation. It opens the offer card, where the price is stated before any
   payment. This mode is the only place it appears: it is the one moment the
   product has nothing to promise, and the banner is edited rather than sent,
   so a way to act on the wait costs no message. A countdown is only honest if reaching zero
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

**A push may never precede the message it describes (2026-08-20).** The banner
is pinned above every conversation, so it is read *next to* the chat rather
than in place of it — and the first venue assignment pushed the moment the
`scheduled` commit landed, ahead of the per-side work that actually tells the
pair where they are going. That work is not incidental: `dateCardSteps` plays
`NEVER_CUT_SHORT` for ~6.3 s on top of blurb generation, so the pin carried the
settled date and venue name for **seven seconds or more** while the chat was
still saying "putting your date card together" — every time, not as a race. The
pinned message was announcing a decision the product was still narrating.

The push now rides `.finally` on each side's own confirmation. Two properties
decide that shape. **A pin ahead of the chat is a wrong state on screen, and
the tick cannot correct it** — the banner is not stale, it is premature, so the
usual "the worker reaches them within a minute" recovery does not apply.
**Being skipped is not a wrong state**: the push is an optimization on top of a
tick that owns recovery, so a confirmation that throws costs at most a minute
of lag. That is why the ordering is worth more than the up-front push it
replaces, why `.finally` is right (the banner follows an *attempted*
confirmation, not a successful one), and why it fires **per side** rather than
per pair — one unreachable chat must neither delay nor skip the other person's
banner. The other four call sites already satisfied this by construction: the
venue-change settles push after their cards, and the decision/TTL/cancellation
transitions are followed by ordinary sends rather than by a multi-second
status sequence.

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
- **Mobile chat agent** (`/v1/chat/*`) — multimodal AI chat that gathers
  profile facts in the background via `update_profile` / `attach_profile_photo`
  tools. Distinct from the legacy onboarding-agent: persists each turn as a
  `Message` row and supports image attachments. Post-onboarding fixed identity
  fields such as age cannot be changed through the tool. Attaching a chat image
  to the dating profile re-runs the same upload-time safety, face-presence,
  identity, duplicate-hash, profile-bucket copy, metadata, and
  verification-rerun path as a normal profile-photo upload.
- Match decision, vibe-location, safety-ack, report endpoints under
  `/v1/matches/:id/*`.
- **Blocking** — `POST /v1/matches/:id/block`, plus `GET /v1/me/blocks` and
  `DELETE /v1/me/blocks/:userId` for the list and the undo. App Store
  guideline 1.2 requires a product carrying user content to offer BOTH a report
  and a block, and the two are deliberately independent here: a report is an
  accusation addressed to moderation, a block is a boundary that needs no
  accusation and no review. See §Blocking below. **iOS-only entry point for
  now** — the effect is server-side and therefore cross-platform, but the
  Telegram surface has no button yet (recorded decision, 2026-08-23).
- **Post-date feedback** — `GET /v1/me/feedback/pending` +
  `POST /v1/me/feedback/post-date`. The GET has no Telegram equivalent: there
  the T+24h DM carries the link, while `/v1/matches/current` stops returning
  the match once it is `completed`, so the app has nothing to discover it from.
- `/v1/me/push-token` registers Expo/APNs/FCM tokens; the bot dispatches
  push via `services/push.ts` for the same events that DM Telegram users.
- `/v1/me/home-location` persists canonical dating city + coordinates for
  match eligibility; `/v1/me/location` remains raw coordinate storage for
  Meet-Halfway and does not by itself unlock matching. The city must be one of
  `AppConfig.supportedCities` (§1.3) — anything else is `city-not-supported`
  (400), and a launched one is canonicalized server-side. The client renders
  the constraint from `GET /v1/app/config` rather than discovering it as an
  error. The same endpoint is how an existing account moves to a launched city.
