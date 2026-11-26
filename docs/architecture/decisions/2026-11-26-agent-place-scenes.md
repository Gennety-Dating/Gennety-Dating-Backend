<!-- WHEN_TO_READ: Touching place scenes in the app chat (`search_venues`, `get_my_places`, `show_place_scene`, `ChatPlaceScene`, token `places`), the `reviews` board, or the proactive place tip — or wondering why there is no delivery, why review text is never stored, why the author name is not shortened, or why a scene has no walking minutes from «where I am». -->

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

---

# 2026-11-26 (later) — delivery dropped, a board of real reviews instead

**Kind:** founder request (voice, 2026-11-26), built on branch
`feat/place-scenes` before any deploy; supersedes items 6 and 8 above.

**Founder's reason.** «Давать ссылки на Bolt или Glovo — неправильно: мы
должны вытягивать человека в офлайн, а не давать повод сидеть дома. Лучше:
выбери день и заглянь туда, там приятно сидеть — и покажи пару НАСТОЯЩИХ
отзывов, приколотых к доске в чате.»

**What.**
1. Kind `delivery` is gone everywhere: no Glovo / Bolt / Wolt links, no
   delivery line in the prompt (the prompt now says outright: never ordering
   in), no delivery tip. A stored `delivery` scene is unreadable (no such
   kind) and links are `maps | web` only, filtered on read too.
2. New kind `reviews`: one venue and 2–3 real Google reviews the server
   fetches (Place Details (New), mask `reviews`, `languageCode` = their
   language) and chooses — 4★+ first, 60–220 characters after cutting at a
   sentence, about the place and the food over the service, recent, untranslated.
   The model picks only the venue and writes the title/subtitle in the spirit
   of «Выбери вечер и загляни — там приятно сидеть». Fewer than two usable
   reviews → refused, the model picks another kind. Dishes only when a chosen
   review names one. Contract: `ChatPlaceReview` and `reviews` on
   `ChatPlaceScene`, copied unchanged from the iOS spec.
3. Price: «Place Details Enterprise + Atmosphere», 1 000 free a month, then
   $25 per 1 000 (Google's pricing page, read 2026-11-26).
4. **Review text is never stored or cached** (Maps Terms 3.2.3(a)(iii) «copy
   and save … user reviews» and 3.2.3(b) no caching; the Places service terms
   allow caching only lat/lng for 30 days, the place ID indefinitely). Chosen
   handling of the `messages.attachment` tension: the row keeps the place ID
   and language (`reviewsFrom`) and no text; history fetches the board again,
   at most three scenes per read, and draws a scene it could not refill as a
   plain `venue`. Rejected: a TTL cache (no TTL is permitted for review text);
   stripping text after a period (no period is permitted).
5. The proactive tip may now be a `reviews` board (when Google has two usable
   reviews of the tipped place), else `regulars`. Still dark:
   `AGENT_PLACE_TIPS_ENABLED=false` + the founder preview list.

**Deliberate deviation from the brief.** The brief said the author is shown
as «first name + initial». Maps Terms 3.2.2(b) forbid modifying attribution,
and the Places policies require crediting each review's author. So the
author goes out exactly as Google's display name. The founder decides
whether to accept that or take it up with Google; changing it is one line in
`selectReviews`.

**Open, for the founder and the iOS contract.**
1. Attribution the contract cannot carry yet: the policies want the author's
   avatar and profile link when space allows (the avatar as the minimum) and
   access to the review on Google Maps. `ChatPlaceReview` has
   `author / rating / text / when / source` only. The server already keeps
   `authorUri`, `authorPhotoUri` and the review's `googleMapsUri` internally;
   adding three optional fields to `ChatPlaceReview` would let iOS show them.
   Until then the board shows the name and «Google Maps» and the Maps link
   opens the place.
2. Translations: Google translates reviews into the requested language; the
   policies recommend saying so. Untranslated reviews are preferred; the
   contract has no «translated» flag.
3. Places service terms §15.2: «must not use Google Maps Content from the
   Places API in conjunction with a non-Google map». The app's maps are
   MapLibre with our own tiles. This applies to every Places-sourced fact on
   any scene drawn on a map (and predates this change), not only to reviews.

**Deploy.** Still not deployed; same block in
[pending.md](../../operations/deploy-journal/pending.md), order unchanged.

