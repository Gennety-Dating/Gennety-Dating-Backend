<!-- WHEN_TO_READ: You are touching an external provider (Supabase storage, Google Places, Telegram, APNs, Twilio, AWS Rekognition), a cross-origin image proxy, or rate limiting / token budget. -->
<!-- SOURCE: ARCHITECTURE.md (lines 1973-2139) — migrated 2026-09-01 -->

## Cross-origin image proxies (CORP)

`helmet()` sets `Cross-Origin-Resource-Policy: same-origin` on every public API
response, and **every Mini App is served from a different host to the API it
reads from** — `dating-calendar.gennety.com` against `dating-api.gennety.com`,
`demo-app` against `demo-api`. That split is forced rather than chosen (initData
is HMAC-signed with a bot token, so only the process holding that token can
verify it), so an image this API serves to a Mini App is cross-origin by
construction and the browser discards it unless the route relaxes CORP for its
own bytes. `public/cross-origin-image.ts` owns that one line and the reasoning;
three routes call it — the map-tile proxy, the Date Ticket avatars
(`/v1/matches/:id/ticket/photo/:side`) and the venue-change board photos
(`/v1/venue-change/photo`).

**CORS and CORP are different gates, and the asymmetry is the whole trap.** A
`fetch()` is governed by CORS, which `PUBLIC_CORS_ORIGIN` already passes; an
`<img>` is a no-cors subresource governed by CORP, which does not. So a Mini App
loads its JSON state perfectly and cannot draw a single photo — and the route
answers a clean `200 image/jpeg` to curl, to a server-side probe and to every
supertest in this repo, because none of them enforce CORP. The only symptom is
the client's own `onerror` fallback (the ticket avatar's monogram, the board
card's category glyph), which is indistinguishable from the image merely having
failed to load. The Date Ticket avatars were diagnosed twice on that evidence —
once as response size (2026-08-07), once as upstream flakiness (2026-08-08) —
before anyone compared the response headers of the working map-tile proxy with a
broken one. Both earlier fixes were real improvements and neither was the cause.

The guard is a test per route asserting the header on a 200, since nothing else
in the stack can see it. Three image routes deliberately do NOT get it — the
founder report's media (same-origin with its own page), the referral card
(fetched by Telegram's servers) and `/v1/matches/partner-photo` (native iOS over
URLSession); none is loaded by a browser on another origin.

## Rate Limiting & Token Budget

Two surfaces, one in-memory mechanism (`services/usage-limiter.ts`; single PM2
process, so plain in-memory sliding windows — a restart only resets counters):

- **Public `/v1/*` API** — `express-rate-limit` per-IP/per-user *request* caps
  (`public/rate-limit.ts`), plus `public/usage-middleware.ts` (`usageGuard`)
  mounted after `requireAuth` on the JWT LLM routers (`/v1/chat`,
  `/v1/assistant`, `/v1/onboarding`) for the per-user daily *token* budget
  (`429` over budget).
- **Telegram bot** — `bot-rate-limit.ts`, registered after `sessionMiddleware`
  in `bot.ts`. Meters only text/voice messages (inline-button callbacks are
  never throttled); a scripted flood or an over-budget user is dropped **before**
  any handler runs, so it protects both OpenAI spend and the
  `messageHistory`/`Message` write path.

Token accounting is attribution-by-context: entry points wrap downstream
handling in `runWithUsage(key, …)` (`services/usage-context.ts`,
`AsyncLocalStorage`; keys `tg:<id>` / `user:<id>`), and the `openaiFetch`
wrapper (`services/openai-fetch.ts`) — a `fetch` drop-in at the scattered OpenAI
call sites — reads the exact `usage.total_tokens` OpenAI returns and charges it
to the ambient key plus a process-wide hourly breaker. Whisper audio is priced
by duration (not tokens), so it stays under the per-request voice limiter only.
All knobs are env-flagged (see deploy.md), ship on with loose thresholds tuned
so normal fast use never trips them, and add no Prisma schema or dependency.

## Storage Buckets (Supabase)

- `SUPABASE_SELFIE_BUCKET` — the Face Liveness reference selfie, used as the
  face-match reference. This is the ONLY copy: the AWS session that produced it
  expires after 3 minutes, so nothing can re-issue it. Auto-deleted by
  `selfie-retention` 90 d after `verifiedAt`, after which a photo edit asks the
  user for a fresh liveness check (PRODUCT_SPEC §1.4).
- `SUPABASE_PHOTO_BUCKET` — mobile-uploaded profile photos. Telegram-uploaded
  profile photos remain Telegram `file_id`s.
- `SUPABASE_CHAT_BUCKET` — mobile chat images, stored as opaque object paths
  (`{userId}/{ts}.jpg`); rendered via short-lived signed URLs from
  `services/storage.ts`.

Telegram-uploaded profile photos are **not** stored in Supabase by the bot
— their static frames live as Telegram `file_id`s in `Profile.photos`.
Richer Telegram display media lives additively in `Profile.profileMedia[]`:
`{ type: "photo", photo }`, `{ type: "live_photo", photo, livePhoto, ...metadata }`,
or `{ type: "video", video, ...metadata }`. Static media admission stores
`uploadedPhotoHashes` for duplicate detection and `acceptedPhotoCount`.
Hashes are positional: every `photos[i]` has `uploadedPhotoHashes[i]` (a real
hash or the empty-string sentinel). Shared alignment helpers normalize legacy
length mismatches without guessing associations, and every Telegram/mobile/
chat append or delete updates photos, media, face score, and hash together.
Telegram deletion uses the same per-user lock as Telegram/mobile/chat append,
then replaces its session from the locked canonical state; a stale Telegram
album can therefore never erase a photo concurrently added on another surface.
**Identity is enforced only by liveness verification, not at upload time
(simplified 2026-06-23).** A static photo that passes per-photo safety,
usable-face (Rekognition confidence ≥ 0.55, area ≥ 0.8% — there is no
obstruction gate at all: the `face_obscured` reject was removed in two steps,
sunglasses 2026-07-26 and the remaining `FaceOccluded` mask/covering branch
2026-07-27, after a production audit showed it was ~82% of all upload
rejections while protecting neither safety nor identity. Its last
justification — that a covered face could hard-reject the whole account at
verification — was removed at the source when the §1.4 quorum began dropping
the offending photo instead; the `face_obscured` reason survives in
`MediaValidationRejectionReason` only for historical
`media_validation_rejections` rows and is never produced. See PRODUCT_SPEC
§1.3), and duplicate gates is accepted
and counted toward `MIN_PHOTOS` immediately. There is no pre-verification
cross-photo "same person" clustering and no self-photo identity anchor: the
former hidden `Profile.pendingPhotoCandidates[]` consensus pool (held the first
photos invisible until two clustered with `CompareFaces`) and the
`referenceFaceEmbedding` self-anchor were removed from the upload flow because
they stranded legitimate users whose genuine same-person photos scored just
below threshold. Those columns are retained (no longer written by uploads) and
no schema change is required. Once a user is liveness-verified, the upload gate
compares each new photo against `verifiedSelfiePath`, and the verification
pipeline re-runs on every photo edit — the real identity gate. Video remains
display-only and is excluded from `photos[]`; admission is validated for
**safety only** (no identity/face-presence gate): `ffprobe`/`ffmpeg` extract 12
temporary samples, AWS Rekognition + OpenAI moderate each frame, and OpenAI
moderates the Whisper audio transcript. Only validation version and
timestamp are retained; temporary video, frames, audio, and transcripts are
deleted. The `photos[i] ↔ photoFaceScores[i]` invariant still holds. When
`profileMedia[]` is empty, renderers normalize legacy `photos[]` into photo
items. Verification and face-match still read `photos[]` only, preserving the
`photos[i] ↔ photoFaceScores[i]` invariant. The mobile app mirrors static
photos through `/v1/me/photos`, which downloads from Telegram (or accepts
direct upload) and runs the face-match gate; Telegram Live Photo upload is
currently bot-side only.

## External Dependencies

| Service | Role |
|---|---|
| OpenAI | Onboarding / menu / mobile chat agents, embeddings, Whisper voice/video-audio transcription, image/text moderation, vision Elo seed |
| AWS Rekognition Face Liveness | Identity liveness: `CreateFaceLivenessSession` + `GetFaceLivenessSessionResults` server-side (`services/face-liveness.ts`); the device streams its selfie video straight to `StartFaceLivenessSession` using STS credentials minted per session by `services/liveness-credentials.ts`. Replaced Persona 2026-07-26. ~$0.015 per check with no monthly floor, so a paused ad campaign costs nothing. A session and its reference image expire 3 minutes after creation — see PRODUCT_SPEC §1.4. **Runs in `FACE_LIVENESS_REGION` = `eu-west-1`, NOT the `AWS_REGION` (eu-central-1) the rest of Rekognition uses** — Frankfurt does not serve Face Liveness, and answers with a message-less `AccessDeniedException` that mimics an IAM denial. `rekognition-client.ts` caches one client per region; the region is returned to the client verbatim because the detector must stream to the region its session was created in. |
| AWS Rekognition | `CompareFaces`, `DetectFaces`, and `DetectModerationLabels` for profile photo/video admission and the face-match decision; `DetectFaces` boxes also drive the date-card share-copy face blur (§3.7a) |
| Google Places (New) v1 | **Fallback** concierge venue search (primary is the first-party `curated_venues` base) at the great-circle midpoint via `places.googleapis.com/v1/places:searchNearby` (+ text fallback). Strict quality gate (operational + place-type deny-list + rating ≥ 4.0 + ≥ 30 reviews + student-friendly price tier for food) and weighted scoring on top of the raw API. **"Fallback" is now enforced rather than described** (2026-09-04): V2 used to count the eligible curated rows and run the sweep anyway on every assignment, so `decidePlacesSweep` / `VENUE_PLACES_FALLBACK_MAX_CURATED` gates it on a thin pool — and defers it to a rescue for the run whose deep pool ranked nothing, which is the only state where the spend can still change the outcome. The runtime search mask sits at the **Enterprise** tier and no higher: `rating` / `priceLevel` / `regularOpeningHours` ARE the quality gate, while `editorialSummary` (the one Atmosphere-tier field) was removed from it and is now bought only by the seeder (`searchVenueCandidates(..., { editorialSummary: true })`), which writes it to `curated_venues` once and reads it for months. The Mini App's departure picker uses **Autocomplete (New)** with a client-minted `sessionToken` per typing episode, closed by a Place Details **Essentials** request (`id,location,formattedAddress`) on `/v1/location/resolve` — a completed session bills its keystrokes at zero, replacing the per-keystroke Text Search Pro that cost $0.10–$0.19 per departure point. Resolved places are cached in `place_cache` (30-day TTL, Google's ceiling; `place_id` kept indefinitely as ToS permits, pruned by the nightly cron). The `places.photos` field + the Places **media** endpoint supply the date-card venue cover photo (fetched at render time, credited on the card, never persisted) and the §3.7b board's galleries; the photo-name lookup (`fetchPlacePhotoNames`, mask `photos`) is the free Place Details Essentials (IDs Only) tier. The board's proxy accepts only the two widths the client renders (each distinct width is a separately billed Place Photo request) and its tiles defer loading until near the viewport (`photo-defer.ts`), since `loading="lazy"` cannot reach a CSS `background-image`. Demo mode is denied the paid search outright (`PLACES_LIVE_SEARCH_ENABLED`) because its generated `.env` inherits production's `PLACES_API_KEY`. |
| Open-Meteo | Hourly forecast for the venue-ranking season/weather multiplier (`services/weather.ts`, PRODUCT_SPEC §3.7 / VENUE_ENGINE_IMPROVEMENT_PLAN 5.3). **No API key, no account, no quota** — chosen for exactly that reason: the value it adds is a few positions of reordering among near-equal venues, which does not justify a credentialed dependency. One request per selection run (every candidate sits in one city at one hour), cached in-process by `cityKey` + hour. Every failure path — network, timeout, non-200, unparseable body, a date past the ~16-day horizon — returns `null`, which scores exactly like perfect weather, so an outage can never withhold the outdoor half of the catalog. Gated by `VENUE_SEASON_WEATHER_ENABLED`; off → no request is ever made. |
| satori + @resvg/resvg-js + @napi-rs/canvas | In-process date-card PNG rendering (§3.7a, feature-flagged): `satori` builds an SVG from a plain element tree, `@resvg/resvg-js` rasterizes it to PNG, and `@napi-rs/canvas` pixelates the partner's face for the share copy plus applies the venue-photo duotone and the film-grain tile. Pure Node (no headless browser); bundled Roboto + Archivo Black TTFs live in `apps/bot/src/assets/fonts/`. The same satori/resvg pair (no canvas) also renders the always-on **locked-time card** (`services/time-card.ts`, PRODUCT_SPEC §3.6) — text only, no photos or network, so it is fast enough to send inline — the **pre-date coordination card family** (`services/coordination-card`, PRODUCT_SPEC §Phase 4), five variants sharing one polaroid frame, each shipped as a photo whose caption is the flow's existing localized copy — and the always-on **expiry card** (`services/expiry-card.ts`, PRODUCT_SPEC §3.4), four variants distinguished by a vector motif rasterized ahead of satori (which supports almost none of the SVG it uses). NB: satori does **not** fall through *within* a font family, so the Unbounded latin/cyrillic subsets must be registered under distinct family names or mixed-script strings silently drop to Roboto. **Those subsets also do not cover Polish** — Ą Ł Ż Ś Ć Ź Ń Ę live in Google's separate `latin-ext` subset — and satori reports nothing when a glyph is missing, it just resolves it from another family mid-word. The expiry card therefore loads the FULL `unbounded-700.woff`, which removes the fallback-ordering hazard entirely. **The time and match cards were moved onto the same full file 2026-08-01** after an audit measured what each renderer actually resolved. Two distinct defects were confirmed by differential render, not one: the time card registered the two subsets under *distinct* family names (correct per the rule above) and so lost only Polish; the **match card registered BOTH subsets under the single name `"Unbounded"`** — the exact anti-pattern this note warns about — with the cyrillic subset first, so it owned the family outright and every **Latin** glyph, including the `Gennety` wordmark on every card and any Latin partner name, silently rendered in Roboto. That one was live under `MATCH_CARD_FEATURE_ENABLED`. The **referral and coordination cards are NOT affected** (an earlier revision of this note wrongly listed them): they switch family by script — `Headline Cyr` for `ru`/`uk`, Archivo Black otherwise — and Archivo Black covers Latin, Polish and German, so no locale falls back there. `services/expiry-card.test.ts` pins the expiry card by differential render (same string with Unbounded+Roboto vs Roboto alone), with a control case asserting the subset genuinely fails so the guard cannot pass for the wrong reason; `services/card-headline-fonts.test.ts` pins the time and match cards the same way, but against each module's **real exported `loadFonts()`** and with the control derived from that same array (a hand-rolled Roboto control let the match-card case pass for the wrong reason — the failed render fell back to Roboto *Bold 700* while the control used Roboto *Medium 500*, so the rasters differed without the headline face contributing anything). |
| Supabase | Postgres + pgvector primary store, Storage for selfies, mobile profile photos, and chat images |
| Resend/email provider | Corporate-email OTP delivery |
| Telegram Gateway | PRIMARY phone-code delivery for the native app (`gatewayapi.telegram.org` — `checkSendAbility` + `sendVerificationMessage` with our own code, ≈$0.01/code). Env `TELEGRAM_GATEWAY_TOKEN`. |
| Twilio Verify | SMS fallback for phone codes (numbers without Telegram / Gateway outages / explicit "send SMS"). REST via fetch — no SDK dependency, no Twilio phone number needed. Env `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID`. |
| Spotify Web API | Music on the profile (decision 2026-09-11). **Search** — `GET /v1/search?type=track` on the app's Client Credentials token (`services/music/spotify.ts`: token in memory, single-flight, answers cached 10 min), server-side only; single-track `GET /v1/tracks/{id}` resolves every id a client pins — the client sends ids, never metadata — and feeds the nightly refresh. **Top-tracks import** — Authorization Code + PKCE, scope `user-top-read` only (`services/music/spotify-oauth.ts`): one `/v1/me/top/tracks` read inside the callback, no token and no Spotify user id stored. Development-mode limits bind (2026-02): at most five allow-listed accounts may authorize (the rest get 403 → `not_allowed`), search `limit` ≤ 10, no batch `GET /tracks`, `preview_url` null. **Developer Policy: display-only** — never an embedding, matching, pitch or prompt input (`services/music/ai-boundary.test.ts`). Env `PROFILE_MUSIC_ENABLED` / `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` / `SPOTIFY_TOP_TRACKS_ENABLED` / `SPOTIFY_REDIRECT_URI`. REST via fetch — no SDK. |
| App Store Server API | StoreKit 2 purchase verification + refund webhooks for the native app's ticket wallet (`services/appstore.ts` — ES256 provider JWT via `jsonwebtoken`, REST via fetch, no SDK). Env `APPSTORE_KEY_PATH/KEY_ID/ISSUER_ID/BUNDLE_ID/ENVIRONMENT/TICKET_PRODUCTS`. **`ENVIRONMENT` picks the ORDER, not the store** (2026-09-04): lookups ask production and sandbox both, because the two are separate stores and a live app plus its TestFlight builds report here simultaneously. |
| APNs (direct) | Native-app push + Live Activity updates: token-based `.p8` auth (`jsonwebtoken` ES256 provider JWT, cached 50 min) over `node:http2` (APNs is HTTP/2-only; no SDK dependency). `services/apns.ts` transport + `services/push.ts` dispatcher; dead tokens (`Unregistered`/410) are auto-purged. Env `APNS_KEY_PATH/KEY_ID/TEAM_ID/BUNDLE_ID/ENVIRONMENT`. **`aps.category` is derived from `data.type`, not carried as its own field** — the two are the same fact, so a second field could only disagree with itself, and ~25 call sites would each have had to opt in. The iOS client attaches actions to a category per type it can act on and renders the rest as ordinary notifications, so an unknown category is a device-side no-op. **`mutable-content` follows the same rule**: it is set when and only when `data.image` carries a URL, because the client's Notification Service Extension exists to blur that one image (§3.3 → the drop push) and has nothing to do without it — so the flag and the payload cannot disagree. **`aps.interruption-level` is read
off the same key by the same rule, but for a different reason** (2026-08-12):
`TIME_SENSITIVE_PUSH_TYPES` is a closed set — `safety.brief` (T-1.5h) and
`proxy.opened` (T-1h) — because the level is not a property of a notification
but a *privilege over the user's phone*, permission to interrupt someone who
asked not to be. A field would let any later sender take that privilege in
passing and would leave no place showing the whole list; a named set makes
taking it an edit to one constant a test guards. The two members qualify for
derivation because each type exists only inside the minutes that make it urgent
— **if a type's urgency ever becomes context-dependent, split the type rather
than adding a field.** Deliberately outside the set: `match.proposed` (a 24-hour
window is not urgency, and under the daily cadence it would pierce Focus nightly),
`proxy.message` (a message every couple of minutes is spam at that level),
`feedback.due`, and — added 2026-08-22 — the four §4.3 map types that finally
reached the app rail: `match.none`, `match.nudge`, `match.planning`,
`match.deadline`. That is the first test of the rule above rather than a
restatement of it: four new senders arrived at once and the set stayed at two,
because a daily decision window is a window, not an emergency, and a nightly
Focus breach is precisely what the 2026-08-12 decision refused. **The set is
therefore load-bearing by staying small** — anything that grows it is a claim on
someone's Do Not Disturb, and a test pins its whole membership rather than one
member. `verification.outcome` (2026-08-23, PRODUCT_SPEC §1.4) is the second
test and the harder one, because unlike a nudge the user is *actively waiting*
on that verdict — which is an argument for delivering it, not for taking their
Do Not Disturb; the set stayed at two again. **The level has a client-side
precondition that fails silently**:
without `com.apple.developer.usernotifications.time-sensitive` in the app,
iOS ignores it entirely and the notification arrives ordinary — measured
by differential probe, `timeSensitiveSetting` reads `notSupported` without the
entitlement and `enabled` with it, at identical authorization state.
`apns-collapse-id` is available per send (`ApnsSendOptions.collapseId`) and used by the drop push, where the dispatcher's retry can legitimately fire the same event twice. The Expo SDK rail was retired 2026-07-18 (no Expo client ever shipped). |
