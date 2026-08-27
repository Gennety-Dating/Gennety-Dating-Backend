# Gennety — Record of Processing Activities (GDPR Article 30)

**Version 1.0 — 1 August 2026.** Internal document. Not published; produced to a
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

### 2.5b Explored areas ("map colouring") — optional, off by default

| | |
|---|---|
| **Purpose** | Let a user colour in the parts of their city they have actually been to |
| **Legal basis** | Art. 6(1)(a) **consent** — a dedicated in-product switch, off by default, withdrawable at any time. Deliberately NOT covered by the research opt-in or by the sign-up terms: this authorises collecting a new class of data, so it is asked for separately |
| **Data categories** | Geohash precision-6 tiles (~1.2 km x 0.61 km) and a count of them. **No coordinate is stored** — the position is reduced to a tile and discarded |
| **Recipients** | None. Not shared with the match, not shared with a processor |
| **Retention** | While the account exists; erased on deletion. Withdrawing consent stops collection and retains the tiles already uncovered (they are the user's own map) |
| **Note** | Written only from a foreground ping while the map screen is open, and from a verified Date Bump. There is no background-location entitlement and no such permission is requested, so "we do not run background collection" is structural rather than a policy promise |

### 2.6 Communications with the AI, and the chat timeline

| | |
|---|---|
| **Purpose** | Run the bot/concierge conversation; let the assistant answer a follow-up against the message the user is actually looking at |
| **Legal basis** | Art. 6(1)(b) contract; Art. 6(1)(f) legitimate interest in a coherent assistant |
| **Data categories** | Messages, voice notes and their transcripts, images sent to the concierge; timeline of outbound messages, button taps (by visible label), Mini App actions. **Typed verification codes are masked before storage.** Phone numbers are never stored in the timeline. |
| **Recipients** | OpenAI, Telegram, Supabase, DigitalOcean |
| **Retention** | Conversation history: while the account exists. **Chat timeline: 30 days.** Relayed proxy-chat messages: **90 days**, and deleted with the match. |

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
| **Purpose** | Sell Date Tickets, venue changes and the Premium subscription; refund; account |
| **Legal basis** | Art. 6(1)(b) contract; Art. 6(1)(c) legal obligation (accounting) |
| **Data categories** | Purchase records, provider transaction identifiers, amounts, entitlement periods, ledger audit rows, optional free-text cancellation reason (**consent**) |
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
| Withdraw consent (7(3)) | Research opt-in: self-service. Biometric consent: support path — it must also erase the reference selfie and remove the user from matching |
| Art. 22 safeguards | Human review on request; fail-safe routing to manual review on any infrastructure failure; automatic re-verification on photo change; suspensions expire automatically |

---

## 4. International transfers

| Processor | Location | Safeguard |
|---|---|---|
| Supabase | EU (`eu-west-1`) | Within the EEA |
| AWS Rekognition | EU (`eu-west-1`, `eu-central-1`) | Within the EEA |
| DigitalOcean | *confirm droplet region* | SCCs where outside the EEA |
| OpenAI | US | SCCs; API data excluded from public-model training |
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
4. **Free text the user volunteers** — a vibe answer, a report, feedback.
   Unsolicited; users are asked not to share more than they need to.

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

**DPO assessment (Art. 37).** A DPO is required where core activities involve
regular and systematic monitoring of data subjects **on a large scale**, or
large-scale processing of special categories. Gennety's core activity is exactly
that kind of monitoring and does involve special categories — the only thing
currently placing it outside the requirement is **scale**: the production user
base is under 20 people. This is therefore a threshold to watch, not a settled
"no". Re-assess before any significant growth, and record the re-assessment
here.
