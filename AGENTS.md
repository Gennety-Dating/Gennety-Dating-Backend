# Gennety Dating — Project Operating Guide

Telegram-first AI matchmaking: the bot runs onboarding, matches a pair blind,
negotiates a real venue, and hands the date off to a Mini App (plus a native
iOS client on the same `/v1/*` API).

**The single always-loaded entry point for every agent**; everything else is
read on demand from `docs/`. **No `CLAUDE.md`** (Claude Code reads `AGENTS.md`;
if a tool needs that name, a one-line `@AGENTS.md` pointer, never a copy) and
no `@imports` here (they once flooded every session).

## Stack

Node 20 + TypeScript · grammY · Express · Vite Mini App (vanilla TS) ·
PostgreSQL + pgvector via Prisma · pnpm workspaces · OpenAI · AWS Rekognition ·
Supabase Storage · Google Places · Remotion (`apps/video`, not production).

## Commands

```bash
pnpm install
pnpm dev:bot            # bot + APIs        pnpm dev:webapp   # Mini App
pnpm build              pnpm lint           pnpm test         pnpm typecheck
pnpm dev:db:up          pnpm dev:db:push    pnpm dev:db:studio
# scope while iterating — faster and quieter:
pnpm --filter @gennety/bot exec vitest run src/path/file.test.ts
pnpm --filter @gennety/bot typecheck
pnpm --filter @gennety/db db:push
```

## Repository map

`apps/bot/` grammY bot, Express public + admin APIs, cron workers ·
`apps/webapp/` Vite Telegram Mini App · `apps/video/` Remotion Studio (not
production) · `packages/db/` Prisma schema + client · `packages/shared/` i18n,
types, prompts, constants · `scripts/` local + deploy helpers · `openapi/` /v1
contract for the iOS repo · `docs/` ALL documentation (routing below).

## Non-negotiable rules

1. **Blind decision** — a user never learns the partner's decision before
   making their own.
2. **No user-to-user in-app chat.** Anonymous proxy chat is the sole
   person-to-person channel, derived from `agreedTime` (T-1h…T+2h) for every
   scheduled pair.
3. **Verification is mandatory and track-aware** (university-email OTP or
   trusted-contact phone): never waive the gate or let one track bypass the
   other's rail. A liveness check not clearly passed is *retryable*, never
   `rejected`.
4. **Demo mode owes an answer.** Every change to a product flow, Mini App
   screen, gate or paid step states its demo-mode behaviour; if not obvious,
   **ask** (`docs/product/demo-mode.md`).
5. **Ask first** before changing user flow or product rules, adding an
   external API or dependency, changing the Prisma schema / vector indexes /
   anything destructive to the DB, or touching prod secrets or irreversible
   deploy steps.
6. **No secrets in the repo** — no `.env`, keys, tokens or raw logs with user
   data, in code or `docs/`.
7. **Respect dirty working trees.** Never revert unrelated user changes.
8. Strict TypeScript (no `any` without cause); user-facing strings live in
   shared i18n; limits/timings/thresholds live in shared constants.
9. **State names come from code.** `packages/db/prisma/schema.prisma` owns
   stored `MatchStatus` values and column types; ticket payment is a string
   substate; `packages/shared/src/date-lifecycle.ts` defines derived date-view
   states. Never invent stored states from business labels.
10. **Date cancellation** is available from booking until `agreedTime`; T-5h
    sends a reminder rather than opening a gate. (Contact window: rule 2.)
11. **Spec format.** New agent-written specs: declarative prose, numbered
    phases, indented lists — no markdown tables.

## Git journal workflow

Solo repo, no reviewers; CI (`.github/workflows/ci.yml`) runs on pushes to
`main`, gates nothing — red means look. Trunk = `main`; a short branch only in
your own worktree when sessions run in parallel, merged right away. Commit and
push after **every** change (`git add -A`, scoped `git commit`,
`git push origin HEAD`) — pre-authorised; only a turn that changed no file
skips it. Roll back with `git revert`. Details:
`docs/operations/agent-operating-manual.md` → "Post-Implementation Git Workflow".

## Documentation routing — read on demand, never up front

Paths are under `docs/`. Every file opens with a `WHEN_TO_READ` line — trust
it. Full tree: `README.md`.

- **Starting any task** → grep `architecture/decisions/INDEX.md` for your topic
  (decisions that exist nowhere in code). **Recording a decision** (product
  call in chat, change of mind, deviation, deliberate non-work) is mandatory:
  append to the newest file in `architecture/decisions/` (a new dated file once
it passes 1 MB) + a row in `INDEX.md`,
  or the next session rebuilds what we rejected.
- Product behaviour → `product/product-spec.md` (Core Principles), then one
  file in `product/domains/`: `onboarding.md` (profiler) · `main-menu.md` (bot
  menu, mobile API) · `matching-engine.md` (scoring, pitch, ticket gate) ·
  `scheduling-and-monetization.md` (venue, Premium, referral, promo, rematch) ·
  `date-lifecycle.md` (the date, feedback, emergency) · `trust-and-safety.md`
  (reports, strikes, blocking) · `living-canvas.md` (Date Bump / Terminal,
  Radar, date map) · `cross-cutting.md` (quiet hours, GDPR, languages, loading
  marks) · `<feature>.md` (events, voice, type radar, ads…)
- Copy → `product/voice-and-tone.md`; demo bot → `product/demo-mode.md`
- `architecture/`: `overview.md` (shape, endpoints, topology) · `data-model.md`
  (any table, enum, column) · `api-surface.md` (new route, cron, worker) ·
  `integrations.md` (providers, proxies, rate limits) · `ownership.md`
  (venue-intent / market / purchase ownership)
- **Deploy or rollback** → `operations/deployment-runbook.md` (canonical — do
  not ask for hostnames/paths/service names); hosts, paths, PM2, env +
  credential locations → `operations/environments.md`; "is X deployed?" →
  `operations/deploy-journal/INDEX.md` (backlog `pending.md`); testing a
  release → `operations/runbooks/`
- Full agent workflow → `operations/agent-operating-manual.md`; superseded →
  `archive/`

## Old document names in source comments

Code and `.env.example` cite pre-2026-09-01 names (root stubs redirect too):
`PRODUCT_SPEC.md §X`, `*_PRODUCT_SPEC.md`, `AD_SPEND_TRACKING_DESIGN.md` →
`product/` (`domains/`) · `DEMO_MODE.md` → `product/demo-mode.md` · `VOICE.md`
→ `product/voice-and-tone.md` · `ARCHITECTURE.md` → `architecture/` ·
`DECISIONS.md` → `architecture/decisions/` · `deploy.md` → `operations/` ·
`PROD_TEST_PLAN.md` → `operations/runbooks/` · `AGENTS.md` → this file (rules)
+ `operations/agent-operating-manual.md` (procedure).

## Context discipline

- **Never read a `docs/` file whole "to see what's in it"**: `WHEN_TO_READ`,
  then grep, then the matching section. Journals: find one entry via
  `decisions/INDEX.md` / `deploy-journal/INDEX.md`.
- Read in slices of ≤300 lines; prefer `grep -n` to opening a large file.
- Never paste deploy logs, `pm2 logs`, SQL dumps or full test output into a
  doc — link the command that reproduces it.
- Complex behaviour change: plan first, confirm before editing (Claude Code:
  Plan Mode; others: state the plan, wait).
