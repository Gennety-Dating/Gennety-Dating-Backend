<!-- WHEN_TO_READ: You are changing the iOS bell's inbox (`/v1/inbox*`), admin announcements (`/admin/announcements*`, the `announcement-fanout` worker), the Today Live Pulse rows (`/v1/pulse`), or the chat context a notification hands to the agent (`context` on `/v1/chat/message`). Also read before adding a push type — it decides whether that type lands in the inbox. -->

## Inbox, announcements, Live Pulse and chat context

Four pieces that share one table. The founder's brief of 2026-09-13 asked for a
bell capsule on iOS, an "Обсудить с агентом" bridge into the agent chat, a
Perplexity-style activity list on Today, and admin-dispatched rich
announcements. The nine forks the founder decided — all "take the
recommendation" — and the calls made on the way are in the decision journal
(2026-09-13 — «инбокс, объявления, пульс и контекст чата»). The client half
lives in Gennety-iOS.

### Invariants

1. **The dot means unread, and nothing else.** `inbox_items.read_at IS NULL`
   is the bell's dot and `unreadCount`. A row the list would not show must
   never count (iOS decision 2026-09-08: «цифра обязана означать
   непрочитанное»).
2. **The inbox does not wait on notifications.** Rows are written for app users
   (`pushReachable`) whether or not a push token exists. Telegram-only accounts
   get none — they have no bell.
3. **The client sends a reference, never words.** Chat context is
   `{ kind: "inbox_item", id }`; the server resolves the text from its own
   rows. A tampered request cannot write into the system prompt.
4. **One conversation per person** (2026-09-04). Context attaches to a
   message; there is no thread, and it stops grounding after six hours of
   silence (`CHAT_CONTEXT_WINDOW_HOURS`, the same gap that cuts a topic).
5. **Nobody else, ever** (F4). The context block and the pulse carry the
   person's own application and ticket — never another guest's name, a
   description, a headcount or a ratio.
6. **Only real, bounded work spins** (F2). A pulse row is `processing` only
   while a job runs with a deadline it settles by. Between drops nothing runs,
   so nothing spins.

### What lands in the inbox (F5)

| Writer | Types | Why |
|---|---|---|
| `announcementFanoutTick` | `announcement` | Written in bulk before any push |
| `sendPushToUser` (one choke point, ~20 callers unchanged) | `INBOX_PUSH_TYPES` in `@gennety/shared`: `match.proposed`, `match.none`, `match.both_accepted`, `match.peer_decided`, `match.outcome`, `match.scheduled`, `match.wingman`, `match.cancelled`, `safety.brief`, `feedback.due`, `verification.outcome`, `event.recap`, `event.mutual` | News the person is waiting on |
| — | **not** `proxy.message`, `date.bump`, `venue_intent` | Each has its own surface |
| — | **not** `match.nudge`, `match.planning`, `match.deadline` | Reminders of news already in the inbox |
| — | **not** `event.round` | Several per evening, each stale by the next |

A new push type is OUT until someone adds it to the set. The push carries the
row's id as `inboxItemId`, so a tap marks exactly that row read.

Title and body are frozen at write time: the inbox records what the person was
told, not a re-render of current state. Rows are swept after 90 days.

### Announcements

Composed in the admin dashboard (`gennety-admin-dashboard` → Announcements),
stored in `announcements`. Venue and time are not columns: an announcement
about a party points at its `Event`.

Lifecycle, every move a CAS on `status`:

```
draft ──schedule──▶ scheduled ──(worker claims)──▶ sending ──▶ sent
  ▲                    │
  └────unschedule──────┘            draft | sent ──archive──▶ archived
```

- **Only a draft is editable.** After the worker claims a row, people are
  reading what was scheduled.
- **Audience** — `{ cityKeys?, languages? }`; an empty object means every app
  user in `active` or `paused`. Counted live at `POST /admin/announcements/audience-count`.
- **Media** (F3) — one image (JPEG/PNG/WebP ≤ 2 MB) or one MP4 (≤ 8 MB, ≤ 10 s,
  checked from the container header, not the Content-Type). A video needs a
  poster image before it can be scheduled. Private bucket
  `SUPABASE_ANNOUNCEMENT_BUCKET`; the app gets 24-hour signed URLs. The client
  plays a video once and rests on its last frame — no loop.
- **Preview** — `POST /admin/announcements/:id/preview { userId }` writes the
  same row the fan-out would (the unique `(user_id, announcement_id)` key), so
  the preview account is not sent a second copy; the fan-out refreshes that
  row's words to the scheduled version.
- **Fan-out** (`* * * * *`, never in demo) — inbox rows for the whole audience
  first, in batches of 500 with `skipDuplicates`; then pushes at ~10/s
  (`ANNOUNCEMENT_PUSH_INTERVAL_MS`). Quiet hours (23:00–09:00 Kyiv) hold the
  pushes and resume them on the first tick after nine; the inbox rows are
  already there. Someone who read it in the app overnight is not pushed.
  Restart-safe: claiming is a CAS, rows are unique, pushes resume from
  `pushed_at IS NULL`.
- **Push payload** — `type: "announcement"`, `inboxItemId`, `announcementId`,
  and the cover as `poster`, not `image`: the Notification Service Extension
  blurs every `image` (a face is the thing it protects), and a party poster
  has no face. `poster` still turns on `mutable-content`.

### Chat context

`POST /v1/chat/message` takes `context: { kind: "inbox_item", id }`;
`POST /v1/chat/voice` takes the same as form fields `contextKind` / `contextId`
(checked before Whisper is paid for). Someone else's id and a nonexistent id
both answer 404.

The user row stores a snapshot `{ kind, id, title }` in `messages.context`,
and `/v1/chat/history` returns it on that message so the chip survives a
reload — and survives the inbox row being swept. Each turn,
`buildChatMessages` finds the newest context-bearing user message inside the
six-hour window and appends a `>>>CONTEXT_DATA … <<<CONTEXT_DATA` block to the
system prompt: title, teaser, body, the founder's `agentBrief`, the event's
venue and wall-clock start in its own zone, and the person's own application
tier and ticket. No new tool, no write budget spent. F8: opening the chat
calls no model — the chip, the placeholder and up to three
`suggestedQuestions` do the greeting.

### Live Pulse

`GET /v1/pulse` → up to six candidate rows; the client picks what its scene
shows (at most three, only in the waiting / famine / paused / awaiting-peer /
planning scenes — F7).

| kind | state | Source | Opens |
|---|---|---|---|
| `drop_batch` | processing | `[previous batch, +20 min)`, until the person's match or no-match notice exists; `active` accounts only | Today |
| `venue_search` | processing | `negotiating_venue` with a scheduled `venueSelectionNextRetryAt`, attempts < 3; deadline = the retry's due time | Map |
| `event_application` | active | Own `waitlist_applications` row for an upcoming/live event; `status` approved / pending / waitlisted | The announcement about it, else chat |
| `announcement` | active → past | Own inbox rows of type `announcement`, last 7 days; hidden when an event row already opens the same item | Detail |
| `date_past` | past | Own `completed` match, last 14 days | Its inbox row, else chat |
| `chat_topic` | past | Two newest chat topics | Chat, scrolled to the topic |

Deliberately **no verification row**: `pending` has no start timestamp, so a
spinner there could not be bounded — the exact thing F2 forbids.

### Demo mode

The fan-out worker is not scheduled in demo (same rule as the no-match
notice): the demo database has no founder composing anything, and a visitor
must never receive a real party announcement. The inbox, pulse and chat
context routes behave as in production — an empty inbox and a pulse built
from the demo's own state are true answers there. The demo `.env` must name
`SUPABASE_ANNOUNCEMENT_BUCKET` explicitly, as it does every bucket.

### Not done, on purpose

- **Telegram delivery of announcements** (F9) — iOS only for now.
- **WebSockets** — polling plus APNs stays the house pattern.
- **An iOS event screen** — `/v1/events` is not in the contract; the only CTA
  is the agent.
- **Editing a sent announcement** — what people were sent stays what they were
  sent.
