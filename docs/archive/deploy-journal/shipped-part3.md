<!-- WHEN_TO_READ: HISTORICAL. Only when you need the verification steps or rollback of an ALREADY SHIPPED deploy (entries 2026-08-07 .. 2026-07-29). Find it via INDEX.md first — never read this file whole. -->
<!-- SOURCE: deploy.md (lines 9085-11500) — migrated 2026-09-01 -->

# Shipped deploy journal — part 3 of 3

Index of every entry: [INDEX.md](../../operations/deploy-journal/INDEX.md). Order is preserved from the original file (newest first).

---

**Deployed 2026-08-07 (was PENDING) — venue photos open full-screen (PRODUCT_SPEC §3.7b).** Deployed 2026-08-07. **No Prisma schema change, no env change, no flag change, no server
behaviour change** — but it is client-side, so it **DOES need a Mini App
redeploy** (`apps/webapp`: `venue-change.ts` / `venue-change.css` / `icons.ts` /
`telegram.d.ts`). The server half is a no-op for this change alone; sequence is
still Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh`.

Tapping a photo on a venue's detail card now opens the ordinary lightbox —
full-screen, swipeable, `n / N` counter, its own ×, BackButton bound to closing
it. The board asks the couple to *choose* a place and the largest a venue was
ever shown was a 340px rail tile.

**Three things worth knowing before the redeploy:**

- **It asks the photo proxy for `w=1600` where it previously only ever asked for
  1000.** That is already the proxy's own ceiling (`clampWidth`,
  `public/routes/venue-change.ts`) so there is nothing to change server-side, but
  it is a **new cache key**: the first user to enlarge a given photo pays one
  fresh Google Places fetch, and the day-long `Cache-Control` then covers it. The
  upgrade is per slide being viewed, never the whole set, so a 10-photo venue
  costs at most one extra fetch per photo actually looked at. `PLACES_API_KEY`
  was re-verified working 2026-08-03; with it down the viewer degrades to the
  category glyph exactly like the rail does.
- **The dev preview now renders synthetic photos.** `?preview` had
  `photoRefs: []` for every mock venue, so the galleries were a wall of category
  glyphs and this feature would have been unreviewable without a live match —
  and production has **2 matches ever, both terminal** with `VENUE_CHANGE_FEATURE_ENABLED` off.
  The mock now carries 0/1/4/7-photo venues backed by generated SVG data-URIs, so
  `http://localhost:5173/venue-change.html?preview=board` exercises every gallery
  shape. `import.meta.env.DEV`-gated — unreachable in production.
- **`.vc-shot` is now a `<button>` when it opens the viewer**, not a div. Its
  button chrome is stripped in a rule at the END of `venue-change.css`, which
  matters because that file carries a pre-existing duplicated block (`.vc-shot`
  is defined twice, lines ~382 and ~745) — anything added to only the first copy
  would be a coin flip. Do not "tidy" that duplication as part of this deploy.

Post-deploy check — nothing new is logged, so verify by opening the board on
`@gennetytestbot` (needs a `scheduled` match) and tapping a venue photo. The
proxy can be exercised directly instead:

```sh
# 1600 is accepted and cached; anything above is clamped, not rejected.
curl -sD- -o /dev/null "https://dating-api.gennety.com/v1/venue-change/photo?ref=<ref>&w=1600&tma=<initData>" | head -1
```

**Rollback:** revert the code and redeploy the Mini App from the previous
checkout. Nothing else to undo — no schema, no env, no flag, no server state.

---

**Deployed 2026-08-07 (was PENDING) — a status is never shown on a step the user owes (PRODUCT_SPEC §3.6b,
§3.5, §3.5c).** Deployed 2026-08-07. **Code-only: no Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched).

A user picks a time, their partner counters with a different one — and both of
them were then shown a `<tg-thinking>` status saying the time was being
coordinated for them. Nobody was coordinating anything: each of them had to
widen their selection or tap one of the other's slots. The person who received
the counter got that status *directly under* the message telling them their
partner had suggested another time, which is the one message in the flow whose
whole job is to say **your turn**.

The invariant it now runs under: a status is only ever shown to someone with
nothing left to do. When the next move is the user's own, they get a reminder
that names it — never a "we're working on it" line.

**The part worth knowing before the restart is not the shimmer, it's what the
shimmer was hiding.** That state matched neither branch of `sideOwesAction`
("has this side marked anything?" — both had), and the entire §3.5c chain keys
off that predicate. So a pair whose calendars simply didn't line up got **no 6h
/12h reminder, no 24h "still on?" check-in, and no 48h cancellation** — they sat
in a live match indefinitely, held out of every drop by the single-live-match
rule. Reachable in one ordinary move. Both sides now owe the action, so all
three fire; the reminder carries static copy (`matchScheduleNoOverlapYet`) plus
the Calendar button, because a generated "pick a time" line is wrong for someone
who did pick.

Two smaller things ride along, both consequences of the same consolidation:
- The scheduling reminder now recognises a pair still inside the §3.5b Date
  Ticket gate by an empty `proposedTimes` rather than by a flag-conditional
  `ticketStatus` filter — the same discriminator the stall chain already used.
  Behaviour is identical under either flag; there is one less way for the two to
  disagree.
- Two i18n keys are deleted (`peerWaitNoOverlap`, `peerWaitNoOverlapLate`, ×5
  locales). Nothing else read them.

Post-deploy check — production has **2 matches ever, both terminal**, so nothing exercises this
until a Thursday batch pairs someone. Walk it on `@gennetytestbot`: pick a slot
from one account, counter with a different one from the other, and confirm both
chats show no shimmer. The reminder is hourly, so verify it from the log rather
than by waiting:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[match-nudge\]'
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-07 (was PENDING) — an abandoned question stops owning the chat (PRODUCT_SPEC §Phase 4 →
Emergency Protocol, §Phase 5, §2.1).** Deployed 2026-08-07. **Code-only: no Prisma
schema change, no env change, no flag change, no Mini App change**
(`apps/webapp` untouched). From a full-codebase audit; three flows, one root
cause.

Three steps asked the user to TYPE something and then read the next plain
message as the answer — the emergency cancellation reason, the report details,
and the post-date feedback text. None of the three had a deadline, and nothing
in the product ever released the state: not `/menu`, not a menu tap, not time.
So the question kept owning the chat indefinitely.

- **The one that matters: an abandoned "Yes, cancel the date" cancelled it
  anyway.** Confirm, change your mind, close the chat — and your next unrelated
  message, days later, flipped a `scheduled` match to `cancelled`, was quoted
  verbatim to your partner as the reason, and refunded both tickets.
  Irreversible. That step also had no way back, the only irreversible confirm in
  the product without one.
- The report details step did the same thing at lower stakes: an unrelated line
  became a filed report on the partner, LLM-triaged up to a strike or a
  suspension. Its **Other** category showed no buttons at all, so there was no
  exit that wasn't filing something.
- Feedback recorded an unrelated line as post-date feedback into the answerer's
  own `negativeConstraints`.

Now: the claim carries a deadline sized to what the answer costs to get wrong
(30 min / 1 h / 24 h), any non-own-button tap or command releases it, and the
emergency + report steps carry a real back-out. Past the window the message
falls through to the concierge agent, which sees the live match and can still
offer the genuine cancel card. `services/match-flow-claim.ts` is the one place
this rule lives.

**Two things worth knowing before the restart:**

- **In-flight answers across the restart are dropped, deliberately.** The
  session field is new, so every existing `bot_sessions` row reads `null` and
  fails closed. A user mid-"type your reason" at deploy time has their message
  answered by the agent instead of cancelling the date — which is the safe
  direction, and they can re-tap Cancel from the My Date hub.
- **The same commit fixes two smaller things** found in the same pass:
  abandoning the photo manager by tapping another menu button now strips the
  cards' 🗑 buttons instead of orphaning them live-but-dead forever, and
  `startPeerWaitShimmer` resolves side B positively (it read "not A, therefore
  B", so a user id belonging to neither participant aimed the shimmer at B).

Post-deploy check — nothing new is logged, so verify by walking it on
`@gennetytestbot`: tap Cancel date → "Yes, cancel" → confirm the prompt now
carries "Keep the date" → tap it → send a message → the date must still be on.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state (the extra session field is ignored by the old
code).

---

**Deployed 2026-08-07 (was PENDING) — referral share card arrives whole (REFERRAL_PRODUCT_SPEC → Surfaces).**
Deployed 2026-08-07. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched).

Sharing an invite delivered a *sliver* of the card — the top ~20%, blank
beneath. That is a partially decoded image, and the endpoint Telegram fetches
had two independent reasons to produce one. It **re-rendered the PNG on every
request** (~2.5 s cold on a Mac, worse on a 1–2 vCPU droplet — satori fonts +
five portraits + the butterfly), and then pushed **453 KB** of it. Telegram
downloads `photo_url` on its own servers under its own deadline and keeps
whatever arrived; a PNG decodes top-down, so a cut-short download *is* a strip
of the top. Now: JPEG (**93 KB**, and what the Bot API actually requires),
pre-rendered and memoized by `POST /share-message` so the fetch is a memory read
(**33 ms** measured end to end), with `photo_width`/`photo_height` stated so
Telegram never probes the file.

**Three things worth knowing before the restart:**

- **It is inert in production.** `REFERRAL_FEATURE_ENABLED=false` in
  `/opt/gennety/.env`, so `/v1/referral/*` 404s and nothing here can run. This
  reproduced on **dev**, where the flag is on and `PUBLIC_BASE_URL` is a **free
  ngrok tunnel** — exactly the slow link that turns "render then push 453 KB"
  into a truncated fetch. The weaknesses were real regardless of tunnel, so this
  lands before referral is ever switched on.
- **The card URL now carries a content version (`v`), and that is the part that
  actually reaches already-affected users.** Telegram caches fetched media **by
  URL**, and the old URL (`?u=&sig=`) was stable forever per referrer — so one
  bad fetch was permanent for that person, which is why it never self-healed.
  The version is inside the signed payload, so the HMAC binding is unchanged.
  Pre-versioning signatures are still accepted, so an in-flight share and
  `scripts/dev-stage-referral.mjs` both keep working untouched.
- **Messages already sent stay broken.** They carry a `file_id` Telegram
  resolved at send time; nothing server-side can rewrite them. Re-share to get a
  good card.

Post-deploy check — referral is off in prod, so verify on `@gennetytestbot`:
share an invite to Saved Messages and confirm the full card arrives. The
endpoint itself can be checked directly (referral must be enabled, else 404):

```sh
curl -sD- -o /dev/null "$PUBLIC_BASE_URL/v1/referral/card?u=<id>&v=<v>&sig=<sig>"
# expect: 200, content-type: image/jpeg, and a content-length that matches the
# bytes actually received — a mismatch is the truncation this change fixes.
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-07 (was PENDING) — Premium screen gets a way back to the board (PRODUCT_SPEC §3.8).**
Deployed 2026-08-07. **No Prisma schema change, no env change, no flag change** —
but this one is **client-side and therefore DOES need a Mini App redeploy**
(`apps/webapp`: new `return-to.ts`, plus `premium.ts` / `venue-change.ts`).
Sequence: Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh`. (The server half is a no-op for this change alone;
it matters only because the block below ships in the same release.)

The board's premium CTA navigates to `premium.html` in the same WebView, and
that was a one-way door — a user who read the price and passed had to close the
Mini App and reopen "Change venue" from chat. Premium now shows Telegram's
native BackButton when (and only when) it was reached from another page, and it
reopens the exact board. Opened cold from the main menu it shows none, because
there is nowhere to go back to.

Three details worth knowing:

- **The return is a fresh navigation, not `history.back()`.** That is deliberate
  and load-bearing for the *successful* case: the board re-reads
  `pairPremiumActive` on open, so a user who actually subscribed comes back to
  unlocked premium cards. A bfcached history entry would show them still locked.
- **The target is validated against an allowlist**, never taken as a URL from
  the query string — it arrives in a parameter the user can edit.
- **Back walks the whole chain, not one hop (folded in 2026-08-05, before this
  block ever shipped).** The first cut of `return-to.ts` stored a single target,
  so each hand-off overwrote the last: board → Premium → referral erased the
  board, and back landed on a Premium screen that believed it was opened cold —
  no button, close-the-Mini-App the only way out. It is a stack now, bounded in
  depth, collapsing a revisit instead of stacking it. The top of the trail stays
  in the original query keys, so a client still on an older bundle keeps its one
  working level rather than losing back entirely.

Post-deploy check: load `premium.html` once from the board and once from the
menu row, confirming the back arrow appears in the first case only — then walk
board → Premium → "invite a friend instead" and press back twice, which must
land back on the board rather than stopping on Premium. (The referral leg needs
`REFERRAL_FEATURE_ENABLED`, which is **false** in production, so that half is
verifiable only on `@gennetytestbot` until referral launches.)
**Rollback:** revert the code and redeploy the Mini App from the previous
checkout.

---

**Deployed 2026-08-07 (was PENDING) — venue-change board: photos back, duplicates gone, premium reaches
5 km (PRODUCT_SPEC §3.7b).** Deployed 2026-08-07. **Code-only: no Prisma schema
change, no env change, no flag change, no Mini App change** (`apps/webapp`
untouched — the client already renders `photoRefs`).

Three user-reported symptoms, one cause. The 2026-07-30 commit `9df3a39` moved
the board's curated catalog from a `universityDomain` scope to a `cityKey` one.
That fixed a real bug (general/phone-track pairs, which is **every production
user** — all 20 have `universityDomain = NULL` — got an empty curated catalog
and never saw the premium tier at all). Its unrecorded side effect: the curated
branch started winning `curated.length > 0 ? curated : places`, and curated rows
are both photo-less and stored one-per-university-domain.

- **Photos never came from our base.** `photoRefs: []` for curated rows has been
  in the code since the feature shipped. Until `9df3a39` it did not matter,
  because every board fell through to the live Places sweep, whose search
  response carries photos — that fallback is also where the old "lots of variety,
  parks and cafés" came from (`FALLBACK_CATEGORIES = cafe, restaurant, park`).
  Curated cards now resolve their photos from `placeId` in one Place Details
  call each, cached in-process, best-effort.
- **Duplicates are data, not display logic.** Kyiv holds **538 active rows for
  127 real venues** (premium: **90 rows for 18**), five copies each — one per
  university domain, at identical coordinates, so they sort adjacently and the
  three pinned premium slots all held the same place. Deduped by the same key
  the board already resolves picks with.
- **Premium now searches `VENUE_CHANGE_PREMIUM_RADIUS_KM` (5 km)**, base and
  alternative stay at 3 km. From Podil only 10 of 18 premium venues are inside
  3 km; all 18 are inside 5.

**Two things worth knowing before the restart:**

- **Board opens now make Places calls where they made none.** Bounded by the
  12-card cap and 4-way concurrency, cached by `placeId` for a day (failures for
  5 minutes, so an outage cannot become a retry storm). Worst case is ≤12 Place
  Details requests on the first board open after a PM2 restart; Kyiv's whole
  catalog warms in ~113. Only the board *read* pays — the like/confirm calls
  rebuild the same catalog to re-resolve a key and skip lookups entirely.
- **Nothing exercises this until a pair reaches `scheduled`.** Production has
  **2 matches ever, both terminal**, and `VENUE_CHANGE_FEATURE_ENABLED` gates the entry button.
  Verify on `@gennetytestbot`.

Post-deploy check — the board should show distinct venues with photos, and three
*different* locked premium cards on top:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[venue\] photo lookup'
# Empty is the good case: that line only prints when a lookup fails.
```

**Rollback:** revert the code and restart. No schema, no env, no flag, no Mini
App state to undo.

---

**DONE — StoreKit 2 is live-configured on the droplet (2026-08-03) and proven
against Apple's real API.** App Store Connect was set up via a browser agent,
every value cross-checked, then the key was uploaded and the env set. These are
identifiers, not secrets — they are inert without the `.p8`, which lives only on
the droplet and in the founder's password manager.

```
APPSTORE_KEY_PATH=/opt/gennety/keys/SubscriptionKey_5UCTX65L56.p8
APPSTORE_KEY_ID=5UCTX65L56
APPSTORE_ISSUER_ID=49fd72b2-faf4-4673-a9b4-50e6027c46a8
APPSTORE_ENVIRONMENT=sandbox
```

**Proof, not inference.** `POST /inApps/v1/notifications/test` against
`api.storekit-sandbox.itunes.apple.com` answered **200** — so the key, `kid`,
issuer and `bid` are all accepted by Apple. Reading the delivery record back
settles the two things that were previously assumed:

- `sendAttempts: [{ sendAttemptResult: "SUCCESS" }]` on the first attempt — our
  webhook is reachable at the saved URL and answered Apple acceptably.
- `version: "2.0"`, `notificationType: "TEST"`, `bundleId: com.gennety.ios`,
  `environment: "Sandbox"` — **the notifications are V2**, which App Store
  Connect's UI could not confirm (it shows no version selector at all). The
  benign-either-way argument below is retained as history, not as a live risk.

The webhook logs nothing for a `TEST`: it carries no `signedTransactionInfo`,
so `transactionId` is empty and the handler acks in the "shape we don't consume"
branch (`res.json({ ok: true })`). Silence in `pm2 logs` after a test
notification is the correct behaviour, not a missed delivery — re-verify with
Apple's delivery record, not with our logs.

Re-run the check any time (10-minute JWT, no state written):

```sh
ssh root@167.172.178.229 'cd /opt/gennety && node -e "
const jwt=require(\"./apps/bot/node_modules/jsonwebtoken\"),fs=require(\"fs\");
const now=Math.floor(Date.now()/1000);
const t=jwt.sign({iss:\"49fd72b2-faf4-4673-a9b4-50e6027c46a8\",iat:now,exp:now+600,
  aud:\"appstoreconnect-v1\",bid:\"com.gennety.ios\"},
  fs.readFileSync(\"/opt/gennety/keys/SubscriptionKey_5UCTX65L56.p8\"),
  {algorithm:\"ES256\",header:{alg:\"ES256\",kid:\"5UCTX65L56\",typ:\"JWT\"}});
fetch(\"https://api.storekit-sandbox.itunes.apple.com/inApps/v1/notifications/test\",
  {method:\"POST\",headers:{Authorization:\"Bearer \"+t}})
  .then(r=>r.text()).then(console.log);"'
```

Flip `APPSTORE_ENVIRONMENT` to `production` at release, and re-run the same
probe against `api.storekit.itunes.apple.com` — a key that works in sandbox is
not evidence that the production host is reachable.

App record: Apple ID `6797330919`, bundle `com.gennety.ios`, SKU `gennety-ios`,
**Team ID `ADWPKD5WZ7`** — which matters beyond bookkeeping: it is the same team
the founder registered with BotFather for Telegram login, so that integration is
bound to the right account.

Product ids match `APPSTORE_TICKET_PRODUCTS` / `PREMIUM_APPSTORE_PRODUCT_ID`
exactly. Verified US base prices, and the per-ticket ladder they produce:

| product | price | per ticket |
|---|---|---|
| `ticket_1` | $6.99 | $6.99 |
| `ticket_3` | $16.99 | $5.66 |
| `ticket_6` | $29.99 | $5.00 |
| `premium_monthly` | ~~$9.99/mo~~ → **$17.99/mo** (raised 2026-08-07) | — |

**`premium_monthly` was raised to $17.99 on 2026-08-07**, matching the Telegram
rail's 750⭐. Re-measured on the product page after a reload: US 17,99 $ as the
current price for new subscribers, **0 upcoming changes**, and 175 storefronts
auto-generated by Apple. The ticket rows above are unchanged and were not
touched.

**⚠️ The subscription group has never been submitted, so iOS Premium is not
purchasable at all yet — price is not the binding constraint (found
2026-08-07).** App Store Connect shows the group and the product as
*Preparing for Submission*, with Apple's standing rule on screen: **"your first
subscription group must be submitted with a new app version."** So
`premium_monthly` cannot be bought on any storefront until an app build carrying
it clears review — which is also why `APPSTORE_ENVIRONMENT=sandbox` is still the
right setting and why the $9.99/$17.99 gap that sat open earlier in this file
was never actually visible to a user.

Two consequences worth holding onto:

- **The price was fixed at the best possible moment**: before first submission,
  there is no price history, no subscriber cohort, and therefore no
  "preserve price for existing subscribers" decision to get wrong. That is why
  the wizard showed no such prompt and no start-date picker.
- **`features.premium: true` on `/v1/app/config` does not mean iOS can sell it.**
  That flag mirrors `PREMIUM_FEATURE_ENABLED` on the server and knows nothing
  about App Store review state. A native paywall gated only on it will render a
  StoreKit product that cannot be purchased. The App Store rail goes live at
  first approved submission, not at a flag flip.

An earlier agent report suggested `ticket_1` might have inherited $16.99, which
would have charged one ticket the price of three; direct inspection shows $6.99.
The ladder is strictly decreasing, so nothing blocks enabling the rail.

**Re-verified 2026-08-21 by a second browser agent.** Everything above was
already in place and nothing had to be created: app record, four products, key
`5UCTX65L56` / issuer `49fd72b2-faf4-4673-a9b4-50e6027c46a8` (identical to the
env), both webhook URLs. Three things it adds to this file:

- **The App Group and both extension App IDs exist** — `group.com.gennety.ios`,
  `com.gennety.ios.widgets`, `com.gennety.ios.notifications`. They were created
  after the 2026-08-03 pass and had never been recorded here.
- **What it did NOT confirm: App Groups enabled on the *widgets* App ID.** The
  report places the capabilities "on the main App ID" and says nothing about the
  extension. That entitlement is what lets the widget read `StatusSnapshot` out
  of the shared container, and its absence does not show up on the simulator —
  it surfaces at signing, i.e. the first TestFlight upload. Check it before 6.3
  rather than during.
- **`ticket_1` had a pending price change and the agent put it into effect
  (2026-08-20).** US base is unchanged at $6.99, but the product is now priced
  **manually across all 175 storefronts**. Manual pricing means Apple stops
  re-deriving foreign prices when exchange rates move — a change of behaviour,
  not bookkeeping, and one an agent made rather than one that was decided. Worth
  a founder call whether this ladder goes back to Apple's automatic pricing.

Cosmetic mismatch, no action: the subscription group is `Gennety Subscriptions`
in App Store Connect and `Gennety Premium` in the local `Gennety.storekit`. A
group's reference name never crosses into code; product ids match. The release
blocker is unchanged — the group is still unsubmitted, so `premium_monthly`
remains unpurchasable until a build clears review.

**These differ from `TICKET_BUNDLES` (`packages/shared/src/constants.ts`:
$7.00 / $16.47 / $26.94), and that is tolerated, not an oversight.** Apple owns
its price points and re-derives them per storefront, so the iOS client must
render StoreKit's own `displayPrice` and never a number of ours. The constants
remain the anchor for the Telegram rail, which charges Stars anyway. Worth a
founder decision later whether the two surfaces should quote one USD ladder.

**Server Notifications** point at `https://dating-api.gennety.com/v1/webhooks/appstore`
on both Production and Sandbox. App Store Connect shows **no V1/V2 selector at
all** — only the two URL fields — which is consistent with new apps being V2
only, though we have not proven it. The failure mode if it were V1 is benign and
visible: our handler requires `signedPayload` and answers **400**, so V1
notifications would simply not apply and would show up as 400s in the log rather
than corrupting anything.

**APNs was broken for nine days and is fixed in the same pass (2026-08-03).**
The 2026-07-25 rsync did not just delete `AuthKey_JTLFAQ8RM2.p8` — it removed
`/opt/gennety/keys/` **entirely**, while `APNS_KEY_PATH` kept pointing into it.
So every push since then failed at key load, silently: the `APNS_*` env was all
present and correct (`APNS_TEAM_ID=ADWPKD5WZ7` matches App Store Connect), which
is exactly why a config check would have said everything was fine. Both `.p8`
files are now uploaded `0600` into a `0700` directory and verified loadable —
`crypto.createPrivateKey` reads each as `ec / prime256v1`, which is what ES256
signing in `services/apns.ts` and `services/appstore.ts` needs.

**Check the directory, not just the env, after any rsync-based deploy.** The
failure mode here is a valid path to a file that no longer exists, and nothing
in the boot sequence fails closed on it:

```sh
ssh root@167.172.178.229 'ls -l /opt/gennety/keys/'   # expect two 0600 .p8 files
```

**`TELEGRAM_LOGIN_CLIENT_ID=8707759133` is also set now, and is deliberately
inert.** The Telegram-login code is on `main` and NOT deployed — the running
`config.ts` has no such key, and `/v1/app/config` still returns no
`features.telegramAuth`. The variable simply waits for the deploy; nothing about
setting it early changes current behaviour.

---

**Deployed 2026-08-07 (was PENDING) — status shimmers stop being overtaken by their own results
(PRODUCT_SPEC §1.3 / §1.4 / §3.7a).** Deployed 2026-08-07. **Code-only: no Prisma
schema change, no env change, no flag change, no Mini App change**
(`apps/webapp` untouched). Two user-reported bugs, one shared cause — a status
sequence and the work it narrates were independent async chains, so the work's
speed decided what the user saw.

- **Verification.** A liveness pass starts the face-match pipeline and the ~7s
  "analysing your check" shimmer side by side. AWS answers fast, so the verdict
  — usually *"the photos on your profile don't match your verification selfie"*
  — routinely landed **underneath** a shimmer still saying the check was being
  completed. A gate (`services/outcome-gate.ts`) now holds every user-facing
  message from that run until the shimmer is torn down, and tells the shimmer
  when the pipeline is ready to speak so a slow run holds its last beat instead
  of ending in silence. Scoped to the fresh-liveness path only: photo-edit
  reruns, the admin recheck and the native rail DM immediately as before.
- **Date planning.** `runStatusSequence`'s `until` cut the narration short the
  moment the work settled — from the FIRST beat, at the three date-card call
  sites. The render ranges from well under a second to several seconds, so the
  card beats a user actually saw varied run to run, often collapsing to a
  sub-second flash of the first line. What that looked like in the chat is
  exactly what was reported: the venue-search shimmer appearing to hang on
  *"подбираю по атмосфере"* (a rich draft lingers on its own ~30s TTL and
  nothing replaced it) with the card beats never arriving. `NEVER_CUT_SHORT`
  makes `until` extend a script, never truncate it.

**Worth knowing before the restart:** the date card now lands ~6s after the
venue is picked even when the render was instant — that is the fix, not a
regression (the beats are a script the user is meant to read). Production has
**2 matches ever, both terminal**, so nothing exercises the date-card half until a Thursday
batch pairs someone; verify it on `@gennetytestbot`. The verification half is
live for anyone who runs a check.

**Rollback:** revert the code and restart. Nothing else to undo.

---

**Deployed 2026-08-07 (was PENDING) — "Continue with Telegram" on iOS (`POST /v1/auth/telegram`).** Deployed 2026-08-07. **No Prisma schema change, no Mini App change, no flag change** —
but it needs **one new env var**, and it is inert until that var is set.

```
TELEGRAM_LOGIN_CLIENT_ID=8707759133
```

That is the bot's Client ID from @BotFather → Bot Settings → Login Widget →
*Switch to OpenID Connect Login* (founder, 2026-08-02). It is the `aud` every ID
token is checked against, so an empty value is fail-closed: the endpoint answers
503 and `/v1/app/config` reports `features.telegramAuth: false`, which is what
tells the client to hide the button. **There is deliberately no client secret**
— we verify an already-issued ID token against Telegram's public keys and never
exchange an authorization code, so no secret needs to exist on the droplet.

The matching iOS redirect URI is `https://app3059503520-login.tg.dev`; it lives
in the app's Associated Domains, not in server config.

**One behaviour change that is NOT about Telegram login**, shipped with it
because Telegram login is what makes it wrong: `workers/profiler.ts` and
`workers/re-engagement.ts` filtered eligible users on `telegramId > 0` alone. A
Telegram-login account carries a real positive id while being reachable only by
push (a bot cannot message someone who never pressed Start), so both now also
require `platform in ('telegram','both')`. Nobody is in that state until the env
var above is set, so the fix lands ahead of the cohort it protects.

Post-deploy check:

```sh
curl -s https://dating-api.gennety.com/v1/app/config | grep -o '"telegramAuth":[a-z]*'
# 503 until the env var is set, then 400 for a missing token — never 404.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dating-api.gennety.com/v1/auth/telegram \
  -H 'content-type: application/json' -d '{}'
```

**Rollback:** remove `TELEGRAM_LOGIN_CLIENT_ID` and
`pm2 restart gennety-bot --update-env`. The endpoint goes inert and the client
hides the button; no data written by a Telegram login is undone by that (those
accounts keep working through their phone rail).

---

**⚠️ Production is NOT at repo HEAD, and a single-file rsync from the working
tree WILL take it down (incident 2026-08-01, ~6 min outage).** Prod runs
`f9e08eb` (deployed 2026-07-29); everything in the PENDING blocks below is
missing from it, including `services/match-stall.ts` and the
`VOICE_SELF_GENDER` export in `@gennety/shared`. The bot runs from source via
tsx, so a file copied from HEAD that imports either one is not a degraded
feature — it is `ERR_MODULE_NOT_FOUND` at boot and a PM2 crash loop. That is
exactly how `services/prompt-builder.ts` was shipped alone and crash-looped
production before it was restored.

Confirm what prod actually runs before touching it — anchor it by md5 rather
than by trusting this file:

```sh
ssh root@167.172.178.229 'md5sum /opt/gennety/packages/shared/src/ai/prompts.ts'
# then locally, walk recent commits until one matches:
git show "<sha>:packages/shared/src/ai/prompts.ts" | md5 -q
```

For a targeted hotfix, patch the version prod actually runs
(`git show "<prod-sha>:<path>"`), import-test it **in place on the droplet**
under a temp filename before `mv`-ing it over the live file, then restart and
watch that the PID holds and the restart count stops climbing. Otherwise do a
full deploy — but note that rsync copies the **working tree**, not git HEAD, so
check `git status` first: an unrelated in-progress refactor ships with it.

**Prod anchor, re-verified 2026-08-21 after the release at the top of this file.**
Prod's **runtime tree** is at **`57cb108`** — verified by the md5 sweep below
across **818 files**, with **zero** differences (the `apps/bot/tmp/*` files that
the rsync excludes by design were absent this time). Measured, not asserted. Deliberately
anchored to the last commit that touched runtime code, not to `HEAD`: docs-only
commits land on top constantly (this note's own release added one), and an
anchor that counts them is stale the hour it is written.

That is exactly what happened to the previous one — it still named `f66949a`
three days after the 2026-08-09 backlog release and the 2026-08-10 cadence flip
had both landed. **Re-anchor as part of every release**, or the section quietly
stops being a fact about prod and becomes a record of when someone last looked.

**Do not maintain a list of undeployed commits here — compute it.** An earlier
revision of this note named them, and it was stale within the hour because a
parallel session kept landing work. The set is a one-liner:

```sh
git log --oneline 57cb108..HEAD                # what prod is missing
git diff --stat 57cb108..HEAD -- apps packages # is any of it runtime code?
```

**A demo-only release does not advance this anchor, and that is the trap.**
`deploy-demo.sh` syncs the whole tree to `/opt/gennety-demo`, so every commit
that is an *ancestor* of a demo release ships to the demo — production-relevant
or not — while `/opt/gennety` stays where it was. That is exactly how `087e7e4`
ran in the demo for a day before reaching production. When the range above
contains a commit under `apps/bot/src/demo/`, the commits *around* it are the
ones to check, not the demo one.

The second command is the one that matters: a range that touches only `*.md` is
a documentation gap, while anything under `apps/` or `packages/` is undeployed
behaviour and needs a block at the top of this file before the next release.
Two standing exclusions, both deliberate rather than forgotten:

- **Kyiv venue-catalog commits** (`scripts/curated-venues.kyiv.*.json`) ship
  nothing. DECISIONS.md records that no `seed-venues:import` is authorised
  against prod, and that prod deliberately carries the pre-expansion catalog —
  so an import is a separate, larger decision, not part of any deploy.
- **`apps/video/**`** is the Remotion workspace and is not in the bot runtime.

Anchor md5 as of 2026-08-20 — two modules this release added plus the one it
changed, so their mere presence (and content) on the droplet is already the check:

```
59f7097650bcdaffc074fd946eda0ea8  /opt/gennety/apps/bot/src/services/rematch-card.ts
891bab6736e5598ce42f944ed7b27014  /opt/gennety/apps/bot/src/services/client-events.ts
```

`dispatch-queue.ts` is the one worth checking by CONTENT rather than presence:
the file long predates both releases, and what they changed inside it is the
guarantee that a dispatch attempt never leaves a match live-and-unstamped (§3.3)
plus the `undelivered` report the paid Rematch refund reads (§3.11). A stale copy
of that file reintroduces a permanent silent hole AND silently stops refunding:

```sh
ssh root@167.172.178.229 'grep -c disposeUndeliveredMatch /opt/gennety/apps/bot/src/services/dispatch-queue.ts'
# 4 = the 2026-08-20 fix is live (definition, call site, and two comments —
#     the 2026-08-21 refund block added the fourth mention, so a `3` means the
#     dispatch fix landed and the refund one did not).
ssh root@167.172.178.229 'grep -c undelivered /opt/gennety/apps/bot/src/services/dispatch-queue.ts'
# 7 = the 2026-08-21 refund report is live. 0 on either = stale file.
```

**The served Mini App bundle is a SEPARATE anchor and is not covered by the
sweep below** — that sweep reads `/opt/gennety` source, while the bundle lives
at `/var/www/dating-app` and only `deploy-webapp.sh` writes it. This release
nearly shipped without it. Check the asset hash, never the status code:

```sh
curl -s https://dating-calendar.gennety.com/onboarding.html \
  | grep -o '/assets/onboarding-[A-Za-z0-9_-]*\.js'
# must match: ls apps/webapp/dist/assets/onboarding-*.js in the deployed tree
# as of 2026-08-15: onboarding-5tbpPWp0.js
```

The file below is kept as the counter-example, not as a check to run:

```
45b55b6600994a7869511e777c1e4704  /opt/gennety/packages/shared/src/ai/prompts.ts
```

That file is a weak anchor on its own — it happened to be identical across the
whole 84-commit range, so it matched prod both before and after that release and
proved nothing. **Anchor on a file the release actually changed, or better, sweep
the whole tree**, which is what settles it in one command (2026-08-15: 791 files,
zero differences):

```sh
ssh root@167.172.178.229 'cd /opt/gennety && find apps packages -type f \
  \( -name "*.ts" -o -name "*.tsx" -o -name "*.prisma" -o -name "*.json" \) \
  -not -path "*/node_modules/*" -not -path "*/dist/*" | sort | xargs md5sum' \
  | sort > /tmp/prod.md5
# then in a clean worktree at the candidate sha:
find apps packages -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.prisma" \
  -o -name "*.json" \) | sort | xargs md5 -r | awk '{print $1"  "$2}' | sort \
  | diff - /tmp/prod.md5 && echo "prod == this tree"
```

Zero differences across the whole tree is what "prod is at this commit" should
mean (791 files on 2026-08-15; the number grows with the repo — it is the diff
being empty that matters, not the count).

---

**⚠️ The rule below has exactly one known exception — do not trust the marker
alone (found 2026-08-07).** The account-health block sits *below* this marker but
its commit (`44f9e41`) is dated **2026-08-03**, i.e. after this release. It was
inserted in the wrong place, so the marker's "everything below already shipped"
claim silently covered a block that had not. It was caught only because
`apps/bot/src/admin/utils/user-health.ts` was **absent** from the droplet, and it
shipped in the 2026-08-07 release. **Verify a block by whether its module is on
the droplet, not by which side of this line it is on**, and keep inserting new
blocks at the TOP of the file where the convention puts them.

**Deployed 2026-08-02 — the 104-commit catch-up: every block below that was
marked PENDING shipped in one deploy.** Full server code + Mini App + one
`db:push`. This is the release that brought prod from `f9e08eb` (2026-07-29) up
to HEAD, so the concierge audit fixes, the planning-stall chain (§3.5c), the
stage-aware pinned banner, peer-wait shimmer v2, the expiry + coordination
cards, the daily-cadence groundwork, venue observability, season/weather
ranking, the admin dialog media column and the `reference_expired` fix all went
live together.

**⚠️ One DESTRUCTIVE schema change, taken deliberately:** `profiles.ethnicity`
was dropped (the onboarding step was removed). 8 of 9 production profiles held
a value. **A backup was captured first** and lives on the droplet next to the
logical DB dump:

```
/opt/gennety/ethnicity-backup-2026-08-02T08-26-08-301Z.json   (9 rows, 8 filled)
```

Add `--exclude '*-backup-*.json'` to the deploy rsync — the documented flag set
does NOT cover this name and `--delete` would erase it. The full plan was
verified before running: 17 × `ADD COLUMN`, 1 × `CREATE INDEX`, exactly one
`DROP`. `db:drift-check` OK afterwards.

Preflight green: typecheck clean, **3378 tests** (bot 2957 / shared 264 /
webapp 157), `pnpm build`, `security:secrets` (947 files), `security:audit`
0 advisories, working tree clean. rsync dry-run listed exactly **1** deletion
(`services/delete-freeze-video.ts`, genuinely removed in `29db1d9`).

Post-deploy verified: `Bot @gennetybot started`, all 16 crons registered
**plus `[worker] Peer-wait shimmer every 20000ms`** (that line is the proof the
new code is live — it did not exist on the old build), `:3100`/`:3101`
listening, `/v1/ping` ok, admin `401`, **all 11 Mini App pages 200**,
`supportedCities` still Kyiv-only, restart count frozen (no crash loop), and
zero `P2022` / `P2023` / unhandled rejections. The concierge knowledge block
measures **0 characters** (was 22,988 — see the `admin_cache` fix).

**🟢 RESOLVED 2026-08-03 — `PLACES_API_KEY` works. Do not act on the paragraph
below.** Re-probed with the key from `/opt/gennety/.env`: `places:searchNearby`
and `places/{id}` (field mask `photos`) both answer **200**. The droplet's key
and the local `.env` key are the same (md5 match), so whatever broke it —
billing, an API toggle, a restriction — was fixed on the Google Cloud side and
nobody recorded it here. Everything listed as degraded below is working. Kept
for the record, and as a reminder to re-probe before trusting an old incident
note:

> **🔴 Pre-existing production issue found during this deploy, NOT caused by it:
> `PLACES_API_KEY` is dead.** Both `places/{id}` details and `places:searchNearby`
> answer `403 PERMISSION_DENIED` with the key from `/opt/gennety/.env` (the key is
> present and 39 chars, so it is rejected rather than missing — billing disabled,
> API disabled, or a key restriction/rotation in Google Cloud). The
> `venue-revalidation` cron has been logging it. What degrades while it is down:
> every date-card venue photo (Google Places is the single source since
> 2026-07-25 → cards fall back to the branded gradient), the Places fallback when
> no curated venue is in commute range, the Location Mini App autocomplete
> (`/v1/location/search`), the venue-change catalog beyond curated rows and its
> photo proxy, and the daily venue re-validation sweep. The curated Kyiv catalog
> is first-party and still works, so scheduling degrades rather than dies. Fix in
> the Google Cloud console; re-verify with the `searchNearby` probe above.

Re-probe (safe, read-only, one request):

```sh
KEY=$(ssh root@167.172.178.229 "sed -n 's/^PLACES_API_KEY=//p' /opt/gennety/.env | tail -1 | tr -d '\"'")
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'https://places.googleapis.com/v1/places:searchNearby' \
  -H 'Content-Type: application/json' -H "X-Goog-Api-Key: $KEY" \
  -H 'X-Goog-FieldMask: places.id' \
  -d '{"includedTypes":["cafe"],"maxResultCount":1,"locationRestriction":{"circle":{"center":{"latitude":50.45,"longitude":30.52},"radius":1000.0}}}'
```

**Rollback:** re-sync a checkout at `f9e08eb` and redeploy the Mini App from it.
The additive columns can stay; `profiles.ethnicity` would have to be restored
from the JSON backup above.

---

**Deployed 2026-08-07 (was PENDING) — account-health classification + fixed conversions (admin only).**
**No Prisma schema change, no flag change, no Mini App
change** (`apps/webapp` untouched) — but it adds **one optional env var** and
requires a **dashboard redeploy** (separate repo,
`~/Desktop/gennety-admin-dashboard`, auto-deploys to Vercel on push).

**This block was filed below the 2026-08-02 catch-up marker by mistake** (see the
warning on that marker) — its commit `44f9e41` postdates that release, so it was
still genuinely pending until 2026-08-07 despite sitting in the "already
shipped" half of the file.

**The dashboard half was already live and had been failing.** The repo was clean
and 0/0 with `origin` — `cf9c9a7` (health section, funnel, class tabs) and
`547ff83` (revenue ledger) had been pushed and auto-deployed to Vercel some time
earlier, so those tabs were calling `/admin/users/:id/health` and
`/admin/purchases` against a server that did not serve them. Nothing needed
doing on the dashboard side at deploy time; this release is what made its
existing tabs work. **When a block names a dashboard redeploy, check whether it
has already happened — a pushed dashboard against an undeployed server is a
silently broken tab, not an error anyone sees.**

Post-deploy measured: `userHealth.byClass` =
`{test: 1, suspicious: 0, stuck_onboarding: 6, cold_open_unengaged: 9,
inactive: 0, live: 4, other: 0}` over 20 users. `test: 1` is the proof the env
var landed.

```
ADMIN_TEST_TELEGRAM_IDS=-153639032722566
```

That is the founder's own mobile-rail account (`Глеб`, synthetic negative id —
verified against the live DB on 2026-08-03). **Leaving this empty is not
neutral:** the classifier then finds zero test accounts and every conversion is
divided by 20 instead of 19. It is analytics-only — nothing in matching,
workers or notifications reads it.

What ships: `/admin/stats` and `/admin/dashboard` gain a `userHealth` section
(seven mutually exclusive classes, summing to the scan) and a `funnel` whose
denominators exclude test accounts; `GET /admin/users/:id/health` explains ONE
account; `/admin/users` gains a health badge per row plus `?health=` and
`?includeTest=false`. Existing response sections are untouched.

**One number changes meaning, and the dashboard reads it:**
`derived.activeRate` was `active / users.total`; it is now
`active+verified / real users`. Against production today that is 5/19 = 0.2632
rather than 5/20 = 0.25. Anyone comparing week over week will see a step — it
is the fix, not a regression.

Measured against the live database before deploying (read-only probe, 20
accounts): live 5, stuck_onboarding 5, cold_open_unengaged 8, test 1, other 1,
suspicious 0, `matchmaking_eligible` 5 of 19, consent→active 55.6%,
registered→active 26.3%.

**Two things worth knowing before the restart:**

- **`/admin/stats` and `/admin/users` now scan the user table** (bounded by
  `HEALTH_CONFIG.max_scan_users`, 20000) on every call, because the class is
  computed rather than stored. At 20 users that is milliseconds; revisit it if
  the base reaches five figures — the fix is a short cache, not a schema
  column.
- **`bot_batch_min_users` is 3.** Three signups inside ten minutes is a
  registration burst — normal during an ad push. Verified accounts are exempt,
  so a real user who passed liveness can never be flagged this way, but
  unverified signups in a burst will be. Raise it in
  `admin/utils/user-health.ts` before a large campaign.

Post-deploy check:

```sh
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://api-admin.gennety.com/admin/stats | python3 -m json.tool | head -60
# userHealth.byClass.test must be 1, not 0 — 0 means the env var did not land.
```

**Rollback:** revert the code in both repos and restart. Nothing else to undo —
no schema, no flag. Removing `ADMIN_TEST_TELEGRAM_IDS` alone does not roll the
feature back; it just stops excluding the test account.

---

**Deployed 2026-08-02 (was PENDING) — privacy remediation, 2026-08-01 (ethnicity removed, founder-feed
delete anonymised, OTP redaction, consent versioning, biometric consent screen,
coordination-card protection).** Deployed 2026-08-02. **No env change, no flag
change** — but it **DOES need a Mini App redeploy** (`apps/webapp`:
`verification.html` + `verification.ts` + `i18n.ts` + `api.ts` carry the new
biometric-consent screen). Ships with the next full deploy — note the
divergence warning above; none of this is safe to single-file rsync.

**Order matters on this one: server first, then the Mini App.** The server
starts refusing `/init` with `409 consent-required`, and only the new bundle
knows how to answer that. A cached old bundle renders its generic error screen
until the user reloads — verification is briefly unavailable for anyone
mid-flow, which is why the two steps should be minutes apart, not hours.

**⚠️ This is the first entry in this file that needs a DESTRUCTIVE schema step.**
It drops `profiles.ethnicity`. That is the *point*: the column holds GDPR Art. 9
data (racial / ethnic origin) which was being folded into the matching embedding
with no Art. 9 basis behind it, so the data itself is the liability and erasing
it IS the remediation. Do not preserve it "just in case".

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
# Read the plan BEFORE running anything. Expect exactly two statements:
#   ALTER TABLE "users" ADD COLUMN "policy_version" TEXT;
#   ALTER TABLE "users" ADD COLUMN "biometric_consent_at" TIMESTAMP(3);
#   ALTER TABLE "users" ADD COLUMN "biometric_consent_version" TEXT;
#   ALTER TABLE "profiles" DROP COLUMN "ethnicity";
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script

# For the record, before it goes:
psql "$DATABASE_URL" -c "select count(*) from profiles where ethnicity is not null;"

pnpm --filter @gennety/db db:push --accept-data-loss
pnpm db:drift-check   # must exit 0 before pm2 restart
```

`--accept-data-loss` is required and correct here. **If the printed plan carries
any DROP other than `profiles.ethnicity`, STOP** — that is drift from another
branch, not this change.

What ships:

- **`profiles.ethnicity` is gone end to end** — the onboarding question, the
  legacy agent's tool field + prompts + context-dump gate, the chat-agent
  `update_profile` field, the fallback embedding text (`profile-analysis.ts`),
  both founder-feed cards, and the admin audience breakdown. PRODUCT_SPEC §1.3
  records why. Existing `onboarding_progress` rows that list `"ethnicity"` are
  harmless: `asField()` drops unknown values.
- **Founder feed on account close is UNCHANGED from what production does
  today.** It was briefly reduced to an anonymous lifecycle event on
  2026-08-01 and **restored by founder decision on 2026-08-02** — the delete
  notification still carries the full profile card, phone number and photos,
  because at this stage knowing exactly who left is treated as the main source
  of churn understanding. The only visible difference is one added line,
  `В продукте: N дн.`. Privacy §12.2 now discloses this prominently and
  commits to deleting those messages on request; `legal/dpia.md` R9 records it
  as a knowingly accepted residual risk. **Operational duty this creates: an
  erasure request extends to the founder-bot chat and must be executed by
  hand — nothing automates it.**
- **A typed verification code is masked in `chat_events`** before the row is
  written (`redactSensitiveSummary`), matching the bcrypt hashing
  `email_otps` / `phone_otps` already do.
- **`users.policy_version`** records WHICH version of the Terms + Privacy Policy
  a user accepted (`LEGAL_DOCS_VERSION`, currently `2026-08-01`) — GDPR Art.
  7(1) accountability. Null on all existing rows, by design.
- **`protect_content` on the coordination cards.** They render the partner's
  face and shipped without it. `COORDINATION_FEATURE_ENABLED` is already `true`
  in production, so this would have been live the moment those cards deployed.
- **A dedicated biometric-consent screen before Face Liveness.** GDPR Art.
  9(2)(a) needs an explicit act for biometric processing specifically; tapping
  "Verify now" under copy that never said the word "biometric" was not one. The
  gate is in `beginLivenessCheck`, so both the Mini App and the native rail are
  bound by it — a client that skips its screen gets a 409, not a session. Two
  more additive columns: `users.biometric_consent_at` / `_version`. **Every
  existing user must consent once** on their next verification attempt; the
  three currently-`unverified` production accounts are the only ones affected,
  and nobody loses `verified` status. **Restyled 2026-08-05, before this block
  ever shipped** — visual only, same one explicit tap, same server gate: the
  disclosure is borderless and vertically centred (padded clear of Telegram's
  floating close ×/menu ⋯ via `wireContentInsets`, which this page did not call
  before), and the action moved off Telegram's MainButton — a full-width bar
  welded to the bottom edge — onto an independent floating pill carrying the
  house inner-perimeter burgundy sheen (`.ref-share`, referral.css). Every other
  screen here still uses MainButton for its Close action.

Also lands `pnpm gdpr:export` — the subject-access / portability tool the policy
now promises. It needs no deploy step of its own (it is a script run against
whichever `DATABASE_URL` is in scope; pass `--prod` for production) but note
that its output is a full personal-data dump written OUTSIDE the repo: deliver
it over a channel the requester controls, then delete it.

Legal documents were rewritten in the same commit (Privacy Policy v4.0, Terms
v3.0). **They are not live until the website is redeployed** — see
`legal/README.md`, which also records the two remaining publication blockers
(controller postal address, Art. 27 EU representative).

**Post-deploy check**, beyond the standard checklist:

```sh
psql "$DATABASE_URL" -c "\d profiles" | grep -c ethnicity   # expect 0
curl -sD- -o /dev/null -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://api-admin.gennety.com/admin/analytics/audience | head -1   # expect 200
```

Then walk one onboarding as far as the profile questions and confirm it goes
partner-preferences → vibe with no origin question in between, and open the
Verify button once to confirm the consent screen appears before the camera and
that agreeing lands you in the detector:

```sh
psql "$DATABASE_URL" -c "select count(*) from users where biometric_consent_at is not null;"
# 0 before anyone verifies; should tick up as accounts pass the new screen.
```

**Rollback:** revert the code and restart. The dropped column can be re-added
empty, but the DATA is gone by design and is not recoverable from the
application — restore from a Supabase backup only if you genuinely intend to
reinstate Art. 9 data you just erased.

---

**Deployed 2026-08-02 (was PENDING) — Premium hub stops asking for money up front (PRODUCT_SPEC §3.8).**
Deployed 2026-08-02. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched) — the price still comes
from `PREMIUM_PRICE_USD_DISPLAY`, now rendered only by
`GET /v1/premium/state` for the Mini App. Copy-only in `packages/shared/src/i18n.ts`
(all five locales) plus `handlers/menu/premium.ts`: the hub's `Subscribe — $X/mo`
button becomes a plain "Learn more", the monthly price leaves the chat message,
and the Telegram → Settings → Subscriptions walkthrough is replaced by "just tell
me and I'll cancel it after you confirm" — which is what the concierge's
`offer_cancel_premium` flow actually does. That walkthrough is untouched where it
is load-bearing (`premiumManageNote`, the honest fallback in `premium-cancel.ts`
when the Stars API cancel fails), and an App Store subscriber viewing the hub
gets Apple's steps instead, since the concierge cannot cancel their subscription.
No post-deploy check beyond the standard checklist. **Rollback:** revert the code
and restart.

---

**Deployed 2026-08-02 (was PENDING) — purchase notifications + admin revenue ledger.** Deployed 2026-08-02.
**No env change, no flag change, no Mini App change** (`apps/webapp`
untouched) — but it needs an **additive `db:push` BEFORE the restart**, and it
requires a **dashboard redeploy** (separate repo,
`~/Desktop/gennety-admin-dashboard`, auto-deploys to Vercel on push).

One new nullable `ticket_ledger` column (`amount_stars`) is WRITTEN on every
Stars store purchase and every date-gate charge, and SELECTED by the admin
purchase list, so a DB missing it throws `P2022` on the first purchase after
the restart — the PM2 crash-loop this file warns about. Verify additive first
(expect one `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships:

- **Every real purchase now DMs the founder ops feed** (ticket store, the
  §3.5b date-ticket gate, Premium, Rematch, venue change — Telegram Stars AND
  App Store), carrying who paid (`@username`, or the phone number on the
  mobile rail where a synthetic negative `telegramId` and no username is
  normal), what they bought, and how much. **Refunds are announced too**: a
  Rematch refund can follow its own purchase within seconds, so a
  purchase-only feed would leave sales in the DM that no longer exist.
- **`GET /admin/purchases`** — the revenue ledger with filters, pagination and
  totals; plus a spend column on `/admin/users` and a full purchase block on
  `/admin/users/:id`. New **Purchases** tab in the dashboard.
- `ticket_ledger.amount_stars` freezes what was actually charged. Star prices
  are env-tunable, so a reader must never re-derive a historical price from
  `bundleSize`; before this a Stars purchase recorded no money figure at all.

**Three things worth knowing before the restart:**

- **The founder DMs ride `FOUNDER_NOTIFY_ENABLED`** (on in production) and the
  same production-only runtime guard as the rest of the feed, so a local dev
  purchase can never reach the real ops DM. Nothing new to configure.
- **Notifications fire from each rail's settlement write** — the same one whose
  unique provider charge id already makes the purchase exactly-once — so a
  redelivered `successful_payment` returns on the duplicate branch before the
  notifier runs. No new idempotency column, and no risk of double-announcing.
- **Dollar figures derived from Stars are estimates and say so.** Telegram
  publishes no Stars→USD rate; the code uses the documented $0.02/⭐ ticket
  rate and marks every such number `≈`. App Store rows carry Apple's real
  price. Expect the two to disagree slightly with a Telegram payout statement.

Post-deploy check — production has had **0 purchases ever**, so the list will
legitimately be empty until someone actually pays; the endpoint answering `200`
with zero totals is the correct result:

```sh
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  'https://api-admin.gennety.com/admin/purchases?limit=5' | head -c 400
psql "$DATABASE_URL" -c "select count(*) from ticket_ledger where amount_stars is not null;"
```

**Rollback:** revert the code in both repos and restart; the additive column
can stay (nothing reads it if the code is reverted). There is no flag — the
notifications follow `FOUNDER_NOTIFY_ENABLED`, which also silences them.

---

**Deployed 2026-08-02 (was PENDING) — audit fixes round 2, 2026-08-02 (Mini App timeouts + two dead ends).**
Deployed 2026-08-02. **No Prisma schema change, no env change, no flag change** —
but this one **DOES require a Mini App redeploy** (`apps/webapp` changed), so the
sequence is Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh`.

- **Every Mini App request now has a 20s deadline** (`apps/webapp/src/api.ts`,
  new `apiFetch`). All 44 `fetch` calls across the 12 pages had none. Each flow
  sets a `saving`/busy flag, disables its button and clears the flag only when
  the promise settles, so a request that never settles (a stalled mobile
  connection, not a slow one) left the user on a dead disabled "Saving…" with
  every further tap swallowed by the busy guard — the only way out was killing
  the Mini App. An abort surfaces as a plain `DOMException`, which is exactly
  what every caller's existing "not a `CalendarApiError` → show the network
  error" branch already handles, so no call site changed. The bot side has
  carried `AbortSignal` on all of its outbound calls for a long time; this
  closes the gap on the client.
- **The onboarding photo editor now always retires its cards**
  (`handlers/onboarding/photo-editor.ts`). `markOnboardingComplete` clears
  `session.onboardingPhotoEdit` synchronously, and it runs BEFORE the next
  outgoing message — so `closeStalePhotoEditor`'s flag-only guard returned early
  on exactly the exit it exists to handle. A user who opened the editor and then
  finished onboarding (tapping an older Continue button, or typing "done") was
  left with a stack of photo cards whose 🗑 buttons silently did nothing.
- **A user who DECLINED no longer gets consoled at expiry** (§3.4). A first
  decision leaves the row `proposed` either way, so a decliner whose partner
  then went silent reached the 24h expiry classified as an ordinary
  `responder` — and got "they never answered, your part was done on time",
  written for the person who accepted and was stood up. They now get one bare
  neutral line (`matchExpiredSelfDeclined`, all 5 locales) and **no card**: the
  card family is for §3.4's emotional beats and this is not one of them.

Also folded in: two dead symbols left over from the ethnicity removal in
`91a6d6a` (`SKIP_RE` in `onboarding-collector.ts`, an unused `history` param in
`onboarding-agent.ts`) had `main`'s `pnpm lint` gate red. Both were verified
orphans of that completed removal — deleted, no behaviour change.

**Known pre-existing flake, NOT caused by this change:**
`services/date-card/render.test.ts` times out nondeterministically in the full
suite even at its existing 60s budget. Measured standalone, one `renderDateCard`
costs ~4–5s of CPU warm or cold (satori + resvg + the canvas duotone and grain
on a 1350px card), and with 201 test files running in parallel that stretches
past 60s wall-clock. It is unrelated to anything here — date-card imports none
of the changed modules — and it reproduces on `main`. The fix is contention, not
another timeout bump: give the heavy PNG renderers their own low-concurrency
vitest project (or cap `maxThreads`). Deliberately left alone because retuning
suite-wide parallelism is a workflow decision, not an audit fix.

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo.

---

**Deployed 2026-08-02 (was PENDING) — audit fixes, 2026-08-01 (NOMATCH-2 + chat-queue + card fonts).**
Deployed 2026-08-02. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change.** Ships with whatever restart carries the blocks
below. Three independent fixes from a full-codebase audit:

- **NOMATCH-2 — the D10 pool-exhaustion pause is now always reversible**
  (`services/no-match-notifier.ts`). The status CAS and the
  `starvationPausedAt` marker were two separate writes. That mattered because
  `autoResumeStarvedUsers` selects `paused AND starvationPausedAt != null` while
  the notifier itself only ever selects `active` — so a pause that committed
  without its marker was invisible to BOTH sweeps: silently and permanently out
  of the matching pool, with nothing in the product able to bring the user back.
  They now commit in one `$transaction`. Separately, a pause whose DM failed to
  send left the user paused **and never told**; that path now resumes the
  account so the next run re-evaluates and re-sends. Inert in production today —
  `FAMINE_PAUSE_AFTER_DAYS` is 28 days and no account is near it — which is
  exactly why it was worth fixing before the mechanism starts firing.
- **The chat queue no longer manufactures unhandled rejections**
  (`chat-queue.ts`). Its cleanup hook was a promise derived from the one handed
  to the caller, with no rejection handler of its own, so **every** handler
  error raised a spurious `unhandledRejection` on top of the real error that was
  already caught. `index.ts` installs a non-fatal listener so nothing ever
  crashed — but "zero unhandled rejections" is a post-deploy health signal used
  further down this file, and it could not mean anything while ordinary errors
  fabricated them. Expect that log line to get materially quieter after this
  restart; if it does not, the remaining ones are real.
- **Card headline fonts** — see the expiry-card block below.

No post-deploy check beyond the standard checklist. **Rollback:** revert the
code and restart; nothing else to undo.

---

**Deployed 2026-08-02 (was PENDING) — expiry card (PRODUCT_SPEC §3.4).** Deployed 2026-08-02. **No Prisma
schema change, no env change, no flag change, no Mini App change**
(`apps/webapp` untouched). Always-on — there is no feature flag, because the
card degrades to the exact plain text that ships today rather than to nothing.

What ships: the 24h-decision-deadline expiry DM becomes a PNG card plus a short
caption, instead of the bare `sendMessage` it has always been. Four variants
(silent-warning / silent-penalty / partner-ghosted-you / you-ghosted-an-accept),
each with its own vector motif, rendered in the recipient's `User.theme` and
language.

**One new asset rides the ordinary code rsync:**
`apps/bot/src/assets/fonts/unbounded-700.woff` (144 KB). It is the FULL
Unbounded, added because the two subset files (`latin` + `cyrillic`) do not
cover Polish — Ą Ł Ż Ś Ć Ź Ń Ę are in Google's separate `latin-ext` subset. The
time card and match card now load this same file too (see the third bullet
below), so it serves three renderers. Nothing is removed: the subsets stay, and
the referral + coordination cards still use `unbounded-cyr-700.woff` for their
Cyrillic-only headline variant.

**Three things worth knowing before the restart:**

- **Send volume per expiry is unchanged** — still one message per side, now a
  photo instead of text. The render is pure layout + rasterize with no network
  call and no photo download (deliberately: partner photos are `protect_content`
  and a terminal match must not depend on a download), and takes ~0.4 s. It runs
  inside the existing 2 s-per-side pacing loop, so it adds no new rate-limit
  pressure.
- **The sibling font bugs ARE now fixed too (2026-08-01 audit), and one of them
  was worse than this file previously described.** The §3.6 locked-time card
  printed Polish months and weekdays (`WRZEŚNIA`, `PAŹDZIERNIKA`, `ŚR`) with
  those letters dropping into Roboto mid-word — invisible today, since
  production has **zero** `pl` users. The **match card** was the real one: it
  registered BOTH Unbounded subsets under the single family name `"Unbounded"`,
  and satori resolves a family to its first registered font rather than falling
  through per glyph, so the cyrillic subset owned it and every **Latin** glyph —
  the `Gennety` wordmark on every card, plus any Latin partner name — rendered
  in Roboto. That affected `en`/`de`/`pl` recipients on the most prominent card
  in the product, under a flag that is ON. Both now load the same
  `unbounded-700.woff` this deploy already ships, so the asset carries three
  renderers rather than one and no new file is needed.
  `apps/bot/src/services/card-headline-fonts.test.ts` is the regression guard.
  The **referral and coordination cards were never affected** — they switch to
  Archivo Black for non-Cyrillic locales, which covers Latin, Polish and German.
- **Nothing exercises this until a match actually expires.** Production has 0
  matches ever, so the first real card renders only after a drop pairs someone
  and one side lets the 24h window close. Verify on `@gennetytestbot` first —
  `scripts/dev-expiry-cards-demo.mjs` renders and sends all four variants in
  both themes without touching the database.

Post-deploy check — the notify sweep already logs its own totals:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[expiry-notify\]'
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state. The added font file can stay either way.

---

**Deployed 2026-08-02 (was PENDING) — pre-date coordination PNG cards (PRODUCT_SPEC §Phase 4).** Deployed 2026-08-02. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched). Ships with whatever
restart carries the blocks below.

What ships: the five coordination DMs stop being bare text. Each becomes ONE
message — a rendered PNG, the SAME localized copy as its caption, the same
inline keyboard — mirroring the date card and the venue wish card. Uses the
already-deployed satori/resvg/canvas stack and the already-bundled fonts, so
`pnpm install` pulls nothing new and there is no system dependency to add.

**Three things worth knowing before the restart:**

- **⚠️ "Inert in production today" was wrong** (corrected 2026-08-08).
  `COORDINATION_FEATURE_ENABLED=true` is set in `/opt/gennety/.env` and the
  running process reports `features.coordination: true` on `/v1/app/config`, so
  the sweep DOES send the T-60m offer and DOES open the T-30m window. The cards
  in this block are therefore live. Nothing has exercised them only because
  production has had **0 dates ever** — which is why the mistake cost nothing
  and also why it went unnoticed for six days.
- **Fail-open is the load-bearing property, not the cards.** A null render, a
  caption over Telegram's 1024-char photo limit, or a rejected `sendPhoto` each
  fall through to the exact plain-text DM the flow sends today. This DM lands
  ~1h before a date and is the only way the pair can find each other, so a
  render hiccup must cost a picture, not the message. Watch for the fallback
  ever firing in production:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[coordination-card\]'
```

- **Verify on the dev bot, not in prod.** Production has 0 dates ever, so
  nothing will exercise this until a Thursday batch pairs someone AND that pair
  reaches `scheduled` AND the flag is on. `scripts/dev-coord-cards-demo.mjs`
  renders and DMs every variant without touching the database, and
  `scripts/dev-coord-offer-demo.mjs` plays the real flow end to end.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-02 (was PENDING) — daily-cadence matching migration groundwork (PRODUCT_SPEC §3.1 /
§3.1b, `DAILY_MATCHING_MIGRATION_AUDIT.md`, `DAILY_MATCHING_IMPLEMENTATION_PLAN.md`).**
Deployed 2026-08-02. **Code + one additive schema column, no env change required
to keep current behavior, no Mini App change.** `DROP_CADENCE` is unset in
`/opt/gennety/.env` today and this deploy does not add it — production keeps
running the `weekly` profile byte-for-byte identical to today (pinned by
`packages/shared/src/cadence.test.ts`). Ships **inert**: a `daily` profile
exists in code but nothing switches to it as part of this deploy.

What ships: an internal `DropCadence` abstraction
(`packages/shared/src/cadence.ts`) that every cadence-dependent constant in
the matching engine, proposal deadlines, nudges, the famine notifier, the
Profiler, and Rematch now reads from, selected once at boot by `DROP_CADENCE`
(`weekly` default | `daily`). Plus a genuinely new mechanism, D10 — an honest
pause instead of an endless famine-tier ladder: a user whose `computeTier`
day-count reaches `FAMINE_PAUSE_AFTER_DAYS` (28, a flat code constant —
`packages/shared/src/constants.ts`) is paused via the same CAS the menu's own
Pause button uses, gets one honest DM instead of another tier notice, and is
auto-resumed the moment `findCandidatesFor` would find them a candidate again
(`services/pool-exhaustion.ts`, `autoResumeStarvedUsers`, same cron tick as the
famine notifier).

**⚠️ Requires an additive `db:push` before restart.** One new nullable column,
`profiles.starvation_paused_at`, is read by `services/account-status-transitions.ts`
on every resume and by `services/pool-exhaustion.ts` on every famine-notice
tick, so a DB missing it throws `P2022` on the first no-match-notice cron after
restart — the PM2 crash-loop this file warns about elsewhere. Verify additive
first (expect one `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

**Four things worth knowing before the restart:**

- **Match daily, apologise weekly (founder decision 2026-08-02, folded into
  this same unshipped block).** The `daily` profile's notice throttle was
  retuned from ~2.5 days to **7 days**, and `famineDiscountMinTier` from 7 to
  **2**, so flipping the cadence later changes how often we *look*, never how
  often we *write*: a nightly drop that finds nobody sends **nothing at all**,
  and the empathetic check-in keeps today's weekly rhythm, tier ladder and
  second-notice discount. Two supporting changes ship with it — `computeTier`
  is now denominated in the NOTICE interval (a tier is "which message in the
  streak", so the tier-2 copy and the discount threshold mean the same thing
  under any cadence; the old batch-denominated version would have made a
  `daily` user's second-ever notice arrive as tier 7 and skip tier 2 entirely),
  and the pinned banner drops its countdown whenever drops outpace notices
  (`dropOutpacesNotices`) so the timer never ticks to zero into deliberate
  silence. **All of it is inert under `weekly`** — `cadence.test.ts` pins both
  profiles and `status-banner-view.test.ts` pins the banner's off state.
- **`FAMINE_PAUSE_AFTER_DAYS = 28`, not 14.** `computeTier` is denominated in
  `CADENCE.famineNoticeIntervalMs` (7 days in both profiles), so tier 2 lands
  at day 14 — a 14-day pause threshold would fire at the exact same moment as
  the famine discount and make tier 3 structurally unreachable. 28 lets the
  tier 1→2→3 ladder (days 7/14/21) play out before the pause takes over, and
  because the interval no longer varies by profile, that ladder now sits at the
  same wall-clock days under `daily` too.
- **Nothing in this deploy changes what any user currently experiences.**
  Every cadence-dependent constant's `weekly` value is asserted byte-for-byte
  identical to what it replaces (`cadence.test.ts`); the only genuinely new
  user-visible surface (D10's pause/resume) is reachable but, per the same
  tier-2-at-day-14 math above, essentially never fires under `weekly` in
  practice at current pool sizes — it exists so the mechanism is proven before
  `daily` cadence (where it fires routinely) is ever turned on.
- **Rematch's env-backed knobs were deliberately left untouched.**
  `REMATCH_MAX_PER_WEEK` / `REMATCH_COOLDOWN_HOURS` /
  `REMATCH_PRE_BATCH_BLACKOUT_HOURS` still read plain `env.*` in `config.ts`,
  not `CADENCE` — moving them would require `config.ts` to import
  `@gennety/shared`, which breaks the dotenv-loading order guarantee
  (`config.ts` must stay the first module evaluated). They need manual review
  before Rematch is ever enabled under `daily`; `REMATCH_FEATURE_ENABLED`
  itself is untouched by this deploy and stays whatever it already is in prod.

**Flipping `DROP_CADENCE=daily` in production is explicitly NOT part of this
deploy** — it is a separate, later decision gated on the founder's judgment
about pool size, not on anything shipped here. When that day comes: set
`DROP_CADENCE=daily` in `.env`, `pm2 restart gennety-bot --update-env`, no
further schema or code change needed (the `daily` profile ships in this
deploy, dormant).

What that flip will visibly change, so it isn't discovered live: the pinned
banner loses its drop countdown for everyone without a live match (steady
"I'm looking — I check every evening" instead), most evenings send no message
at all, and the agent starts quoting the shorter planning deadlines. What it
will NOT change: how often a starved user hears from us, the tier ladder, or
when the discount lands. Two things to watch on the first days —
`FAMINE_PAUSE_AFTER_DAYS` (28) stops being theoretical and will start firing
routinely at small pool sizes, which is intended (an honest pause plus
auto-resume beats a fourth tier of apology), and the Rematch knobs above still
need their manual review first.

Post-deploy check — the drop-batch log prefix confirms the new code is live
without needing to wait for Thursday:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[drop-batch\]\|\[pool-exhaustion\]'
psql "$DATABASE_URL" -c "select count(*) from profiles where starvation_paused_at is not null;"
```

**Rollback:** revert the code and restart; the additive column can stay
(nothing reads it if the code is reverted). There is no flag to unset — this
deploy adds no env var.

---

**Deployed 2026-08-02 (was PENDING) — season + weather venue ranking (PRODUCT_SPEC §3.7,
VENUE_ENGINE_IMPROVEMENT_PLAN 5.3).** Deployed 2026-08-02. **No Prisma schema
change, no Mini App change** (`apps/webapp` untouched) — but it ships alongside
the observability block below, which DOES need an additive `db:push`, so follow
that block's schema step. One new external dependency, one new flag, ships
**off**.

What it does: a park in a January downpour ranks below a comparable indoor spot.
It is a **soft multiplier, never a filter** — the venue stays fully selectable,
because a wrong forecast or a dead provider must not be able to withhold a venue
from a couple. The combined season × weather factor is clamped to `[0.8, 1.1]`
by a code constant, so it can reorder near-ties and nothing more.

**New external dependency: Open-Meteo** (`api.open-meteo.com`). **No API key, no
account, no quota, nothing to configure** — that is why it was picked over a
credentialed provider for a signal worth a few positions of reordering. One
request per venue selection (not per candidate), cached in-process by city +
hour. If the droplet's egress is ever firewalled, allow `api.open-meteo.com:443`;
otherwise there is no setup step at all.

New env (all optional):

| Key | Default | Effect |
|---|---|---|
| `VENUE_SEASON_WEATHER_ENABLED` | `false` | Master flag. Off → multiplier is a constant 1.0 and **no forecast is ever requested**. |
| `VENUE_WEATHER_TIMEOUT_MS` | `2500` | Upper bound on the forecast wait. Past it the run continues weather-blind rather than making the pair wait. |
| `VENUE_WEATHER_CACHE_TTL_MS` | `3600000` | In-process cache TTL. Failures are cached too, so an outage cannot become a retry storm. |

**Three things worth knowing before flipping the flag:**

- **Every failure is fail-open, by construction.** Network error, timeout,
  non-200, unparseable body, a date past Open-Meteo's ~16-day horizon — all
  return null, and null scores exactly like *perfect* weather, never like bad
  weather. The forecast can only ever make an exposed venue rank slightly
  better or slightly worse; it can never remove one.
- **Most of the catalog is unaffected.** Indoor venues score exactly 1.0 in
  every condition, as does any venue whose exposure the catalog does not
  record. In practice this moves parks and a handful of scenic/outdoor rows.
- **It runs on the selection path**, so the flag is safe to flip live with
  `pm2 restart gennety-bot --update-env`, but production currently has **0
  matches ever** — nothing will exercise it until the first Thursday batch
  pairs someone and that pair reaches `negotiating_venue`.

Post-deploy check — the multiplier is named in `venueSelectionReason` only when
it actually moved a winner, so its absence on indoor picks is correct:

```sh
psql "$DATABASE_URL" -c "select venue_name, venue_selection_reason from matches where venue_selection_reason like '%context%' order by updated_at desc limit 5;"
```

**Rollback:** `VENUE_SEASON_WEATHER_ENABLED=false` +
`pm2 restart gennety-bot --update-env`. No schema, no data, nothing to undo.

---

**Deployed 2026-08-02 (was PENDING) — venue observability (VENUE_ENGINE_IMPROVEMENT_PLAN part 6).** Deployed 2026-08-02. **No Mini App change** (`apps/webapp` untouched) — but it needs an
**additive `db:push` BEFORE the restart**, and it ships alongside the blocks
below, which need their own schema steps. Do every schema step, then one
restart. A **dashboard redeploy** (separate repo, `~/Desktop/gennety-admin-dashboard`)
is only needed to *render* the new endpoint; the API works without it.

One new nullable `venue_selection_logs` column (`city_key`) plus one index is
WRITTEN on every venue selection and SELECTED by the new admin route and the
weekly alert worker, so a DB missing it throws `P2022` on the first date that
gets a venue after the restart — the PM2 crash-loop this file warns about.
Verify additive first (expect one `ADD COLUMN` + one `CREATE INDEX`, zero
`DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships, and why:

- **The selection funnel is recorded.** `topCandidates` now holds
  `{candidates, poolSizes}` instead of a bare array — `poolSizes` is how many
  venues survived each stage (`curatedInBox` → `curatedEligible` →
  `placesAdded` → `ranked`). The engine fails silently (dates keep being
  scheduled), so the `.slice(0, 20)` that left 20 of 661 eligible Kyiv venues
  in the running could only ever be found by a hand-written production query.
- **`GET /admin/analytics/venue-concentration?days=7`** — per city: the funnel,
  top venues by share, a concentration index, and `failureReason` counts.
  Cached 15 min, honours `?fresh=1`, emits `X-Data-Generated-At`.
- **Weekly alarm into the founder ops DM**, Friday 10:00 Kyiv.

New env (all optional, all default to the safe value):

| Key | Default | Effect |
|---|---|---|
| `VENUE_CONCENTRATION_ALERT_ENABLED` | `false` | Registers the weekly cron. Also inert unless `FOUNDER_NOTIFY_ENABLED` (the only delivery channel). |
| `VENUE_CONCENTRATION_ALERT_THRESHOLD_PCT` | `15` | Share of a city's dates one venue may take before it is worth a message. |
| `VENUE_CONCENTRATION_ALERT_WINDOW_DAYS` | `7` | Lookback window. |
| `VENUE_CONCENTRATION_ALERT_CRON_SCHEDULE` | `0 10 * * 5` | Friday morning, so the window always contains a full Thursday drop. |

**Three things worth knowing before the restart:**

- **The funnel and `cityKey` are NOT gated by the alert flag.** They are data,
  useful whether or not anyone is being paged, and they start filling on the
  first venue selection after the restart. Only the weekly DM is behind
  `VENUE_CONCENTRATION_ALERT_ENABLED`.
- **Existing log rows keep the old bare-array `topCandidates` and carry no
  funnel.** `parsePoolSizes` returns null for them on purpose — a zeroed funnel
  would drag the median down and fake a pool collapse. They show as
  `samples: 0` until new rows accumulate.
- **A thin city will look concentrated and that is arithmetic, not a defect.**
  Two of three dates in one place is 66%. The alert therefore always carries
  the sample size; a minimum-sample threshold was deliberately NOT added
  because it would blind the alarm exactly when a new market launches.

Post-deploy check — production currently has **0 matches ever**, so the log
table is empty and both surfaces will legitimately return nothing until the
first Thursday batch pairs someone and that pair reaches `negotiating_venue`:

```sh
psql "$DATABASE_URL" -c "select count(*), count(city_key) from venue_selection_logs;"
curl -sD- -o /dev/null -H "Authorization: Bearer $ADMIN_API_KEY" \
  'https://api-admin.gennety.com/admin/analytics/venue-concentration?days=7' | head -1
```

**Rollback:** revert the code and restart; the additive column can stay. To stop
only the DM without a code change, set `VENUE_CONCENTRATION_ALERT_ENABLED=false`
and `pm2 restart gennety-bot --update-env`.

---

**Deployed 2026-08-02 (was PENDING) — admin dialog media + the fat user card (ARCHITECTURE.md
→ `chat_events` / Admin API).** Deployed 2026-08-02. **No env change, no flag
change, no Mini App change** (`apps/webapp` untouched) — but it needs an
**additive `db:push` BEFORE the restart**, and it ships alongside the blocks
below, which need their own schema steps. Do every schema step, then one
restart. It also requires a **dashboard redeploy** (separate repo,
`~/Desktop/gennety-admin-dashboard`, auto-deploys to Vercel on push).

One new nullable `chat_events` column (`media`) is SELECTED by the admin dialogs
reader and WRITTEN by the outbound API transformer on every media send, so a DB
missing it throws `P2022` on the first photo the bot sends after the restart —
the PM2 crash-loop this file warns about. Verify additive first (expect one
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships, and why each piece exists:

- **Chat media is finally recorded.** `chat_events` stored only a sentence
  ("(photo card, no caption)", "sent a photo"), so the admin dialog reader could
  say a photo happened and never show it — every image in every conversation was
  invisible, which is what "многое количество форматов контента в чате просто не
  видно" actually was. The `file_id` is now read off the API **result**, which is
  the only capture point that works for the bytes-only sends (date card, кружок,
  generated voice note) that carry no id going out.
- **Inbound media too**, plus stickers, which previously fell through
  completely unrecorded.
- **The rich AI-compose finaliser now records itself.** `streamComposedRich`
  persists its final message with `sendRichMessage`, a raw Bot API call the
  outbound transformer does not classify, and unlike the classic stream it
  never called `recordOutboundMessage`. So **every Profiler question was absent
  from the timeline** — the reader showed a user's answers with nothing above
  them, and the concierge agent resolving a bare "why?" against the last thing
  on screen could not see the question either. Visible in production today: the
  06:01 answers in one live dialog have no questions above them.
- **The user card carries the data it always claimed to.** `eloScore` was
  already in the payload and simply never rendered; `homeCity`, tickets,
  Premium, the contact rails, `embeddingDirty`, `standbyCount`, the vibe axes,
  the match history and the Profiler answers were not in the payload at all.
- **Cache freshness.** Analytics TTLs run 10–60 min with nothing on screen
  admitting it. Every cached route now emits `X-Data-Generated-At` /
  `X-Data-Cache` and honours `?fresh=1`.

**Four things worth knowing before the restart:**

- **The timeline now records from `/start`, not from the end of onboarding**
  (founder decision 2026-07-31 — PRODUCT_SPEC §2.1). Registration was the one
  stretch of the conversation the dialog reader could not see. Expect
  `chat_events` to grow faster and to contain onboarding-era content: a typed
  OTP code, and a ≤300-char excerpt of a pasted AI-memory export (that branch
  is off in production — `AI_MEMORY_EXPORT_ENABLED=false` — so it is currently
  theoretical). The 30-day `retention` sweep is what bounds both. The phone
  number is still never stored; the contact share is recorded as the event.
  Reverting is a code change, not a flag: `resolveChatTarget` in
  `services/chat-events.ts`.
- **Existing rows have `media = NULL` and stay text-only.** Nothing backfills,
  and nothing can: Telegram `file_id`s were never stored for those sends. The
  transcript fills in from the first message after the restart.
- **The CORS `exposedHeaders` addition is load-bearing** for the dashboard's
  freshness display — without it the browser silently cannot read the header
  even though the server sends it. `ADMIN_DASHBOARD_ORIGIN` must be a concrete
  origin (it already is) or CORS is denied outright and this is moot.

Post-deploy check, beyond the standard checklist — the column should start
filling within minutes of any real bot traffic, and onboarding chats should
start appearing at all:

```sh
psql "$DATABASE_URL" -c "select kind, count(*) from chat_events where media is not null group by 1;"
# Was structurally 0 before this deploy — anything here proves the widened scope.
psql "$DATABASE_URL" -c "select count(*) from chat_events e join users u on u.id=e.user_id where u.onboarding_step <> 'completed';"
curl -sD- -o /dev/null -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://api-admin.gennety.com/admin/analytics/cities | grep -i 'x-data-'
```

**Rollback:** revert the code in both repos and restart; the additive column can
stay. There is no flag — the recorder writes `media` unconditionally, and the
worst case of leaving it is a nullable column nothing reads.

---

**Deployed 2026-08-02 (was PENDING) — `reference_expired` is escapable again (PRODUCT_SPEC §1.4 rule 5).**
Deployed 2026-08-02. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched). Ships with whatever
restart carries the blocks below.

What it fixes: `beginLivenessCheck` refused every `verified` user, so a user
whose reference selfie the 90-day scrub removed was told by three surfaces to
"verify again to change your photos" and then refused `409 already_verified` by
the only call that could do it. The refusal is now conditional on
`verifiedSelfiePath`. Such a re-run deliberately does **not** write `pending` —
matching admits `verified` only, so a downgrade would drop a long-tenured user
out of the pool over a photo edit.

**Probably nobody is in this state yet — not verified against the live DB.** The
scrub keys off `verifiedAt + 90 days`, and the production state recorded at the
2026-07-27 deploy was a single `verified` account whose check ran 2026-07-26, so
its reference is not due for scrubbing until late October. That is an inference
from a three-day-old note, not a measurement. Run this before assuming the fix is
still theoretical (and note the admin API cannot answer it — it needs the DB):

```sh
psql "$DATABASE_URL" -c "select count(*) from users where verification_status='verified' and verified_selfie_path is null;"
```

**Rollback:** revert the code and restart. Nothing else to undo.

---

**Deployed 2026-08-02 (was PENDING) — peer-wait shimmer v2 (PRODUCT_SPEC §3.6b).** Deployed 2026-08-02.
**No env change, no flag change, no Mini App change** (`apps/webapp` untouched) —
but it needs an **additive `db:push` BEFORE the restart**, and it ships alongside
the two blocks below, which need their own schema steps. Do all three schema
steps, then one restart.

Two new nullable `matches` columns (`peer_wait_started_at_a/_b`) are SELECTED by a
worker that runs every 20 s, so a DB missing them throws `P2022` on the first tick
— the PM2 crash-loop this file warns about. Verify additive first (expect two
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships: the shimmer's wording stops rotating on a 60 s clock and instead
climbs a **five-tier ladder keyed to how long that side has actually waited**
(<5 m / 5 m–1 h / 1–6 h / 6–24 h / >24 h), one line each, plain text with no
icon. Plus two coverage fixes: the calendar's **both-picked-no-overlap**
state (previously silent for BOTH sides until the §3.5c 24 h check-in) and the
**§3.7b venue-change board** (previously no shimmer at all — its ~4 s polling only
covers an open Mini App).

**Three things worth knowing before the restart:**

- **Tiers 4 and 5 are claims about other workers.** "Напомнили {name} о вас" at
  6 h is true only because `match-nudge` fires there, and "{name} долго не
  отвечает" at 24 h is the window the §3.5c 24 h check-in / 48 h cancellation
  sits in. If either schedule is retuned, retune these boundaries with it
  (`TIERS` in `services/peer-wait.ts`).
- **The copy was rewritten once already, same day (2026-07-31), before ever
  shipping.** The first five-tier pass (`Ждём {name}` / `От {name} пока тихо` /
  …) was too terse for a repeat visitor to tell what was actually being waited
  on; every line now states the mechanic ("ждём ответа") explicitly, chosen from
  three candidate ladders demoed live in a dev chat. Tier 5 also dropped the
  "время поджимает" tail — a founder call that the bare fact carries the
  urgency without an explicit pressure phrase.
- **These statuses carry no emoji or animated glyph at all** (founder decision
  2026-07-30) — unlike every other `<tg-thinking>` beat in the product, which
  keeps its AIActions glyph. If a future edit adds one back, that is a product
  change, not a fix; a test in `services/peer-wait.test.ts` asserts the absence.
- **One venue-change interaction is expected, not a bug.** That branch runs on
  `scheduled`, which is not a Profiler-blocking status, so a Profiler question can
  land mid-wait and collapse the draft; the next tick (≤20 s) re-issues it. The
  other three scenarios sit on statuses where the waiting side's chat is quiet.

Watch on the first day that the anchor is only written on real waits — it should
NOT grow by one row per user per tick:

```sh
psql "$DATABASE_URL" -c "select count(*) from matches where peer_wait_started_at_a is not null or peer_wait_started_at_b is not null;"
pm2 logs gennety-bot --lines 200 --nostream | grep '\[peer-wait\]'
```

**Rollback:** `PEER_WAIT_TICK_MS=0` + `pm2 restart gennety-bot --update-env`
disables the whole feature with no code change (note that with it off the
calendar/venue waits show nothing at all — the old confirmation messages were
removed, not merely decorated). Or revert the code; the additive columns can stay.

---

**Deployed 2026-08-02 (was PENDING) — stage-aware pinned banner (PRODUCT_SPEC §2.1).** Deployed 2026-08-02.
**This change adds no Prisma schema change, no env change, no flag change, and no
Mini App change** (`apps/webapp` untouched) — but it ships alongside the planning
stall chain below, which DOES need an additive `db:push`, so follow that block's
schema step. Sequence: Deploy Full Server Code → `db:push` (for §3.5c) →
`pnpm db:drift-check` → `pm2 restart`.

What ships: the pinned banner stops always counting down to Thursday. A user
holding a live match is excluded from that batch (§3.2 filter 8), so the banner
now counts down whatever is actually next for them — the 24 h reply deadline on a
`proposed` pitch (label byte-identical to the pitch keyboard's own button), the
time to the date once `scheduled`, or a neutral "date being planned" in between,
each opening the My Date hub instead of the menu. No live match → the original
drop countdown, unchanged. The unlaunched-city waitlist banner still outranks
everything.

**No new API-call volume.** The banner was already re-edited every minute per
active user, and the per-tick match query is still one `findMany` (widened from
`scheduled` to all four live statuses — a user holds at most one live row, so
cardinality is unchanged). Nothing new is sent; only the text of the message that
was already being edited changes.

Two things worth knowing before the restart:

- **The scheduled-date line moved rather than being added.** It used to be an
  extra line *below* the drop status; a scheduled date now owns the whole banner.
  Anyone with a live date sees the drop schedule leave the pin — intended, with
  the reasoning in §2.1.
- **Production had 0 matches ever at the last deploy**, so on day one every
  active account is on the unchanged drop mode and this is invisible until the
  first Thursday batch actually pairs someone. The new modes therefore get their
  first real exercise in production — verify them on `@gennetytestbot` first.

Post-deploy check (beyond the standard checklist): the `status-timer` heartbeat's
`eligible`/`unchanged` counts should look exactly like the previous deploy's, and
no new banner errors should appear.

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep 'status-banner'
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-02 (was PENDING) — planning stall chain (PRODUCT_SPEC §3.5c).** Code-only otherwise:
**no env change, no flag change, no Mini App change** (`apps/webapp` untouched).
Always-on — there is no feature flag, because the thing it fixes is a hole rather
than a feature: the scheduling and venue steps had no deadline, so a partner who
went quiet kept BOTH sides out of every weekly batch indefinitely.

**⚠️ Requires an additive `db:push` BEFORE the restart.** Seven new nullable
`matches` columns are selected by a worker that runs every hour AND written by
`startScheduling` on every mutual accept, so a DB missing them throws `P2022` —
the PM2 crash-loop this file warns about. Verify additive first (expect seven
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

New columns: `venue_nudge1_sent_at`, `venue_nudge2_sent_at`,
`scheduling_opened_at`, `stall_check_in_sent_at_a/_b`,
`stall_confirmed_at_a/_b`.

What ships: 6 h/12 h reminders on the venue step (which had none), a "still in?"
check-in with 🟢/🔴 at 24 h, and cancellation at 48 h that frees both sides for
the next drop. Plus cancellation by **text or voice at every planning stage** —
the agent's `propose_cancel_date` filtered on `scheduled` alone, so someone
writing "I want to cancel" mid-planning got an explanation and no way out.

**Two behaviours worth knowing before the restart:**

- **The existing scheduling nudge cadence changes anchor.** It counted from
  `dispatchedAt`, which also covers the up-to-24 h decision window, so a pair
  that accepted at hour 23 could get "pick a time" seconds after the Calendar
  card. It now counts from `scheduling_opened_at`. In-flight rows have that
  column null and keep the old dispatch anchor, so nothing in flight changes
  behaviour mid-deploy.
- **The 48 h cancellation is real and irreversible.** Production currently holds
  0 matches ever, so there is nothing in flight to sweep on the first tick — but
  check before restarting if that has changed:

```sh
psql "$DATABASE_URL" -c "select status, count(*) from matches where status in ('negotiating','negotiating_venue') group by 1;"
# Any such row older than 48h will be cancelled on the first non-quiet-hours
# tick. Both sides get a notice and next-batch priority; nothing is lost, but
# know it is coming rather than discovering it in the logs.
```

Watch the first day via the cron line — it only logs when something happened:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[match-nudge\]'
pm2 logs gennety-bot --lines 200 --nostream | grep '\[match-stall\]'
```

**Known gap, deliberately deferred:** a stall cancellation does **not** refund a
paid Date Ticket. That hole already exists on every other cancellation path
(emergency cancel of a scheduled date burns both tickets today — neither
`cancel-in-flight-matches.ts` nor `handlers/date/emergency.ts` mentions refunds).
It is being fixed in a separate pass under one rule: the date didn't happen → the
ticket returns to the wallet, for everyone who paid. Until then this change
widens the existing hole slightly, so don't leave the two deploys far apart.

**Rollback:** revert the code and restart. The additive columns can stay. There
is no flag to flip — if the chain has to be stopped without a code revert, set
`MATCH_NUDGE_CRON_SCHEDULE` far-future (e.g. `0 0 31 2 *`), which also silences
every other match nudge.

---

**Deployed 2026-07-29 — admin ops endpoints + the three blocks that had been
sitting PENDING below (`f9e08eb`, 30 commits since `58134b8`… i.e. everything
after the 2026-07-27 release).** Full server code + Mini App + **both** additive
migrations. The three PENDING blocks that used to head this file
(peer-wait shimmer, Kyiv-only market gate, chat timeline) all shipped in this
one deploy and are marked *Deployed* in place below; their env/rollback notes
stay valid as reference.

What prompted it: six `/admin/*` paths were 404ing. The finding was that **none
of them was a stale deploy** — prod's admin surface was byte-identical to HEAD.
They had never been written, and three already existed under a different name
(`/admin/analytics/matches`, `/admin/dialogs`, `/admin/analytics/weekly-matches`).
New: `/admin/health` `/admin/stats` `/admin/dashboard` `/admin/matches`
(`admin/routes/ops.ts`), plus `/admin/conversations` and
`/admin/analytics/founder-weekly` as aliases on the existing handlers.

Schema step was verified additive before running — `prisma migrate diff --script`
produced **zero DROPs**: 4 × `ADD COLUMN` (`matches.peer_wait_*`) and
`CREATE TABLE chat_events` + 2 indexes + FK. `db:push` → `db:drift-check` **OK**
→ restart.

Preflight green: **183 bot test files / 2503 tests**, all typechecks, `pnpm build`,
`security:secrets` (875 files), `security:audit` 0 advisories.

Post-deploy verified: `Bot @gennetybot started`, **all crons registered plus
`[worker] Peer-wait shimmer every 20000ms`** (that line is the proof the new code
is live — it did not exist before), `:3100`/`:3101` listening, `/v1/ping` ok,
admin `401` unauthenticated, **all 12 Mini App pages 200**, `supportedCities`
now Kyiv-only via `/v1/app/config`, `/admin/dialogs/:id` `sources.timeline: true`
(was `false` — the table finally exists), restart count 1 with no crash loop, and
**zero new `P2022`/`P2023`** (counts held at 113/14, all historical — confirmed by
firing fresh requests and re-counting).

Two live bugs were found and fixed while verifying, both pre-existing:
- **`/admin/users/:id` 500'd on a malformed id.** A non-UUID does not read as
  "not found" to Prisma — it throws `P2023`, which the route reported as
  "Internal server error" with a stack trace. Now `400 {"error":"id must be a
  UUID"}` on `/admin/users/:id`, its `/conversation`, and `/admin/dialogs/:id`.
- **`datingadmin.gennety.com` is DOWN** (not caused by this deploy, not fixed by
  it): its Let's Encrypt certificate has **expired**, and even ignoring the cert
  the host answers `404`, so the domain is no longer attached to the Vercel
  project. DNS still points at Vercel. The dashboard is reachable only at
  `https://gennety-dating-dashboard.vercel.app`. Note `ADMIN_DASHBOARD_ORIGIN`
  still lists the dead domain, which is harmless but should be re-pointed when
  the domain is restored. **Superseded 2026-08-01** — see below.

**2026-08-01 (env-only) — `admin.gennety.com` added to `ADMIN_DASHBOARD_ORIGIN`.**
The dashboard's Vercel domain was changed to `admin.gennety.com`, and the admin
API's CORS allowlist is a concrete-origin list (empty/`*` DENIES cross-origin),
so every request from the new domain failed at the preflight — surfacing in the
browser as `Failed to fetch` with nothing loading at all, not even the user
list. Fixed by editing `/opt/gennety/.env` (backed up first) +
`pm2 restart gennety-bot --update-env`:

```
ADMIN_DASHBOARD_ORIGIN=https://admin.gennety.com,https://datingadmin.gennety.com,https://gennety-dating-dashboard.vercel.app
```

All three are kept so the old Vercel URL keeps working during the cutover. The
dead `datingadmin` entry is still listed and still harmless. Verified live: a
preflight carrying `Origin: https://admin.gennety.com` answers `204` with
`access-control-allow-origin` echoing that origin, while a foreign origin gets
`204` with **no** `access-control-allow-origin` (i.e. the allowlist is still a
real gate, not a wildcard). **This is the only change needed when the dashboard
moves domains** — no code, no schema, no redeploy. Rollback: restore the
`.env.bak.*` snapshot and restart.

rsync dry-run listed exactly 2 deletions (the usual stale `apps/video/build`
artifacts). **The exclude list was widened for this run** with
`--exclude 'prod-backup-*.json' --exclude '*.bak.*'`: the droplet holds
`prod-backup-2026-07-27T14-08-06-066Z.json` (a logical DB dump that exists
nowhere else) and a hand-edit `.bak` of `admin/server.ts`, both of which the
documented flag set would have deleted. Consider keeping those excludes.

**Rollback:** re-sync a checkout at `58134b8`, restart, redeploy the Mini App
from it. The additive columns/table can stay. `PEER_WAIT_TICK_MS=0` disables the
shimmer without a redeploy.

---

**Deployed 2026-07-29 (was PENDING) — peer-wait shimmer (PRODUCT_SPEC §3.6b).**
Code-only otherwise: **no flag change, no Mini App change** (`apps/webapp`
untouched). One new optional env var, one **required additive `db:push`**.

**⚠️ Push the schema BEFORE the restart.** The new
`matches.peer_wait_message_id_a/_b` + `peer_wait_edited_at_a/_b` columns are
selected by a worker that runs every 20 s, so a DB missing them throws `P2022`
on the first tick — the PM2 crash-loop this file warns about. Verify additive
first (expect four `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships: instead of a flat "saved, we'll tell you when they reply" line, the
side that has committed and is now blocked on its partner sees a
`<tg-thinking>` shimmer for the WHOLE wait, wording rotating, gone the moment
the partner answers. Applies to the pitch decision (the card stays, shimmer
under it), the calendar first-mover, and the venue confirm (both of which now
send NO message at all).

**`PEER_WAIT_TICK_MS`** (optional, default `20000`, `0` disables the whole
feature) — the re-issue interval. A rich draft dies ~30 s after it is issued, so
this must stay comfortably under that or the shimmer visibly blinks out between
ticks. `0` is the kill switch: no redeploy, just
`pm2 restart gennety-bot --update-env`.

**Watch on the first day: call volume.** This is a per-waiter heartbeat — one
draft re-issue every 20 s for every side currently waiting. Confirm the worker is
only touching real waits:

```sh
# Logs only when something notable happened (fallback sent/cleared, or errors).
pm2 logs gennety-bot --lines 200 --nostream | grep '\[peer-wait\]'
# Should stay empty on the rich path: the fallback is for clients that cannot
# render rich drafts, and a non-empty column means someone is on that path.
psql "$DATABASE_URL" -c "select count(*) from matches where peer_wait_message_id_a is not null or peer_wait_message_id_b is not null;"
```

**Rollback:** set `PEER_WAIT_TICK_MS=0` and restart (feature off, no code
change), or revert the code. The additive columns can stay either way. Note that
with the feature off the calendar/venue waits show nothing at all — the old
confirmation messages were removed, not merely decorated.

**Deployed 2026-07-29 (was PENDING) — Kyiv-only market gate.** **No Prisma schema
change, no env change, no flag change.** Requires a **Mini App redeploy**
(`apps/webapp` changed: `onboarding.tsx` / `onboarding-i18n.ts` /
`onboarding.css` / `api.ts`), so the sequence is Deploy Full Server Code →
`db:drift-check` → `pm2 restart` → `./scripts/deploy-webapp.sh`.

What ships: registration accepts **Kyiv only** (PRODUCT_SPEC §1.3). The
launched-market list is a code constant
(`packages/shared/src/markets.ts` → `SUPPORTED_MARKETS`), deliberately NOT an
env var — a market is only real once its curated venue catalog, ads and ops
exist, and an env toggle would let someone open a city before any of that is
ready. Launching a city is: seed + review its `curated_venues` rows, add the
`SUPPORTED_MARKETS` entry (its `cityKey` must match the venue rows'
`cityKey`), redeploy.

Two behaviour notes worth knowing before the restart:

- **The city step no longer calls Google Places at all** (search and the
  geolocation resolve are both first-party now). `PLACES_API_KEY` is still
  required for venues and the date card — do not remove it. This also removes a
  latent bug: without the key, the old reverse-geocode resolved ANY coordinates
  to Kyiv.
- **Accounts already registered outside Kyiv are not touched** — no status
  change, no data rewrite. They gain a `menu:city` row offering a one-tap move
  to Kyiv, their pinned banner switches from the drop countdown to waitlist
  copy (the `status-timer` worker self-heals it within a minute), and the
  Thursday no-match DM becomes an honest "we haven't launched in {city}" with
  the switch button (no famine tier, no discount, no Rematch offer). Production
  held 9 users at the last deploy with Kyiv covering 6, so expect roughly 3
  accounts on this path.

Post-deploy checks (beyond the standard checklist):

```sh
curl -s https://dating-api.gennety.com/v1/app/config | grep -o 'supportedCities.*ua:kyiv'
# The city step is Kyiv-only end to end; confirm on the dev bot that a search
# for "Berlin" returns nothing and geolocation outside Kyiv explains itself.
psql "$DATABASE_URL" -c "select home_city_key, count(*) from profiles group by 1 order by 2 desc;"
```

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo — no schema, no env, no flag. A city
switched to Kyiv stays switched (it is an ordinary profile write).

---

**Deployed 2026-07-29 (was PENDING) — chat timeline for the concierge agent
(`chat_events`).** Code-only otherwise: **no env change, no flag change, no Mini App
change** (`apps/webapp` untouched).

**⚠️ Requires an additive `db:push` BEFORE the restart.** The new
`chat_events` table is read on every menu-agent turn and written by the
outbound API transformer on every message the bot sends, so a DB missing it
throws `P2022` on the first message after restart — the PM2 crash-loop this
file warns about. Verify additive first (expect one `CREATE TABLE` + two
`CREATE INDEX`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships: the concierge agent can finally see what the user is reacting to
(PRODUCT_SPEC §2.1) — every durable outbound message, every button tap by its
visible label, and Mini App submissions, rendered into its prompt as a "Recent
chat timeline". Written at three boundaries (grammY API transformer, one
inbound middleware, ~12 explicit calls in the initData routes), not at the ~276
individual send sites.

**Two things to watch on the first day, both about write volume.** The
transformer records only `send*` methods — every `edit*` is skipped precisely
because the pinned status banner and the pitch countdown re-render **once a
minute per user**. Confirm that holds in production:

```sh
# Should grow roughly with real messages, NOT by ~1 row/user/minute.
psql "$DATABASE_URL" -c "select count(*), max(created_at) from chat_events;"
# No 'analysing…' / status-beat rows: those sends are marked ephemeral and a
# deleteMessage also removes whatever row it created.
psql "$DATABASE_URL" -c "select direction, kind, left(summary,60) from chat_events order by created_at desc limit 20;"
```

Retention: the existing `retention` cron (`45 3 * * *` Kyiv) now also sweeps
`chat_events` older than **30 days**, batched at 1000 rows/tick — no new cron,
no new env.

**Rollback:** revert the code and restart. The table can stay (nothing else
reads it) or be dropped separately; no env, flag, or Mini App state to undo.

**Deployed 2026-07-27 (latest) — onboarding photo editor, MIN_PHOTOS 3, one
onboarding entry point, pre-drop teaser removed (`867129e`, 11 code commits
since `e774daa`).** Code only: **no Prisma schema change** (`db:drift-check`
returned OK with nothing to push), no env change, no flag change, **no Mini App
redeploy** (`apps/webapp` was untouched by every commit in the range).

Carries: the in-onboarding photo editor (`photo-editor.ts` / `photo-cards.ts` /
`photo-stage-panel.ts` — the first upload is no longer write-only, PRODUCT_SPEC
§1.3), `MIN_PHOTOS` lowered 4 → 3, the removal of the whole `face_obscured`
obstruction gate, the §1.4 quorum change that drops a failing photo instead of
the account (plus the withheld activation when that leaves the profile under the
minimum), one onboarding entry point (the legacy chat consent/language screens
are deleted), and the removal of the pre-drop teaser worker.

**The teaser removal is the deploy's own proof of freshness.** The pre-restart
log block carried `[cron] Pre-match announce scheduled: "0 18 * * 3"`; the
post-restart block does not. That cron disappearing is what confirms the new
code is actually live, the same way the Rematch cron appearing confirmed its
flag flip.

rsync dry-run listed **7** deletions and every one was intended: the 5 files git
actually deletes in this range (`consent.ts`, `language.ts`, `prompts.ts`,
`pre-match-announce.ts` + its test) and the 2 usual stale `apps/video/build`
artifacts. `.env` survived with all 8 `.env.bak.*` snapshots intact.

Preflight green locally: **typecheck clean, 172 bot test files / 2281 tests
passed, `pnpm build` clean, `security:secrets` passed (845 files),
`security:audit` clean (0 advisories)**, tree clean and level with `origin/main`.

Post-deploy verified: `Bot @gennetybot started`, all crons registered (Rematch +
venue-change refund retries present, so both flags still on; Pre-match announce
correctly absent), `:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, **all
12 Mini App pages `200`**, zero `P2022` / `FATAL` / unhandled rejections, restart
count 31 → 32 (single restart, PID stable). Server markers confirm the new code:
`MIN_PHOTOS = 3`, `photo-editor.ts` present, `pre-match-announce.ts` gone. The
only error-log lines are the documented `status-banner … chat not found` pair —
the `status-timer` heartbeat reads `eligible:3 unchanged:3 permanentFailures:2`,
i.e. the same two unreachable Telegram rows under their 6-hour cooldown.

**Production state recorded at this deploy (baseline before the ad launch):** 9
users total (6 `onboarding`, 3 `active`), verification funnel 6 `unverified` / 1
`verified` / 2 `rejected`, Kyiv holds 6 of them — **4 male, 0 female** — and
there have been **0 matches and 0 dates ever**. So the entire post-match half of
the product has never executed once in production. `REFERRAL_FEATURE_ENABLED`
stays `false` (still under development); its code shipped in this range only in
the sense that it was already there and untouched.

**Rollback:** re-sync a checkout at `e774daa` and restart. No schema, no env, no
flag, no Mini App to undo.

**Prior: 2026-07-27 — sunglasses stop rejecting profile photos, plus
the overdue Profiler schema (`e774daa`, 3 commits since `35df65b`).** Code only:
no env change, no flag change, **no Mini App redeploy** (`apps/webapp` carries
its own inlined i18n and does not import `@gennety/shared` strings, so the
changed `photoFaceObscured` copy is bot-side only).

Driven by a production audit rather than a guess: `media_validation_rejections`
plus the PM2 logs, across prod AND dev, showed `face_obscured` was **9 of the 11
real (non-retryable) rejections ever recorded — ~82% of all upload friction** —
while `unsafe_content` had never fired once and `no_face` had fired exactly once
in six weeks. So the fix is one sub-check, not the feature: the sunglasses branch
is gone, the mask/covering branch stays (PRODUCT_SPEC §1.3 records why — a
covered face becomes a `fail` at verification, and one `fail` hard-rejects the
whole account under the §1.4 quorum rule).

**⚠️ The mandatory `db:drift-check` gate earned its keep on this deploy.** It
failed *before* the restart — not from this change, which touches no
`schema.prisma`, but from the **Profiler** columns `profiles.profiler_answer_
window_until` / `profiler_question_message_id`, committed to `main` in `f54d53a`
after the last deploy and never pushed. Prod had been running pre-Profiler code,
so nothing was broken yet; restarting the freshly-synced code against that DB
would have thrown `P2022` on the first Profiler question and surfaced as a PM2
crash loop — exactly the failure mode this file warns about. Verified additive
before pushing: `prisma migrate diff --script` produced **two nullable
`ADD COLUMN`s and zero DROPs**. Ran `db:push` → `db:drift-check` **OK** → restart.

Preflight green locally: **bot 171 files / 2267 tests, webapp 144, shared 207,
all typechecks clean, `pnpm build` clean, `security:secrets` passed,
`security:audit` clean**, tree clean and level with `origin/main`. The rsync
dry-run listed only the 2 usual stale `apps/video/build` artifacts as deletions,
and the 7 `.env.bak.*` snapshots survived it.

Post-deploy verified: `Bot @gennetybot started`, **all 16 crons** registered
(incl. Rematch + venue-change refund retries, so both flags are still on),
`:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, **all 12 Mini App pages
`200`**, zero `P2022` / `FATAL` / unhandled rejections, restart count 30 → 31
(single restart, same PID holding — no crash loop). The only error-log lines are
the documented `status-banner … chat not found` pair for two unreachable
Telegram rows. Confirmed on the live droplet that `MIN_SUNGLASSES_CONFIDENCE` is
gone from the deployed source and the new RU rejection copy is in place.

**How to tell whether this was the right gate — no new instrumentation needed.**
Watch `media_validation_rejections`: if `face_obscured` drops toward zero,
sunglasses were the cause; if it continues at the same rate, what remains are
genuine coverings.

**Rollback:** `git revert e774daa`, redeploy. The additive Profiler columns may
stay either way — they are required by current `main` regardless.

**Prior: 2026-07-26 — card-based photo manager, honest liveness-retry
copy, branded detector (`9b3e51e`, 8 commits since `2c5f206`).** Code + Mini App:
no Prisma schema change, no env change, no flag change. Ships the §2.1 card-based
photo manager (one message per photo with its own 🗑 button, coalesced upload
bursts, per-frame rejection replies), the §1.4 outcome-split liveness-retry copy
(`not_live` / `expired`/`in_progress` / `no_reference` instead of one generic
"shaky camera" guess), the theme-aware branding of the Face Liveness detector,
a body-encoded-404 fix in `services/storage.ts` that could wedge account
deletion, and the drop of the hourglass emoji from the pinned-banner countdown
button.

Preflight green locally: **typecheck clean, all tests pass (bot 169 files /
2212 tests), `pnpm build` clean**, working tree clean and level with
`origin/main`. Ran Deploy Full Server Code → `db:drift-check` (**OK**, nothing to
push — the diff touches no `schema.prisma`) → `pm2 restart`, then Deploy Mini App
Only (`apps/webapp` changed: `liveness-theme.css`, `liveness-detector.tsx`,
`verification.html`). The rsync dry-run listed only the 2 usual stale
`apps/video/build` artifacts as deletions.

Post-deploy verified: `Bot @gennetybot started`, all 14 crons registered,
`:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, all 11 Mini App pages
`200`, the self-hosted liveness assets still serve correctly
(`/liveness/tfjs-wasm/*.wasm` → `application/wasm`, `/liveness/blazeface/
model.json` → `application/json`), restart count 27 → 28 (single restart, no
crash loop), and no new lines in the error log — the `face mismatch → rejected`
entry there is the pre-existing 2026-07-26 session, and the `status-banner …
chat not found` lines are the documented unreachable-chat cooldown. The 113
`P2022` hits in the historical log all predate earlier pushes.

**Rollback:** re-sync a checkout at `2c5f206` and redeploy the Mini App from it.
Nothing else to undo — no schema, no env, no flag.

**Prior: 2026-07-26 (later) — a missing reference selfie is retryable, not a
dead end (`2c5f206`).** Code-only: no Prisma schema change, no env change, no
flag change, no Mini App change. A verification run that cannot fetch the
reference selfie used to write `pending_review` — a status with no button, that
the re-engagement stall sweep skips, behind an app gate that stays locked — so
the user could never get out (PRODUCT_SPEC §1.4 rule 4). It now writes `pending`
and DMs the Verify button, and it restores `verified` instead of demoting a user
our own outage tripped over.

Found via a live incident: one prod account (`telegramId 782065541`) had sat in
that dead end since 2026-07-25 20:16 UTC — a photo-edit rerun against a
Persona inquiry whose selfie was never stored (`selfie fetch failed
{ error: 'no_selfie' }`, Persona-era code, ~9.5 h before the Face Liveness
migration commit). **The account was recovered by hand** (`pending_review` →
`unverified`, `personaInquiryId`/`faceMatchedAt`/`faceMatchScore` → null);
`photoFaceScores` was deliberately left as `[0,0,0,0]` to preserve the
`photos[i] ↔ photoFaceScores[i]` 1:1 invariant — the next successful run
overwrites it. It was the only row in `pending_review` (plus 1 `rejected`, 7
`unverified`).

The bug was NOT Persona-specific — the migration carried that branch over
verbatim and only swapped the selfie source underneath it. The live AWS-era
trigger is the 90-day `selfie-retention` scrub plus the admin
"rerun verification" button, which checks `personaInquiryId` but **not**
`verifiedSelfiePath`: before this fix, one click on any user verified 90+ days
ago would have demoted them out of the match pool into the same inescapable
state. No such user exists yet, which is why it had not fired.

Preflight green locally: bot suite **167 files / 2181 tests**, typecheck clean.
Ran Deploy Full Server Code → `db:drift-check` (**OK**, nothing to push) →
`pm2 restart`. rsync dry-run listed only the 2 usual stale `apps/video/build`
artifacts as deletions. Post-deploy verified: `Bot @gennetybot started`, all 14
crons registered, `:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, all 11
Mini App pages `200`, restart count 26 → 27 (single restart, no crash loop), and
no new lines in the error log.

**Also confirmed by this deploy's log review:** the "still to confirm" item from
the migration block below — one live end-to-end verification from a real
production account — has happened. A real AWS liveness session
(`4c74f6d7-cd00-4e40-99c2-59f6a5be333b`, a UUID, not an `inq_*`) ran the full
pipeline and returned a well-formed `rejected` (4 photos scored 0.027–0.046
against the selfie). Face Liveness is working end-to-end in production.

**Rollback:** `git revert 2c5f206`, redeploy. Nothing else to undo — no schema,
no env. The hand-recovered account is independent of the code and stays
recovered either way.

**Prior: 2026-07-26 — identity verification moved from Persona to AWS
Rekognition Face Liveness.** The sandbox-Persona era is over: production had
been running test-only KYC behind `ALLOW_SANDBOX_PERSONA=true` since
2026-07-17, and that override no longer exists because Face Liveness has no
sandbox/production key split to waive.

Sequence: env delta first (the bot refuses to boot without the new keys, so
they must precede the restart) → rsync → install/build → `db:push` →
`db:drift-check` → `pm2 restart` → Mini App deploy.

- **Env** (`/opt/gennety/.env`, backed up to `.env.bak.20260726-160202`):
  removed all seven Persona keys (`ENABLE_PERSONA_VERIFICATION`,
  `PERSONA_TEMPLATE_ID`, `PERSONA_ENVIRONMENT_ID`, `PERSONA_API_KEY`,
  `PERSONA_WEBHOOK_SECRET`, `PERSONA_HOSTED_URL_BASE`,
  `ALLOW_SANDBOX_PERSONA`); added `FACE_LIVENESS_ENABLED=true`,
  `FACE_LIVENESS_REGION=eu-west-1`, `FACE_LIVENESS_MIN_CONFIDENCE=0.8`,
  `LIVENESS_STS_ROLE_ARN=arn:aws:iam::147010141827:role/GennetyLivenessClient`,
  `LIVENESS_CREDENTIALS_TTL_SECONDS=900`. No new AWS credentials were needed —
  the existing `gennety-bot-rekognition` user gained two Rekognition actions
  plus `sts:AssumeRole`, and a new `GennetyLivenessClient` role carries the
  single `StartFaceLivenessSession` grant a user's device briefly holds.
- **⚠️ An unrelated schema drift surfaced and had to be resolved first.**
  `db:drift-check` failed on the **Rematch** tables (`matches.source`,
  `matches.rematch_paid_by_id`, `rematch_purchases`) — committed to `main`
  earlier and never deployed, exactly as this file's Rematch section warns.
  Verified additive before pushing: `prisma migrate diff --script` produced 6
  statements, all `ALTER TABLE ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX`,
  **zero `DROP`** (the only "DELETE" match was `ON DELETE CASCADE` in the new
  table's FK). `db:push` then `db:drift-check` → OK. The liveness migration
  itself is schema-free: `personaInquiryId` now holds the AWS session id.
- **rsync** dry-run listed 12 deletions, all intended: the 9 deleted
  Persona/poller files, the dead `verification.css`, and 2 stale
  `apps/video/build` artifacts.
- **Verified after restart:** `Bot @gennetybot started`, all 14 crons
  registered, `:3100`/`:3101` listening, restart count 25 → 26 (single restart,
  no crash loop), and **no new lines in the error log** — the `[persona] handler
  error` entries there predate the deploy by two hours and belong to the
  webhook that no longer exists. `pnpm probe-liveness` **on the droplet** passed
  all three AWS permissions with production env. `/v1/ping` ok, admin `401`, all
  11 Mini App pages `200`, the self-hosted model + wasm assets serve with
  `application/wasm`, and `POST /v1/webhooks/persona` now `404`s.
  (`GET /v1/me/verification/url` answers `401` rather than `404` because
  `requireAuth` runs before routing in that router — the route is genuinely
  gone.)
- **Still to confirm:** one live end-to-end verification from a real account.
  The dev run on `@gennetytestbot` passed fully (real AWS session, reference
  selfie stored, `CompareFaces` [1.000, 0.988, 1.000, 0.999] → `verified`), so
  the remaining unknown is only production's own Mini App host.

**Rollback:** `git revert` the migration commits, restore
`.env.bak.20260726-160202`, redeploy. Realistic because production identity was
sandbox-only — no real `verified` cohort depends on it. The additive Rematch
schema can stay either way.

Prior: 2026-07-25 — phone-based account login (`d1ad29f`), code-only.
Prior the same day: full catch-up release (85 commits), additive
`db:push`, flag alignment, and a dev↔prod isolation fix (details in the dated
blocks below). Prior: 2026-07-23 — dev↔prod schema-drift reconciliation + the
2026-07-22 code release. Earlier: 2026-07-21
(full server deploy — **self-healing Telegram drop banner**, commit `045279c`;
no Prisma schema change). Production build and PM2
restart succeeded; `/v1/ping` stayed healthy, every Mini App returned `200`,
and the unauthenticated admin API returned `401`. A legacy pinned-banner orphan
was unpinned only after its message id, create/edit timestamps, text, account
creation timestamp, and status matched the pre-deploy audit; the final
production orphan count was zero. The 16-minute observation window produced the
expected second heartbeat with `eligible=2`, `unchanged=2`, no new errors, no
429s, and no PM2 restart-count growth. Both DB-active Telegram rows returned
`400 chat not found`, so the worker correctly left them untracked under the
six-hour unreachable cooldown; there was no reachable active chat for a live
client rendering check.)

**2026-07-27 (env-only) — Rematch turned ON.** Founder decision, immediately
after the release below verified clean. Added a single line to
`/opt/gennety/.env` (backed up to `.env.bak.20260727-033937` first):

```
REMATCH_FEATURE_ENABLED=true
```

then `pm2 restart gennety-bot --update-env` + `pm2 save`. No schema step — the
`matches.source` / `rematch_paid_by_id` columns and the `rematch_purchases`
table were already in the prod DB (see the release note below). No Mini App
change; Rematch is Telegram-only and has no Mini App surface.

**The flag flip is confirmed by the cron, not by the env line.** The startup
block after the restart now carries `[cron] Rematch refund retry scheduled:
"0 * * * *"`, which is registered only when the flag is on — the block
immediately before it (same log, pre-restart) does not. That cron is what makes
"never keep money without delivering a match" durable, so its presence is the
real proof the feature is live rather than half-on. Also verified: `Bot
@gennetybot started`, `:3100`/`:3101` listening, `/v1/ping` ok, PM2 restart
count 29 → 30 (single restart, no crash loop), no new `P2022` / `FATAL` /
unhandled rejections.

Every other `REMATCH_*` key is left unset, so the code defaults apply:
`REMATCH_STARS=150`, `REMATCH_MAX_PER_WEEK=2`, `REMATCH_COOLDOWN_HOURS=24`,
`REMATCH_GIFT_CAP_DAYS=7`, `REMATCH_PRE_BATCH_BLACKOUT_HOURS=6`.

**⚠️ Open pricing decision — the label may under-promise the charge.** 150⭐ is
$3.00 at the ticket rate ($6.99/350⭐ = $0.02/⭐) but ≈$3.59 at the more
conservative $0.024/⭐ rate documented under `PREMIUM_STARS`, while the offer
copy says **$2.99**. Both fixes are env-only: `REMATCH_STARS=125`, or raise
`REMATCH_PRICE_USD_DISPLAY`. Not resolved at flip time.

**Rollback is one line:** delete `REMATCH_FEATURE_ENABLED` (or set `false`) and
`pm2 restart gennety-bot --update-env`. The additive schema may stay. Note that
rollback stops *new* offers but does not refund an in-flight purchase — the
refund sweep is itself flag-gated, so if a purchase is stranded in `processing`,
flip the flag back on long enough for the hourly sweep to settle it.

**Deployed 2026-07-27 — Rematch + audit hardening + retention (`35df65b`, 40
commits).** Carried the paid **Rematch** feature (`REMATCH_PRODUCT_SPEC.md`,
PRODUCT_SPEC §3.11) plus the security/audit hardening batch (AUTH-1, XSS-1,
ADMIN-1/2, BONUS-1, liveness-session binding, report-triage bounding, OTP
connection handling, 12 dependency advisories), the data-retention sweep, the
durable venue-change refund rail, and the founder-report 90-day link expiry.

Preflight green locally: **171 bot / 15 webapp / 13 shared test files (2251 /
144 / 205 tests)**, all typechecks clean, `pnpm build` clean, tree clean and
level with `origin/main`.

Ran Deploy Full Server Code → `db:push` → `db:drift-check` (**OK**) →
`pm2 restart`, then Deploy Mini App Only (`apps/webapp` changed). The rsync
dry-run listed exactly **2** deletions, both stale `apps/video/build`
artifacts; `.env*` and `keys/` were excluded and the 5 `.env.bak.*` rollback
snapshots survived.

**Schema step was verified additive before running:** `prisma migrate diff
--script` produced **zero DROP statements** — only `founder_reports.expires_at`,
`users.pending_liveness_session_id`, and the new `venue_change_purchases` table
(+ its unique/FK indexes). Notably the Rematch objects (`matches.source`,
`matches.rematch_paid_by_id`, `rematch_purchases`) were **already present in the
prod DB** and so did not appear in the plan.

**Rematch shipped dark and was verified inert** *(superseded the same day — see
the env-only flip above)*: no `REMATCH_*` keys existed in `/opt/gennety/.env`,
so `REMATCH_FEATURE_ENABLED` defaulted to `false`; the startup log correctly
showed **no** "Rematch refund retry" cron (it registers only when the flag is
on) while the new "Venue-change refund retry" and "Data retention" crons did
appear.

Post-deploy verified: `Bot @gennetybot started`, all crons registered,
`:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, **all 11 Mini App pages
`200`**, zero `P2022` / `FATAL` / unhandled rejections, and the PM2 restart
count moved exactly 28 → 29 (no crash loop). The status-timer heartbeat's
`permanentFailures: 2` is the known pre-existing "chat not found" for two
unreachable Telegram rows, not a regression.

**Deployed 2026-07-25 (later) — phone-based account login (`d1ad29f`).**
Code-only: no Prisma schema change, no env change, no flag change. A verified
phone number now resolves to the existing account instead of dead-ending on
"this number is already linked to another account" (PRODUCT_SPEC §1.1,
`services/account-linking.ts`), which is what unblocks a user who verified on
the iOS rail and then opened the bot, or who re-created their Telegram account.
Preflight green locally: **166 bot / 13 webapp / 13 shared test files (2156 /
127 / 202 tests)**, both typechecks clean, `pnpm build` clean, tree level with
`origin/main`. (One pre-existing lint error in `apps/webapp/src/referral.ts:277`
is unrelated and was left alone.)

Ran Deploy Full Server Code → `db:drift-check` (**OK**, nothing to push) →
`pm2 restart`, then Deploy Mini App Only (`apps/webapp` changed: a `completed`
account now routes straight to the done screen). The rsync dry-run listed only
two stale `apps/video/build` artifacts as deletions. Post-deploy verified:
`Bot @gennetybot started`, all 14 crons registered, `:3100`/`:3101` listening,
`/v1/ping` ok, admin `401`, all 11 Mini App pages `200`, no `P2022` / unhandled
rejections, and the PM2 restart count held at 25 (no crash loop).

**Deployed 2026-07-25 — full catch-up release + dev↔prod isolation fix.**
Prod was 85 commits behind (146 files); it had no referral/promo code at all.
Preflight was green locally (`typecheck` clean, **164 test files / 2127 tests
passed**, `openapi:lint` valid, tree clean and level with `origin/main`).
Deployed with Deploy Full Server Code → additive `db:push` → `db:drift-check`
→ `pm2 restart`, then Deploy Mini App. The schema step was verified additive
twice before running: the prod↔local `schema.prisma` diff showed no column
removals, and `prisma migrate diff --script` produced **zero DROP statements**
(6 new columns — `matches.proposal_deadline_nudge_sent_at`,
`matches.synergy_reason_b`, `users.promo_redeemed_at`,
`users.referral_counted_at`, `users.referral_invitee_premium_at`,
`users.referral_verified_count` — plus the `promo_codes` /
`promo_redemptions` tables). Post-deploy: `Bot @gennetybot started`, all 14
crons registered, `:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, all
11 Mini App pages `200`, **zero new `P2022`** (the 113 in the historical log
all predate earlier pushes).

Flag changes in this deploy (`/opt/gennety/.env`, backed up first):

| Key | Before | After | Why |
|---|---|---|---|
| `VENUE_INTENT_V2_ROLLOUT_PERCENT` | `10` | `100` | Founder decision — full live after the 2026-07-25 dev E2E ran the two-step concierge end-to-end. **Note this skips the staged 10→50→100 / 48h-per-step guard documented in the Venue Intent V2 rollout section**; acceptable here only because prod had 0 matches at the time. Roll back to `10` on any hard-constraint violation or fake/closed assignment. |
| `VENUE_INTENT_V2_SHADOW_PERCENT` | `100` | `0` | Redundant once live is 100% (dev parity). |
| `TYPE_PREF_FLOOR` | `1.0` | `0.7` | `V_type` now actually re-ranks instead of shadow no-op. Safe for the existing cohort: `typePreferenceMultiplier` returns `1` when the seeker has no radar signal or the candidate has no overlapping appearance tags. |
| `PROMO_FEATURE_ENABLED` | (unset) | `true` | Inert until a code exists — create with `pnpm promo:create`. |
| `REFERRAL_FEATURE_ENABLED` | (unset) | `false` | **Set explicitly, not left to the default.** The referral program is unfinished (founder decision 2026-07-25): its code ships with this release but every surface is gated — menu row, hub, `/v1/referral/*`, `/v1/me/referral*`, the onboarding wow screen, and the verification-pipeline reward all check the flag. Verified live: `/v1/referral/state` → `404`, `features.referral` → `false`. Flip to `true` to launch. |
| `PREMIUM_PRICE_USD_DISPLAY` | `$10` | `$9.99` | Clears the stale-value note from the 2026-07-21 deploy. |
| `PUBLIC_CORS_ORIGIN` | `*` | `https://dating-calendar.gennety.com,https://gennety.com,https://www.gennety.com` | Removes the wildcard warning. Verified: Mini App origin gets `access-control-allow-origin`, a foreign origin gets none, and native clients (no `Origin` header) are unaffected. |
| `EXPO_ACCESS_TOKEN` | `` (empty) | removed | Expo rail retired 2026-07-18; the process no longer reads it. |

**⚠️ rsync `--delete` footgun — the exclude list in Deploy Full Server Code was
widened.** The old list excluded only `.env`, `.env.local`, `.env.test`, so a
deploy silently deleted every `/opt/gennety/.env.bak.*` (the documented env
rollback path) **and `/opt/gennety/keys/`**. That is not hypothetical: the APNs
`.p8` key at `APNS_KEY_PATH=/opt/gennety/keys/AuthKey_JTLFAQ8RM2.p8` **is gone
from the droplet** (a full-filesystem `find / -name '*.p8'` returns nothing), so
native-iOS push and Live Activities are dead until the key is re-uploaded from
Apple Developer → Certificates → Keys. No user impact today (no iOS client has
shipped). The exclude list is now `.env*`, `keys/`, and the local tooling dirs;
always dry-run with `--itemize-changes | grep '^\*deleting'` before a real sync.
The 6 deletions in this run were all intended (4 obsolete `welcome-gift`
кружки dropped by commit `d068ccd`, which kept `ru.mp4` only, plus two
`apps/video/build` artifacts).

**Curated venue catalog: nothing to push.** Prod (972 active = 448 base +
90 premium `ua:kyiv` + 434 legacy `city_key NULL` rows the runtime dedupes by
`placeId`) is a superset of dev (537), with equal-or-better facet coverage
(338 vs 337 base, 87 vs 87 premium).

**Deployed 2026-07-23 — dev↔prod schema-drift reconciliation + 2026-07-22 code
release.** The prod DB was a day behind the code: additive schema from
venue-intent-v2 (`matches.venue_*` + the `venue_selection_logs` table +
`curated_venues` enrichment, `8181bfb`), Type Radar (`profiles.type_radar_*`/
`appearance_tags` + `match_score_logs.score_type`, `6cbd996`), and
`subscription_ledger.note` (`b8b2975`) was missing, and the DB still carried the
dead `web_registration_links` table (6 rows) + `WebRegistrationPurpose` enum
(removed from code 2026-07-19). Reconciled with one
`prisma db push --accept-data-loss` (Variant B: +32 columns, +`venue_selection_logs`
+ indexes, dropping only the two dead objects; a full `SELECT *` logical backup of
all 24 tables was taken first via `scripts/dump-prod-backup.mjs`). Then Deploy Full
Server Code (rsync → build → `pnpm db:drift-check` gate → `pm2 restart`) and Deploy
Mini App (`deploy-webapp.sh`). Verified: `db:drift-check` OK on the droplet, bot
online with admin `:3100` + public `:3101` listening, `/v1/ping` healthy, zero new
P2022, all Mini App pages `200`. No feature flags changed. The new
`pnpm db:drift-check` preflight guard (`8fa57cb`) is now the mandatory gate in
Deploy Full Server Code below.
