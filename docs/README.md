<!-- WHEN_TO_READ: You know you need a document but not which one, and the routing table in the root AGENTS.md did not settle it. This is the full map. -->

# Documentation map

Nothing here loads automatically. `AGENTS.md` at the repo root is the only
always-loaded file; it routes here. There is deliberately no `CLAUDE.md` —
`AGENTS.md` is the cross-tool standard and the single source of truth. Every document below starts with a
`<!-- WHEN_TO_READ: … -->` line stating exactly when it is worth opening.

```
docs/
├── architecture/
│   ├── overview.md            System shape: endpoints, topology, E2E schema, process layout. START HERE.
│   ├── data-model.md          Every Prisma table, enum, column. Grep it; don't read it.
│   ├── api-surface.md         Cron & workers, public /v1/*, admin /admin/*.
│   ├── integrations.md        External providers, CORP image proxies, rate limits, storage buckets.
│   ├── ownership.md           Venue Intent V2 / launched-market / purchase ownership.
│   └── decisions/             The decision & deviation journal — 238 entries.
│       ├── INDEX.md           ★ FIRST STOP: every entry title. Grep, then open one dated file.
│       ├── README.md          The protocol: when to write, entry format.
│       ├── 2026-08-27_2026-09-01.md   23 entries (newest)
│       ├── 2026-08-23_2026-08-26.md   42 entries
│       ├── 2026-08-20_2026-08-22.md   44 entries
│       ├── 2026-08-13_2026-08-19.md   36 entries
│       └── 2026-08-07_2026-08-12.md   93 entries (journal starts 2026-08-07)
├── product/
│   ├── product-spec.md        Project overview + Core Principles (Strict Rules). Read before any flow change.
│   ├── demo-mode.md           The isolated demo bot + the impact check every change owes it.
│   ├── voice-and-tone.md      How the bot talks. Read before writing any user-facing copy.
│   └── domains/
│       ├── onboarding.md                    Phase 1 + 1b: consent, capture, voice prompt, verification, profiler
│       ├── main-menu.md                     Phase 2: bot menu, mobile API
│       ├── matching-engine.md               Phase 3.1–3.5c: cadence, scoring, pitch, blind decision, ticket gate
│       ├── scheduling-and-monetization.md   Phase 3.6–3.11: calendar, venue, date card, Premium, referral, promo, rematch
│       ├── date-lifecycle.md                Phase 4: safety brief, did-you-meet, feedback, emergency
│       ├── trust-and-safety.md              Phase 5: reports, strikes, blocking
│       ├── living-canvas.md                 Phase 6: Date Bump, Date Radar, Scratch Map, Campus Radar
│       ├── cross-cutting.md                 Quiet hours, standby, embeddings, GDPR, languages, loading marks
│       ├── venue-intent-v2.md               Venue intent selection (2026-07-21)
│       ├── daily-matching.md                ACTIVE migration — prod still on `weekly`; see §3.1 for remaining work
│       ├── venue-engine-plan.md             Venue ranking improvements; Stage 5 + Part 6 still open
│       └── launch-events.md · voice-prompts.md · type-radar.md · rematch.md · prime-time.md
│           promo-codes.md · referral.md · venue-change.md · ad-spend-tracking.md
├── operations/
│   ├── deployment-runbook.md  ★ CANONICAL deploy/rollback/DB-ops/logs/Caddy procedure.
│   ├── environments.md        Droplet, paths, PM2, Caddy, env + credential locations, endpoints, dev↔prod isolation.
│   ├── agent-operating-manual.md  Full coding-agent workflow (was AGENTS.md).
│   ├── hermes-agent-prompt.md     System prompt for the Hermes analytics agent.
│   ├── deploy-journal/
│   │   ├── INDEX.md           ★ FIRST STOP: all 161 deploy entries, status + date.
│   │   └── pending.md         The ACTIVE backlog — blocks marked `**PENDING` have NOT shipped.
│   └── runbooks/
│       ├── prod-test-plan.md · e2e-test-plan.md · venue-catalog-audit.md
└── archive/                   Historical / superseded. Reach for it only when the index sends you.
    ├── deploy-journal/shipped-part1..3.md   121 already-shipped deploy entries
    ├── daily-matching-migration-audit.md    Pre-change audit, superseded by domains/daily-matching.md
    ├── hermes-match-conversion-addendum.md  Merged into operations/hermes-agent-prompt.md
    └── ios-app-roadmap-snapshot.md          2026-07-18 snapshot; live copy is in the iOS repo
```

## Conventions

- **`WHEN_TO_READ` is a contract.** If a file's condition does not describe your
  task, do not open it.
- **Indexes before journals.** `decisions/INDEX.md` and
  `deploy-journal/INDEX.md` are built so you load one entry, not a whole file.
- **Root `*.md` files are redirect stubs**, kept only because source comments
  and `.env.example` still reference the old filenames. They contain no content.
- **New decisions** go in `architecture/decisions/` (newest dated file) plus a
  row in its `INDEX.md`. **New deploys** go in
  `operations/deploy-journal/pending.md`.
