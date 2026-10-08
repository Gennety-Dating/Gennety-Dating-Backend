# Gennety — Record of Processing Activities (GDPR Article 30)

**Version 1.2 — 8 October 2026** (adds §2.5d–2.5f, The Morning After and the
Date Wishlist, and the wishlist unlock in §2.8; carries the 2026-10-02
retirement of §2.5b; v1.1 — 26 September 2026, Tempo Sync; v1.0 — 1 August
2026). Internal document. Not published; produced to a
supervisory authority on request.

**Why this exists.** Article 30(5) exempts organisations under 250 employees
*unless* the processing is not occasional, is likely to result in a risk to
rights and freedoms, or includes special categories. Gennety meets all three,
so the exemption does not apply and this record is mandatory.

**Maintenance rule.** This document is derived from the code, not from memory.
When a processing activity, a data category, a retention period, or a processor
changes, update the row here in the same commit — the same rule that governs
`legal/privacy-policy.md`. `ARCHITECTURE.md` is the technical companion: it
lists every table, cron and route this record summarises.

---

## 1. Controller

| Field | Value |
|---|---|
| Controller | **Gleb Gosha**, a natural person operating the Gennety service, Kyiv, Ukraine |
| Legal entity | None. The operator is the controller personally. |
| Postal address | *TO BE COMPLETED — required by Art. 30(1)(a)* |
| Contact | legal@gennety.com |
| DPO | **Not appointed.** See §6 for the assessment. |
| Art. 27 EU representative | **Not appointed.** See §6 — this is an open gap, not a conclusion that none is needed. |
| Joint controllers | None. |

---

## 2. Processing activities

Each row is one purpose. "Categories of data subjects" is the same for all of
them — **adult users and prospective users of a matchmaking service** (18+
enforced at onboarding) — so it is stated once here rather than repeated.

### 2.1 Account creation and contact verification

| | |
|---|---|
| **Purpose** | Create an account; prove the person controls a real, unique contact rail |
| **Legal basis** | Art. 6(1)(b) contract; Art. 6(1)(f) legitimate interest in preventing duplicate and fraudulent accounts |
| **Data categories** | First name, age, gender, gender preference, language, UI theme, Telegram user id and `@username`, platform; university email + domain **or** phone number in E.164; one-time codes (hashed); registration track; consent flags with the accepted document version |
| **Recipients** | Resend (email codes), Twilio Verify (SMS codes), Telegram / Telegram Gateway, Supabase (hosting), DigitalOcean (hosting) |
| **Transfers** | See §4 |
| **Retention** | While the account exists. OTP challenges: **7 days** (`workers/retention.ts`). Codes are bcrypt-hashed and never stored in clear. |
| **Security** | TLS; hashed codes; per-phone and per-IP rate limits with a durable daily cap; advisory-lock serialisation per contact rail |

### 2.2 Identity verification (biometric)

| | |
|---|---|
| **Purpose** | Confirm the user is a real, live person and that the profile photos are of them |
| **Legal basis** | **Art. 9(2)(a) explicit consent**, captured on a dedicated screen before any session is minted (`User.biometricConsentAt`); Art. 6(1)(f) for fraud prevention |
| **Data categories** | **Special category — biometric data:** liveness video (streamed device → AWS, never through our servers), one reference still, per-photo face-match similarity scores |
| **Recipients** | Amazon Web Services (Rekognition Face Liveness, `eu-west-1`; Rekognition CompareFaces/DetectFaces, `eu-central-1`), Supabase Storage (private bucket) |
| **Retention** | Reference still: **90 days** after `verifiedAt`, then deleted by the `selfie-retention` cron. Similarity scores: while the account exists. The AWS session and its data expire **3 minutes** after creation. |
| **Security** | Private bucket, short-lived signed URLs; session bound to the user who minted it; verdict read server-to-server, never accepted from the client; STS credentials clamped to one action and ~15 minutes |

### 2.3 Profile building and matchmaking

| | |
|---|---|
| **Purpose** | Build a psychological profile and match one compatible person at a time |
| **Legal basis** | Art. 6(1)(b) contract; Art. 6(1)(f) legitimate interest in effective matchmaking |
| **Data categories** | Height, hobbies, partner preferences, preferred age band, dating city + coordinates, free-text "vibe" answers; derived: psychological summary, 1536-dim embedding, vibe axes, Elo/attractiveness score, appearance tags, per-match score breakdown, standby counters. **Gender + gender preference together can reveal sexual orientation** — see §5. **Ethnic origin is NOT collected** (removed 2026-08-01). |
| **Recipients** | OpenAI (analysis, embeddings, vision scoring), Supabase, DigitalOcean |
| **Retention** | While the account exists; erased on deletion |
| **Security** | pgvector in the primary database; no per-message embeddings; scores never shown to other users |

### 2.4 Photo and video admission

| | |
|---|---|
| **Purpose** | Keep prohibited content off the platform and stop duplicate/impersonating uploads |
| **Legal basis** | Art. 6(1)(f) legitimate interest in a safe platform; Art. 6(1)(c) legal obligation for illegal content |
| **Data categories** | Profile photos, optional profile video, transient video frames and audio transcript, perceptual hashes, rejection reasons |
| **Recipients** | AWS Rekognition (moderation, face detection), OpenAI (moderation, Whisper) |
| **Retention** | Photos/video while the account exists. **Extracted frames, audio and transcripts are not retained.** Rejection audit rows store reason + media type + time only — never the media. |

### 2.5 Date arrangement (scheduling, venue, logistics)

| | |
|---|---|
| **Purpose** | Agree a time, choose a venue convenient to both, deliver the confirmation |
| **Legal basis** | Art. 6(1)(b) contract. **Art. 9(2)(a) explicit consent** for a confirmed dietary requirement (can reveal religion) or a step-free requirement (can reveal health) |
| **Data categories** | Availability slots, departure-point coordinates + label, venue intent chips, agreed time, venue snapshot, selection log (raw-text-free) |
| **Recipients** | Google Places (venue search/details/photos — receives approximate meeting-area coordinates, never identity), Open-Meteo (city coordinates + hour), CARTO (map tiles, proxied so the provider never sees the user's IP) |
| **Retention** | While the account exists; erased on deletion |
| **Note** | A departure point is **never** shown to the match — only the agreed venue |

### 2.5b Explored areas ("map colouring") — RETIRED 2026-10-02

| | |
|---|---|
| **Status** | **Collection stopped 2026-10-02** — the feature was retired, the endpoints removed, and nothing reads or writes the tiles. Rows already stored stay (erased on account deletion) until the table is dropped; the drop is pending the founder's approval. The date map that replaced it collects nothing new: it reads the attendance already held for activity 2.4/2.5 date records |
| **Purpose** | Let a user colour in the parts of their city they have actually been to |
| **Legal basis** | Art. 6(1)(a) **consent** — a dedicated in-product switch, off by default, withdrawable at any time. Deliberately NOT covered by the research opt-in or by the sign-up terms: this authorises collecting a new class of data, so it is asked for separately |
| **Data categories** | Geohash precision-6 tiles (~1.2 km x 0.61 km) and a count of them. **No coordinate is stored** — the position is reduced to a tile and discarded |
| **Recipients** | None. Not shared with the match, not shared with a processor |
| **Retention** | While the account exists; erased on deletion. Withdrawing consent stops collection and retains the tiles already uncovered (they are the user's own map) |
| **Note** | Written only from a foreground ping while the map screen is open, and from a verified Date Bump. There is no background-location entitlement and no such permission is requested, so "we do not run background collection" is structural rather than a policy promise |

### 2.5c Life rhythm from Apple Health ("Tempo Sync") — optional, off by default

| | |
|---|---|
| **Purpose** | Plan the date around the pair's usual pace (venue access, an after-date suggestion); a minor, centred factor in the match score |
| **Legal basis** | Art. 9(2)(a) **explicit consent** (and Art. 6(1)(a)): a dedicated in-app sheet naming what is read and what it is used for, then Apple's own permission sheet. Recorded per user as `consentVersion` + `consentedAt` on the first upload. Withdrawable in-app ("Disconnect") and in iOS Settings |
| **Data categories** | Two labels — activity (calm/moderate/active) and chronotype (early/intermediate/late/unknown) — and coverage days. **Derived on the device** from 28 days of Apple Health step counts (incl. wheelchair pushes). No raw Health value is transmitted or stored |
| **Recipients** | None beyond hosting (Supabase, DigitalOcean). Never OpenAI, never Telegram, never the match, never the operations feed |
| **Retention** | Replaced on each refresh; deleted after 35 days without one, on "Disconnect", and on account deletion (cascade) |
| **Note** | Only the iOS app can read Apple Health; Telegram-only accounts never have a rhythm and are matched exactly as before. Analytics see only pair-level aggregates with cells under 20 suppressed (`/admin/analytics/rhythm-outcomes`) |

### 2.5d–2.5f Date Wishlist & The Morning After (2026-10-08)

One feature set, recorded as three purposes because each has its own legal
basis: asking about the date (2.5d), building the list (2.5e), and showing it to
the other person (2.5f). Shipped behind `MORNING_AFTER_ENABLED` and
`WISHLIST_FEATURE_ENABLED` (plus `WISHLIST_APPSTORE_ENABLED` for the iOS
purchase), all off by default — to be switched on only once Privacy Policy v4.3
and Terms v3.1 are live on gennety.com. Schema: migration `20261008120000`;
shared rules in `packages/shared/src/wishlist.ts`.

### 2.5d The Morning After

| | |
|---|---|
| **Purpose** | The morning after a date (first local 11:00 at least 6 h after it; nothing after 14:00, nothing for a date older than 48 h) ask each participant separately one two-button question; tell both only when both said "great"; use the answer, like the existing post-date feedback, as a matching signal |
| **Legal basis** | Art. 6(1)(b) contract; Art. 6(1)(f) legitimate interest in better matches (the matching use) |
| **Data categories** | Per match and side: answer (`great` / `pass`) and its time (`matches.morning_after_a/b`, `morning_after_at_a/b`), when the question was sent (`morning_after_sent_at`), and the derived `mutual_interest_at` |
| **Recipients** | None beyond hosting (Supabase, DigitalOcean) and the delivery rail (Telegram, Apple APNs). Not OpenAI |
| **Retention** | With the match record: while the account exists; erased on deletion |
| **Safeguard** | **Double-blind.** A `pass` is never disclosed to the partner, directly or by wording; only `great` + `great` produces a message, to both. The honest limit is inference from silence, which no design removes |

### 2.5e Date Wishlist — building the list

| | |
|---|---|
| **Purpose** | Let a user build a wishlist with the AI agent (catalog, pasted list or links, free-text search); find real products; keep a product image; personalise the catalog and suggestions |
| **Legal basis** | Art. 6(1)(b) contract — a feature the user chooses to use. Personalisation inputs already held under 2.3/2.5 are reused for a compatible purpose; frequently visited places are read **only** where `users.frequent_places_opt_in` is on |
| **Data categories** | `wishlist_items`: category (whitelist of 9), title (≤120), brand, note (≤200), stored image path, product URL, price **band** (€–€€€€, never an exact price), source (`catalog` / `search` / `link` / `text`), position; at most 30 items. Inputs: the text the user types or pastes (≤4000 chars, ≤12 look-ups per paste, ≤60 look-ups per day). Personalisation: profile, Profiler answers, date map (attendance already held), saved places, frequently visited places (opt-in only). Profile session slot timestamps (`profiles.wishlist_offered_at` / `_snoozed_until` / `_done_at`). `web_lookup_cache`: search or link → found product details, **no user id**, 30-day expiry; and `suggest:` rows keyed by sha256(user id + day) holding that day's picked catalog keys, 24-hour expiry (pseudonymous, not anonymous) |
| **Recipients** | OpenAI (the wishlist agent; catalog ranking from up to 20 Profiler answers and hobbies — no name or photos; **web search** with the typed text and at most city + language — no name, photos or profile); Supabase (database; product images copied into the private chat bucket under `{userId}/w…`, ≤4 MB each, JPEG/PNG/WebP only); DigitalOcean. **Shops are not recipients:** our server fetches their public page (OpenGraph tags) the way a browser would and sends nothing about the user; the shop sees the server's IP |
| **Transfers** | OpenAI, US — SCCs (§4) |
| **Retention** | Items and images: until the user deletes them, or on account deletion (storage first by the `{userId}/` prefix sweep, fail-closed, then cascade). Look-up cache: **30 days**; suggestion rows: **24 hours** |
| **Note** | Images are copied rather than hot-linked, so neither the owner nor a match's device ever contacts the shop by viewing the list. Copying third-party product photos is a copyright question, not a data-protection one — see §6 item 11 |

### 2.5f Date Wishlist — disclosure to a mutual match, and the taste hint

| | |
|---|---|
| **Purpose** | After mutual interest (2.5d), show the other person the user's wishlist as a cheat sheet for a second date — about a tenth free (none for a list of one or two items; places, drinks and flowers first), the rest after a one-off unlock (§2.8) or with Premium; from 45 days after the owner's last change, with a "last updated N days ago" line — and, with the offer, one Profiler answer as a hint (today: favourite flowers) |
| **Legal basis** | **Wishlist: Art. 6(1)(b) contract.** Being shown to a mutual match is the purpose of the feature the user chooses to use (Terms §6, Privacy §12.1); the list is not used for anything else. Changed on 2026-10-08 (founder, second decision of the day) from a separate Art. 6(1)(a) consent screen before the first item: that screen read as a warning and put people off a feature built for them. Consent could not move into the sign-up tick instead — consent bundled with acceptance of the terms is not valid (Art. 7(2), 7(4)) — so the basis changed rather than the place of the tick. Transparency (Art. 13, 5(1)(a)) at the moment of collection: the session's first line names who sees the list and when; the owner can hide it at any time (`users.wishlist_hidden_at`), which also hides the taste hint. **Taste hint: Art. 6(1)(b) contract / 6(1)(f)** — the same purpose for which Profiler answers already feed date hints shown to the match (Privacy §4.1, §12.1), now shown directly; gated on `policyVersion ≥ LEGAL_DOCS_TASTE_HINTS_FROM` (`2026-10-08`) **or** having built a wishlist (whose session says the same), never while the list is hidden, so no answer is shown for a user who has not been told |
| **Data categories** | The wishlist items as stored (2.5e), read live; the date of the owner's last add or delete (`users.wishlist_changed_at`), shown as an age from 45 days; one Profiler answer (`f_flowers`) |
| **Recipients** | **One other user per mutual match** — never before mutual interest, never anyone else. Gennety receives the unlock price from the viewer; the owner is neither paid nor charged |
| **Retention** | No copy is made for the viewer: the sheet is read from the owner's live list, so an edit, a deletion, hiding the list or the owner's account deletion takes effect for the viewer immediately. An unlocked sheet stays openable for the viewer; the offer itself is shown for 7 days after mutual interest |
| **Safeguard** | See DPIA R12–R13 |

### 2.6 Communications with the AI, and the chat timeline

| | |
|---|---|
| **Purpose** | Run the bot/concierge conversation; let the assistant answer a follow-up against the message the user is actually looking at |
| **Legal basis** | Art. 6(1)(b) contract; Art. 6(1)(f) legitimate interest in a coherent assistant |
| **Data categories** | Messages, voice notes and their transcripts, images sent to the concierge; timeline of outbound messages, button taps (by visible label), Mini App actions. **Typed verification codes are masked before storage.** Phone numbers are never stored in the timeline. |
| **Recipients** | OpenAI, Telegram, Supabase, DigitalOcean |
| **Retention** | Conversation history: while the account exists. **Chat timeline: 30 days.** Relayed proxy-chat messages: **90 days**, and deleted with the match. |
| **Note** | The Date Wishlist conversation with the agent is part of this activity; its look-ups and stored items are §2.5e |

### 2.7 Trust and safety

| | |
|---|---|
| **Purpose** | Moderate reports, apply strikes, suspend or investigate accounts |
| **Legal basis** | Art. 6(1)(f) legitimate interest in user safety; Art. 6(1)(c) legal obligation |
| **Data categories** | Report free text, LLM-assigned tier, strikes, suspension/investigation status, relayed proxy-chat logs, match event audit trail |
| **Recipients** | OpenAI (triage), Supabase, DigitalOcean |
| **Retention** | While the account exists; proxy logs 90 days |
| **Safeguard** | The reporter's chosen category bounds the tier in **both** directions, so a mild category cannot be escalated to an account freeze by engineered free text |

### 2.8 Payments and subscriptions

| | |
|---|---|
| **Purpose** | Sell Date Tickets, venue changes, Date Wishlist unlocks and the Premium subscription; refund; account |
| **Legal basis** | Art. 6(1)(b) contract; Art. 6(1)(c) legal obligation (accounting) |
| **Data categories** | Purchase records, provider transaction identifiers, amounts, entitlement periods, ledger audit rows, optional free-text cancellation reason (**consent**). **Date Wishlist unlock** (`wishlist_unlocks`, one per buyer and match): buyer (`user_id`, set to null when the buyer's account is deleted), the list's owner (`owner_id`) and the match (`match_id`) as bare ids, rail, external payment id, Stars or cents, `refunded_at` — no wishlist content. **Premium ticket cover** grandfathering: `users.premium_ticket_cover_until`, set once by the migration to the then-current `premium_until` and never moved by a renewal |
| **Recipients** | Telegram (Stars), Apple (App Store Server API) |
| **Retention** | **As required by accounting and tax law — survives account deletion**, kept minimal and separated from the profile |
| **Note** | **We never receive or store card numbers.** |

### 2.9 Notifications and re-engagement

| | |
|---|---|
| **Purpose** | Deliver match, date, safety and reminder messages |
| **Legal basis** | Art. 6(1)(b) contract; Art. 6(1)(f) |
| **Data categories** | Telegram chat id, APNs device tokens, Live Activity tokens, nudge timestamps |
| **Recipients** | Telegram, Apple (APNs) |
| **Retention** | Until the device unregisters, the token is reported dead, or the account is deleted |
| **Safeguard** | Quiet hours 23:00–09:00 Europe/Kyiv on every notification-raising worker |

### 2.10 Internal operations feed

| | |
|---|---|
| **Purpose** | Let the sole operator see new registrations, weekly matches, confirmed dates and departures |
| **Legal basis** | Art. 6(1)(f) legitimate interest in operating and quality-checking an early-stage service |
| **Data categories** | Profile card + photos on activation, on freeze **and on deletion**, including the phone number; weekly pair report behind an unguessable, 90-day-expiring token |
| **Recipients** | Telegram (a separate, private, founder-only bot) |
| **Retention** | Report snapshots deleted when the subject deletes their account; the notification messages persist in the operator's own chat until deleted by hand |
| **Balancing note** | The delete branch was reduced to an anonymous event on 2026-08-01 and **restored by explicit founder decision on 2026-08-02**: at this stage, knowing who left with enough context to follow up is treated as the primary source of churn understanding. Recorded as an accepted residual risk in `dpia.md` R9. Art. 21(3) means this cannot be defended purely on legitimate interest once erasure is requested, so the mitigation is transparency plus an on-request removal: Privacy §12.2 discloses it prominently and commits to deleting the messages on request. **Operational duty: an erasure request extends to this chat and must be executed by hand.** Review on growth. |

### 2.11 Analytics and product measurement

| | |
|---|---|
| **Purpose** | Understand onboarding drop-off and service health |
| **Legal basis** | Art. 6(1)(f) legitimate interest in improving the Service |
| **Data categories** | Per-step key, outcome, dwell time, language, platform. **Never the answer text.** Aggregate city/gender/status counts. |
| **Retention** | While the account exists; erased on deletion |

### 2.12 Abuse prevention and cost control

| | |
|---|---|
| **Purpose** | Enforce fair-use limits on messaging and AI spend |
| **Legal basis** | Art. 6(1)(f) legitimate interest in availability and cost control |
| **Data categories** | Per-user message and token counters, IP address, coarse promo-attribution fingerprint (hashed IP + user-agent + language) |
| **Retention** | **In memory only**; counters reset on restart, promo fingerprints expire within an hour |

---

## 3. Data subject rights — how each is served

| Right | Mechanism |
|---|---|
| Access (15), Portability (20) | `pnpm gdpr:export -- --telegram=<id> --prod` |
| Rectification (16) | Self-service for most profile fields; identity fields via support |
| Erasure (17) | In-product delete (Telegram Settings, `DELETE /v1/me`): storage erased first and fail-closed, then a cascading database delete, then partner compensation |
| Restriction (18) | Pause matching (self-service) or freeze the account |
| Objection (21) | legal@gennety.com |
| Withdraw consent (7(3)) | Research opt-in: self-service. Biometric consent: support path — it must also erase the reference selfie and remove the user from matching. (Date Wishlist sharing is not consent-based since 2026-10-08 — §2.5f — but the owner keeps a self-service switch: «Не показывать мой список» in Profile → My wishlist hides the list and the taste hint from every match at once; items stay deletable one by one) |
| Art. 22 safeguards | Human review on request; fail-safe routing to manual review on any infrastructure failure; automatic re-verification on photo change; suspensions expire automatically |

---

## 4. International transfers

| Processor | Location | Safeguard |
|---|---|---|
| Supabase | EU (`eu-west-1`) | Within the EEA |
| AWS Rekognition | EU (`eu-west-1`, `eu-central-1`) | Within the EEA |
| DigitalOcean | *confirm droplet region* | SCCs where outside the EEA |
| OpenAI | US | SCCs; API data excluded from public-model training. Includes the `web_search` tool used for Date Wishlist look-ups |
| Twilio | US | SCCs |
| Apple | US | SCCs |
| Google (Places) | US | SCCs |
| Telegram | Non-EEA | Separate controller for the messaging layer |
| Open-Meteo | EU | Coordinates only |
| Vercel | US | SCCs |
| CARTO | US | Tile coordinates only; proxied, no user IP |

**Open item:** signed DPAs / SCCs must be on file for each of the above. Until
they are, Privacy Policy §15's assurance runs ahead of the paperwork.

---

## 5. Special-category data — the complete list

1. **Biometric data** (§2.2) — Art. 9(2)(a) explicit consent.
2. **Dietary requirements** revealing religion, and **step-free access**
   revealing health (§2.5) — Art. 9(2)(a) explicit consent. **Open item:** the
   consent for these is not yet captured as a distinct act; today they are
   ordinary chips in the venue picker.
3. **Sexual orientation, by inference.** Gender plus gender preference together
   reveal it. Unavoidable for a matchmaking service and disclosed in Privacy §6.
   Used only to match; never shared beyond the match.
4. **Free text the user volunteers** — a vibe answer, a report, feedback, a
   Date Wishlist item or note. Unsolicited; users are asked not to share more
   than they need to. A wishlist item is the one place where such text can
   reach **another user** (§2.5f), so Privacy §6 and Terms §6 tell people to
   leave health, beliefs and sex life off it.
5. **Life rhythm derived from Apple Health** (§2.5c) — Art. 9(2)(a) explicit
   consent, captured as a distinct act with version and time.

**Not collected:** racial or ethnic origin (removed 2026-08-01), political
opinions, trade-union membership, genetic data.

---

## 6. Open items

| # | Item | Status |
|---|---|---|
| 1 | Controller postal address | **Required by Art. 30(1)(a)** — missing |
| 2 | Art. 27 EU representative | **Required** (product ships `de`/`pl`, targeting the EEA) — not appointed |
| 3 | DPIA (Art. 35) | Mandatory; drafted separately as `legal/dpia.md` |
| 4 | Signed DPAs / SCCs per §4 | Not yet on file |
| 5 | Explicit consent act for dietary / step-free requirements | Not yet distinct from the chip UI |
| 6 | Per-person admin access + audit trail | Single shared key today; no record of who viewed what |
| 7 | Breach response procedure (Art. 33, 72 hours) | Not written |
| 8 | Manual deletion of founder-feed messages on an erasure request | No tooling; operator must do it by hand (see §2.10) |
| 9 | Existing users and v4.3 | `LEGAL_DOCS_VERSION` moved to `2026-10-08`, but nothing re-presents the documents to people who accepted an earlier version. Nothing in §2.5d–2.5f relies on that acceptance as *consent*: the wishlist disclosure rests on contract with the wishlist session's own first line as the notice at collection, and the taste hint is gated on the version or on having built a wishlist. Art. 13 still requires informing existing users of the new purposes — a one-time in-product notice is owed before the flags go on |
| 10 | Hide the cheat sheet and the taste hint when either side blocks or reports the other, or the match is cancelled for safety | A block in either direction already closes both (`services/wishlist.ts`, `loadMutualPair`); a report without a block, and a safety cancellation, still to confirm — see DPIA R12 |
| 11 | Product images copied from shop pages | Copyright, not data protection: keep the notice-and-takedown route in Terms §6 working (remove on a rights holder's request) |
| 12 | Frequently visited places, saved places, date map — no activity row here, no section in the Privacy Policy | Found while writing §2.5e, which reads them. Frequently visited places (`user_place_visits`, live since 2026-09-22) is location-derived, **on by default** (`frequent_places_opt_in` defaults to true) and shown to the match — it needs its own row with a basis that fits an opt-out default (Art. 6(1)(f) with a balancing test, not consent), and its own Privacy §4/§11/§12.1/§16 text. Saved places and the date map need at least a §4 row |

**DPO assessment (Art. 37).** A DPO is required where core activities involve
regular and systematic monitoring of data subjects **on a large scale**, or
large-scale processing of special categories. Gennety's core activity is exactly
that kind of monitoring and does involve special categories — the only thing
currently placing it outside the requirement is **scale**: the production user
base is under 20 people. This is therefore a threshold to watch, not a settled
"no". Re-assess before any significant growth, and record the re-assessment
here.
