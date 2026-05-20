> **Product logic and user flow** are in [PRODUCT_SPEC.md](PRODUCT_SPEC.md).  
> **Database schema and system architecture** are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Architecture & Tech Stack (Preferred)
- **Bot**: Node.js 20+ + TypeScript + **grammY v2+** (Telegraf v4+ allowed only as fallback)
- **Mini App**: React 18+ + TypeScript + Vite + `@twa-dev/sdk`
- **Future Mobile**: React Native + Expo (shared packages must remain compatible)
- **Database**: PostgreSQL + pgvector + **Prisma** (with Prisma Accelerate / pgvector extension)
- **AI**: OpenAI / Anthropic (streaming)
- **Shared**: TypeScript packages (`packages/shared`)
- **i18n**: i18next + react-i18next
- **Monorepo**: pnpm workspaces

**Always** refer to the official documentation:  
https://core.telegram.org/bots/api (Bot API 9.6)  
https://core.telegram.org/bots/webapps

## Setup & Commands
- Install: `pnpm install`
- Dev bot: `pnpm --filter bot dev`
- Dev webapp: `pnpm --filter webapp dev`
- Build all: `pnpm build`
- Lint + fix: `pnpm lint --filter bot --filter webapp --fix`
- Type check (file-scoped): `pnpm tsc --noEmit --project apps/bot/tsconfig.json path/to/file.ts`
- Test (file-scoped): `pnpm vitest run path/to/file.test.ts`
- DB migrations: `pnpm --filter db db:push` or `pnpm prisma migrate dev`

All commands must be file-scoped and fast.

## Local Development (dev bot on your machine)

Prod and local must never share a bot token — Telegram long polling delivers
each update to exactly one consumer, so they'd steal each other's messages.

One-time setup:
1. Create a separate bot in [@BotFather](https://t.me/BotFather) → `/newbot`.
2. `cp .env.local.example .env.local` and fill in the dev `BOT_TOKEN`.
3. `pnpm dev:db:up` — start local Postgres + pgvector (port 5434).
4. `pnpm dev:db:push` — apply Prisma schema to the dev DB.

Daily loop:
- `pnpm dev:bot` — runs the dev bot via `tsx watch` (hot reload).
- `pnpm dev:db:studio` — open Prisma Studio against the dev DB.
- `pnpm dev:db:reset` — wipe & recreate dev DB (destroys volume).
- `pnpm dev:db:down` — stop dev DB (keeps data).

Env loading order (see `apps/bot/src/config.ts`):
`.env.local` → `.env` (dotenv `override: false`, so `.env.local` wins).
Delete `.env.local` to run locally against prod config.

Caveats:
- All cron jobs in `apps/bot/src/index.ts` also fire locally. The dev DB has
  no users, so they're no-ops, but don't be surprised by their logs.
- Mini App local dev needs an HTTPS tunnel (e.g. `cloudflared tunnel --url
  http://localhost:5173`), then set `WEBAPP_URL` in `.env.local` and register
  it for the dev bot via BotFather → Configure Mini App.

## Project Structure
```
/
├── apps/
│   ├── bot/          # grammY + FSM + handlers (TypeScript)
│   ├── webapp/       # React + Vite + Telegram Mini App (Calendar)
│   └── mobile/       # future: React Native + Expo
├── packages/
│   ├── shared/       # types, utils, i18n, constants, AI prompts
│   └── db/           # Prisma schema + client
├── prisma/           # schema.prisma
├── .env.example
├── AGENTS.md
├── PRODUCT_SPEC.md
├── ARCHITECTURE.md
└── turbo.json        # (optional, if you switch to Turbo)
```

## Code Style & Conventions
### Do
- TypeScript `strict: true` + `exactOptionalPropertyTypes`
- Named exports, functional style
- grammY: middleware, Composer, session (when needed)
- React Mini App: functional components + hooks, full TypeScript + Vite
- Absolute imports (`@gennety/shared`, `@gennety/bot`)
- All Telegram Bot API 9.5+ features (`sendMessageDraft` with unique draft_id)
- Small diffs and file-scoped changes

### Don't
- Never use `any`, class components, or legacy Telegraf middleware unless absolutely necessary
- Never create chat interfaces
- Never hardcode strings, styles, or time — use shared constants and `date_time` entity
- Never add new dependencies without approval

## Testing Requirements
- Test-first: new code -> test -> implementation
- Vitest + @grammyjs/testing (bot) + React Testing Library (webapp)
- Before any PR: 100% green lint + type check + tests
- Mock Telegram Bot API and DeviceStorage

## Git & PR Workflow
- Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`
- PR title: `[sprint-X] Short description`
- Before push/PR: `pnpm lint && pnpm test && pnpm build`
- Never commit `.env`, secrets, or `node_modules`

## Post-Implementation Git Workflow

After meaningful implementation of a new feature, bugfix, UX/API/schema/deploy
change, preserve rollbackable history by completing the Git handoff before
finishing:

1. Run the relevant tests, typecheck, or build for the change. Use narrow
   verification while iterating and broaden when risk justifies it.
2. Complete the Documentation Impact Check above, and update Obsidian when the
   change warrants a session, changelog, or ADR note.
3. Check `git status` and `git diff` before staging.
4. Stage only changes that belong to the current task. Never stage `.env`,
   secrets, raw logs, build artifacts, `node_modules`, or unrelated dirty
   changes from the user.
5. Commit with a clear, scoped message.
6. Push to the current upstream branch. If no upstream is configured, use
   `git push -u origin HEAD`.

Do not create an automatic commit or push after pure analysis, review,
planning, or an answer that made no implementation changes. If relevant tests,
typecheck, or build fail, stop before committing unless the user explicitly
asks to preserve the failing state. If the worktree contains unrelated user
changes, leave them untouched and tell the user what was left out. If push is
blocked by authorization, a protected branch, missing remote/upstream, or a
conflict/non-fast-forward, stop and report the exact cause.

## Boundaries & Safety
**Always**
- Follow the user flow defined in PRODUCT_SPEC.md
- Use `sendMessageDraft` + `icon_custom_emoji_id` + `date_time` entity
- Validate corporate university email

**Ask first**
- Any change to User Flow
- New external APIs or dependencies
- Changes to Prisma schema or vector index
- Switching to Turbo / Nx

**Never**
- Create in-app chat
- Skip onboarding steps
- Hardcode sensitive data
- Make breaking changes in shared packages

## Good / Bad Examples
- Good: `apps/bot/handlers/onboarding/photo-upload.ts` + streaming `sendMessageDraft`
- Good: `apps/webapp/src/components/Calendar.tsx` with DeviceStorage
- Bad: any `fetch` instead of grammY, class components in React, missing `date_time` entity

## When stuck
1. Ask a clarifying question.
2. Propose a short plan (max 3 steps).
3. Open a draft PR with comments.
4. For Telegram API questions — always link to https://core.telegram.org/bots/api

## gstack

### Web Browsing

Always use the `/browse` skill from gstack for all web browsing tasks. Never use `mcp__claude-in-chrome__*` tools.

### Available Skills

- `/plan-ceo-review` — CEO/founder-mode plan review: rethink the problem, challenge premises, find the 10-star product
- `/plan-eng-review` — Eng manager-mode plan review: lock in architecture, data flow, edge cases, test coverage
- `/review` — Pre-landing PR review: analyzes diff for SQL safety, trust boundary violations, side effects
- `/ship` — Ship workflow: merge base, run tests, review diff, bump version, update changelog, commit, push, create PR
- `/browse` — Fast headless browser for QA testing and site dogfooding: navigate, interact, verify, diff
- `/qa` — Systematically QA test a web app and fix bugs found
- `/setup-browser-cookies` — Import cookies from your real browser into the headless browse session
- `/retro` — Weekly engineering retrospective: commit history, work patterns, code quality metrics

### Troubleshooting

If gstack skills aren't working, rebuild by running:

```sh
cd .claude/skills/gstack && ./setup
```

This builds the browse binary and re-registers all skills.
