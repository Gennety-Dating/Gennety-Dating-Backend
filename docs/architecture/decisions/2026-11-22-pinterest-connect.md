<!-- WHEN_TO_READ: Touching Pinterest Connect — the read-only Pinterest OAuth link, the aesthetic profile, where it is surfaced (Settings connector vs onboarding), Pinterest's API review and terms, or why no pins are stored. -->

# 2026-11-22 — Pinterest Connect: design for approval, connector in Settings, nothing built

## 2026-11-22 — Pinterest Connect: the founder accepts every recommendation; phase 0 next, code after Pinterest's answer

**Kind:** founder decision

**What:** On the design, its mockup and the six open questions the founder answered «Совсем согласен». That settles: placement B (Settings connector beside Apple Health, owner-only «Твой вкус» on the profile) plus the one-time offer card, no onboarding step; pin images to OpenAI's vision model; the encrypted refresh token kept for a monthly update; no secret boards in v1; matching weight 0 with a shadow log; no partner-facing shared-taste line in v1. The answer also covers the schema (`pinterest_connections`, `user_aesthetic_profiles`, `match_score_logs.aesthetic_similarity`), the Pinterest API and the three server secrets as designed.

**Why:** The founder approved the spec as written; the agreed order in it puts Pinterest's written consent before code, so that order stands too.

**What it changes going forward:** Phase 0 is the next step: the founder registers the developer app under a Pinterest business account the founder controls and sends the drafted use-case text and consent email (spec, «Phase 0 texts»). Which account owns the app is still open. Phase 1 code starts only once Pinterest answers yes; a partial yes changes the spec first, a no ends the feature.

**Recorded in:** `docs/product/domains/pinterest-connect.md` («Founder answers», «Phase 0 texts»).

## 2026-11-22 — Pinterest Connect designed; recommended as a Settings connector with a one-time offer card, not an onboarding step

**Kind:** not done (design waiting for the founder's «да»)

**What:** The founder asked for a Pinterest link «to understand aesthetic preferences», shaped like a reference connect sheet from another app (round close button, provider title and icon, «what it will be able to do» with two allowed lines and one struck-through, one «Allow read-only access» pill), either as a full onboarding screen or like the Apple Health integration. The spec `docs/product/domains/pinterest-connect.md` and the mockup `docs/product/mockups/pinterest-connect.html` were written; nothing was built.

1. **Placement recommended: B, the connector**, in iOS Settings «Связанные сервисы» beside Apple Health and as an owner-only «Твой вкус» block on the own profile, plus one soft offer card after onboarding and verification, shown once. Not an onboarding step: until Pinterest grants Standard access only the founder's account can connect (Trial), onboarding already carries the mandatory verification gate, many people have no Pinterest, and the taste is first used days later.
2. **What Pinterest requires** (search excerpts of the primary pages, 2026-11-22; the pages themselves did not load from the cloud container):
   - Trial access serves only the app owner's account, 1,000 requests a day; Standard access needs a screen recording of the OAuth flow, the use case and a privacy-policy link, with no published turnaround.
   - Read-only scopes `user_accounts:read`, `boards:read`, `pins:read`; secret boards need `*_read_secret` and are left out of v1.
   - Continuous refresh token (60 days, refreshable indefinitely) for apps activated after 2025-09-25.
   - The terms revised 2026-08-18 forbid using Pinterest Data and its derivatives to build or improve AI/ML models without written consent (email suffices), combining account data with other services beyond the service the user asked for, and joining Pinterest Data with PII; some summaries also say API data may not be stored. Per-user inference on the person's own pins is not training, but it is close enough that **phase 0 asks Pinterest in writing before any code**.
3. **Data shape chosen in the design:** pins, images and board names live only in the read job's memory; only coarse tags from closed lists are stored (palette families and five snapped swatches from `dominant_color` without a model; styles, domains, place vibes and dress code from one `MODELS.visionFast` call on at most 36 low-detail images); a sensitive-topic word list drops weddings, babies, health, religion, politics, sexuality and the like before any model; the owner can hide any tag.
4. **Uses:** the owner's card, a ≤80-token owner-only agent block, venue reweighting inside the diversity band (like Tempo Sync Tier 2), and a centred matching factor `V_aesthetic` with weight 0 and a shadow log. The partner, the pitch, icebreakers, the wingman tip, the embedding, the founder feed and per-user admin reads never see it; a boundary test holds the reader list.
5. **Demo mode:** v1 is iOS-only and the demo bot is Telegram, so the demo shows nothing; no gate, paid step or negotiation step is added, and the unconnected puppet makes every factor neutral.
6. **Rejected:** reading whole public boards through the widget JSON the share sheet already uses for single pins (it is the automated extraction the guidelines forbid and skips Pinterest's consent); storing pins; feeding Pinterest into the profile embedding; routing users through a third-party Pinterest MCP connector.

**Why:** The Spotify precedent (music became display-only because Spotify's policy forbids user profiling) shows that a provider's terms, not the code, decide whether a taste connector can exist at all; the design is therefore built around storing as little as possible and getting Pinterest's written answer first.

**What it changes going forward:** No Pinterest API code, schema change (`pinterest_connections`, `user_aesthetic_profiles`, `match_score_logs.aesthetic_similarity`) or secret (`PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`, `PINTEREST_TOKEN_KEY`) lands before the founder's «да» and Pinterest's written consent. Open questions for the founder are listed at the end of the spec: placement, pin images to OpenAI, keeping the refresh token, secret boards, who writes to Pinterest, matching weight, a partner-facing shared-taste line.

**Recorded in:** `docs/product/domains/pinterest-connect.md`, `docs/product/mockups/pinterest-connect.html`.
