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
   and the card on «Сегодня» names the partner. Telegram gets a DM with the
   partner's name and two buttons (`ma:g:<matchId>` / `ma:p:<matchId>`).
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
   2023 fMRI study of couples' compliments). No numbers without a source.
3. **The flowers hint** — «Её любимые цветы: Пионы, Тюльпаны» from the
   partner's `f_flowers` Profiler answer (tapped options in the viewer's
   language, else her own words up to 80 characters). Shown only if the partner
   accepted legal docs version 2026-10-08 or later, or gave the wishlist
   consent — an answer given under an older policy stays private. The question
   itself stays an ordinary vibe question. Delivery in one tap is deferred (no
   partner integration).
4. **The cheat sheet.** About a tenth of the partner's wishlist is free
   (`wishlistTeaserIds`: at least one item, none for lists of one or two,
   preferring a place, a drink or flowers); the rest is «Ещё N позиций». It is
   opened by one purchase — 150⭐ in Telegram (`wish:<matchId>`), the
   `date_wishlist_unlock` StoreKit consumable ($2.99) in the app — or for free
   with Premium, which writes a `premium` unlock row so the sheet stays open if
   Premium lapses. The sheet is live: it shows the owner's list as it is now.
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
2. **Consent first.** Before the first item is saved, an explicit consent that
   the list (and taste answers such as favourite flowers) is shown to a match
   only after both said "great" the morning after, a tenth free and the rest
   paid or with Premium, the owner not paid, withdrawable at any time
   (`User.wishlistConsent*`, version `WISHLIST_CONSENT_VERSION`).
3. **Three ways in.** A pasted list (`/parse` splits it; links are read by
   their OpenGraph / JSON-LD tags, plain text goes to web search, the client
   animates each card's search), the catalog of popular ideas (suggested ones
   first), or a typed search. Every result is a card with a photo and a price
   range, confirmed by the person before it is saved. Nothing real found keeps
   the person's own words (`source: text`).
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

## Flags, demo, rollout

1. `MORNING_AFTER_ENABLED` (check, reveal, offer), `WISHLIST_FEATURE_ENABLED`
   (session, routes, sheet), `WISHLIST_APPSTORE_ENABLED` (StoreKit till). All
   off by default; `GET /v1/app/config` serves `features.morningAfter`,
   `features.wishlist` and `wishlistProduct`.
2. **Demo mode** behaves the same as production with the flags it is given;
   the demo bot has no Stars rail, so the cheat sheet there opens only with
   Premium.
3. **Before switching on:** the website shows privacy v4.3 / terms v3.1; the
   App Store product exists; Premium subscribers have been told that the
   ticket cover ends with their paid period (notice before renewal); existing
   users get a one-time notice about the new purposes.
