<!-- WHEN_TO_READ: You are touching place scenes in the app chat — `search_venues`, `get_my_places`, `show_place_scene`, `ChatPlaceScene` / the `place` field, the `places` chat-card token, the `reviews` board (Google reviews, their storage and attribution), the proactive place tip worker, or `AGENT_PLACE_SCENES_ENABLED` / `AGENT_PLACE_TIPS_*`. -->

# Agent place scenes — answers about places as scenes in the app chat

Status: built on branch `feat/place-scenes` (2026-11-26), not deployed.
Decision: [2026-11-26-agent-place-scenes](../../architecture/decisions/2026-11-26-agent-place-scenes.md)
(and its entry «delivery dropped, reviews instead»).
iOS plan: `docs/product/chat-place-scenes-plan.md` in the iOS repo (drawing,
motion, sound, haptics of each scene). Contract: `ChatPlaceScene` and its parts
in `openapi/gennety-v1.yaml`, copied byte-for-byte from the iOS scaffold.

## Why

The founder asked on 2026-11-26 that an answer about a place stops being a text
bubble: a venue opens as a postcard out of the map, recommendations are dealt
as cards, the person's regular places become a constellation with a new place
beside them, a place worth an evening comes with a couple of real reviews
pinned to a board, opening hours turn into a dial, a walk into footsteps, and
two places fight a duel. The agent should also tell the person, unasked, about
a good place near where they already go.

The same day the founder dropped delivery: «давать ссылки на Bolt или Glovo —
неправильно, мы должны вытягивать человека в офлайн, а не давать повод сидеть
дома». No scene, link, prompt line or tip ever points at ordering in.

## Phase 1 — The contract and the gate

1. One card type for every scene: `ChatPlaceScene`, with `kind` one of
   `venue`, `picks`, `regulars`, `reviews`, `hours`, `route`, `versus`.
   Links (`ChatPlaceLink.provider`) are `maps` or `web` only; a stored link of
   any other provider is dropped on read.
   - It rides `place` on the `/v1/chat/message` and `/v1/chat/voice` replies
     and on `ChatHistoryMessage`, and is drawn after the reply text.
   - A build lists `places` in `X-Gennety-Chat-Cards` to get it. A build that
     does not never gets the tools, the prompt block or the field; history
     keeps the reply text for it.
   - One card per reply: a scene never shares a reply with a wishlist card, an
     offer, the guide, screenshots or a vibe card.
2. `AGENT_PLACE_SCENES_ENABLED` is on unless set to `false`, like the vibe
   cards. Off, every turn loses the three tools and the prompt block. Scenes
   already stored stay readable in history.
3. Telegram never gets the tools: they need the app header.
4. Demo mode: the same behaviour; the demo bot is Telegram and sees nothing.

## Phase 2 — Finding places

1. `search_venues` reads the person's city's `CuratedVenue` rows (their home
   city when it is a market, else the default market), active only.
   - Copies of one place (the catalog keeps a row per university domain) fold
     on the Google place id; the operator's best copy names it and hands out
     its id, the best copy with a photo lends the photo.
   - Operator-blocked names and rows without a point are dropped. Every
     category is kept, museums and parks too: this is where a person goes,
     not what we propose for a first date.
   - Arguments: `query` (name, street, district, cuisine, vibe — words are
     matched against the name, address, editorial summary, primary type, tags
     and category words in five languages), `category`, `near` (an id from
     `get_my_places` or an earlier search), `open_now`, `limit` up to six.
   - Ranking: words matched, then walking distance from `near` — or, without
     it, places within 1.5 km of one of their regular places first — then
     Google's rating weighted by its count.
   - The result is compact: id, name, category label, address, rating and
     count, price level, open now and the hours label, walking minutes from
     `near`, the nearest of their regular places with minutes, whether the
     place is one of their regulars, a 140-character summary, three tags, and
     no dishes and no reviews (those exist only on a `reviews` scene).
2. The catalog of a city is read once per ten minutes per process, and inside a
   turn only when a place tool is called.
3. Opening hours are computed from the stored `openingHours` periods and
   `utcOffsetMinutes`, never asked from a provider.
   - Open now, the label («до 23:00», «откроется в 9:00», «откроется завтра в
     9:00», «сейчас закрыто», «круглосуточно»), today's intervals and the
     venue-local time.
   - An evening that runs past midnight is one window: at 01:30 it reads «до
     2:00», and today's intervals show both yesterday's tail (`00:00–02:00`)
     and today's evening (`18:00–02:00`). A close at midnight reads `00:00`; a
     whole day reads `00:00–24:00`.
   - No hours or no offset: open now, the label and the intervals are null or
     empty — never a guessed «closed».
4. Walking: the straight line × 1.3, at 80 m a minute. Beyond 5 km the scene
   carries the distance and no minutes.

## Phase 3 — Their regular places

1. `get_my_places` exists on a turn only when the person has frequent places
   switched on (`users.frequent_places_opt_in`), and so does a `regulars`
   scene.
2. It returns at most five places, ranked by distinct days with a visit in the
   last 60 days, at least two days each, from `user_place_visits` and the dates
   they attended — the two sources `frequent-places.md` counts.
   - Only catalog places: a visit is only ever recorded at a catalog venue, so
     home and work can never appear.
   - Places they hid from their profile are left out.
   - The model gets the id, name, category and day count, never the days and
     never coordinates; the server puts the catalog points on the scene.
3. Their regular places also rank `search_venues` (Phase 2).

## Phase 4 — The scene

1. The model passes only the kind, the title and subtitle, the venue ids with
   an optional reason and up to three tags each, the anchor ids, the versus
   rows of qualities, dish names and a footnote. The server fills every fact:
   name, localized category, address, point, photo, rating, count, price, open
   now, the hours label, today's intervals, the local time, walking minutes and
   distance, links.
2. Validation:
   - unknown ids drop out, one place named twice counts once, and a scene with
     no valid venue is refused;
   - picks need 2–3 places, versus exactly two, every other kind one (extra
     places are cut);
   - `regulars` is refused without the opt-in or without regular places;
   - `route` is refused without a start (`anchor_ids[0]`: a regular place or a
     catalog place);
   - `reviews` is refused when Google gives fewer than two usable reviews
     (or the place has no Google place ID) — the model is told to pick
     `venue` or `picks`; `delivery` is no kind and is refused as `bad_kind`;
   - the title is cut to 40 characters, the subtitle 80, a reason 70, a tag
     24, the footnote 90, a versus label and value 18, the verdict 40.
3. Kinds that need the server's own words:
   - `regulars` and `route` get the subtitle «4 мин от Win Bar» from the
     walk the server computed; `regulars` carries their places as anchors
     with their day counts, `route` its one start.
   - `versus` starts with the rows the server knows — rating, price
     («₴₴»), walking minutes when there is a start — then up to five rows of
     the model's qualities («Шум: громко / тихо»). A model row that repeats a
     server row or holds a digit is dropped. No winner given: the rows decide.
   - `venue`, `hours`, `route`, `regulars` and `reviews` get a Maps link when
     the catalog has one.
4. The photo is stored as the catalog id of the copy that has one and signed
   again (`/v1/venues/:id/photo`, card width, a day's validity) on every read;
   everything else except review text is stored as shown, so history draws the
   scene as it was — including «open now» at the time of the answer. Reviews:
   Phase 5.
5. The model reads `[Place scene (venue) after this reply: «Win Bar» (id …)]`
   under its own earlier reply, so a follow-up can reuse the ids.
6. A turn whose closing call says nothing after a scene gets «Смотри:» in the
   person's language.

## Phase 5 — Reviews

1. What the founder asked (2026-11-26): «выбери день и заглянь туда, там
   приятно сидеть» — one venue and two or three REAL Google reviews, pinned
   to a board in the chat.
   - The model picks the venue id and writes the title and subtitle in that
     spirit; it never writes, quotes, sums up or paraphrases a review, and its
     tool result says so.
   - The server asks Google and chooses the reviews
     (`services/place-reviews.ts`).
2. The request: Place Details (New), `GET places/{placeId}?languageCode=<their
   language>`, field mask `reviews` only — every other fact on the scene comes
   from our catalog. Google returns up to five reviews, most relevant first,
   the text translated to the requested language where it was written in
   another one (`originalText` keeps the original).
   - Billing: a mask holding `reviews` bills the «Place Details Enterprise +
     Atmosphere» SKU (Google's data-fields table, read 2026-11-26:
     https://developers.google.com/maps/documentation/places/web-service/data-fields).
     Price (https://developers.google.com/maps/billing-and-pricing/pricing,
     read 2026-11-26): 1 000 free a month, then $25.00 per 1 000 up to
     100 000, $20.00 to 500 000, $15.00 to 1 000 000, $7.50 to 5 000 000,
     $2.28 above.
   - One request per `reviews` scene shown live, one per tip that picks a
     place, and one per `reviews` scene on each history read (item 5), at
     most three per read.
3. Selection, all of it server-side and pure (`selectReviews`):
   - usable: an author name (attribution is required), a rating of at least
     3, a text of 60–220 characters after cutting;
   - cutting: whitespace collapsed; a text over 220 characters is cut after
     the last whole sentence that fits («.», «!», «?», «…», closing quotes
     included, a decimal point is no end); no sentence end within 220 → not
     usable. Never cut mid-sentence;
   - order: 4★ and above first; then reviews about sitting there, the room
     and the food (word stems in five languages) over complaints about the
     service; then the recent (publish time, two years scale); then the ones
     written in the person's language over ones Google translated; Google's
     own order breaks ties;
   - the best three go on the board; fewer than two usable → the scene is
     refused (Phase 4).
   - `when` is Google's localized relative time
     (`relativePublishTimeDescription`, «2 недели назад»), `source: "google"`.
   - Dishes (0–3): the model may pass names it expects; the server keeps one
     only when a chosen review names it literally (`groundDishes`).
     Otherwise none.
4. Google's terms and policies, read 2026-11-26, and what follows from them:
   - Google Maps Platform Terms of Service
     (https://cloud.google.com/maps-platform/terms, last modified 2026-08-26),
     3.2.3(a)(iii): no «copy and save business names, addresses, or user
     reviews»; 3.2.3(b): no caching «except as expressly permitted under the
     Maps Service Specific Terms».
   - Service Specific Terms
     (https://cloud.google.com/maps-platform/terms/maps-service-terms, last
     modified 2026-11-24), §15.3 Places API: only latitude/longitude may be
     cached, up to 30 days. The Places policies
     (https://developers.google.com/maps/documentation/places/web-service/policies)
     add that the place ID is exempt and may be stored indefinitely.
   - So review text is cached NOWHERE — no memory cache, no table, no TTL.
     There is no allowed period to strip after: it is never stored at all.
   - Terms 3.2.2(b): attribution is displayed and not modified, and the
     policies require crediting the author of every review shown (avatar,
     name and profile link when space allows; the avatar at the very least),
     a clear notice of how reviews were ordered and filtered, and access to
     the review on Google Maps.
   - Therefore the author goes out exactly as Google gives the display name,
     not reduced to «first name + initial» as the founder's brief said — that
     would be modifying attribution (decision record, open question).
   - The notice is the scene's footnote, written by the server in their
     language (`placeReviewsNotice`: «Отзывы из Google Maps. Мы выбрали
     свежие и хорошие — о месте и еде.»), replacing any model footnote. The
     Maps link of the scene opens the place, where every review can be read.
   - The internal review keeps the author's profile and avatar links and the
     review's own Google Maps link; `ChatPlaceReview` has no field for them
     yet, so they are not sent (open question — see the decision record).
5. Storage and history (the tension: a chat reply is stored in
   `messages.attachment`):
   - The stored scene keeps `reviews: []` and `reviewsFrom: { placeId,
     language }` — a Google place ID, which may be stored, and the language
     it was asked in. Review text never enters the row
     (`storedPlaceScene`), and a row that somehow held some is never read
     (`readPlaceScene` always returns `reviews: []`).
   - The live reply carries the board from memory.
   - `GET /v1/chat/history` fetches the board again for the `reviews`
     scenes of the page, newest first, at most
     `PLACE_REVIEWS.historyRefetchMax` (3) per read
     (`refreshHistoryReviews`), and re-checks the dishes against the fresh
     texts. History may therefore show newer reviews than the first answer:
     they are always Google's current ones.
   - A scene without a board (Google failed, the reviews changed, beyond the
     three) is drawn as a `venue` scene: same venue, no dishes, no notice.
6. Demo mode: the same; the demo bot is Telegram and never sees scenes.
7. Not done: a `reviewSummary` (Google's AI summary — same SKU, but it is
   Google's words about the place, not the people's); storing reviews or
   snippets in `CuratedVenue` or `PlaceCache` (forbidden, above).

## Phase 6 — The proactive tip

1. A worker every 30 minutes (`workers/place-tips.ts`) may post an assistant
   message with a scene of a catalog place near the places the person keeps
   going to, that they have never been to: a `reviews` board when Google has
   two or three usable reviews of it (one billed request per tip), else a
   `regulars` scene. Never anything about delivery.
2. Off by default: `AGENT_PLACE_TIPS_ENABLED=false`, and the founder's preview
   list `AGENT_PLACE_TIPS_USER_IDS` (`services/feature-preview.ts`).
3. Who gets one:
   - frequent places on, not banned, an app account (`platform` mobile or
     both), a visit in the last 60 days, not muted by «только мои свидания»
     (kind `place_tip` in `notification-mute.ts`);
   - their local daytime, 11:00–20:00, and never in the quiet hours of their
     zone;
   - at most one tip per three days; after two tips in a row with no message
     from them after either, none for 30 days;
   - a place within 700 m of one of their regular places, with a photo, not
     known to be closed now, with no visit of theirs ever and never tipped
     before; the best by rating weighted by count, a place added to the
     catalog in the last 30 days first among equals.
4. The line under the scene is a shared-i18n sentence («Kanapa — в 4 мин от
   Win Bar, и это место для тебя новое.»); no model call. It lands in their
   newest chat when it was active in the last six hours, else in a new chat,
   with a push on the chat-reply rail (`chat.reply` with the chat id, title
   «Новое рядом с твоими местами»). No inbox row.
5. The cadence is read back from the stored scenes (`proactive: true` on the
   attachment); there is no table of its own.
6. The `reviews` tip is stored like any reviews scene: no review text in the
   row, fetched again when history is read (Phase 5).
7. Demo mode: the worker never runs for the demo bot (no app accounts there).

## Files

1. `packages/shared/src/place-scenes.ts` — kinds, limits, link providers,
   the review selection limits, the tip cadence, the prompt block.
2. `packages/shared/src/i18n.ts` — `place*` labels in five languages,
   `placeReviewsNotice`.
3. `apps/bot/src/services/place-catalog.ts` — the city catalog, the clock, the
   walk, the regular places, the search.
4. `apps/bot/src/services/chat-place-scene.ts` — the three tools, the scene,
   storing without review text, reading back, the history refresh, the view,
   the history note.
5. `apps/bot/src/services/place-reviews.ts` — the Google request, cutting at
   a sentence, choosing the reviews.
6. `apps/bot/src/services/chat-agent.ts`, `public/routes/chat.ts` — wiring.
7. `apps/bot/src/services/place-tips.ts`, `workers/place-tips.ts`,
   `index.ts` — the tip.
