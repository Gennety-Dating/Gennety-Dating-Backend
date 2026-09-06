<!-- WHEN_TO_READ: ALWAYS read this first for any product/behaviour change. Holds the project overview and the Core Principles (Strict Rules) that every flow must obey. Individual flows live in docs/product/domains/ — see the map at the bottom of this file. -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 1-121) — migrated 2026-09-01 -->

# Gennety Dating — Product Specification

> **Version:** 2.2 (rewritten 2026-05-04 to reflect the actual code; clarified
> 2026-05-06 as product-invariants documentation; identity verification moved
> from Persona to AWS Rekognition Face Liveness 2026-07-26 — §1.4; the
> 1.x linear-FSM onboarding and visual-screening sections are obsolete.)
> Tech stack and coding rules are in [AGENTS.md](../operations/agent-operating-manual.md).
> Database schema and system architecture are in [ARCHITECTURE.md](../architecture/overview.md).
> This file documents product invariants and major flows, not every
> implementation detail. Code, tests, and Prisma remain the source of truth for
> local mechanics.

## Project Overview

Gennety Dating is an AI-first romantic matchmaking service. It launched for
university students and (Registration v2, 2026-07) opens to a general adult
audience while keeping a first-class student community: students register
with a university email (and get loyalty perks), everyone else with a phone
number. It diverges from traditional dating apps by relying on deep context
extracted from each user's personal LLM (ChatGPT, Claude, etc.) and completely
eliminating user-to-user text communication before the first date. The system
acts as the matchmaker: it finds the match, pitches it, and negotiates the
logistics until both users meet in person.

The product surface is Telegram-first: `@gennetybot`, the Calendar Mini App,
and a shared `/v1/*` HTTP API for the native mobile client. This repo contains
the backend, Mini App, and public API (the native iOS client lives in the
separate `Gennety-iOS` repo); a full
`apps/mobile` workspace is not present here yet. Both Telegram and mobile users
share the same Postgres backend (`User.platform ∈ {telegram, mobile, both}`).
Mobile-only users carry a synthetic **negative** `telegramId` and are filtered
out of Telegram-only workers.

## Core Principles (Strict Rules)

- **Dual-Track Verified Registration (Registration v2)** — Every user MUST
  verify a contact rail at sign-up. The fork (gated by `PHONE_AUTH_ENABLED`;
  off → legacy email-only flow) offers two tracks recorded in
  `User.registrationTrack`: **student** — university email OTP (whitelist in
  `ALLOWED_EMAIL_DOMAINS`, e.g. `.edu`, `.ac.uk`), rewarded with
  `STUDENT_BONUS_TICKETS` (2) free Date Tickets; **general** — phone via
  Telegram one-tap `requestContact` (the bot receives a trusted
  `message.contact`; `User.phone` is `@unique` — one account per number).
  On the **native mobile app** (no Telegram one-tap there) the general track
  verifies the phone with a delivered code instead: **Twilio SMS by default**
  (founder decision 2026-07-18; Telegram Gateway remains an optional
  secondary rail behind `PHONE_CODE_PRIMARY_PROVIDER`)
  (`/v1/auth/phone/*`, same `PHONE_AUTH_ENABLED` gate; the verified number
  lands in the same unique `User.phone` + `phoneVerifiedAt`, so Telegram and
  mobile registrations can never duplicate an account). Because the number is
  the shared identity across both rails, **verifying it is also the login**: a
  uniqueness collision resolves to the existing account rather than a refusal
  (§1.1).
  **Third rail on iOS: "Continue with Telegram" (2026-08-02).** Telegram's
  official native Login SDK returns a signed OIDC ID token; the server verifies
  it against Telegram's public keys (`POST /v1/auth/telegram`). With the `phone`
  scope the token carries an already-**verified** `phone_number`, which is
  accepted as the general track's contact rail — so this login satisfies the
  same gate as an SMS code while costing nothing. It is not a fourth kind of
  account: the token's subject IS `User.telegramId`, so a bot user who installs
  the app lands in their existing profile, and an app user who verified by SMS
  is matched by that same number. A collision where the number and the Telegram
  identity belong to two different real accounts is refused (`account_conflict`)
  and routed to support, exactly like the Telegram-side `manual-merge`. Gated by
  `TELEGRAM_LOGIN_CLIENT_ID` (empty → the client hides the button).
  **One consequence to hold onto:** such an account carries a REAL positive
  `telegramId` while being reachable only by push, because a bot cannot message
  someone who never pressed Start. `platform` is the canonical reachability
  check; the id alone is not (ARCHITECTURE.md → `users`).
  Matching admits the union of the two valid cohorts (student + verified email,
  or general + verified phone); a credential from the other track never
  satisfies an individual's gate. The student
  community keeps its flavor via educational homogamy, shared-domain curated
  venues, and the 🎓 profile line.
- **NO IN-APP CHAT** — Users NEVER message each other through our platform. Do
  not build chat interfaces between users. The only chats are user↔bot,
  user↔chat agent (mobile), and the structured pitch / scheduling /
  emergency flows. **Narrow exception (feature-flagged):** the Variant C
  pre-date *anonymous proxy chat* (§Phase 4 — Pre-date coordination) relays
  text between an already-matched, already-scheduled pair. It is deliberately
  scoped so it does not reopen general user-to-user chat: post-match only,
  time-boxed (opens T-1h, auto-closes T+2h), text-only (media rejected),
  every message logged to `ProxyMessage`, an in-line Report button on each
  relayed message, and off by default (`COORDINATION_FEATURE_ENABLED`). It
  exists to solve "find each other at the venue", not conversation.
- **Deep Context over Questionnaires** — At the end of the Telegram entry Mini
  App the user chooses whether to enrich onboarding from ChatGPT, Claude,
  Gemini, or another personal LLM. Accepted users paste the *Magic Prompt* and
  return the long psychological analysis. Declined users continue without it;
  the backend generates a deterministic fallback summary + embedding from
  their ordinary onboarding answers.
- **Identity-Verified, Mandatory at Launch** — Liveness (AWS Rekognition Face
  Liveness, migrated off Persona 2026-07-26) + photo↔selfie face-match (AWS
  Rekognition `CompareFaces`) gate full match eligibility. With
  `MANDATORY_VERIFICATION_ENABLED` on (Registration v2), the CTA has no Skip
  button and activation happens ONLY through the pipeline's `verified`
  outcome; legacy skip callbacks refuse politely and pre-flip skippers are
  grandfathered with their `UNVERIFIED_ELO_PENALTY`. A production-like process
  refuses to boot when liveness is disabled or unconfigured (no AWS
  credentials, no `LIVENESS_STS_ROLE_ARN`), Rekognition is disabled, or
  profile-media validation is disabled. **There is no sandbox escape hatch any
  more:** the Persona era shipped `ALLOW_SANDBOX_PERSONA`, which let production
  run test-only KYC, and it is gone with the provider — Face Liveness has no
  sandbox/production key split, so a production-like config is either complete
  or it does not start. (Historical note: `verified` statuses granted during
  the sandbox window carry no real identity guarantee and were never
  retroactively cleared.)
- **Progressive Logistics** — The AI auto-proposes timeslots first; if both
  rounds fail it hands off to the Calendar Mini App; venue is chosen by an
  AI concierge from each user's free-text *vibe* + commute pin.
- **Native Telegram AI Experience** — Heavy use of Bot API 9.x/10.x:
  bottom-of-chat `sendMessage` + `editMessageText` streams (status, pitch,
  no-match, ice-breakers), `icon_custom_emoji_id` (menu and match-decision
  affordances), `message_effect_id` (match confirmations), `date_time`
  MessageEntity (timezone-aware date confirmation), and pinned status banner
  (live discrete countdown). Product flows intentionally avoid Telegram draft
  streams because clients treat them like generated AI replies and may reserve
  scroll space for a follow-up answer.
- **Blind Decision Invariant** — A user must never learn their partner's
  Accept/Decline before committing to their own.
