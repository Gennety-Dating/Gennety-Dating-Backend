# PRODUCT_SPEC.md — moved

The product specification (7,682 lines, ~131k tokens) was being loaded into
every session through a `@PRODUCT_SPEC.md` import in the root instruction
file. It is now
split by phase. This stub stays because source comments reference
"PRODUCT_SPEC.md §…" by name.

| Old reference | Read |
|---|---|
| Project Overview, Core Principles (Strict Rules) | [docs/product/product-spec.md](docs/product/product-spec.md) |
| §Phase 1, §1.x, §Phase 1b Profiler | [docs/product/domains/onboarding.md](docs/product/domains/onboarding.md) |
| §Phase 2, §2.x | [docs/product/domains/main-menu.md](docs/product/domains/main-menu.md) |
| §3.1 – §3.5c (cadence, scoring, pitch, decision, nudges, ticket gate) | [docs/product/domains/matching-engine.md](docs/product/domains/matching-engine.md) |
| §3.6 – §3.11 (scheduling, venue, date card, Premium, referral, promo, rematch) | [docs/product/domains/scheduling-and-monetization.md](docs/product/domains/scheduling-and-monetization.md) |
| §Phase 4 (date lifecycle, feedback, emergency) | [docs/product/domains/date-lifecycle.md](docs/product/domains/date-lifecycle.md) |
| §Phase 5 (reports, strikes, blocking) | [docs/product/domains/trust-and-safety.md](docs/product/domains/trust-and-safety.md) |
| §Phase 6 (Living Canvas, Date Bump, Radar, Scratch Map) | [docs/product/domains/living-canvas.md](docs/product/domains/living-canvas.md) |
| §Cross-Cutting (quiet hours, GDPR, languages, marks) | [docs/product/domains/cross-cutting.md](docs/product/domains/cross-cutting.md) |
| §Venue Intent V2 | [docs/product/domains/venue-intent-v2.md](docs/product/domains/venue-intent-v2.md) |

**Always start with** `docs/product/product-spec.md` — it holds the Core
Principles every flow must obey.
