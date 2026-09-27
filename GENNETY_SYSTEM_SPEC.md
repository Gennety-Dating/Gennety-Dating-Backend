# Gennety System Specification (GENNETY_SYSTEM_SPEC)

> **Document Status:** Cross-repository architectural overview; the Prisma schema and current service code govern stored state and behavior.
> **Source Repositories:**
> - `Gennety Dating` (Monorepo: Backend, Telegram Bot, Telegram Mini Apps, PostgreSQL/Prisma, Public/Admin HTTP API)
> - `Gennety-iOS` (Native SwiftUI Client, iOS 26 Liquid Glass, StoreKit 2, MapLibre Release maps, ActivityKit)
> **Generated:** 2026-09-26; **synchronized with source:** 2026-09-27
> **Target Audience:** AI Research Assistant Skill, Engineering, Product & Operations

---

## 1. System Overview & Tech Stack

Gennety Dating is an AI-first, zero-chat romantic matchmaking platform. It removes conventional in-app messaging between users, curates exactly one high-synergy match per drop cycle via multidimensional vector embeddings and assortative Elo leagues, coordinates logistics (availability & venue selection) through an automated AI concierge, and guides participants directly to an offline, in-person date at vetted partner venues.

### 1.1 Architecture Topology

```
┌─────────────────────────────────┐       ┌─────────────────────────────────┐
│        Telegram Clients         │       │        Native iOS Client        │
│   (Bot Long-Polling + Mini Apps)│       │    (SwiftUI, Liquid Glass, SPM) │
└────────────────┬────────────────┘       └────────────────┬────────────────┘
                 │ Bot API / WebApp                        │ HTTPS (Bearer JWT)
                 │ Signed HTTP POST (tma initData)         │ Direct APNs / StoreKit 2
                 ▼                                         ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    Single Node.js Process (apps/bot)                      │
│───────────────────────────────────────────────────────────────────────────│
│ • grammY Telegram Bot (Long-Polling via Composer Router)                  │
│ • Public Express API Server (:3101) — /v1/* (OpenAPI 3.1 Contract)        │
│ • Admin Express API Server (:3100) — /admin/* (Bearer Key + Helmet)       │
│ • 16× node-cron Background Schedulers + 20s/60s/2min Lifecycle Intervals  │
│ • AI Agents: Onboarding Collector, Post-Onboarding Menu Agent, Chat Agent │
│ • Matching Engine: SQL ANN Pre-filter + In-Memory Multi-Factor Re-Ranking │
│ • Dispatch Queue: Rate-limited DM Delivery with Backoff Ladder            │
│ • Verification Pipeline: AWS STS + Face Liveness + Rekognition CompareFaces│
│ • In-Process Media Renderers: satori + @resvg/resvg-js + @napi-rs/canvas   │
└─────────────────────┬───────────────────┬───────────────────┬─────────────┘
                      │                   │                   │
                      ▼                   ▼                   ▼
┌───────────────────────────┐   ┌───────────────────┐   ┌───────────────────────────┐
│  PostgreSQL 15+ / pgvector│   │  OpenAI Platform  │   │  External Cloud Services  │
│     (Supabase Hosted)     │   │ • GPT-4o / Mini   │   │ • AWS Rekognition (Faces) │
│ • vector(1536) Embeddings │   │ • text-embedding- │   │ • AWS Face Liveness       │
│ • Prisma ORM Client       │   │   3-small (1536)  │   │   (eu-west-1 STS token)   │
│ • Canonical Pair Indexes  │   │ • Whisper (Voice) │   │ • Google Places (New) v1  │
│ • Advisory Row Locks      │   │ • Content Moder-  │   │ • CARTO Vector Tiles Proxy│
└───────────────────────────┘   │   ation & Vision  │   │ • Apple App Store API     │
                                └───────────────────┘   │ • Telegram Gateway /Twilio│
                                                        │ • Spotify Web API (PKCE)  │
                                                        │ • Open-Meteo Weather API  │
                                                        └───────────────────────────┘
```

### 1.2 Exact Technology Stack & Dependencies

#### Monorepo Backend (`Gennety Dating`)
- **Runtime:** Node.js 22+ (ES Modules, TypeScript 5.7+). Process managed via PM2 on Ubuntu/DigitalOcean droplet (`167.172.178.229`), TLS terminated via Caddy reverse proxy.
- **Web Framework:** Express 5.2.1 (`express: ^5.2.1`), `helmet: ^8.1.0`, `cors: ^2.8.6`, `express-rate-limit: ^8.5.2`, `multer: ^2.2.0`.
- **Database & ORM:** PostgreSQL with `pgvector` extension hosted on Supabase; Prisma ORM (`@prisma/client: ^6.x`, schema in `packages/db/prisma/schema.prisma`).
- **Telegram Bot Framework:** grammY 1.35.0 (`grammy: ^1.35.0`), `@grammyjs/auto-retry: ^2.0.2`, `@grammyjs/transformer-throttler: ^1.2.1`.
- **Telegram Mini Apps (WebApps):** Vite 6.4.3 + React 19.2.6 SPA (`apps/webapp`), MapLibre GL 6.6.0 (`maplibre-gl: ^6.6.0`), AWS Amplify Face Liveness (`@aws-amplify/ui-react-liveness: ^3.6.7`, `aws-amplify: ^6.19.0`), `qrcode: ^1.5.4`, `jsqr: ^1.4.0`.
- **AI & Computer Vision:** OpenAI Node SDK 4.104.0 (`openai: ^4.104.0`), AWS SDK v3 Rekognition (`@aws-sdk/client-rekognition: ^3.1064.0`), AWS STS (`@aws-sdk/client-sts: ^3.1095.0`).
- **Image Generation & Processing:** Satori 0.26.0 (`satori: ^0.26.0`), Resvg JS 2.6.2 (`@resvg/resvg-js: ^2.6.2`), `@napi-rs/canvas: ^1.0.0` (in-process SVG to PNG rasterization, polaroids, duotone cards, face blur).
- **Scheduled Tasks:** `node-cron: ^4.2.1` (16 registered jobs + in-memory drift-safe intervals).
- **Authentication:** `jsonwebtoken: ^9.0.2` (HS256 Bearer JWTs for mobile; HMAC SHA-256 for Telegram `initData`).
- **Video Rendering:** Remotion 4.0.489 (`remotion: 4.0.489`, `@remotion/cli: 4.0.489` in `apps/video`).

#### Native iOS Client (`Gennety-iOS`)
- **Language & Runtime:** Swift 6, minimum deployment target **iOS 26** (Liquid Glass design system), iPhone only.
- **UI Framework:** 100% SwiftUI, zero third-party UI dependencies.
- **Project Structure:** XcodeGen (`project.yml` source of truth; `.xcodeproj` generated via `xcodegen generate`).
- **Network Layer:** Type-safe Swift client generated from `openapi/gennety-v1.yaml` using `swift-openapi-generator` (`Packages/APIClient`).
- **Mapping Engine:** MapLibre Native 6.31 draws on-screen maps in Release; Mapbox Maps SDK v11 remains a Debug fallback. MapKit handles address search and Apple Maps handoff.
- **System Extensions:**
  - `ActivityKit` / `WidgetKit`: Lock screen widgets and Dynamic Island Live Activities (`DateDayLiveActivity`, `DecisionLiveActivity`).
  - `NotificationServiceExtension`: Image download and blur filter processing for push notifications.
- **In-App Purchases:** StoreKit 2 (`Gennety.storekit`, transaction listeners, App Store Server API synchronization).
- **Biometrics & Identity:** AWS Face Liveness SDK (`FaceLivenessDetector`).
- **Motion & Sensors:** `CoreMotion` (accelerometer listener for mutual Date Bump shake detection).

---

## 2. Data Models & Entity Relationships

The data model is declared in `packages/db/prisma/schema.prisma` (3,489 lines) and PostgreSQL migrations.

### 2.1 Enums & Status State Machines

```prisma
enum UserStatus {
  onboarding             // Initial state before completing profile/verification
  active                 // Normal live participant eligible for drop matching
  paused                 // User-toggled manual pause with banner + resume
  frozen                 // Soft-delete: excluded from matching; auto-reactivates on next /start
  suspended              // Moderated temporary timeout (Tier-1 or Tier-2 automatic)
  pending_investigation  // Safety report triggered hold
  banned                 // Hard exclusion from the platform
}

enum VerificationStatus {
  unverified       // No liveness attempted
  pending          // STS session minted, waiting for client stream
  pending_review   // Liveness passed, face-match inconclusive; manual admin review
  verified         // Fully identity-cleared and eligible for drop matching
  rejected         // Face mismatch or liveness failure
}

enum MatchStatus {
  proposed           // Pitch dispatched to both sides; 24h reply window
  negotiating        // Both accepted; resolving ticket gate & scheduling slots
  negotiating_venue  // Timeslot locked; selecting/confirming venue
  scheduled          // Date confirmed with locked time & curated venue
  cancelled          // Explicit emergency cancellation or planning stall timeout
  completed          // T+24h feedback tick closes the scheduled match
  expired            // 24h decision window lapsed without mutual acceptance
}

enum MatchEventActionType {
  PROPOSAL_SHOWN
  ACCEPTED
  DECLINED
  DATE_COMPLETED
  CHEMISTRY_POSITIVE
  CHEMISTRY_NEGATIVE
  EXPIRED_SILENT        // Actor who remained silent past 24h TTL
  EXPIRED_PEER_IGNORED   // Actor who responded, but peer timed out
}

// `MatchEventActionType.ACCEPTED` records an action; it is not a MatchStatus.

enum OnboardingStep {
  consent
  language
  conversational
  completed
}

enum Language { en, ru, uk, de, pl }
enum Theme { light, dark }
enum ThemeMode { system, light, dark }
enum Gender { male, female }
enum GenderPreference { men, women, both }
enum Platform { telegram, mobile, both }
enum MatchRadius { campus_only, citywide }
enum ProfilerPriority { high, medium, low }
enum ProfilerMediaKind { photo, sticker }
enum ShortVideoPlatform { tiktok, instagram }
enum MessageRole { user, assistant, system }
```

### 2.2 Stored match status, ticket substate, and derived date view

1. **Match progression:** A dispatched pitch is `MatchStatus.proposed`.
   Mutual acceptance moves the row to `negotiating`, where the optional ticket
   gate and time agreement run. A locked time awaiting venue confirmation is
   `negotiating_venue`. A confirmed time and venue is `scheduled`. `cancelled`,
   `completed`, and `expired` close the progression. The post-date feedback
   tick marks `completed` at T+24h. Business words such as “created”,
   “accepted”, “planning”, and “no-show” are descriptions or events, not
   additional `MatchStatus` values. `no_show_partner` and `no_show_self` are
   attendance-outcome strings, separate from match status.
2. **Ticket gate:** `ticketPaidA` and `ticketPaidB` are nullable `DateTime`
   payment timestamps. `ticketStatus` is a string substate of the negotiating
   match: `pending`, `partial`, `completed`, `refund_pending`, `refunded`, or
   `expired`. There is no `TicketStatus=PAID` enum or `ticketPaidBy` column.
   `paidForPartnerByA/B` record partner coverage. The feature flag controls
   whether the gate runs; ticket substate does not replace `Match.status`.
3. **Date view:** `DateLifecycleState` is computed from `Match.status`, the
   clock, this side's decision and feedback, and the Date Bump session. The
   public values are `IDLE_EXPLORING`, `DROP_PENDING_DECISION`,
   `LOGISTICS_SCHEDULING`, `DATE_SCHEDULED`, `DATE_RADAR_ACTIVE`,
   `DATE_BUMP_PENDING`, `DATE_IN_PROGRESS`, and `POST_DATE_FEEDBACK`. Neither
   `active_terminal` nor `bump_pending` is a stored match state.

### 2.3 Core Models (Illustrative Fields; Prisma Is Canonical)

#### `User` (Identity, Authentication, Account Status)
```prisma
model User {
  id                        String              @id @default(uuid())
  telegramId                BigInt?             @unique @map("telegram_id")
  telegramUsername          String?             @map("telegram_username")
  phone                     String?             @unique
  phoneVerifiedAt           DateTime?           @map("phone_verified_at")
  email                     String?             @unique
  emailVerifiedAt           DateTime?           @map("email_verified_at")
  universityDomain          String?             @map("university_domain")
  registrationTrack         String              @default("student") @map("registration_track") // student | general
  status                    UserStatus          @default(onboarding)
  onboardingStep            OnboardingStep      @default(consent) @map("onboarding_step")
  language                  Language            @default(en)
  platform                  Platform            @default(telegram)
  theme                     Theme               @default(dark)
  themeMode                 ThemeMode           @default(system) @map("theme_mode")
  policyVersion             String?             @map("policy_version")
  ticketBalance             Int                 @default(0) @map("ticket_balance")
  referralCode              String              @unique @map("referral_code")
  referredById              String?             @map("referred_by_id")
  referralSource            String?             @map("referral_source")
  referralCountedAt         DateTime?           @map("referral_counted_at")
  lastMatchedAt             DateTime?           @map("last_matched_at")
  lastMessageAt             DateTime?           @map("last_message_at")
  pendingLivenessSessionId  String?             @map("pending_liveness_session_id")

  // Relations
  profile                   Profile?
  onboardingProgress        OnboardingProgress?
  matchesAsA                Match[]             @relation("UserAMatches")
  matchesAsB                Match[]             @relation("UserBMatches")
  ticketLedger              TicketLedger[]
  subscriptionLedger        SubscriptionLedger[]
  rematchPurchases          RematchPurchase[]
  venueChangePurchases      VenueChangePurchase[]
  primeTimePurchases        PrimeTimePurchase[]
  liveActivityTokens        LiveActivityToken[]
  userPlaceVisits           UserPlaceVisit[]
  userScratchMap            UserScratchMap[]
}
```

#### `Profile` (Match Signals, Vectors, Visuals & Coordinates)
```prisma
model Profile {
  userId                    String              @id @map("user_id")
  firstName                 String?             @map("first_name")
  age                       Int?
  gender                    Gender?
  preference                GenderPreference?
  height                    Int?                // Centimetres: 140..220
  relationshipIntents       String[]            @map("relationship_intents")
  bio                       String?
  hobbies                   String[]            // Max 10 items, <=50 chars
  major                     String?             // University program
  photos                    String[]            // Telegram file_ids or Supabase storage paths
  uploadedPhotoHashes       String[]            @map("uploaded_photo_hashes")
  acceptedPhotoCount        Int                 @default(0) @map("accepted_photo_count")
  homeCityKey               String?             @map("home_city_key") // Canonical market key (e.g. "kyiv", "berlin")
  homeLatitude              Float?              @map("home_latitude")
  homeLongitude             Float?              @map("home_longitude")
  matchRadius               MatchRadius         @default(citywide) @map("match_radius")

  // Psychological & Matching Vectors
  psychologicalSummary      String?             @map("psychological_summary")
  partnerPreferences        String?             @map("partner_preferences")
  negativeConstraints       String?             @map("negative_constraints")
  energyAxis                Float?              @map("energy_axis")       // [-1.0, 1.0] (Internal vs External Tempo)
  orientationAxis           Float?              @map("orientation_axis")  // [-1.0, 1.0] (Structure vs Spontaneity)
  socialRole                String?             @map("social_role")
  typePrefTags              Json?               @map("type_pref_tags")    // PreferenceVector from Type Radar

  // Embeddings
  embedding                 Unsupported("vector(1536)")?                  // OpenAI text-embedding-3-small
  embeddingDirty            Boolean             @default(false) @map("embedding_dirty")
  embeddingDirtyAt          DateTime?           @map("embedding_dirty_at")

  // Attractiveness & League Elo
  attractivenessElo         Float               @default(1200) @map("attractiveness_elo") // Elo league score
  attractivenessCount       Int                 @default(0) @map("attractiveness_count")
  reliabilityScore          Int                 @default(100) @map("reliability_score")   // +50 on verified Bump

  // Identity & Biometrics
  verificationStatus        VerificationStatus  @default(unverified) @map("verification_status")
  verifiedAt                DateTime?           @map("verified_at")
  verifiedSelfiePath        String?             @map("verified_selfie_path")
  referenceFaceEmbedding    Json?               @map("reference_face_embedding")

  user                      User                @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([embeddingDirty, embeddingDirtyAt])
}
```

#### `Match` (Zero-Chat Progression, Logistics & Audit)

The canonical declaration is `packages/db/prisma/schema.prisma` → `model Match`.
Its `status` is `MatchStatus`, with separate nullable `acceptedByA/B` decisions,
`agreedTime`, nullable `ticketPaidA/B` timestamps, `ticketStatus`,
`paidForPartnerByA/B`, venue details, proxy-chat markers, and feedback fields.
`DateBumpSession` records the two physical shakes and verification. Do not copy
this overview as a migration or infer a column from a business-stage label.

#### `CuratedVenue` (Partner Catalog & Midpoint Assignment)
```prisma
model CuratedVenue {
  id                        String              @id @default(uuid())
  placeId                   String              @unique @map("place_id") // Google Places ID
  name                      String
  address                   String
  cityKey                   String              @map("city_key")
  latitude                  Float
  longitude                 Float
  priceLevel                Int                 @default(1) @map("price_level") // 1: Cheap, 2: Moderate
  rating                    Float?
  userRatingsTotal          Int?                @map("user_ratings_total")
  primaryType               String?             @map("primary_type") // cafe, bar, coffee_shop, park
  regularOpeningHours       Json?               @map("regular_opening_hours")
  photoRefs                 String[]            @map("photo_refs")
  editorialSummary          String?             @map("editorial_summary")
  universityDomains         String[]            @map("university_domains")
  operatorPriority          Int                 @default(0) @map("operator_priority")
  active                    Boolean             @default(true)
}
```

#### Financial Ledgers & Purchases
- `TicketLedger`: Balance mutations (`user_id`, `amount`, `reason` ∈ `store_purchase | gate_settle | student_bonus | photo_bonus | famine_discount | promo_grant | admin_grant | refund`, `externalPaymentId` = `appstore:<txId>` or `stars:<chargeId>`).
- `SubscriptionLedger`: Recurring & fixed period Premium records (`planId` ∈ `monthly | months3 | months6`, `status` ∈ `active | expired | cancelled`, `startsAt`, `expiresAt`, `externalSubscriptionId`).
- `RematchPurchase`: Post-decline matching rerun (`status` ∈ `pending | processing | settled | refund_pending | refunded | refund_failed`, `starsExternalPaymentId`).
- `VenueChangePurchase`: Multiplayer board venue swap ($150\star$ / StoreKit consumable).
- `PrimeTimePurchase`: Evening calendar band unlock ($50\star$ / $0.99 StoreKit).

---

## 3. Core User Flows & State Machines (Step-by-Step)

```mermaid
stateDiagram-v2
    [*] --> Onboarding

    state Onboarding {
        ConsentLanguage --> DualTrackGate
        DualTrackGate --> StudentTrack: .edu / university email OTP
        DualTrackGate --> GeneralTrack: Phone OTP / Telegram Contact / OIDC
        StudentTrack --> ProfileBasics
        GeneralTrack --> ProfileBasics
        ProfileBasics --> TypeRadar: Optional visual preference calibration
        TypeRadar --> PhotoIntake: Min 4, Max 10 Photos
        PhotoIntake --> VoicePrompt: Optional 3..60s Audio Clip
        VoicePrompt --> FaceLivenessGate: AWS Rekognition Liveness (eu-west-1)
        FaceLivenessGate --> CompareFacesGate: Selfie vs Photos (>= 0.60 match)
    }

    Onboarding --> PoolActive: Verified Outcome

    state MatchCycle {
        PoolActive --> DropBatch: Configured matching cadence (CADENCE.cron)
        DropBatch --> ProposedMatch: Top 1 Candidate (Assortative League)

        state ProposedMatch {
            PitchShown --> BlindDecision: 24h Countdown TTL
            BlindDecision --> MutualAccept: Both Say "YES"
            BlindDecision --> SingleDecline: Rematch Offered (150 Stars)
            BlindDecision --> ExpiredSilent: 24h Window Lapses
        }

        MutualAccept --> DateTicketGate: Male Covers / Wallet / Stars / StoreKit
        DateTicketGate --> ProgressiveScheduling: 3-Stage Slot Grid
        ProgressiveScheduling --> VenueMidpointSelection: Curated Primary / Google Fallback
        VenueMidpointSelection --> DateScheduled
    }

    state DateExecution {
        DateScheduled --> PreDateTimeline: Cancellation from booking; T-5h Icebreakers
        PreDateTimeline --> PreDateSafetyBrief: T-1.5h Female Brief
        PreDateSafetyBrief --> ProxyChatWindow: T-1h Anonymous Proxy Chat Opens
        ProxyChatWindow --> DateRadarActive: T-45m Masked Proximity ETA
        DateRadarActive --> DateBumpWindow: T-15m to T+2h Mutual Phone Shake
        DateBumpWindow --> DateInProgress: Bump Verified (+50 Reliability, 5 Prompts)
        DateInProgress --> PostDateFeedback: T+2h Proxy Closes, T+24h Review Prompt
    }
```

### 3.1 Onboarding & Verification Flow
1. **Consent & Language:** User confirms ToS, Privacy Policy (versioned via `LEGAL_DOCS_VERSION = "2026-08-27"`), research opt-in, and language (`en`, `ru`, `uk`, `de`, `pl`).
2. **Registration Fork (Registration v2):**
   - **Student Track:** User enters institutional email ending in `ALLOWED_EMAIL_DOMAINS` (`.edu`, `.ac.uk`, `.edu.ua`, `kpi.ua`, etc.). 6-digit numeric OTP is issued (`OTP_TTL_MS = 10 min`). Verifying rewards `STUDENT_BONUS_TICKETS = 2` free Date Tickets.
   - **General Track (Telegram):** Single-tap native contact button `requestContact` via Bot API. Telegram vouchers for the phone number.
   - **General Track (Native iOS):** Twilio Verify SMS (primary default) or Telegram Gateway (secondary fallback). Enforces cooldowns via DB row locking on `phone_otps`.
   - **Continue with Telegram (iOS):** Native Telegram iOS SDK returns OIDC ID token. Server validates JWKS RS256 signature against `oauth.telegram.org` without client secrets.
3. **Profile Intake (Conversational or Mini App):**
   - Demographic facts: `firstName`, `age` (18..55), `gender` (`male` | `female`), `preference` (`men` | `women` | `both`), `height` (140..220 cm), `relationshipIntents` (multi-select), `hobbies` (max 10 items, <=50 chars), `major` (max 100 chars), `bio` (max 500 chars).
   - Market allocation: Selects from `SUPPORTED_CITY_KEYS` (e.g. `kyiv`, `berlin`). Unlaunched cities write to `city_waitlist_entries` and halt.
4. **Photo Intake & Quality Gate:**
   - Enforces `MIN_PHOTOS = 4`, `MAX_PHOTOS = 10`. Uploading $\ge 6$ validated photos grants `+1` free Date Ticket.
   - Each photo validated against: NSFW/Safety (`DetectModerationLabels`), face detection (`DetectFaces` confidence $\ge 0.55$, bounding box area $\ge 0.8\%$), perceptual hash duplicate check (`DUPLICATE_HASH_DISTANCE = 8`).
5. **Voice Prompt Intake:**
   - Audio duration between `VOICE_PROMPT_MIN_DURATION_SECONDS = 3` and `VOICE_PROMPT_MAX_DURATION_SECONDS = 60` (target 15s, max 2MB). Transcribed via Whisper. Transcript feeds embedding; waveform pre-computed to 40 buckets for iOS visualization.
6. **Onboarding sequence:**
   - The questionnaire leads through optional Type Radar, profile photos, an optional voice prompt, and mandatory verification. The external AI context-import and Magic Prompt path is retired.
7. **Identity Verification Gate (AWS Rekognition Face Liveness):**
   - STS credentials minted server-side clamped strictly to `rekognition:StartFaceLivenessSession` in `eu-west-1`. Session expires in 3 minutes.
   - On completion, server synchronously invokes `GetFaceLivenessSessionResults`.
   - If liveness score passes, reference selfie is matched against profile photos using AWS Rekognition `CompareFaces` (`FACE_SIMILARITY_THRESHOLD = 0.60`).
   - If match succeeds: `verificationStatus = verified`, account flipped to `status = active`. Reference selfie is scheduled for auto-deletion after 90 days (GDPR Art. 9 scrub).

### 3.2 Discovery & Matching Engine
1. **Cadence & Execution Window:**
   - Batch timing is selected by `DROP_CADENCE` and optional `MATCH_CRON_SCHEDULE` override; resolve the active schedule from `CADENCE` and deployed configuration.
   - Preflight executes `expireStaleMatches()` and updates dirty vector embeddings (`workers/embedding-refresh.ts`).
2. **Hard Candidate Constraints (SQL Pre-filter):**
   - Status must be `active`, onboarding complete, verification `verified`.
   - Both sides must have non-null `embedding`, `gender`, `preference`.
   - Cross-gender preference matching: $A.\text{pref} \ni B.\text{gender} \land B.\text{pref} \ni A.\text{gender}$.
   - Same market: $A.\text{homeCityKey} = B.\text{homeCityKey}$.
   - Single Live Match Lock: Neither side may have a match with `status IN ('proposed', 'negotiating', 'negotiating_venue', 'scheduled')`.
   - Lifetime Ban Deduplication: Pair must never have existed in historical `matches` table (`matches_pair_canonical_idx` on `LEAST(user_a, user_b), GREATEST(user_a, user_b)`).
   - Cooldown: `lastMatchedAt < NOW() - 24 hours`.
3. **Scoring Formulation (`services/match-engine.ts`):**
   $$\text{MatchScore} = \Big( (w_1 \cdot V_{\text{explicit}}) + (w_2 \cdot V_{\text{research}}) \Big) \cdot V_{\text{league}} - (w_3 \cdot V_{\text{penalty}})$$
   - $w_1 = 0.65$ (`explicit`): Cosine similarity of 1536-dimensional OpenAI vector embeddings.
   - $w_2 = 0.35$ (`research`): Quadrant proximity over `energyAxis` (weight 0.7) and `orientationAxis` (weight 0.3), age gradient, height compatibility, educational homogamy.
   - $w_3 = 0.30$ (`penalty`): Negative constraints penalty (smoking, alcohol, personality dealbreakers).
   - $V_{\text{league}}$ (Elo Assortative Factor): Attractiveness Elo gap.
     - `LEAGUE_TOLERANCE = 60` Elo points (~10 attractiveness points).
     - Decay: $1.0 - (\Delta\text{Elo} - 60) \times 0.005$, clamped to floor $0.05$.
     - `MALE_REACH_ELO = 36`: In heterosexual pairings where female Elo > male Elo, gap is discounted by 36 points (~6 attractiveness points).
   - Multipliers: Type Radar preference multiplier $\times$ Relationship Intent compatibility multiplier.
4. **The Pitch & Blind Decision Invariant:**
   - AI concierge pitches the match highlighting synergy reasons, voice prompt audio, and blurred/unblurred visual cards.
   - Reply deadline: strictly 24 hours. Pinned button on Telegram and native iOS countdown badge updates minute-by-minute.
   - **Blind Invariant:** Neither user is informed of the partner's accept/decline action until both have committed. If a user declines, partner is not notified until TTL expires, preventing social anxiety.
   - If declined, male users are offered **Rematch** (150 Stars) to trigger an immediate single-candidate rerun.

### 3.3 Offline / Zero-Chat / Meetup Flow
1. **Date Ticket Gate (Post-Acceptance):**
   - Date Ticket ($8.49 reference, or Telegram Stars / StoreKit consumable) required to access scheduling.
   - Male participant can choose "Cover Partner" (settles 2 slots). Female participant sees "Your match covered your ticket" reveal card.
   - Subscription Waiver: Active Gennety Premium subscribers have their personal slot automatically cleared.
2. **Progressive Scheduling:**
   - System auto-proposes top 3 overlapping timeslots derived from known availability.
   - If unconfirmed, hands off to the Calendar slot grid (multi-slot select, auto-locks on single intersection).
   - Prime Time band (evening 19:00+ and weekend slots) requires Prime Time Pass ($50\star$ / $0.99) or Gennety Premium.
3. **Concierge Venue Midpoint Engine:**
   - Computes great-circle geographical midpoint between users' departure pins (`vibeLat/Lng`).
   - Queries `curated_venues` within the dating city key. Filters by price tier, opening hours at agreed date time, operational status.
   - Incorporates Open-Meteo hourly weather forecast (rain/temperature multiplier adjusts indoor vs outdoor venue weighting).
   - Fallback: Google Places (New) v1 Nearby Search (`places:searchNearby`) triggered only if curated pool is thin.
4. **Venue Change Board v2 (Multiplayer):**
   - Either participant can open the Venue Change board to review up to 10 alternatives within 3 km of the assigned venue.
   - Both like candidate venues. Single overlap auto-confirms swap.
   - Settled via 150 Stars or StoreKit consumable (`venue_change_1`). Women can invoke unilateral "Express Mint" to swap venue instantly.
5. **Day-of-Date Timeline & Privacy Protection:**
   - **From booking until `agreedTime`:** A scheduled date can be cancelled. T-5h sends a reminder and does not open a cancellation gate.
   - **T-5 hours:** System sends curated ice-breaker suggestions and the cancellation reminder.
   - **T-1.5 hours:** Safety brief dispatched to female participant (`safety.brief`, Time-Sensitive APNs).
   - **T-1 hour:** Anonymous Proxy Chat opens for every scheduled pair (`proxy_messages`), without a coordination choice or handle exchange. It relays text between users via bot/app proxy and auto-closes at T+2 hours.
   - **T-45 minutes:** Date Radar activates (`/v1/dates/{id}/proximity`) and Telegram sends the Date Terminal invite. The service computes ETAs relative to the venue and discards raw coordinates; only `unknown`, `en_route`, `arrived`, and an optional masked ETA cross to the partner.
   - **T-15 min to T+2 hours (Date Bump):** Physical arrival confirmation. Both users tap "Bump" and physically shake phones together near the venue:
     - Telegram sends the Date Terminal reminder at T-15 minutes; the invite/reminder are Telegram messages, while iOS enters through its native canvas.
     - Distance to venue $\le 100$ meters (`BUMP_VENUE_RADIUS_M = 100`).
     - Time difference between shakes $\le 10$ seconds (`BUMP_SHAKE_WINDOW_MS = 10_000`).
     - The server rejects early, late, or too-distant shakes. Verified outcome awards `+50` Reliability Score to both users once and unlocks 5 in-person icebreaker topics.
   - **T+24 hours:** Post-date feedback prompt (thumbs up/down, safety review, no-show report).

6. **Mixed-platform pair:** An iOS-first user has `platform=mobile` and may have a synthetic negative `telegramId`; a Telegram user is reached through the bot. Both share one `Match` and the same date state. Telegram sends only to a reachable bot chat, while native notifications use the mobile push rail. The proxy-chat window and Bump validation apply equally to an iOS ↔ Telegram pair.

### 3.4 Spatial & Mapping Architecture
- **Mini App Vector Mapping:** MapLibre GL 6.6.0 connected to first-party CARTO vector-tile proxy (`/v1/vectortiles/:z/:x/:y`). Strips 7 label/POI layers on the server before gzipping, reducing tile weight by 78% (from 1,074 KB to 342 KB per phone screen).
- **Native iOS Mapping:** MapLibre Native 6.31 in Release, with Mapbox retained as a Debug fallback.
- **Privacy Obfuscation Boundaries:**
  - Raw coordinates are never delivered to peers or stored permanently in connection with real-time location.
  - Dating Scratch Map: GPS fix mapped to Geohash-6 tile (~1.2 km $\times$ 0.6 km). Coordinates are discarded immediately after hashing.
  - Frequently Visited Places: Foreground fixes checked against in-memory city geofences. Coordinates dropped immediately. A visit day is recorded in `user_place_visits` only if two fixes $\ge 15$ min apart land within a venue boundary.

---

## 4. API Endpoints, Bot Commands & Event Triggers

### 4.1 Public HTTP API (`/v1/*`, Port 3101)

All endpoints require Bearer JWT (`Authorization: Bearer <token>`) unless marked as `[tma]` (Telegram WebApp HMAC `Authorization: tma <initData>`) or `[public]`.

| Method | Path | Auth | Purpose & Side Effects |
|---|---|---|---|
| `GET` | `/v1/ping` | `[public]` | Liveness health check |
| `GET` | `/v1/app/config` | `[public]` | Returns `minSupportedIosVersion`, `supportedCities`, feature flags |
| `GET` | `/v1/vectortiles/:z/:x/:y` | `[public]` | CARTO vector tile proxy (strips unused layers; 1MB ceiling) |
| `GET` | `/v1/promo/:code` | `[public]` | Promo landing page; stashes device fingerprint, redirects to App Store |
| `POST`| `/v1/promo/attribution` | `[public]` | Matches device fingerprint to promo code on off-origin landing |
| `POST`| `/v1/auth/otp/request` | `[public]` | Send corporate/university email OTP (rate-limited, DB serialized) |
| `POST`| `/v1/auth/otp/verify` | `[public]` | Verify OTP; mints access JWT (HS256) & refresh token |
| `POST`| `/v1/auth/phone/request` | `[public]` | Native phone OTP: Twilio Verify SMS (primary) / Telegram Gateway |
| `POST`| `/v1/auth/phone/verify` | `[public]` | Verify phone OTP; finds or creates User by phone; mints JWTs |
| `POST`| `/v1/auth/telegram` | `[public]` | iOS "Continue with Telegram": verifies OIDC JWT from `oauth.telegram.org` |
| `POST`| `/v1/auth/refresh` | `[public]` | Rotates refresh token; returns fresh access JWT |
| `GET` | `/v1/telegram-onboarding/state` | `[tma]` | Returns onboarding state, theme, promo gifts, profileBasics |
| `POST`| `/v1/telegram-onboarding/track` | `[tma]` | Records user's registration track (`student` \| `general`) |
| `POST`| `/v1/telegram-onboarding/profile` | `[tma]` | Sets demographic facts (`firstName`, `age`, `gender`, `height`, etc.) |
| `POST`| `/v1/telegram-onboarding/complete`| `[tma]` | Validates contact gate and transitions to `conversational` |
| `GET` | `/v1/me` | JWT | Read current user and profile |
| `PATCH`| `/v1/me` | JWT | Update editable profile attributes |
| `DELETE`| `/v1/me` | JWT | GDPR Account erasure: purges storage files, cascades relational data |
| `POST`| `/v1/me/home-location` | JWT | Persists `homeCityKey` and coordinates; checks market status |
| `PATCH`| `/v1/me/status` | JWT | Pause/resume toggle (`active` $\leftrightarrow$ `paused`, `frozen` $\to$ `active`) |
| `POST`| `/v1/me/freeze` | JWT | Cancels in-flight matches with partner comp; sets `frozen` |
| `POST`| `/v1/me/push-token` | JWT | Register APNs/FCM device push token |
| `POST`| `/v1/me/live-activity-token` | JWT | Register ActivityKit push token (`match_decision` \| `date_day`) |
| `GET/PUT`| `/v1/me/music` | JWT | Read / update pinned Spotify tracks (0..3 tracks) |
| `GET` | `/v1/music/search` | JWT | Search Spotify catalog using app token (cached 10 min) |
| `POST`| `/v1/me/photos` | JWT | Upload profile photo; validates moderation & face presence |
| `DELETE`| `/v1/me/photos/:idx` | JWT | Delete photo at index; updates `uploadedPhotoHashes` |
| `GET` | `/v1/me/verification/native-init` | JWT | Mints STS credentials for AWS Face Liveness session (`eu-west-1`) |
| `POST`| `/v1/me/verification/native-event`| JWT | Terminal liveness event; evaluates AWS results & CompareFaces |
| `GET` | `/v1/matches/current` | JWT | Active match snapshot, partner profile, agreed venue, timezone |
| `POST`| `/v1/matches/:id/decision` | JWT | Accept or decline match proposal (enforces Blind Invariant) |
| `POST`| `/v1/matches/:id/vibe-location` | JWT | Submit departure pin & concierge vibe preferences |
| `POST`| `/v1/matches/:id/safety-ack` | JWT | Acknowledge T-1.5h pre-date safety brief |
| `POST`| `/v1/matches/:id/cancel` | JWT | Native emergency cancellation of scheduled date |
| `GET` | `/v1/matches/:id/chat` | JWT | Read pre-date proxy messages (window open T-1h to T+2h) |
| `POST`| `/v1/matches/:id/chat` | JWT | Send text message through proxy relay |
| `GET` | `/v1/matches/:id/ticket-gate` | JWT | Native Date Ticket gate status |
| `POST`| `/v1/matches/:id/ticket-gate/use` | JWT | Spend tickets from balance (`self` \| `both` \| `partner`) |
| `GET` | `/v1/matches/:id/calendar` | JWT | Native calendar availability grid & prime time band status |
| `POST`| `/v1/matches/:id/calendar` | JWT | Submit selected availability slots (auto-locks on single overlap) |
| `GET` | `/v1/matches/:id/venue-intent` | JWT | Fetch Venue Intent V2 confirmation |
| `POST`| `/v1/tickets/appstore/transaction`| JWT | Report StoreKit 2 transaction; verifies against Apple Server API |
| `POST`| `/v1/webhooks/appstore` | `[public]` | App Store Server Notifications V2 (refunds & revocations) |
| `GET` | `/v1/date/state` | JWT/tma | Living Canvas derived state (`DateLifecycleState`) |
| `POST`| `/v1/dates/:id/bump` | JWT/tma | Date Bump shake submission; verifies distance $\le 100$m & time $\le 10$s |
| `POST`| `/v1/dates/:id/proximity` | JWT/tma | Date Radar ping; drops coordinates, returns masked ETA |
| `GET/PUT`| `/v1/scratch` | JWT/tma | Dating Scratch Map tiles & opt-in toggle |
| `POST`| `/v1/scratch/ping` | JWT/tma | Add foreground position to Scratch Map (hashed to geohash-6) |
| `GET/POST`| `/v1/frequent-places` | JWT/tma | Frequently visited places list & presence check |
| `GET` | `/v1/venues/showcase` | JWT/tma | Curated venue showcase carousel for map standby mode |
| `GET` | `/v1/events` | JWT/tma | Open launch events & Party Mode sessions |
| `POST`| `/v1/events/:id/apply` | JWT/tma | Apply for launch event waitlist |
| `GET` | `/v1/events/:id/ticket/qr` | JWT/tma | Mint 90-second door admission QR code (HMAC signed) |
| `GET` | `/v1/events/:id/live` | JWT/tma | Party Mode live rounds & assigned pairings |
| `POST`| `/v1/events/:id/pairings/:pId/met`| JWT/tma | Confirm in-person meeting during speed round |
| `POST`| `/v1/events/:id/pairings/:pId/thumbs`| JWT/tma| Post-event double-blind thumbs rating (creates match if mutual) |

### 4.2 Admin HTTP API (`/admin/*`, Port 3100)
Authenticated strictly via `Authorization: Bearer <ADMIN_API_KEY>` with timing-safe string comparison.

- `GET /admin/health`: Database connectivity, uptime, node version.
- `GET /admin/stats`: Counters (users by status, onboarding steps, verification status, active matches).
- `GET /admin/dashboard`: Derived conversion metrics, CAC, LTV:CAC, ROAS, 10 most recent matches.
- `GET /admin/purchases`: Real-time uncached financial ledger (Stars, StoreKit, tickets).
- `GET /admin/ad-spend` / `POST /admin/ad-spend`: Founder acquisition cost entry form.
- `GET /admin/analytics/dau` / `GET /admin/analytics/mau`: DAU/MAU cohorts derived from `user_activity_days`.
- `GET /admin/analytics/cohort-retention`: Return-curve cohort retention at D1, D7, D14, D30.
- `GET /admin/analytics/monetization`: Conversion funnel, ARPU, ARPPU by channel and city.
- `GET /admin/analytics/virality/summary`: K-factor ($K = i \times c$), direct and word-of-mouth viral multipliers.
- `GET /admin/matches`: Paginated match audit rows with participant data and attendance records.
- `GET /admin/dialogs`: Unified conversation viewer (aggregates user messages, agent turns, and bot events).
- `GET /admin/media`: Secure image proxy to stream private photos, selfies, and chat media.

### 4.3 Telegram Bot Commands & Callbacks
- `/start [payload]`: Bot initialization; decodes deep links:
  - `ref_<code>`: Referral attribution.
  - `promo_<code>`: Promo campaign link.
  - `event_<id>`: Launch event invitation.
  - Reactivates `frozen` accounts automatically.
- `/menu`: Opens main user menu with custom emoji action buttons.
- `/edit`: Profile editor (photos, bio, preferences, height, hobbies).
- `/profile`: Sends preview of the user's current public profile card.
- `/settings`: Language, notification, and theme settings.
- `/restart`: Demo mode reset (only active when `DEMO_MODE_ENABLED=true`).
- **Core Inline Keyboard Callbacks:**
  - `match:accept:<id>`, `match:decline:<id>`: Decision buttons on the pitch.
  - `match:rematch:<id>`: Trigger Rematch purchase flow.
  - `verify:skip`, `verify:skip_confirm`, `verify:check`: Identity verification handling.
  - `onb:ph:del:<idx>`, `onb:ph:back`: Onboarding photo manager callbacks.
  - `vc:like:<id>:<key>`, `vc:confirm:<id>:<key>`: Venue change multiplayer board.

### 4.4 Background Schedulers & Workers (`apps/bot/src/index.ts`)

| Schedule / Interval | Timezone | Worker Module | Canonical Function & Side Effects |
|---|---|---|---|
| `0 18 * * 4` (Thu 18:00) | Europe/Kyiv | `match-engine.ts` | **Drop Batch (`runDropBatch`):** Preflight expire stale matches, refresh dirty embeddings, compute global greedy assortative matching by city, dispatch pitches. |
| `15 18 * * 4` (Thu 18:15) | Europe/Kyiv | `no-match-notifier.ts` | **Famine Notices:** Sends tiered empathetic notice to unpaired active users; runs `autoResumeStarvedUsers`. |
| `*/15 * * * *` | UTC | `match-expiry.ts` | **Match Expiry Sweep:** Sweeps `proposed` matches where 24h deadline lapsed; writes `EXPIRED_SILENT` & `EXPIRED_PEER_IGNORED` events. |
| `* * * * *` | UTC | `proposal-countdown.ts`| **Countdown Button Render:** Updates hours/minutes label on Telegram pitch inline keyboard button (`editMessageReplyMarkup`). |
| `0 * * * *` | UTC | `match-nudge.ts` | **Match Nudges & Stall Chain:** Evaluates whose turn it is; dispatches reminders at 3h/10h, check-in at 24h, cancellations at 48h. |
| `*/5 * * * *` | UTC | `re-engagement.ts` | **Onboarding Re-engagement:** 5-step decay chain targeting incomplete registrations (respects 23:00–09:00 quiet hours). |
| `*/15 * * * *` | UTC | `profiler.ts` | **Profiler Dispatcher:** Sends post-onboarding Q&A questions during morning/evening windows. |
| `* * * * *` | UTC | `status-timer.ts` | **Pinned Status Banner:** Updates pinned blue countdown timer button in Telegram chat. |
| `*/5 * * * *` | UTC | `embedding-refresh.ts` | **Embedding Refresher:** Scans `Profile.embeddingDirty = true` (up to 20 profiles per tick) and recomputes OpenAI vectors. |
| `30 3 * * *` | Europe/Kyiv | `selfie-retention.ts` | **GDPR Article 9 Scrub:** Hard-deletes reference selfies from Supabase bucket 90 days after verification. |
| `20 4 * * *` | UTC | `profile-music.ts` | **Spotify Refresh:** Re-fetches metadata for profile tracks older than 7 days; purges tracks dropped from Spotify. |
| `45 3 * * *` | Europe/Kyiv | `retention.ts` | **Data Retention Purge:** Deletes expired OTPs (7d), dead sessions (30d), proxy chat messages (90d), frequent place visit days (>180d). |
| `20 0 * * *` | UTC | `activity-rollup.ts` | **DAU/MAU Reconciliation:** Re-aggregates daily activity records from chat events into `user_activity_days`. |
| `40 3 * * *` | UTC | `virality-rollup.ts` | **Virality Rollup:** Recalculates $K$-factors and maturity cohorts for the trailing 120 days into `virality_days`. |
| `0 4 * * *` | Europe/Kyiv | `venue-revalidation.ts`| **Venue Revalidation:** Sweeps Google Places API for venue closures, rating changes, and hours (max 30 places/tick). |
| `0 * * * *` | UTC | Refund Workers | **Refund Sweeps:** Retries failed refunds for Date Tickets, Rematch, Venue Change, Prime Time, and Meme Unlock. |
| `setInterval(20s)` | — | `peer-wait-shimmer.ts` | **Peer-Wait Shimmer:** Re-issues ephemeral Telegram `<tg-thinking>` draft while waiting for partner actions. |
| `setInterval(2min)` | — | `date-lifecycle.ts` | **Date Lifecycle Tick:** Pre-date safety briefs (T-1.5h), proxy chat open (T-1h) / close (T+2h), feedback trigger (T+24h). |
| `setInterval(60s)` | — | `event-rounds.ts` | **Party Mode Rounds:** Opens and closes 35-minute pairing rounds during live launch events. |

---

## 5. Monetization & Paywalls

Gennety monetizes offline real-world interactions rather than digital swiping. Money moves through two rails: **Telegram Stars (XTR)** for Telegram Mini App users, and **StoreKit 2** for native iOS users.

### 5.1 Pricing Matrix & Products

| Product / Feature | Scope & Type | Telegram Stars Price | Apple StoreKit 2 Price | Product ID |
|---|---|---|---|---|
| **1 Date Ticket** | Consumable (Wallet) | Env `TICKET_BUNDLE_STARS` (~400⭐) | $6.99 (Ref: $8.49) | `ticket_1` |
| **3 Date Tickets** | Consumable (Wallet, -20%) | Env `TICKET_BUNDLE_STARS_3` (~950⭐)| $16.99 (Ref: $20.37) | `ticket_3` |
| **6 Date Tickets** | Consumable (Wallet, -35%) | Env `TICKET_BUNDLE_STARS_6` (~1550⭐)| $29.99 (Ref: $33.12) | `ticket_6` |
| **Date Gate: Self** | Gate Payment (1 match) | Variable (~400⭐, or 77% off famine) | Spends 1 Ticket | `gate:<id>:self` |
| **Date Gate: Both** | Male covers both slots | Variable (~800⭐) | Spends 2 Tickets | `gate:<id>:both` |
| **Prime Time Pass** | Consumable (Per-date) | 50⭐ | $0.99 | `prime_time_pass` |
| **Venue Change (Agreed)**| Consumable (Per-date) | 150⭐ (`VENUE_CHANGE_STARS`) | $2.99 / In-app | `venue_change_1` |
| **Venue Change (Express)**| Unilateral Instant Swap | 150⭐ | $2.99 / In-app | `venue:<id>:express`|
| **Rematch Rerun** | Consumable (On-demand) | 150⭐ (`REMATCH_STARS_PRICE`) | N/A (Telegram first)| `rematch:v1` |
| **Gennety Premium (1 mo)**| Auto-Renewing Sub | 900⭐ / mo (`sub:premium`) | $17.99 / month | `premium_monthly` |
| **Gennety Premium (3 mo)**| Fixed 3-Month Package | 2,300⭐ (-15%, `sub:premium3`) | N/A | Package |
| **Gennety Premium (6 mo)**| Fixed 6-Month Package | 3,800⭐ (-30%, `sub:premium6`) | N/A | Package |

### 5.2 Paywalled Capabilities
1. **Date Ticket Gate (`negotiating` State):**
   - The primary paywall. Once two users accept a pitch, neither can access the scheduling calendar until the gate is settled.
   - Settle options: User spends 1 ticket from wallet, pays via Telegram Stars / StoreKit, has an active Gennety Premium subscription, or was covered by the male partner.
2. **Prime Time Evening Band:**
   - Calendar slots on weekday evenings (19:00+) and weekend peak hours are locked by default.
   - Unlocked for the pair if either user purchases a Prime Time Pass or holds Gennety Premium.
3. **Venue Change Board:**
   - Swapping an assigned curated venue requires 150 Stars or 1 Venue Change consumable.
4. **Rematch Rerun:**
   - If a pitch is declined, male users can bypass the weekly cadence by purchasing a Rematch rerun.
5. **Gennety Premium Entitlements:**
   - Zero Date Ticket fees on all matches.
   - Automatic unlock of Prime Time calendar slots.
   - Priority matching queue position during drop batching.
   - Badge styling and extended profile visibility.

---

## 6. Touchpoints for Marketing, Integrations & Creative Features

### 6.1 High-Attention Screens & Peak Engagement Moments
1. **The Cinema Pitch (`TodayView` / Bot Pitch Card):**
   - Dispatched at the drop hour. Contains dynamic cinematic artwork, partner voice note preview, compatibility synergy breakdown, and a live reply deadline countdown.
2. **The 3D Ticket Tear & Confetti (`ticket.html` / `TicketView`):**
   - Realistic 3D skeuomorphic ticket rendered with three-dimensional perspective, tear-off perforated stub animation, and haptic confetti upon gate settlement.
3. **The Living Canvas & Transit Dock (`CanvasStage.swift` / `canvas.html`):**
   - Visual map showing the date location pin, walking routes, and an integrated one-tap dock to launch Uber, Bolt, Apple Maps, or Google Maps with pre-populated destination coordinates.
4. **The Date Bump Screen (`date-terminal.html` / Native Bump Sheet):**
   - Appears at the venue when both phones detect proximity. Features pulsing radar animations, CoreMotion shake detection, and butterfly flight burst upon mutual verification.
5. **Party Mode Live Rounds (`event.html` / `gatekeeper.html`):**
   - Live speed-dating rounds during launch events, countdown timers per pairing, 90-second cryptographic QR scanner at venue doors, and morning-after double-blind thumbs reveal.

### 6.2 Deep Link Architecture
Gennety supports structured deep links across Telegram and native iOS:

- **Telegram Bot Format:** `https://t.me/gennetybot?start=<payload>` or `tg://resolve?domain=gennetybot&start=<payload>`
  - `ref_<referralCode>`: Links user to referrer (`User.referredById`); unlocks milestone ladder for referrer upon verification.
  - `promo_<code>`: Applies promo code campaign, granting welcome tickets and trial months.
  - `event_<eventId>`: Direct route to event admission and ticket claiming.
  - `date_<matchId>`: Direct access to scheduled date details or terminal.
- **Native iOS URL Scheme & Universal Links:**
  - `gennety://promo?code=<code>`: In-app promo redemption.
  - `gennety://spotify-import?status=<status>`: Spotify OAuth PKCE callback destination.
  - Deferred Deep Linking: `/v1/promo/:code` copies `GENNETY:<CODE>` to clipboard and tracks IP/device fingerprint before redirecting to the App Store; the iOS app reads clipboard or invokes `/v1/me/promo/claim-deferred`.

### 6.3 Gamification & Viral Loops
- **Reliability Score:** Every user profile maintains a `reliabilityScore` (default 100). Completing a verified physical Date Bump awards `+50` Reliability. No-shows or cancellations within 2 hours of a date trigger severe score penalties and temporary matchmaking suspensions.
- **Dating Scratch Map:** An interactive "fog of war" map of the city. As users walk around or complete dates, Geohash-6 tiles (~1.2 km $\times$ 0.6 km) are un-fogged, displaying their explored percentage of the city.
- **Referral Milestone Ladder:**
  - Progress tracker with cash/ticket rewards based on verified signups ($K$-factor direct tracking).
  - Rewards are triggered when the referred user clears **identity verification**, preventing fake account farming.
- **Famine Streak Relief:**
  - Users eligible but unpaired for 2 consecutive batches receive a 77% discount on Date Tickets (`FAMINE_DISCOUNT_PCT = 77`).
  - At 28 days without a match, the system triggers an honest "Pool Exhaustion Pause" with auto-resume when new opposite-gender users register.

### 6.4 Partner Surfaces & Venue Integrations
- **Venue Representation:** Represented in `CuratedVenue` with Google Place ID, centroid coordinates, verified address, price tier, opening hours, and affiliated university domains.
- **Commercial Model:** Gennety's core business model integrates ticket fees ($8.49) with a **10% venue food/beverage revenue share** for driving confirmed student pairs to specific tables.
- **Standby Showcase Carousel:** When users are between matches (`IDLE_EXPLORING`), the Living Canvas displays partner venues as styled photo pins with a bottom card carousel arranged in order of a walking tour.

---

## 7. Invariants, Constraints & Edge Cases

### 7.1 Security & Privacy Boundaries
1. **Zero-Chat Platform Invariant:** Users cannot initiate unmoderated text or media chats with each other. The only communication is the time-boxed (T-1h to T+2h) plain-text proxy relay, where all messages are recorded to `ProxyMessage` with inline report capabilities.
2. **Ephemeral Location Tracking:** Real-time GPS coordinates are never persisted. Date Radar, Frequent Places, and Scratch Map process coordinates in memory and discard them immediately.
3. **Blind Decision Invariant:** Neither side of a match proposal can inspect the partner's accept/decline action until both have responded or the 24-hour TTL has expired.
4. **GDPR Article 9 Biometric Data Scrub:** Reference selfies stored in Supabase during AWS Face Liveness checks are permanently purged after 90 days (`services/selfie-retention.ts`). Subsequent profile photo edits require fresh liveness verification.
5. **Face Obstruction Policy:** To prevent false rejections of legitimate users, sunglasses and facial covering rejections at upload time are removed. Identity is verified strictly at the final liveness stage.

### 7.2 Technical Bottlenecks & Operational Constraints
1. **Single-Process Monolith:** The entire backend (bot polling, public API, admin API, 16 crons) runs in a single Node.js process (`apps/bot`). Long-running synchronous CPU operations (e.g. image rendering via Satori/Canvas) must remain offloaded or bounded to prevent event loop lag.
2. **AWS Rekognition Regional Discrepancy:**
   - AWS Rekognition Face Liveness is deployed in `eu-west-1` (Ireland) because it is unavailable in `eu-central-1` (Frankfurt).
   - Core Rekognition features (`CompareFaces`, `DetectFaces`) run in `eu-central-1`.
   - Backend maintains two distinct AWS client instances mapped to these respective regions.
3. **Telegram Rate Limits:** The Telegram Bot API imposes strict limits (30 messages/second globally; 1 message/second per private chat). Batch drop pitches are routed through a rate-limited dispatch queue with exponential backoff (`services/dispatch-queue.ts`).
4. **BigInt JSON Serialization:** PostgreSQL `BigInt` (used for `telegramId`) cannot be serialized natively by `JSON.stringify`. All API serializers must convert `BigInt` fields to strings before responding to clients.
5. **Multi-Overlap Auto-Lock:** In calendar slot and venue change negotiations, a single intersection between participants automatically locks in the selection; multiple intersections present an interactive disambiguation card to the actor.
