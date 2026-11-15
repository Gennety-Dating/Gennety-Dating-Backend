<!-- WHEN_TO_READ: Touching match outcome on /v1/matches/current, ticket-gate/expiry/chat-reply pushes, «did you meet?» on /v1, the app chat prompt surface, get_my_date, profiler asides, or chat voice dedupe. -->

# 2026-11-15 — app audit fixes that needed no founder decision

The founder asked for every audit fix that is important and needs no product decision from them. Product questions (feedback "what we learned", second date, paywall row, unpaid ticket, safety, reliability, rematch, freeze) wait for the founder. Backend commits `bcbbb831` (agent) and `3828ba6d` (statuses). Not deployed.

## Statuses

1. `/v1/matches/current` returns `lastOutcome {matchId, kind, penalized, at}` when there is no live match. It only covers matches that ended within `LAST_MATCH_OUTCOME_WINDOW_MS` (72 h) and that the user was shown.
   - `kind` is a plain string, not an enum, so a new kind does not break older apps.
   - Blind rule: the partner's decline is named only when both answers are on the row, which is exactly when Telegram reveals it. The partner's yes is named only to a side that stayed silent until expiry, which matches Telegram's "missed date".
   - The penalty is read from `EXPIRED_SILENT` event metadata, which `match-expiry.ts` now writes. Older expiries read as a warning.
   - The app shows the outcome once as a Today card, dismissed per match.
2. Expiry notices get an app push leg (`match.outcome`) with the Telegram text.
3. Ticket-gate pushes go to app-reachable users: `ticket.peer_paid`, `ticket.partner_covered` (once, on gate completion) and `ticket.refunded`.
   - A deadline push would need a new cron. Deliberately not done.
4. `POST /v1/me/feedback/attendance` uses the same writers as the bot's attendance handler.
   - The app asks «Вы встретились?» first.
   - «Нет» records the outcome and closes the form.
   - The notification's quick buttons skip the question.
   - An app talking to an older server falls back to the form.
5. The planning caption on Today appears only once the caller has answered.
6. Push titles «It's a match», «Venue locked in» and the wingman title moved to i18n.
7. Premium expiry push not done: it would reverse a 2026-08 decision (the push rail was deliberately not built). That decision's premise ("Premium can't be bought on iOS") may be outdated now that `PremiumStore` exists. Founder's call.

## Agent in the app chat

8. `buildSystemPrompt`, `describeActiveMatch` and the playbook take a surface (`tg` | `app`).
   - The app names native screens, App Store billing and pushes. It says «Gennety» instead of "concierge".
   - The Telegram prompt is byte-identical, proven by `prompt-tg-baseline.json`, so Telegram keeps "concierge" for now.
9. Profiler asides: when the chat ends on a profiler question, a reply that is a question or mentions match, date, ticket or venue goes to the agent instead of being stored as the answer. This is a cheap rule with no model call.
10. `get_my_date` is a read-only tool. It returns the date time in the profile zone, `CuratedVenue` details, the user's own icebreakers (only once the date card shows them), and the proxy window. For the partner it returns the first name only and nothing about decisions.
11. `matching` is a new activity step for standing, pause and resume. The iOS pacer shows a newly arrived step once a turn is older than 6 s.
12. `/v1/chat/voice` takes `clientMessageId` and dedupes like `/message`. It also reports activity steps.
13. The person card gets a line on dates so far, from the user's side only.
14. Long chats get their own digest as «Earlier in this chat». The digest is rewritten after the reply, at most once per `CHAT_SESSION_LONG_RESUMMARIZE_MESSAGES`.
15. `open_screen: wishlist` exists only for the app, behind the wishlist flag.
16. On the app surface, match times use the profile zone.
17. `chat.reply` push («Gennety ответил»):
    - It is sent when every request waiting on a turn has disconnected.
    - It is transactional: no quiet hours, no inbox row.
    - Its body is the first bubble.
    - The iOS send timeout is 180 s.
    - On foreground the app resends with the same `clientMessageId` (within 9 min) or matches the reply in history.

Demo mode: unchanged. The demo visitor and puppet are Telegram accounts, so no new push leg fires, and the Telegram prompt is byte-identical.
