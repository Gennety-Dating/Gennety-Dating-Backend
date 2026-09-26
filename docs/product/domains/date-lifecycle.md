<!-- WHEN_TO_READ: You are changing what happens around the date itself: the spotter sign, the safety brief, the Date Terminal invite and reminder (T-45m / T-15m), the did-you-meet check, post-date feedback, pre-date coordination, or the emergency protocol (Phase 4). -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 6516-6890) — migrated 2026-09-01 -->

## Phase 4 — Date Lifecycle

Driven by `services/date-lifecycle.ts` + `services/pre-date-safety.ts`,
`setInterval` every 2 min. All actions are idempotent via timestamp
columns on `matches`.

| When | Action | Idempotency marker |
|---|---|---|
| Activation → `scheduled` | Generate **wingman hints** (one short imperative tip per side about the other) and persist on the row | `wingmanHintA/B` |
| T − 5 h | Send personalised AI **ice-breakers** (3 starters per side, language-aware, fallback to static lists). For Telegram users the DM is delivered through the native rich AI-compose draft stream (`streamDraftsToChat(..., { rich: true })`, same primitive as the pitch): a "thinking" lead beat (`icebreakerStreamStart`, a `<tg-thinking>` shimmer), each starter revealed one-by-one as growing drafts, then the full set of starters as the plain final `sendMessage` — the cancel-reminder DM lands right after. Degrades to the classic edited stream when a client can't render rich drafts. Mobile gets the same content via `iceBreakersA/B` (no streaming). | `icebreakersSentAt` |
| T − 5 h | **Cancel reminder** — DM both sides the cancel button (callback `emerg:start:{matchId}`). A reminder, NOT a gate: a `scheduled` date can be cancelled from the moment it is booked (My Date hub, the agent's `propose_cancel_date`, the app's date card — founder decision 2026-09-26; nothing ever checked the clock before T-5h, only the copy said "the window is open"). Cancelling **closes at `agreedTime`**: from the start of the date the service refuses (`date-started`, 409 `date_started` on the app) — "they didn't show up" is the T+24h did-you-meet question, not a cancellation that refunds both tickets (2026-09-14, audit A13-M20) | shared with above |
| T − 5 h | **Start the native «date day» Live Activity** on both sides (`services/date-day-activity.ts`, iOS §4.2) — APNs *push-to-start*, so the card appears on a locked phone whose owner has not opened the app, which is the entire reason the gate is at T-5h. No-op for anyone with no registered start token, i.e. every Telegram-only account. | shared with above |
| T − 1.5 h | **Advance the Live Activity to the `wingman` stage.** | shared with `wingmanSentAt` |
| T − 1 h | **Advance the Live Activity to the `chat_open` stage** — fired by `openProxies` in `services/coordination.ts`, not by the lifecycle tick. Declared since the four-stage card and deliberately dark until the native chat screen existed; live since it did. | shared with `proxyOpenedAt` |
| T − 30 min | **Advance the Live Activity to the `spotter` stage** — the shared sign, the partner's arrival flag, and (expanded Dynamic Island only) their first name. | time window (`dateDayBeatFor`) |
| T + 2 h | **Advance the Live Activity to `vibe_check`** — three buttons asking how the evening went, answered from the lock screen without opening the app. | time window (`dateDayBeatFor`) |
| T + 3 h | **End the Live Activity.** An hour after the question, not at the same moment as it: ending at T+2h would take the question away in the tick that posed it. A time window (T+3h … T+3h30) rather than an idempotency column: ending an activity that is already gone is a no-op, so a repeated sweep costs one wasted push. | — (idempotent by nature) |
| T − 1.5 h | **Pre-date safety brief** to the female user, on whichever rails reach her — Telegram DM and/or APNs push (`safety.brief`, **time-sensitive**, §Phase 4 → Pre-date safety brief). Gender selects the recipient; `platform` selects the rail. | `safetyNoteSentAt` |
| T − 1.5 h | **Wingman hint reveal push** — the asymmetric tip is unmasked at this gate (the mobile serializer enforces it independently, through `preDateBriefingVisibility`) | `wingmanSentAt` |
| T − 1 h | **Anonymous proxy chat opens** (feature-flagged) for **every** scheduled date — no questionnaire precedes it since 2026-09-26 — and each side is told on its own rail (the "Enter chat" card on Telegram, a push on the app); the Live Activity advances to `chat_open`. Moved out from T−30m on 2026-09-04, which also lifted it clear of the spotter beat — the two used to push the same card from two different sweeps in the same tick. | `proxyOpenedAt` |
| T − 45 min | **Date Terminal invite** (Telegram-only) — one DM per side with a single `web_app` button, "🎟 Open the Date Terminal" (Contact Sync, §6.4a). Step 2d of the tick, `sendDateTerminalBeats` (`services/date-terminal-invite.ts`); anchored on `DATE_RADAR_LEAD_MINUTES`. See below. | `terminalInviteSentAt` |
| T − 15 min (until T + 30 min) | **Date Terminal reminder** — the same button, anchored on `DATE_BUMP_OPENS_MINUTES`, still sent up to `DATE_TERMINAL_REMINDER_GRACE_MINUTES` (30) after the date time. See below. | `terminalReminderSentAt` |
| Date moment | (no automated action — users meet in person) | — |
| T + 2 h | **Anonymous proxy chat auto-closes** (feature-flagged) | `proxyClosedAt` |
| T + 2 h | **Pre-date briefing leaves the app** — no message; `iceBreakers` / `wingmanHint` on `/v1/matches/current` come back empty (`preDateBriefingVisibility`, `PRE_DATE_BRIEFING_CLOSE_AFTER_HOURS`). The iOS «Сегодня» card shows the briefing for as long as the server returns it, and the match stays `scheduled` until T+24h (2026-09-15) | — (time window) |
| T + 24 h | **"Did you actually meet?"** on Telegram, then the **feedback prompt** — each side on its own rail (DM and/or push — see below); LLM parses positives/negatives and updates `negativeConstraints` accordingly | `feedbackPromptedAt` |

### Date Terminal invite and reminder (T-45m / T-15m, Telegram-only, 2026-09-11)

The bot's way into the Date Terminal (§6.4a), sent by step 2d of
`runDateLifecycleTick` (`sendDateTerminalBeats`,
`services/date-terminal-invite.ts`). Both are one DM per Telegram side with a
single inline `web_app` button, "🎟 Open the Date Terminal"; copy keys
`dateTerminalInvite`, `dateTerminalReminder`, `dateTerminalBtn` in
`packages/shared` i18n (en/ru/uk/de/pl).

- **Invite at T-45m, reminder at T-15m, the reminder still sent until T+30m.**
  The windows are disjoint, so a process that was down across T-45m sends only
  the reminder.
- **Exactly-once per match** via `Match.terminalInviteSentAt` /
  `Match.terminalReminderSentAt`, each claimed BEFORE the DM goes out.
- **Skipped:** legacy rows whose stored venue coordinates are the route
  midpoint (recognised by `venueMidpointLat` being null); app-only users — the
  invite has no push leg; a pair that has already synced, whose reminder is
  claimed silently; and the demo entirely, which replays the lifecycle on a
  shifted clock while the terminal reads the real one — the same structural
  limit as the Date Bump (DEMO_MODE.md).

### The spotter sign and the one-tap vibe read (2026-09-01)

Two beats added to the date-day card, both native-only (the Telegram rail has no
surface for either).

**The spotter sign** answers "which of them is he" without showing a face. It is
a pure function of the match id (`spotterSignFor`), so both pushes carry the same
SF Symbol and colour without a column, a migration, or a write that could succeed
on one side and fail on the other — and a re-delivered push cannot contradict the
first one. What travels with it is the partner's arrival as a **fact**: the
proximity route (`POST /v1/dates/:id/proximity`) fires `notifyPartnerArrived`
**only on the transition** to present, never on the five-second ping, and the
payload carries no distance and no coordinate — the same masking the radar
response already applies. The partner's first name rides along on this stage
alone, and the client renders it in exactly one place: the expanded Dynamic
Island, which the phone's owner opens deliberately.

**`tableHint` is declared by the client and never sent by us.** There is nowhere
in the product a person writes "by the window"; inventing one would be the
dead-button anti-pattern in text. The slot waits for the surface that fills it,
exactly as `chat_open` waited for the chat.

**The vibe read** (`POST /v1/matches/:id/vibe-telemetry`) is one tap with three
values, and it is **not** the T+24h feedback form. The form refuses anything
before the date is closed out and demands two considered answers, so pointing a
lock-screen button at it would have meant either loosening its gate or inventing
a chemistry number on the user's behalf — and that blob is the only thing the
product learns whether a date worked from. The tap writes to the audit log
(`match_events`) with the rating in `metadata`, changes nothing the form later
says, and takes that side's card down. Answering twice succeeds: the second call
is almost always a retry of a request whose response was lost.

### Pre-date safety brief (both rails since 2026-08-12)

The brief is the checklist itself — a Markdown DM naming the venue. What did
not exist until §5.4 is any way for it to reach a woman who lives in the app:
this module filtered recipients on `telegramId > 0n` while carrying a comment
saying mobile users "get safety briefs via push", and nothing sent one. Same
shape as `pitch.ts`'s claim about the drop, and the ninth instance of one
mechanic existing on a single surface.

**Two defects sat inside that one filter, and the second is worse.** A woman on
the app got nothing. A woman who signed in through Telegram — a REAL positive
id on an account the bot cannot message (§1.1) — also got nothing, on a rail
that reported success. **Gender selects the recipient; `platform` selects the
rail** (`telegramReachable` / `pushReachable`), and both are attempted, so a
`both` account is told twice.

**The push is one of exactly two notifications allowed through Focus**
(ARCHITECTURE → APNs). It arrives ninety minutes before she walks out to meet a
stranger and is worthless afterwards, which is the whole test for that level.

**It names neither the partner nor the venue.** The first is §3.3's rule for the
public lock screen. The second is this brief's own: a safety notice that
announces where this woman will be tonight, to anyone who picks up her phone,
argues against the thing it was sent for. The push says a checklist has arrived;
the checklist stays in the DM and in the app.

### Did you actually meet? (T+24h, Telegram-only, added 2026-08-15)

The product could not tell whether a date happened. `Match.status = 'completed'`
is stamped by the T+24h feedback prompt **whether or not anyone showed up**, and
the form asks about chemistry (1–10) and a second date — questions *about* a
date, which read as absurd to someone who was stood up. So no-show was
unmeasurable, and the "share of no-shows among sold tickets" quality metric
existed only on paper.

Telegram now gets one plain question before the form, with two buttons.

**The question is asked ALWAYS; evidence changes its wording, not whether it is
asked.** The tempting design was the other one — read the proxy chat and what
the user told the concierge, run it through a cheap model, and skip the question
when it looks like they met. That is wrong, and the two failure modes are not
symmetric. Asking someone who already told us reads as *an agent with no
memory*: mildly annoying, recoverable. Deciding for someone who said nothing
writes a fabricated fact into the one metric the feature exists for, and greets
a person who was stood up with "how did your date go?".

The "no memory" complaint is not actually about being asked — it is about being
asked **as if nothing is known**. *"Yesterday you wrote that she never came —
still right?"* both asks and remembers.

So the rule that holds the whole thing up: **the evidence classifier never
writes `dateAttended*`.** It picks one of three wordings. Wrong guess costs an
odd sentence; only a human answer becomes data.

- **Evidence, and its honest strength.** Definitive signals never reach the
  classifier and shouldn't: an emergency cancellation leaves the match in
  `cancelled`, which never reaches T+24h, and the partner's own answer is
  already a fact read directly. What is left is what the user told the
  concierge after `agreedTime` (strong but rare) and the pre-date proxy chat
  (**a hint only** — "I'm at the door" is not "we met"; one of them may have
  left). A pair with neither gets the neutral question and **no model call at
  all**, which is the overwhelming majority, so the feature costs ~nothing in
  tokens.
- **Strictness is structural, not a request in the prompt.** Anything short of
  a `high`-confidence unambiguous verdict collapses to the neutral wording.
- **Privacy boundary.** `proxy_messages` hold the *other* user's words, which
  the product deliberately keeps out of the agent's timeline
  (`withRedactedSummary`). The classifier may read them server-side; its output
  is a three-value enum, and no fragment of that text ever reaches the agent's
  prompt or the user's screen. Quoting it back ("you said you were at the
  door") would be a leak of one user to another, not a nicer sentence.
- **"Yes"** records attendance and hands over to the existing feedback
  invitation, unchanged.
- **"No"** does *not* lead to the chemistry form. It asks what happened, with
  four outcomes (`no_show_partner` / `no_show_self` / `both_rescheduled` /
  `other`) — the distinction that separates "the date didn't happen" from
  "somebody was left waiting", which matters both for the metric and for any
  future refund decision. The closing message **promises nothing**: there is no
  ticket refund and no priority boost on this path today, and a surface must
  not invent one (the same rule the §3.4 expiry card follows).
- **Attendance is a property of the PAIR.** One credible answer settles the
  match; the two columns exist because the sides can disagree, and a
  disagreement is a real state (`disputed`) that belongs on screen rather than
  silently collapsed. `unknown` (nobody answered) is never rendered as "didn't
  happen" — silence after a date is the ordinary case.
- **Free text is captured, bounded.** The question is asked in prose, and prose
  invites a typed reply, so an unambiguous short answer is recorded
  (`awaiting_attendance`, 24h, `services/match-flow-claim.ts`). Matching is on
  the **whole utterance**: "нет мы встретились" opens with "нет" and means yes.
  Anything ambiguous falls through to the concierge, which can see the open
  question in the timeline.

**Known gap — the ticket.** §3.5b returns a ticket whenever a match dies
*before* the date. A no-show is a match that reached `scheduled`, whose time
passed with nothing cancelled — so today the ticket burns for **the person who
showed up**. This feature is the first thing that makes such cases visible;
whether to refund them is a separate founder decision, deliberately not taken
here (0 tickets have ever been sold).

**Telegram-only for now.** The push rail keeps sending the existing feedback
invitation unchanged, so nothing regresses for app users — but they are not
asked about attendance, and `/v1/me/feedback/pending` is untouched. The native
question is a follow-up that owes a `/v1/*` addition.

### Post-date Feedback UX

**Both surfaces since 2026-08-09; before that the app could not reach this at
all.** The form existed only as a Mini App signed with `initData`, the T+24h
prompt that carries its link was a Telegram DM guarded on `telegramId > 0`, and
`/v1/matches/current` stops returning the match the moment it turns `completed`
(`ACTIVE_MATCH_STATUSES`). So an app user was not merely unable to submit —
they were never told a form existed, and could not have found it if they had
been. Three holes in one feature, and the third is the one with no Telegram
equivalent: **there, the DM IS the discovery.**

The native rail is `GET /v1/me/feedback/pending` + `POST
/v1/me/feedback/post-date` (JWT). Everything either surface decides —
what counts as an answer, how the structured inputs become the one text blob
the analyst reads, what else the answer writes — lives in
`services/post-date-feedback.ts`, so the two cannot build two datasets out of
the same question. Each keeps only its own idiom: initData vs. JWT, and a
thank-you DM vs. none (the app rail cannot assume a bot chat exists, and a
message nobody receives is not a confirmation).

**The invitation now follows each side's own rail.** `telegramReachable`
(`services/telegram-reach.ts`) decides the DM and `pushReachable` the push, so
a `both`-platform user is told twice and an app-only user is told at all. The
old `telegramId > 0` guard stopped being a reachability test when Telegram
login shipped — see §1.1.

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

**One rail for every pair (founder decision 2026-09-26).** Every scheduled
date gets the anonymous chat at T-1h, on both surfaces, and nothing else:
handles never change hands before the date. Until then a T-3h questionnaire
(`sendOffers`, `COORD_OFFER_HOURS`) offered the female participant — or both
sides of a same-sex pair — three ways to find each other: share her Telegram
(A), ask for the partner's (B), or this chat (C), and the chat opened only for a
pair that ended up on C. The app already skipped the question (2026-09-07: any
pair with the app in it was put on C without asking), so the pair it still
failed was the Telegram-only one whose initiator picked a handle, or never
tapped the offer — no chat at all in the last hour before meeting. The offer,
its handlers and its four contact cards are gone; the `coord*` columns stay on
`Match` for the rows written before and are no longer read. Buttons on offer
cards already sitting in chats (`coord:m:*`, `coord:approve:*`,
`coord:decline:*`) are answered and stripped, nothing else
(`handleRetiredCoordCard`).

The relay lives in `services/proxy-chat.ts`, shared by the Telegram handler and
`GET/POST /v1/matches/{id}/chat` (JWT), so the two surfaces cannot drift on the
window, the log, or what the partner receives. Delivery follows the partner's
OWN rail — a DM, an APNs push carrying the message text, or both.

**Delivery states (2026-09-07).** A sender is told how far their own message
got, and every state is a fact the server holds rather than an inference:

| State | What it means | Where it comes from |
|---|---|---|
| `sent` | logged, and nowhere else yet | the `proxy_messages` row |
| `delivered` | a rail the partner has ACCEPTED it | `ProxyMessage.deliveredAt`, stamped when `sendMessage` resolves or APNs takes the push |
| `read` | the partner's cursor is at or past it | `Match.proxyReadAtA/B`, moved by `readProxyChat` |

Three things about this are load-bearing:

- **It is computed server-side** and shipped as `ProxyChatMessage.status`, not
  as raw timestamps. Two surfaces deriving "read" independently would sooner or
  later derive it differently, and this is a claim about another person.
- **The cursor moves only in `readProxyChat`**, which only the app calls, and
  only while its chat screen is on the phone. That is the whole basis for the
  claim. A background refresh or a prefetch routed through that function would
  turn it into a lie.
- **A partner on the Telegram rail never reaches `read`.** The Bot API gives
  bots no read receipts, so `delivered` is the honest ceiling there, and the
  third state is in practice a signal that both sides are on the app. Clients
  render its absence as "not known to be read", never as "unread".

There is no `failed` state: a send that fails never becomes a row, so the client
has an error to show and no status to draw.

The window is derived from `agreedTime` (T-1h … T+2h) rather than read from
`proxyOpenedAt`/`proxyClosesAt`: those are written by the 2-minute tick, which
would open the window up to two minutes late. The stamps keep their
real job — the pair was told — and `proxyClosedAt` is still a force-close.
`/v1/matches/current` exposes the window (`proxyChatOpensAt/ClosesAt`) only
while the flag is on and the date is `scheduled`: the window itself asks for
nothing but a time now, and without those two checks the app would be handed
an Enter button into a 404 with the flag off.

**Reachability is `platform`, not `telegramId > 0`.** The open and close
notices go to Telegram only where `telegramReachable` holds: a Telegram-login
app account carries a REAL id the bot cannot message, and the 403 it returns
would read as that person blocking the bot.

- **The anonymous chat.** Opens at T-1h for every scheduled date (no choice,
  no consent — an offline partner must never strand the other side),
  auto-closes at agreed time **+ 2h**. The cron DMs both an **Enter chat**
  button; tapping it sets the `coordination_chat` session state (entry is
  explicit, so normal bot use — `/menu`, settings, photos — is never hijacked
  into the relay). While in the chat, plain text is relayed bot→partner; every
  relayed message carries **Leave chat** + **Report** controls and is logged to
  `ProxyMessage`. Media is rejected (text-only, closes the face/metadata-leak
  bypass). The relay re-checks per message, so a stale session self-heals
  after close. **One gate for both rails** (`proxyChatAcceptsMessages`,
  `services/proxy-chat.ts`): the match must still be `scheduled` — a date
  cancelled, frozen or blocked inside the window stops relaying at once, not at
  T+2h — and the window is open by the schedule (`agreedTime`) or by the tick's
  stamps. The Telegram relay delivers through the same `relayProxyMessage` as
  the app. The close notice goes only to dates that are on or happened; a
  called-off date's window is stamped closed silently. See the "NO IN-APP CHAT"
  carve-out in Core Principles.

**The chat's opening is a rendered PNG card, not a bare text DM
(2026-08-01, `services/coordination-card`).** One message: the card, the
localized copy as its **caption**, and the "Enter chat" keyboard, exactly like
the date card (§3.7a). The card holds a white polaroid frame with the portrait
**withheld** behind a burgundy halftone and the brand mark reading through it —
the anonymity of the relay made visual. The **close** notice keeps its plain
text — there is no card for "it's over". (Until 2026-09-26 the family had four
more cards — the T-3h offer, the contact ask, a revealed contact and a declined
ask — three of them carrying a real face; they went with the questionnaire.)
**The card carries the beat; the message carries what you act on:** nothing on
a PNG is tappable or reachable by a screen reader, so instructions and buttons
stay in the caption and the keyboard.

Cards render in the **recipient's** `User.theme` and language, like the other
PNG cards. Delivery is fail-open by construction (`coordination-card/send.ts`):
a null render, a caption over Telegram's 1024-char photo limit, or a rejected
`sendPhoto` all fall through to the plain text DM the flow sent before. This is
not decoration-grade tolerance — the DM lands ~1h before the date and is the
only way the pair can find each other, so it must degrade rather than fail.
Inert with `COORDINATION_FEATURE_ENABLED` off.

### Emergency Protocol

`handlers/date/emergency.ts`:

**Both surfaces since 2026-08-07.** Everything irreversible — the status
compare-and-set, the peer's priority boost, the ticket refunds — lives in
`services/emergency-cancel.ts`, shared by the Telegram handler and the native
`POST /v1/matches/{id}/cancel` (JWT). Each surface owns only how it *asks* and
how it *tells the partner*: either surface quotes the reason verbatim in a
Telegram chat for a reachable Telegram peer; iOS also shows the outcome in the
app. They must not disagree about anything else, which is why the split is
where it is. A stale Telegram cancel button now answers with an alert and
retires its keyboard; a native caller sees 409 `stale_action` with the current
match status and refreshes Today immediately.

The same change fixed something that had been quietly false: the Telegram
handler's comment claimed a mobile peer got "a push notification dispatched
separately", and no such push existed anywhere. A mobile-only partner learned
their date was off only by opening the app. The service now pushes the peer on
either rail — **without the reason**, which is someone else's free text and
does not belong on a lock screen; it is shown where the recipient chose to look.

- **Any time while the date is on — from the moment it is booked.** There is
  no opening: `DATE_ALERT_HOURS` (T-5h) only times the reminder DM, and neither
  the service, the REST route, the Telegram handler nor the app ever checked the
  clock before it (founder decision 2026-09-26, which also retired the "window
  is open" copy). The cancel button is in the My Date hub for the whole
  `scheduled` period, the agent can surface it (`propose_cancel_date`), and the
  app's date card carries it; every consequence — the peer's boost, both ticket
  refunds, the Prime Time refund, the partner's push — runs the same however
  early. There is deliberately NO cancel button on the Telegram "date booked"
  confirmation card (founder decision 2026-09-26).
- **Only before the date starts.** `cancelScheduledDate` refuses once
  `agreedTime <= now` (the check is also in its compare-and-set), on the tap, the
  confirm and a late-arriving reason alike. It used to accept a cancel up to T+24h,
  so a date that had happened could be "cancelled" with any reason — both tickets
  refunded, the peer boosted and the outcome never asked (audit A13-M20). No
  grace window: a no-show belongs to the did-you-meet check.
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
