# Telegram Stars Monetization — Port from Beta to Prod

> Status: **IN PROGRESS (2026-07-07).** Real Telegram Stars (XTR) replace the
> mock USD/Stripe stub as the production payment rail. This is a reverse port
> (beta → prod): Stars were authored in the beta clone and are live there; prod
> diverged in the ticket zone (student_bonus, goodwill-cover read-receipt), so
> the Stars pieces are hand-ported with divergence reconciliation, not
> cherry-picked.

## Founder decisions (2026-07-07)
- **Star price per ticket = 350⭐** (`TICKET_BUNDLE_STARS` default `1:350,3:830,6:1350`).
  Gate: self=350, both=700, partner=350. Store bundles: 1→350 / 3→830 (~277 ea) /
  6→1350 (~225 ea). ~$5–7/ticket at typical Star retail. Env-overridable.
- **Mock stays as the `TICKET_STARS_ENABLED=false` fallback** (beta parity):
  Stars is the primary rail when the flag is on; the mock USD path survives only
  when it's off. PAY-1 guard closes the mock bypass while Stars is on.
- Both surfaces ported: **store top-up** (My Tickets → native in-chat ⭐ invoices)
  AND **date-gate direct pay** (`WebApp.openInvoice` at the ticket gate).

## Trust model (from beta, unchanged)
- `pre_checkout_query` — re-validate payload + Star amount, approve within 10s.
- `message:successful_payment` — the ONLY trust boundary that credits/settles.
- Store top-up: exactly-once via the new unique `TicketLedger.externalPaymentId`
  (`telegram_payment_charge_id`); a redelivered `successful_payment` → P2002 →
  idempotent no-op.
- Date gate: settled by the existing atomic slot CAS, so a redelivered payment
  is already a no-op — no charge-id column needed there.

## Phases
- **A — shared + config + schema.** `stars.ts` payload helpers (verbatim);
  `TICKET_STARS_ENABLED` + `TICKET_BUNDLE_STARS` + `parseStarBundles` in config;
  additive `TicketLedger.externalPaymentId String? @unique` → `db:push`.
- **B — bot payment rail.** `handlers/payments.ts` (pre_checkout + successful_payment,
  store + gate), registered at the top of the router. `ticket-wallet.grantTickets`
  gains `externalPaymentId` + `isUniqueViolation` export (reconcile with prod's
  student_bonus). `ticket-payment.gateStarsForScope` + Stars branch. `ticket-gate.
  applyStarsTicketPayment` — settle a gate slot via Stars, integrated with prod's
  goodwill-cover read-receipt loop.
- **C — API routes.** Gate `POST /stars-invoice` (`createInvoiceLink`) + `state.starsEnabled`
  + per-scope stars; store `sendInvoice` (menu) / invoice link. PAY-1: mock
  `intent`/`confirm` 404 when Stars on (both gate + store). `/use` untouched.
- **D — webapp.** `openInvoice` in `ticket/App.tsx` + `tickets/App.tsx`, `telegram.d.ts`
  typing, `api.ts` stars-invoice fetch.
- **E — i18n + tests + docs.** Star copy (5 langs), payments handler + stars payload
  tests, PRODUCT_SPEC §3.5b / ARCHITECTURE / deploy.md flag entry.
- **F — dev verify.** `db:push` dev DB, restart bot, live Stars test purchase on
  `@gennetytestbot` (Telegram Stars test flow), then resume the reg-v2 E2E.

## Rollout
Deploy code + `db:push` (additive `external_payment_id`) with `TICKET_STARS_ENABLED`
off → zero behavior change. Flip `TICKET_STARS_ENABLED=true` + set
`TICKET_BUNDLE_STARS` → Stars live. Rollback = flag off (mock returns).
Telegram Stars needs NO merchant account / provider token (empty provider token,
`currency: "XTR"`); withdrawal to TON is a Telegram-side setting.
