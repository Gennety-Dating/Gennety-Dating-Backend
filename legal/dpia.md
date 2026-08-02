# Gennety — Data Protection Impact Assessment (GDPR Article 35)

**Version 1.0 — 1 August 2026.** Internal document. Living: revisit on any
material change to matching, verification, or the data model, and before any
significant growth in user numbers.

Companion documents: [`ropa.md`](ropa.md) (the processing inventory this
assessment reasons over), [`privacy-policy.md`](privacy-policy.md) (what users
are told), `ARCHITECTURE.md` (how it is built).

---

## 1. Is a DPIA required?

Yes, and not marginally. Article 35(3) plus the WP248 criteria are met several
times over:

| Criterion | How Gennety meets it |
|---|---|
| Evaluation or scoring | A psychological summary, an embedding, an attractiveness ("league") Elo, appearance tags, and a per-pair compatibility score |
| Automated decision-making with significant effect | The weekly batch decides **whether and with whom** a person is matched; the verification pipeline decides whether their account is usable at all |
| Systematic monitoring | Every message, tap and Mini App action in the chat timeline; onboarding funnel telemetry |
| Special-category data | Biometric identification; dietary/accessibility requirements; sexual orientation by inference |
| Data processed on a large scale | *Not currently met* — see §7. Every other criterion stands regardless. |
| Innovative use of technology | LLM-derived personality profiling; vector similarity matching; vision-model attractiveness scoring |
| Matching or combining datasets | Profile answers + photos + behavioural signals + location combined into one matching decision |
| Vulnerable data subjects | Dating creates asymmetries of vulnerability; users disclose intimate preferences and meet strangers in person |

Three or more criteria is the threshold. We meet at least seven.

---

## 2. What the processing is

Gennety is an AI-first matchmaking service on Telegram and iOS. It differs from
a conventional dating app in three ways that matter here:

1. **There is no browsing and no user-to-user chat.** The system chooses one
   match at a time and negotiates the logistics. The user's agency is exercised
   as accept/decline, not as search.
2. **It processes more context per person than a swipe app** — free-text
   psychological material, a photo-derived attractiveness score, stated
   preferences, and location for date logistics.
3. **It ends in a physical meeting between strangers.** The output of the
   processing is not a feed impression; it is two people in a café.

That third point is why the safety-side processing (identity verification,
moderation, the relay-chat log) is not overhead bolted onto the product — it is
the thing that makes the product defensible at all.

---

## 3. Necessity and proportionality

### 3.1 Identity verification is necessary, and consent for it is the hard case

**The purpose** is to ensure the person a user meets alone, in person, is the
person in the photos. There is no less intrusive measure that achieves it:
email/phone verification proves control of a rail, not identity; manual photo
review is slower, less accurate, and exposes more people to the images; a
"verified by a human" badge without a check is theatre.

**The tension.** Verification is mandatory to be matched, and the only available
Art. 9 basis is explicit consent (9(2)(a)) — the substantial-public-interest and
other grounds require Member State law we cannot invoke. Consent that is a
precondition of the service sits uncomfortably with Art. 7(4).

**Our position, recorded deliberately:**

- The processing is **necessary for the purpose the user is seeking**, not
  bundled to it. Someone signing up for supervised in-person introductions is
  asking for exactly the guarantee this check provides.
- The consent is **specific and informed**: a dedicated screen names what is
  captured, the processor, the region, the 90-day retention and the consequence
  of refusing, before any session is minted.
- **Refusal is real and costless.** The user is not matched, and can delete the
  account. Nothing else is degraded, no penalty is applied, no dark pattern is
  used. The former "skip with a rating penalty" path is retired.
- The data is **minimised to the extreme the technology allows**: the video
  never touches our servers, a single still is kept, and it is deleted after 90
  days while the verified status persists.

We accept this remains the most legally exposed part of the service and record
it as such rather than asserting it away. If a supervisory authority disagreed,
the mitigation is not to weaken the check but to re-found it — which is why the
consent is captured as a discrete, versioned act that could be re-collected
under a different framing without re-verifying anyone.

### 3.2 What we decided NOT to process

Proportionality is easier to demonstrate by what was removed:

- **Ethnic origin.** Collected optionally until 2026-08-01 and folded into the
  matching embedding. Removed entirely: an Art. 9 category was influencing an
  Art. 22 decision with no Art. 9 basis, and the matching quality it bought did
  not begin to justify that.
- **The personal AI export.** Users could paste a psychological analysis from
  their own AI assistant — the single most sensitive text in the product.
  Retired as a feature.
- **Skin tone and ethnic proxies in appearance tagging.** The visual-preference
  taxonomy is hair, build, style, tattoos. Deliberately chosen so a
  "type" preference cannot become racial filtering.
- **Per-message embeddings.** Conversations are not vectorised.
- **Continuous location.** Coordinates are captured for a chosen dating city and
  a per-date departure point only; there is no background collection.
- **Advertising and data sales.** Neither exists, and neither is planned.

---

## 4. Risks to data subjects, and what reduces them

Severity and likelihood are assessed for the individual, not for the business.

### R1 — Biometric data breach *(severity: high · likelihood: low)*

A face image is irreplaceable; a leak is permanent.

*Mitigations.* Video streams device → AWS, never through our infrastructure.
Only one still is stored, in a private bucket reachable solely through
short-lived signed URLs. Deleted after 90 days while verified status persists,
so the window is bounded for every user. The AWS session expires in 3 minutes.
**Residual: low-moderate.** The single largest remaining exposure is the
Supabase service-role key.

### R2 — Being wrongly excluded by an automated decision *(medium · medium)*

A verification or moderation error can lock someone out of the service.

*Mitigations.* Infrastructure failure routes to human review, never to
rejection. A failing photo is dropped rather than the account (changed
2026-07-27). Verification re-runs automatically on any photo change, so no
outcome is permanent. Report triage is bounded in both directions by the
reporter's own category, so a mild category cannot be escalated into an account
freeze. Suspensions expire automatically. Human review on request.
**Residual: low.**

### R3 — Being scored on appearance *(medium · certain)*

An attractiveness Elo derived from photos strongly shapes who a person is shown
to. This is not a malfunction; it is how the product works.

*Mitigations.* The score is never displayed to the user or to their match. It is
seeded once from a vision pass and audited per-photo in `eloSeedDetails`. It
scores appearance, not demographics. Disclosed plainly in Privacy §8 rather than
hidden behind "compatibility".
**Residual: moderate — and accepted as inherent to the product.** The honest
mitigation here is disclosure, not elimination.

### R4 — Discrimination through matching *(high · low)*

A matching system that correlates with a protected characteristic causes real
harm at scale.

*Mitigations.* Ethnic origin is not collected. The appearance taxonomy contains
no ethnic proxy. The stated-preference multiplier dampens rather than excludes,
and is neutral for users who never set one. Score breakdowns are frozen per pair
in `match_score_logs`, so the algorithm is auditable after the fact.
**Residual: low.** *Untested assumption:* no formal disparate-impact analysis
has been run — with the current user base it would not be meaningful. Flag for
re-assessment at scale.

### R5 — Physical harm at the date *(very high · low)*

The processing ends with two strangers meeting alone.

*Mitigations.* Mandatory identity verification. Venue selection restricted to
real, operational, open-at-the-time public places. A pre-date safety brief. An
emergency cancellation path with a two-step guard. Reports triaged with
immediate suspension available at the safety tier. The departure point is never
revealed to the match. Contact exchange requires explicit consent from the
person whose contact is shared.
**Residual: moderate.** This risk cannot be engineered to zero by any dating
service; it is reduced, disclosed, and supported.

### R6 — Partner photos leaving the platform *(medium · medium)*

*Mitigations.* Every surface showing a partner's face with `protect_content`:
the match card, the private date card, the My Date hub, and the coordination
cards. The shareable date card blurs the face and refuses to send if the blur
cannot be produced. **Honest limit:** OS screenshots cannot be blocked in a
normal Telegram chat, and this is stated in the Privacy Policy rather than
papered over.
**Residual: moderate.**

### R7 — Operator over-access *(medium · medium)*

One person can read profiles, transcripts, photos and verification state.

*Mitigations.* A separate key-protected, rate-limited interface; images streamed
through an authenticated proxy; deletion notifications carry no personal data.
**Residual: moderate — the largest open governance gap.** A single shared key
means no per-person attribution and no record of who viewed what. Acceptable
only while the team is one person, and it is the first thing that must change
when a second person gains access.

### R8 — Sensitive content in free text *(medium · medium)*

Users may reveal health, beliefs or sexual history in a vibe answer, a report,
or a message to the assistant.

*Mitigations.* The AI-export feature — the largest such intake — is retired.
Chat timeline entries expire after 30 days and mask typed verification codes.
Timeline text is fenced as untrusted data in the assistant's prompt. Users are
asked not to share more than they need to.
**Residual: moderate.** Conversation history is retained for the life of the
account with no shorter ceiling; a retention limit on it is the obvious next
improvement.

### R9 — Erasure that does not erase *(high · low)*

*Mitigations.* Deletion erases storage objects first and **fails closed** — a
storage outage aborts the deletion rather than producing a half-deleted account.
It then cancels live matches, removes founder-report snapshots containing the
subject, and cascades the database delete.

**Accepted exception (founder decision, 2026-08-02).** The operations feed
receives the departing user's profile card, phone number and photos at the
moment of deletion, and that message stays in the operator's private Telegram
chat. This was briefly removed on 2026-08-01 and deliberately restored: at the
current stage, seeing exactly who leaves — with enough context to recognise and
contact them — is treated as the main way early churn is understood, and the
controller accepts the tradeoff knowingly.

It is a genuine limit on Art. 17, not a technicality, so it is mitigated by
transparency rather than argued away: Privacy §12.2 states it prominently under
its own heading, §16 cross-references it, and both commit to removing those
messages on request. The duty that creates is **manual** — nothing deletes them
automatically — and is tracked as RoPA §6 item 8.

**Residual: moderate, and knowingly accepted.** Three honest limits beyond it:
financial records are retained under accounting law; photos uploaded through
Telegram remain on Telegram's infrastructure as `file_id`s we do not control;
and this exception depends on one person executing a manual step correctly.
**Re-assess before the user base grows** — the reasoning that supports it is
explicitly about scale, and it stops holding as the service gets larger.

### R10 — Processor concentration *(medium · low)*

OpenAI sees profile text, photos and transcripts; AWS sees faces; Supabase holds
everything.

*Mitigations.* API terms exclude our data from public-model training. Regional
pinning inside the EEA for the database and both AWS services. Places receives
coordinates but never identity; CARTO never receives the user's IP.
**Residual: moderate**, pending the signed DPAs recorded as open in the RoPA.

---

## 5. Consultation

No supervisory-authority prior consultation under Art. 36 is considered
necessary: after mitigation, no residual risk is assessed as "high" in the sense
that triggers it. The three moderate residuals that come closest — appearance
scoring (R3), operator access (R7), and the founder-feed deletion exception
(R9) — are respectively inherent-and-disclosed, a governance gap with a known
fix, and a knowingly accepted tradeoff that is disclosed to users, removable on
request, and scheduled for re-assessment at growth.

Data subjects have not been formally consulted (Art. 35(9)). At the current
scale this would not be meaningful; the Privacy Policy is written to be readable
by the people it describes, which is the substitute available today.

---

## 6. Outcome

The processing may proceed, subject to the actions below. The two mandatory
paperwork gaps (§7 items 1–2) are blockers for offering the service to EEA users
at any meaningful scale, not for the current handful of accounts.

---

## 7. Actions

| # | Action | Priority | Reference |
|---|---|---|---|
| 1 | Appoint an Art. 27 EU representative | **Blocker before EEA growth** | RoPA §6 |
| 2 | Record the controller's postal address | **Blocker before publication** | RoPA §1 |
| 3 | Sign DPAs / SCCs with every processor | High | RoPA §4 |
| 4 | Write the Art. 33 breach procedure (72 hours, named owner) | High | RoPA §6 |
| 5 | Capture dietary / step-free consent as a distinct act | High | RoPA §5 |
| 6 | Per-person admin accounts + access audit log | High | R7 |
| 7 | Retention ceiling on conversation history | Medium | R8 |
| 7a | Re-assess the founder-feed deletion exception as the user base grows | At growth | R9 |
| 8 | Re-assess the DPO requirement | At growth | RoPA §6 |
| 9 | Disparate-impact analysis of matching outcomes | At scale | R4 |
| 10 | Re-run this DPIA on any material change to matching or verification | Ongoing | — |

---

## 8. Sign-off

| | |
|---|---|
| Assessed by | Gleb Gosha (controller) |
| Date | 1 August 2026 |
| DPO advice (Art. 35(2)) | No DPO appointed — see RoPA §6 |
| Next review | On material change, or before a significant increase in user numbers |
