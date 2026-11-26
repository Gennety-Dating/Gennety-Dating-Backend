<!-- WHEN_TO_READ: You are touching place scenes in the app chat — `search_venues`, `get_my_places`, `show_place_scene`, `ChatPlaceScene` / the `place` field, the `places` chat-card token, delivery links (Glovo, Bolt Food), the proactive place tip worker, or `AGENT_PLACE_SCENES_ENABLED` / `AGENT_PLACE_TIPS_*`. -->

# Agent place scenes — answers about places as scenes in the app chat

Status: built on branch `feat/place-scenes` (2026-11-26), not deployed.
Decision: [2026-11-26-agent-place-scenes](../../architecture/decisions/2026-11-26-agent-place-scenes.md).
iOS plan: `docs/product/chat-place-scenes-plan.md` in the iOS repo (drawing,
motion, sound, haptics of each scene). Contract: `ChatPlaceScene` and its parts
in `openapi/gennety-v1.yaml`, copied byte-for-byte from the iOS scaffold.

## Why

The founder asked on 2026-11-26 that an answer about a place stops being a text
bubble: a venue opens as a postcard out of the map, recommendations are dealt
as cards, the person's regular places become a constellation with a new place
beside them, delivery shows where to order and what, opening hours turn into a
dial, a walk into footsteps, and two places fight a duel. The agent should also
tell the person, unasked, about a good place near where they already go.

## Phase 1 — The contract and the gate

1. One card type for every scene: `ChatPlaceScene`, with `kind` one of
   `venue`, `picks`, `regulars`, `delivery`, `hours`, `route`, `versus`.
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
     an empty `groundedDishes` list.
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
   - `delivery` is refused in a city no linked service covers;
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
   - `venue`, `hours`, `route` and `regulars` get a Maps link when the catalog
     has one.
4. The photo is stored as the catalog id of the copy that has one and signed
   again (`/v1/venues/:id/photo`, card width, a day's validity) on every read;
   everything else is stored as shown, so history draws the scene as it was —
   including «open now» at the time of the answer.
5. The model reads `[Place scene (venue) after this reply: «Win Bar» (id …)]`
   under its own earlier reply, so a follow-up can reuse the ids.
6. A turn whose closing call says nothing after a scene gets «Смотри:» in the
   person's language.

## Phase 5 — Delivery

1. Links are the providers' own search pages for the venue's name in the
   person's city; the catalog has no menu links. Formats were checked on the
   public sites on 2026-11-26, read-only:
   - Glovo: `https://glovoapp.com/<lang>/ua/kyiv/search?q=<name>` — `uk`,
     `ru`, `en`, `pl`; German has no Glovo page for Ukraine and opens English.
     The older `/<country>/<lang>/<city>/` form now redirects to a 404.
   - Bolt Food: `https://food.bolt.eu/<locale>/325-kyiv/search/?q=<name>` —
     `uk-ua`, `ru-ru`, `en`, `pl-pl`, `de-de`.
   - Only cities in `DELIVERY_CITIES` (`packages/shared/src/place-scenes.ts`)
     get links; today that is Kyiv.
2. A link is a search, not a promise that the place delivers: the scene's
   button opens the service on the venue's name.
3. Dishes are kept only when a review text of the venue names them. Neither
   `CuratedVenue` nor `PlaceCache` stores review text today, so every delivery
   scene has no dishes and the model is told to name none. Storing review
   snippets would mean asking Google Place Details for `reviews` (a billed
   field) and a schema change — a separate decision.

## Phase 6 — The proactive tip

1. A worker every 30 minutes (`workers/place-tips.ts`) may post an assistant
   message with a `regulars` scene: a catalog place near the places the person
   keeps going to, that they have never been to.
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
6. Deliberately not built: a proactive `delivery` tip. Without grounded dishes
   and with links that only search, a tip saying «order from here» could point
   at a place that does not deliver.
7. Demo mode: the worker never runs for the demo bot (no app accounts there).

## Files

1. `packages/shared/src/place-scenes.ts` — kinds, limits, the tip cadence, the
   delivery providers and URL builder, the prompt block.
2. `packages/shared/src/i18n.ts` — `place*` labels in five languages.
3. `apps/bot/src/services/place-catalog.ts` — the city catalog, the clock, the
   walk, the regular places, the search.
4. `apps/bot/src/services/chat-place-scene.ts` — the three tools, the scene,
   reading back, the view, the history note.
5. `apps/bot/src/services/chat-agent.ts`, `public/routes/chat.ts` — wiring.
6. `apps/bot/src/services/place-tips.ts`, `workers/place-tips.ts`,
   `index.ts` — the tip.
