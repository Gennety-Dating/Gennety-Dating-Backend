> **Product invariants and user flow** live in [PRODUCT_SPEC.md](PRODUCT_SPEC.md).
> **System architecture, data ownership, and API topology** live in [ARCHITECTURE.md](ARCHITECTURE.md).
> **The isolated demo bot** lives in [DEMO_MODE.md](DEMO_MODE.md).
> **Production deploy/runbook** lives in [deploy.md](deploy.md).

## Obsidian Memory Protocol

This repo is indexed in the local Obsidian vault as part of Gennety Dating.

Before meaningful implementation work, read:
- `/Users/pro/Documents/Obsidian Vault/Projects/Project Registry.md`
- `/Users/pro/Documents/Obsidian Vault/Projects/Gennety Dating/Project Brief.md`

After meaningful implementation, update Obsidian when relevant:
- `Projects/Gennety Dating/Sessions/` for session summaries
- `Projects/Gennety Dating/Changelogs/` for shipped behavior, UX, API, deploy, or user-facing changes
- `Projects/Gennety Dating/ADRs/` for architecture, product strategy, data model, privacy, matching, or core assumption decisions

Do not store secrets, raw env values, private keys, or sensitive user data in Obsidian.

## Purpose

This file is the operating manual for coding agents working in this repo. It
should describe how to work effectively, not re-explain implementation details
that are already obvious from code.

When prose and code disagree:
1. Treat code, tests, Prisma schema, and runtime config as the implementation
   source of truth.
2. Treat PRODUCT_SPEC.md as the source of truth for product invariants.
3. Report the mismatch before making behavior-changing assumptions.

## Current Stack

- **Bot / backend process**: Node.js 20+, TypeScript, grammY, Express.
- **Telegram Mini App**: Vite + TypeScript using Telegram WebApp globals. It is
  currently a small vanilla TS app, not a React app.
- **Video workspace**: Remotion + React in `apps/video` for local Studio preview
  and programmatic video rendering. It is not part of the production bot or
  Mini App runtime.
- **Mobile surface**: the public `/v1/*` API, consumed by the native SwiftUI
  app in the separate `Gennety-iOS` repo (`~/Desktop/Gennety-iOS`; its
  OpenAPI contract is `openapi/gennety-v1.yaml` here). The legacy Expo
  `mobile-handoff/` components were removed 2026-07-18.
- **Database**: PostgreSQL + pgvector through Prisma (`packages/db`).
- **AI / media / verification**: OpenAI, AWS Rekognition (Face Liveness for
  identity + CompareFaces/moderation for media; replaced Persona 2026-07-26), Supabase
  Storage, Google Places, Expo push.
- **Shared package**: `packages/shared` for constants, types, i18n, and prompts.
- **Workspace**: pnpm workspaces.

Use official Telegram docs when changing Bot API or Mini App behavior:

- https://core.telegram.org/bots/api
- https://core.telegram.org/bots/webapps

## Commands

- Install: `pnpm install`
- Dev bot: `pnpm dev:bot`
- Dev Mini App: `pnpm dev:webapp`
- Dev video Studio: `pnpm dev:video`
- Render video: `pnpm render:video`
- Build all: `pnpm build`
- Lint all: `pnpm lint`
- Test all: `pnpm test`
- Typecheck all: `pnpm typecheck`
- Dev DB up/down: `pnpm dev:db:up`, `pnpm dev:db:down`
- Dev DB push/studio/reset: `pnpm dev:db:push`, `pnpm dev:db:studio`,
  `pnpm dev:db:reset`
- Test DB up/down/push: `pnpm test:db:up`, `pnpm test:db:down`,
  `pnpm test:db:push`

Prefer file-scoped or package-scoped verification while iterating:

- Bot test file: `pnpm --filter @gennety/bot exec vitest run src/path/file.test.ts`
- Shared test file: `pnpm --filter @gennety/shared exec vitest run src/path/file.test.ts`
- Webapp test file: `pnpm --filter @gennety/webapp exec vitest run src/path/file.test.ts`
- Bot typecheck: `pnpm --filter @gennety/bot typecheck`
- DB generate: `pnpm --filter @gennety/db db:generate`
- DB push: `pnpm --filter @gennety/db db:push`

## Project Map

```
/
├── apps/
│   ├── bot/          # grammY bot, Express public/admin APIs, workers
│   ├── video/        # Remotion Studio, compositions, and local renders
│   └── webapp/       # Vite Telegram Calendar Mini App
├── packages/
│   ├── db/           # Prisma schema, client exports, DB helpers
│   └── shared/       # constants, i18n, types, AI prompts
├── scripts/          # local/deploy helper scripts
├── AGENTS.md
├── PRODUCT_SPEC.md
├── ARCHITECTURE.md
└── deploy.md
```

## Feature Workflow

1. Read the existing flow before editing. Start from routes/handlers, then
   services, then shared constants/prompts, then tests.
2. Identify whether the change affects product invariants, API contracts,
   Prisma schema, env vars, cron/deploy behavior, or external services.
3. Add or update focused tests first when behavior changes.
4. Implement the smallest change that fits existing boundaries and naming.
5. Run the narrowest useful tests/typecheck, then broaden only if risk justifies it.
6. Do the documentation impact check described below.

Avoid new abstractions unless they remove real duplication or protect a clear
contract. Do not add dependencies without approval.

## Bug Fix Workflow

1. Reproduce the bug with a failing test, fixture, or narrow command when feasible.
2. Find the root cause; avoid patching only the visible symptom.
3. Check adjacent flows that share the same service, callback prefix, cron, or DB field.
4. Add regression coverage for the failing behavior.
5. Keep the patch small and avoid unrelated cleanup.

## Review Workflow

When asked to review, lead with findings, ordered by severity, with file/line
references. Focus on:

- Product invariant violations from PRODUCT_SPEC.md.
- Trust boundary mistakes: Telegram initData, JWT, liveness session verdicts
  (never a client claim), admin bearer auth.
- Database safety: Prisma schema drift, raw SQL, vector indexes, cascade behavior.
- Matchmaking invariants: no repeated pair, blind decision, no in-app user chat.
- Verification bypasses: corporate email, liveness, face-match, skip penalties.
- Worker side effects: cron idempotency, duplicate DMs, quiet hours, rate limits.
- Mobile parity: does the change touch the `/v1/*` JWT surface or a product
  flow the iOS app consumes? Spec updated same-commit; Telegram-only scope
  explicit; channel-aware notifications (see "Two Clients, One Backend").
- Missing tests for changed behavior.

If no issues are found, say that clearly and mention any remaining test or
runtime risk.

## Two Clients, One Backend (Telegram + native iOS)

This backend serves TWO product surfaces: the Telegram bot/Mini Apps AND the
native SwiftUI app (separate repo `~/Desktop/Gennety-iOS`, contract =
`openapi/gennety-v1.yaml` here, docs there: AGENTS/PRODUCT_SPEC/DESIGN/
ARCHITECTURE/ROADMAP/IMPLEMENTATION_PLAN). Both share one Postgres and ONE
matching pool (`User.platform`). Rules for every behavior change:

1. **Design for both surfaces by default.** A new product mechanic, flow
   change, or invariant change must state how it behaves on Telegram AND on
   iOS. "Telegram-only" is a legitimate answer, but it must be an explicit,
   recorded decision (like the existing Telegram-only feature flags), never
   an accident of where the code happened to be written.
2. **`/v1/*` JWT surface = the iOS contract.** Any change to those route
   shapes updates `openapi/gennety-v1.yaml` in the SAME commit
   (`pnpm openapi:lint`), and is additive unless explicitly approved —
   the App Store cannot roll back shipped clients (kill switch:
   `IOS_MIN_SUPPORTED_APP_VERSION`).
3. **Mobile-relevant work gets recorded in the iOS repo.** If a backend
   change creates client work (new endpoint to adopt, changed flow, new
   push/Live-Activity event), add or update the task in
   `~/Desktop/Gennety-iOS/IMPLEMENTATION_PLAN.md` (its AGENTS.md living-docs
   protocol applies there).
4. **Shared services stay channel-aware.** Notifications go through
   channel-aware helpers (Telegram DM and/or APNs push — see
   `notifyParticipant` / `services/push.ts`); never assume a user is
   reachable via Telegram (`platform` may be `mobile`, `telegramId` may be
   synthetic negative).

## Product Guardrails

Always preserve these unless the user explicitly asks to redesign the product
and confirms the tradeoff:

- No user-to-user in-app chat.
- Contact verification stays mandatory and track-aware (Registration v2):
  university-email OTP for the student track, trusted Telegram-contact phone
  for the general track; matching admits the union of the two rails. Never
  waive the gate or let one track bypass the other's rail.
- Onboarding steps and required data are not skipped.
- Blind decision invariant: users do not learn the partner's decision before
  making their own.
- Liveness/face-match verification stays meaningful: mandatory (no skip, no
  unverified activation) when `MANDATORY_VERIFICATION_ENABLED` is on; the
  legacy soft-skip + unverified Elo penalty applies only while it is off /
  for grandfathered pre-flip users. A liveness check that does not clearly pass
  is retryable, never `rejected` — that status is reserved for a real detected
  face in the photo set that isn't the verified person.
- Scheduled-date confirmations use Telegram `date_time` entity where applicable.
- Telegram Bot API calls should go through grammY abstractions unless the API
  surface is not typed yet; raw Bot API usage must be isolated and justified.

Ask first before:

- Changing user flow or product rules.
- Adding external APIs or dependencies.
- Changing Prisma schema, vector indexes, or destructive DB behavior.
- Switching workspace/build systems.
- Touching production secrets or irreversible deploy steps.

## Demo Mode Impact Check

This backend runs a **second, isolated deployment**: the demo bot
([DEMO_MODE.md](DEMO_MODE.md)), which walks investors and friends through the
whole product from one account — no real partner, no real identity check, no
real money, no waiting. It is the same source tree behind one flag
(`DEMO_MODE_ENABLED`) that production never sets.

Most changes need nothing. The demo driver re-derives state on every tick
instead of hooking into the matching handlers, so ordinary flow changes are
picked up for free. Ask the question only when a change adds or moves one of:

1. **A gate** — anything a user must pass (verification, a contact rail, a
   validation step). Does demo wave it through, and where?
2. **A paid step** — demo cannot charge. Is there a mock rail, is it free, or
   is the screen skipped? Say which, because "skipped" means an investor never
   sees that surface.
3. **A two-sided negotiation step** — the puppet needs a branch in
   `apps/bot/src/demo/decide.ts`, or the demo dead-ends there.
4. **How a match is created or advanced** — re-check the driver's state table
   in DEMO_MODE.md still describes reality.

When the answer is not obvious from the change itself, **ask the user how it
should behave in demo mode** rather than assuming. Same shape as the "Two
Clients, One Backend" rule above, which forces the equivalent question for iOS.

Two hard rules, not judgment calls:

- **No demo-only table or column in `packages/db/prisma/schema.prisma`.** The
  schema is shared, so it would ship to the production database. Demo
  bookkeeping that cannot be derived from real product state lives in memory.
- **Demo behavior stays inside `apps/bot/src/demo/`**, reached from production
  modules only through a single commented `if (DEMO_MODE_ENABLED)`. If a change
  needs more than that, it needs a design conversation first.

## Documentation Impact Check

After any code change, check whether docs need updates. Update docs only when
the change affects:

- Product invariants or major user flow.
- Architecture boundaries, data ownership, or external integrations.
- Public/admin API contracts.
- Prisma schema, env vars, cron schedules, deployment, or rollback behavior.
- Agent workflow rules in this file.

Do not document local implementation details just because code changed. If no
docs are affected, say `Docs unaffected` in the final response or PR notes.

### DECISIONS.md — the context rule (MANDATORY, every session)

Only files cross a session boundary; the conversation does not. So anything
that would otherwise live only in chat MUST land in
[DECISIONS.md](DECISIONS.md) — **in the same turn and the same commit as the
work**, whatever the task:

- a product decision the founder made in conversation (including "no, we are
  not doing that");
- a change of my own mind mid-task;
- a deviation from the plan — different scope, approach, or order;
- scope deliberately left undone, with the reason;
- a document found to disagree with the code.

This is a separate rule, not a special case of the impact check above.
PRODUCT_SPEC and ARCHITECTURE record HOW the product works; DECISIONS.md
records WHY it is that way and what was rejected. The second does not follow
from the first, and it is the one that gets lost.

**Read DECISIONS.md before starting a task.** An entry there can override the
plan or a runbook block: the specs state intent, the journal states the latest
decision. On conflict the journal wins, and the disagreement is resolved by
editing the spec in the same turn.

Client-side decisions go in the iOS repo's DECISIONS.md, under its rules.

## Post-Implementation Git Workflow

**Standing rule (single-branch journal — see CLAUDE.md): commit and push after
EVERY change, no matter how small, before ending your turn.** This is durable,
pre-authorized — do not ask first. Work directly on `main`; never create
branches. The GitHub remote is a transparent, rollback-able log of each step, so
the working tree must not accumulate mixed, hard-to-attribute changes between
sessions.

After any turn that edits/adds/deletes files, complete the Git handoff:

1. Run the relevant tests, typecheck, or build for the change. Use narrow
   verification while iterating and broaden when risk justifies it.
2. Complete the Documentation Impact Check above, and update Obsidian when the
   change warrants a session, changelog, or ADR note.
3. Check `git status` and `git diff` before staging.
4. Stage the changes for the work just done. Never stage `.env`, secrets, raw
   logs, build artifacts, `node_modules`, or local tooling (`.claude/`,
   `.agents/`, `.gstack/` are gitignored).
5. Commit with a clear, scoped message.
6. `git push origin HEAD` (i.e. to `origin/main`).

A turn that changed **no** files (pure analysis, a question, a read-only answer)
has nothing to record — do not create an empty commit. Roll back with
`git revert` (or `git reset` for unpushed work). If relevant tests/typecheck/
build fail, still commit to keep the journal current but call out the failing
state in the commit/PR notes (the user has opted into this) unless told
otherwise. If push is blocked by authorization, a protected branch, or a
non-fast-forward, stop and report the exact cause.

## Deployment

`deploy.md` is canonical for production. When asked to deploy, read it first
and proceed from the documented hostnames, paths, PM2 service names, Caddy
routes, env-file locations, and rollback steps.

Ask only when access is blocked, required secrets are missing from documented
locations, or the requested action is destructive beyond the documented rollback.

Production and local development must never share `BOT_TOKEN`; Telegram long
polling delivers each update to only one consumer.

## Local Development

One-time setup:
1. Create a separate dev bot in BotFather.
2. `cp .env.local.example .env.local` and fill in dev values.
3. `pnpm dev:db:up`
4. `pnpm dev:db:push`

Daily loop:

- `pnpm dev:bot`
- `pnpm dev:webapp`
- `pnpm dev:db:studio`

Env loading order is `.env.local` then `.env`; `.env.local` wins because
dotenv does not override already-set keys. Delete `.env.local` only when you
intentionally want local code to use production-like config.

All cron jobs in `apps/bot/src/index.ts` also fire locally. The dev DB usually
has no users, so they are mostly no-ops.

Mini App local dev needs HTTPS tunneling, then `WEBAPP_URL` must point to the
tunnel and the dev bot must be configured in BotFather.

## Style And Safety

- TypeScript strictness is intentional: no `any` unless there is no reasonable
  typed alternative.
- Use named exports and existing functional patterns.
- Keep shared package changes backward-compatible unless explicitly approved.
- Keep user-facing strings in shared i18n where the surrounding flow is localized.
- Use shared constants for limits, timings, and product thresholds.
- Do not commit `.env`, secrets, `node_modules`, build artifacts, or raw logs
  containing user data.
- Respect dirty working trees. Never revert unrelated user changes.

## gstack

### Web Browsing

Always use the `/browse` skill from gstack for web browsing tasks. Never use
`mcp__claude-in-chrome__*` tools.

### Available Skills

- `/plan-ceo-review` - CEO/founder-mode plan review.
- `/plan-eng-review` - engineering plan review.
- `/review` - pre-landing PR review.
- `/ship` - ship workflow.
- `/browse` - headless browser QA and dogfooding.
- `/qa` - systematic web app QA.
- `/setup-browser-cookies` - import cookies into browse session.
- `/retro` - retrospective over commit history and work patterns.

### Troubleshooting

If gstack skills are not working, rebuild them:

```sh
cd .claude/skills/gstack && ./setup
```
