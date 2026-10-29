<!-- WHEN_TO_READ: You are changing «The Morning After» (the two-button check the day after a date), the mutual reveal and its offer, the Date Wishlist (building it with the agent on «Сегодня», the look-ups, the catalog, suggestions), or the paid cheat sheet. -->

# «The Morning After» and the Date Wishlist

Founder brief and decisions of 2026-10-08 (decision journal, same date). Three
pieces that run in one line: the morning after a first date both people are
asked one question; when both say it was great, each is offered the other's
Date Wishlist as a cheat sheet for the second date; and the wishlist itself is
built earlier, with the agent, on «Сегодня».

## Phase 1 — the morning check

1. **The anchor is the date's own time.** `Match.agreedTime` is known, so no
   location tracking is needed — a pair can share a campus or a concert without
   knowing it, and background location costs battery and an iOS "always"
   prompt. Hinge's «We Met» made the same call.
2. **When.** The first 11:00 in the pair's city at least six hours after the
   date (`morningAfterDueAt`): an evening date is asked the next morning, a
   lunch date too, a date at 1 am the same morning. A tick that misses 11:00 may
   still send until 14:00; after that the moment is gone and nothing is sent. A
   date older than 48 hours is never asked about. A pair where somebody already
   said the date did not happen is skipped. Step 2e of the date-lifecycle tick
   (`runMorningAfterTick`), claimed once per match on `morningAfterSentAt`.
3. **How.** Each side separately, on their own rails. The app gets a push whose
   copy names nobody (the lock screen is public) — «Как всё прошло вчера?» —
   and the card on «Сегодня» names the partner and shows their photo, the venue
   and the time (founder's pick 2026-10-08). Both rails carry the double-blind
   promise («{name} узнает о твоём ответе, только если это взаимно»). Telegram
   gets a DM with the partner's name and two buttons (`ma:g:<matchId>` /
   `ma:p:<matchId>`); the 🔥 / 🤷 marks are Telegram's, the app draws its own.
4. **Two answers only:** 🔥 «Было круто, хочу увидеться снова» (`great`) and
   🤷 «Не сошлись / Мимо» (`pass`). One-shot; the same answer again is
   idempotent, a change of mind is refused.
5. **Double-blind.** Nobody ever learns the other's answer. Only when both are
   `great` is `mutualInterestAt` stamped by compare-and-set, and the one call
   that stamped it tells both sides (push `date.mutual` without names, Telegram
   DM with the offer). A `pass` is never revealed — the `great` side simply
   hears nothing, as with a declined pitch.
6. **The T+24h form stays** and still feeds matching; it no longer asks "second
   date?" of someone who answered here (`askSecondDate: false`; the server
   derives yes/no from the morning answer).

## Phase 2 — the offer after mutual interest

1. **Shown for seven days** on «Сегодня» (`GET /v1/me/after-date` → `offers`)
   and once as a Telegram DM. A block or a report in either direction removes
   it.
2. **The copy** says it is mutual, then two research lines instead of the
   brief's invented percentages: a message the next morning sparks the most
   interest and by the second day it is already fading (Teichmann et al.,
   J. Soc. Pers. Relationships, 2026); giving something to a person you like
   uses the same brain reward system as falling in love (Aron et al., 2005; the
   2023 fMRI study of couples' compliments). No numbers without a source. Since
   2026-10-09 each idea is one short line («Напиши сегодня — утром после
   свидания интерес на пике.»), about half the words of the first version. The
   title is the bare word («Взаимно»): the app draws its own mark beside it, the
   Telegram DM appends ✨, the push keeps ✨ in its title.
3. **The flowers hint** — «Любимые цветы: Пионы, Тюльпаны» from the
   partner's `f_flowers` Profiler answer (tapped options in the viewer's
   language, else her own words up to 80 characters). Shown only if the partner
   accepted legal docs version 2026-10-08 or later, or built a wishlist (its
   session says the same at the top), and never while the partner hid their
   list — an answer given under an older policy stays private. The question
   itself stays an ordinary vibe question. Delivery in one tap is deferred (no
   partner integration).
4. **The cheat sheet.** About a tenth of the partner's wishlist is free
   (`wishlistTeaserIds`: at least one item, none for lists of one or two,
   preferring a place, a drink or flowers); the rest is «Ещё N позиций». It is
   opened by one purchase — 150⭐ in Telegram (`wish:<matchId>`), the
   `date_wishlist_unlock` StoreKit consumable ($2.99) in the app — or for free
   with Premium, which writes a `premium` unlock row so the sheet stays open if
   Premium lapses. The sheet is live: it shows the owner's list as it is now.
   From 45 days after the owner's last add or delete (`users.wishlist_changed_at`,
   `WISHLIST_STALE_AFTER_DAYS`) it carries a small line «Список обновлялся 52 дня
   назад» (`ageNote`; months from 90 days) — before the
   purchase too, so the viewer knows it before paying. A fresher list has no line.
5. **Purchases** are `WishlistUnlock` rows, idempotent on the provider's
   payment id. A Stars charge that can no longer be honoured is refunded at
   once; an App Store one is answered `unclaimed` and reported to the founder
   (Apple refunds consumables). An App Store REFUND closes that viewer's sheet.

## Phase 3 — building the wishlist on «Сегодня»

1. **Not in onboarding.** The session takes the slot of one Profiler batch,
   never before three Profiler answers, at the person's 09:00 / 18:00 window
   (`profiler-native.ts` on the app's pull; `workers/wishlist-session.ts` with
   one push `wishlist.session` for those who did not open the app). App users
   only. It stands until «Готово» (needs at least one item; never offered
   again) or «Позже» (comes back after three days).
2. **No consent screen** (founder, 2026-10-08, second decision: a screen of
   «кто увидит твой список» before the first item reads as a warning and puts
   people off). Being shown to a mutual date is what the list is for, so the
   basis is the contract (Art. 6(1)(b), Privacy §12.1, Terms §6), not consent —
   which could not move into the sign-up tick, where bundled consent is invalid.
   The notice at the moment of collection is the mascot's first line, framed as
   the reason to fill the list: «Что тебя порадует? Если свидание будет взаимным
   — подскажу это твоей паре.» The owner can hide the list — and the flowers
   hint — at any time: «Не показывать мой список» in Profile → «Мой вишлист»
   (`PUT /v1/me/wishlist/visibility`, `users.wishlist_hidden_at`); items stay.
3. **Five ways in.** A pasted list (`/parse` splits it; links are read by
   their OpenGraph / JSON-LD tags, plain text goes to web search, the client
   animates each card's search), the catalog of popular ideas (suggested ones
   first), a typed search, **a voice note** (`/voice`: Whisper, then one
   structured call lifts the concrete ideas out of free talk — «Шанель Шанс»
   becomes «Chanel Chance», «только не розы» is dropped; the comma split is the
   fallback) and **screenshots** from the photo library (`/photos`: up to 6 per
   send, one vision call names each wanted product as a search query, or as
   its link when the address is readable). Voice and screenshots end in the
   same entries as a paste, so the search, the cards and «оставить своими
   словами» are one path; the audio, the transcript and the images are never
   stored (founder 2026-10-08, third: «люди хранят скрины желанных вещей»).
   Every result is a card with a photo and a price range, confirmed by the
   person before it is saved. Nothing real found keeps the person's own words
   (`source: text`).
4. **Search** is the OpenAI Responses API with the `web_search` tool (founder's
   choice, no new provider), up to three candidates, ~20 s budget, cached 30
   days without a user id, 30 look-ups a day per person. Shop pages are fetched
   through the SSRF perimeter of `safe-fetch.ts`. The confirmed photo is copied
   into our storage under the person's own prefix; deleting the account deletes
   it.
5. **Suggestions** (the brief's recommendation system, first cut): the
   person's own frequent places — only with their frequent-places opt-in — and
   a daily model pick from the catalog against their Profiler answers and
   interests. Shown to the owner only.

6. **In the app's chat — a card with a button** (founder, 2026-10-15: the
   agent got five photos of his favourite perfumes and had nowhere to put
   them). The chat agent recognises what a person shares — a photo of the
   thing, a shop screenshot, a link, «хочу / обожаю X» — and calls
   `propose_wishlist_items`, which writes NOTHING: it builds a card stored on
   the reply (`messages.attachment`) — the items with pictures, all ticked, one
   «Добавить» and a quiet «Не надо». The tap is the consent:
   `POST /v1/chat/messages/:id/wishlist` saves the ticked keys
   (`services/chat-wishlist.ts`).
   - Pictures: a clear photo of the thing is the person's own (copied into the
     wishlist key on save; removing the item removes the copy); a link is read
     for its page photo; a screenshot or a messy photo is looked up for a clean
     product shot (at most four look-ups per card, 12 s each, from the same
     daily budget), the person's photo being the fallback.
   - Items already in the list are left out; a full list (30) gets no card but
     a «Мой вишлист» button (`menu:wishlist`).
   - The card and its answer survive a reload (`/v1/chat/history` carries
     `attachment`), and the next turn's model reads under its reply what was
     saved or dismissed. The agent's person card names the newest items.
   - Only for a build that sends `X-Gennety-Chat-Cards: wishlist`; an older
     build gets neither the card nor the tool. App only — Telegram keeps the
     «Сегодня» session as the way in.

7. **Removing an item in app chat** (founder, 2026-10-29). The agent can
   remove one saved item when the person asks, including «тогда удали его»
   after an already-saved reply. It reads the live owner list first with
   `get_my_wishlist`, resolves the exact item, then calls `remove_wishlist_item`.
   An ambiguous reference gets a question before any deletion. A separate
   authorization check receives the real item title and brand; a failed check
   leaves the item alone. Removal consumes the turn's single write budget and
   returns a localized receipt only after success. It uses the same scoped
   removal and photo cleanup as Profile. This is available with
   `WISHLIST_FEATURE_ENABLED`, including builds without card support; no new
   native API or app update is needed. Adding still requires the card's button.
   Telegram's menu agent is unchanged. Demo app chats follow the same flag and
   operate only on their isolated owner's list; no synthetic partner is edited.

8. **A soft hint for the first venue** (founder, 2026-10-15: «подсказывать
   место свидания по вишлисту»). The `place` / `drink` / `experience` items of
   each side whose list is not hidden become one more draw weight inside the
   venue diversity band, next to Tempo Sync Tier 2
   (`wishlistVenueTaste` / `wishlistVenueFit` / `wishlistVenueMultiplier` in
   `packages/shared/src/wishlist-venue.ts`, `loadWishlistVenueTastes`): catalog
   ideas by their tags, free text by a short multilingual keyword map, a typed
   place by its name. It can only pick between venues the ranker already rates
   near-equal; never logged, stored on the match, or put into the reason or the
   blurb. `WISHLIST_VENUE_HINT_WEIGHT` (0 = off, the default; 0.3 intended,
   capped at 0.5) — a NEW purpose of the list: privacy v4.4 (§7 table), ROPA
   2.5 / 2.5f and DPIA R12 carry it; switch on only once that text is on the
   site.

8. **A shared short video** (founder, 2026-10-24: «Поделиться → Gennety» for
   Reels / TikTok / Shorts). The iOS share extension sends the link to
   `POST /v1/me/share/video` (`services/share-video/read.ts`): the server reads
   only what a logged-out browser gets — caption, title, author, cover frame
   (TikTok/YouTube oEmbed, Instagram OG tags; no frames, no audio) — and one
   vision call returns a title, a one-line summary, ONE interest, ONE item or
   place (`query` for `/lookup`) and up to three questions. The sheet shows
   them as «＋» rows; nothing is written without a tap. «＋ Интерес» is
   `POST /v1/me/share/interest` (append to `Profile.hobbies`, case-insensitive
   dedupe, `409 too-many` at 10, embedding marked dirty); the item goes through
   the ordinary `/lookup` + `/items`. Questions are answered in the sheet
   (`POST /v1/me/share/video/ask`), grounded only on the read plus the home
   city. Nothing new is stored: the read lives in an in-process cache (6 h,
   500 entries). YouTube is read for this path only — the Profiler's
   allowlist is unchanged. Same `WISHLIST_FEATURE_ENABLED` switch; an older
   server's bare 404 makes the app fall back to the wishlist flow.

## Flags, demo, rollout

1. `MORNING_AFTER_ENABLED` (check, reveal, offer), `WISHLIST_FEATURE_ENABLED`
   (the person's own list: session, routes, «Мой вишлист» in Settings and
   Profile, the chat card), `WISHLIST_APPSTORE_ENABLED` (StoreKit till). All
   off by default; `GET /v1/app/config` serves `features.morningAfter`,
   `features.wishlist` and `wishlistProduct`. The cheat sheet and its purchase
   need the wishlist AND the morning flag (`wishlistSheetLive`, 2026-10-15), so
   `WISHLIST_FEATURE_ENABLED` alone is a supported setting: people collect,
   nobody is shown or sold anything.
2. **Demo mode** behaves the same as production with the flags it is given;
   the demo bot has no Stars rail, so the cheat sheet there opens only with
   Premium.
3. **Before switching on:** the website shows privacy v4.3 / terms v3.1; the
   App Store product exists; Premium subscribers have been told that the
   ticket cover ends with their paid period (notice before renewal); existing
   users get a one-time notice about the new purposes.
