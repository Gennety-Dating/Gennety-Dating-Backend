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

## Git Journal Workflow (single-branch, commit after every change)

This repo is a **solo, single-branch journal**: no CI/CD, no reviewers, no
feature branches. Work directly on `main`; `main` is the only branch and the
GitHub remote is used as a transparent, rollback-able log of every step.

**Standing rule — commit and push after every change, no matter how small.**
After any turn that edits, adds, or deletes files in this repo (even a one-line
tweak), before you end your turn you MUST:

1. `git add -A` the changes that belong to the work just done.
2. `git commit` with a clear, scoped message (this is durable, pre-authorized —
   you do **not** need to ask first).
3. `git push origin HEAD` (i.e. to `origin/main`).

This keeps the working tree from accumulating mixed, hard-to-attribute changes
and keeps the GitHub history a faithful sequence of what actually happened.
Details and exact mechanics: see AGENTS.md → "Post-Implementation Git Workflow".

- Never create branches; never push to any remote other than this repo's
  `origin`. Roll back with `git revert` (or `git reset` for unpushed work).
- The only turn that does NOT commit is one that changed no files (pure
  analysis, a question, or a read-only answer) — there is nothing to record.
- Standard safety still holds: never stage `.env`, secrets, `node_modules`,
  build artifacts, or large local tooling (`.claude/`, `.agents/`, `.gstack/`
  are gitignored). If a relevant test/typecheck/build fails, say so in the
  commit/PR notes, but the user has opted to keep the journal current — commit
  the state rather than leaving it uncommitted, unless told otherwise.
