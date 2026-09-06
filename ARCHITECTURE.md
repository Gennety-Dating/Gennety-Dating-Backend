# ARCHITECTURE.md — moved

The architecture document (2,343 lines, ~58k tokens) was being loaded into every
session through an `@ARCHITECTURE.md` import in the root instruction file. It
is now split.
This stub stays because source comments reference "ARCHITECTURE.md →" by name.

| Old reference | Read |
|---|---|
| Production endpoints, topology, end-to-end schema, process layout | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Any table / enum / column (`users`, `matches`, `events`, ledgers, `curated_venues`, …) | [docs/architecture/data-model.md](docs/architecture/data-model.md) |
| Cron & workers, `/v1/*`, `/admin/*` | [docs/architecture/api-surface.md](docs/architecture/api-surface.md) |
| Image proxies (CORP), rate limiting, storage buckets, external dependencies | [docs/architecture/integrations.md](docs/architecture/integrations.md) |
| Venue Intent V2 / launched-market / purchase ownership | [docs/architecture/ownership.md](docs/architecture/ownership.md) |

**Start with** `docs/architecture/overview.md`.
