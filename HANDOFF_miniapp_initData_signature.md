# HANDOFF — Mini App `initData` 401 (`signature` field breaks HMAC)

> Written 2026-06-18 during dev E2E testing on `@gennetytestbot`.
> Surfaced via the venue-change ("Сменить место свидания") screen, but the bug is
> in the shared Telegram `initData` validator, so it affects **all** `tma`-authed
> Mini App endpoints.

## TL;DR (root cause is CONFIRMED, fix is one line)

`validateInitData` in [`apps/bot/src/public/init-data.ts`](apps/bot/src/public/init-data.ts)
builds the HMAC data-check-string from **all fields except `hash`**. It does **not**
remove the `signature` field. Telegram (Bot API 8.0+, the test phone is on **9.6**)
adds `signature` to `initData` and computes its `hash` **excluding both `hash` AND
`signature`**. Including `signature` in our check string makes the HMAC mismatch →
`reason: "bad-hash"` → HTTP **401** → the Mini App shows its generic
`errGeneric` ("Не удалось отправить запрос. Попробуйте снова.").

### The fix
In `validateInitData`, delete `signature` alongside `hash` before building the
data-check-string (lines ~53-55):

```ts
const hash = params.get("hash");
if (!hash) return { valid: false, reason: "missing-hash" };
params.delete("hash");
params.delete("signature"); // Bot API 8.0+: Telegram excludes `signature` from the HMAC check string
```

This matches Telegram's documented algorithm and every maintained validator
(`@telegram-apps/init-data-node`, `@grammyjs/validator`) which strip both `hash`
and `signature`. `signature` is only for the alternative Ed25519 (public-key)
verification, never part of the bot-token HMAC.

### Add a regression test
There is existing coverage near the validator (search for `validateInitData` tests).
Add a case: build `initData` with a `signature` field whose `hash` is computed over
the fields **excluding** `signature` and `hash`, assert `valid === true`. It fails
before the fix (`bad-hash`), passes after. (See the repro in "Evidence" below.)

## Symptom
Female participant on a **scheduled** date card taps "Change venue" → the
venue-change Mini App opens fine (HTML + JS load 200), then immediately shows the
yellow ⚠️ "Не удалось отправить запрос. Попробуйте снова." The error is the
client catch in [`apps/webapp/src/venue-change.ts`](apps/webapp/src/venue-change.ts)
`main()` (~line 535-537): `fetchVenueChangeState` throws on the 401.

## Evidence chain (all verified this session)
1. **Server logic is healthy.** Calling the handler directly against the dev DB:
   - `getVenueChangeState(5986970093n, '1833db55-…')` → `ok:true, eligible:true` (female).
   - `getVenueChangeState(782065541n, …)` → `ok:true, eligible:false, not-female-initiator` (male, correct).
   - `getVenueChangeCatalog(female)` → `ok, venues=12`.
   So it's NOT a 500 / not eligibility / not the DB.
2. **initData on the phone is valid and present.** A temp client beacon (see
   "Temp diagnostics" below) logged `[vc-debug] CLIENT-DIAG`:
   `{"tg":"object","app":true,"ver":"9.6","idlen":587,"unsafeKeys":["query_id","user","auth_date","signature","hash"],"ua":"…iPhone OS 18_7…"}`
   → `app.initData` is 587 chars and contains a `signature` field. NOT empty.
3. **The validator rejects signature-bearing initData.** Deterministic test against
   the real `validateInitData` (hash computed the Telegram way, excluding
   `signature`+`hash`):
   - `withSignature=false → valid=true`
   - `withSignature=true  → valid=false reason=bad-hash`
   This is the bug.

### Reproduce the validator bug (no phone needed)
```bash
cd "/Users/pro/Desktop/Gennety Dating"
cat > /tmp/t.mjs <<'EOF'
import "/Users/pro/Desktop/Gennety Dating/apps/bot/src/config.ts";
import { createHmac } from "node:crypto";
const { validateInitData } = await import("/Users/pro/Desktop/Gennety Dating/apps/bot/src/public/init-data.ts");
import { env } from "/Users/pro/Desktop/Gennety Dating/apps/bot/src/config.ts";
function build(uid, withSig){
  const f={auth_date:String(Math.floor(Date.now()/1000)),query_id:"AAA",user:JSON.stringify({id:uid,first_name:"P"})};
  const dcs=Object.keys(f).sort().map(k=>`${k}=${f[k]}`).join("\n");
  const sec=createHmac("sha256","WebAppData").update(env.BOT_TOKEN).digest();
  const hash=createHmac("sha256",sec).update(dcs).digest("hex");
  const u=new URLSearchParams(f); if(withSig)u.append("signature","fake"); u.append("hash",hash); return u.toString();
}
for(const s of [false,true]) console.log("withSignature="+s, validateInitData(build(1,s), env.BOT_TOKEN));
process.exit(0);
EOF
pnpm --filter @gennety/bot exec tsx /tmp/t.mjs > .out.txt 2>&1; cat .out.txt; rm -f /tmp/t.mjs .out.txt
```

## Scope / impact
All Mini App endpoints authenticated with `Authorization: tma <initData>` share this
validator: `/v1/venue-change/*`, `/v1/calendar/*`, `/v1/matches/:id/ticket/*`,
`/v1/tickets/*`, `/v1/location/*`, `/v1/feedback/post-date`,
`/v1/telegram-onboarding/*`, `/v1/verification/mini-app/*`. On any client that sends
`signature` (Telegram 8.0+), they all 401. **This is a production launch-blocker.**
If onboarding/tickets appeared to "work" this session, check whether those steps were
driven by the dev scripts (`scripts/dev-*.mjs`) rather than real device→API `tma`
calls — the validator is provably wrong for signature-bearing initData regardless.

## How to inspect logs / current state

- **Bot log** (single combined process — bot + public API :3101 + admin :3100):
  `/tmp/gennety-dev-bot.log`. The route logs `[vc-debug] CLIENT-DIAG …` (temp).
  Note: the `/state` route currently returns a **bare 401/500 with no stack log**
  on auth/throw — that silence is why this was hard to see; consider adding a
  try/catch + logger to the `tma` routes.
- **ngrok request inspector** (the Mini App is served via the free ngrok tunnel
  `https://hatching-overlook-jailbreak.ngrok-free.dev` → Vite :5173; API is relative
  → same tunnel → local :3101). Buffer ~100, churns fast:
  `curl -s "http://127.0.0.1:4040/api/requests/http?limit=60" | python3 -c "import sys,json;d=json.load(sys.stdin);[print(r.get('start','')[:19],r['request']['method'],r['response']['status_code'] if r.get('response') else '-',r['request']['uri'][:90]) for r in d['requests'] if 'venue-change' in r['request']['uri']]"`
  → look for `GET … /v1/venue-change/state?match=<uuid>` and its status (401 = this bug).
- **Dev DB** (Postgres in Docker, `localhost:5434/gennety_dev`, creds `gennety/gennety`):
  `docker exec gennety-dev-db psql -U gennety -d gennety_dev -c "<sql>"`.
  Current test match: `1833db55-8a4a-4c3d-a52d-70ba9b815d7c` (status `scheduled`,
  venue "Кальян-бар Mr.White 3", agreedTime 2026-06-19 14:30). Female = Алёна
  (telegramId `5986970093`, user B). Male = Андрей (`782065541`, user A).
- **Direct handler repro** (bypasses HTTP/auth, hits dev DB; import `config.ts` first
  so `.env.local` loads before Prisma):
  `pnpm --filter @gennety/bot exec tsx <script.ts>` importing
  `getVenueChangeState`/`getVenueChangeCatalog` from
  `apps/bot/src/handlers/matching/venue-change.ts`.

## Test accounts & env
- **@GN01001** — telegramId `782065541` (male, full verification path).
- **@gennetysupport** — telegramId `5986970093` (female, email verification SKIPPED;
  in `DEV_OTP_BYPASS_TELEGRAM_IDS`).
- Feature flags ON in `.env.local`: `VENUE_CHANGE_FEATURE_ENABLED`,
  `TICKET_FEATURE_ENABLED`, `COORDINATION_FEATURE_ENABLED`, `DATE_CARD_FEATURE_ENABLED`,
  `RICH_THINKING_ENABLED`, `ONBOARDING_FACT_COLLECTOR_ENABLED`, `ELO_VISION_SEED_ENABLED`,
  Persona (sandbox), Rekognition (real), Places (real), `TICKET_PAYMENT_MODE=mock`.

## Process gotchas (bit us this session)
- **One bot only.** A leftover/duplicate `pnpm dev:bot` causes Telegram 409 conflicts
  AND serves the Mini App API with a stale in-memory Prisma client (silent 500s).
  `scripts/dev-bot.mjs` now fail-fasts if :3101 is busy. If `lsof -ti :3101` is empty,
  the bot died — restart: `( nohup pnpm dev:bot >/tmp/gennety-dev-bot.log 2>&1 </dev/null & )`.
- **`dev:db:push`, never bare `db:push`** (bare hits PRODUCTION Supabase via `.env`).
- **ngrok free interstitial** breaks browser-UA XHR without the
  `ngrok-skip-browser-warning` header → handled by `apps/webapp/src/dev-ngrok-fetch.ts`
  (imported by `api.ts`). Not the cause here, but keep it in mind.

## Temp diagnostics to REMOVE after the fix
1. Client beacon in [`apps/webapp/src/venue-change.ts`](apps/webapp/src/venue-change.ts)
   — the `void fetch("/v1/venue-change/state?match=DBG&dbg=…")` block (search `TEMP DIAGNOSTIC`).
2. Server log in [`apps/bot/src/public/routes/venue-change.ts`](apps/bot/src/public/routes/venue-change.ts)
   `/state` handler — `if (req.query.dbg) console.warn("[vc-debug] CLIENT-DIAG …")`.

## Recommended order
1. Apply the one-line `params.delete("signature")` fix + regression test.
2. Remove the two temp diagnostics above.
3. Restart bot, re-tap "Change venue" on the phone, confirm the catalog screen loads
   (and grep ngrok: `GET /v1/venue-change/state?match=1833db55…` should now be **200**).
4. Smoke-test one more `tma` Mini App (e.g. tickets) to confirm the shared fix.
