> **Product invariants and user flow** live in [PRODUCT_SPEC.md](PRODUCT_SPEC.md).
> **System architecture, data ownership, and API topology** live in [ARCHITECTURE.md](ARCHITECTURE.md).
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
- **AI / media / verification**: OpenAI, Persona, AWS Rekognition, Supabase
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
- Trust boundary mistakes: Telegram initData, JWT, Persona HMAC, admin bearer auth.
- Database safety: Prisma schema drift, raw SQL, vector indexes, cascade behavior.
- Matchmaking invariants: no repeated pair, blind decision, no in-app user chat.
- Verification bypasses: corporate email, Persona, face-match, skip penalties.
- Worker side effects: cron idempotency, duplicate DMs, quiet hours, rate limits.
- Missing tests for changed behavior.

If no issues are found, say that clearly and mention any remaining test or
runtime risk.

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
- Persona/face-match verification stays meaningful: mandatory (no skip, no
  unverified activation) when `MANDATORY_VERIFICATION_ENABLED` is on; the
  legacy soft-skip + unverified Elo penalty applies only while it is off /
  for grandfathered pre-flip users.
- Scheduled-date confirmations use Telegram `date_time` entity where applicable.
- Telegram Bot API calls should go through grammY abstractions unless the API
  surface is not typed yet; raw Bot API usage must be isolated and justified.

Ask first before:

- Changing user flow or product rules.
- Adding external APIs or dependencies.
- Changing Prisma schema, vector indexes, or destructive DB behavior.
- Switching workspace/build systems.
- Touching production secrets or irreversible deploy steps.

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
