# Tempo Sync (Apple Health) — draft changes to the legal documents

**Status: DRAFT, not applied.** Written 2026-09-25 with the code (decision
journal 2026-09-24, variant B). The live documents in this directory still
describe the product WITHOUT Apple Health, and that is correct: the feature
ships behind `TEMPO_SYNC_ENABLED=false`, so nothing is collected yet.

**Why a separate file and not an edit of the live ones.** The published text
must match what the running product does, and `LEGAL_DOCS_VERSION` is written
to every user at consent — bumping it before the feature is on would ask every
user to agree to a processing that does not exist yet. This file is the exact
text to move in, once reviewed.

## Order of switching it on (founder)

1. Lawyer review of the four blocks below — especially §6 and §8: this is
   health data (GDPR Art. 9) feeding an automated matching decision (Art. 22).
2. Apply the blocks to `privacy-policy.md` (→ v4.2), `ropa.md`, `dpia.md`; bump
   `LEGAL_DOCS_VERSION` in `packages/shared/src/constants.ts` in the SAME
   commit; transcribe to the website (`gennety.com/privacy`).
3. App Store Connect → App Privacy: add **Health & Fitness → Fitness** ("Linked
   to you", not tracking, purpose "App Functionality"). The app description
   must mention the Apple Health integration (guideline 2.5.1).
4. Run `scripts/enrich-venues-osm.mjs --city=ua:kyiv --prod --apply` (venue
   Tier 2 facts; harmless before step 5, read only when rhythm exists).
5. `TEMPO_SYNC_ENABLED=true` (+ `pm2 restart --update-env`). The iOS row
   appears; matching still only LOGS similarity.
6. Only once the policy from step 2 is live: `RHYTHM_MATCH_WEIGHT=0.05`.

Steps 5–6 are separate on purpose: step 5 collects and uses rhythm for venues
(disclosed in the same policy), step 6 turns on the matching effect.

---

## Block 1 — `privacy-policy.md`

### Version line (top)

> **Version: 4.2** — adds one optional feature: **Tempo Sync**, which reads your
> step count from Apple Health on your iPhone, reduces it on the phone to two
> coarse labels, and uses them to plan the date and as one small factor in
> matching. It is off unless you switch it on, and you can switch it off at any
> time.

### §4.3 Data we derive or generate — new row

| **Life rhythm (Tempo Sync)** — two labels: your usual activity level (calm / moderate / active) and when your day tends to be most active (earlier / middle / later, or unknown), plus how many days of data they are based on | Computed **on your iPhone** from the last 28 days of your step count in Apple Health, only if you connect it. Only the labels reach us — never step counts, sleep, workouts, heart rate or any other Health data |

### §6 Special-Category Data — new table row

| **Life rhythm from Apple Health** — derived from your step count, which can reveal health | Only if you tap "Connect Apple Health" and allow access in the iOS permission sheet. Refreshed when you open the iPhone app, at most once a day. | Nothing changes: you are matched and dates are planned exactly as for everyone else. |

### §6 — replace the paragraph "Dietary and accessibility requirements are used only…"

> Dietary and accessibility requirements are used **only** to filter and rank
> date venues. They are never used to rank you, to score you, or to decide who
> you are matched with, and they are never shown to your match as a category —
> your match sees only the venue we chose.
>
> **Life rhythm is different, and we say so plainly.** If you connect Apple
> Health, your two rhythm labels are used (a) to plan the date — for example
> preferring a venue close to the metro, or suggesting a park or café nearby for
> afterwards — and (b) as **one small factor in matching**: when both people
> have a rhythm, a similar rhythm raises the pair's score slightly and a very
> different one lowers it slightly, by at most a few percent. It never excludes
> anyone, it does nothing when either person has not connected Apple Health,
> and it is far weaker than the other factors (Section 8). Your match never
> sees your labels or learns that rhythm played any part. The labels are never
> sent to our AI provider, never used in any text written about you, and never
> shown to our staff one person at a time — only as statistics over many pairs.
> Disconnect in the app (Settings → Your tempo → Disconnect) erases them from
> our servers immediately; revoke Health access in iOS Settings → Health → Data
> Access & Devices → Gennety.

### §8 Automated Decision-Making — add to the bullet list

> - where you have connected Apple Health, compare your two life-rhythm labels
>   with another person's as a minor factor in the match score, and use the
>   calmer of the two to lean the venue choice (Section 6);

### §12.1 With your match — add

> Your match never receives your life-rhythm labels, or any statement that
> rhythm influenced the match, the venue or an after-date suggestion. An
> after-date suggestion, when there is one, is shown to both of you with the
> same neutral wording.

### §16 Data Retention — new row

| Life rhythm (Tempo Sync) | While connected. Replaced on every refresh; **deleted 35 days after the last refresh**, immediately on "Disconnect", and on account deletion |

---

## Block 2 — `ropa.md`

### New activity after 2.5b

### 2.5c Life rhythm from Apple Health ("Tempo Sync") — optional, off by default

| | |
|---|---|
| **Purpose** | Plan the date around the pair's usual pace (venue access, an after-date suggestion); a minor, centred factor in the match score |
| **Legal basis** | Art. 9(2)(a) **explicit consent** (and Art. 6(1)(a)): a dedicated in-app sheet naming what is read and what it is used for, then Apple's own permission sheet. Recorded per user as `consentVersion` + `consentedAt` on the first upload. Withdrawable in-app ("Disconnect") and in iOS Settings |
| **Data categories** | Two labels — activity (calm/moderate/active) and chronotype (early/intermediate/late/unknown) — and coverage days. **Derived on the device** from 28 days of Apple Health step counts (incl. wheelchair pushes). No raw Health value is transmitted or stored |
| **Recipients** | None beyond hosting (Supabase, DigitalOcean). Never OpenAI, never Telegram, never the match, never the operations feed |
| **Retention** | Replaced on each refresh; deleted after 35 days without one, on "Disconnect", and on account deletion (cascade) |
| **Note** | Only the iOS app can read Apple Health; Telegram-only accounts never have a rhythm and are matched exactly as before. Analytics see only pair-level aggregates with cells under 20 suppressed (`/admin/analytics/rhythm-outcomes`) |

### §5 Special-category data — new item

5. **Life rhythm derived from Apple Health** (§2.5c) — Art. 9(2)(a) explicit
   consent, captured as a distinct act with version and time.

---

## Block 3 — `dpia.md`

### New risk after R10

### R11 — Health-derived data steering who you meet *(medium · low)*

Step counts can reveal disability, pregnancy, illness or recovery; a "calm"
label on a wheelchair user is, in effect, a health label. Used in matching, it
could systematically disadvantage people who move less.

*Mitigations.* Only two coarse labels leave the phone; the multiplier is
**centred** (similar rhythms up, very different down, average effect ≈ 0) and
capped at ±10 % in code (±5 % planned), against an attractiveness multiplier
spanning ×0.05–×1 — it reorders neighbours, it cannot exclude. Exactly neutral
when either side has no rhythm, so not connecting carries no penalty. It ships
at weight 0 with the similarity logged, so the effect is measured before it is
applied. Wheelchair pushes count as steps. Labels are fenced in code
(`apps/bot/src/services/rhythm/boundary.test.ts`): no prompt, no partner, no
per-user admin read. For venues the calmer side leads, which protects rather
than excludes. **Residual: low.** *Re-assess* before raising the weight above
0.05, using `/admin/analytics/rhythm-outcomes`.

### §3.2 What we decided NOT to process — add

> - **Sleep, workouts, heart rate or any Health value other than steps.** Sleep
>   without an Apple Watch is only a bedtime schedule the person typed; workout
>   types can reveal rehabilitation. Not read at all.
> - **Background Health delivery.** Refresh happens only when the app is opened.
