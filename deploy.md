# deploy.md — moved

This file was 13,248 lines (~187k tokens) and was being pulled into every Claude
Code session through a `@deploy.md` import in the root instruction file. It is
now split. This
stub stays because ~10 source comments, `scripts/deploy-webapp.sh`,
`scripts/deploy-demo.sh`, `scripts/check-schema-drift.mjs` and `.env.example`
still point at "deploy.md" by name.

| You want | Read |
|---|---|
| Deploy / rollback / DB ops / logs / Caddy | [docs/operations/deployment-runbook.md](docs/operations/deployment-runbook.md) |
| Droplet, paths, PM2, Caddy, env + credential locations, endpoints, dev↔prod isolation | [docs/operations/environments.md](docs/operations/environments.md) |
| What is queued but NOT yet deployed (the PENDING backlog) | [docs/operations/deploy-journal/pending.md](docs/operations/deploy-journal/pending.md) |
| "Has X shipped? how was it verified?" — index of all 161 entries | [docs/operations/deploy-journal/INDEX.md](docs/operations/deploy-journal/INDEX.md) |
| Verification/rollback of an already-shipped deploy | [docs/archive/deploy-journal/](docs/archive/deploy-journal/) |

**Deploying?** `docs/operations/deployment-runbook.md` is canonical.
