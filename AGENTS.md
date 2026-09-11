# Gennety Dating — Project Operating Guide

Telegram-first AI matchmaking: the bot runs onboarding, matches a pair blind,
negotiates a real venue, and hands the date off to a Mini App (plus a native
iOS client on the same `/v1/*` API).

**This is the single entry point for every coding agent** — the cross-tool
`AGENTS.md` standard, deliberately not duplicated as `CLAUDE.md`. It is the only
always-loaded document; everything else is read on demand from `docs/`.

> **Do not create a `CLAUDE.md`.** Claude Code discovers `AGENTS.md` natively, and
> a second root instruction file is exactly the drift this layout removes. If a
> tool ever needs the Claude-specific name, make it a one-line `@AGENTS.md`
> pointer — never a copy. Same rule for `@imports`: do not add any here. Six of
> them are what pulled 923k tokens into every session before 2026-09-01.

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

```
apps/bot/       grammY bot, Express public + admin APIs, cron workers
apps/webapp/    Vite Telegram Mini App
apps/video/     Remotion Studio (not part of the production runtime)
packages/db/    Prisma schema + client            packages/shared/  i18n, types, prompts, constants
scripts/        local + deploy helpers            openapi/          /v1 contract for the iOS repo
docs/           ALL project documentation (see routing below)
```

## Non-negotiable rules

1. **Blind decision invariant** — a user never learns the partner's decision
   before making their own.
2. **No user-to-user in-app chat.** Proxy chat only, within its derived window.
3. **Verification is mandatory and track-aware** (university-email OTP or
   trusted-contact phone). Never waive the gate or let one track bypass the
   other's rail. A liveness check that does not clearly pass is *retryable*,
   never `rejected`.
4. **Demo mode owes an answer.** Any change to a product flow, Mini App screen,
   gate, or paid step must state its demo-mode behaviour. If it isn't obvious,
   **ask** — see `docs/product/demo-mode.md`.
5. **Ask first** before changing user flow or product rules, adding an external
   API or dependency, changing the Prisma schema / vector indexes / anything
   destructive to the DB, or touching production secrets or irreversible deploy
   steps.
6. **Secrets never land in the repo.** No `.env`, keys, tokens, or raw logs
   containing user data — not in code, not in `docs/`.
7. **Respect dirty working trees.** Never revert unrelated user changes.
8. Strict TypeScript (no `any` without cause); user-facing strings live in
   shared i18n; limits/timings/thresholds live in shared constants.

## Git journal workflow (single-branch)

Solo repo, no CI, no reviewers. Work on `main`; commit and push after **every**
change, however small — `git add -A`, scoped `git commit`, `git push origin HEAD`.
This is pre-authorised: do not ask. Only a turn that changed no file skips it.
Never create branches; roll back with `git revert`. Full mechanics:
`docs/operations/agent-operating-manual.md` → "Post-Implementation Git Workflow".

## Documentation routing — read on demand, never up front

Every file under `docs/` opens with a `<!-- WHEN_TO_READ: … -->` line. Trust it.

| When you are… | Read |
|---|---|
| **Starting any task** | `docs/architecture/decisions/INDEX.md` — grep it for your topic. It holds decisions that exist nowhere in the code. |
| Changing product behaviour | `docs/product/product-spec.md` (Core Principles) → then the one file in `docs/product/domains/` |
| Onboarding / profiler | `docs/product/domains/onboarding.md` |
| Bot menu / mobile API | `docs/product/domains/main-menu.md` |
| Matching, scoring, pitch, ticket gate | `docs/product/domains/matching-engine.md` |
| Scheduling, venue, Premium, referral, promo, rematch | `docs/product/domains/scheduling-and-monetization.md` |
| The date itself, feedback, emergency | `docs/product/domains/date-lifecycle.md` |
| Reports, strikes, blocking | `docs/product/domains/trust-and-safety.md` |
| Living Canvas, Date Bump / Date Terminal, Radar, Scratch Map | `docs/product/domains/living-canvas.md` |
| Quiet hours, GDPR, languages, loading marks | `docs/product/domains/cross-cutting.md` |
| A single feature (events, voice, type radar, ads…) | `docs/product/domains/<feature>.md` |
| Writing any user-facing copy | `docs/product/voice-and-tone.md` |
| Anything touching the demo bot | `docs/product/demo-mode.md` |
| System shape, endpoints, topology | `docs/architecture/overview.md` |
| Any table, enum, or column | `docs/architecture/data-model.md` |
| Adding a route, cron, or worker | `docs/architecture/api-surface.md` |
| External providers, proxies, rate limits | `docs/architecture/integrations.md` |
| Venue-intent / market / purchase ownership | `docs/architecture/ownership.md` |
| **Deploying or rolling back** | `docs/operations/deployment-runbook.md` (canonical — do not ask for hostnames/paths/service names) |
| Hosts, paths, PM2, env + credential locations | `docs/operations/environments.md` |
| "Is X deployed yet?" | `docs/operations/deploy-journal/INDEX.md`, backlog in `pending.md` |
| Testing a release | `docs/operations/runbooks/` |
| The full agent workflow (this file is the short version) | `docs/operations/agent-operating-manual.md` |
| Something historical/superseded | `docs/archive/` |

Full tree with descriptions: `docs/README.md`.

**Recording a decision** (product call in chat, change of mind, deviation,
deliberate non-work): append to the newest file in
`docs/architecture/decisions/` and add a row to its `INDEX.md`. Mandatory —
this is the rule that keeps the next session from rebuilding what we rejected.

## Stale references in source comments

Source comments and `.env.example` still name the pre-2026-09-01 documents.
Resolve them here (the root stubs also redirect):

`deploy.md` → `docs/operations/` · `PRODUCT_SPEC.md §X` → `docs/product/` ·
`ARCHITECTURE.md` → `docs/architecture/` · `DECISIONS.md` →
`docs/architecture/decisions/` · `DEMO_MODE.md` → `docs/product/demo-mode.md` ·
`AGENTS.md` → this file for the rules, `docs/operations/agent-operating-manual.md`
for the full procedure ·
`*_PRODUCT_SPEC.md` / `AD_SPEND_TRACKING_DESIGN.md` → `docs/product/domains/` ·
`VOICE.md` → `docs/product/voice-and-tone.md` ·
`PROD_TEST_PLAN.md` / `E2E_TEST_PLAN.md` → `docs/operations/runbooks/`.

## Context discipline

- **Never read a `docs/` file whole "to see what's in it."** Use the
  `WHEN_TO_READ` line, then grep, then read the matching section.
- The two index files (`decisions/INDEX.md`, `deploy-journal/INDEX.md`) exist so
  you can find one entry instead of loading a journal. Use them first.
- Read in slices of ≤300 lines; prefer `grep -n` over opening a large file.
- Never paste deploy logs, `pm2 logs`, SQL dumps, or full test output into a
  document — link to the command that reproduces it.
- Plan first for complex behaviour changes; confirm the plan before editing.
  (Claude Code: Plan Mode. Other tools: say the plan, then wait.)
