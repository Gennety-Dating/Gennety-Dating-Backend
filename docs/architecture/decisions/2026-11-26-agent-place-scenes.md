<!-- WHEN_TO_READ: Touching place scenes in the app chat (`search_venues`, `get_my_places`, `show_place_scene`, `ChatPlaceScene`, token `places`), the delivery links, or the proactive place tip — or wondering why a scene has no dishes, no walking minutes from «where I am», or why the tip is regulars-only. -->

# 2026-11-26 — place scenes in the app chat (server)

**Kind:** founder request (voice brief 2026-11-26), built on branch
`feat/place-scenes`; defaults below are the build's, each can change.

**What.** Answers about places become animated scenes after the reply
(`ChatPlaceScene`, seven kinds). The agent gets `search_venues` over the city's
catalog, `get_my_places` (their regular places, only with the frequent-places
opt-in) and `show_place_scene`; the server fills every fact. A proactive tip
worker posts a `regulars` scene near their regular places, off by default.
Spec: `docs/product/domains/agent-place-scenes.md`. The contract was fixed by
the iOS scaffold (`claude/chat-scenes`) and copied unchanged.

**Decided in the build.**
1. The model never writes a fact. Name, category, address, point, photo,
   rating, price, open now, hours, minutes and links come from `CuratedVenue`;
   versus rows of the model are qualities only (a digit in one drops it).
2. Ids handed out are the catalog id of the place's naming copy; any copy's id
   or the Google place id resolves to it.
3. Walking minutes come from a start the scene knows: a regular place or
   another catalog place. **Not from «where I am now»:** the server keeps no
   position of the person (frequent places drop every fix after matching it,
   the Date Radar keeps none), and the chat contract sends none. A scene
   without a start carries no minutes. Adding the phone's position to a chat
   turn would be a contract and privacy change — not done.
4. Regular places for the agent: top five by distinct days in the last 60, at
   least two days, hidden places out, never the days and never coordinates to
   the model. Home and work cannot appear because visits are only recorded at
   catalog venues.
5. «Open now» and the hours label are stored as shown at the time of the
   answer; only the photo link is re-signed on read (it expires after a day).
6. Delivery links are the providers' search pages by venue name; the brief's
   Glovo format was out of date and was replaced by the one the site serves
   now (checked read-only). Dishes only when a review names them — and no
   review text is stored anywhere, so there are none. Not done: asking Google
   for `reviews` (a billed Place Details field plus a schema change).
7. The proactive tip is the one part of agent-advisor phase 4 built ahead of
   the rest, because the founder's brief asked for it; item 9 of
   [2026-11-26-agent-concept-phase4](./2026-11-26-agent-concept-phase4.md)
   still holds for everything else. It is behind `AGENT_PLACE_TIPS_ENABLED`
   (false) and the founder-only preview list, reads its cadence from the
   stored scenes (no schema), respects quiet hours, daytime 11–20, the
   opt-in and «только мои свидания» (new muted kind `place_tip`), and stops
   for 30 days after two ignored tips. Its trigger is an event of the catalog
   (a place near their regulars that is new to them), not a timer message.
8. Not built: a proactive `delivery` tip (links only search, so «order from
   here» could name a place that does not deliver).
9. Tool status for the activity line: `search_venues` and `show_place_scene`
   read as «thinking», `get_my_places` as «remembering» — no new contract key.

**Deploy.** Not deployed; waits for the founder's «да»
([pending.md](../../operations/deploy-journal/pending.md)).
