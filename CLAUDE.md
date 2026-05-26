## Claude Code Entry Point

Claude Code should load and follow these root documents:

@AGENTS.md
@PRODUCT_SPEC.md
@ARCHITECTURE.md
@deploy.md

Document roles:

- **AGENTS.md** — operating manual for coding agents: workflows, guardrails,
  commands, review standards, documentation impact checks.
- **PRODUCT_SPEC.md** — product invariants and major user flows.
- **ARCHITECTURE.md** — durable architecture boundaries, topology, data
  ownership, API surface, background jobs, external integrations.
- **deploy.md** — production runbook for DigitalOcean, PM2, Caddy, env,
  validation, rollback.

Claude-specific rule: for complex behavior changes, start in Plan Mode with a
short plan and wait for confirmation before editing. For deploy requests,
`deploy.md` is canonical; do not ask for documented hostnames, paths, service
names, or credential locations unless access is blocked or data is missing.
