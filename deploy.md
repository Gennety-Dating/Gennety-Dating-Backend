# Gennety Dating Deploy

**PENDING — a forgotten menu edit stops owning the chat, and About me shows what
it replaces (PRODUCT_SPEC §2.1, DECISIONS.md).** Not deployed yet. **No Prisma
schema change, no env change, no flag change, no Mini App change**
(`apps/webapp` untouched) — bot-side only, so a full server code deploy carries
all of it, plus `pnpm demo:deploy`.

Found by a full-codebase audit rather than a report. `services/match-flow-claim.ts`
bounded the three match flows that read the next plain message as their answer;
the five `menuState` values that do the same thing were never bounded. Worst
case is `edit_bio`, which writes its message verbatim into
`Profile.psychologicalSummary` — the dominant embedding input — so a user who
tapped **About me** and walked away had their next message, weeks later, replace
their whole profile analysis while their actual question went unanswered.

**Three things worth knowing before the restart:**

- **`SessionData` gains one nullable field** (`menuClaimUntil`). Additive, no
  schema change — `bot_sessions` stores the blob as JSON and the storage adapter
  merges defaults. **It fails closed on purpose:** every session written before
  this deploy reads `null`, so the handful of users sitting in an open editor at
  restart have that edit dropped and their next message answered by the
  concierge instead. That is the safe direction (the agent hands the editor
  straight back); the alternative trusts a stale state and overwrites a profile.
- **The About me prompt is now two messages, not one** — the second carries the
  current text so the replacement is an informed act. It is skipped entirely for
  a user with no bio yet, and the lookup is best-effort, so a DB blip costs the
  preview and never the editor.
- **The windows are short on purpose** (30 min for About me / Who I want, 60 for
  the rest). Expiring is soft — the message goes to the agent — so if anyone
  reports "it forgot my bio edit", the fix is a longer TTL in
  `MENU_CLAIM_TTL_MS`, not removing the deadline.

Preflight for this change: typecheck clean across all 5 projects, lint clean,
**3955 tests** (bot 3430 / shared 273 / webapp 252), 0 failed. The two
router-level regression tests were confirmed to FAIL with the guard neutralised
(`prisma.profile.update` called on a three-week-stale claim) before being
confirmed green with it.

Post-deploy check — nothing new is logged on the happy path, so verify on
`@gennetytestbot`: tap **My Profile → About me**, confirm the current text is
shown beneath the prompt, then send a bio and confirm it saves. The expiry is
only observable by waiting, so check it in the database instead:

```sh
# Sessions holding an open text-capture claim. A row whose menu_state is one of
# the five but whose blob has no live menuClaimUntil is the pre-deploy backlog —
# it fails closed and self-heals on the user's next message.
psql "$DATABASE_URL" -c "select count(*) from bot_sessions where value::jsonb->>'menuState' in ('edit_bio','edit_major','edit_partner_preferences','edit_age_range','awaiting_premium_cancel_reason');"
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. The extra session field is ignored by the old code.

---

**PENDING — venue-change photos are retried instead of dropped, and a failed
one is no longer silent (PRODUCT_SPEC §3.7b, DECISIONS.md).** Not deployed yet.
**No Prisma schema change, no env change, no flag change.** Half server, half
client, so it needs BOTH: Deploy Full Server Code → `pnpm db:drift-check` →
`pm2 restart` → `./scripts/deploy-webapp.sh` → `pnpm demo:deploy`.

**The two halves are independent — there is no ordering constraint**, which is
unusual enough to state. The new client works against today's server and the
new server works against today's bundle; each is a strict improvement on its own
hop. If the Mini App build fails (see below), the server half still ships.

Reported against the demo — no photos on the venue-change board, neither in the
card previews nor in the opened gallery. It is **not** a demo bug: the
venue-change handler is md5-identical between the two deployments, the
`PLACES_API_KEY` line is md5-identical, and it is the same droplet. Production
simply has never had a date reach that board (0 dates ever), so nobody had seen
it. Reproduced in **production** with the prod bot token: 1 of 6 proxied photos
came back 502, logged as `ETIMEDOUT` connecting to Google's photo CDN.

**Four things worth knowing before the restart:**

- **The 10s photo budget now covers up to 3 attempts** (≤4s each, 150ms apart)
  rather than one long wait, so a proxied photo can never take *longer* than it
  could before — only fail less often. Only transient outcomes retry: a thrown
  fetch, 5xx, 429, 408. A 4xx, a non-image body and an over-ceiling file are
  permanent and answer on the first attempt, so a genuinely broken ref costs one
  request, not three.
- **Expect new log lines, and treat a burst of them as the signal they are.**
  `photo proxy failed after N attempt(s): <reason>` on every 502 (previously two
  of the three failure branches returned in complete silence — that is why the
  original report left almost nothing to go on), and
  `photo recovered on attempt N` when a retry rescues a blip. The second is
  rare by design; if it becomes frequent, the droplet's path to Google's CDN is
  degrading and that is worth acting on before users lose photos again.
- **Upstream request volume can rise on a bad day**, bounded at 3× for the
  photos that fail. Google Places photo requests are billed, so a sustained
  outage now costs somewhat more than it did — capped, and only while failing.
- **Nothing in production exercises this** until a pair reaches `scheduled`
  with `VENUE_CHANGE_FEATURE_ENABLED` on. Verify on the demo (walk a run to a
  scheduled date, open "Change venue") or on `@gennetytestbot`. Note the demo's
  own match had already gone `completed` during diagnosis, so it needs a fresh
  run — `/restart`, or the "show me another profile" button.

Preflight for this change: typecheck clean across all 5 projects, lint clean,
**3935 tests** (bot 3410 / shared 273 / webapp 252), 0 failed.

Post-deploy check — the healthy state is silence, so grep for the absence:

```sh
./scripts/deploy-webapp.sh && pnpm demo:deploy
pm2 logs gennety-bot  --lines 200 --nostream | grep '\[venue-change\] photo'
pm2 logs gennety-demo --lines 200 --nostream | grep '\[venue-change\] photo'
# Empty = nothing failing. `photo recovered on attempt N` = a blip the retry
# caught (fine, but watch the rate). `failed after 3 attempt(s)` = a real
# upstream problem — read the reason, it now names one.
```

**Rollback:** revert the code, restart, redeploy the Mini App and the demo.
Nothing else to undo — no schema, no env, no flag, no server state.

---

**PENDING — security audit remediation: the demo stops holding production's JWT
secret and stops being able to send real SMS (DECISIONS.md ×3, DEMO_MODE.md →
The isolation invariant).** Not deployed yet. **No Prisma schema change, no flag
change, no Mini App change** (`apps/webapp` untouched) — bot-side only, so a full
server code deploy carries all of it, plus `pnpm demo:deploy`. **One env change,
demo-side only**, and it must land BEFORE the demo redeploy or the new gate will
(correctly) refuse to deploy.

From a full demo↔production isolation audit. Four fixes; the first two are the
ones that matter.

- **`JWT_SECRET` was identical in both deployments.** Same secret, same
  hardcoded issuer/audience, and `requireAuth` verifies a signature without
  looking the user up — so a token minted by the demo API was cryptographically
  valid on production, with only "does this UUID exist in the prod database?"
  left between it and an authenticated request. Cause is structural: the demo
  `.env` is production's plus the overrides in `.env.demo`, so every key
  `.env.demo` omits is inherited (the same mechanism that leaked `SUPABASE_URL`
  on day one). Fixed by giving the demo its own secret, and by a **gate in
  `deploy-demo.sh`** that compares both `.env` files on the server and refuses
  to deploy on a shared secret. `assertDemoIsolation()` cannot do this — from
  inside the process, production's values are unknowable.
- **The demo could send real SMS billed to production's Twilio account.**
  `phone-verification.ts` had no dev/demo short-circuit while `/v1/auth/phone`
  is mounted unconditionally and `PHONE_AUTH_ENABLED` is on there. A console
  rail gated on `OTP_LOG_TO_CONSOLE` now prints the code and calls no provider,
  mirroring `email.ts`. **That gate also covers local dev**, which inherits the
  same `TWILIO_*` keys — gating on `DEMO_MODE_ENABLED` would have fixed one of
  the two affected deployments.
- **`retention` gains a fifth target:** `bot_sessions` rows whose chat id
  matches no user and that nothing has touched for 7 days. `deleteUserAccount`
  erases the session directly as of `981ef04`, but forward-only — production
  carried five orphans from before it.
- **The demo can no longer park itself permanently** (`failure-tracker.ts`): a
  given-up action releases one probe every 2 minutes. See DECISIONS.md for why
  this is complementary to, not a duplicate of, the decline-reason fix in
  `8055c03`.

**Three things worth knowing before the restart:**

- **The env step is not optional and comes first.** Generate a fresh secret
  (≥32 bytes; the public API refuses to start on a shorter one) into
  `/opt/gennety-demo/.env` **and** into `.env.demo`, or the next hand-built demo
  env inherits production's again — which is the entire failure this fixes.
  Rotating the DEMO secret only invalidates demo tokens; production's is
  untouched, so no iOS client is affected either way.
- **`phone_otps.provider` gains a third value, `console`.** No schema change
  (plain string column). Verification now branches on
  `provider === "twilio_verify"` and treats everything else as locally
  hash-verified — deliberately that way round, so an unrecognised rail is
  refused rather than handed to a provider that never issued it.
- **The new orphan sweep is raw SQL with an age floor**, and the floor is
  load-bearing: `sessionMiddleware` runs before the handler that creates the
  `User` row, so a chat mid-`/start` legitimately has a session and no user.
  Without it the sweep would race registration.

Post-deploy check — the gate proves itself by refusing when it should, and the
console rail by making no outbound call:

```sh
# 1. The gate must PASS after the env change (it failed on JWT_SECRET before it):
pnpm demo:deploy          # first line: "OK — bot, database, storage and JWT secret are all demo-owned"

# 2. The demo must no longer reach Twilio. On the demo, request a code and watch:
ssh root@167.172.178.229 'pm2 logs gennety-demo --lines 50 --nostream | grep "console rail"'
#    A "[phone-verification] console rail — code for +…" line and NO twilio line.

# 3. Orphan sweep (runs 03:45 Kyiv; the count should go to zero and stay there):
psql "$DATABASE_URL" -c "select count(*) from bot_sessions b left join users u on u.telegram_id::text = b.key where u.id is null;"
```

**Rollback:** revert the code and restart. The demo's new `JWT_SECRET` can stay
(nothing depends on it matching anything) — reverting it would restore the
vulnerability. The `console` provider rows expire on their own within 7 days.

---

**PENDING — the ticket becomes a portrait object, the recommended bundle becomes
a burgundy button (PRODUCT_SPEC §3.5b).** Not deployed yet. **No Prisma schema
change, no env change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the
diff is `apps/webapp/**` plus docs. **Deploy Mini App Only**
(`./scripts/deploy-webapp.sh`); nothing to rsync to `/opt/gennety`, **no
`pm2 restart`**. Run `pnpm demo:deploy` too — the demo builds its own bundle from
the same source, and the mock/USD branch is only reachable there.

A second, third and fourth pass over the two ticket screens, each from founder
review of the one before (the first is in the block further down, still
undeployed — **all of it is one Mini App build**, so whichever redeploy happens
first carries everything).

**Seven things worth knowing before the redeploy:**

- **The ticket card loses its barcode; the stub prints БАЛАНС ▸ 🎟 × N.** One
  new i18n key (`balanceLabel`, all five locales) and one prop deleted
  (`Ticket3D.seed`, with its stripe generator) — so nothing on the card is
  derived from the match id any more. Watch the tear line rather than the text:
  the stub carries a `min-height` floor so the gate's screens that print no
  balance keep the perforation at the same height as the ones that do. If the
  card's silhouette ever differs between the offer screen and the waiting
  screen, that floor is what broke.
- **The pinned button bar stops being a footer and starts floating**, on both
  screens: content now scrolls *under* it and dissolves through a 72px scrim
  instead of being cut against its top edge. The only behaviour worth watching
  is the space at the end of the scroll — it is now the bar's **measured**
  height (`--bar-space`, written by a ResizeObserver in
  `apps/webapp/src/ticket/action-bar.ts`), so a screen with no bar reserves
  nothing and a wrapped RU label reserves more. If a last row of content ever
  sits stuck behind the buttons, that hook is where to look, not the CSS. The
  venue board's own CTA — the pattern this copies — is deliberately untouched.

- **The recommended bundle gets its burgundy fill BACK**, in both themes,
  reversing the earlier block's "no fill, burgundy light on glass". That earlier
  call was made on the dark theme and failed on cream — see DECISIONS.md. **The
  dark theme changes too**, which the founder did not ask for; a rung that is a
  filled button on one theme and a glass row on the other is two components.
  Its **edge light now diverges from `.btn-hero`** and that is deliberate: the
  white 90° wash layer is gone (it painted over the count emblem, which sits in
  the first ~19% of the row), the side insets are a whisper on dark, and on
  light there is no inner light at all — a white rim inside a burgundy button
  reads as a frame on cream. `.btn-hero` itself is untouched and keeps the full
  recipe; the two are never on screen together.
- **On dark, the two ordinary bundle rows lose the sheen entirely** and are
  lifted by tint instead (≈`#1a1a1a` over the `#030303` page, plus the existing
  drop shadow), and their count tiles become a saturated burgundy with no white
  halo. The famine row keeps its rose light — that temperature is its meaning,
  and it only renders on the mock rail. So production's Stars store is two flat
  rows and one lit burgundy button; the demo shows the rose one between them.
  Light theme is unchanged here.
- **The ticket card's geometry is now fixed, not content-derived** (268 × 392).
  Before, the gate's card and the store's card were different shapes because one
  prints a name row. If a future line is added to the card, it eats into the
  centred field rather than making the card taller — check it at 392 before
  raising `min-height`.
- **The specular highlight is deleted, not retuned.** Do not add a third
  version; DECISIONS.md records why the failure is structural. The holographic
  film stays.
- **Fifteen i18n strings change**, not just styling: `title` and `successTitle`
  lose their 🎟️ in all five store locales, and `balanceLabel` is added in all
  five ticket ones. Nothing reads them but the heading and the stub, and a stale
  bundle cannot half-apply either — it is one build or the other.

Post-deploy check — these screens are transient and log nothing, so verify by
eye. `scripts/dev-stage-all-screens.mjs` stands up all six gate states plus the
store, in both themes, as `web_app` buttons in the dev-bot chat:

```sh
./scripts/deploy-webapp.sh
pnpm demo:deploy
for p in ticket tickets; do curl -sI "https://dating-calendar.gennety.com/$p.html" | head -1; done
# Then, on @gennetytestbot:
#   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-stage-all-screens.mjs --apply
# Look for: a clearly PORTRAIT card with no serial, no barcode and no moving
# highlight, its stub reading БАЛАНС on the left and 🎟 × N on the right; the
# notch cutouts landing exactly on the dashed tear line; the ×6 row reading as
# burgundy-deep rather than pink-washed on BOTH themes, with its "6" clean and
# not washed pale at the left edge; and, on dark only, the ×1/×3 rows reading as
# flat lifted grey with no glow inside their edges.
# Then SCROLL both screens: content must fade out under the bottom buttons with
# no horizontal edge anywhere, and scrolling to the very end must leave the last
# row fully clear of them (not tucked behind).
```

**Rollback:** redeploy the Mini App from the previous checkout, and
`pnpm demo:deploy` from it as well. Nothing else to undo — no schema, no env, no
flag, no server state.

---

**Deployed 2026-08-08 — a decline reason stops blocking the next match, and the
demo's redo button answers (`8055c03`, PRODUCT_SPEC → Embedding freshness (M-2),
DEMO_MODE.md → Recovery).** Full server code + demo. **No Prisma schema change**
(`db:drift-check` **OK**, nothing to push), no env change, no flag change, no
Mini App change (`apps/webapp` untouched). Deployed from an isolated
`git worktree` at `8055c03` — a parallel session was mid-way through the ticket
screens in the shared tree, and it landed `47a5352` on `main` while this was
being verified, so **production is deliberately at `8055c03`, not at HEAD**;
that commit is `apps/webapp` only and carries its own PENDING block below.

Found from a founder report against the demo: tapping «Показати анкету знову»
after a pass produced **nothing** — no profile, no message — for 44 seconds.
Reconstructed exactly from `chat_events` in the demo DB rather than guessed:
reason given by voice 17:45:52 → recorded 17:45:57 → button tapped 17:46:05 →
`createProposedMatch refused … visitor embeddingDirty (no vector yet)` → three
more silent driver attempts → the give-up line at 17:46:49.

**The root cause is production, not the demo.** `appendNegativeConstraint`
marked `embeddingDirty` and stopped there, while every other embedding-feeding
writer has always attempted an immediate user-scoped refresh — and
`findCandidatesFor` fail-closes on the **seeker's own** dirty flag, so recording
a decline reason withheld that user from matching until the 5-minute cron.
ARCHITECTURE.md has described the fixed behaviour since M-2 shipped; the code
only did it for bio and partner-preferences.

**Three things worth knowing before the restart:**

- **This is reachable in production today, via Rematch.** The §3.11 offer is
  sent on the decline path — its primary case — and `REMATCH_FEATURE_ENABLED`
  has been on since 2026-07-27. Inside the window a buyer was told the engine
  found nobody and refunded, when it had refused to look. The refund rail worked,
  so nothing was lost but the purchase and the truth of the message. Nobody has
  hit it yet: production has had **2 matches ever, both terminal**, and
  `rematch_purchases` is empty.
- **Report and post-date-feedback paths now pay for one embeddings call.**
  They already awaited an OpenAI JSON call inside the same function, so this
  roughly doubles a sub-second step; it is bounded by the existing 30s deadline
  and is best-effort, so a failure leaves the row dirty for the cron exactly as
  before. Post-date feedback appends several constraints and deliberately
  refreshes **once at the end** rather than per line.
- **The demo half changes a button's behaviour.** The redo keyboard is retired
  only once a profile is actually dispatched, double-tap protection moved to the
  driver's single-flight guard, and a refused tap now answers immediately
  (`retrying`, ru/uk/en) and counts into the same failure ladder the driver uses.

Preflight for this change: typecheck clean, **3908 tests** (bot 3390 /
shared 273 / webapp 245), lint clean.

Post-deploy check — the production half logs nothing on the happy path, so the
assertion is the absence of the window rather than a new line:

```sh
# Should stay empty; it only prints when the immediate refresh fails.
pm2 logs gennety-bot --lines 200 --nostream | grep 'immediate embedding refresh failed'
# A profile dirtied by a decline reason should clear within a second, not five
# minutes — this is a snapshot, so run it right after a decline reason lands.
psql "$DATABASE_URL" -c "select count(*) from profiles where embedding_dirty;"
```

**Post-deploy verified (measured):** the founder's own stuck demo visitor healed
itself the moment the demo came back — the driver pitched at 18:19:04 and
`[dispatch] 1/1 matchId=315ca7d9… OK`, where every attempt in the previous hour
had answered `createProposedMatch refused … visitor embeddingDirty`. Their
profile's flag reads `embeddingDirty: false` with the constraint still on the
row, which is the whole change in one line. Both changed files md5-match the
deployed worktree; production restart count 54 → **55** (one increment, no
loop), **zero** errors from the new PID (the error log's last write is dated
2026-08-07), `/v1/ping` ok, admin `401`, **all 11 Mini App pages 200**. Demo
re-verified from its own banner: `@gennety_demo_bot`, database
`aws-1-eu-west-1` (production is `aws-0-`), both demo-only cron suppressions
logged, restart count 16, `demo-api` ping ok.

**⚠️ `deploy-demo.sh` again exits after failing its Mini App build step on a
worktree run** — no `node_modules`, so `vite: command not found`. Harmless here
for the same reason as 2026-08-08's coordination release: `apps/webapp` is
untouched, the existing `/var/www/demo-app` bundle stays correct, and the
failure comes after the rsync, the schema check and the restart have all
succeeded. Read the restart count and the banner, not the exit code.

**Still owed** (needs a human in the chat, on the demo): pass on a profile, give
a free-text reason, tap «Показати анкету знову» — a profile must arrive. And the
negative case, which is the actual regression guard: if it ever refuses, the tap
must answer within a second and the button must still be there.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. Constraints already written stay written; their embeddings are
correct either way.

---

**Deployed 2026-08-08 — deleting an account erases its chat session, and
photo-stage "Continue" stops finalizing early (`981ef04`, PRODUCT_SPEC §1.3 /
§GDPR, ARCHITECTURE → `bot_sessions`).** **No Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched) —
bot-side only,
so a full server code deploy carries all of it, and `pnpm demo:deploy` after it.

Found from a founder-reported dead end in the demo: after uploading photos the
chat printed **"Cannot finalize — missing required data: partner_preferences.
Please collect these before calling finalize_onboarding."** and nothing moved
the flow on. Reconstructed exactly from `chat_events` rather than guessed — the
hobbies question at 15:47:29, three photos at 15:47:53, a Continue button at
15:47:55, the tap, the error; then the same error again 85 minutes later on a
second tap.

Three defects, one chain:

- **Root cause: `bot_sessions` survives account deletion.** It is keyed by
  Telegram CHAT id with no relation to `users`, so no cascade reaches it. The
  demo `/restart` deleted the account and left the session, and the NEXT
  account inherited `expectingPhoto: true` — which put a brand-new user into
  the photo stage while the collector was still at `hobbies`.
- **`photos_continue` called finalize directly**, bypassing the collector's own
  question order. The guard refused, changed no state, and left the stage open:
  a permanent dead end with no path back to the missing question.
- **The guard's message went straight into the chat.** It is written for the
  model — English, internal field keys — and now goes to the log while the user
  gets localized copy.

**Three things worth knowing before the restart:**

- **The session delete is a GDPR fix as much as a state fix**, and it is NOT
  demo-only: `DELETE /v1/me` and Telegram Settings → Delete run the same
  service. `SessionData` holds `pendingPhotos` (file_ids of the erased
  profile), `contextDumpBuffer` (a pasted AI-memory export) and `activeMatchId`.
  It rides the same transaction as `user.delete`, so a storage-cleanup failure
  still leaves both the account and its session intact for a safe retry.
- **Telegram Settings → Delete was already correct** — it resets `ctx.session`
  itself. Only the demo `/restart` was missing that half, and grammY writes the
  live session back after the handler, so the row delete alone would have been
  undone.
- **One divergence remains reachable and is deliberately not "fixed" here:**
  `home_city` is required by the finalize guard and is not a collector question
  at all, so a missing city can still refuse a `complete` state. It now
  produces localized copy plus `[onboarding] finalize refused a complete
  collector state` in the log instead of a raw dump. Watch for that line: it is
  the only signal that the two notions of "done" have drifted.

Preflight for this change: typecheck clean, **3902 tests** (bot 3384 / shared
273 / webapp 245), lint clean. Two existing test harnesses needed a
`botSession` mock added (`account-deletion.test.ts`, `public-api.test.ts`) —
without it the mobile delete path 500s, which is exactly the failure the change
prevents in production.

Post-deploy check — nothing new is logged on the happy path, so verify on
`@gennetytestbot` (or the demo): send photos BEFORE answering every profile
question, tap Continue, and confirm the bot asks the pending question instead
of an English error. The session erasure is checkable directly:

```sh
# Delete an account (Settings → Delete, or /restart on the demo), then:
psql "$DATABASE_URL" -c "select count(*) from bot_sessions where key = '<telegram id>';"
# 0 is the fix. A surviving row is what the next account would inherit.
pm2 logs gennety-bot --lines 200 --nostream | grep 'finalize refused'
# Empty is the good case.
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. Sessions already erased stay erased, which is the correct state.

---

**PENDING — "invite a friend instead" becomes one chip instead of five rows
(PRODUCT_SPEC §3.9).** Not deployed yet. **No Prisma schema change, no env
change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the diff is
`apps/webapp/**` plus docs, so this is the **Deploy Mini App Only** path
(`./scripts/deploy-webapp.sh`), nothing to rsync to `/opt/gennety`, **no
`pm2 restart`**. Run `pnpm demo:deploy` as well. **It ships in the same Mini App
build as the ticket-screen block below** — one `deploy-webapp.sh` carries both.

The referral cross-promo existed as five hand-copied full-width rows across four
Mini Apps, four identical CSS blocks under four class names. It is now one
module (`apps/webapp/src/referral-hint.ts` + its React twin) rendering a 30px
auto-width chip, and the four old classes are deleted.

**Three things worth knowing before the redeploy:**

- **The Premium footer changes shape, and that is the actual fix.** The hint was
  the only one of the five living inside `.pm-action`, which is `flex: none` —
  so it grew that footer by ~39px (~57px once its 59-character copy wrapped,
  which it did on every phone) and pushed the subscribe CTA and the price line
  up the screen. The footer now holds the CTA and the price alone and cannot
  move. Verified by eye at 390×844 in both themes via `?preview=offer`.
- **Nine i18n keys are DELETED, not blanked** — `referralHint` across all five
  locales in `premium.ts`, `venue-change.ts`, `ticket/i18n.ts` and
  `tickets/i18n.ts`, plus the four interface declarations. One string now lives
  in `referral-hint.ts`, ≤31 characters per language, guarded by
  `referral-hint.test.ts` (that bound is what keeps the chip one line — a
  longer translation turns it back into the block this replaced). A stale bundle
  cannot half-apply it: it is one build or the other.
- **`REFERRAL_FEATURE_ENABLED=false` in production**, so none of this is
  reachable by a real user on any of the five surfaces. Verify on
  `@gennetytestbot`, or on the dev previews, which need no Telegram and no
  account — `venue-change.html?preview=board` now sets `referralEnabled` in its
  mock for exactly this reason (dev-only, `import.meta.env.DEV`-gated).

Post-deploy check — the chip is static and logs nothing, so verify by eye:

```sh
./scripts/deploy-webapp.sh
pnpm demo:deploy
for p in premium venue-change ticket tickets; do
  curl -sI "https://dating-calendar.gennety.com/$p.html" | head -1
done
# Dev previews (vite dev server), both themes:
#   /premium.html?preview=offer&lang=ru&theme=dark      → chip under "Дальше
#     будет больше", footer = CTA + price only
#   /venue-change.html?preview=agreed&lang=ru           → chip 8px under the
#     burgundy Premium row, visibly smaller
#   /venue-change.html?preview=board → tap a locked premium card → chip at the
#     tail of the detail, full 18px gap
```

**Rollback:** redeploy the Mini App from the previous checkout, and
`pnpm demo:deploy` from it too. Nothing else to undo — no schema, no env, no
flag, no server state.

---

**PENDING — the two ticket screens get one light, and the card stops lying
(PRODUCT_SPEC §3.5b).** Not deployed yet. **No Prisma schema change, no env
change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the diff is
`apps/webapp/**` plus docs. So this is the **Deploy Mini App Only** path
(`./scripts/deploy-webapp.sh`); there is nothing to rsync to `/opt/gennety` and
**no `pm2 restart`**. Run `pnpm demo:deploy` too — the demo builds its own
bundle from the same source and will otherwise keep the old one, and the demo
is where half of this is actually reachable (below).

Covers both ticket surfaces, which share one component and one stylesheet: the
store (`tickets.html`, the **My Tickets** menu row) and the §3.5b gate
(`ticket.html`, reached while planning a date).

**Three things worth knowing before the redeploy:**

- **The mock/USD branch only renders in DEMO.** Production runs
  `TICKET_STARS_ENABLED=true`, so the Stars bundle rows are what real users see
  and the rose "famine" bundle is unreachable there. The demo bot runs
  `TICKET_PAYMENT_MODE=mock`, so it gets the other branch. Both were restyled
  and both were screenshotted; if you only check one deployment you have only
  checked half of it.
- **Six i18n keys are DELETED, not blanked** — `ticketHolders` + `ticketStub`
  (the "На двоих" falsehood), `ticketLabel`, `ticketTagline`, and the store's
  `anonHolderA/B` + `balance`, across all five locales. `TicketStrings` /
  `StoreStrings` shrank with them, so a stale bundle cannot half-apply this: it
  is one build or the other.
- **`ticket/i18n.test.ts` changed its assertion** from `ticketStub` to
  `balanceNote` containing `{n}` — that string is now an accessible name only
  (the visible text on the stub is the vector mark plus "× N"), which is also
  why its emoji was removed from all five locales.

Post-deploy check — these screens are transient and log nothing, so verify by
eye. `scripts/dev-stage-all-screens.mjs` already stands up all six gate states
plus the store, in both themes, as `web_app` buttons in the dev-bot chat:

```sh
./scripts/deploy-webapp.sh
pnpm demo:deploy
for p in ticket tickets; do curl -sI "https://dating-calendar.gennety.com/$p.html" | head -1; done
# Then, on @gennetytestbot:
#   pnpm --filter @gennety/bot exec tsx ../../scripts/dev-stage-all-screens.mjs --apply
# Look for: no "На двоих" anywhere on the card; the store's card carries NO
# names while the gate's does; the wallet count on the stub (and absent at 0);
# three distinguishable bundle rows in BOTH themes.
```

**Rollback:** redeploy the Mini App from the previous checkout, and
`pnpm demo:deploy` from it as well. Nothing else to undo — no schema, no env,
no flag, no server state.

---

**Deployed 2026-08-08 — the pre-date coordination flow becomes walkable in the
demo (`7c67fd2`, DEMO_MODE.md).** **Demo only** — the diff is
`apps/bot/src/demo/**` plus docs, so **nothing was rsynced to `/opt/gennety` and
production was not restarted** (`gennety-bot` held restart count 53, PID
2344409). `pnpm demo:deploy` was the whole deploy, run from an isolated
`git worktree` at `7c67fd2` because the shared tree carried a parallel session's
in-progress ticket-screen work. No Prisma schema change (`db:drift-check` **OK**,
nothing to push), no env change, no flag change, no Mini App change.

Builds directly on the replay fix two blocks down (`23c8ea1`, deployed earlier
today) and **supersedes one bullet of it**: `defaultCoordMethodToProxy` is
deleted, because the choice is now the visitor's. That block carries a note in
place.

Three defects, one flow. Even with the replay live, the hour before the date was
not something a visitor could actually walk:

1. **The coordination fork was never shown.** The puppet is `platform: "mobile"`
   with a negative `telegramId`, so `resolveCoordRecipients` returns nobody and
   production silently selects the anonymous chat instead of asking — the
   three-way question never appeared on screen at all.
2. **The chat window lived ~4 seconds.** The replay ran all four gates with a 4s
   sleep between them, so `closeProxies` (T+25h) shut the relay almost
   immediately after `openProxies` (T-30m) opened it: the "Enter chat" button was
   dead by the time anyone reached it.
3. **The puppet could not answer.** No chat, no push token, no branch in
   `decide.ts` — a visitor who got in wrote into silence.

Now: the demo sends production's own offer card with **all three** buttons; the
two contact-exchange variants are explained rather than performed (founder
decision — DECISIONS.md) and deliberately write nothing, so the fork stays open
and both can be read; the anonymous chat is locked in by the visitor's own tap;
the replay is split into three stretches that stop at each real decision; and the
puppet talks in the relay through one small LLM call per turn, in character, with
the real venue and time.

**Five things worth knowing before the restart:**

- **The demo now spends OpenAI on the relay** (`MODELS.fast`, roughly one call
  per message the visitor sends, capped at 8 per match). Small, not zero. With no
  `OPENAI_API_KEY` — or on any failure, or on a generation that breaks character
  — it falls back to a scripted ladder, so the chat still works.
- **A new give-up line to grep for:** `giving up on partner_proxy_reply` means
  the relay refused three times running. `proxy-relay:closed` as the reason means
  the injected clock (`agreedTime − 15m`) and the window derived from
  `agreedTime` have drifted apart — that pairing is the one fragile join in this
  change.
- **Two floor timers, 5 and 7 minutes.** A visitor who walks away leaves the demo
  holding a screen for that long before continuing by itself. Deliberate (the
  buttons are the intended path), but longer than any previous demo pause — so a
  demo that looks stalled at the fork or in the chat probably is not.
- **Production coordination behaviour is untouched.** Nothing under
  `apps/bot/src/services/` or `handlers/` changed, and the guarded-branch count
  in production code stays at **8** — the fork card is sent from
  `apps/bot/src/demo/` with its own callback data precisely so no ninth branch is
  needed. DEMO_MODE.md explains why routing variant C through production's
  `handleCoordMethod` was rejected.
- **One test assertion changed rather than a behaviour:** `decide.test.ts` had
  two cases asserting `{ kind: "none" }` on a `scheduled` fixture past the T-2h
  gate. That state is no longer idle — it is the coordination stretch — so both
  now assert the thing they were actually about.

Preflight green: typecheck clean, **3380 bot tests** (85 under `src/demo/`, 32 of
them new), lint clean across all five projects.

**⚠️ `deploy-demo.sh` exits non-zero when run from a worktree, AFTER the bot is
already live.** Its last step builds the demo Mini App bundle, and a fresh
`git worktree` has no `node_modules`, so `vite build` dies with
`vite: command not found`. Harmless here — `apps/webapp` is untouched by this
change, the existing `/var/www/demo-app` bundle stays correct, and the failure
comes after the rsync, the schema check, the restart and `pm2 save` have all
succeeded. But it means **the script's exit code cannot be trusted as the
verification** on a worktree run: read the restart count and the banner instead.
It also means the script will NOT rebuild `dist/` back to the production API
base — safe only because it never built a demo-pointed one either. For a release
that does touch the Mini App, either `pnpm install` in the worktree first or
deploy from the main tree.

**Post-deploy verified (measured):** `driver.ts` on the droplet md5-matches local
(`e8f66c2c`), `proxy-partner.ts` present (10,959 bytes), banner names
`@gennety_demo_bot` + the demo database (`aws-1-eu-west-1`; production is
`aws-0-`), both demo-only cron suppressions logged, `:3102` listening,
`/v1/ping` ok, `demo-app/ticket.html` 200, restart count 13 → 14 with a stable
PID, and **zero errors from the new PID**. The driver is correctly idle: 0
actions across 10 consecutive ticks with the one visitor mid-onboarding (the
`[demo] scanned=…` line only prints when something was acted on, so silence is
the healthy state — do not read a run of `acted=1` at startup as a loop).

**Pre-existing and unrelated, seen while checking:** 8 historical `P2003
chat_events_user_id_fkey` lines in the demo error log — the outbound recorder
writing a chat event for an account `/restart` has just deleted. Fire-and-forget
and swallowed; nothing to do with coordination.

**Post-deploy walk still owed** (needs a human in the chat): a fresh run —
`/restart`, or «показать ещё одну анкету» — through to a scheduled date, then
«Что происходит дальше», then press **A**, press **B**, then the anonymous chat,
write two messages, press «Дальше».

```sh
pnpm demo:deploy
ssh root@167.172.178.229 'pm2 describe gennety-demo | grep -E "uptime|restarts"'
# uptime in seconds, restarts +1 — the bot runs from source, so the restart IS
# the deploy. A stale uptime means the code on disk is not the code running.
ssh root@167.172.178.229 'pm2 logs gennety-demo --lines 60 --nostream | grep -E "giving up|acted=0"'
# empty = nothing is stuck.
```

In the demo database afterwards:

```sql
select coord_method, proxy_opened_at is not null, proxy_closed_at is not null, status
  from matches order by created_at desc limit 1;
select sender_id, left(body, 60) from proxy_messages order by created_at;
```

Expect `coord_method = 'proxy'`, both stamps set, `status = 'completed'`, and
`proxy_messages` alternating between the puppet and the visitor — the puppet's
own line **first**, which is what makes a visitor open the chat.

**Variants A and B stay explanations, by design.** They exchange `t.me/` links
and the puppet has no account; giving it a fake `@username` would put a dead link
in front of an investor. The full three-variant flow with a live partner is
`@gennetytestbot` plus `scripts/dev-coord-offer-demo.mjs` (it has `--reset`, so A,
then B, then C on one match).

**Rollback:** revert and `pnpm demo:deploy`. Production is untouched. Nothing
else to undo — no schema, no env, no flag.

---

**Deployed 2026-08-08 — the two fixes production was still missing (`f66949a`).**
Full server code + Mini App + demo, bringing prod from `d5405f6` to
**`f66949a` plus `e04ffec`** (the dependency-override commit made during the
release). **No Prisma schema change** — `db:drift-check` **OK**, nothing to
push. No env change, no flag change.

It carried both PENDING blocks below — the venue-change current-venue card
photo, and the "free text that isn't an answer" fix (`087e7e4`) — which had sat
undeployed because the two releases in between were **demo-only** and never
restarted `gennety-bot`. Worth stating plainly, because it is the failure this
file keeps warning about in a new shape: a demo deploy touches
`/opt/gennety-demo`, so a production-relevant commit that happens to be an
ancestor of a demo release ships to the DEMO and nowhere else. `087e7e4` was in
the demo since 2026-08-07 and in production only now. **Check the prod restart
count after any demo deploy**: it not moving is the whole point, and it is also
what hides an unshipped fix.

**⚠️ `security:audit` failed preflight again — the third release running.**
`nanoid` <3.3.17 (GHSA-2v37-7h3g-55p8), reached through
`apps/video > @remotion/cli > @remotion/bundler > css-loader > postcss`. Not in
the bot runtime, so no user was exposed, but the gate is pass/fail. Fixed by
adding `"nanoid": "3.3.17"` to `pnpm.overrides` (`e04ffec`), which also sorted
the block so the next entry lands somewhere obvious. Re-audit: **No known
vulnerabilities found.** This is now a standing tax, not an incident — read the
Preflight note about overrides rotting.

**⚠️ A worktree deploy leaves a stray `.git` FILE on the droplet.** `git
worktree` writes `.git` as a file containing `gitdir: /Users/pro/…`, and the
documented `--exclude '.git/'` matches directories only — so yesterday's
worktree deploy rsynced that pointer to `/opt/gennety/.git`, where it sat as a
dangling reference to a Mac path. This release's `--delete` removed it, which is
correct and self-healing. Do **not** "fix" the exclude to `.git` without a
slash: an excluded path is protected from `--delete`, so that would pin the junk
there permanently. Either leave it to the next full deploy or
`rm -f /opt/gennety/.git` after a worktree run.

Preflight green: typecheck clean across all 5 projects, **3867 tests**
(bot 3353 / shared 273 / webapp 241, 261 files, 0 failed), `pnpm build`,
`security:secrets` (1016 files), `security:audit` 0 advisories after the
override.

rsync dry-run listed exactly **3** deletions, all reviewed: two gitignored
`apps/video/build` Remotion artifacts and the stray `.git` file above. Both
droplet-only DB backups and both `keys/*.p8` verified present afterwards.

**Post-deploy verified (measured, not inferred):** the three files that
distinguish the two undeployed commits now md5-match local HEAD
(`onboarding-photo-stage.ts` `4983080a`, `venue-change.ts` `9fd9e243`,
`i18n.ts` `359cb5e6` — before the deploy they matched `d5405f6`);
`services/profiler-intent.ts` present on the droplet (it did not exist there);
`originalPhotoRefs` appears 4× in the venue-change handler (0× before);
`Bot @gennetybot started` with all 16 crons + the peer-wait worker; restart
count 52 → **53** (one increment, no loop); **zero** P2022 / P2023 /
`ERR_MODULE_NOT_FOUND` / unhandled from the new PID; `/v1/ping` ok; admin
`401`; **all 11 Mini App pages 200**. Demo redeployed from the same source and
isolation re-confirmed from its own banner (`@gennety_demo_bot`, database
`aws-1-eu-west-1` — production is `aws-0-`), both demo-only cron suppressions
still logged.

**Rollback:** re-sync a checkout at `d5405f6` and redeploy the Mini App and the
demo from it. No schema to undo, no env, no flag.

---

**Deployed 2026-08-08 (was PENDING) — the venue-change board's current-venue card gets its photo
(PRODUCT_SPEC §3.7b).** Deployed 2026-08-08 in the release at the top of this
file. **No Prisma schema change, no env
change, no flag change** — but it is half client, so it **DOES need a Mini App
redeploy**: Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh` → `pnpm demo:deploy`.

**Server first, and the order matters.** The photo refs are new on
`GET /v1/venue-change/state`; a cached older bundle ignores the field and keeps
today's photo-less card. The reverse order ships a client reading a field the
server does not send yet — no picture, and the badge has already moved.

The pinned "keep this place" card was the one card on the board with no
picture, because the assigned venue is deliberately excluded from the catalog
(2026-08-03) and the card had no row to inherit pictures from. The board was
asking the pair to compare places while showing them everything except the
place they already had.

**Three things worth knowing before the restart:**

- **The data was already there.** `Match.venuePhotoName` is written at
  assignment by both selectors and is the same image the date card renders —
  the state endpoint just never sent it. The common path costs nothing; a row
  with no stored cover falls back to ONE Place Details lookup from
  `venuePlaceId`, cached for a day in the same map the catalog fills (5 min on
  failure). This endpoint is polled every ~4 s, which is why the stored cover
  comes first rather than always querying for the fuller gallery.
- **The card's badge moved to its own line**, which is a visible layout change
  beyond "add a photo". A 68px photo takes 82px out of a ~350px card, leaving
  the badge 176px against 203px of "Obecne miejsce spotkania" — measured, not
  guessed: it wrapped into a two-line pill and pushed the venue's own name into
  an ellipsis. Verified at 390px and 320px in ru/uk/pl, light and dark, plain
  and burgundy-marked. The venue name on this card now wraps instead of
  truncating; the twelve alternatives are untouched.
- **Nothing exercises it until a pair reaches `scheduled`.** Production has
  **2 matches ever, both terminal**, and `VENUE_CHANGE_FEATURE_ENABLED` gates
  the entry button, so verify on `@gennetytestbot` — or, with no match at all,
  on the dev preview, which now ships a photo for the pinned card:
  `http://localhost:5173/venue-change.html?preview=board&lang=ru&theme=dark`.

Demo picks it up from the same source with `pnpm demo:deploy` (its matches are
assigned through the real path, so they carry a cover). No gate, no paid step,
no negotiation branch — `apps/bot/src/demo/decide.ts` is untouched.

Post-deploy check — the photo either renders or it doesn't, so verify by eye;
the one thing worth querying is that the covers exist at all:

```sh
psql "$DATABASE_URL" -c "select count(*) filter (where venue_photo_name is not null) as with_cover, count(*) as scheduled from matches where status='scheduled';"
# A scheduled row with no cover takes the fallback-lookup path — not a bug.
pm2 logs gennety-bot --lines 200 --nostream | grep '\[venue\] photo lookup'
# Empty is the good case: that line only prints when a lookup fails.
```

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo — no schema, no env, no flag.

---

**Deployed 2026-08-08 — the demo replays the hour before the date, which it never
did (DEMO_MODE.md).** Demo only (`23c8ea1`) — `apps/bot/src/demo/**` plus docs,
so **nothing was rsynced to `/opt/gennety` and production was not restarted**
(`gennety-bot` held restart count 52). Deployed from an isolated `git worktree`,
the shared tree again carrying a parallel session's work. No schema, no env, no
flag change. Demo banner re-verified: `@gennety_demo_bot`, database
`aws-1-eu-west-1` (production is `aws-0-`).

Found by the first demo run ever to reach a scheduled date. It finished
correctly (`status: completed`, real venue, date card rendered,
`venue_selection_logs` 0 → 1) but `coordOfferSentAt` and `proxyOpenedAt` were
both still null: `runCoordinationTick` is a **separate sweep** from
`runDateLifecycleTick`, called from `index.ts` on the real clock, and the demo
replayed only the lifecycle. So the T-60m "how do we find each other" offer, the
T-30m anonymous chat and all five coordination cards were invisible in the demo
— with the flag on the whole time. Both take an injected clock, so the replay now
calls both, at gates `−2h / −45m / −30m / +25h` (the extra gate keeps the offer
and the chat opening as two separate beats).

**⚠️ Related correction, no action needed:** two blocks below claimed
`COORDINATION_FEATURE_ENABLED` is **off** in production. It is **on**, and has
been — `GET /v1/app/config` reports `features.coordination: true`. Both blocks
now carry a note in place. Nothing has exercised it because production has had
0 dates ever.

**Two things worth knowing:**

- **One demo-only branch:** an unanswered coordination offer resolves to the
  anonymous chat. `openProxies` needs `coordMethod`, which in the product comes
  from a tap, and a demo cannot depend on a tap landing inside a four-second
  beat. Guarded on `coordMethod: null`, so a visitor who did tap keeps theirs.
  **⚠️ Superseded by the PENDING block at the top of this file:** the four-second
  beat is gone (the replay now stops at the fork and waits), so this branch was
  deleted and the visitor makes the choice themselves. The floor timer that
  replaces it is five minutes.
- **A same-sex pair still cannot show everything.** The safety brief goes to the
  female participant, so a male visitor will correctly never see it — same for
  the hetero-only cover gesture, wish card and express venue change. That needs
  a second run from the other side, not a code change.

**Post-deploy check still owed:** the previous run's match is already
`completed`, so this needs a fresh walk — `/restart`, or «показать ещё одну
анкету» — through to a scheduled date, then «Что происходит дальше». The two
columns that were null are the assertion:

```sh
# In the demo DB: coord_offer_sent_at and proxy_opened_at must both be set,
# and coord_method should read 'proxy' for an untapped offer.
```

**Rollback:** revert and `pnpm demo:deploy`. Production is untouched.

---

**Deployed 2026-08-08 (was PENDING) — free text that isn't an answer stops being recorded as one
(PRODUCT_SPEC §1.3, §Phase 1b, §3.4).** Deployed 2026-08-08 in the release at
the top of this file — **note it reached the DEMO a day earlier**, on
2026-08-07, because `087e7e4` is an ancestor of the demo-only release `23c8ea1`
and `deploy-demo.sh` syncs the whole tree. **No Prisma schema
change, no env change, no flag change, no Mini App change** (`apps/webapp`
untouched) — bot-side only, so a full server code deploy carries all of it.
Demo picks it up from the same source with `pnpm demo:deploy`; no gate, no paid
step, no negotiation branch, so `apps/bot/src/demo/decide.ts` is untouched.

Three flows, one root cause: a prompt read the next message as its answer with
no check that it *was* one. See DECISIONS.md for the rule this establishes.

- **Profiler.** "не хочу отвечать" was stored verbatim as the ANSWER to the
  live question with `skipped: false` — burning it permanently (answered
  questions are never re-asked) and feeding it to the ice-breaker / wingman
  generators. It is now recorded as a skip and **ends the batch**, deferring to
  the user's next local window. Expect `profiler_answers` rows that previously
  would have carried refusal text to arrive as `skipped: true` with a null
  `answerText` instead; that is the fix, not data loss.
- **Onboarding photo stage, at or above `MIN_PHOTOS`.** The continue matcher
  took bare words only, and every unmatched message got the progress card
  without the agent being called. Now it matches phrases ("мне хватит", "не
  хочу больше", "это всё") and hands **question-shaped** text to the agent.
  Only questions — an ordinary message there would advance the collector to
  `complete` and finalize onboarding, which §1.3 forbids.
- **Decline reasons.** The four preset buttons record analytics and explicitly
  do NOT write `negativeConstraints`; the message promised the opposite. Copy
  fixed in all 5 locales, and the first button now names appearance explicitly
  ("Не мой тип" alone read as personality). **No behaviour change** — read
  DECISIONS.md before ever "fixing" the presets by routing them into matching.

Preflight for this change: typecheck clean, **3347 bot tests + 273 shared**,
lint clean. One existing assertion was updated (`matching.test.ts` pinned the
old button label — that test doing its job is how the copy change was caught).

Post-deploy check — nothing new is logged and production has 2 matches ever, so
verify on `@gennetytestbot` rather than from prod logs: answer a Profiler
question with "не хочу" (expect the ack + no further question until the next
window), and at 3 photos type "мне хватит" (expect the stage to close) and then
"а кто увидит мои фото?" (expect an answer, not the progress card).

```sh
psql "$DATABASE_URL" -c "select skipped, count(*) from profiler_answers group by 1;"
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-07 — a stuck demo says so instead of retrying forever
(DEMO_MODE.md).** Demo only (`263e9b9`) — the diff is `apps/bot/src/demo/**` plus
docs, so **nothing was rsynced to `/opt/gennety` and production was not
restarted** (`gennety-bot` held restart count 52 across the whole rollout).
`pnpm demo:deploy` was the whole deploy, run from an isolated `git worktree` at
`263e9b9` because the shared tree carried a parallel session's in-progress
Profiler work. No Prisma schema change, no flag change.

Groundwork for the full demo walkthrough: before hunting for more dead-ends, make
a dead-end impossible to miss. Every branch of `performAction` now returns an
outcome instead of `void`, a refusal (or a throw) is counted per (visitor,
action), and at three in a row the demo tells the visitor it is stuck and stops
retrying. Seven branches had the same shape as the ticket-gate stall; one of them
(`partner_accept`) was not even checking `applyMatchDecision`'s `null`.

**One env change, applied separately and already live:** the demo was quoting a
**stale Premium price** — `PREMIUM_STARS=500` / `$11.99` against production's
`750` / `$17.99` as of today. An investor was being shown the wrong number.
Fixed in `/opt/gennety-demo/.env` (backup `.env.bak.20260807-214909`); it takes
effect on the redeploy's restart.

**Two things worth knowing before the restart:**

- **The tick summary changes meaning.** `acted` used to count refusals;
  `errors` was effectively always 0. After this, `[demo] scanned=1 acted=0
  errors=1` is a real signal, and `giving up on <action> …` is the line to grep
  for. Historical log lines are not comparable.
- **`DEMO_MAX_ACTION_FAILURES = 3` is a code constant, not env.** At
  `DEMO_STEP_WAIT_MS` (12s) apart that is ~36 seconds before the demo gives up.
  Lower it and a provider hiccup ends a demo; raise it and the audience is back
  to watching silence.

**Post-deploy verified:** demo banner names `@gennety_demo_bot` and the demo
database (`aws-1-eu-west-1`; production is `aws-0-`), both demo-only cron
suppressions logged, `failure-tracker.ts` present on the droplet, `demo-api`
ping ok, `demo-app/ticket.html` 200, and **zero** `giving up on` / `acted=0`
lines since the restart — i.e. nothing is currently stuck. The Premium price was
read back off the surface an investor actually sees: `GET /v1/premium/state`
now answers `priceStars: 750, priceDisplay: "$17.99"`, matching production.

To confirm the give-up path itself, make a stall on purpose — zero the puppet's
wallet and remove the top-up. It is safe: `/restart` clears the tracker and the
top-up refills the wallet on the next real run.

```sh
ssh root@167.172.178.229 'pm2 logs gennety-demo --lines 100 --nostream | grep -E "giving up on|acted=0"'
# Empty in the healthy case. A `giving up on <action>` line is the feature
# working, and it must appear ONCE per streak — not once per tick.
```

**Rollback:** revert the code and `pnpm demo:deploy`. Production is untouched by
this block. To put the Premium price back, restore
`/opt/gennety-demo/.env.bak.20260807-214909` and restart `gennety-demo`.

---

**Deployed 2026-08-07 — ticket-gate avatars stop being half a megabyte each, and
two demo dead-ends (DEMO_MODE.md).** Server + Mini App + demo, brought prod from
`c25adbc`+`01c32b8` to **`d5405f6`**. **No Prisma schema change, no env change,
no flag change** (`db:drift-check` **OK**, nothing to push). Deployed from an
isolated `git worktree` at `d5405f6`.

**This release also carried every other PENDING block** — the three below (the
preference screen, the onboarding name field, the native proxy-chat server half)
plus the two photo-shimmer commits `27f426b` / `d75b518`, which had no block of
their own (PRODUCT_SPEC §1.3 / §2.1 carry the behaviour). All four blocks are
marked deployed in place.

Three fixes from one founder report. **Only the first reaches production**; the
other two are `apps/bot/src/demo/` and inert without `DEMO_MODE_ENABLED`.

- **Date Ticket avatars (production + demo).** The Mini App draws two 44px
  circles on the "pay for us both" button and the route streamed the
  participants' FULL profile photos to fill them — measured on the live demo at
  **517 KB + 355 KB for one button**, over mobile data, inside a Telegram
  WebView, against the client's 6-second preload budget. `GET
  /v1/matches/:id/ticket/photo/:side` now shrinks to a 256px ceiling
  (`services/avatar-thumbnail.ts`, `@napi-rs/canvas` — already a dependency, no
  new install) and caches the result in-process by storage ref. `Avatar` also
  falls back to the monogram on a load error, so a failure reads as an initial
  rather than a broken-image glyph.
- **The puppet could not pay its own ticket (demo).** A visitor who chose "pay
  only mine" hit a hard stop: `useTicketFromBalance` refuses at a zero balance,
  which is where every seeded puppet starts, so the gate never completed and the
  Calendar was never sent — `[demo] puppet ticket settle failed:
  insufficient-balance` every 12s, forever. Reproduced live before the fix. Only
  the "pay for both" path avoided it, which is why earlier walkthroughs missed it.
- **The product was explained twice (demo).** `spokenBeats` is in memory and the
  demo restarts on every release, so a visitor who came back from a pass got the
  whole "you're in the system, here is how matchmaking works" message again. The
  deleted match rows are durable proof it was already said.

**Three things worth knowing before the restart:**

- **The avatar change is NOT demo-only** even though it was reported against the
  demo. `TICKET_FEATURE_ENABLED=true` in production, so this is the paid gate's
  own screen. It is strictly less data and the same picture.
- **The in-process cache holds image bytes.** Bounded to 200 entries with a 6h
  TTL and swept on insert; at ~25 KB an entry that is a few megabytes worst case
  on a 2 GB droplet. Keyed by `file_id`/Supabase path, both of which change when
  the photo does, so a cached avatar can never outlive its photo.
- **A stuck demo heals itself on the restart.** The match currently sitting in
  `ticketStatus: partial` will complete on the next 3-second tick once the demo
  is redeployed — no manual DB edit.

**Post-deploy verified (measured, not inferred):**

- **Avatar bytes, against the same live gate that produced the "before"
  numbers:** self **517,591 → 17,073 B**, partner **354,963 → 12,703 B**. One
  button went from ~850 KB to **~30 KB (3.5%)**. Downloaded and decoded: a valid
  144×256 JPEG, aspect ratio intact. The cache shows up as a second fetch at
  0.35s against 0.88s cold.
- **The stuck demo healed itself on the first tick**, with no manual DB edit:
  the match that had been logging `insufficient-balance` every 12s since 14:53Z
  went `ticketStatus: partial → completed`, both slots paid, and
  `proposedTimes` filled with 84 slots — i.e. the Calendar finally opened. The
  ledger reads `+1 store_purchase` then `-1 spend_match`, which is the top-up
  and the settle.
- Production: `Bot @gennetybot started`, all 16 crons + the peer-wait worker,
  restart count 51 → **52** (one increment, no loop), **zero** P2022 / P2023 /
  `ERR_MODULE_NOT_FOUND` / unhandled from the new PID, `/v1/ping` ok, admin
  `401`, **all 11 Mini App pages 200**.
- Demo re-verified after `pnpm demo:deploy`: `demo-api` ping ok,
  `demo-app/ticket.html` 200, driver ticking `scanned=1 acted=1 errors=0`.
- rsync dry-run listed **80** deletions, all reviewed: 72 gitignored
  `apps/video/build|out` Remotion artifacts (same class as the last release) and
  8 files of the deliberately-deleted second preference design. Both droplet-only
  DB backups and both `keys/*.p8` survived.

**Rollback:** revert the code, restart, redeploy the Mini App and the demo.
Nothing else to undo — no schema, no env, no flag. The cache is in-process and
disappears with the restart.

---

**Deployed 2026-08-07 (was PENDING) — the preference screen is one design now,
and the photos and the word both changed (PRODUCT_SPEC §1.3).** Deployed
2026-08-07 in the release at the top of this file. **No Prisma schema
change, no env change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the
diff is `apps/webapp/**` plus docs. **Deploy Mini App Only**
(`./scripts/deploy-webapp.sh`); nothing to rsync to `/opt/gennety`, **no
`pm2 restart`**. Run `pnpm demo:deploy` too — the demo builds its own bundle
from the same source and will otherwise keep the old one.

Three commits, one bundle: the photo tiles lost their white frames and the dark
hairlines the frames were causing; «Парней» / «Девушек» went to Inter 800 and
larger; and the second design plus its `?v=` switch, review page and artwork
were deleted after the founder settled on the photo scatter. Full detail is in
the profile-screens block below (the four bullets under "So does the preference
photo fork") — that block is labelled *Deployed*, which is true of the screens
themselves and **not** of these three changes.

**Two things worth knowing before the redeploy:**

- **The bundle gets ~335 KB SMALLER**: `apps/webapp/src/preference/cutout/`
  (two group images) is deleted along with the code that read it. Nothing else
  referenced those files, so this is dead weight leaving, not an asset going
  missing.
- **`onboarding.html` must keep `;800` in its Google Fonts URL.** It was added
  for the deleted design, so the obvious tidy-up after removing that design is
  to drop it again — that would silently downgrade the two labels to a
  synthesised bold. An earlier revision of the bullet below actively told you to
  drop it; it now says the opposite.

Post-deploy check — the screen is transient and logs nothing, so verify by eye
on `@gennetytestbot` (or the dev preview, which needs no Telegram):

```sh
./scripts/deploy-webapp.sh
curl -sI https://dating-calendar.gennety.com/onboarding.html | head -1
# Dev preview of the exact screen, both themes:
#   http://localhost:5173/onboarding.html?preview=basics:preference&lang=ru&theme=light
# `?v=1`, `?v=2`, `?v=both` must now all render the same single design.
```

**Rollback:** redeploy the Mini App from the previous checkout. Nothing else to
undo — no schema, no env, no flag, no server state.

---

**Deployed 2026-08-07 (was PENDING) — the onboarding name field stops shrinking
under the keyboard (PRODUCT_SPEC §1.1).** Deployed 2026-08-07 in the release at
the top of this file. **No Prisma schema change, no env
change, no flag change, and NO SERVER CODE CHANGE AT ALL** — the diff is
`apps/webapp/src/onboarding.css` plus docs. So this is the **Deploy Mini App
Only** path (`./scripts/deploy-webapp.sh`); there is nothing to rsync to
`/opt/gennety` and **no `pm2 restart`**. Also run `pnpm demo:deploy` — the demo
builds its own bundle from the same source and will otherwise keep the old one.

The name screen's font size was measured in `dvh`, so opening the keyboard
shrank the letters the user was typing and closing it snapped them back (the
"blink" on Continue). It is width-measured now, which the keyboard cannot
touch. One thing worth knowing: on a 390px phone the unfocused size moves
48px → 46.8px — a deliberate 2.5% trade for a constant size, and narrower
phones scale down further, which is what a long name wanted anyway.

Post-deploy check — this is a transient visual state, so verify by eye rather
than from logs. The dev-only preview needs no Telegram and no account:

```sh
./scripts/deploy-webapp.sh
curl -sI https://dating-calendar.gennety.com/onboarding.html | head -1
# Then, on the dev server: tap the field and confirm the name holds its size.
#   http://localhost:5173/onboarding.html?preview=basics:name&lang=ru&theme=dark
```

**Rollback:** redeploy the Mini App from the previous checkout. Nothing else to
undo — no schema, no env, no flag, no server state.

---

**Deployed 2026-08-07 (was PENDING) — the anonymous pre-date chat reaches the
native client, and opens at all for a pair with an app participant
(PRODUCT_SPEC §Phase 4).** Deployed 2026-08-07 in the release at the top of this
file. **No Prisma schema change, no env change, no flag change, no Mini App
change** (`apps/webapp` untouched) — half of it is client, so the iOS app ships
with it (separate repo).

**⚠️ This block said "inert in production — the flag is off". That was wrong**
(corrected 2026-08-08). `COORDINATION_FEATURE_ENABLED=true` has been in
`/opt/gennety/.env` (line 70) for some time, and the running process confirms
it: `GET /v1/app/config` answers `features.coordination: true`. So these routes
are **live**, and the T-60m offer plus the anonymous chat are real behaviour for
real users. What made the error invisible is that production has had **0 dates
ever**, so nothing has ever reached T-60m to exercise them. Read the flag off
`/v1/app/config`, never off a sentence in this file — an older block one screen
down states the opposite, and only one of them could be right.

New: `GET/POST /v1/matches/{id}/chat` (JWT), plus `services/proxy-chat.ts` —
the window, the `proxy_messages` write and delivery, shared with the Telegram
relay.

**Four things worth knowing before the restart:**

- **The gap was not a missing endpoint, it was a missing initiation.** The
  offer requires both sides in a bot chat, and `openProxies` only opens a
  window for a match whose `coordMethod` a tap set — so a pair with an app
  participant never got the offer, a method, or a window. Such a pair now has
  variant C selected for them at T-60m. Once the flag is on, expect
  `coordMethod: "proxy"` rows nobody chose; that is the fix, not drift.
- **The window moved off the cron's columns.** Derived from `agreedTime`
  (T-30m…T+2h). `proxyOpenedAt`/`proxyClosesAt` are still written and still
  mean "the pair was told"; `proxyClosedAt` still force-closes. Effect on
  Telegram: the chat becomes enterable up to two minutes earlier, which is the
  point.
- **`resolveCoordRecipients` now checks `platform`, not `telegramId > 0`** —
  the same fix already applied to the Profiler and re-engagement workers.
  Nobody is in that state until `TELEGRAM_LOGIN_CLIENT_ID` is live.
- **A mobile partner now gets pushes that did not exist**: one when the window
  opens, one per relayed message, and the message push CARRIES the text (see
  DECISIONS.md for why this differs from the emergency-cancellation push). It
  also fires the `chat_open` stage of the date-day Live Activity, declared in
  §4.2 and deliberately never sent until now.

Post-deploy check — the flag is off and production has **0 dates ever**, so
nothing exercises this; verify mountedness, then walk it on `@gennetytestbot`
with the flag on:

```sh
# 404 while the flag is off = mounted and correctly inert.
curl -s -o /dev/null -w '%{http_code}\n' \
  https://dating-api.gennety.com/v1/matches/00000000-0000-4000-8000-000000000000/chat
pnpm openapi:lint
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. `SerializedMatch.proxyChatOpensAt`/`ClosesAt` simply stop being
sent, and the iOS build treats their absence as "no window".

---

**Deployed 2026-08-07 — the 84-commit backlog: every block below that was marked
PENDING above the 2026-08-02 catch-up marker shipped in one release, plus the
misfiled account-health block.** Full server code + Mini App + demo + two `.env`
lines. Brought prod from `7f19a72` (2026-08-02) to `c25adbc` plus one
dependency-override commit made during the release.

**No Prisma schema change at all.** The droplet's `schema.prisma` was already
byte-identical to the target, so there was no `db:push`, no `migrate diff` plan
to read, and no additive-step conflict to sequence around — which is why 19
blocks could group into a single release. `db:drift-check` still ran as the
mandatory gate and returned **OK**.

**Deployed from an isolated `git worktree`, not the working tree.** A parallel
session was writing the `/v1/*` proxy-chat server half in the same checkout, and
rsync copies the working tree. `git worktree add /tmp/gennety-deploy c25adbc`
gave a clean source; preflight ran **there**, so the test numbers describe what
shipped rather than someone's half-written module. Do this whenever the tree is
not yours alone — it also means the sync deletes accumulated build junk, which
is where most of the deletion lines below came from.

**⚠️ `security:audit` failed preflight, and three existing overrides were the
cause.** `postcss`, `fast-uri` and `brace-expansion` were each pinned in
`pnpm.overrides` at exactly one patch below their advisory's fix — the precise
trap this file's Preflight section warns about ("never pin an override BELOW the
patched version"). They were correct when written; advisories published since
moved the bar. 7 advisories (4 high / 3 moderate). Only the `ip-address` chain
(`apps/bot > express-rate-limit`) reaches the droplet runtime — the other four
are `apps/video` build-time or `eslint` dev tooling. Fixed by raising three
overrides and adding two:

```
postcss         8.5.18 -> 8.5.23      fast-uri   3.1.4 -> 3.1.5
brace-expansion 5.0.8  -> 5.0.9       js-yaml    (new) -> 4.3.1
ip-address      (new)  -> 10.3.1
```

Re-audit: **No known vulnerabilities found.** These advisories were already live
in prod (the lockfile was unchanged since 2026-08-02), so the release did not
introduce them — but the gate is mandatory and shipping past it silently would
have carried them another release. **Re-check the pinned versions against
`pnpm audit` every deploy**; an override rots the moment a new advisory lands.

Preflight green (in the worktree): typecheck clean across all 5 projects,
**3776 tests** (bot 3256 / shared 273 / webapp 247, 257 files, 0 failed),
`pnpm build`, `security:secrets` (1012 files), `security:audit` 0 advisories,
`openapi:lint` valid.

rsync dry-run listed **189 deletions, every one reviewed**: 11 docs/scripts
retired by `1e6db50` + `27ef241`, 1 stale `apps/bot/src/admin/server.ts.bak.*`
(snapshotted to `/root/` first), and 176 gitignored `apps/video/{build,out}`
artifacts — Remotion output that is not in the bot runtime, all but 2 also
present on the Mac, and only on the droplet because the documented exclude list
covers `dist/` but not `build/` or `out/`.

**Two droplet-only DB backups would have been destroyed by `--delete`, not
one.** This file already said to add `--exclude '*-backup-*.json'` for the
ethnicity backup; it does **not** mention the second file, which is 3.3 MB:

```
/opt/gennety/ethnicity-backup-2026-08-02T08-26-08-301Z.json   (1 KB)
/opt/gennety/prod-backup-2026-07-27T14-08-06-066Z.json        (3.3 MB)
```

One pattern covers both. Verified present after the sync, along with both
`keys/*.p8`.

**Two `.env` changes**, both applied before the single restart:
`ADMIN_TEST_TELEGRAM_IDS=-153639032722566` (was missing entirely — the
account-health block's own check fails without it) and the Premium price
`PREMIUM_STARS` 500 → **750**, `PREMIUM_PRICE_USD_DISPLAY` $11.99 → **$17.99**
(founder decision this session; 0 purchases ever, so no cohort is grandfathered).

**✅ App Store Connect closed the same day (2026-08-07, founder-driven).**
`premium_monthly` was raised $9.99 → **$17.99/mo** on the US storefront; Apple
auto-generated the other **175** storefronts (CA $24.99, UK £17.99, AT €19.99,
AU $29.99, …), none hand-edited. Verified by reloading the product page rather
than from the confirmation dialog: US shows 17,99 $ under "current price for new
subscribers" with **"upcoming changes (0)"** — i.e. it is the live price, not a
scheduled future one. No existing-subscriber prompt and no start-date picker
appeared, which is consistent with zero subscribers and no prior price history.
`ticket_1` / `ticket_3` / `ticket_6` were not touched. The two rails now quote
the same number.

**Post-deploy verified (measured, not inferred):**

- Prod tree is **byte-identical to the deployed worktree across all 728 files**
  (`.ts/.tsx/.prisma/.json` under `apps/` + `packages/`), by md5 sweep.
- `pm2`: PID held, restart count 50 → 51 (one increment, no loop), **zero
  `P2022` / `P2023` / unhandled / `ERR_MODULE_NOT_FOUND` from the new PID**.
- All 16 crons + `[worker] Peer-wait shimmer every 20000ms` registered.
  `venue-concentration-alert` correctly absent — its flag is unset.
- `/v1/app/config` now serves **`features.telegramAuth: true`** and
  **`ticketProducts`** (3 products) — both new, both previously missing.
- `POST /v1/auth/telegram` → **400 `{"error":"Missing idToken"}`** (was 404).
  It is live rather than 503 because `TELEGRAM_LOGIN_CLIENT_ID` was already set
  on the droplet, ahead of its code.
- All 10 new modules present on the droplet (`emergency-cancel`,
  `date-day-activity`, `venue-origin`, `telegram-login`, `outcome-gate`,
  `calendar-native`, `ticket-gate`, `telegram-auth`, `user-health` ×2).
- `/admin/stats` → **`userHealth.byClass.test = 1`**, which is this file's own
  stated proof that `ADMIN_TEST_TELEGRAM_IDS` landed.
- Loaded config re-read from the running process: `PREMIUM_STARS = 750`,
  `PREMIUM_PRICE_USD_DISPLAY = $17.99`.
- All **11 Mini App pages 200**; assets 57 → 76; `verification.html` carries the
  hand-inlined butterfly mark; the 12 preference photos shipped (~516 KB, inside
  the ~530 KB budget) and the onboarding chunk is 124.5 KB as documented.
- Demo redeployed and **isolation re-confirmed from its own banner**:
  `@gennety_demo_bot`, database `aws-1-eu-west-1.pooler…` (prod is `aws-0-…`,
  a different Supabase project), drop matching not scheduled.
- `api-admin` unauthenticated → 401; `/v1/ping` ok.

**Not verified, and deliberately so:** every flow needing a live match. Nothing
has reached `negotiating_venue` or `scheduled`, so `venue_selection_logs` is
**0 rows** and `live_activity_tokens` is **empty** — the geo-ladder `geoRung`
query, the Live Activity `date_day/start` row and the date-card path have no
data to check and remain unexercised in production. Walk them on
`@gennetytestbot`.

**A note this file kept getting wrong: production does NOT have "0 matches
ever".** It has had **2**, both from the real Thursday drop —
`2026-07-30 15:00Z` (expired) and `2026-08-06 15:00Z` (cancelled), both
`source = weekly`, neither reaching a date. The claim was true when first
written and was then copied forward into every new block. Corrected in the
blocks below; older blocks keep it as the historical record they are.

**Rollback:** re-sync a clean worktree at `7f19a72` and redeploy the Mini App
from it. No schema to undo. Restore `.env` from the `.env.bak.*` snapshot taken
during this deploy to return the Premium price and drop
`ADMIN_TEST_TELEGRAM_IDS`.

---

**Deployed 2026-08-07 (was PENDING) — emergency cancellation reaches the native client, and the partner
finally gets a push (PRODUCT_SPEC §Phase 4 → Emergency Protocol).** Deployed 2026-08-07. **No Prisma schema change, no env change, no flag change, no Mini
App change** (`apps/webapp` untouched) — half of it is client, so the iOS app
ships with it (separate repo).

Cancelling a scheduled date existed only as a Telegram callback flow. An
iOS-only user could not call off a date at all. New:
`POST /v1/matches/{id}/cancel` (JWT), with everything irreversible moved into
`services/emergency-cancel.ts` and shared by both rails.

**Three things worth knowing before the restart:**

- **A mobile partner now gets a push, and did not before.** The Telegram
  handler carried a comment claiming one was "dispatched separately"; nothing
  sent it. A mobile-only partner learned their date was off only by opening the
  app. Expect one new push per cancellation — localized, and deliberately
  **without the reason**, which is someone else's free text and does not belong
  on a lock screen.
- **The Telegram path now writes with `updateMany` (a CAS), not `update`.**
  Same outcome, but two clients racing — the partner cancelling from Telegram
  at the same moment — produce one cancellation and one refusal instead of two
  sets of refunds.
- **The client owns the two-step guard, the server does not.** That is
  deliberate and worth knowing before someone reads the route as under-
  validated: a confirmation the caller can skip is not a confirmation, and the
  irreversible step here is the request itself. The reason IS enforced (400 on
  empty), because forwarding it verbatim is the product rule.

Post-deploy check — production has **0 dates ever** (2 matches, neither reached `scheduled`), so nothing exercises this
until a pair schedules; verify on `@gennetytestbot`. Mounted-ness is checkable
without one:

```sh
# 401 (mounted), never 404 (missing).
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://dating-api.gennety.com/v1/matches/00000000-0000-4000-8000-000000000000/cancel
pnpm openapi:lint
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. The Telegram flow returns to its own copy of the logic.

---

**Deployed 2026-08-07 (was PENDING) — the «date day» Live Activity gets driven from the server
(PRODUCT_SPEC §Phase 4).** Deployed 2026-08-07. **No Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched) — it is
half client, so the iOS app must ship with it (separate repo).

`live_activity_tokens` and `sendLiveActivityUpdateToUser` have existed since
Stage 0 with **no production caller at all**: the transport was built and never
wired, so `date_day` was a row shape and nothing more. Now the date lifecycle
drives it — push-to-start at T-5h alongside the ice-breakers, a `wingman` stage
update at T-1.5h, and an end sweep at T+2h.

**Four things worth knowing before the restart:**

- **`APNS_KEY_PATH` must actually resolve.** This is the first feature whose
  value is *entirely* in reaching a phone that is not being looked at, so an
  unloadable key degrades it to nothing rather than to less. The 2026-07-25
  rsync deleted `/opt/gennety/keys/` once and APNs was silently dead for nine
  days; re-check `ls -l /opt/gennety/keys/` before believing this shipped.
- **Push-to-start is a new payload shape**, not a new endpoint:
  `buildLiveActivityStartPayload` adds `event: "start"` with `attributes-type`,
  `attributes` and a required `alert`. `attributes-type` must equal the Swift
  struct name **verbatim** (`DateDayActivity`) — ActivityKit drops an
  unresolvable start push in complete silence, so a client-side rename is a
  breaking change with no error anywhere.
- **The alert is user-visible.** A start push necessarily raises a
  notification, so a mobile user now gets one more push on date day than
  before — localized, once, at T-5h.
- **The `chat_open` stage is defined and deliberately never sent.** The
  pre-date proxy chat is Telegram-only until the native chat screen lands, and
  announcing an open chat on a lock screen the app cannot follow is the
  dead-button anti-pattern.

Post-deploy check — production has **0 dates ever** (2 matches, neither reached `scheduled`), so nothing exercises this
until a pair schedules; verify on `@gennetytestbot`. The lifecycle logs only on
failure, so silence is the good case:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep 'date-day activity'
psql "$DATABASE_URL" -c "select activity_type, kind, count(*) from live_activity_tokens group by 1,2;"
```

A `date_day / start` row appearing is the proof the client half landed.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag; the card simply never starts and the Telegram beats are unchanged.

---

**Deployed 2026-08-07 (was PENDING) — the Mini App loading screens become the brand mark: butterflies in
the stomach (PRODUCT_SPEC → Cross-Cutting Concerns).** Deployed 2026-08-07.
**No Prisma schema change, no env change, no flag change, and NO SERVER CODE
CHANGE AT ALL** — the diff is `apps/webapp/**` plus this file and
PRODUCT_SPEC.md. So this is the **Deploy Mini App Only** path
(`./scripts/deploy-webapp.sh`); there is nothing to rsync to `/opt/gennety` and
**no `pm2 restart`**. Running the full server deploy for it would only risk
shipping whatever else is in the working tree.

The generic spinning ring is replaced on the seven full-screen waits that had
one — Verification, the Date Ticket gate, the Ticket Store, Premium, Referral,
Venue Change, and the Type Radar submit — by a faint line-drawn waist with three
of the logo's own butterflies flying inside it. The contextual boot screens that
already say something the generic mark cannot are deliberately untouched (the
Location map pin, the radar card-stack skeleton, the onboarding orb), as are the
16px in-button spinners.

**Three things worth knowing before the redeploy:**

- **`verification.html` carries a hand-inlined COPY of the mark** (markup + the
  animation CSS), because that shell paints before the bundle exists and
  verification.ts renders the identical mark once it loads — otherwise the
  handover is a visible ring→butterfly swap on the one screen a user is already
  nervous on. `butterfly-loader.test.ts` fails if the two drift, including if a
  keyframe or custom property is added to the module and not to the shell.
- **That same file was missing `--text-faint`.** Its theme tokens are inlined by
  hand and are supposed to mirror theme.css; the gap was invisible until the
  belly stroke resolved through it, and an unresolvable `var()` on `stroke`
  means NO stroke, so the torso vanished and left three butterflies floating on
  a blank screen. Found by screenshotting the real `?screen=loading` preview.
  Both the token and a themed fallback in the shared CSS are in.
- **Demo mode needs `pnpm demo:deploy`** to pick it up (it builds its own bundle
  from the same source). No gate, no paid step, no negotiation step, so
  `apps/bot/src/demo/decide.ts` is untouched.

Post-deploy check — the loading states are transient, so verify through the
dev-only preview and by eye rather than from logs:

```sh
./scripts/deploy-webapp.sh
for p in verification premium referral radar ticket tickets venue-change; do
  curl -sI "https://dating-calendar.gennety.com/$p.html" | head -1
done
# The real loading screen, both themes (this route is import.meta.env.DEV-gated
# in verification.ts, so use the dev server / dev bot for it):
#   http://localhost:5173/verification.html?screen=loading&lang=ru&theme=dark
```

**Rollback:** redeploy the Mini App from the previous checkout. Nothing else to
undo — no schema, no env, no flag, no server state.


**Deployed 2026-08-07 (was PENDING) — two contract fields the native client could not see
(PRODUCT_SPEC §3.7 / §3.8).** Deployed 2026-08-07. **No Prisma schema change, no
env change, no flag change, no Mini App change** (`apps/webapp` untouched) — it
is half client, so the iOS app must ship with it (separate repo, `a2b1b38`).

Both halves of `SerializedMatch`/`VenueIntentState` are read-only additions; the
server-side behaviour they describe already ships.

**Two things worth knowing before the restart:**

- **`VenueIntentState.market` is a schema fix, not a new field.** It was added
  on 2026-08-05 with the departure-point gate and declared
  `oneOf: [$ref Market, "null"]` — the shape swift-openapi-generator SKIPS
  silently — so it never reached the generated Swift client and the live gate
  existed on Telegram only. The wire format is unchanged: it is now a bare
  `$ref`, and the server still sends an explicit `null`, which an optional
  property decodes to absent. The Mini App reads `state.market` and is
  unaffected either way.
- **`SerializedMatch.timeZone` is genuinely new** — the CALLER's own city zone,
  from `Profile.timeZone`. `agreedTime` is an instant and the native date card
  has to draw it on a wall clock; the device's is wrong for a traveller. Same
  reason `CalendarState.timeZone` exists (block above). One extra `profile`
  select on `/v1/matches/current`, no new query.

Post-deploy check — `/v1/matches/current` needs a real match and production has
**2 matches ever, both terminal**, so verify the shape on `@gennetytestbot` via
`scripts/dev-e2e-full-flow.mjs`. The spec itself is checkable without one:

```sh
curl -s https://dating-api.gennety.com/v1/app/config >/dev/null && echo mounted
pnpm openapi:lint
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. `timeZone` simply stops being sent and the iOS card falls back to
the device zone; `market` reverts to the shape iOS cannot read, i.e. the state
this fixes.

---

**Deployed 2026-08-07 (was PENDING) — the slot calendar becomes reachable from the native client
(PRODUCT_SPEC §3.6).** Deployed 2026-08-07. **No Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched) — it is
half client, so the iOS app must ship with it (separate repo, `d345bca`).

Ships alongside the ticket-gate block below and has the same shape: the server
has always written `proposedTimes` for every `negotiating` match whichever
client accepted, but the only way to read or answer that grid was
`/v1/calendar/*`, which is `initData`-authed. An iOS pair reached scheduling
and had no calendar at all. New: `GET`/`POST /v1/matches/{id}/calendar` (JWT).

**Three things worth knowing before the restart:**

- **No new scheduling logic.** Both verbs delegate to `getCalendarState` /
  `processCalendarSlotsUpdate` unchanged, so auto-lock, `overlapCandidates`,
  the first-mover DM and the peer's live card behave identically to the Mini
  App. Nothing about the Telegram path moves.
- **The response carries the pair's `Profile.timeZone`.** Read-only, additive.
  It exists because the grid is a set of instants and the client has to pick a
  wall clock; the device's is the wrong one, since the date happens in the
  pair's city.
- **A closed calendar answers 409**, matching how the native ticket gate
  reports the same class of state. The Mini App routes are untouched and keep
  their existing codes.

Post-deploy check — the route needs a real `negotiating` match to answer
anything but 401, and production has **2 matches ever, both terminal**, so verify on
`@gennetytestbot` via `scripts/dev-e2e-full-flow.mjs`:

```sh
# Unauthenticated must be 401 (mounted), never 404 (missing).
curl -s -o /dev/null -w '%{http_code}\n' \
  https://dating-api.gennety.com/v1/matches/00000000-0000-4000-8000-000000000000/calendar
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag; the Mini App calendar is unaffected either way.

---

**Deployed 2026-08-07 (was PENDING) — the Date Ticket gate becomes reachable from the native client
(PRODUCT_SPEC §3.5b).** Deployed 2026-08-07. **No Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched) — but it
is half client, so the iOS app must ship with it (separate repo, `368918b`).

The gate has been arming on the mobile mutual-accept path for a while:
`matches-service.ts` calls `sendTicketOffer` whenever `TICKET_FEATURE_ENABLED`,
whichever client committed the decision. What did not exist was any way to
*read* or *settle* it from `/v1/*` — the Mini App's `/v1/matches/:id/ticket`
routes are `initData`-authed, and an app user has no Telegram session to sign
with. So an iOS-only pair sat in a `negotiating` match with no Calendar and no
way to pay until the partial window lapsed and the expiry cron opened
scheduling for free. **Inert in production today** (`TICKET_FEATURE_ENABLED` is
the gate on all of it), which is why this shipped as a hole rather than as an
outage.

**Four things worth knowing before the restart:**

- **`SerializedMatch` grows one field, and it is deliberately NOT `ticketStatus`.**
  That column defaults to `"pending"` on every row the table has ever held, so a
  match from before the feature existed is indistinguishable from an open gate.
  `ticketGate` (`none|open|reveal`) is derived from `ticketExpiresAt`, which is
  what `sendTicketOffer` actually stamps and what both completion and expiry
  clear. `reveal` is load-bearing: the server holds the covered side's Calendar
  back until she opens the surprise, so a client routing her to planning would
  strand her on an empty screen.
- **`/v1/app/config` now serves `ticketProducts`** (from
  `APPSTORE_TICKET_PRODUCTS`, empty while tickets are off) and `/v1/me` serves
  `ticketBalance`. Both additive. The product list is served rather than
  hard-coded because a StoreKit id the app knows and this server does not is a
  purchase that takes money and then 422s on report.
- **On iOS the wallet is the only rail.** StoreKit credits it through the
  already-deployed `/v1/tickets/appstore/transaction`; the gate only spends from
  it. No new payment path, no new provider, no new refund surface — a settle
  that loses its race returns a ticket to the wallet exactly as the Stars gate
  already does. The famine discount is USD-only and does not apply.
- **Demo mode is unaffected.** The demo bot walks the gate on the shipped mock
  rail through the Telegram Mini App; the new routes are JWT-only and
  unreachable from a bot chat, and the puppet still settles its half with
  `useTicketFromBalance`. No branch needed in `demo/decide.ts`.

Post-deploy check — the routes 404 while tickets are off, which is the correct
answer and also the proof they are mounted (an unmounted path answers 404 from
the JWT `matches` router with a different body):

```sh
curl -s https://dating-api.gennety.com/v1/app/config | python3 -m json.tool | grep -A4 ticketProducts
# With TICKET_FEATURE_ENABLED off: [] — and the gate route is unreachable.
curl -s -o /dev/null -w '%{http_code}\n' https://dating-api.gennety.com/v1/matches/00000000-0000-4000-8000-000000000000/ticket-gate
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag. `SerializedMatch.ticketGate` simply stops being sent; the iOS
build treats a missing gate as `none`, which is what it already does with
tickets switched off.

---

**Deployed 2026-08-07 (was PENDING) — the departure point must be in a launched city, and the venue
engine stops failing on geometry (PRODUCT_SPEC §3.7).** Deployed 2026-08-07. **No
Prisma schema change, no env change, no flag change** — but it is half client,
so it **DOES need a Mini App redeploy**: Deploy Full Server Code →
`pnpm db:drift-check` → `pm2 restart` → `./scripts/deploy-webapp.sh` →
`pnpm demo:deploy`.

The venue step asked "where are you setting off from?" and accepted **any point
on Earth** — the only check was that the coordinates were numbers. Registration's
city has had a real gate since the Kyiv-only launch; this one had none, on the
same data. Nothing fake was ever assigned (the ranker discards anything past the
commute cap), which is exactly why it was invisible: the run found nothing, the
pair sat in `negotiating_venue`, and 48 h later the §3.5c chain cancelled them
with a lifetime pair ban. The one message they got told them to "relax the
suggested condition" — a condition they never set, on a screen with nothing to
relax, and with no button to reopen it.

**Server first is safe and the order matters.** The gate lives in
`services/venue-origin.ts` and every write path goes through it, so a cached
older bundle keeps working — it just discovers the refusal as a `400` instead of
on-screen. The reverse order would ship a client gating against a `market` field
the server does not yet send, which degrades to no gate at all.

**Four things worth knowing before the restart:**

- **`GET /v1/location/search` now resolves the DB user** (it restricts Places to
  the caller's own market instead of merely biasing toward it, so "Berlin
  Hauptbahnhof" is not in the list at all). A caller with no `User` row now gets
  `404` where it used to search. Unreachable in practice — the route is
  initData-authed from inside a match — but it is a real contract change.
- **The engine now retries with wider geometry instead of failing.** Rung 1 is
  today's behaviour and covers the ordinary case; rungs 2 (12 km) and 3 (the
  market radius) exist because two people at opposite ends of Kyiv — Troieshchyna
  ↔ Vyshneve is ~30 km — could not be served at all. **Only the two distance caps
  move**; quality, hours, price policy and hard constraints are identical on
  every rung. Watch how often it fires: a rung above 1 is normal occasionally and
  means a thin catalog if it is routine.
- **The no-candidates failure now also DMs the founder ops feed** (it schedules
  no retry, so it is a live match about to be lost) and carries a button back
  into the venue screen. Expect ops-feed traffic that did not exist before —
  `FOUNDER_NOTIFY_ENABLED` is on in production.
- **Nothing exercises any of this until a pair reaches `negotiating_venue`.**
  Production has **2 matches ever, both terminal**, so verify on `@gennetytestbot` (needs an
  HTTPS tunnel and `WEBAPP_URL` pointed at it) via
  `scripts/dev-e2e-full-flow.mjs`.

Post-deploy check — the gate refuses server-side even with the client bypassed,
and the ladder names itself in the selection reason when it fires:

```sh
# Berlin coordinates from a Kyiv account must be refused, not saved.
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PUBLIC_BASE_URL/v1/location/select" \
  -H 'content-type: application/json' \
  -d '{"matchId":"<uuid>","lat":52.525,"lng":13.369}'   # expect 400
pm2 logs gennety-bot --lines 200 --nostream | grep 'widened to rung'
psql "$DATABASE_URL" -c "select top_candidates->'poolSizes'->>'geoRung' rung, count(*) from venue_selection_logs group by 1;"
```

`rung = 1` for essentially every row is the healthy state.

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo — no schema, no env, no flag. Departure
points already saved stay valid; they are the same columns as before.

---

**Deployed 2026-08-07 (was PENDING) — Premium is $17.99/mo = 750⭐ (PRODUCT_SPEC §3.8).** Deployed 2026-08-07. **No Prisma schema change, no flag change** — but it needs a **two-line
`.env` edit** and a **Mini App redeploy**, and one step of it is not in this
repo at all (App Store Connect). Sequence: `.env` → Deploy Full Server Code →
`pnpm db:drift-check` → `pm2 restart gennety-bot --update-env` →
`./scripts/deploy-webapp.sh`.

The charge is Stars, and the dollar figure is only ever a description of what
those Stars cost: **750⭐ is exactly what Telegram's own Star store bills
$17.99 for**. That is why the two values are edited together and why the code
comment now says so — a label cheaper than the Stars it spends is the one kind
of wrong price that takes money from a user who was told otherwise.

**⚠️ The code defaults are NOT what production runs.** `/opt/gennety/.env`
carries explicit `PREMIUM_STARS=500` / `PREMIUM_PRICE_USD_DISPLAY=$11.99`,
which override them, so deploying the code alone changes nothing a user sees:

```sh
ssh root@167.172.178.229
cd /opt/gennety
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
sed -i 's/^PREMIUM_STARS=.*/PREMIUM_STARS=750/;
        s/^PREMIUM_PRICE_USD_DISPLAY=.*/PREMIUM_PRICE_USD_DISPLAY=$17.99/' .env
grep -n '^PREMIUM_' .env    # expect 750 and $17.99
pm2 restart gennety-bot --update-env && pm2 save
```

**Three things worth knowing before the restart:**

- **The iOS price is Apple's, and nothing here can set it.** The native app
  renders StoreKit's `displayPrice` for `premium_monthly`. It was **$9.99** in
  App Store Connect and was raised to **$17.99** by the founder on 2026-08-07,
  so the two rails now agree — but note the shape of the dependency, because it
  is permanent: `/v1/app/config` exposes only `features.premium`, a boolean.
  There is no server-side price for iOS to read, so **no code change and no
  deploy can ever move the App Store price** — every future change to
  `PREMIUM_PRICE_USD_DISPLAY` needs a matching manual edit in App Store Connect,
  or the two surfaces silently diverge again with nothing in this repo showing
  it.
- **Existing subscribers keep their old price until they resubscribe.** A
  Telegram Stars subscription's amount is fixed on the invoice that created it,
  and `pre_checkout_query` validates against the *current* `PREMIUM_STARS`
  (`handlers/payments.ts`), so an already-recurring 500⭐ subscription keeps
  renewing at 500⭐ while any new invoice is 750⭐. Production has had **0
  purchases ever**, so today that cohort is empty — verify before assuming it
  stays that way.
- **Referral rung values move with it.** `referralUsdValue` parses
  `PREMIUM_PRICE_USD_DISPLAY`, so the ladder's "≈ $ value" column rises
  (1 friend: $18.98 → $24.98). Inert in production —
  `REFERRAL_FEATURE_ENABLED=false`.

Post-deploy check — the state endpoint is the single source both surfaces read:

```sh
# Needs initData, so verify from the Premium Mini App itself; the button must
# read "Оформить — $17.99/мес" and the Stars sheet must say 750.
pm2 logs gennety-bot --lines 50 --nostream | grep -i premium
```

**Rollback:** restore the `.env.bak.*` snapshot and
`pm2 restart gennety-bot --update-env`. The code defaults are then overridden
back to the old price with no redeploy; revert the commit at leisure.

---

**Deployed 2026-08-07 (was PENDING) — the first five profile questions move from the chat into the Mini
App (PRODUCT_SPEC §1.1 / §1.3).** Deployed 2026-08-07. **No Prisma schema change,
no env change, no flag change** — every column it writes (`users.first_name`,
`age`, `gender`, `preference`, `profiles.height`) already exists. But it is
half client, so it **DOES need a Mini App redeploy**, and the order matters:
Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh`.

Name, age, gender, who-you're-looking-for and height now have their own screens
in the onboarding Mini App — a text field, an age slider, tinted choice buttons
and a scroll-snap height drum — sitting between the welcome-gift screen and the
AI-memory choice. The chat then opens on `hobbies` instead of "как тебя зовут?".
These are the five questions with exactly one correct answer out of a finite
set, which a Telegram chat cannot ask for: the bot asked in prose and recovered
the value with a regex or an LLM. iOS already had the right controls here
(`ui-hints.ts`); its `/v1/*` contract is untouched.

**Server first is safe, and that is the point.** The new
`POST /v1/telegram-onboarding/profile` simply has no callers until the bundle
ships, and a cached older bundle keeps working on the old path: `/complete`
deliberately does NOT require the five fields, so anything the Mini App did not
deliver is asked for in the chat exactly as it is today. There is no version of
this change where a user gets stuck at the handoff.

**Three things worth knowing before the restart:**

- **It writes through the collector, not through Prisma.** `applyOnboardingFacts`
  reuses `collectOnboardingInput`'s save block, so `onboarding_progress`
  advances under the same revision compare-and-set and the funnel keeps getting
  one `onboarding_step_events` row per real transition. Expect the funnel's
  `first_name_age` / `gender` / `preference` / `height` rows to start arriving
  with `platform: "telegram"` seconds after the Mini App opens rather than
  minutes into a chat — the numbers move, the meaning does not.
- **`MIN_HEIGHT_CM` / `MAX_HEIGHT_CM` moved into `@gennety/shared`.** They were
  literals in the collector and a private copy in `ui-hints.ts`; both now read
  the shared constant, and `/state.profileLimits` serves the same values to the
  Mini App. Values are unchanged (140/220), so nothing shifts — this only
  removes the second place a bound could drift.
- **Nothing exercises the drum until someone registers.** Production onboarding
  is low-volume, so verify on `@gennetytestbot` first (needs an HTTPS tunnel and
  `WEBAPP_URL` pointed at it). For design review alone there is now a preview
  that needs no Telegram and no account:
  `http://localhost:5173/onboarding.html?preview=basics:height&lang=ru&theme=light`
  — `import.meta.env.DEV`-gated, so it does not exist in the production bundle.
- **The tap burst rides along, and it is client-only** (added 2026-08-06,
  PRODUCT_SPEC §1.3). Tapping an option on the gender / preference screens
  throws a themed particle burst from the touch point. No server change, no env,
  no schema — it lives entirely in the Mini App bundle, so the
  `./scripts/deploy-webapp.sh` step above is the whole deploy for it, and
  skipping that step is what would ship the screens without it. Review it with
  `?preview=basics:gender` (or `basics:preference`) on the same dev-only route.
- **So does the preference photo fork** (added 2026-08-06, PRODUCT_SPEC §1.3).
  "Who do you want to meet?" becomes two tall photo columns over a smaller,
  quieter "both". Also client-only — no server change, no env, no schema — but
  it carries three things the burst did not:
  - **Photos ship inside the bundle**, and they are the one thing here with a
    real user cost. They live in `apps/webapp/src/preference/photo/{men,women}/`,
    enumerated by `import.meta.glob`. The screen downloads **~530 KB** (12
    photos, six per side) against a 124 KB onboarding chunk, over mobile data,
    inside Telegram. That is the budget; check it if the set ever changes. It
    grew from 440 KB with the sixth photo per side. (The dropped second design
    held one group image per side in a `cutout/` folder — ~330 KB; that folder
    is gone, see the last bullet.)
    **Never copy originals in by hand.** They are 2–6 MB PNGs, ~40 MB across the
    set. `~/Desktop/gennety-preference-photos/prepare.mjs` is what resizes,
    re-encodes and trims them into the repo; the naive `sync.sh` that preceded
    it was deleted precisely because running it shipped the originals. **Run it
    with no flags.** It still writes a `cutout/` folder the app no longer reads,
    and its `--tight` flag only ever narrowed that artwork — both are dead
    weight now, harmless because nothing globs that path.
  - **`onboarding.html` requests Inter 800**, and **must keep doing so** (the
    Google Fonts URL previously stopped at 700). It was added for the dropped
    design's heavy word, and an earlier revision of this bullet said to drop
    `;800` again if the other design won — **that is now wrong**: «Парней» /
    «Девушек» were made 800 on 2026-08-07 and would fall back to a synthesised
    bold. One extra font file for every onboarding user.
  - **One design, no switch (2026-08-07).** `preference-variant.ts`, the `?v=`
    override, the on-screen V1/V2/both toggle, the stacked review page, the
    variant-2 CSS and the `cutout/` artwork are **deleted** — the founder
    settled on the photo scatter. `?v=` is now inert rather than removed-and-
    erroring: it is simply read by nothing. The deleted design is recoverable
    from git history (`git show 8190fea:apps/webapp/src/preference-variant.ts`
    and the paths beside it); it is not recoverable from a flag, on purpose.
  - **The photo scatter was tidied 2026-08-07** — the
    white frames and the dark hairlines inside them are gone (the frame's
    `border-box` shrank the tile's content box below the photo's own ratio, so
    `object-fit: contain` letterboxed all twelve), and the bottom band no longer
    runs under «Парней» / «Девушек». Still client-only. Two things worth
    knowing: the tiles are now `object-fit: cover`, so **the folder must stay
    9:16** or a photo gets cropped instead of showing a margin (`prepare.mjs`
    already preserves the source ratio, so this only bites a hand-copied file);
    and the label's strip is reserved in CSS (`--pref-label-zone`) while the
    bottom slots are authored against the **tightest** column, so a slot's `y`
    is bounded by `maxCentreY` and a test enforces it — verify on a short
    viewport (320×568), not only on 390×844, if those numbers are ever touched.
    Byte cost unchanged. The same pass made «Парней» / «Девушек» heavier (Inter
    800, larger) — which is why the strip and `TIGHTEST_AREA_RATIO` moved with
    it: the reservation is sized to the label, so the two are edited together or
    the photos land on the word again. Inter 800 was already being loaded, so no
    new font request.
- **And so does the height drum's per-row tick** (added 2026-08-06,
  PRODUCT_SPEC §1.3). The drum pulses `HapticFeedback.selectionChanged` as each
  value passes under the capsule instead of once when the scroll stops, and its
  row height drops 56px → 38px, which is the drum's gearing: a native scroll is
  1:1 with the finger, so one swipe now crosses ~47% more values and a flick
  genuinely spins. Client-only — no server change, no env, no schema — so
  `./scripts/deploy-webapp.sh` is again the whole deploy, and **skipping that
  step ships the drum unchanged**. Three things worth knowing:
  - **The row height is duplicated by construction.** `WHEEL_ITEM_H`
    (`onboarding-wheel.ts`) and `.ob-wheel-item` / `.ob-wheel-capsule` /
    `.ob-wheel-pad` in `onboarding.css` must agree, and nothing enforces it —
    the pad is `(280 − row) / 2`, so a change in one place alone silently
    stops the first and last values from reaching the centre. Verified on the
    dev preview after this change: row 38, capsule 38, pad 121, active row
    centred on the capsule to within a pixel, ~7 rows in frame, in both themes.
  - **38px is near the floor, not a midpoint.** It is about where a native iOS
    picker row sits, and the numerals are 28px, so there are only a few px of
    air left. A further increase in sensitivity has to come from somewhere
    other than this number — and there is nowhere honest: the scroll is
    native and 1:1 by design. Dropping `scroll-snap-type` to `proximity`
    would lengthen flings but let one land between two values, which the
    settle handler does not re-centre.
  - **Haptics are not gated on `prefers-reduced-motion`.** That setting is
    about motion; iOS and Telegram honour their own haptic settings below us.
  Review with `?preview=basics:height` on the same dev-only route.
- **Demo mode picks all of it up for free.** The screens are the same source
  behind the same Mini App build, so `pnpm demo:deploy` (which builds its own
  bundle) is the whole story — no gate, no paid step, no negotiation branch, so
  `apps/bot/src/demo/decide.ts` is untouched.

Post-deploy check — the route logs its own line on every screen, so one walk
through onboarding on the dev bot should print five of them:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep 'profile-saved'
# And the state the chat reads from, for one test account:
psql "$DATABASE_URL" -c "select first_name, age, gender, preference from users order by created_at desc limit 3;"
psql "$DATABASE_URL" -c "select current_question from onboarding_progress order by updated_at desc limit 3;"
```

`current_question = 'hobbies'` on a fresh account is the proof the handoff
landed where it should.

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo — no schema, no env, no flag. Any
profile data already written by the screens stays valid; it is the same columns
the chat writes.

---

**Deployed 2026-08-07 (was PENDING) — the Type Radar stops gating a client that cannot open it.** Deployed 2026-08-07. **No Prisma schema change, no env change, no flag change** —
code-only, and Telegram behaviour is unchanged by construction
(`AgentDeps.canPresentTypeRadar` defaults to true).

**Read this one before deciding the deploy order.** `TYPE_RADAR_ENABLED=true` is
live, and the gate was written into `runAgentTurn`, which BOTH surfaces share —
while only the Telegram handler consumes `typeRadarRequested` and attaches the
buttons that clear it. So on the native rail the invite came back as a bare
question on every turn with nothing to tap, and the collector never advanced
past `context_dump`/`photos`. **iOS onboarding has been impassable in production
since that flag was flipped**, which also means the founder's pending live runs
(4 real photos through Rekognition, the end-to-end liveness pass) cannot be done
until this ships. Nothing else in the backlog blocks them.

Telegram is unaffected either way, so this changes no behaviour a current user
sees — but it was the one PENDING block whose absence was actively blocking work.
Commit `e0079df`; regression test `onboarding-agent.test.ts` → "does not gate a
caller that cannot present the radar". Full reasoning: TYPE_RADAR_PRODUCT_SPEC.md
→ «Mobile parity».

**Shipped ahead of the rest of the backlog, as a targeted two-file hotfix
(2026-08-07 12:24 UTC).** It was the only blocking block, so it did not wait for
the 84-commit release below. The hotfix was safe *specifically* because both
files it touches — `services/onboarding-agent.ts` and
`public/routes/onboarding.ts` — are changed by **exactly one commit** in the
whole `7f19a72..c25adbc` range (verified with `git log -- <path>`), so prod's
version plus `e0079df` IS the target version and the change pulls in no module
prod did not already have. That is the condition the 2026-08-01 incident note
above is really about; check it with `git log` before ever repeating this,
because a file touched by two commits does not satisfy it.

Procedure actually used: `pnpm --filter @gennety/bot exec vitest run
src/services/onboarding-agent.test.ts src/public/public-api.test.ts` (148
passed) → `scp` both files to the droplet under a **`.hotfix.ts`** name (not
`.ts.new` — tsx refuses an unknown extension, so the import test cannot run) →
`tsx` import-test in place, both OK → `mv` over the live files → restart.

Post-deploy verified: both files md5-match the target, PID 2298196 held, restart
count 49 → 50 with no loop, **zero errors in the error log from the new PID**,
all 16 crons + the peer-wait worker registered, and
`grep canPresentTypeRadar public/routes/onboarding.ts` shows `false` passed at
both call sites (lines 89 and 196) — which is the actual proof the native rail
is no longer gated. Superseded an hour later by the full release below, which
re-synced the same content.

**Deployed 2026-08-05 — demo mode: a second, isolated bot that walks one person
through the whole product (DEMO_MODE.md).** **No Prisma schema change, no
production env change, no production flag change** — production behaviour is
byte-identical with `DEMO_MODE_ENABLED` unset, which is how it ships. What it
adds is a SECOND deployment of the same source tree. Production was NOT
restarted: `gennety-bot` held PID 2174947 and restart count 49 across the whole
rollout.

For an investor or a friend, the only way to see the product end to end today is
to actually register, wait for a Thursday drop, and hope someone matches — i.e.
there is no way. `scripts/dev-e2e-full-flow.mjs` drives both sides from a
terminal, which is useful for engineering and useless as a demo. This is the
demo: same screens, same cards, same Mini Apps, but the partner is a puppet, the
gates wave you through, and twelve seconds stands in for two days.

**The safety property worth reading before anything else.** `DEMO_MODE_ENABLED`
makes `identityTrustConfigurationErrors` treat the process as non-production, so
it stops enforcing the liveness gate. That is why the flag is not
self-certifying: `assertDemoIsolation()` runs first at boot and refuses a
demo-flagged process that still carries production's own settings (founder
notifications on, Stars on, an admin key present). **So setting
`DEMO_MODE_ENABLED=true` in `/opt/gennety/.env` does not silently disable
verification for real users — it stops the bot from booting**, naming the
setting that gave it away. Production is unaffected either way; there is nothing
to undo on the production side.

One-time setup, all of it done on 2026-08-05 and all outside `/opt/gennety`:

1. BotFather: demo bot `@gennety_demo_bot` (id `8845048941`), `/setdomain
   demo-app.gennety.com` — without it the liveness Mini App cannot ask for
   camera permission. ✓
2. A **second Supabase project** — ref `amwalpnalqkhyiaqpqre`, distinct from
   production's `ophztqjrabwemkqwidkq`. pgvector is created by `db:push`
   because the datasource declares the extension. ✓
3. Hostinger DNS: `demo-app` and `demo-api` A records → `167.172.178.229`. ✓
4. Two Caddy blocks appended to `/etc/caddy/Caddyfile` (backup taken first) —
   `demo-api.gennety.com` → `localhost:3102`, `demo-app.gennety.com` serving
   `/var/www/demo-app`. TLS auto-provisioned. ✓
5. `/opt/gennety-demo/.env` — generated as production's `.env` **minus every
   key `.env.demo` defines, minus `FOUNDER_BOT_TOKEN`/`FOUNDER_TELEGRAM_ID`**,
   with `.env.demo` appended. Dropping the founder keys is deliberate:
   `assertDemoIsolation` only checks the FLAG, so removing the token means no
   route to the real ops chat exists even if the flag were flipped. ✓
6. Seed: `db:push` + `db:drift-check` OK; Kyiv catalog imported — **1208
   venues** (913 base / 195 premium / 100 alternative). ✓
7. `pm2 start bash --name gennety-demo --max-memory-restart 300M -- -c "cd /opt/gennety-demo && ./apps/bot/node_modules/.bin/tsx apps/bot/src/index.ts"` then `pm2 save`. ✓

**The 300 MB cap is not decoration.** The droplet has 2 GB and the demo is the
process that must die first if memory gets tight — it has no users to lose.
Production carries no such cap.

**Two things this rollout uncovered, both fixed in code:**

- `scripts/seed-venues.mjs` loaded `.env.local` with `override: true`, so
  `DATABASE_URL=… pnpm seed-venues:import --apply` **silently wrote to the dev
  database and reported success**. It surfaced as "1208 updated" against a
  database holding zero rows. This runbook tells you to run that script against
  production, and DEMO_MODE.md against the demo DB; both were unfollowable. An
  exported variable now beats every dotenv file (`.env.local` still beats
  `.env`).
- The demo photo seeder fell back to `FOUNDER_TELEGRAM_ID` for its upload chat —
  a **production**-bot chat. It failed with "chat not found", and had it
  resolved it would have posted fictional profiles into the real founder ops
  feed. It now resolves the chat from the demo DB, falling back to `getUpdates`.

**Storage isolation — closed 2026-08-06.** For the first day the demo's
`SUPABASE_URL` pointed at the **production** Supabase project (the demo
project's service-role key had not been supplied yet), with `…-demo` bucket
names. Nothing leaked, and it is worth recording why rather than just that: the
only storage write on the Telegram demo path — the liveness reference selfie —
is stubbed by `demo/verification.ts`; Telegram profile photos are `file_id`s
that never reach Supabase; the mobile/Aether upload routes are JWT-only and
unreachable from a bot chat; and `/restart` calls the real `deleteUserAccount`,
whose `collectOwnedPaths` keeps only paths prefixed `${userId}/`, so the stub
selfie path was filtered out and no storage call was made at all. A write that
did slip through would have hit a bucket that does not exist in the production
project — a loud failure, not a silent object beside real user media.

What it actually cost was the credential: the demo process held **production's
`service_role` key** for no reason. Now closed — `/opt/gennety-demo/.env`
carries the demo project's own `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`,
the three `…-demo` buckets exist there as **private**, and a real
upload → download → delete round-trip was verified against `selfies-demo`.
`SUPABASE_ANON_KEY` is read by nothing in this codebase and was blanked rather
than left holding production's value.

**Both keys belong in `.env.demo`, not only on the droplet.** The droplet's env
is generated as production's `.env` plus that file, so any key it does not name
silently inherits production's value — which is exactly how `SUPABASE_URL`
became production's in the first place.

Thereafter it is one command per release, run **after** production is verified:

```sh
./scripts/deploy-demo.sh      # or: pnpm demo:deploy
```

It syncs the same working tree to `/opt/gennety-demo`, installs, builds, pushes
the schema to the demo database with a `db:drift-check` gate, restarts
`gennety-demo`, and builds a second Mini App bundle pointed at `demo-api` into
`/var/www/demo-app` — then rebuilds `dist/` back to the production API base so a
later `deploy-webapp.sh` can never ship a demo-pointed bundle to the real host.

**Three things worth knowing before the first run:**

- **A schema change now needs `db:push` against TWO databases.** The demo deploy
  script does it and fails on drift; skipping it surfaces as a `P2022` crash
  loop on `gennety-demo` exactly as it would in production.
- **Memory.** The droplet has 2 GB with ~1.4 GB free and `gennety-bot` sits at
  ~45 MB RSS, so a second process fits — but the demo is the one to kill first
  if memory ever gets tight. It has no users to lose.
- **The demo spends real OpenAI, Places and AWS budget** (a liveness session is
  still minted, ~$0.015, even though its verdict is ignored). Small, not zero.

Post-deploy check — the banner is the proof the right process came up:

```sh
ssh root@167.172.178.229 'pm2 logs gennety-demo --lines 40 --nostream' | head -20
# Must name the DEMO bot and the DEMO database. If it names production, stop.
curl -s https://demo-api.gennety.com/v1/ping
curl -sI https://demo-app.gennety.com/onboarding.html | head -1
```

Verified on the 2026-08-05 rollout: `Bot @gennety_demo_bot started`, banner
naming the demo bot + `aws-1-eu-west-1` database, `[worker] Demo driver every
3000ms`, **`[cron] Drop matching NOT scheduled (demo mode owns matching)`** and
`[cron] No-match notice NOT scheduled` (the two that would otherwise pair two
visitors with each other), `:3102` listening, `/v1/ping` ok, **all 11 Mini App
pages 200**, no admin API (empty key), restart count 0, error log empty.

**Still outstanding at hand-off:** nobody had pressed Start on the demo bot, so
the partner photos are not uploaded yet — `pnpm demo:seed -- --photos=<dir>`
needs one real chat to mint per-bot `file_id`s. The profiles themselves (Артём
29, Ева 25) are seeded and the demo runs; the pitch just has no images until
that step.

**Follow-up 2026-08-06 — the scheduled date gets minutes, and the demo stops
looping (`apps/bot/src/demo/` only, DEMO_MODE.md).** Ships with
`pnpm demo:deploy`; **production is not restarted for it** and nothing outside
`apps/bot/src/demo/` changed. Three defects from one walkthrough, all in the
same stretch of the flow:

- The pre-date replay fired **12 s** after the date locked in, burying the date
  card — the venue-change board, Open in Maps, the blurred share copy — under
  five more messages. It now hands the card over with a note plus a **«Что
  происходит дальше»** button and continues on the tap, or after 7 minutes.
- The post-date feedback flips `scheduled` to `completed`, which is terminal
  exactly like a pass — so finishing the demo produced the **decline** copy
  ("a pass is final, this pair will never be shown again"). The two endings now
  have their own copy.
- The "show me the profile again" button was decorative: the offer deleted the
  finished rows to make itself one-shot, the next tick could not tell that from
  "the demo has not started", and a fresh profile arrived 12 s later whether or
  not anyone tapped. The rows now stay until the tap.

Post-deploy check: walk one demo to a scheduled date and confirm the card sits
alone until the button, and that finishing the feedback form ends with the
🎬 closing message and nothing else.

**Follow-up 2026-08-07 — the photo note stops firing under the Type Radar
invite (`apps/bot/src/demo/` only, DEMO_MODE.md).** Same shape: ships with
`pnpm demo:deploy`, **production is not restarted**, nothing outside
`apps/bot/src/demo/` changed, no schema, no env, no Mini App.

Reported as "the note before photos isn't there in demo mode". It was — in the
wrong place. `TYPE_RADAR_ENABLED=true` on the demo box, so the radar gate
intercepts the photos question *before* it is asked: the collector writes
`currentQuestion = "photos"`, the chat gets the radar invite, and the demo's
note (which the beat fired on that column) landed underneath it. The visitor
then spent several minutes inside the radar Mini App, sat through the ~13s
thinking sequence, and got the photo request — by which point the note was four
screens up. The trigger is now the session's `expectingPhoto`, so it lands
directly under the photo request on every path.

Two things worth knowing before the redeploy:

- **`Profile.typeRadarCompletedAt` is the trap, not the fix.** It is stamped
  *before* the radar thinking sequence runs, so keying on it would drop the note
  into the middle of that sequence — and a real message collapses a rich draft
  (PRODUCT_SPEC §3.6b), so the ~10.7s shimmer would visibly die mid-beat.
- **The driver now reads `bot_sessions`** once per visitor per 3s tick — one
  indexed `findUnique` on a table the bot writes on every update anyway. Demo
  scans at most 100 visitors, so this is noise, but it is the first time the
  driver reads the session store at all.

Post-deploy check: walk one demo onboarding to the radar step and confirm the
note arrives immediately below the "send me 3 photos" request — not above the
radar invite — on both the submit and the Skip path.

**Rollback:** `pm2 delete gennety-demo`. Production is untouched by anything in
this block — no shared database, no shared token, no shared port, no shared
bundle.

---

**Deployed 2026-08-07 (was PENDING) — venue photos open full-screen (PRODUCT_SPEC §3.7b).** Deployed 2026-08-07. **No Prisma schema change, no env change, no flag change, no server
behaviour change** — but it is client-side, so it **DOES need a Mini App
redeploy** (`apps/webapp`: `venue-change.ts` / `venue-change.css` / `icons.ts` /
`telegram.d.ts`). The server half is a no-op for this change alone; sequence is
still Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh`.

Tapping a photo on a venue's detail card now opens the ordinary lightbox —
full-screen, swipeable, `n / N` counter, its own ×, BackButton bound to closing
it. The board asks the couple to *choose* a place and the largest a venue was
ever shown was a 340px rail tile.

**Three things worth knowing before the redeploy:**

- **It asks the photo proxy for `w=1600` where it previously only ever asked for
  1000.** That is already the proxy's own ceiling (`clampWidth`,
  `public/routes/venue-change.ts`) so there is nothing to change server-side, but
  it is a **new cache key**: the first user to enlarge a given photo pays one
  fresh Google Places fetch, and the day-long `Cache-Control` then covers it. The
  upgrade is per slide being viewed, never the whole set, so a 10-photo venue
  costs at most one extra fetch per photo actually looked at. `PLACES_API_KEY`
  was re-verified working 2026-08-03; with it down the viewer degrades to the
  category glyph exactly like the rail does.
- **The dev preview now renders synthetic photos.** `?preview` had
  `photoRefs: []` for every mock venue, so the galleries were a wall of category
  glyphs and this feature would have been unreviewable without a live match —
  and production has **2 matches ever, both terminal** with `VENUE_CHANGE_FEATURE_ENABLED` off.
  The mock now carries 0/1/4/7-photo venues backed by generated SVG data-URIs, so
  `http://localhost:5173/venue-change.html?preview=board` exercises every gallery
  shape. `import.meta.env.DEV`-gated — unreachable in production.
- **`.vc-shot` is now a `<button>` when it opens the viewer**, not a div. Its
  button chrome is stripped in a rule at the END of `venue-change.css`, which
  matters because that file carries a pre-existing duplicated block (`.vc-shot`
  is defined twice, lines ~382 and ~745) — anything added to only the first copy
  would be a coin flip. Do not "tidy" that duplication as part of this deploy.

Post-deploy check — nothing new is logged, so verify by opening the board on
`@gennetytestbot` (needs a `scheduled` match) and tapping a venue photo. The
proxy can be exercised directly instead:

```sh
# 1600 is accepted and cached; anything above is clamped, not rejected.
curl -sD- -o /dev/null "https://dating-api.gennety.com/v1/venue-change/photo?ref=<ref>&w=1600&tma=<initData>" | head -1
```

**Rollback:** revert the code and redeploy the Mini App from the previous
checkout. Nothing else to undo — no schema, no env, no flag, no server state.

---

**Deployed 2026-08-07 (was PENDING) — a status is never shown on a step the user owes (PRODUCT_SPEC §3.6b,
§3.5, §3.5c).** Deployed 2026-08-07. **Code-only: no Prisma schema change, no env
change, no flag change, no Mini App change** (`apps/webapp` untouched).

A user picks a time, their partner counters with a different one — and both of
them were then shown a `<tg-thinking>` status saying the time was being
coordinated for them. Nobody was coordinating anything: each of them had to
widen their selection or tap one of the other's slots. The person who received
the counter got that status *directly under* the message telling them their
partner had suggested another time, which is the one message in the flow whose
whole job is to say **your turn**.

The invariant it now runs under: a status is only ever shown to someone with
nothing left to do. When the next move is the user's own, they get a reminder
that names it — never a "we're working on it" line.

**The part worth knowing before the restart is not the shimmer, it's what the
shimmer was hiding.** That state matched neither branch of `sideOwesAction`
("has this side marked anything?" — both had), and the entire §3.5c chain keys
off that predicate. So a pair whose calendars simply didn't line up got **no 6h
/12h reminder, no 24h "still on?" check-in, and no 48h cancellation** — they sat
in a live match indefinitely, held out of every drop by the single-live-match
rule. Reachable in one ordinary move. Both sides now owe the action, so all
three fire; the reminder carries static copy (`matchScheduleNoOverlapYet`) plus
the Calendar button, because a generated "pick a time" line is wrong for someone
who did pick.

Two smaller things ride along, both consequences of the same consolidation:
- The scheduling reminder now recognises a pair still inside the §3.5b Date
  Ticket gate by an empty `proposedTimes` rather than by a flag-conditional
  `ticketStatus` filter — the same discriminator the stall chain already used.
  Behaviour is identical under either flag; there is one less way for the two to
  disagree.
- Two i18n keys are deleted (`peerWaitNoOverlap`, `peerWaitNoOverlapLate`, ×5
  locales). Nothing else read them.

Post-deploy check — production has **2 matches ever, both terminal**, so nothing exercises this
until a Thursday batch pairs someone. Walk it on `@gennetytestbot`: pick a slot
from one account, counter with a different one from the other, and confirm both
chats show no shimmer. The reminder is hourly, so verify it from the log rather
than by waiting:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[match-nudge\]'
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-07 (was PENDING) — an abandoned question stops owning the chat (PRODUCT_SPEC §Phase 4 →
Emergency Protocol, §Phase 5, §2.1).** Deployed 2026-08-07. **Code-only: no Prisma
schema change, no env change, no flag change, no Mini App change**
(`apps/webapp` untouched). From a full-codebase audit; three flows, one root
cause.

Three steps asked the user to TYPE something and then read the next plain
message as the answer — the emergency cancellation reason, the report details,
and the post-date feedback text. None of the three had a deadline, and nothing
in the product ever released the state: not `/menu`, not a menu tap, not time.
So the question kept owning the chat indefinitely.

- **The one that matters: an abandoned "Yes, cancel the date" cancelled it
  anyway.** Confirm, change your mind, close the chat — and your next unrelated
  message, days later, flipped a `scheduled` match to `cancelled`, was quoted
  verbatim to your partner as the reason, and refunded both tickets.
  Irreversible. That step also had no way back, the only irreversible confirm in
  the product without one.
- The report details step did the same thing at lower stakes: an unrelated line
  became a filed report on the partner, LLM-triaged up to a strike or a
  suspension. Its **Other** category showed no buttons at all, so there was no
  exit that wasn't filing something.
- Feedback recorded an unrelated line as post-date feedback into the answerer's
  own `negativeConstraints`.

Now: the claim carries a deadline sized to what the answer costs to get wrong
(30 min / 1 h / 24 h), any non-own-button tap or command releases it, and the
emergency + report steps carry a real back-out. Past the window the message
falls through to the concierge agent, which sees the live match and can still
offer the genuine cancel card. `services/match-flow-claim.ts` is the one place
this rule lives.

**Two things worth knowing before the restart:**

- **In-flight answers across the restart are dropped, deliberately.** The
  session field is new, so every existing `bot_sessions` row reads `null` and
  fails closed. A user mid-"type your reason" at deploy time has their message
  answered by the agent instead of cancelling the date — which is the safe
  direction, and they can re-tap Cancel from the My Date hub.
- **The same commit fixes two smaller things** found in the same pass:
  abandoning the photo manager by tapping another menu button now strips the
  cards' 🗑 buttons instead of orphaning them live-but-dead forever, and
  `startPeerWaitShimmer` resolves side B positively (it read "not A, therefore
  B", so a user id belonging to neither participant aimed the shimmer at B).

Post-deploy check — nothing new is logged, so verify by walking it on
`@gennetytestbot`: tap Cancel date → "Yes, cancel" → confirm the prompt now
carries "Keep the date" → tap it → send a message → the date must still be on.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state (the extra session field is ignored by the old
code).

---

**Deployed 2026-08-07 (was PENDING) — referral share card arrives whole (REFERRAL_PRODUCT_SPEC → Surfaces).**
Deployed 2026-08-07. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched).

Sharing an invite delivered a *sliver* of the card — the top ~20%, blank
beneath. That is a partially decoded image, and the endpoint Telegram fetches
had two independent reasons to produce one. It **re-rendered the PNG on every
request** (~2.5 s cold on a Mac, worse on a 1–2 vCPU droplet — satori fonts +
five portraits + the butterfly), and then pushed **453 KB** of it. Telegram
downloads `photo_url` on its own servers under its own deadline and keeps
whatever arrived; a PNG decodes top-down, so a cut-short download *is* a strip
of the top. Now: JPEG (**93 KB**, and what the Bot API actually requires),
pre-rendered and memoized by `POST /share-message` so the fetch is a memory read
(**33 ms** measured end to end), with `photo_width`/`photo_height` stated so
Telegram never probes the file.

**Three things worth knowing before the restart:**

- **It is inert in production.** `REFERRAL_FEATURE_ENABLED=false` in
  `/opt/gennety/.env`, so `/v1/referral/*` 404s and nothing here can run. This
  reproduced on **dev**, where the flag is on and `PUBLIC_BASE_URL` is a **free
  ngrok tunnel** — exactly the slow link that turns "render then push 453 KB"
  into a truncated fetch. The weaknesses were real regardless of tunnel, so this
  lands before referral is ever switched on.
- **The card URL now carries a content version (`v`), and that is the part that
  actually reaches already-affected users.** Telegram caches fetched media **by
  URL**, and the old URL (`?u=&sig=`) was stable forever per referrer — so one
  bad fetch was permanent for that person, which is why it never self-healed.
  The version is inside the signed payload, so the HMAC binding is unchanged.
  Pre-versioning signatures are still accepted, so an in-flight share and
  `scripts/dev-stage-referral.mjs` both keep working untouched.
- **Messages already sent stay broken.** They carry a `file_id` Telegram
  resolved at send time; nothing server-side can rewrite them. Re-share to get a
  good card.

Post-deploy check — referral is off in prod, so verify on `@gennetytestbot`:
share an invite to Saved Messages and confirm the full card arrives. The
endpoint itself can be checked directly (referral must be enabled, else 404):

```sh
curl -sD- -o /dev/null "$PUBLIC_BASE_URL/v1/referral/card?u=<id>&v=<v>&sig=<sig>"
# expect: 200, content-type: image/jpeg, and a content-length that matches the
# bytes actually received — a mismatch is the truncation this change fixes.
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-07 (was PENDING) — Premium screen gets a way back to the board (PRODUCT_SPEC §3.8).**
Deployed 2026-08-07. **No Prisma schema change, no env change, no flag change** —
but this one is **client-side and therefore DOES need a Mini App redeploy**
(`apps/webapp`: new `return-to.ts`, plus `premium.ts` / `venue-change.ts`).
Sequence: Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh`. (The server half is a no-op for this change alone;
it matters only because the block below ships in the same release.)

The board's premium CTA navigates to `premium.html` in the same WebView, and
that was a one-way door — a user who read the price and passed had to close the
Mini App and reopen "Change venue" from chat. Premium now shows Telegram's
native BackButton when (and only when) it was reached from another page, and it
reopens the exact board. Opened cold from the main menu it shows none, because
there is nowhere to go back to.

Three details worth knowing:

- **The return is a fresh navigation, not `history.back()`.** That is deliberate
  and load-bearing for the *successful* case: the board re-reads
  `pairPremiumActive` on open, so a user who actually subscribed comes back to
  unlocked premium cards. A bfcached history entry would show them still locked.
- **The target is validated against an allowlist**, never taken as a URL from
  the query string — it arrives in a parameter the user can edit.
- **Back walks the whole chain, not one hop (folded in 2026-08-05, before this
  block ever shipped).** The first cut of `return-to.ts` stored a single target,
  so each hand-off overwrote the last: board → Premium → referral erased the
  board, and back landed on a Premium screen that believed it was opened cold —
  no button, close-the-Mini-App the only way out. It is a stack now, bounded in
  depth, collapsing a revisit instead of stacking it. The top of the trail stays
  in the original query keys, so a client still on an older bundle keeps its one
  working level rather than losing back entirely.

Post-deploy check: load `premium.html` once from the board and once from the
menu row, confirming the back arrow appears in the first case only — then walk
board → Premium → "invite a friend instead" and press back twice, which must
land back on the board rather than stopping on Premium. (The referral leg needs
`REFERRAL_FEATURE_ENABLED`, which is **false** in production, so that half is
verifiable only on `@gennetytestbot` until referral launches.)
**Rollback:** revert the code and redeploy the Mini App from the previous
checkout.

---

**Deployed 2026-08-07 (was PENDING) — venue-change board: photos back, duplicates gone, premium reaches
5 km (PRODUCT_SPEC §3.7b).** Deployed 2026-08-07. **Code-only: no Prisma schema
change, no env change, no flag change, no Mini App change** (`apps/webapp`
untouched — the client already renders `photoRefs`).

Three user-reported symptoms, one cause. The 2026-07-30 commit `9df3a39` moved
the board's curated catalog from a `universityDomain` scope to a `cityKey` one.
That fixed a real bug (general/phone-track pairs, which is **every production
user** — all 20 have `universityDomain = NULL` — got an empty curated catalog
and never saw the premium tier at all). Its unrecorded side effect: the curated
branch started winning `curated.length > 0 ? curated : places`, and curated rows
are both photo-less and stored one-per-university-domain.

- **Photos never came from our base.** `photoRefs: []` for curated rows has been
  in the code since the feature shipped. Until `9df3a39` it did not matter,
  because every board fell through to the live Places sweep, whose search
  response carries photos — that fallback is also where the old "lots of variety,
  parks and cafés" came from (`FALLBACK_CATEGORIES = cafe, restaurant, park`).
  Curated cards now resolve their photos from `placeId` in one Place Details
  call each, cached in-process, best-effort.
- **Duplicates are data, not display logic.** Kyiv holds **538 active rows for
  127 real venues** (premium: **90 rows for 18**), five copies each — one per
  university domain, at identical coordinates, so they sort adjacently and the
  three pinned premium slots all held the same place. Deduped by the same key
  the board already resolves picks with.
- **Premium now searches `VENUE_CHANGE_PREMIUM_RADIUS_KM` (5 km)**, base and
  alternative stay at 3 km. From Podil only 10 of 18 premium venues are inside
  3 km; all 18 are inside 5.

**Two things worth knowing before the restart:**

- **Board opens now make Places calls where they made none.** Bounded by the
  12-card cap and 4-way concurrency, cached by `placeId` for a day (failures for
  5 minutes, so an outage cannot become a retry storm). Worst case is ≤12 Place
  Details requests on the first board open after a PM2 restart; Kyiv's whole
  catalog warms in ~113. Only the board *read* pays — the like/confirm calls
  rebuild the same catalog to re-resolve a key and skip lookups entirely.
- **Nothing exercises this until a pair reaches `scheduled`.** Production has
  **2 matches ever, both terminal**, and `VENUE_CHANGE_FEATURE_ENABLED` gates the entry button.
  Verify on `@gennetytestbot`.

Post-deploy check — the board should show distinct venues with photos, and three
*different* locked premium cards on top:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[venue\] photo lookup'
# Empty is the good case: that line only prints when a lookup fails.
```

**Rollback:** revert the code and restart. No schema, no env, no flag, no Mini
App state to undo.

---

**DONE — StoreKit 2 is live-configured on the droplet (2026-08-03) and proven
against Apple's real API.** App Store Connect was set up via a browser agent,
every value cross-checked, then the key was uploaded and the env set. These are
identifiers, not secrets — they are inert without the `.p8`, which lives only on
the droplet and in the founder's password manager.

```
APPSTORE_KEY_PATH=/opt/gennety/keys/SubscriptionKey_5UCTX65L56.p8
APPSTORE_KEY_ID=5UCTX65L56
APPSTORE_ISSUER_ID=49fd72b2-faf4-4673-a9b4-50e6027c46a8
APPSTORE_ENVIRONMENT=sandbox
```

**Proof, not inference.** `POST /inApps/v1/notifications/test` against
`api.storekit-sandbox.itunes.apple.com` answered **200** — so the key, `kid`,
issuer and `bid` are all accepted by Apple. Reading the delivery record back
settles the two things that were previously assumed:

- `sendAttempts: [{ sendAttemptResult: "SUCCESS" }]` on the first attempt — our
  webhook is reachable at the saved URL and answered Apple acceptably.
- `version: "2.0"`, `notificationType: "TEST"`, `bundleId: com.gennety.ios`,
  `environment: "Sandbox"` — **the notifications are V2**, which App Store
  Connect's UI could not confirm (it shows no version selector at all). The
  benign-either-way argument below is retained as history, not as a live risk.

The webhook logs nothing for a `TEST`: it carries no `signedTransactionInfo`,
so `transactionId` is empty and the handler acks in the "shape we don't consume"
branch (`res.json({ ok: true })`). Silence in `pm2 logs` after a test
notification is the correct behaviour, not a missed delivery — re-verify with
Apple's delivery record, not with our logs.

Re-run the check any time (10-minute JWT, no state written):

```sh
ssh root@167.172.178.229 'cd /opt/gennety && node -e "
const jwt=require(\"./apps/bot/node_modules/jsonwebtoken\"),fs=require(\"fs\");
const now=Math.floor(Date.now()/1000);
const t=jwt.sign({iss:\"49fd72b2-faf4-4673-a9b4-50e6027c46a8\",iat:now,exp:now+600,
  aud:\"appstoreconnect-v1\",bid:\"com.gennety.ios\"},
  fs.readFileSync(\"/opt/gennety/keys/SubscriptionKey_5UCTX65L56.p8\"),
  {algorithm:\"ES256\",header:{alg:\"ES256\",kid:\"5UCTX65L56\",typ:\"JWT\"}});
fetch(\"https://api.storekit-sandbox.itunes.apple.com/inApps/v1/notifications/test\",
  {method:\"POST\",headers:{Authorization:\"Bearer \"+t}})
  .then(r=>r.text()).then(console.log);"'
```

Flip `APPSTORE_ENVIRONMENT` to `production` at release, and re-run the same
probe against `api.storekit.itunes.apple.com` — a key that works in sandbox is
not evidence that the production host is reachable.

App record: Apple ID `6797330919`, bundle `com.gennety.ios`, SKU `gennety-ios`,
**Team ID `ADWPKD5WZ7`** — which matters beyond bookkeeping: it is the same team
the founder registered with BotFather for Telegram login, so that integration is
bound to the right account.

Product ids match `APPSTORE_TICKET_PRODUCTS` / `PREMIUM_APPSTORE_PRODUCT_ID`
exactly. Verified US base prices, and the per-ticket ladder they produce:

| product | price | per ticket |
|---|---|---|
| `ticket_1` | $6.99 | $6.99 |
| `ticket_3` | $16.99 | $5.66 |
| `ticket_6` | $29.99 | $5.00 |
| `premium_monthly` | ~~$9.99/mo~~ → **$17.99/mo** (raised 2026-08-07) | — |

**`premium_monthly` was raised to $17.99 on 2026-08-07**, matching the Telegram
rail's 750⭐. Re-measured on the product page after a reload: US 17,99 $ as the
current price for new subscribers, **0 upcoming changes**, and 175 storefronts
auto-generated by Apple. The ticket rows above are unchanged and were not
touched.

**⚠️ The subscription group has never been submitted, so iOS Premium is not
purchasable at all yet — price is not the binding constraint (found
2026-08-07).** App Store Connect shows the group and the product as
*Preparing for Submission*, with Apple's standing rule on screen: **"your first
subscription group must be submitted with a new app version."** So
`premium_monthly` cannot be bought on any storefront until an app build carrying
it clears review — which is also why `APPSTORE_ENVIRONMENT=sandbox` is still the
right setting and why the $9.99/$17.99 gap that sat open earlier in this file
was never actually visible to a user.

Two consequences worth holding onto:

- **The price was fixed at the best possible moment**: before first submission,
  there is no price history, no subscriber cohort, and therefore no
  "preserve price for existing subscribers" decision to get wrong. That is why
  the wizard showed no such prompt and no start-date picker.
- **`features.premium: true` on `/v1/app/config` does not mean iOS can sell it.**
  That flag mirrors `PREMIUM_FEATURE_ENABLED` on the server and knows nothing
  about App Store review state. A native paywall gated only on it will render a
  StoreKit product that cannot be purchased. The App Store rail goes live at
  first approved submission, not at a flag flip.

An earlier agent report suggested `ticket_1` might have inherited $16.99, which
would have charged one ticket the price of three; direct inspection shows $6.99.
The ladder is strictly decreasing, so nothing blocks enabling the rail.

**These differ from `TICKET_BUNDLES` (`packages/shared/src/constants.ts`:
$7.00 / $16.47 / $26.94), and that is tolerated, not an oversight.** Apple owns
its price points and re-derives them per storefront, so the iOS client must
render StoreKit's own `displayPrice` and never a number of ours. The constants
remain the anchor for the Telegram rail, which charges Stars anyway. Worth a
founder decision later whether the two surfaces should quote one USD ladder.

**Server Notifications** point at `https://dating-api.gennety.com/v1/webhooks/appstore`
on both Production and Sandbox. App Store Connect shows **no V1/V2 selector at
all** — only the two URL fields — which is consistent with new apps being V2
only, though we have not proven it. The failure mode if it were V1 is benign and
visible: our handler requires `signedPayload` and answers **400**, so V1
notifications would simply not apply and would show up as 400s in the log rather
than corrupting anything.

**APNs was broken for nine days and is fixed in the same pass (2026-08-03).**
The 2026-07-25 rsync did not just delete `AuthKey_JTLFAQ8RM2.p8` — it removed
`/opt/gennety/keys/` **entirely**, while `APNS_KEY_PATH` kept pointing into it.
So every push since then failed at key load, silently: the `APNS_*` env was all
present and correct (`APNS_TEAM_ID=ADWPKD5WZ7` matches App Store Connect), which
is exactly why a config check would have said everything was fine. Both `.p8`
files are now uploaded `0600` into a `0700` directory and verified loadable —
`crypto.createPrivateKey` reads each as `ec / prime256v1`, which is what ES256
signing in `services/apns.ts` and `services/appstore.ts` needs.

**Check the directory, not just the env, after any rsync-based deploy.** The
failure mode here is a valid path to a file that no longer exists, and nothing
in the boot sequence fails closed on it:

```sh
ssh root@167.172.178.229 'ls -l /opt/gennety/keys/'   # expect two 0600 .p8 files
```

**`TELEGRAM_LOGIN_CLIENT_ID=8707759133` is also set now, and is deliberately
inert.** The Telegram-login code is on `main` and NOT deployed — the running
`config.ts` has no such key, and `/v1/app/config` still returns no
`features.telegramAuth`. The variable simply waits for the deploy; nothing about
setting it early changes current behaviour.

---

**Deployed 2026-08-07 (was PENDING) — status shimmers stop being overtaken by their own results
(PRODUCT_SPEC §1.3 / §1.4 / §3.7a).** Deployed 2026-08-07. **Code-only: no Prisma
schema change, no env change, no flag change, no Mini App change**
(`apps/webapp` untouched). Two user-reported bugs, one shared cause — a status
sequence and the work it narrates were independent async chains, so the work's
speed decided what the user saw.

- **Verification.** A liveness pass starts the face-match pipeline and the ~7s
  "analysing your check" shimmer side by side. AWS answers fast, so the verdict
  — usually *"the photos on your profile don't match your verification selfie"*
  — routinely landed **underneath** a shimmer still saying the check was being
  completed. A gate (`services/outcome-gate.ts`) now holds every user-facing
  message from that run until the shimmer is torn down, and tells the shimmer
  when the pipeline is ready to speak so a slow run holds its last beat instead
  of ending in silence. Scoped to the fresh-liveness path only: photo-edit
  reruns, the admin recheck and the native rail DM immediately as before.
- **Date planning.** `runStatusSequence`'s `until` cut the narration short the
  moment the work settled — from the FIRST beat, at the three date-card call
  sites. The render ranges from well under a second to several seconds, so the
  card beats a user actually saw varied run to run, often collapsing to a
  sub-second flash of the first line. What that looked like in the chat is
  exactly what was reported: the venue-search shimmer appearing to hang on
  *"подбираю по атмосфере"* (a rich draft lingers on its own ~30s TTL and
  nothing replaced it) with the card beats never arriving. `NEVER_CUT_SHORT`
  makes `until` extend a script, never truncate it.

**Worth knowing before the restart:** the date card now lands ~6s after the
venue is picked even when the render was instant — that is the fix, not a
regression (the beats are a script the user is meant to read). Production has
**2 matches ever, both terminal**, so nothing exercises the date-card half until a Thursday
batch pairs someone; verify it on `@gennetytestbot`. The verification half is
live for anyone who runs a check.

**Rollback:** revert the code and restart. Nothing else to undo.

---

**Deployed 2026-08-07 (was PENDING) — "Continue with Telegram" on iOS (`POST /v1/auth/telegram`).** Deployed 2026-08-07. **No Prisma schema change, no Mini App change, no flag change** —
but it needs **one new env var**, and it is inert until that var is set.

```
TELEGRAM_LOGIN_CLIENT_ID=8707759133
```

That is the bot's Client ID from @BotFather → Bot Settings → Login Widget →
*Switch to OpenID Connect Login* (founder, 2026-08-02). It is the `aud` every ID
token is checked against, so an empty value is fail-closed: the endpoint answers
503 and `/v1/app/config` reports `features.telegramAuth: false`, which is what
tells the client to hide the button. **There is deliberately no client secret**
— we verify an already-issued ID token against Telegram's public keys and never
exchange an authorization code, so no secret needs to exist on the droplet.

The matching iOS redirect URI is `https://app3059503520-login.tg.dev`; it lives
in the app's Associated Domains, not in server config.

**One behaviour change that is NOT about Telegram login**, shipped with it
because Telegram login is what makes it wrong: `workers/profiler.ts` and
`workers/re-engagement.ts` filtered eligible users on `telegramId > 0` alone. A
Telegram-login account carries a real positive id while being reachable only by
push (a bot cannot message someone who never pressed Start), so both now also
require `platform in ('telegram','both')`. Nobody is in that state until the env
var above is set, so the fix lands ahead of the cohort it protects.

Post-deploy check:

```sh
curl -s https://dating-api.gennety.com/v1/app/config | grep -o '"telegramAuth":[a-z]*'
# 503 until the env var is set, then 400 for a missing token — never 404.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dating-api.gennety.com/v1/auth/telegram \
  -H 'content-type: application/json' -d '{}'
```

**Rollback:** remove `TELEGRAM_LOGIN_CLIENT_ID` and
`pm2 restart gennety-bot --update-env`. The endpoint goes inert and the client
hides the button; no data written by a Telegram login is undone by that (those
accounts keep working through their phone rail).

---

**⚠️ Production is NOT at repo HEAD, and a single-file rsync from the working
tree WILL take it down (incident 2026-08-01, ~6 min outage).** Prod runs
`f9e08eb` (deployed 2026-07-29); everything in the PENDING blocks below is
missing from it, including `services/match-stall.ts` and the
`VOICE_SELF_GENDER` export in `@gennety/shared`. The bot runs from source via
tsx, so a file copied from HEAD that imports either one is not a degraded
feature — it is `ERR_MODULE_NOT_FOUND` at boot and a PM2 crash loop. That is
exactly how `services/prompt-builder.ts` was shipped alone and crash-looped
production before it was restored.

Confirm what prod actually runs before touching it — anchor it by md5 rather
than by trusting this file:

```sh
ssh root@167.172.178.229 'md5sum /opt/gennety/packages/shared/src/ai/prompts.ts'
# then locally, walk recent commits until one matches:
git show "<sha>:packages/shared/src/ai/prompts.ts" | md5 -q
```

For a targeted hotfix, patch the version prod actually runs
(`git show "<prod-sha>:<path>"`), import-test it **in place on the droplet**
under a temp filename before `mv`-ing it over the live file, then restart and
watch that the PID holds and the restart count stops climbing. Otherwise do a
full deploy — but note that rsync copies the **working tree**, not git HEAD, so
check `git status` first: an unrelated in-progress refactor ships with it.

**Prod anchor, re-verified 2026-08-08 after the release at the top of this file.**
Prod is at **`f66949a` plus `e04ffec`** (the dependency-override commit made
during that release) — deliberately **not** at `HEAD`, and the gap grows every
time anyone commits.

**Do not maintain a list of undeployed commits here — compute it.** An earlier
revision of this note named them, and it was stale within the hour because a
parallel session kept landing work. The set is a one-liner:

```sh
git log --oneline f66949a..HEAD | grep -v e04ffec    # what prod is missing
git diff --stat f66949a..HEAD -- apps packages       # is any of it runtime code?
```

**A demo-only release does not advance this anchor, and that is the trap.**
`deploy-demo.sh` syncs the whole tree to `/opt/gennety-demo`, so every commit
that is an *ancestor* of a demo release ships to the demo — production-relevant
or not — while `/opt/gennety` stays where it was. That is exactly how `087e7e4`
ran in the demo for a day before reaching production. When the range above
contains a commit under `apps/bot/src/demo/`, the commits *around* it are the
ones to check, not the demo one.

The second command is the one that matters: a range that touches only `*.md` is
a documentation gap, while anything under `apps/` or `packages/` is undeployed
behaviour and needs a block at the top of this file before the next release.
Two standing exclusions, both deliberate rather than forgotten:

- **Kyiv venue-catalog commits** (`scripts/curated-venues.kyiv.*.json`) ship
  nothing. DECISIONS.md records that no `seed-venues:import` is authorised
  against prod, and that prod deliberately carries the pre-expansion catalog —
  so an import is a separate, larger decision, not part of any deploy.
- **`apps/video/**`** is the Remotion workspace and is not in the bot runtime.

Anchor md5 as of 2026-08-08 — three files the last release actually changed,
which is what makes them worth anchoring on:

```
4983080a84fdf053fc79bb99fcf118c5  /opt/gennety/apps/bot/src/services/onboarding-photo-stage.ts
9fd9e243fea22d10a7c862ced62b2f2f  /opt/gennety/apps/bot/src/services/venue-change.ts
359cb5e6ba572d0939e141ee7ddba224  /opt/gennety/packages/shared/src/i18n.ts
```

The file below is kept as the counter-example, not as a check to run:

```
45b55b6600994a7869511e777c1e4704  /opt/gennety/packages/shared/src/ai/prompts.ts
```

That file is a weak anchor on its own — it happened to be identical across the
whole 84-commit range, so it matched prod both before and after this release and
proved nothing. **Anchor on a file the release actually changed, or better, sweep
the whole tree**, which is what settles it in one command:

```sh
ssh root@167.172.178.229 'cd /opt/gennety && find apps packages -type f \
  \( -name "*.ts" -o -name "*.tsx" -o -name "*.prisma" -o -name "*.json" \) \
  -not -path "*/node_modules/*" -not -path "*/dist/*" | sort | xargs md5sum' \
  | sort > /tmp/prod.md5
# then in a clean worktree at the candidate sha:
find apps packages -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.prisma" \
  -o -name "*.json" \) | sort | xargs md5 -r | awk '{print $1"  "$2}' | sort \
  | diff - /tmp/prod.md5 && echo "prod == this tree"
```

728 files, zero differences, is what "prod is at this commit" should mean.

---

**⚠️ The rule below has exactly one known exception — do not trust the marker
alone (found 2026-08-07).** The account-health block sits *below* this marker but
its commit (`44f9e41`) is dated **2026-08-03**, i.e. after this release. It was
inserted in the wrong place, so the marker's "everything below already shipped"
claim silently covered a block that had not. It was caught only because
`apps/bot/src/admin/utils/user-health.ts` was **absent** from the droplet, and it
shipped in the 2026-08-07 release. **Verify a block by whether its module is on
the droplet, not by which side of this line it is on**, and keep inserting new
blocks at the TOP of the file where the convention puts them.

**Deployed 2026-08-02 — the 104-commit catch-up: every block below that was
marked PENDING shipped in one deploy.** Full server code + Mini App + one
`db:push`. This is the release that brought prod from `f9e08eb` (2026-07-29) up
to HEAD, so the concierge audit fixes, the planning-stall chain (§3.5c), the
stage-aware pinned banner, peer-wait shimmer v2, the expiry + coordination
cards, the daily-cadence groundwork, venue observability, season/weather
ranking, the admin dialog media column and the `reference_expired` fix all went
live together.

**⚠️ One DESTRUCTIVE schema change, taken deliberately:** `profiles.ethnicity`
was dropped (the onboarding step was removed). 8 of 9 production profiles held
a value. **A backup was captured first** and lives on the droplet next to the
logical DB dump:

```
/opt/gennety/ethnicity-backup-2026-08-02T08-26-08-301Z.json   (9 rows, 8 filled)
```

Add `--exclude '*-backup-*.json'` to the deploy rsync — the documented flag set
does NOT cover this name and `--delete` would erase it. The full plan was
verified before running: 17 × `ADD COLUMN`, 1 × `CREATE INDEX`, exactly one
`DROP`. `db:drift-check` OK afterwards.

Preflight green: typecheck clean, **3378 tests** (bot 2957 / shared 264 /
webapp 157), `pnpm build`, `security:secrets` (947 files), `security:audit`
0 advisories, working tree clean. rsync dry-run listed exactly **1** deletion
(`services/delete-freeze-video.ts`, genuinely removed in `29db1d9`).

Post-deploy verified: `Bot @gennetybot started`, all 16 crons registered
**plus `[worker] Peer-wait shimmer every 20000ms`** (that line is the proof the
new code is live — it did not exist on the old build), `:3100`/`:3101`
listening, `/v1/ping` ok, admin `401`, **all 11 Mini App pages 200**,
`supportedCities` still Kyiv-only, restart count frozen (no crash loop), and
zero `P2022` / `P2023` / unhandled rejections. The concierge knowledge block
measures **0 characters** (was 22,988 — see the `admin_cache` fix).

**🟢 RESOLVED 2026-08-03 — `PLACES_API_KEY` works. Do not act on the paragraph
below.** Re-probed with the key from `/opt/gennety/.env`: `places:searchNearby`
and `places/{id}` (field mask `photos`) both answer **200**. The droplet's key
and the local `.env` key are the same (md5 match), so whatever broke it —
billing, an API toggle, a restriction — was fixed on the Google Cloud side and
nobody recorded it here. Everything listed as degraded below is working. Kept
for the record, and as a reminder to re-probe before trusting an old incident
note:

> **🔴 Pre-existing production issue found during this deploy, NOT caused by it:
> `PLACES_API_KEY` is dead.** Both `places/{id}` details and `places:searchNearby`
> answer `403 PERMISSION_DENIED` with the key from `/opt/gennety/.env` (the key is
> present and 39 chars, so it is rejected rather than missing — billing disabled,
> API disabled, or a key restriction/rotation in Google Cloud). The
> `venue-revalidation` cron has been logging it. What degrades while it is down:
> every date-card venue photo (Google Places is the single source since
> 2026-07-25 → cards fall back to the branded gradient), the Places fallback when
> no curated venue is in commute range, the Location Mini App autocomplete
> (`/v1/location/search`), the venue-change catalog beyond curated rows and its
> photo proxy, and the daily venue re-validation sweep. The curated Kyiv catalog
> is first-party and still works, so scheduling degrades rather than dies. Fix in
> the Google Cloud console; re-verify with the `searchNearby` probe above.

Re-probe (safe, read-only, one request):

```sh
KEY=$(ssh root@167.172.178.229 "sed -n 's/^PLACES_API_KEY=//p' /opt/gennety/.env | tail -1 | tr -d '\"'")
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  'https://places.googleapis.com/v1/places:searchNearby' \
  -H 'Content-Type: application/json' -H "X-Goog-Api-Key: $KEY" \
  -H 'X-Goog-FieldMask: places.id' \
  -d '{"includedTypes":["cafe"],"maxResultCount":1,"locationRestriction":{"circle":{"center":{"latitude":50.45,"longitude":30.52},"radius":1000.0}}}'
```

**Rollback:** re-sync a checkout at `f9e08eb` and redeploy the Mini App from it.
The additive columns can stay; `profiles.ethnicity` would have to be restored
from the JSON backup above.

---

**Deployed 2026-08-07 (was PENDING) — account-health classification + fixed conversions (admin only).**
**No Prisma schema change, no flag change, no Mini App
change** (`apps/webapp` untouched) — but it adds **one optional env var** and
requires a **dashboard redeploy** (separate repo,
`~/Desktop/gennety-admin-dashboard`, auto-deploys to Vercel on push).

**This block was filed below the 2026-08-02 catch-up marker by mistake** (see the
warning on that marker) — its commit `44f9e41` postdates that release, so it was
still genuinely pending until 2026-08-07 despite sitting in the "already
shipped" half of the file.

**The dashboard half was already live and had been failing.** The repo was clean
and 0/0 with `origin` — `cf9c9a7` (health section, funnel, class tabs) and
`547ff83` (revenue ledger) had been pushed and auto-deployed to Vercel some time
earlier, so those tabs were calling `/admin/users/:id/health` and
`/admin/purchases` against a server that did not serve them. Nothing needed
doing on the dashboard side at deploy time; this release is what made its
existing tabs work. **When a block names a dashboard redeploy, check whether it
has already happened — a pushed dashboard against an undeployed server is a
silently broken tab, not an error anyone sees.**

Post-deploy measured: `userHealth.byClass` =
`{test: 1, suspicious: 0, stuck_onboarding: 6, cold_open_unengaged: 9,
inactive: 0, live: 4, other: 0}` over 20 users. `test: 1` is the proof the env
var landed.

```
ADMIN_TEST_TELEGRAM_IDS=-153639032722566
```

That is the founder's own mobile-rail account (`Глеб`, synthetic negative id —
verified against the live DB on 2026-08-03). **Leaving this empty is not
neutral:** the classifier then finds zero test accounts and every conversion is
divided by 20 instead of 19. It is analytics-only — nothing in matching,
workers or notifications reads it.

What ships: `/admin/stats` and `/admin/dashboard` gain a `userHealth` section
(seven mutually exclusive classes, summing to the scan) and a `funnel` whose
denominators exclude test accounts; `GET /admin/users/:id/health` explains ONE
account; `/admin/users` gains a health badge per row plus `?health=` and
`?includeTest=false`. Existing response sections are untouched.

**One number changes meaning, and the dashboard reads it:**
`derived.activeRate` was `active / users.total`; it is now
`active+verified / real users`. Against production today that is 5/19 = 0.2632
rather than 5/20 = 0.25. Anyone comparing week over week will see a step — it
is the fix, not a regression.

Measured against the live database before deploying (read-only probe, 20
accounts): live 5, stuck_onboarding 5, cold_open_unengaged 8, test 1, other 1,
suspicious 0, `matchmaking_eligible` 5 of 19, consent→active 55.6%,
registered→active 26.3%.

**Two things worth knowing before the restart:**

- **`/admin/stats` and `/admin/users` now scan the user table** (bounded by
  `HEALTH_CONFIG.max_scan_users`, 20000) on every call, because the class is
  computed rather than stored. At 20 users that is milliseconds; revisit it if
  the base reaches five figures — the fix is a short cache, not a schema
  column.
- **`bot_batch_min_users` is 3.** Three signups inside ten minutes is a
  registration burst — normal during an ad push. Verified accounts are exempt,
  so a real user who passed liveness can never be flagged this way, but
  unverified signups in a burst will be. Raise it in
  `admin/utils/user-health.ts` before a large campaign.

Post-deploy check:

```sh
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://api-admin.gennety.com/admin/stats | python3 -m json.tool | head -60
# userHealth.byClass.test must be 1, not 0 — 0 means the env var did not land.
```

**Rollback:** revert the code in both repos and restart. Nothing else to undo —
no schema, no flag. Removing `ADMIN_TEST_TELEGRAM_IDS` alone does not roll the
feature back; it just stops excluding the test account.

---

**Deployed 2026-08-02 (was PENDING) — privacy remediation, 2026-08-01 (ethnicity removed, founder-feed
delete anonymised, OTP redaction, consent versioning, biometric consent screen,
coordination-card protection).** Deployed 2026-08-02. **No env change, no flag
change** — but it **DOES need a Mini App redeploy** (`apps/webapp`:
`verification.html` + `verification.ts` + `i18n.ts` + `api.ts` carry the new
biometric-consent screen). Ships with the next full deploy — note the
divergence warning above; none of this is safe to single-file rsync.

**Order matters on this one: server first, then the Mini App.** The server
starts refusing `/init` with `409 consent-required`, and only the new bundle
knows how to answer that. A cached old bundle renders its generic error screen
until the user reloads — verification is briefly unavailable for anyone
mid-flow, which is why the two steps should be minutes apart, not hours.

**⚠️ This is the first entry in this file that needs a DESTRUCTIVE schema step.**
It drops `profiles.ethnicity`. That is the *point*: the column holds GDPR Art. 9
data (racial / ethnic origin) which was being folded into the matching embedding
with no Art. 9 basis behind it, so the data itself is the liability and erasing
it IS the remediation. Do not preserve it "just in case".

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
# Read the plan BEFORE running anything. Expect exactly two statements:
#   ALTER TABLE "users" ADD COLUMN "policy_version" TEXT;
#   ALTER TABLE "users" ADD COLUMN "biometric_consent_at" TIMESTAMP(3);
#   ALTER TABLE "users" ADD COLUMN "biometric_consent_version" TEXT;
#   ALTER TABLE "profiles" DROP COLUMN "ethnicity";
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script

# For the record, before it goes:
psql "$DATABASE_URL" -c "select count(*) from profiles where ethnicity is not null;"

pnpm --filter @gennety/db db:push --accept-data-loss
pnpm db:drift-check   # must exit 0 before pm2 restart
```

`--accept-data-loss` is required and correct here. **If the printed plan carries
any DROP other than `profiles.ethnicity`, STOP** — that is drift from another
branch, not this change.

What ships:

- **`profiles.ethnicity` is gone end to end** — the onboarding question, the
  legacy agent's tool field + prompts + context-dump gate, the Aether
  `update_profile` field, the fallback embedding text (`profile-analysis.ts`),
  both founder-feed cards, and the admin audience breakdown. PRODUCT_SPEC §1.3
  records why. Existing `onboarding_progress` rows that list `"ethnicity"` are
  harmless: `asField()` drops unknown values.
- **Founder feed on account close is UNCHANGED from what production does
  today.** It was briefly reduced to an anonymous lifecycle event on
  2026-08-01 and **restored by founder decision on 2026-08-02** — the delete
  notification still carries the full profile card, phone number and photos,
  because at this stage knowing exactly who left is treated as the main source
  of churn understanding. The only visible difference is one added line,
  `В продукте: N дн.`. Privacy §12.2 now discloses this prominently and
  commits to deleting those messages on request; `legal/dpia.md` R9 records it
  as a knowingly accepted residual risk. **Operational duty this creates: an
  erasure request extends to the founder-bot chat and must be executed by
  hand — nothing automates it.**
- **A typed verification code is masked in `chat_events`** before the row is
  written (`redactSensitiveSummary`), matching the bcrypt hashing
  `email_otps` / `phone_otps` already do.
- **`users.policy_version`** records WHICH version of the Terms + Privacy Policy
  a user accepted (`LEGAL_DOCS_VERSION`, currently `2026-08-01`) — GDPR Art.
  7(1) accountability. Null on all existing rows, by design.
- **`protect_content` on the coordination cards.** They render the partner's
  face and shipped without it. `COORDINATION_FEATURE_ENABLED` is already `true`
  in production, so this would have been live the moment those cards deployed.
- **A dedicated biometric-consent screen before Face Liveness.** GDPR Art.
  9(2)(a) needs an explicit act for biometric processing specifically; tapping
  "Verify now" under copy that never said the word "biometric" was not one. The
  gate is in `beginLivenessCheck`, so both the Mini App and the native rail are
  bound by it — a client that skips its screen gets a 409, not a session. Two
  more additive columns: `users.biometric_consent_at` / `_version`. **Every
  existing user must consent once** on their next verification attempt; the
  three currently-`unverified` production accounts are the only ones affected,
  and nobody loses `verified` status. **Restyled 2026-08-05, before this block
  ever shipped** — visual only, same one explicit tap, same server gate: the
  disclosure is borderless and vertically centred (padded clear of Telegram's
  floating close ×/menu ⋯ via `wireContentInsets`, which this page did not call
  before), and the action moved off Telegram's MainButton — a full-width bar
  welded to the bottom edge — onto an independent floating pill carrying the
  house inner-perimeter burgundy sheen (`.ref-share`, referral.css). Every other
  screen here still uses MainButton for its Close action.

Also lands `pnpm gdpr:export` — the subject-access / portability tool the policy
now promises. It needs no deploy step of its own (it is a script run against
whichever `DATABASE_URL` is in scope; pass `--prod` for production) but note
that its output is a full personal-data dump written OUTSIDE the repo: deliver
it over a channel the requester controls, then delete it.

Legal documents were rewritten in the same commit (Privacy Policy v4.0, Terms
v3.0). **They are not live until the website is redeployed** — see
`legal/README.md`, which also records the two remaining publication blockers
(controller postal address, Art. 27 EU representative).

**Post-deploy check**, beyond the standard checklist:

```sh
psql "$DATABASE_URL" -c "\d profiles" | grep -c ethnicity   # expect 0
curl -sD- -o /dev/null -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://api-admin.gennety.com/admin/analytics/audience | head -1   # expect 200
```

Then walk one onboarding as far as the profile questions and confirm it goes
partner-preferences → vibe with no origin question in between, and open the
Verify button once to confirm the consent screen appears before the camera and
that agreeing lands you in the detector:

```sh
psql "$DATABASE_URL" -c "select count(*) from users where biometric_consent_at is not null;"
# 0 before anyone verifies; should tick up as accounts pass the new screen.
```

**Rollback:** revert the code and restart. The dropped column can be re-added
empty, but the DATA is gone by design and is not recoverable from the
application — restore from a Supabase backup only if you genuinely intend to
reinstate Art. 9 data you just erased.

---

**Deployed 2026-08-02 (was PENDING) — Premium hub stops asking for money up front (PRODUCT_SPEC §3.8).**
Deployed 2026-08-02. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched) — the price still comes
from `PREMIUM_PRICE_USD_DISPLAY`, now rendered only by
`GET /v1/premium/state` for the Mini App. Copy-only in `packages/shared/src/i18n.ts`
(all five locales) plus `handlers/menu/premium.ts`: the hub's `Subscribe — $X/mo`
button becomes a plain "Learn more", the monthly price leaves the chat message,
and the Telegram → Settings → Subscriptions walkthrough is replaced by "just tell
me and I'll cancel it after you confirm" — which is what the concierge's
`offer_cancel_premium` flow actually does. That walkthrough is untouched where it
is load-bearing (`premiumManageNote`, the honest fallback in `premium-cancel.ts`
when the Stars API cancel fails), and an App Store subscriber viewing the hub
gets Apple's steps instead, since the concierge cannot cancel their subscription.
No post-deploy check beyond the standard checklist. **Rollback:** revert the code
and restart.

---

**Deployed 2026-08-02 (was PENDING) — purchase notifications + admin revenue ledger.** Deployed 2026-08-02.
**No env change, no flag change, no Mini App change** (`apps/webapp`
untouched) — but it needs an **additive `db:push` BEFORE the restart**, and it
requires a **dashboard redeploy** (separate repo,
`~/Desktop/gennety-admin-dashboard`, auto-deploys to Vercel on push).

One new nullable `ticket_ledger` column (`amount_stars`) is WRITTEN on every
Stars store purchase and every date-gate charge, and SELECTED by the admin
purchase list, so a DB missing it throws `P2022` on the first purchase after
the restart — the PM2 crash-loop this file warns about. Verify additive first
(expect one `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships:

- **Every real purchase now DMs the founder ops feed** (ticket store, the
  §3.5b date-ticket gate, Premium, Rematch, venue change — Telegram Stars AND
  App Store), carrying who paid (`@username`, or the phone number on the
  mobile rail where a synthetic negative `telegramId` and no username is
  normal), what they bought, and how much. **Refunds are announced too**: a
  Rematch refund can follow its own purchase within seconds, so a
  purchase-only feed would leave sales in the DM that no longer exist.
- **`GET /admin/purchases`** — the revenue ledger with filters, pagination and
  totals; plus a spend column on `/admin/users` and a full purchase block on
  `/admin/users/:id`. New **Purchases** tab in the dashboard.
- `ticket_ledger.amount_stars` freezes what was actually charged. Star prices
  are env-tunable, so a reader must never re-derive a historical price from
  `bundleSize`; before this a Stars purchase recorded no money figure at all.

**Three things worth knowing before the restart:**

- **The founder DMs ride `FOUNDER_NOTIFY_ENABLED`** (on in production) and the
  same production-only runtime guard as the rest of the feed, so a local dev
  purchase can never reach the real ops DM. Nothing new to configure.
- **Notifications fire from each rail's settlement write** — the same one whose
  unique provider charge id already makes the purchase exactly-once — so a
  redelivered `successful_payment` returns on the duplicate branch before the
  notifier runs. No new idempotency column, and no risk of double-announcing.
- **Dollar figures derived from Stars are estimates and say so.** Telegram
  publishes no Stars→USD rate; the code uses the documented $0.02/⭐ ticket
  rate and marks every such number `≈`. App Store rows carry Apple's real
  price. Expect the two to disagree slightly with a Telegram payout statement.

Post-deploy check — production has had **0 purchases ever**, so the list will
legitimately be empty until someone actually pays; the endpoint answering `200`
with zero totals is the correct result:

```sh
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" \
  'https://api-admin.gennety.com/admin/purchases?limit=5' | head -c 400
psql "$DATABASE_URL" -c "select count(*) from ticket_ledger where amount_stars is not null;"
```

**Rollback:** revert the code in both repos and restart; the additive column
can stay (nothing reads it if the code is reverted). There is no flag — the
notifications follow `FOUNDER_NOTIFY_ENABLED`, which also silences them.

---

**Deployed 2026-08-02 (was PENDING) — audit fixes round 2, 2026-08-02 (Mini App timeouts + two dead ends).**
Deployed 2026-08-02. **No Prisma schema change, no env change, no flag change** —
but this one **DOES require a Mini App redeploy** (`apps/webapp` changed), so the
sequence is Deploy Full Server Code → `pnpm db:drift-check` → `pm2 restart` →
`./scripts/deploy-webapp.sh`.

- **Every Mini App request now has a 20s deadline** (`apps/webapp/src/api.ts`,
  new `apiFetch`). All 44 `fetch` calls across the 12 pages had none. Each flow
  sets a `saving`/busy flag, disables its button and clears the flag only when
  the promise settles, so a request that never settles (a stalled mobile
  connection, not a slow one) left the user on a dead disabled "Saving…" with
  every further tap swallowed by the busy guard — the only way out was killing
  the Mini App. An abort surfaces as a plain `DOMException`, which is exactly
  what every caller's existing "not a `CalendarApiError` → show the network
  error" branch already handles, so no call site changed. The bot side has
  carried `AbortSignal` on all of its outbound calls for a long time; this
  closes the gap on the client.
- **The onboarding photo editor now always retires its cards**
  (`handlers/onboarding/photo-editor.ts`). `markOnboardingComplete` clears
  `session.onboardingPhotoEdit` synchronously, and it runs BEFORE the next
  outgoing message — so `closeStalePhotoEditor`'s flag-only guard returned early
  on exactly the exit it exists to handle. A user who opened the editor and then
  finished onboarding (tapping an older Continue button, or typing "done") was
  left with a stack of photo cards whose 🗑 buttons silently did nothing.
- **A user who DECLINED no longer gets consoled at expiry** (§3.4). A first
  decision leaves the row `proposed` either way, so a decliner whose partner
  then went silent reached the 24h expiry classified as an ordinary
  `responder` — and got "they never answered, your part was done on time",
  written for the person who accepted and was stood up. They now get one bare
  neutral line (`matchExpiredSelfDeclined`, all 5 locales) and **no card**: the
  card family is for §3.4's emotional beats and this is not one of them.

Also folded in: two dead symbols left over from the ethnicity removal in
`91a6d6a` (`SKIP_RE` in `onboarding-collector.ts`, an unused `history` param in
`onboarding-agent.ts`) had `main`'s `pnpm lint` gate red. Both were verified
orphans of that completed removal — deleted, no behaviour change.

**Known pre-existing flake, NOT caused by this change:**
`services/date-card/render.test.ts` times out nondeterministically in the full
suite even at its existing 60s budget. Measured standalone, one `renderDateCard`
costs ~4–5s of CPU warm or cold (satori + resvg + the canvas duotone and grain
on a 1350px card), and with 201 test files running in parallel that stretches
past 60s wall-clock. It is unrelated to anything here — date-card imports none
of the changed modules — and it reproduces on `main`. The fix is contention, not
another timeout bump: give the heavy PNG renderers their own low-concurrency
vitest project (or cap `maxThreads`). Deliberately left alone because retuning
suite-wide parallelism is a workflow decision, not an audit fix.

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo.

---

**Deployed 2026-08-02 (was PENDING) — audit fixes, 2026-08-01 (NOMATCH-2 + chat-queue + card fonts).**
Deployed 2026-08-02. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change.** Ships with whatever restart carries the blocks
below. Three independent fixes from a full-codebase audit:

- **NOMATCH-2 — the D10 pool-exhaustion pause is now always reversible**
  (`services/no-match-notifier.ts`). The status CAS and the
  `starvationPausedAt` marker were two separate writes. That mattered because
  `autoResumeStarvedUsers` selects `paused AND starvationPausedAt != null` while
  the notifier itself only ever selects `active` — so a pause that committed
  without its marker was invisible to BOTH sweeps: silently and permanently out
  of the matching pool, with nothing in the product able to bring the user back.
  They now commit in one `$transaction`. Separately, a pause whose DM failed to
  send left the user paused **and never told**; that path now resumes the
  account so the next run re-evaluates and re-sends. Inert in production today —
  `FAMINE_PAUSE_AFTER_DAYS` is 28 days and no account is near it — which is
  exactly why it was worth fixing before the mechanism starts firing.
- **The chat queue no longer manufactures unhandled rejections**
  (`chat-queue.ts`). Its cleanup hook was a promise derived from the one handed
  to the caller, with no rejection handler of its own, so **every** handler
  error raised a spurious `unhandledRejection` on top of the real error that was
  already caught. `index.ts` installs a non-fatal listener so nothing ever
  crashed — but "zero unhandled rejections" is a post-deploy health signal used
  further down this file, and it could not mean anything while ordinary errors
  fabricated them. Expect that log line to get materially quieter after this
  restart; if it does not, the remaining ones are real.
- **Card headline fonts** — see the expiry-card block below.

No post-deploy check beyond the standard checklist. **Rollback:** revert the
code and restart; nothing else to undo.

---

**Deployed 2026-08-02 (was PENDING) — expiry card (PRODUCT_SPEC §3.4).** Deployed 2026-08-02. **No Prisma
schema change, no env change, no flag change, no Mini App change**
(`apps/webapp` untouched). Always-on — there is no feature flag, because the
card degrades to the exact plain text that ships today rather than to nothing.

What ships: the 24h-decision-deadline expiry DM becomes a PNG card plus a short
caption, instead of the bare `sendMessage` it has always been. Four variants
(silent-warning / silent-penalty / partner-ghosted-you / you-ghosted-an-accept),
each with its own vector motif, rendered in the recipient's `User.theme` and
language.

**One new asset rides the ordinary code rsync:**
`apps/bot/src/assets/fonts/unbounded-700.woff` (144 KB). It is the FULL
Unbounded, added because the two subset files (`latin` + `cyrillic`) do not
cover Polish — Ą Ł Ż Ś Ć Ź Ń Ę are in Google's separate `latin-ext` subset. The
time card and match card now load this same file too (see the third bullet
below), so it serves three renderers. Nothing is removed: the subsets stay, and
the referral + coordination cards still use `unbounded-cyr-700.woff` for their
Cyrillic-only headline variant.

**Three things worth knowing before the restart:**

- **Send volume per expiry is unchanged** — still one message per side, now a
  photo instead of text. The render is pure layout + rasterize with no network
  call and no photo download (deliberately: partner photos are `protect_content`
  and a terminal match must not depend on a download), and takes ~0.4 s. It runs
  inside the existing 2 s-per-side pacing loop, so it adds no new rate-limit
  pressure.
- **The sibling font bugs ARE now fixed too (2026-08-01 audit), and one of them
  was worse than this file previously described.** The §3.6 locked-time card
  printed Polish months and weekdays (`WRZEŚNIA`, `PAŹDZIERNIKA`, `ŚR`) with
  those letters dropping into Roboto mid-word — invisible today, since
  production has **zero** `pl` users. The **match card** was the real one: it
  registered BOTH Unbounded subsets under the single family name `"Unbounded"`,
  and satori resolves a family to its first registered font rather than falling
  through per glyph, so the cyrillic subset owned it and every **Latin** glyph —
  the `Gennety` wordmark on every card, plus any Latin partner name — rendered
  in Roboto. That affected `en`/`de`/`pl` recipients on the most prominent card
  in the product, under a flag that is ON. Both now load the same
  `unbounded-700.woff` this deploy already ships, so the asset carries three
  renderers rather than one and no new file is needed.
  `apps/bot/src/services/card-headline-fonts.test.ts` is the regression guard.
  The **referral and coordination cards were never affected** — they switch to
  Archivo Black for non-Cyrillic locales, which covers Latin, Polish and German.
- **Nothing exercises this until a match actually expires.** Production has 0
  matches ever, so the first real card renders only after a drop pairs someone
  and one side lets the 24h window close. Verify on `@gennetytestbot` first —
  `scripts/dev-expiry-cards-demo.mjs` renders and sends all four variants in
  both themes without touching the database.

Post-deploy check — the notify sweep already logs its own totals:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[expiry-notify\]'
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state. The added font file can stay either way.

---

**Deployed 2026-08-02 (was PENDING) — pre-date coordination PNG cards (PRODUCT_SPEC §Phase 4).** Deployed 2026-08-02. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched). Ships with whatever
restart carries the blocks below.

What ships: the five coordination DMs stop being bare text. Each becomes ONE
message — a rendered PNG, the SAME localized copy as its caption, the same
inline keyboard — mirroring the date card and the venue wish card. Uses the
already-deployed satori/resvg/canvas stack and the already-bundled fonts, so
`pnpm install` pulls nothing new and there is no system dependency to add.

**Three things worth knowing before the restart:**

- **⚠️ "Inert in production today" was wrong** (corrected 2026-08-08).
  `COORDINATION_FEATURE_ENABLED=true` is set in `/opt/gennety/.env` and the
  running process reports `features.coordination: true` on `/v1/app/config`, so
  the sweep DOES send the T-60m offer and DOES open the T-30m window. The cards
  in this block are therefore live. Nothing has exercised them only because
  production has had **0 dates ever** — which is why the mistake cost nothing
  and also why it went unnoticed for six days.
- **Fail-open is the load-bearing property, not the cards.** A null render, a
  caption over Telegram's 1024-char photo limit, or a rejected `sendPhoto` each
  fall through to the exact plain-text DM the flow sends today. This DM lands
  ~1h before a date and is the only way the pair can find each other, so a
  render hiccup must cost a picture, not the message. Watch for the fallback
  ever firing in production:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[coordination-card\]'
```

- **Verify on the dev bot, not in prod.** Production has 0 dates ever, so
  nothing will exercise this until a Thursday batch pairs someone AND that pair
  reaches `scheduled` AND the flag is on. `scripts/dev-coord-cards-demo.mjs`
  renders and DMs every variant without touching the database, and
  `scripts/dev-coord-offer-demo.mjs` plays the real flow end to end.

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-02 (was PENDING) — daily-cadence matching migration groundwork (PRODUCT_SPEC §3.1 /
§3.1b, `DAILY_MATCHING_MIGRATION_AUDIT.md`, `DAILY_MATCHING_IMPLEMENTATION_PLAN.md`).**
Deployed 2026-08-02. **Code + one additive schema column, no env change required
to keep current behavior, no Mini App change.** `DROP_CADENCE` is unset in
`/opt/gennety/.env` today and this deploy does not add it — production keeps
running the `weekly` profile byte-for-byte identical to today (pinned by
`packages/shared/src/cadence.test.ts`). Ships **inert**: a `daily` profile
exists in code but nothing switches to it as part of this deploy.

What ships: an internal `DropCadence` abstraction
(`packages/shared/src/cadence.ts`) that every cadence-dependent constant in
the matching engine, proposal deadlines, nudges, the famine notifier, the
Profiler, and Rematch now reads from, selected once at boot by `DROP_CADENCE`
(`weekly` default | `daily`). Plus a genuinely new mechanism, D10 — an honest
pause instead of an endless famine-tier ladder: a user whose `computeTier`
day-count reaches `FAMINE_PAUSE_AFTER_DAYS` (28, a flat code constant —
`packages/shared/src/constants.ts`) is paused via the same CAS the menu's own
Pause button uses, gets one honest DM instead of another tier notice, and is
auto-resumed the moment `findCandidatesFor` would find them a candidate again
(`services/pool-exhaustion.ts`, `autoResumeStarvedUsers`, same cron tick as the
famine notifier).

**⚠️ Requires an additive `db:push` before restart.** One new nullable column,
`profiles.starvation_paused_at`, is read by `services/account-status-transitions.ts`
on every resume and by `services/pool-exhaustion.ts` on every famine-notice
tick, so a DB missing it throws `P2022` on the first no-match-notice cron after
restart — the PM2 crash-loop this file warns about elsewhere. Verify additive
first (expect one `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

**Four things worth knowing before the restart:**

- **Match daily, apologise weekly (founder decision 2026-08-02, folded into
  this same unshipped block).** The `daily` profile's notice throttle was
  retuned from ~2.5 days to **7 days**, and `famineDiscountMinTier` from 7 to
  **2**, so flipping the cadence later changes how often we *look*, never how
  often we *write*: a nightly drop that finds nobody sends **nothing at all**,
  and the empathetic check-in keeps today's weekly rhythm, tier ladder and
  second-notice discount. Two supporting changes ship with it — `computeTier`
  is now denominated in the NOTICE interval (a tier is "which message in the
  streak", so the tier-2 copy and the discount threshold mean the same thing
  under any cadence; the old batch-denominated version would have made a
  `daily` user's second-ever notice arrive as tier 7 and skip tier 2 entirely),
  and the pinned banner drops its countdown whenever drops outpace notices
  (`dropOutpacesNotices`) so the timer never ticks to zero into deliberate
  silence. **All of it is inert under `weekly`** — `cadence.test.ts` pins both
  profiles and `status-banner-view.test.ts` pins the banner's off state.
- **`FAMINE_PAUSE_AFTER_DAYS = 28`, not 14.** `computeTier` is denominated in
  `CADENCE.famineNoticeIntervalMs` (7 days in both profiles), so tier 2 lands
  at day 14 — a 14-day pause threshold would fire at the exact same moment as
  the famine discount and make tier 3 structurally unreachable. 28 lets the
  tier 1→2→3 ladder (days 7/14/21) play out before the pause takes over, and
  because the interval no longer varies by profile, that ladder now sits at the
  same wall-clock days under `daily` too.
- **Nothing in this deploy changes what any user currently experiences.**
  Every cadence-dependent constant's `weekly` value is asserted byte-for-byte
  identical to what it replaces (`cadence.test.ts`); the only genuinely new
  user-visible surface (D10's pause/resume) is reachable but, per the same
  tier-2-at-day-14 math above, essentially never fires under `weekly` in
  practice at current pool sizes — it exists so the mechanism is proven before
  `daily` cadence (where it fires routinely) is ever turned on.
- **Rematch's env-backed knobs were deliberately left untouched.**
  `REMATCH_MAX_PER_WEEK` / `REMATCH_COOLDOWN_HOURS` /
  `REMATCH_PRE_BATCH_BLACKOUT_HOURS` still read plain `env.*` in `config.ts`,
  not `CADENCE` — moving them would require `config.ts` to import
  `@gennety/shared`, which breaks the dotenv-loading order guarantee
  (`config.ts` must stay the first module evaluated). They need manual review
  before Rematch is ever enabled under `daily`; `REMATCH_FEATURE_ENABLED`
  itself is untouched by this deploy and stays whatever it already is in prod.

**Flipping `DROP_CADENCE=daily` in production is explicitly NOT part of this
deploy** — it is a separate, later decision gated on the founder's judgment
about pool size, not on anything shipped here. When that day comes: set
`DROP_CADENCE=daily` in `.env`, `pm2 restart gennety-bot --update-env`, no
further schema or code change needed (the `daily` profile ships in this
deploy, dormant).

What that flip will visibly change, so it isn't discovered live: the pinned
banner loses its drop countdown for everyone without a live match (steady
"I'm looking — I check every evening" instead), most evenings send no message
at all, and the agent starts quoting the shorter planning deadlines. What it
will NOT change: how often a starved user hears from us, the tier ladder, or
when the discount lands. Two things to watch on the first days —
`FAMINE_PAUSE_AFTER_DAYS` (28) stops being theoretical and will start firing
routinely at small pool sizes, which is intended (an honest pause plus
auto-resume beats a fourth tier of apology), and the Rematch knobs above still
need their manual review first.

Post-deploy check — the drop-batch log prefix confirms the new code is live
without needing to wait for Thursday:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[drop-batch\]\|\[pool-exhaustion\]'
psql "$DATABASE_URL" -c "select count(*) from profiles where starvation_paused_at is not null;"
```

**Rollback:** revert the code and restart; the additive column can stay
(nothing reads it if the code is reverted). There is no flag to unset — this
deploy adds no env var.

---

**Deployed 2026-08-02 (was PENDING) — season + weather venue ranking (PRODUCT_SPEC §3.7,
VENUE_ENGINE_IMPROVEMENT_PLAN 5.3).** Deployed 2026-08-02. **No Prisma schema
change, no Mini App change** (`apps/webapp` untouched) — but it ships alongside
the observability block below, which DOES need an additive `db:push`, so follow
that block's schema step. One new external dependency, one new flag, ships
**off**.

What it does: a park in a January downpour ranks below a comparable indoor spot.
It is a **soft multiplier, never a filter** — the venue stays fully selectable,
because a wrong forecast or a dead provider must not be able to withhold a venue
from a couple. The combined season × weather factor is clamped to `[0.8, 1.1]`
by a code constant, so it can reorder near-ties and nothing more.

**New external dependency: Open-Meteo** (`api.open-meteo.com`). **No API key, no
account, no quota, nothing to configure** — that is why it was picked over a
credentialed provider for a signal worth a few positions of reordering. One
request per venue selection (not per candidate), cached in-process by city +
hour. If the droplet's egress is ever firewalled, allow `api.open-meteo.com:443`;
otherwise there is no setup step at all.

New env (all optional):

| Key | Default | Effect |
|---|---|---|
| `VENUE_SEASON_WEATHER_ENABLED` | `false` | Master flag. Off → multiplier is a constant 1.0 and **no forecast is ever requested**. |
| `VENUE_WEATHER_TIMEOUT_MS` | `2500` | Upper bound on the forecast wait. Past it the run continues weather-blind rather than making the pair wait. |
| `VENUE_WEATHER_CACHE_TTL_MS` | `3600000` | In-process cache TTL. Failures are cached too, so an outage cannot become a retry storm. |

**Three things worth knowing before flipping the flag:**

- **Every failure is fail-open, by construction.** Network error, timeout,
  non-200, unparseable body, a date past Open-Meteo's ~16-day horizon — all
  return null, and null scores exactly like *perfect* weather, never like bad
  weather. The forecast can only ever make an exposed venue rank slightly
  better or slightly worse; it can never remove one.
- **Most of the catalog is unaffected.** Indoor venues score exactly 1.0 in
  every condition, as does any venue whose exposure the catalog does not
  record. In practice this moves parks and a handful of scenic/outdoor rows.
- **It runs on the selection path**, so the flag is safe to flip live with
  `pm2 restart gennety-bot --update-env`, but production currently has **0
  matches ever** — nothing will exercise it until the first Thursday batch
  pairs someone and that pair reaches `negotiating_venue`.

Post-deploy check — the multiplier is named in `venueSelectionReason` only when
it actually moved a winner, so its absence on indoor picks is correct:

```sh
psql "$DATABASE_URL" -c "select venue_name, venue_selection_reason from matches where venue_selection_reason like '%context%' order by updated_at desc limit 5;"
```

**Rollback:** `VENUE_SEASON_WEATHER_ENABLED=false` +
`pm2 restart gennety-bot --update-env`. No schema, no data, nothing to undo.

---

**Deployed 2026-08-02 (was PENDING) — venue observability (VENUE_ENGINE_IMPROVEMENT_PLAN part 6).** Deployed 2026-08-02. **No Mini App change** (`apps/webapp` untouched) — but it needs an
**additive `db:push` BEFORE the restart**, and it ships alongside the blocks
below, which need their own schema steps. Do every schema step, then one
restart. A **dashboard redeploy** (separate repo, `~/Desktop/gennety-admin-dashboard`)
is only needed to *render* the new endpoint; the API works without it.

One new nullable `venue_selection_logs` column (`city_key`) plus one index is
WRITTEN on every venue selection and SELECTED by the new admin route and the
weekly alert worker, so a DB missing it throws `P2022` on the first date that
gets a venue after the restart — the PM2 crash-loop this file warns about.
Verify additive first (expect one `ADD COLUMN` + one `CREATE INDEX`, zero
`DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships, and why:

- **The selection funnel is recorded.** `topCandidates` now holds
  `{candidates, poolSizes}` instead of a bare array — `poolSizes` is how many
  venues survived each stage (`curatedInBox` → `curatedEligible` →
  `placesAdded` → `ranked`). The engine fails silently (dates keep being
  scheduled), so the `.slice(0, 20)` that left 20 of 661 eligible Kyiv venues
  in the running could only ever be found by a hand-written production query.
- **`GET /admin/analytics/venue-concentration?days=7`** — per city: the funnel,
  top venues by share, a concentration index, and `failureReason` counts.
  Cached 15 min, honours `?fresh=1`, emits `X-Data-Generated-At`.
- **Weekly alarm into the founder ops DM**, Friday 10:00 Kyiv.

New env (all optional, all default to the safe value):

| Key | Default | Effect |
|---|---|---|
| `VENUE_CONCENTRATION_ALERT_ENABLED` | `false` | Registers the weekly cron. Also inert unless `FOUNDER_NOTIFY_ENABLED` (the only delivery channel). |
| `VENUE_CONCENTRATION_ALERT_THRESHOLD_PCT` | `15` | Share of a city's dates one venue may take before it is worth a message. |
| `VENUE_CONCENTRATION_ALERT_WINDOW_DAYS` | `7` | Lookback window. |
| `VENUE_CONCENTRATION_ALERT_CRON_SCHEDULE` | `0 10 * * 5` | Friday morning, so the window always contains a full Thursday drop. |

**Three things worth knowing before the restart:**

- **The funnel and `cityKey` are NOT gated by the alert flag.** They are data,
  useful whether or not anyone is being paged, and they start filling on the
  first venue selection after the restart. Only the weekly DM is behind
  `VENUE_CONCENTRATION_ALERT_ENABLED`.
- **Existing log rows keep the old bare-array `topCandidates` and carry no
  funnel.** `parsePoolSizes` returns null for them on purpose — a zeroed funnel
  would drag the median down and fake a pool collapse. They show as
  `samples: 0` until new rows accumulate.
- **A thin city will look concentrated and that is arithmetic, not a defect.**
  Two of three dates in one place is 66%. The alert therefore always carries
  the sample size; a minimum-sample threshold was deliberately NOT added
  because it would blind the alarm exactly when a new market launches.

Post-deploy check — production currently has **0 matches ever**, so the log
table is empty and both surfaces will legitimately return nothing until the
first Thursday batch pairs someone and that pair reaches `negotiating_venue`:

```sh
psql "$DATABASE_URL" -c "select count(*), count(city_key) from venue_selection_logs;"
curl -sD- -o /dev/null -H "Authorization: Bearer $ADMIN_API_KEY" \
  'https://api-admin.gennety.com/admin/analytics/venue-concentration?days=7' | head -1
```

**Rollback:** revert the code and restart; the additive column can stay. To stop
only the DM without a code change, set `VENUE_CONCENTRATION_ALERT_ENABLED=false`
and `pm2 restart gennety-bot --update-env`.

---

**Deployed 2026-08-02 (was PENDING) — admin dialog media + the fat user card (ARCHITECTURE.md
→ `chat_events` / Admin API).** Deployed 2026-08-02. **No env change, no flag
change, no Mini App change** (`apps/webapp` untouched) — but it needs an
**additive `db:push` BEFORE the restart**, and it ships alongside the blocks
below, which need their own schema steps. Do every schema step, then one
restart. It also requires a **dashboard redeploy** (separate repo,
`~/Desktop/gennety-admin-dashboard`, auto-deploys to Vercel on push).

One new nullable `chat_events` column (`media`) is SELECTED by the admin dialogs
reader and WRITTEN by the outbound API transformer on every media send, so a DB
missing it throws `P2022` on the first photo the bot sends after the restart —
the PM2 crash-loop this file warns about. Verify additive first (expect one
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships, and why each piece exists:

- **Chat media is finally recorded.** `chat_events` stored only a sentence
  ("(photo card, no caption)", "sent a photo"), so the admin dialog reader could
  say a photo happened and never show it — every image in every conversation was
  invisible, which is what "многое количество форматов контента в чате просто не
  видно" actually was. The `file_id` is now read off the API **result**, which is
  the only capture point that works for the bytes-only sends (date card, кружок,
  generated voice note) that carry no id going out.
- **Inbound media too**, plus stickers, which previously fell through
  completely unrecorded.
- **The rich AI-compose finaliser now records itself.** `streamComposedRich`
  persists its final message with `sendRichMessage`, a raw Bot API call the
  outbound transformer does not classify, and unlike the classic stream it
  never called `recordOutboundMessage`. So **every Profiler question was absent
  from the timeline** — the reader showed a user's answers with nothing above
  them, and the concierge agent resolving a bare "why?" against the last thing
  on screen could not see the question either. Visible in production today: the
  06:01 answers in one live dialog have no questions above them.
- **The user card carries the data it always claimed to.** `eloScore` was
  already in the payload and simply never rendered; `homeCity`, tickets,
  Premium, the contact rails, `embeddingDirty`, `standbyCount`, the vibe axes,
  the match history and the Profiler answers were not in the payload at all.
- **Cache freshness.** Analytics TTLs run 10–60 min with nothing on screen
  admitting it. Every cached route now emits `X-Data-Generated-At` /
  `X-Data-Cache` and honours `?fresh=1`.

**Four things worth knowing before the restart:**

- **The timeline now records from `/start`, not from the end of onboarding**
  (founder decision 2026-07-31 — PRODUCT_SPEC §2.1). Registration was the one
  stretch of the conversation the dialog reader could not see. Expect
  `chat_events` to grow faster and to contain onboarding-era content: a typed
  OTP code, and a ≤300-char excerpt of a pasted AI-memory export (that branch
  is off in production — `AI_MEMORY_EXPORT_ENABLED=false` — so it is currently
  theoretical). The 30-day `retention` sweep is what bounds both. The phone
  number is still never stored; the contact share is recorded as the event.
  Reverting is a code change, not a flag: `resolveChatTarget` in
  `services/chat-events.ts`.
- **Existing rows have `media = NULL` and stay text-only.** Nothing backfills,
  and nothing can: Telegram `file_id`s were never stored for those sends. The
  transcript fills in from the first message after the restart.
- **The CORS `exposedHeaders` addition is load-bearing** for the dashboard's
  freshness display — without it the browser silently cannot read the header
  even though the server sends it. `ADMIN_DASHBOARD_ORIGIN` must be a concrete
  origin (it already is) or CORS is denied outright and this is moot.

Post-deploy check, beyond the standard checklist — the column should start
filling within minutes of any real bot traffic, and onboarding chats should
start appearing at all:

```sh
psql "$DATABASE_URL" -c "select kind, count(*) from chat_events where media is not null group by 1;"
# Was structurally 0 before this deploy — anything here proves the widened scope.
psql "$DATABASE_URL" -c "select count(*) from chat_events e join users u on u.id=e.user_id where u.onboarding_step <> 'completed';"
curl -sD- -o /dev/null -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://api-admin.gennety.com/admin/analytics/cities | grep -i 'x-data-'
```

**Rollback:** revert the code in both repos and restart; the additive column can
stay. There is no flag — the recorder writes `media` unconditionally, and the
worst case of leaving it is a nullable column nothing reads.

---

**Deployed 2026-08-02 (was PENDING) — `reference_expired` is escapable again (PRODUCT_SPEC §1.4 rule 5).**
Deployed 2026-08-02. **Code-only: no Prisma schema change, no env change, no flag
change, no Mini App change** (`apps/webapp` untouched). Ships with whatever
restart carries the blocks below.

What it fixes: `beginLivenessCheck` refused every `verified` user, so a user
whose reference selfie the 90-day scrub removed was told by three surfaces to
"verify again to change your photos" and then refused `409 already_verified` by
the only call that could do it. The refusal is now conditional on
`verifiedSelfiePath`. Such a re-run deliberately does **not** write `pending` —
matching admits `verified` only, so a downgrade would drop a long-tenured user
out of the pool over a photo edit.

**Probably nobody is in this state yet — not verified against the live DB.** The
scrub keys off `verifiedAt + 90 days`, and the production state recorded at the
2026-07-27 deploy was a single `verified` account whose check ran 2026-07-26, so
its reference is not due for scrubbing until late October. That is an inference
from a three-day-old note, not a measurement. Run this before assuming the fix is
still theoretical (and note the admin API cannot answer it — it needs the DB):

```sh
psql "$DATABASE_URL" -c "select count(*) from users where verification_status='verified' and verified_selfie_path is null;"
```

**Rollback:** revert the code and restart. Nothing else to undo.

---

**Deployed 2026-08-02 (was PENDING) — peer-wait shimmer v2 (PRODUCT_SPEC §3.6b).** Deployed 2026-08-02.
**No env change, no flag change, no Mini App change** (`apps/webapp` untouched) —
but it needs an **additive `db:push` BEFORE the restart**, and it ships alongside
the two blocks below, which need their own schema steps. Do all three schema
steps, then one restart.

Two new nullable `matches` columns (`peer_wait_started_at_a/_b`) are SELECTED by a
worker that runs every 20 s, so a DB missing them throws `P2022` on the first tick
— the PM2 crash-loop this file warns about. Verify additive first (expect two
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships: the shimmer's wording stops rotating on a 60 s clock and instead
climbs a **five-tier ladder keyed to how long that side has actually waited**
(<5 m / 5 m–1 h / 1–6 h / 6–24 h / >24 h), one line each, plain text with no
icon. Plus two coverage fixes: the calendar's **both-picked-no-overlap**
state (previously silent for BOTH sides until the §3.5c 24 h check-in) and the
**§3.7b venue-change board** (previously no shimmer at all — its ~4 s polling only
covers an open Mini App).

**Three things worth knowing before the restart:**

- **Tiers 4 and 5 are claims about other workers.** "Напомнили {name} о вас" at
  6 h is true only because `match-nudge` fires there, and "{name} долго не
  отвечает" at 24 h is the window the §3.5c 24 h check-in / 48 h cancellation
  sits in. If either schedule is retuned, retune these boundaries with it
  (`TIERS` in `services/peer-wait.ts`).
- **The copy was rewritten once already, same day (2026-07-31), before ever
  shipping.** The first five-tier pass (`Ждём {name}` / `От {name} пока тихо` /
  …) was too terse for a repeat visitor to tell what was actually being waited
  on; every line now states the mechanic ("ждём ответа") explicitly, chosen from
  three candidate ladders demoed live in a dev chat. Tier 5 also dropped the
  "время поджимает" tail — a founder call that the bare fact carries the
  urgency without an explicit pressure phrase.
- **These statuses carry no emoji or animated glyph at all** (founder decision
  2026-07-30) — unlike every other `<tg-thinking>` beat in the product, which
  keeps its AIActions glyph. If a future edit adds one back, that is a product
  change, not a fix; a test in `services/peer-wait.test.ts` asserts the absence.
- **One venue-change interaction is expected, not a bug.** That branch runs on
  `scheduled`, which is not a Profiler-blocking status, so a Profiler question can
  land mid-wait and collapse the draft; the next tick (≤20 s) re-issues it. The
  other three scenarios sit on statuses where the waiting side's chat is quiet.

Watch on the first day that the anchor is only written on real waits — it should
NOT grow by one row per user per tick:

```sh
psql "$DATABASE_URL" -c "select count(*) from matches where peer_wait_started_at_a is not null or peer_wait_started_at_b is not null;"
pm2 logs gennety-bot --lines 200 --nostream | grep '\[peer-wait\]'
```

**Rollback:** `PEER_WAIT_TICK_MS=0` + `pm2 restart gennety-bot --update-env`
disables the whole feature with no code change (note that with it off the
calendar/venue waits show nothing at all — the old confirmation messages were
removed, not merely decorated). Or revert the code; the additive columns can stay.

---

**Deployed 2026-08-02 (was PENDING) — stage-aware pinned banner (PRODUCT_SPEC §2.1).** Deployed 2026-08-02.
**This change adds no Prisma schema change, no env change, no flag change, and no
Mini App change** (`apps/webapp` untouched) — but it ships alongside the planning
stall chain below, which DOES need an additive `db:push`, so follow that block's
schema step. Sequence: Deploy Full Server Code → `db:push` (for §3.5c) →
`pnpm db:drift-check` → `pm2 restart`.

What ships: the pinned banner stops always counting down to Thursday. A user
holding a live match is excluded from that batch (§3.2 filter 8), so the banner
now counts down whatever is actually next for them — the 24 h reply deadline on a
`proposed` pitch (label byte-identical to the pitch keyboard's own button), the
time to the date once `scheduled`, or a neutral "date being planned" in between,
each opening the My Date hub instead of the menu. No live match → the original
drop countdown, unchanged. The unlaunched-city waitlist banner still outranks
everything.

**No new API-call volume.** The banner was already re-edited every minute per
active user, and the per-tick match query is still one `findMany` (widened from
`scheduled` to all four live statuses — a user holds at most one live row, so
cardinality is unchanged). Nothing new is sent; only the text of the message that
was already being edited changes.

Two things worth knowing before the restart:

- **The scheduled-date line moved rather than being added.** It used to be an
  extra line *below* the drop status; a scheduled date now owns the whole banner.
  Anyone with a live date sees the drop schedule leave the pin — intended, with
  the reasoning in §2.1.
- **Production had 0 matches ever at the last deploy**, so on day one every
  active account is on the unchanged drop mode and this is invisible until the
  first Thursday batch actually pairs someone. The new modes therefore get their
  first real exercise in production — verify them on `@gennetytestbot` first.

Post-deploy check (beyond the standard checklist): the `status-timer` heartbeat's
`eligible`/`unchanged` counts should look exactly like the previous deploy's, and
no new banner errors should appear.

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep 'status-banner'
```

**Rollback:** revert the code and restart. Nothing else to undo — no schema, no
env, no flag, no Mini App state.

---

**Deployed 2026-08-02 (was PENDING) — planning stall chain (PRODUCT_SPEC §3.5c).** Code-only otherwise:
**no env change, no flag change, no Mini App change** (`apps/webapp` untouched).
Always-on — there is no feature flag, because the thing it fixes is a hole rather
than a feature: the scheduling and venue steps had no deadline, so a partner who
went quiet kept BOTH sides out of every weekly batch indefinitely.

**⚠️ Requires an additive `db:push` BEFORE the restart.** Seven new nullable
`matches` columns are selected by a worker that runs every hour AND written by
`startScheduling` on every mutual accept, so a DB missing them throws `P2022` —
the PM2 crash-loop this file warns about. Verify additive first (expect seven
`ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

New columns: `venue_nudge1_sent_at`, `venue_nudge2_sent_at`,
`scheduling_opened_at`, `stall_check_in_sent_at_a/_b`,
`stall_confirmed_at_a/_b`.

What ships: 6 h/12 h reminders on the venue step (which had none), a "still in?"
check-in with 🟢/🔴 at 24 h, and cancellation at 48 h that frees both sides for
the next drop. Plus cancellation by **text or voice at every planning stage** —
the agent's `propose_cancel_date` filtered on `scheduled` alone, so someone
writing "I want to cancel" mid-planning got an explanation and no way out.

**Two behaviours worth knowing before the restart:**

- **The existing scheduling nudge cadence changes anchor.** It counted from
  `dispatchedAt`, which also covers the up-to-24 h decision window, so a pair
  that accepted at hour 23 could get "pick a time" seconds after the Calendar
  card. It now counts from `scheduling_opened_at`. In-flight rows have that
  column null and keep the old dispatch anchor, so nothing in flight changes
  behaviour mid-deploy.
- **The 48 h cancellation is real and irreversible.** Production currently holds
  0 matches ever, so there is nothing in flight to sweep on the first tick — but
  check before restarting if that has changed:

```sh
psql "$DATABASE_URL" -c "select status, count(*) from matches where status in ('negotiating','negotiating_venue') group by 1;"
# Any such row older than 48h will be cancelled on the first non-quiet-hours
# tick. Both sides get a notice and next-batch priority; nothing is lost, but
# know it is coming rather than discovering it in the logs.
```

Watch the first day via the cron line — it only logs when something happened:

```sh
pm2 logs gennety-bot --lines 200 --nostream | grep '\[match-nudge\]'
pm2 logs gennety-bot --lines 200 --nostream | grep '\[match-stall\]'
```

**Known gap, deliberately deferred:** a stall cancellation does **not** refund a
paid Date Ticket. That hole already exists on every other cancellation path
(emergency cancel of a scheduled date burns both tickets today — neither
`cancel-in-flight-matches.ts` nor `handlers/date/emergency.ts` mentions refunds).
It is being fixed in a separate pass under one rule: the date didn't happen → the
ticket returns to the wallet, for everyone who paid. Until then this change
widens the existing hole slightly, so don't leave the two deploys far apart.

**Rollback:** revert the code and restart. The additive columns can stay. There
is no flag to flip — if the chain has to be stopped without a code revert, set
`MATCH_NUDGE_CRON_SCHEDULE` far-future (e.g. `0 0 31 2 *`), which also silences
every other match nudge.

---

**Deployed 2026-07-29 — admin ops endpoints + the three blocks that had been
sitting PENDING below (`f9e08eb`, 30 commits since `58134b8`… i.e. everything
after the 2026-07-27 release).** Full server code + Mini App + **both** additive
migrations. The three PENDING blocks that used to head this file
(peer-wait shimmer, Kyiv-only market gate, chat timeline) all shipped in this
one deploy and are marked *Deployed* in place below; their env/rollback notes
stay valid as reference.

What prompted it: six `/admin/*` paths were 404ing. The finding was that **none
of them was a stale deploy** — prod's admin surface was byte-identical to HEAD.
They had never been written, and three already existed under a different name
(`/admin/analytics/matches`, `/admin/dialogs`, `/admin/analytics/weekly-matches`).
New: `/admin/health` `/admin/stats` `/admin/dashboard` `/admin/matches`
(`admin/routes/ops.ts`), plus `/admin/conversations` and
`/admin/analytics/founder-weekly` as aliases on the existing handlers.

Schema step was verified additive before running — `prisma migrate diff --script`
produced **zero DROPs**: 4 × `ADD COLUMN` (`matches.peer_wait_*`) and
`CREATE TABLE chat_events` + 2 indexes + FK. `db:push` → `db:drift-check` **OK**
→ restart.

Preflight green: **183 bot test files / 2503 tests**, all typechecks, `pnpm build`,
`security:secrets` (875 files), `security:audit` 0 advisories.

Post-deploy verified: `Bot @gennetybot started`, **all crons registered plus
`[worker] Peer-wait shimmer every 20000ms`** (that line is the proof the new code
is live — it did not exist before), `:3100`/`:3101` listening, `/v1/ping` ok,
admin `401` unauthenticated, **all 12 Mini App pages 200**, `supportedCities`
now Kyiv-only via `/v1/app/config`, `/admin/dialogs/:id` `sources.timeline: true`
(was `false` — the table finally exists), restart count 1 with no crash loop, and
**zero new `P2022`/`P2023`** (counts held at 113/14, all historical — confirmed by
firing fresh requests and re-counting).

Two live bugs were found and fixed while verifying, both pre-existing:
- **`/admin/users/:id` 500'd on a malformed id.** A non-UUID does not read as
  "not found" to Prisma — it throws `P2023`, which the route reported as
  "Internal server error" with a stack trace. Now `400 {"error":"id must be a
  UUID"}` on `/admin/users/:id`, its `/conversation`, and `/admin/dialogs/:id`.
- **`datingadmin.gennety.com` is DOWN** (not caused by this deploy, not fixed by
  it): its Let's Encrypt certificate has **expired**, and even ignoring the cert
  the host answers `404`, so the domain is no longer attached to the Vercel
  project. DNS still points at Vercel. The dashboard is reachable only at
  `https://gennety-dating-dashboard.vercel.app`. Note `ADMIN_DASHBOARD_ORIGIN`
  still lists the dead domain, which is harmless but should be re-pointed when
  the domain is restored. **Superseded 2026-08-01** — see below.

**2026-08-01 (env-only) — `admin.gennety.com` added to `ADMIN_DASHBOARD_ORIGIN`.**
The dashboard's Vercel domain was changed to `admin.gennety.com`, and the admin
API's CORS allowlist is a concrete-origin list (empty/`*` DENIES cross-origin),
so every request from the new domain failed at the preflight — surfacing in the
browser as `Failed to fetch` with nothing loading at all, not even the user
list. Fixed by editing `/opt/gennety/.env` (backed up first) +
`pm2 restart gennety-bot --update-env`:

```
ADMIN_DASHBOARD_ORIGIN=https://admin.gennety.com,https://datingadmin.gennety.com,https://gennety-dating-dashboard.vercel.app
```

All three are kept so the old Vercel URL keeps working during the cutover. The
dead `datingadmin` entry is still listed and still harmless. Verified live: a
preflight carrying `Origin: https://admin.gennety.com` answers `204` with
`access-control-allow-origin` echoing that origin, while a foreign origin gets
`204` with **no** `access-control-allow-origin` (i.e. the allowlist is still a
real gate, not a wildcard). **This is the only change needed when the dashboard
moves domains** — no code, no schema, no redeploy. Rollback: restore the
`.env.bak.*` snapshot and restart.

rsync dry-run listed exactly 2 deletions (the usual stale `apps/video/build`
artifacts). **The exclude list was widened for this run** with
`--exclude 'prod-backup-*.json' --exclude '*.bak.*'`: the droplet holds
`prod-backup-2026-07-27T14-08-06-066Z.json` (a logical DB dump that exists
nowhere else) and a hand-edit `.bak` of `admin/server.ts`, both of which the
documented flag set would have deleted. Consider keeping those excludes.

**Rollback:** re-sync a checkout at `58134b8`, restart, redeploy the Mini App
from it. The additive columns/table can stay. `PEER_WAIT_TICK_MS=0` disables the
shimmer without a redeploy.

---

**Deployed 2026-07-29 (was PENDING) — peer-wait shimmer (PRODUCT_SPEC §3.6b).**
Code-only otherwise: **no flag change, no Mini App change** (`apps/webapp`
untouched). One new optional env var, one **required additive `db:push`**.

**⚠️ Push the schema BEFORE the restart.** The new
`matches.peer_wait_message_id_a/_b` + `peer_wait_edited_at_a/_b` columns are
selected by a worker that runs every 20 s, so a DB missing them throws `P2022`
on the first tick — the PM2 crash-loop this file warns about. Verify additive
first (expect four `ADD COLUMN`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships: instead of a flat "saved, we'll tell you when they reply" line, the
side that has committed and is now blocked on its partner sees a
`<tg-thinking>` shimmer for the WHOLE wait, wording rotating, gone the moment
the partner answers. Applies to the pitch decision (the card stays, shimmer
under it), the calendar first-mover, and the venue confirm (both of which now
send NO message at all).

**`PEER_WAIT_TICK_MS`** (optional, default `20000`, `0` disables the whole
feature) — the re-issue interval. A rich draft dies ~30 s after it is issued, so
this must stay comfortably under that or the shimmer visibly blinks out between
ticks. `0` is the kill switch: no redeploy, just
`pm2 restart gennety-bot --update-env`.

**Watch on the first day: call volume.** This is a per-waiter heartbeat — one
draft re-issue every 20 s for every side currently waiting. Confirm the worker is
only touching real waits:

```sh
# Logs only when something notable happened (fallback sent/cleared, or errors).
pm2 logs gennety-bot --lines 200 --nostream | grep '\[peer-wait\]'
# Should stay empty on the rich path: the fallback is for clients that cannot
# render rich drafts, and a non-empty column means someone is on that path.
psql "$DATABASE_URL" -c "select count(*) from matches where peer_wait_message_id_a is not null or peer_wait_message_id_b is not null;"
```

**Rollback:** set `PEER_WAIT_TICK_MS=0` and restart (feature off, no code
change), or revert the code. The additive columns can stay either way. Note that
with the feature off the calendar/venue waits show nothing at all — the old
confirmation messages were removed, not merely decorated.

**Deployed 2026-07-29 (was PENDING) — Kyiv-only market gate.** **No Prisma schema
change, no env change, no flag change.** Requires a **Mini App redeploy**
(`apps/webapp` changed: `onboarding.tsx` / `onboarding-i18n.ts` /
`onboarding.css` / `api.ts`), so the sequence is Deploy Full Server Code →
`db:drift-check` → `pm2 restart` → `./scripts/deploy-webapp.sh`.

What ships: registration accepts **Kyiv only** (PRODUCT_SPEC §1.3). The
launched-market list is a code constant
(`packages/shared/src/markets.ts` → `SUPPORTED_MARKETS`), deliberately NOT an
env var — a market is only real once its curated venue catalog, ads and ops
exist, and an env toggle would let someone open a city before any of that is
ready. Launching a city is: seed + review its `curated_venues` rows, add the
`SUPPORTED_MARKETS` entry (its `cityKey` must match the venue rows'
`cityKey`), redeploy.

Two behaviour notes worth knowing before the restart:

- **The city step no longer calls Google Places at all** (search and the
  geolocation resolve are both first-party now). `PLACES_API_KEY` is still
  required for venues and the date card — do not remove it. This also removes a
  latent bug: without the key, the old reverse-geocode resolved ANY coordinates
  to Kyiv.
- **Accounts already registered outside Kyiv are not touched** — no status
  change, no data rewrite. They gain a `menu:city` row offering a one-tap move
  to Kyiv, their pinned banner switches from the drop countdown to waitlist
  copy (the `status-timer` worker self-heals it within a minute), and the
  Thursday no-match DM becomes an honest "we haven't launched in {city}" with
  the switch button (no famine tier, no discount, no Rematch offer). Production
  held 9 users at the last deploy with Kyiv covering 6, so expect roughly 3
  accounts on this path.

Post-deploy checks (beyond the standard checklist):

```sh
curl -s https://dating-api.gennety.com/v1/app/config | grep -o 'supportedCities.*ua:kyiv'
# The city step is Kyiv-only end to end; confirm on the dev bot that a search
# for "Berlin" returns nothing and geolocation outside Kyiv explains itself.
psql "$DATABASE_URL" -c "select home_city_key, count(*) from profiles group by 1 order by 2 desc;"
```

**Rollback:** revert the code, restart, and redeploy the Mini App from the
previous checkout. Nothing else to undo — no schema, no env, no flag. A city
switched to Kyiv stays switched (it is an ordinary profile write).

---

**Deployed 2026-07-29 (was PENDING) — chat timeline for the concierge agent
(`chat_events`).** Code-only otherwise: **no env change, no flag change, no Mini App
change** (`apps/webapp` untouched).

**⚠️ Requires an additive `db:push` BEFORE the restart.** The new
`chat_events` table is read on every menu-agent turn and written by the
outbound API transformer on every message the bot sends, so a DB missing it
throws `P2022` on the first message after restart — the PM2 crash-loop this
file warns about. Verify additive first (expect one `CREATE TABLE` + two
`CREATE INDEX`, zero `DROP`):

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db exec prisma migrate diff \
  --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
pnpm --filter @gennety/db db:push
pnpm db:drift-check   # must exit 0 before pm2 restart
```

What ships: the concierge agent can finally see what the user is reacting to
(PRODUCT_SPEC §2.1) — every durable outbound message, every button tap by its
visible label, and Mini App submissions, rendered into its prompt as a "Recent
chat timeline". Written at three boundaries (grammY API transformer, one
inbound middleware, ~12 explicit calls in the initData routes), not at the ~276
individual send sites.

**Two things to watch on the first day, both about write volume.** The
transformer records only `send*` methods — every `edit*` is skipped precisely
because the pinned status banner and the pitch countdown re-render **once a
minute per user**. Confirm that holds in production:

```sh
# Should grow roughly with real messages, NOT by ~1 row/user/minute.
psql "$DATABASE_URL" -c "select count(*), max(created_at) from chat_events;"
# No 'analysing…' / status-beat rows: those sends are marked ephemeral and a
# deleteMessage also removes whatever row it created.
psql "$DATABASE_URL" -c "select direction, kind, left(summary,60) from chat_events order by created_at desc limit 20;"
```

Retention: the existing `retention` cron (`45 3 * * *` Kyiv) now also sweeps
`chat_events` older than **30 days**, batched at 1000 rows/tick — no new cron,
no new env.

**Rollback:** revert the code and restart. The table can stay (nothing else
reads it) or be dropped separately; no env, flag, or Mini App state to undo.

**Deployed 2026-07-27 (latest) — onboarding photo editor, MIN_PHOTOS 3, one
onboarding entry point, pre-drop teaser removed (`867129e`, 11 code commits
since `e774daa`).** Code only: **no Prisma schema change** (`db:drift-check`
returned OK with nothing to push), no env change, no flag change, **no Mini App
redeploy** (`apps/webapp` was untouched by every commit in the range).

Carries: the in-onboarding photo editor (`photo-editor.ts` / `photo-cards.ts` /
`photo-stage-panel.ts` — the first upload is no longer write-only, PRODUCT_SPEC
§1.3), `MIN_PHOTOS` lowered 4 → 3, the removal of the whole `face_obscured`
obstruction gate, the §1.4 quorum change that drops a failing photo instead of
the account (plus the withheld activation when that leaves the profile under the
minimum), one onboarding entry point (the legacy chat consent/language screens
are deleted), and the removal of the pre-drop teaser worker.

**The teaser removal is the deploy's own proof of freshness.** The pre-restart
log block carried `[cron] Pre-match announce scheduled: "0 18 * * 3"`; the
post-restart block does not. That cron disappearing is what confirms the new
code is actually live, the same way the Rematch cron appearing confirmed its
flag flip.

rsync dry-run listed **7** deletions and every one was intended: the 5 files git
actually deletes in this range (`consent.ts`, `language.ts`, `prompts.ts`,
`pre-match-announce.ts` + its test) and the 2 usual stale `apps/video/build`
artifacts. `.env` survived with all 8 `.env.bak.*` snapshots intact.

Preflight green locally: **typecheck clean, 172 bot test files / 2281 tests
passed, `pnpm build` clean, `security:secrets` passed (845 files),
`security:audit` clean (0 advisories)**, tree clean and level with `origin/main`.

Post-deploy verified: `Bot @gennetybot started`, all crons registered (Rematch +
venue-change refund retries present, so both flags still on; Pre-match announce
correctly absent), `:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, **all
12 Mini App pages `200`**, zero `P2022` / `FATAL` / unhandled rejections, restart
count 31 → 32 (single restart, PID stable). Server markers confirm the new code:
`MIN_PHOTOS = 3`, `photo-editor.ts` present, `pre-match-announce.ts` gone. The
only error-log lines are the documented `status-banner … chat not found` pair —
the `status-timer` heartbeat reads `eligible:3 unchanged:3 permanentFailures:2`,
i.e. the same two unreachable Telegram rows under their 6-hour cooldown.

**Production state recorded at this deploy (baseline before the ad launch):** 9
users total (6 `onboarding`, 3 `active`), verification funnel 6 `unverified` / 1
`verified` / 2 `rejected`, Kyiv holds 6 of them — **4 male, 0 female** — and
there have been **0 matches and 0 dates ever**. So the entire post-match half of
the product has never executed once in production. `REFERRAL_FEATURE_ENABLED`
stays `false` (still under development); its code shipped in this range only in
the sense that it was already there and untouched.

**Rollback:** re-sync a checkout at `e774daa` and restart. No schema, no env, no
flag, no Mini App to undo.

**Prior: 2026-07-27 — sunglasses stop rejecting profile photos, plus
the overdue Profiler schema (`e774daa`, 3 commits since `35df65b`).** Code only:
no env change, no flag change, **no Mini App redeploy** (`apps/webapp` carries
its own inlined i18n and does not import `@gennety/shared` strings, so the
changed `photoFaceObscured` copy is bot-side only).

Driven by a production audit rather than a guess: `media_validation_rejections`
plus the PM2 logs, across prod AND dev, showed `face_obscured` was **9 of the 11
real (non-retryable) rejections ever recorded — ~82% of all upload friction** —
while `unsafe_content` had never fired once and `no_face` had fired exactly once
in six weeks. So the fix is one sub-check, not the feature: the sunglasses branch
is gone, the mask/covering branch stays (PRODUCT_SPEC §1.3 records why — a
covered face becomes a `fail` at verification, and one `fail` hard-rejects the
whole account under the §1.4 quorum rule).

**⚠️ The mandatory `db:drift-check` gate earned its keep on this deploy.** It
failed *before* the restart — not from this change, which touches no
`schema.prisma`, but from the **Profiler** columns `profiles.profiler_answer_
window_until` / `profiler_question_message_id`, committed to `main` in `f54d53a`
after the last deploy and never pushed. Prod had been running pre-Profiler code,
so nothing was broken yet; restarting the freshly-synced code against that DB
would have thrown `P2022` on the first Profiler question and surfaced as a PM2
crash loop — exactly the failure mode this file warns about. Verified additive
before pushing: `prisma migrate diff --script` produced **two nullable
`ADD COLUMN`s and zero DROPs**. Ran `db:push` → `db:drift-check` **OK** → restart.

Preflight green locally: **bot 171 files / 2267 tests, webapp 144, shared 207,
all typechecks clean, `pnpm build` clean, `security:secrets` passed,
`security:audit` clean**, tree clean and level with `origin/main`. The rsync
dry-run listed only the 2 usual stale `apps/video/build` artifacts as deletions,
and the 7 `.env.bak.*` snapshots survived it.

Post-deploy verified: `Bot @gennetybot started`, **all 16 crons** registered
(incl. Rematch + venue-change refund retries, so both flags are still on),
`:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, **all 12 Mini App pages
`200`**, zero `P2022` / `FATAL` / unhandled rejections, restart count 30 → 31
(single restart, same PID holding — no crash loop). The only error-log lines are
the documented `status-banner … chat not found` pair for two unreachable
Telegram rows. Confirmed on the live droplet that `MIN_SUNGLASSES_CONFIDENCE` is
gone from the deployed source and the new RU rejection copy is in place.

**How to tell whether this was the right gate — no new instrumentation needed.**
Watch `media_validation_rejections`: if `face_obscured` drops toward zero,
sunglasses were the cause; if it continues at the same rate, what remains are
genuine coverings.

**Rollback:** `git revert e774daa`, redeploy. The additive Profiler columns may
stay either way — they are required by current `main` regardless.

**Prior: 2026-07-26 — card-based photo manager, honest liveness-retry
copy, branded detector (`9b3e51e`, 8 commits since `2c5f206`).** Code + Mini App:
no Prisma schema change, no env change, no flag change. Ships the §2.1 card-based
photo manager (one message per photo with its own 🗑 button, coalesced upload
bursts, per-frame rejection replies), the §1.4 outcome-split liveness-retry copy
(`not_live` / `expired`/`in_progress` / `no_reference` instead of one generic
"shaky camera" guess), the theme-aware branding of the Face Liveness detector,
a body-encoded-404 fix in `services/storage.ts` that could wedge account
deletion, and the drop of the hourglass emoji from the pinned-banner countdown
button.

Preflight green locally: **typecheck clean, all tests pass (bot 169 files /
2212 tests), `pnpm build` clean**, working tree clean and level with
`origin/main`. Ran Deploy Full Server Code → `db:drift-check` (**OK**, nothing to
push — the diff touches no `schema.prisma`) → `pm2 restart`, then Deploy Mini App
Only (`apps/webapp` changed: `liveness-theme.css`, `liveness-detector.tsx`,
`verification.html`). The rsync dry-run listed only the 2 usual stale
`apps/video/build` artifacts as deletions.

Post-deploy verified: `Bot @gennetybot started`, all 14 crons registered,
`:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, all 11 Mini App pages
`200`, the self-hosted liveness assets still serve correctly
(`/liveness/tfjs-wasm/*.wasm` → `application/wasm`, `/liveness/blazeface/
model.json` → `application/json`), restart count 27 → 28 (single restart, no
crash loop), and no new lines in the error log — the `face mismatch → rejected`
entry there is the pre-existing 2026-07-26 session, and the `status-banner …
chat not found` lines are the documented unreachable-chat cooldown. The 113
`P2022` hits in the historical log all predate earlier pushes.

**Rollback:** re-sync a checkout at `2c5f206` and redeploy the Mini App from it.
Nothing else to undo — no schema, no env, no flag.

**Prior: 2026-07-26 (later) — a missing reference selfie is retryable, not a
dead end (`2c5f206`).** Code-only: no Prisma schema change, no env change, no
flag change, no Mini App change. A verification run that cannot fetch the
reference selfie used to write `pending_review` — a status with no button, that
the re-engagement stall sweep skips, behind an app gate that stays locked — so
the user could never get out (PRODUCT_SPEC §1.4 rule 4). It now writes `pending`
and DMs the Verify button, and it restores `verified` instead of demoting a user
our own outage tripped over.

Found via a live incident: one prod account (`telegramId 782065541`) had sat in
that dead end since 2026-07-25 20:16 UTC — a photo-edit rerun against a
Persona inquiry whose selfie was never stored (`selfie fetch failed
{ error: 'no_selfie' }`, Persona-era code, ~9.5 h before the Face Liveness
migration commit). **The account was recovered by hand** (`pending_review` →
`unverified`, `personaInquiryId`/`faceMatchedAt`/`faceMatchScore` → null);
`photoFaceScores` was deliberately left as `[0,0,0,0]` to preserve the
`photos[i] ↔ photoFaceScores[i]` 1:1 invariant — the next successful run
overwrites it. It was the only row in `pending_review` (plus 1 `rejected`, 7
`unverified`).

The bug was NOT Persona-specific — the migration carried that branch over
verbatim and only swapped the selfie source underneath it. The live AWS-era
trigger is the 90-day `selfie-retention` scrub plus the admin
"rerun verification" button, which checks `personaInquiryId` but **not**
`verifiedSelfiePath`: before this fix, one click on any user verified 90+ days
ago would have demoted them out of the match pool into the same inescapable
state. No such user exists yet, which is why it had not fired.

Preflight green locally: bot suite **167 files / 2181 tests**, typecheck clean.
Ran Deploy Full Server Code → `db:drift-check` (**OK**, nothing to push) →
`pm2 restart`. rsync dry-run listed only the 2 usual stale `apps/video/build`
artifacts as deletions. Post-deploy verified: `Bot @gennetybot started`, all 14
crons registered, `:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, all 11
Mini App pages `200`, restart count 26 → 27 (single restart, no crash loop), and
no new lines in the error log.

**Also confirmed by this deploy's log review:** the "still to confirm" item from
the migration block below — one live end-to-end verification from a real
production account — has happened. A real AWS liveness session
(`4c74f6d7-cd00-4e40-99c2-59f6a5be333b`, a UUID, not an `inq_*`) ran the full
pipeline and returned a well-formed `rejected` (4 photos scored 0.027–0.046
against the selfie). Face Liveness is working end-to-end in production.

**Rollback:** `git revert 2c5f206`, redeploy. Nothing else to undo — no schema,
no env. The hand-recovered account is independent of the code and stays
recovered either way.

**Prior: 2026-07-26 — identity verification moved from Persona to AWS
Rekognition Face Liveness.** The sandbox-Persona era is over: production had
been running test-only KYC behind `ALLOW_SANDBOX_PERSONA=true` since
2026-07-17, and that override no longer exists because Face Liveness has no
sandbox/production key split to waive.

Sequence: env delta first (the bot refuses to boot without the new keys, so
they must precede the restart) → rsync → install/build → `db:push` →
`db:drift-check` → `pm2 restart` → Mini App deploy.

- **Env** (`/opt/gennety/.env`, backed up to `.env.bak.20260726-160202`):
  removed all seven Persona keys (`ENABLE_PERSONA_VERIFICATION`,
  `PERSONA_TEMPLATE_ID`, `PERSONA_ENVIRONMENT_ID`, `PERSONA_API_KEY`,
  `PERSONA_WEBHOOK_SECRET`, `PERSONA_HOSTED_URL_BASE`,
  `ALLOW_SANDBOX_PERSONA`); added `FACE_LIVENESS_ENABLED=true`,
  `FACE_LIVENESS_REGION=eu-west-1`, `FACE_LIVENESS_MIN_CONFIDENCE=0.8`,
  `LIVENESS_STS_ROLE_ARN=arn:aws:iam::147010141827:role/GennetyLivenessClient`,
  `LIVENESS_CREDENTIALS_TTL_SECONDS=900`. No new AWS credentials were needed —
  the existing `gennety-bot-rekognition` user gained two Rekognition actions
  plus `sts:AssumeRole`, and a new `GennetyLivenessClient` role carries the
  single `StartFaceLivenessSession` grant a user's device briefly holds.
- **⚠️ An unrelated schema drift surfaced and had to be resolved first.**
  `db:drift-check` failed on the **Rematch** tables (`matches.source`,
  `matches.rematch_paid_by_id`, `rematch_purchases`) — committed to `main`
  earlier and never deployed, exactly as this file's Rematch section warns.
  Verified additive before pushing: `prisma migrate diff --script` produced 6
  statements, all `ALTER TABLE ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX`,
  **zero `DROP`** (the only "DELETE" match was `ON DELETE CASCADE` in the new
  table's FK). `db:push` then `db:drift-check` → OK. The liveness migration
  itself is schema-free: `personaInquiryId` now holds the AWS session id.
- **rsync** dry-run listed 12 deletions, all intended: the 9 deleted
  Persona/poller files, the dead `verification.css`, and 2 stale
  `apps/video/build` artifacts.
- **Verified after restart:** `Bot @gennetybot started`, all 14 crons
  registered, `:3100`/`:3101` listening, restart count 25 → 26 (single restart,
  no crash loop), and **no new lines in the error log** — the `[persona] handler
  error` entries there predate the deploy by two hours and belong to the
  webhook that no longer exists. `pnpm probe-liveness` **on the droplet** passed
  all three AWS permissions with production env. `/v1/ping` ok, admin `401`, all
  11 Mini App pages `200`, the self-hosted model + wasm assets serve with
  `application/wasm`, and `POST /v1/webhooks/persona` now `404`s.
  (`GET /v1/me/verification/url` answers `401` rather than `404` because
  `requireAuth` runs before routing in that router — the route is genuinely
  gone.)
- **Still to confirm:** one live end-to-end verification from a real account.
  The dev run on `@gennetytestbot` passed fully (real AWS session, reference
  selfie stored, `CompareFaces` [1.000, 0.988, 1.000, 0.999] → `verified`), so
  the remaining unknown is only production's own Mini App host.

**Rollback:** `git revert` the migration commits, restore
`.env.bak.20260726-160202`, redeploy. Realistic because production identity was
sandbox-only — no real `verified` cohort depends on it. The additive Rematch
schema can stay either way.

Prior: 2026-07-25 — phone-based account login (`d1ad29f`), code-only.
Prior the same day: full catch-up release (85 commits), additive
`db:push`, flag alignment, and a dev↔prod isolation fix (details in the dated
blocks below). Prior: 2026-07-23 — dev↔prod schema-drift reconciliation + the
2026-07-22 code release. Earlier: 2026-07-21
(full server deploy — **self-healing Telegram drop banner**, commit `045279c`;
no Prisma schema change). Production build and PM2
restart succeeded; `/v1/ping` stayed healthy, every Mini App returned `200`,
and the unauthenticated admin API returned `401`. A legacy pinned-banner orphan
was unpinned only after its message id, create/edit timestamps, text, account
creation timestamp, and status matched the pre-deploy audit; the final
production orphan count was zero. The 16-minute observation window produced the
expected second heartbeat with `eligible=2`, `unchanged=2`, no new errors, no
429s, and no PM2 restart-count growth. Both DB-active Telegram rows returned
`400 chat not found`, so the worker correctly left them untracked under the
six-hour unreachable cooldown; there was no reachable active chat for a live
client rendering check.)

**2026-07-27 (env-only) — Rematch turned ON.** Founder decision, immediately
after the release below verified clean. Added a single line to
`/opt/gennety/.env` (backed up to `.env.bak.20260727-033937` first):

```
REMATCH_FEATURE_ENABLED=true
```

then `pm2 restart gennety-bot --update-env` + `pm2 save`. No schema step — the
`matches.source` / `rematch_paid_by_id` columns and the `rematch_purchases`
table were already in the prod DB (see the release note below). No Mini App
change; Rematch is Telegram-only and has no Mini App surface.

**The flag flip is confirmed by the cron, not by the env line.** The startup
block after the restart now carries `[cron] Rematch refund retry scheduled:
"0 * * * *"`, which is registered only when the flag is on — the block
immediately before it (same log, pre-restart) does not. That cron is what makes
"never keep money without delivering a match" durable, so its presence is the
real proof the feature is live rather than half-on. Also verified: `Bot
@gennetybot started`, `:3100`/`:3101` listening, `/v1/ping` ok, PM2 restart
count 29 → 30 (single restart, no crash loop), no new `P2022` / `FATAL` /
unhandled rejections.

Every other `REMATCH_*` key is left unset, so the code defaults apply:
`REMATCH_STARS=150`, `REMATCH_MAX_PER_WEEK=2`, `REMATCH_COOLDOWN_HOURS=24`,
`REMATCH_GIFT_CAP_DAYS=7`, `REMATCH_PRE_BATCH_BLACKOUT_HOURS=6`.

**⚠️ Open pricing decision — the label may under-promise the charge.** 150⭐ is
$3.00 at the ticket rate ($6.99/350⭐ = $0.02/⭐) but ≈$3.59 at the more
conservative $0.024/⭐ rate documented under `PREMIUM_STARS`, while the offer
copy says **$2.99**. Both fixes are env-only: `REMATCH_STARS=125`, or raise
`REMATCH_PRICE_USD_DISPLAY`. Not resolved at flip time.

**Rollback is one line:** delete `REMATCH_FEATURE_ENABLED` (or set `false`) and
`pm2 restart gennety-bot --update-env`. The additive schema may stay. Note that
rollback stops *new* offers but does not refund an in-flight purchase — the
refund sweep is itself flag-gated, so if a purchase is stranded in `processing`,
flip the flag back on long enough for the hourly sweep to settle it.

**Deployed 2026-07-27 — Rematch + audit hardening + retention (`35df65b`, 40
commits).** Carried the paid **Rematch** feature (`REMATCH_PRODUCT_SPEC.md`,
PRODUCT_SPEC §3.11) plus the security/audit hardening batch (AUTH-1, XSS-1,
ADMIN-1/2, BONUS-1, liveness-session binding, report-triage bounding, OTP
connection handling, 12 dependency advisories), the data-retention sweep, the
durable venue-change refund rail, and the founder-report 90-day link expiry.

Preflight green locally: **171 bot / 15 webapp / 13 shared test files (2251 /
144 / 205 tests)**, all typechecks clean, `pnpm build` clean, tree clean and
level with `origin/main`.

Ran Deploy Full Server Code → `db:push` → `db:drift-check` (**OK**) →
`pm2 restart`, then Deploy Mini App Only (`apps/webapp` changed). The rsync
dry-run listed exactly **2** deletions, both stale `apps/video/build`
artifacts; `.env*` and `keys/` were excluded and the 5 `.env.bak.*` rollback
snapshots survived.

**Schema step was verified additive before running:** `prisma migrate diff
--script` produced **zero DROP statements** — only `founder_reports.expires_at`,
`users.pending_liveness_session_id`, and the new `venue_change_purchases` table
(+ its unique/FK indexes). Notably the Rematch objects (`matches.source`,
`matches.rematch_paid_by_id`, `rematch_purchases`) were **already present in the
prod DB** and so did not appear in the plan.

**Rematch shipped dark and was verified inert** *(superseded the same day — see
the env-only flip above)*: no `REMATCH_*` keys existed in `/opt/gennety/.env`,
so `REMATCH_FEATURE_ENABLED` defaulted to `false`; the startup log correctly
showed **no** "Rematch refund retry" cron (it registers only when the flag is
on) while the new "Venue-change refund retry" and "Data retention" crons did
appear.

Post-deploy verified: `Bot @gennetybot started`, all crons registered,
`:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, **all 11 Mini App pages
`200`**, zero `P2022` / `FATAL` / unhandled rejections, and the PM2 restart
count moved exactly 28 → 29 (no crash loop). The status-timer heartbeat's
`permanentFailures: 2` is the known pre-existing "chat not found" for two
unreachable Telegram rows, not a regression.

**Deployed 2026-07-25 (later) — phone-based account login (`d1ad29f`).**
Code-only: no Prisma schema change, no env change, no flag change. A verified
phone number now resolves to the existing account instead of dead-ending on
"this number is already linked to another account" (PRODUCT_SPEC §1.1,
`services/account-linking.ts`), which is what unblocks a user who verified on
the iOS rail and then opened the bot, or who re-created their Telegram account.
Preflight green locally: **166 bot / 13 webapp / 13 shared test files (2156 /
127 / 202 tests)**, both typechecks clean, `pnpm build` clean, tree level with
`origin/main`. (One pre-existing lint error in `apps/webapp/src/referral.ts:277`
is unrelated and was left alone.)

Ran Deploy Full Server Code → `db:drift-check` (**OK**, nothing to push) →
`pm2 restart`, then Deploy Mini App Only (`apps/webapp` changed: a `completed`
account now routes straight to the done screen). The rsync dry-run listed only
two stale `apps/video/build` artifacts as deletions. Post-deploy verified:
`Bot @gennetybot started`, all 14 crons registered, `:3100`/`:3101` listening,
`/v1/ping` ok, admin `401`, all 11 Mini App pages `200`, no `P2022` / unhandled
rejections, and the PM2 restart count held at 25 (no crash loop).

**Deployed 2026-07-25 — full catch-up release + dev↔prod isolation fix.**
Prod was 85 commits behind (146 files); it had no referral/promo code at all.
Preflight was green locally (`typecheck` clean, **164 test files / 2127 tests
passed**, `openapi:lint` valid, tree clean and level with `origin/main`).
Deployed with Deploy Full Server Code → additive `db:push` → `db:drift-check`
→ `pm2 restart`, then Deploy Mini App. The schema step was verified additive
twice before running: the prod↔local `schema.prisma` diff showed no column
removals, and `prisma migrate diff --script` produced **zero DROP statements**
(6 new columns — `matches.proposal_deadline_nudge_sent_at`,
`matches.synergy_reason_b`, `users.promo_redeemed_at`,
`users.referral_counted_at`, `users.referral_invitee_premium_at`,
`users.referral_verified_count` — plus the `promo_codes` /
`promo_redemptions` tables). Post-deploy: `Bot @gennetybot started`, all 14
crons registered, `:3100`/`:3101` listening, `/v1/ping` ok, admin `401`, all
11 Mini App pages `200`, **zero new `P2022`** (the 113 in the historical log
all predate earlier pushes).

Flag changes in this deploy (`/opt/gennety/.env`, backed up first):

| Key | Before | After | Why |
|---|---|---|---|
| `VENUE_INTENT_V2_ROLLOUT_PERCENT` | `10` | `100` | Founder decision — full live after the 2026-07-25 dev E2E ran the two-step concierge end-to-end. **Note this skips the staged 10→50→100 / 48h-per-step guard documented in the Venue Intent V2 rollout section**; acceptable here only because prod had 0 matches at the time. Roll back to `10` on any hard-constraint violation or fake/closed assignment. |
| `VENUE_INTENT_V2_SHADOW_PERCENT` | `100` | `0` | Redundant once live is 100% (dev parity). |
| `TYPE_PREF_FLOOR` | `1.0` | `0.7` | `V_type` now actually re-ranks instead of shadow no-op. Safe for the existing cohort: `typePreferenceMultiplier` returns `1` when the seeker has no radar signal or the candidate has no overlapping appearance tags. |
| `PROMO_FEATURE_ENABLED` | (unset) | `true` | Inert until a code exists — create with `pnpm promo:create`. |
| `REFERRAL_FEATURE_ENABLED` | (unset) | `false` | **Set explicitly, not left to the default.** The referral program is unfinished (founder decision 2026-07-25): its code ships with this release but every surface is gated — menu row, hub, `/v1/referral/*`, `/v1/me/referral*`, the onboarding wow screen, and the verification-pipeline reward all check the flag. Verified live: `/v1/referral/state` → `404`, `features.referral` → `false`. Flip to `true` to launch. |
| `PREMIUM_PRICE_USD_DISPLAY` | `$10` | `$9.99` | Clears the stale-value note from the 2026-07-21 deploy. |
| `PUBLIC_CORS_ORIGIN` | `*` | `https://dating-calendar.gennety.com,https://gennety.com,https://www.gennety.com` | Removes the wildcard warning. Verified: Mini App origin gets `access-control-allow-origin`, a foreign origin gets none, and native clients (no `Origin` header) are unaffected. |
| `EXPO_ACCESS_TOKEN` | `` (empty) | removed | Expo rail retired 2026-07-18; the process no longer reads it. |

**⚠️ rsync `--delete` footgun — the exclude list in Deploy Full Server Code was
widened.** The old list excluded only `.env`, `.env.local`, `.env.test`, so a
deploy silently deleted every `/opt/gennety/.env.bak.*` (the documented env
rollback path) **and `/opt/gennety/keys/`**. That is not hypothetical: the APNs
`.p8` key at `APNS_KEY_PATH=/opt/gennety/keys/AuthKey_JTLFAQ8RM2.p8` **is gone
from the droplet** (a full-filesystem `find / -name '*.p8'` returns nothing), so
native-iOS push and Live Activities are dead until the key is re-uploaded from
Apple Developer → Certificates → Keys. No user impact today (no iOS client has
shipped). The exclude list is now `.env*`, `keys/`, and the local tooling dirs;
always dry-run with `--itemize-changes | grep '^\*deleting'` before a real sync.
The 6 deletions in this run were all intended (4 obsolete `welcome-gift`
кружки dropped by commit `d068ccd`, which kept `ru.mp4` only, plus two
`apps/video/build` artifacts).

**Curated venue catalog: nothing to push.** Prod (972 active = 448 base +
90 premium `ua:kyiv` + 434 legacy `city_key NULL` rows the runtime dedupes by
`placeId`) is a superset of dev (537), with equal-or-better facet coverage
(338 vs 337 base, 87 vs 87 premium).

**Deployed 2026-07-23 — dev↔prod schema-drift reconciliation + 2026-07-22 code
release.** The prod DB was a day behind the code: additive schema from
venue-intent-v2 (`matches.venue_*` + the `venue_selection_logs` table +
`curated_venues` enrichment, `8181bfb`), Type Radar (`profiles.type_radar_*`/
`appearance_tags` + `match_score_logs.score_type`, `6cbd996`), and
`subscription_ledger.note` (`b8b2975`) was missing, and the DB still carried the
dead `web_registration_links` table (6 rows) + `WebRegistrationPurpose` enum
(removed from code 2026-07-19). Reconciled with one
`prisma db push --accept-data-loss` (Variant B: +32 columns, +`venue_selection_logs`
+ indexes, dropping only the two dead objects; a full `SELECT *` logical backup of
all 24 tables was taken first via `scripts/dump-prod-backup.mjs`). Then Deploy Full
Server Code (rsync → build → `pnpm db:drift-check` gate → `pm2 restart`) and Deploy
Mini App (`deploy-webapp.sh`). Verified: `db:drift-check` OK on the droplet, bot
online with admin `:3100` + public `:3101` listening, `/v1/ping` healthy, zero new
P2022, all Mini App pages `200`. No feature flags changed. The new
`pnpm db:drift-check` preflight guard (`8fa57cb`) is now the mandatory gate in
Deploy Full Server Code below.

Prior full deploy: 2026-07-21 (**Gennety Premium launch**:
recurring Telegram Stars + StoreKit subscription, venue-change premium tier.
`PREMIUM_FEATURE_ENABLED=true` + `PREMIUM_STARS=500` / `PREMIUM_PRICE_USD_DISPLAY=$10`
/ `PREMIUM_APPSTORE_PRODUCT_ID=premium_monthly` added; Mini App redeployed
(`premium.html` + reworked `venue-change.html`); Kyiv premium catalog imported
(70 premium venues, 14/domain × 5 domains); `features.premium: true` live,
`/v1/premium/state` → 401 (mounted+on). **Schema applied additively via
`prisma db execute`, NOT `db:push`:** the prod DB still carries the obsolete
`web_registration_links` table (6 rows) + `WebRegistrationPurpose` enum from the
2026-07-19 web-registration removal, so a plain `db:push` demands
`--accept-data-loss` to drop them. To keep the Premium launch additive-only, the
five premium ALTER/CREATE statements (`users.premium_*`, `curated_venues.tier`,
`matches.venue_change_tier`, `subscription_ledger`) were generated with
`prisma migrate diff` and run via `prisma db execute`, filtering out the two
DROP statements. **Follow-up (separate, founder-approved):** run
`prisma db push --accept-data-loss` to drop the dead `web_registration_links`
table + enum once you're comfortable — no code reads them (PRODUCT_SPEC §1.1).
Prior full deploys: 2026-07-18 (iOS Stage 0 backend slice:
`/v1/app/config`, phone rail `/v1/auth/phone/*` (Gateway/Twilio creds not yet
set → clean 503), direct APNs transport with the live `.p8` key at
`/opt/gennety/keys/AuthKey_JTLFAQ8RM2.p8` (sandbox probe returned
`BadDeviceToken` = provider auth verified), additive `db:push` of
`phone_otps` + `live_activity_tokens`, and the advisory-lock P2010 hotfix —
see the Prisma gotcha below). Prior full deploys: 2026-07-17 (security/i18n
+ `ALLOW_SANDBOX_PERSONA=true`; PM2 command changed to the explicit tsx
binary path — see the PM2 gotcha in Production Inventory), 2026-07-15,
2026-07-13.

**Prisma raw-SQL gotcha (2026-07-18):** `pg_advisory_xact_lock(...)` returns
`void`, and Prisma 6.19+ throws P2010 ("Failed to deserialize column of type
'void'") when it is run through `$queryRawUnsafe`. Use `$executeRawUnsafe`
for lock/side-effect statements — it skips result deserialization. This bit
the phone rail's first live probe and was latent in the email-OTP path.

This file is the production runbook for the DigitalOcean deployment. It
contains the real hostnames, paths, service names, and deploy commands. Raw
secret values are intentionally not duplicated here: keep them only in the
gitignored env files and provider dashboards listed below.

## Production Inventory

| Item | Value |
|---|---|
| Droplet | DigitalOcean droplet `Gennety-Dating` |
| Public IP | `167.172.178.229` |
| SSH user | `root` |
| SSH key on this Mac | `~/.ssh/id_rsa` |
| Local repo | `/Users/pro/Desktop/Gennety Dating` |
| GitHub remote | `https://github.com/Gennety-Dating/Gennety-Dating-Backend.git` |
| Production code path | `/opt/gennety` |
| Production env file | `/opt/gennety/.env` |
| Mini App static path | `/var/www/dating-app` |
| Caddy config | `/etc/caddy/Caddyfile` |
| PM2 process | `gennety-bot` |
| PM2 cwd | `/opt/gennety` |
| PM2 command | `cd /opt/gennety && ./apps/bot/node_modules/.bin/tsx apps/bot/src/index.ts` |
| PM2 startup service | `pm2-root.service` |

**PM2 command gotcha (2026-07-17):** the process must launch tsx via the
explicit workspace binary (`./apps/bot/node_modules/.bin/tsx`), NOT `npx tsx`.
`tsx` is a devDependency of `apps/bot` only; after the 2026-07-16 lockfile
change, `pnpm install` no longer hoists a root `node_modules/.bin/tsx`, so
`npx tsx` from `/opt/gennety` hits `tsx: not found` and PM2 crash-loops
(observed live on the 2026-07-17 deploy). Keep the cwd at `/opt/gennety` —
`.env` resolution is file-relative and unaffected, but stay consistent.

## Autonomous Deploy Rule

When asked to deploy, use this file as the canonical source and proceed without
asking for hostnames, paths, service names, Caddy routes, env-file locations, or
credential locations. Pick the deploy path from the user's wording:

- "deploy everything", "full deploy", "deploy server", or backend/code changes:
  use **Deploy Full Server Code**.
- "deploy Mini App", "deploy webapp", "calendar", or frontend-only changes:
  use **Deploy Mini App Only**.
- "env", "token", "secret", "port", or config-only changes:
  use **Deploy Env-Only Changes**.
- Prisma schema changes: run the schema step in **Deploy Full Server Code**.

Only stop to ask when access is blocked, required secrets are missing from the
documented locations, or the requested action is destructive beyond the rollback
steps documented here.

Production runtime versions verified on the droplet:

- Node.js `v20.20.2`
- pnpm `10.33.0`
- npm `10.8.2`
- PM2 `6.0.14`
- Caddy `2.6.2`

## Required Production System Dependency

Profile photo/video validation launches `ffmpeg` and `ffprobe` as operating
system processes. They are not JavaScript packages, so `pnpm install` does not
install them. The Ubuntu/Debian package named `ffmpeg` provides both commands.

Install it once on the current droplet, and repeat this step for every
replacement/rebuilt production host:

```sh
ssh root@167.172.178.229 '
  if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg
  fi
  ffmpeg -version | head -n 1
  ffprobe -version | head -n 1
'
```

The long local Homebrew build on Intel macOS is not the expected production
path. Ubuntu normally installs a prebuilt `apt` package. Never set
`PROFILE_MEDIA_VALIDATION_ENABLED=true` until both production version checks
succeed.

## Dev ↔ Prod Isolation

Production is the controlled environment with real users; local dev is for
testing. Nothing may flow between them. Audited 2026-07-25 — current state:

| Resource | Dev | Prod | Isolated? |
|---|---|---|---|
| Postgres | local Docker `localhost:5434/gennety_dev` (`pnpm dev:db:up`) | Supabase `aws-0-eu-west-1.pooler…/postgres` | ✅ separate servers |
| Telegram bot | `@gennetytestbot` (token `8627…`) | `@gennetybot` (token `8707…`) | ✅ separate tokens — mandatory, long polling delivers each update to exactly one consumer |
| Supabase Storage | `selfies-dev` / `profile-photos-dev` / `chat-attachments-dev` | `selfies` / `profile-photos` / `chat-attachments` | ✅ since 2026-07-25 (same project, separate buckets) |
| OpenAI / Resend / AWS / Places | shared keys | shared keys | ⚪ stateless — no cross-contamination |
| Founder ops bot | shared `FOUNDER_BOT_TOKEN` + chat, feed OFF | same token/chat, feed ON | ✅ since 2026-07-25 — see below |
| Identity liveness | shared AWS creds; sessions are per-request | same | ✅ since 2026-07-26 — AWS Face Liveness sessions carry no shared server-side config and no webhook, so dev and prod cannot reach each other (this row used to be Persona's ⚠️) |

**Fixed 2026-07-25 — founder-feed leak (dev registrations in the real ops
DM).** There is only ONE founder bot and ONE founder chat, and `.env.local`
carried `FOUNDER_NOTIFY_ENABLED=true` with the same `FOUNDER_BOT_TOKEN` /
`FOUNDER_TELEGRAM_ID` as prod, so local test accounts were announced to the
founder exactly like real users. Confirmed: the dev DB has 2 users with
`founderNotifiedAt` set (2026-07-25 11:42 / 12:12) — both fired from
`@gennetytestbot`. Two locks now: `.env.local` (+ `.env.local.example`) sets
`FOUNDER_NOTIFY_ENABLED=false`, and `services/founder-notify.ts` hard-suppresses
the feed whenever `NODE_ENV=development` (the value `scripts/dev-bot.mjs` sets;
prod leaves `NODE_ENV` unset, and ONLY an explicit `development` mutes the
feed, so a missing value can never silence production). Everything reaching the
founder DM is therefore prod-only: new activations, freeze/delete snapshots,
weekly-match reports, scheduled-date cards, and ops alerts.

**Fixed 2026-07-25 — Supabase Storage leak.** `.env.local` overrides
`BOT_TOKEN` and `DATABASE_URL` but used to leave `SUPABASE_*` to `.env` (the
prod-like copy), so the dev bot wrote Persona selfies, mobile profile photos,
and chat images straight into the **production** buckets. Confirmed: dev user
ids `5607aa76…` / `1a357d89…` had objects in prod `selfies`. `.env.local` now
pins `SUPABASE_SELFIE_BUCKET=selfies-dev`, `SUPABASE_PHOTO_BUCKET=
profile-photos-dev`, `SUPABASE_CHAT_BUCKET=chat-attachments-dev`
(`.env.local.example` carries the same block). The URL and service key stay
shared, so a stronger isolation would be a second Supabase project for dev.

**Known residue — orphaned dev objects in the prod `selfies` bucket.** 6 of
its 8 user-id prefixes belong to no prod user row (`6efffed1…`, `5a61bdad…`,
`5607aa76…`, `4ce48f96…`, `29ed79a8…`, `1a357d89…`); only `d9731286…` and
`2a899ad8…` are real prod selfies. Deleting the six is a destructive prod
storage operation — do it deliberately, not as part of a deploy.

**Resolved 2026-07-26 — the Persona webhook cross-talk is gone.** Dev and prod
used to share one Persona template whose webhook target pointed at prod, so a
**dev** verification fired a webhook at **production** (it no-op'd on an unknown
reference-id, but it polluted the prod error log, and the dev bot never received
a webhook at all). AWS Face Liveness has no webhook and no shared template: each
session is created and read within one request, by whichever process created it.
Dev and prod share only the stateless AWS credentials, so a dev check is
invisible to prod. Billing is shared — a dev liveness check costs the same
$0.015 as a real one, which is worth remembering during test loops.

**Never** point local code at prod: keep `.env.local` present (deleting it
makes the local process load `.env`, i.e. the **production** bot token and
database), and never rsync `.env.local` to the droplet.

## Credentials And Secrets

Do not paste raw tokens, passwords, private keys, or database URLs into this
file. This repo explicitly forbids committing secrets. The deployment still has
all credential locations documented here:

| Credential | Where to get it |
|---|---|
| SSH private key | Local machine: `~/.ssh/id_rsa` |
| Production bot/env secrets | Droplet: `/opt/gennety/.env` |
| Local production env copy | Local repo: `.env` |
| Local dev overrides | Local repo: `.env.local` |
| DigitalOcean access | DigitalOcean dashboard for droplet `Gennety-Dating` |
| DNS | Hostinger DNS for `gennety.com` |
| Telegram production bot | BotFather entry for `@gennetybot`; token is `BOT_TOKEN` |
| Telegram dev bot | BotFather entry for `@gennetytestbot`; token is in `.env.local` |
| Supabase Postgres/storage | Supabase dashboard; URL/key values are in `.env` / `/opt/gennety/.env` |
| OpenAI | OpenAI dashboard; key is `OPENAI_API_KEY` |
| Resend | Resend dashboard; key is `RESEND_API_KEY` |
| AWS Face Liveness | Same IAM user as Rekognition (`gennety-bot-rekognition`) plus the `GennetyLivenessClient` role — see "Verification production gate" |
| AWS Rekognition | AWS IAM user `gennety-bot-rekognition` |
| Google Places | Google Cloud API key `PLACES_API_KEY` |
| APNs push (native iOS) | Apple Developer → Certificates → Keys: `.p8` APNs Auth Key (`APNS_KEY_PATH` on the droplet) + Key ID + Team ID |
| Twilio Verify (primary phone rail) | Twilio console; `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` |
| Telegram Gateway (optional secondary) | gateway.telegram.org (login with the founder's Telegram); token is `TELEGRAM_GATEWAY_TOKEN` |

SSH connect:

```sh
ssh root@167.172.178.229
```

SSH connect with explicit key:

```sh
ssh -i ~/.ssh/id_rsa root@167.172.178.229
```

List configured production env keys without printing values:

```sh
ssh root@167.172.178.229 'cut -d= -f1 /opt/gennety/.env'
```

Edit production env:

```sh
ssh root@167.172.178.229
cd /opt/gennety
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
nano .env
pm2 restart gennety-bot --update-env
pm2 save
```

Important: production and local development must never share `BOT_TOKEN`.
Telegram long polling sends each update to only one consumer, so a local
process using the production token can steal updates from production.

## Production Endpoints

| Endpoint | Target | Purpose |
|---|---|---|
| `https://dating-api.gennety.com` | Caddy -> `localhost:3101` | Public `/v1/*` API for the mobile app and the Telegram Mini Apps |
| `https://api-admin.gennety.com` | Caddy -> `localhost:3100` | Admin analytics API, `ADMIN_API_KEY` bearer auth |
| `https://dating-calendar.gennety.com` | `/var/www/dating-app` | Telegram Mini App static bundles |
| `@gennetybot` | PM2 process `gennety-bot` | Production Telegram bot, long polling |

There is no identity-provider webhook any more: Face Liveness verdicts are read
server-to-server inside the client's `/event` request (the session expires 3
minutes after it is minted). `/v1/webhooks/persona` was removed — Persona's
dashboard webhook can be deleted on their side.

Known Caddy config:

```caddyfile
api-admin.gennety.com {
    reverse_proxy localhost:3100
}

dating-api.gennety.com {
    reverse_proxy /v1/* localhost:3101
}

dating-calendar.gennety.com {
    root * /var/www/dating-app
    file_server
    encode gzip zstd
    try_files {path} /index.html

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    @assets path *.js *.css *.svg *.png *.woff2
    header @assets Cache-Control "public, max-age=31536000, immutable"
    header /index.html Cache-Control "no-cache"
}
```

## Preflight Before Deploy

Run from the local repo:

```sh
cd "/Users/pro/Desktop/Gennety Dating"
git status --short
pnpm install
pnpm test
pnpm build
pnpm security:secrets
pnpm security:audit
```

`pnpm security:audit` is a **mandatory** preflight step (added 2026-07-26). It
existed as a script long before it was in this runbook, and the gap is exactly
how a CRITICAL `fast-xml-parser` advisory reached the shipped Mini App bundle —
the package rides in via `@aws-amplify/ui-react-liveness`, so a client-side CVE
was invisible to any server-side check. Fix transitive advisories with an entry
in the root `pnpm.overrides` block (already used for seven packages) rather than
waiting on the upstream dependency. **Never pin an override BELOW the patched
version** — `postcss` was held at `8.5.10` while the fix was `8.5.18`, so the
override itself was the vulnerability.

**An override rots — re-check the pinned versions every deploy, not only when
adding one.** This recurred on 2026-08-07, to three overrides at once
(`postcss` 8.5.18, `fast-uri` 3.1.4, `brace-expansion` 5.0.8), each sitting
exactly one patch below a **newly published** advisory. Every one had been
correct when written; the bar moved underneath them, and the block still looked
deliberate and healthy on inspection. `pnpm audit` is the only thing that
notices. Triage the output by whether the path reaches the droplet runtime — an
`apps/video > @remotion/cli` or `eslint > …` chain is build/dev-only and never
ships, while `apps/bot > …` does — but fix all of them anyway, because the gate
is pass/fail and one tolerated advisory turns it into a permanently red check
nobody reads.

Identity and profile-media validation preflight:

```sh
ffmpeg -version
ffprobe -version
# The process must refuse to boot unless all of these are production-ready:
grep -E '^(MANDATORY_VERIFICATION_ENABLED|FACE_LIVENESS_ENABLED|LIVENESS_STS_ROLE_ARN|FACE_MATCH_PROVIDER|PROFILE_MEDIA_VALIDATION_ENABLED)=' .env
```

These local checks do not prove that the production droplet has the package.
Run the server-side installation/check in **Required Production System
Dependency** during the production rollout.

Verify the three narrow Rekognition actions and run consenting/synthetic QA
media before deployment. Production must have
`MANDATORY_VERIFICATION_ENABLED=true`, `FACE_LIVENESS_ENABLED=true`, a
configured `LIVENESS_STS_ROLE_ARN`, `FACE_MATCH_PROVIDER=rekognition`, and
`PROFILE_MEDIA_VALIDATION_ENABLED=true`. The process now fails closed before
starting if any trust boundary is weakened. An identity-provider outage is not
rolled back by disabling verification; pause new onboarding or roll back code
while keeping existing verified users safe.

For narrow code changes, file-scoped tests are acceptable before the full build:

```sh
pnpm vitest run path/to/file.test.ts
pnpm tsc --noEmit --project apps/bot/tsconfig.json
```

Check production is reachable before changing it:

```sh
ssh root@167.172.178.229 'pm2 status'
curl -s https://dating-api.gennety.com/v1/ping
curl -sI https://dating-calendar.gennety.com
curl -sI https://dating-calendar.gennety.com/onboarding.html
curl -sI https://dating-calendar.gennety.com/verification.html
curl -sI https://dating-calendar.gennety.com/ticket.html
curl -sI https://dating-calendar.gennety.com/tickets.html
curl -sI https://dating-calendar.gennety.com/venue-change.html
curl -sI https://api-admin.gennety.com
```

Expected smoke results:

- `dating-api.gennety.com/v1/ping` returns JSON with `"ok": true`.
- `dating-calendar.gennety.com` returns HTTP `200`.
- `dating-calendar.gennety.com/onboarding.html` returns HTTP `200`.
- `dating-calendar.gennety.com/verification.html` returns HTTP `200`.
- `dating-calendar.gennety.com/ticket.html` returns HTTP `200`.
- `dating-calendar.gennety.com/venue-change.html` returns HTTP `200`.
- `api-admin.gennety.com` returns HTTP `401` without bearer auth.

## Deploy Full Server Code

The droplet path `/opt/gennety` is not a git checkout. Deploy by syncing the
local working tree to the server while preserving remote env files.

From the local repo:

```sh
cd "/Users/pro/Desktop/Gennety Dating"

```sh
# ALWAYS dry-run first. Every line must be a deletion you intend.
rsync -az --delete --dry-run --itemize-changes \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' --exclude 'tmp/' \
  --exclude '.env*' --exclude 'keys/' --exclude '*-backup-*.json' \
  --exclude '.claude/' --exclude '.agents/' --exclude '.codex/' --exclude '.gstack/' \
  ./ root@167.172.178.229:/opt/gennety/ | grep '^\*deleting'
```

Then the real sync (identical flags, minus `--dry-run`):

```sh
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'tmp/' \
  --exclude '.env*' \
  --exclude 'keys/' \
  --exclude '*-backup-*.json' \
  --exclude '.claude/' \
  --exclude '.agents/' \
  --exclude '.codex/' \
  --exclude '.gstack/' \
  ./ root@167.172.178.229:/opt/gennety/
```

**`.env*`, `keys/` and `*-backup-*.json` are not optional excludes.** `.env*`
(not just `.env`) covers the `.env.bak.*` snapshots that Rollback depends on.
`keys/` holds server-only Apple secrets (`APNS_KEY_PATH`, `APPSTORE_KEY_PATH`)
that exist nowhere in the repo — the narrower pre-2026-07-25 list already
destroyed the APNs `.p8` once. `*-backup-*.json` covers the **two** droplet-only
database backups, which live in the repo root and are matched by nothing else:

```
/opt/gennety/ethnicity-backup-2026-08-02T08-26-08-301Z.json   (1 KB)
/opt/gennety/prod-backup-2026-07-27T14-08-06-066Z.json        (3.3 MB)
```

Until 2026-08-07 this exclude was mentioned only in the 2026-08-02 release note,
named only the first file, and was **absent from the flag set above** — so
following this section literally destroyed both. `ls /opt/gennety/*.json` after
any deploy; it is the same class of failure as the `keys/` deletion.

Then install, validate, and restart on the droplet:

```sh
ssh root@167.172.178.229
cd /opt/gennety

# Required once per production host. Safe to keep in the deploy checklist:
# installation is skipped when both commands already exist.
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg
fi
ffmpeg -version | head -n 1
ffprobe -version | head -n 1

pnpm install --frozen-lockfile
pnpm --filter @gennety/db db:generate
pnpm build
```

If `packages/db/prisma/schema.prisma` changed, update the production database
schema before restarting the bot. The Prisma CLI runs inside `packages/db` and
does **not** read the root `/opt/gennety/.env`, so `DATABASE_URL` must be passed
in explicitly — without it `db:push` fails with `P1012: Environment variable not
found: DATABASE_URL`:

```sh
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db db:push
```

There is no Prisma migrations directory in this repo at the moment, so the
current workflow is Prisma `db:push`. Before risky schema changes, take a
Supabase backup from the Supabase dashboard. The droplet currently does not
have `pg_dump` installed.

Prisma refuses to add a `@unique` column without `--accept-data-loss`, even when
the column is brand new (it cannot know the column will be all-`NULL`). Before
reaching for that flag, confirm the change is genuinely additive. The
authoritative gate is `pnpm db:drift-check` (it introspects the live prod DB
rather than diffing schema files); to SEE which DROPs `--accept-data-loss` would
run, dump the plan with `prisma migrate diff --from-schema-datasource
prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` (URL
read from env, never `--from-url`, which would leak the password into `ps` and
pnpm's failure echo) and confirm every DROP is one you intend. The older manual
pair below still works as a cross-check — the deploy is only safe if **both** hold:

```sh
# 1. No column/model removals in the schema diff (empty output = additive only):
diff -u <(ssh root@167.172.178.229 'cat /opt/gennety/packages/db/prisma/schema.prisma') \
        packages/db/prisma/schema.prisma | grep '^-' | grep -v '^---' | grep -vE '^-\s*(///)?\s*$'
# 2. The new unique columns do not yet exist in the *public* schema (Supabase's
#    auth.users has its own `phone` column — always filter on table_schema).
```

Then run `pnpm --filter @gennety/db db:push --accept-data-loss`.

**Schema drift is a real failure mode here.** A production DB missing a column
the code reads throws `P2022` as an *unhandled rejection*, which kills the
process — an unnoticed drift shows up as a PM2 restart loop, not as a clean
error. If `pm2 status` shows a climbing restart count, check
`grep P2022 /root/.pm2/logs/gennety-bot-error.log` before anything else; a
`db:push` is the fix.

**Mandatory drift gate before restart.** Whether or not you think the schema
changed, confirm the production DB now matches the code schema — this turns the
silent P2022 crash-loop above into a clean pre-restart stop:

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm db:drift-check   # exit 0 = match (safe); exit 2 = DRIFT → run db:push, re-check
```

Restart after the code and any required schema update are both in place:

```sh
pm2 restart gennety-bot --update-env
pm2 save
```

## Deploy Mini App Only

Use the existing script:

```sh
cd "/Users/pro/Desktop/Gennety Dating"
./scripts/deploy-webapp.sh
curl -sI https://dating-calendar.gennety.com
curl -sI https://dating-calendar.gennety.com/onboarding.html
curl -sI https://dating-calendar.gennety.com/verification.html
curl -sI https://dating-calendar.gennety.com/ticket.html
curl -sI https://dating-calendar.gennety.com/tickets.html
curl -sI https://dating-calendar.gennety.com/venue-change.html
```

The script builds `apps/webapp` with Vite and rsyncs:

```text
apps/webapp/dist/ -> root@167.172.178.229:/var/www/dating-app/
```

Vite is configured for multiple entries (`vite.config.ts`), so the same rsync
deploys the Mini Apps together — `index.html` (calendar), `feedback.html`
(post-date feedback), `location.html` (venue handoff), `onboarding.html`
(full-screen Telegram onboarding), `verification.html` (AWS Face Liveness
Embedded SDK KYC flow), `ticket.html` (Date Ticket, feature-flagged
premium post-accept gate), `tickets.html` (ticket store / wallet,
feature-flagged pre-purchase bundles), and `venue-change.html` (feature-flagged
female-exclusive venue swap). Caddy's `try_files {path} /index.html` resolves
direct hits like `/feedback.html` and `/onboarding.html` before the SPA
fallback.

The liveness flow needs one one-time provider-side setup step (it doesn't
affect rsync output, but skipping it breaks the Mini App):
1. **BotFather** `/setdomain` → `dating-calendar.gennety.com` for
   `@gennetybot`. Without this, the Mini App can't request camera
   permissions inside the Telegram WebView.

Note the detector fetches its TF.js wasm backend and Blazeface model from
public CDNs by default. If a client network can't reach them, self-host both
from `/var/www/dating-app` and set `config.binaryPath` / `config.faceModelUrl`
in `apps/webapp/src/liveness-detector.tsx`.

The webapp production build bakes in:

```text
VITE_API_BASE_URL=https://dating-api.gennety.com
```

## Deploy Env-Only Changes

```sh
ssh root@167.172.178.229
cd /opt/gennety
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
nano .env
pm2 restart gennety-bot --update-env
pm2 save
pm2 logs gennety-bot --lines 80 --nostream
curl -s https://dating-api.gennety.com/v1/ping
```

### Production flag state last observed (2026-07-13)

**Update 2026-07-23 — remaining dark features enabled in safe shadow mode
(founder-approved, env-only + PM2 restart).** The two features that were still
off (Type Radar, Venue Intent V2) were switched on in their *designed* launch
posture — enabled but not yet influencing matching — NOT flipped to full live:
- `TYPE_RADAR_ENABLED=true` with `TYPE_PREF_FLOOR=1.0` — the "choose your type"
  onboarding step + answer collection go live; the `V_type` multiplier stays a
  no-op (shadow) until predictiveness is validated over 3–4 batches, per
  TYPE_RADAR_PRODUCT_SPEC. Verified live: `GET /v1/radar/deck` now returns `401`
  (auth-gated) instead of `404`.
- `VENUE_INTENT_V2_ENABLED=true` with `VENUE_INTENT_V2_SHADOW_PERCENT=100` /
  `VENUE_INTENT_V2_ROLLOUT_PERCENT=0` — the new two-step concierge selector
  computes + writes its append-only `venue_selection_logs` for 100% of pairs
  but real matches still schedule via the existing path (live 0%), exactly the
  documented "shadow ≥7 days / 30 pairs before advancing live" rollout.

**Superseded 2026-07-25.** Both were advanced to their live posture in the
catch-up deploy: `TYPE_PREF_FLOOR=0.7` (the `V_type` multiplier now re-ranks)
and `VENUE_INTENT_V2_ROLLOUT_PERCENT=100` / `SHADOW_PERCENT=0`. See the
2026-07-25 block at the top of this file, including the note that the venue
rollout skipped the staged 10→50→100 guard. `PROMO_FEATURE_ENABLED=true` was
added at the same time; `REFERRAL_FEATURE_ENABLED=false` is set explicitly
because the referral program is unfinished. **Superseded 2026-07-26 for
identity:** Persona and its `ALLOW_SANDBOX_PERSONA` override are gone; the
provider is AWS Face Liveness and the sandbox-vs-real-KYC question no longer
exists (see the block at the top of this file). No schema work remains.

Every product feature is now **on** in `/opt/gennety/.env`: tickets + Telegram
Stars, Registration v2's phone track, the fact collector (which is what actually
feeds the matching engine's vibe axes), Elo vision seed, pre-date coordination,
venue change v2, the date card, the match card, and Rekognition face-match.

`ENABLE_PERSONA_VERIFICATION` was on, while
`MANDATORY_VERIFICATION_ENABLED` was still off. After the identity trust-gate
hardening that state stopped booting; as of 2026-07-17
`MANDATORY_VERIFICATION_ENABLED=true` was set and production ran the sandbox
Persona key behind an explicit `ALLOW_SANDBOX_PERSONA=true` override. **That
whole arrangement was retired on 2026-07-26** when identity moved to AWS Face
Liveness — see "Verification production gate" below for the current gate.

**Provider credentials, verified by probing each one from the droplet** (a flag
is worthless without its provider):

| Credential | State | Consequence |
|---|---|---|
| Supabase (DB + Storage) | **migrated 2026-07-13 to a new project** — see below | Storage works for the first time (the old project's keys were never filled in — they were the literal `your_supabase_…` placeholders from `.env.example`, so uploads 403'd with `Invalid Compact JWS`). |
| `PERSONA_API_KEY` | **retired 2026-07-26** (was a SANDBOX key, `persona_sand…`, so identity checks were test flows rather than real KYC) | Replaced by AWS Face Liveness on the existing `AWS_*` credentials + the `GennetyLivenessClient` STS role. Verify with `pnpm probe-liveness`; delete the `PERSONA_*` keys from `/opt/gennety/.env`. |
| `PLACES_API_KEY` | ~~empty~~ → **set** (re-verified on the droplet 2026-07-25; a live Place Details probe of a real curated Kyiv venue returned its cover photo) | Google Places: the venue fallback when no curated venue is in range, the Location Mini App autocomplete, the venue-change catalog beyond curated rows, and — since 2026-07-25 — **every** venue photo, including for curated venues (resolved from `placeId` at assignment). Without it the curated base still covers Kyiv/Kharkiv/Odesa, so scheduling degrades to gradient-only cards rather than dying. |
| `EXPO_ACCESS_TOKEN` | retired 2026-07-18 (Expo rail removed; native push is direct APNs via `APNS_*`) | Can be deleted from `/opt/gennety/.env`; the process no longer reads it. |

Re-probe any credential from the droplet before trusting a flag flip; the probes
are cheap and each one of these was wrong in a different way.

### Supabase project migration (2026-07-13)

Production moved to a **new Supabase project** because the credentials for the
old one were lost. Current project ref: **`ophztqjrabwemkqwidkq`**
(`eu-west-1`); the old one was `junbjqkdhdjrpennczib` (`eu-north-1`), and it is
left **untouched and intact** as the rollback path — restoring it is a matter of
putting the old `DATABASE_URL` / `SUPABASE_*` values back from an `.env.bak.*`
and restarting.

The migration was cheap because the data was tiny (14 MB) and the schema is
code. If it ever has to be repeated:

1. Create the project, then set `DATABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` in `/opt/gennety/.env`.
   `SUPABASE_URL` is always `https://<project-ref>.supabase.co` — the ref is in
   the DB connection string's username **and** inside the JWT keys, so it never
   has to be looked up in the dashboard.
2. `pnpm --filter @gennety/db db:push` (with `DATABASE_URL` exported — see the
   schema section above). This creates every table **and** the `vector`
   extension, since the Prisma datasource declares `extensions = [vector]`.
   The functional `matches_pair_canonical_idx` is created by the bot at boot.
3. Copy the data with a Prisma script, users first (everything else FKs to
   them), then `profiles` / `onboarding_progress` / `no_match_notices` /
   `bot_sessions` / `system_knowledge` / `curated_venues`. `Profile.embedding`
   is `Unsupported("vector(1536)")` and cannot be copied through the Prisma
   client — set `embeddingDirty = true` on the copied profiles instead and let
   the `embedding-refresh` cron rebuild the vectors from OpenAI.
4. Create the three **private** buckets: `selfies`, `profile-photos`,
   `chat-attachments`.
5. Restart, then prove it: row counts match, `/v1/ping` is `ok`, and a probe
   upload into `SUPABASE_SELFIE_BUCKET` returns 200 (that upload is step 1 of
   `verification-pipeline.ts` and is exactly what used to fail).

### Verification production gate

**Provider: AWS Rekognition Face Liveness (migrated off Persona 2026-07-26).**
The migration's whole point was ending the sandbox era: production had been
running `ALLOW_SANDBOX_PERSONA=true` since 2026-07-17, i.e. Persona TEST flows
rather than real KYC, because a live Persona key costs a fixed ~$250/mo
regardless of volume. Face Liveness is ~$0.015 per check with no monthly floor
(so a paused ad campaign costs nothing), and our Persona template only ever
used selfie-liveness — no document checks — so nothing was lost functionally.

There is **no sandbox/production key split to police any more**, and therefore
no override to remove. `identityTrustConfigurationErrors` requires
`FACE_LIVENESS_ENABLED=true`, real `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, and `LIVENESS_STS_ROLE_ARN`, alongside the unchanged
`MANDATORY_VERIFICATION_ENABLED=true`, `FACE_MATCH_PROVIDER=rekognition` and
`PROFILE_MEDIA_VALIDATION_ENABLED=true`. A production-like process refuses to
start unless all of them hold — the credential check matters because
flag-on-but-unconfigured would render a verification CTA that opens a Mini App
with no session to run.

**Historical debt:** `verified` statuses granted during the sandbox window
(2026-07-17 → 2026-07-26) carry no real identity guarantee and were never
retroactively cleared. Audit that cohort before it matters commercially.

**Cost per verified user.** One liveness check ≈ **$0.015** (first 500k/mo,
us-east-1 list price; eu-central-1 may differ slightly) plus the existing
`CompareFaces` calls — one per profile photo, ≈ $0.001 each, so 4–10 photos add
≈ $0.004–0.010. A verified user therefore costs roughly **$0.02–0.03**, and a
retry costs another $0.015. At 1,000 registrations/month that is ~$25 versus
Persona's $250 floor.

**⚠️ Region: Face Liveness runs in `eu-west-1`, not `eu-central-1`.**
`FACE_LIVENESS_REGION` (default `eu-west-1`) is deliberately separate from
`AWS_REGION`, which stays `eu-central-1` for `CompareFaces` / `DetectFaces` /
moderation. Measured across every EU region on 2026-07-26, **`eu-west-1`
(Ireland) is the only one that serves Face Liveness** for this account —
`eu-central-1` and `eu-west-2` refuse it, and the rest have no Rekognition
endpoint at all. This is also where our Supabase project lives, so the
reference selfie never leaves that region.

**The trap that cost us a debugging session:** a region that does not serve Face
Liveness answers `CreateFaceLivenessSession` with an `AccessDeniedException`
carrying an **empty message** — indistinguishable from an IAM denial, and
nothing like the `UnknownOperationException` you would expect. If the probe
fails, rule out the region before touching IAM: `sts:AssumeRole` lives in the
same policy as the Rekognition permissions, so if step 2 of the probe succeeds
the policy is live and the region is your problem.

**Required AWS setup** (account `147010141827`; IAM is global, so no region
applies to these two steps). Both console-side:

1. Add to the `gennety-bot-rekognition` user policy:
   `rekognition:CreateFaceLivenessSession`,
   `rekognition:GetFaceLivenessSessionResults` (Resource `*`), and
   `sts:AssumeRole` on
   `arn:aws:iam::147010141827:role/GennetyLivenessClient`.
2. Create role **`GennetyLivenessClient`** — trust policy: Principal =
   `arn:aws:iam::147010141827:user/gennety-bot-rekognition`, Action
   `sts:AssumeRole`. Permission policy: `rekognition:StartFaceLivenessSession`
   on `*` and nothing else. This is the grant a user's browser/phone briefly
   holds (15 min, the AssumeRole floor) to sign its own video stream;
   Rekognition supports no resource-level ARN for that action, so the narrow
   action list plus the short TTL is the containment. The backend re-asserts
   the same ceiling as an inline session policy, so widening the role later
   does not silently widen what a client gets.

Verify all three permissions without a camera or a billed check:

```sh
pnpm probe-liveness   # CreateSession → AssumeRole → GetSessionResults
```

An unused session is not billed as a check and expires on its own after 3
minutes, so the probe is free and safe to re-run.

**BotFather `/setdomain` must include `dating-calendar.gennety.com`** — the
detector needs camera permission inside the Telegram WebView. (The Persona
"Allowed origins" dashboard step is gone with the provider.)

Matching admits only verified users and the persisted pre-flip skip cohort. The
AI vision Elo seed runs inside the verification pipeline, so live verification
also restores meaningful league calibration for new users.

Required/high-impact env keys:

- Telegram: `BOT_TOKEN`, `BOT_USERNAME`, `WEBAPP_URL`,
  `WEBAPP_FEEDBACK_URL` (optional — defaults to `${WEBAPP_URL}/feedback.html`,
  which Caddy already serves from the same `/var/www/dating-app` root),
  `CUSTOM_EMOJI_MENU_ID`, `CUSTOM_EMOJI_ACCEPT_ID`,
  `CUSTOM_EMOJI_DECLINE_ID`, `CUSTOM_EMOJI_VERIFIED_ID` (optional —
  animated checkmark next to a verified partner in the match-pitch caption;
  empty falls back to a static `✓` glyph),
  `CUSTOM_EMOJI_DATE_ID` (optional — animated icon on the conditional
  primary-styled "My Date" main-menu row; empty → the 💫 label still renders,
  just without an `icon_custom_emoji_id`), `MESSAGE_EFFECT_MATCH_ID`,
  `MESSAGE_EFFECT_FEEDBACK_ID` (optional — Bot API 7.6 effect on the T+24 h
  feedback DM; empty = no effect),
  `MESSAGE_EFFECT_MUTUAL_ID` (falling-hearts effect on the mutual-match reveal
  — the Date Ticket card, and only that card; **defaults to ❤️
  `5159385139981059251`, so no env change is needed** — set it empty to
  disable, or to another effect id to change the animation. Code-only
  otherwise: no schema, no flag, no Mini App change.)
- **My Date hub + scheduled-date banner (always-on — no feature flag).** The
  conditional "My Date" main-menu row and its hub (PRODUCT_SPEC §2.1) plus the
  status-banner countdown-to-your-date are always active; they degrade to the
  parts each sub-feature enables (the cached/re-rendered date card respects
  `DATE_CARD_FEATURE_ENABLED`, Change venue `VENUE_CHANGE_FEATURE_ENABLED`, Enter
  chat `COORDINATION_FEATURE_ENABLED`). **Requires `db:push` of the additive
  `matches.date_card_file_id_a` / `date_card_file_id_b` columns first**
  (non-destructive; they cache the rendered date-card `file_id` for instant hub
  re-open). No new system dependency; the only optional env is
  `CUSTOM_EMOJI_DATE_ID` above.
- Database/storage: `DATABASE_URL`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SELFIE_BUCKET`,
  `SUPABASE_PHOTO_BUCKET`, `SUPABASE_CHAT_BUCKET`
- AI/email/onboarding: `OPENAI_API_KEY`, `RESEND_API_KEY`, `SMTP_FROM`,
  `OTP_LOG_TO_CONSOLE`, `ONBOARDING_FACT_COLLECTOR_ENABLED` (default `false`;
  enable only after schema push and backfill verification)
  - **AI-memory export kill switch:** `AI_MEMORY_EXPORT_ENABLED` (default
    **`true`** — `config.ts` reads `!== "false"`, so the Magic Prompt branch
    stays on unless explicitly disabled). Set `AI_MEMORY_EXPORT_ENABLED=false`
    to hide the whole feature (PRODUCT_SPEC §1.3): the onboarding Mini App skips
    the AI-memory choice screen, `POST /v1/telegram-onboarding/ai-memory` 404s,
    and onboarding runs vibe → photos with the deterministic fallback summary —
    i.e. every user takes the existing "declined" path. **No schema change, no
    backfill, no Mini App rebuild required to flip it** (the bundle reads the
    server's `aiMemoryExportEnabled` from `/state`; redeploying the Mini App is
    only needed to pick up the client-side skip for *cached* older bundles,
    which are already safe because the server 404s the write). Toggle live with
    `pm2 restart gennety-bot --update-env`. Rollback = remove the line (or set
    `true`); `User.aiMemoryExportPreference` is never rewritten by the flag, so
    the branch returns exactly as it was. In-flight effects when turning it
    off: users parked on the choice screen / Magic Prompt step advance straight
    to photos, and a paste already buffered is dropped instead of saved.
    **Current state (2026-07-30): OFF in production AND off in dev.** Prod has
    carried `AI_MEMORY_EXPORT_ENABLED=false` in `/opt/gennety/.env` since
    2026-07-26; `.env.local` (+ `.env.local.example`) now sets the same, because
    the default is `true` and a dev box without the line walks an onboarding
    flow no production user can reach — choice screen → Magic Prompt paste →
    an AI-derived `psychologicalSummary` feeding `V_explicit`. Nothing in the
    production pool is AI-memory-derived: audited 2026-07-30, **zero** users
    have ever held `aiMemoryExportPreference = accepted` (15 rows: 14
    `undecided`, 1 `declined`), so the five populated `psychologicalSummary`
    values are all the deterministic vibe fallback. **Rollback trap:** four env
    backups predating 2026-07-26 (`.env.bak.20260713`…`20260725`) have no such
    line, so restoring one silently turns the feature back on.
  - **Vibe onboarding questions (no flag of their own).** The two §1.3 vibe
    questions (`friday_vibe` / `vibe_focus`) and their matching signal live in
    the collector, so they are active only when
    `ONBOARDING_FACT_COLLECTOR_ENABLED=true`. Requires `db:push` of the new
    `Profile.friday_vibe_text` / `vibe_focus_text` / `energy_axis` /
    `orientation_axis` / `social_role` / `anchor_tags` / `vibe_extracted_at`
    columns first (additive, non-destructive; missing columns → P2022
    crash-loop). No new system dependency — extraction reuses `OPENAI_API_KEY`.
    The matching weight re-split (`V_explicit` 0.65 / `V_research` 0.35) and the
    new vibe quadrant factor are code-only and need no env; `V_league` (and
    `MALE_REACH_ELO`) are unchanged.
- OpenAI model selection (single source of truth, `apps/bot/src/models.ts`):
  every chat/vision call site resolves its model from the `MODELS` map, so an
  OpenAI generation retirement is a one-line change (or a live env override).
  Current defaults are the GPT-5.6 tiers (migrated off the retiring GPT-5.4/4.1
  families 2026-07): `MODELS.vision`/`MODELS.agent` → **`gpt-5.6-terra`**
  (attractiveness Elo seed + conversational/user-facing generation),
  `MODELS.visionFast`/`MODELS.fast` → **`gpt-5.6-luna`** (simple photo checks +
  cheap classification / short worker DMs). Four optional overrides —
  `OPENAI_MODEL_VISION`, `OPENAI_MODEL_VISION_FAST`, `OPENAI_MODEL_AGENT`,
  `OPENAI_MODEL_FAST` — let ops pin/roll a model live via
  `pm2 restart gennety-bot --update-env`, no redeploy and no schema change.
  Embeddings (`text-embedding-3-small`), Whisper, and moderation are
  deliberately NOT routed through `MODELS` (changing the embedding model forces
  a full re-embed). Note: switching `MODELS.vision` shifts the Elo seed's score
  distribution for newly verified users; `Profile.eloSeedDetails.model` records
  the model per seed so the drift is auditable.
- Chat progress streams: no production env flag. Do not set or reintroduce a
  `RICH_THINKING_ENABLED` live toggle — the rich path is hard-coded per call site
  (`rich: true`), never a global default, because Telegram draft/rich-draft APIs
  are treated by clients as generated AI replies and can reserve scroll space
  below the preview, and that tradeoff must be chosen deliberately per flow.
  Two categories of stream exist:
  - **Thinking-status beats** (`runStatusSequence`, the "agent is analysing /
    working" lines): AI-memory analysis, liveness verify check, verification
    soft-skip, profile-video upload check, onboarding photo-burst check
    (`photoReviewSteps`), concierge venue selection, date-card
    render + share, plus the Profiler batch boundary, the Profiler in-batch
    questions (PRODUCT_SPEC §Phase 1b), and the periodic profile-survey
    "thinking" pause (PRODUCT_SPEC §1.3). These all call with `rich: true` so
    they render as the native `<tg-thinking>` shimmer + AI Actions `<tg-emoji>`
    draft, degrading to the classic `sendMessage` + `editMessageText` stream when
    a client can't render rich drafts. No env toggle gates this — nothing to
    configure at deploy time.
  - **Content streams** (`streamDraftsToChat(..., { rich: true })` →
    `streamRichDraftsToChat`): the match pitch, no-match notice, and ice-breaker
    DMs also stream via the native rich AI-compose draft path (lead "thinking"
    chunk = `<tg-thinking>` shimmer), but their **final persisted message is a
    plain `sendMessage`, never a rich message** — it must stay a normal text
    message, and the proposal-countdown worker live-edits the pitch's final
    message via `editMessageText`. Same degrade-to-classic fallback. Also no env
    toggle.
  The AI Actions `<tg-emoji>` glyphs are the baked `AI_EMOJI` ids in
  `services/ai-emoji.ts` (no env).
- Admin API: `ADMIN_API_KEY`, `ADMIN_PORT`, `ADMIN_DASHBOARD_ORIGIN`
- Public API: `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`,
  `PUBLIC_PORT`, `PUBLIC_CORS_ORIGIN` (comma-separated browser origins allowed to
  call `/v1/*`; empty now **denies** cross-origin instead of wildcarding — native
  mobile clients send no `Origin` header and are unaffected. Prefer listing the
  concrete browser origins — the Mini App host `https://dating-calendar.gennety.com`
  plus any web signup site — over `*`, which still works but logs a warning.)
- Native iOS app: `IOS_MIN_SUPPORTED_APP_VERSION` (optional, default empty →
  no forced update). Served pre-auth by `GET /v1/app/config` as
  `minSupportedIosVersion`; set e.g. `1.2.0` only to retire a broken/insecure
  old build — every older client blocks behind an "update the app" screen.
  Toggled live with `pm2 restart gennety-bot --update-env`; no schema change.
- Native-app phone rail (`/v1/auth/phone/*`, shares the Registration v2
  `PHONE_AUTH_ENABLED` gate — 404 while off): `TWILIO_ACCOUNT_SID` /
  `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` (**primary rail** —
  Twilio Verify, founder decision 2026-07-18; no phone number purchase
  needed) and optionally `TELEGRAM_GATEWAY_TOKEN` (secondary —
  gateway.telegram.org; empty → Gateway never used).
  `PHONE_CODE_PRIMARY_PROVIDER` (default `twilio`; set `telegram` to flip
  the order). Either rail alone works; with neither set the endpoints
  answer 503 and the Telegram one-tap flow is unaffected. Twilio gotchas:
  a trial account only texts numbers verified in the console, and Geo
  Permissions must allow the target countries.
  **An upgraded account is not immediately a sending account (2026-08-05).**
  The founder upgraded off trial and the REST API reported `type: "Full"`,
  `status: "active"`, `$20.00` balance within seconds — while a real send to a
  Ukrainian number was refused with **`403 / code 60238` "Verification Creation
  Attempt blocked by Twilio"**, which Twilio documents as the upgrade being
  under review (its only other cause is Iran/Syria/Cuba). Account type and
  sending permission are separate states, so **`type: Full` is not evidence
  that SMS works** — only a real send is. Twilio's guidance is to wait and to
  contact support if it persists past **72 hours**. Our side degrades
  correctly: `twilioStartVerification` returns null on the 403, the Gateway
  fallback is unconfigured, and the route answers a visible
  `503 "Code delivery unavailable"` rather than a phantom code-entry screen.
  Re-test with one command — no `verify` call, so no account is resolved,
  created or logged in:

```sh
curl -s -X POST https://dating-api.gennety.com/v1/auth/phone/request \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+380XXXXXXXXX","channel":"sms"}' -w '\n%{http_code}\n'
# 200 + deliveredVia:"sms" = the rail is open. 503 = still blocked;
# read the exact Twilio code from: pm2 logs gennety-bot --nostream | grep twilio
```

  A 60238 that outlives the review window is NOT the same failure as Geo
  Permissions (which must separately allow +380) — check the returned code
  before changing any console setting.
  **Requires `db:push` of the additive `phone_otps` table first**
  (non-destructive). Anti-SMS-pumping: per-phone+IP express limits plus a
  durable per-phone cooldown (60 s) and daily cap (6/day) in the table.
- StoreKit 2 tickets (native iOS; rides `TICKET_FEATURE_ENABLED`):
  `APPSTORE_KEY_PATH` (App Store Connect → Users and Access → Integrations →
  In-App Purchase key `.p8`, scp'd next to the APNs key), `APPSTORE_KEY_ID`,
  `APPSTORE_ISSUER_ID` (same Integrations page), `APPSTORE_BUNDLE_ID`
  (default `com.gennety.ios`), `APPSTORE_ENVIRONMENT` (`sandbox` default →
  TestFlight/dev purchases; `production` for App Store builds),
  `APPSTORE_TICKET_PRODUCTS` (default `ticket_1:1,ticket_3:3,ticket_6:6`).
  Server Notifications V2 URL to set in App Store Connect:
  `https://dating-api.gennety.com/v1/webhooks/appstore`. Without the keys
  the purchase endpoint answers 503; no schema change (rides the unique
  `ticket_ledger.external_payment_id` already deployed for Stars).
- Push (native iOS, direct APNs — the Expo rail was retired 2026-07-18):
  `APNS_KEY_PATH` (path to the `.p8` APNs Auth Key on the droplet, e.g.
  `/opt/gennety/keys/AuthKey_XXXXXX.p8` — NOT committed; scp it manually),
  `APNS_KEY_ID` (the key's 10-char id), `APNS_TEAM_ID` (Apple Developer
  Team ID), `APNS_BUNDLE_ID` (default `com.gennety.ios`),
  `APNS_ENVIRONMENT` (`sandbox` default — dev/TestFlight builds use the
  sandbox host; set `production` for App Store builds). With any of the
  first three empty, pushes are dropped with a warning and everything else
  works. **Requires `db:push` of the additive `live_activity_tokens` table
  first** (non-destructive). `EXPO_ACCESS_TOKEN` is retired and can be
  removed from `/opt/gennety/.env`.
- Liveness (AWS Rekognition Face Liveness — replaced Persona 2026-07-26):
  `FACE_LIVENESS_ENABLED` (must be `true` in production — startup fails
  closed), `FACE_LIVENESS_MIN_CONFIDENCE` (default `0.8`; below it the check is
  RETRYABLE, never `rejected`), `LIVENESS_STS_ROLE_ARN`
  (`arn:aws:iam::147010141827:role/GennetyLivenessClient`),
  `LIVENESS_CREDENTIALS_TTL_SECONDS` (default/floor `900`). Reuses the existing
  `AWS_*` credentials and region. **Since 2026-07-26 requires `db:push` of the
  additive `users.pending_liveness_session_id` column** (nullable,
  non-destructive) — it binds a liveness session to the user who minted it, and
  the `/event` handler reads it unconditionally, so a DB missing it throws
  `P2022` on every completed check. Push the schema BEFORE restarting. **Removed with the provider:**
  `ENABLE_PERSONA_VERIFICATION`, `PERSONA_TEMPLATE_ID`,
  `PERSONA_ENVIRONMENT_ID`, `PERSONA_API_KEY`, `PERSONA_WEBHOOK_SECRET`,
  `PERSONA_HOSTED_URL_BASE`, `ALLOW_SANDBOX_PERSONA` — delete these from
  `/opt/gennety/.env`; the process no longer reads them.
- Face match: `FACE_MATCH_PROVIDER`, `FACE_MATCH_THRESHOLD_VERIFY`
  (default 0.85), `FACE_MATCH_THRESHOLD_REVIEW` (default 0.75),
  `FACE_MATCH_MIN_VERIFIED_PHOTOS` (default 1), `AWS_REGION`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `ELO_VISION_SEED_ENABLED`
- Profile media validation: `PROFILE_MEDIA_VALIDATION_ENABLED` (default **`true`**
  — `config.ts` reads `!== "false"`, so strict upload-time validation is on
  unless it is explicitly disabled; this doc previously claimed `false`),
  `PROFILE_MEDIA_VALIDATION_FAIL_OPEN` (must remain `false` in
  production), `PROFILE_VIDEO_MAX_ANALYSIS_FRAMES` (default `24`), and
  `PROFILE_VIDEO_VALIDATION_TIMEOUT_MS` (default `60000`). Requires local
  `ffmpeg` + `ffprobe`, OpenAI, and an IAM policy containing exactly
  `rekognition:CompareFaces`, `rekognition:DetectFaces`, and
  `rekognition:DetectModerationLabels`. No new AWS access key is required.
- App-wide theme (light/dark, **always-on — no feature flag**): users pick a
  theme in onboarding (after the city gate; default `dark`) or change it later
  via Settings → Change theme. Every Mini App renders it (shared `theme.css`
  tokens + a pre-paint boot snippet in each `*.html`, which also honors a
  `?theme=` deep-link) and both server PNG cards (date + match) render in the
  recipient's `User.theme`. **Requires `db:push` of the additive `users.theme`
  (enum `Theme`, default `dark`) / `theme_chosen_at` columns first** (additive,
  non-destructive), and redeploy the Mini App bundle so all screens ship the
  theme system. No new env, no new system dependency.
- Registration v2 (phone rail feature-flagged; identity gate mandatory):
  `PHONE_AUTH_ENABLED` (default `false`) turns on the sign-up fork + the
  general-track phone rail (Mini App PathGate/PhoneGate, `POST
  /v1/telegram-onboarding/track`, the trusted `message.contact` handler);
  `MANDATORY_VERIFICATION_ENABLED=true` removes the verification
  Skip button, refuses legacy skip callbacks, and adds the verification-stall
  re-engagement sweep. Production-like startup refuses any other verification
  setting. **Requires `db:push` of the additive `users.phone`
  (unique) / `phone_verified_at` / `registration_track` columns first**
  (non-destructive; deploy code + push schema BEFORE flipping either flag —
  the new columns are read unconditionally by matching and `/state`). Also
  redeploy the Mini App bundle (`onboarding.html`) so the fork screens exist.
  The student ticket bonus (+2 at uni-email verification, `student_bonus`
  ledger reason) rides `TICKET_FEATURE_ENABLED` — no flag of its own, no
  schema beyond the wallet tables. `PHONE_AUTH_ENABLED` can be rolled back to
  the email-only flow; mandatory identity verification must remain enabled.
- Matching: `MALE_REACH_ELO` (default `36` Elo ≈ 6 attractiveness points) —
  one-directional "reach up" allowance that lets a less-attractive man match a
  somewhat more-attractive woman without the `V_league` penalty (hetero pairs
  only; matching down and same-gender pairs unaffected). Raise for a stronger
  male lift, lower toward `0` to disable. No restart side effects beyond the
  standard `pm2 restart`.
- Proposal reply countdown + deadline nudge (always-on, no feature flag,
  Telegram-only): the pitch's live reply-deadline **button** re-render
  (`workers/proposal-countdown.ts`, `editMessageReplyMarkup`) and the new
  match-nudge **deadline heads-up** (`workers/match-nudge.ts`, one DM ~2 h
  before the 24 h TTL to still-undecided sides). Both run on the existing crons
  (`PROPOSAL_COUNTDOWN_CRON_SCHEDULE`, `MATCH_NUDGE_CRON_SCHEDULE`) — no new
  schedule, no new env. `PROPOSAL_COUNTDOWN_CRON_SCHEDULE` defaults to
  `* * * * *` since 2026-07-25 (was `*/5 * * * *`) so the button label moves
  every minute; `editMessageReplyMarkup` raises no notification, and the load
  is one edit per undecided side per minute only during a 24 h window (paced at
  25 edits/s, single-flight via `guardedTick`). Set the env override back to
  `*/5 * * * *` to restore the old cadence without a redeploy. **Requires `db:push` of the additive
  `matches.proposal_deadline_nudge_sent_at` column first** (nullable,
  non-destructive; a DB missing it throws `P2022` on the nudge sweep). Mobile
  clients render their own countdown from the public API and are unaffected.
- Per-side synergy rationale (always-on, no feature flag, bug fix 2026-07-25):
  the match-reveal synergy reason is now stored + rendered **per side in that
  side's own language** instead of pair-wide (it used to splice side A's
  sentence into side B's otherwise-localized pitch header, and into the mobile
  `synergyReason`). **Requires `db:push` of the additive
  `matches.synergy_reason_b` column first** (nullable, non-destructive; a DB
  missing it throws `P2022` on every pitch dispatch AND on
  `GET /v1/matches/current`, so push the schema BEFORE restarting). Existing
  rows keep their single reason and fall back to it for side B. No env, no new
  system dependency; `/v1/*` contract unchanged (same `synergyReason` field,
  correct language).
- Matching — stated age-band preference: `AGE_RANGE_PREF_FLOOR` (default `0.6`)
  and `AGE_RANGE_PREF_DECAY_PER_YEAR` (default `0.1`). The soft `V_agePref`
  multiplier dampens (never excludes) a candidate whose actual age is outside
  the seeker's stated preferred-**partner** age band (`Profile.ageRangeMin/Max`,
  edited via the **Search Prefs → Partner age range** menu / the menu-agent
  `update_age_range` tool / mobile `PATCH /v1/me`). Neutral (1.0) for users who
  never set a band, so it's inert for most users. Set
  `AGE_RANGE_PREF_FLOOR=1.0` to disable entirely; lower the floor / raise the
  decay for a stronger preference. **Requires `db:push` of the additive
  `match_score_logs.score_age_pref` column first** (non-destructive, defaults to
  `1`). No new system dependency; toggled live with `pm2 restart gennety-bot
  --update-env`.
- Venue picker: `PLACES_API_KEY`
- Anti-spam / LLM token budget (always-on, in-memory; no schema, no new dep):
  the Telegram bot meters text/voice per user (flood + daily token budget) in
  `bot-rate-limit.ts`, and the JWT LLM routers (`/v1/chat`, `/v1/assistant`,
  `/v1/onboarding`) gain `usageGuard`. Tokens are counted from the exact
  `usage.total_tokens` OpenAI returns, attributed via an `AsyncLocalStorage`
  context that `services/openai-fetch.ts` reads (call sites only swapped their
  default `fetch` for `openaiFetch`). Env (all optional, safe defaults):
  `BOT_RATE_LIMIT_ENABLED` (default `true`), `BOT_FLOOD_BURST_LIMIT` (`40`) /
  `BOT_FLOOD_BURST_WINDOW_MS` (`60000`), `BOT_FLOOD_SUSTAINED_LIMIT` (`300`) /
  `BOT_FLOOD_SUSTAINED_WINDOW_MS` (`3600000`), `LLM_TOKEN_BUDGET_ENABLED`
  (default `true`), `LLM_USER_DAILY_TOKEN_BUDGET` (`180000`),
  `LLM_GLOBAL_HOURLY_TOKEN_BUDGET` (`0` = global breaker off). Thresholds are
  deliberately loose so normal fast use never trips them. Counters are in-memory
  (single PM2 process) and reset on restart — no `db:push`, toggled live with
  `pm2 restart gennety-bot --update-env`. Whisper (audio) stays under the
  existing per-request voice limiter, not the token budget.
- Date Ticket (feature-flagged monetization): `TICKET_FEATURE_ENABLED`
  (default `false` — leave off until launch), `TICKET_PAYMENT_MODE`
  (`mock` default / `stripe`), `TICKET_PRICE_CENTS` (default `699`),
  `TICKET_PAYMENT_WINDOW_HOURS` (default `24`).
  - **Real payments = Telegram Stars (XTR), the production rail.**
    `TICKET_STARS_ENABLED` (default `false`) makes the date gate **and** the
    store pay natively in Telegram Stars via `WebApp.openInvoice` +
    `pre_checkout_query` + `successful_payment` (`handlers/payments.ts`). Needs
    **no** merchant account / provider token (empty provider token +
    `currency: "XTR"`); Stars→TON withdrawal is a Telegram-side setting.
    `TICKET_BUNDLE_STARS` (default `1:350,3:830,6:1350`, `<count>:<stars>` pairs)
    sets the per-bundle Star price; the gate derives its per-scope price from the
    1-ticket entry (self/partner 1×, both 2×). **Requires the additive unique
    `ticket_ledger.external_payment_id` column to be deployed first** (the
    Telegram charge id — exactly-once store credit and durable date-gate
    refunds; non-destructive). Gate payments are recorded before settlement;
    the hourly expiry worker retries `gate_refund_pending` rows and opens free
    scheduling only after Telegram confirms the refund. When Stars
    is on, the mock `/{ticket,tickets/store}/{intent,confirm}` routes 404 (PAY-1)
    so Stars is the sole purchase rail; the free wallet "Use a ticket" path is
    unaffected. Redeploy the Mini App bundle (`ticket.html` + `tickets.html`) so
    the ⭐-priced `openInvoice` buttons ship. Rollback: flip
    `TICKET_STARS_ENABLED` back to `false` — the mock returns exactly as before;
    the additive column may stay. Star prices are env-tunable at launch without
    a code change. The famine single-ticket discount is USD-only and is inert on
    Stars purchases.
  - Going live with **Stripe** instead (alternate path) additionally needs
    `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET` + `TICKET_PAYMENT_MODE=stripe` (see the
  `// TODO: Stripe Production Mode` branches in
  `services/ticket-payment.ts`). Requires `db:push` of the new `Match`
  ticket columns first — including the additive `partner_paid_seen_at` /
  `partner_paid_nudged_at` columns backing the §3.5b goodwill-cover read-receipt
  (the payer's "she saw it ❤️" DM + the guaranteed completion nudge). The
  read-receipt DMs reuse the existing `MESSAGE_EFFECT_TICKET_ID` heart on the
  payer's confirmation; no new env. Redeploy the Mini App bundle (`ticket.html`)
  so his success screen shows the "you covered {name}'s ticket 💛" copy.
  - **Ticket wallet + store (same flag).** `TICKET_FEATURE_ENABLED` also turns
    on the user ticket wallet: onboarding bonuses (6+ photos, profile video),
    the **My Tickets** menu, the store Mini App (`tickets.html`, bundles
    1/3/6), and the "Use a ticket" gate path. `MESSAGE_EFFECT_TICKET_ID`
    (optional — Bot API 7.6 effect on the reward DM; empty = no effect).
    Requires `db:push` of the new `User.ticket_balance`,
    `Profile.photo_bonus_ticket_at` / `video_bonus_ticket_at` columns and the
    new `ticket_ledger` table first, and `tickets.html` deployed with the Mini
    App bundle.
  - **Welcome gift (same flag).** Every new user is gifted 1 free Date Ticket as
    a pre-roll before their first match pitch — an optional founder **video
    note** (кружок) + a gift DM. `MATCH_PREROLL_DELAY_MS` controls the pause
    between a delivered gift pre-roll and the match card reveal (default 2 min).
    `MESSAGE_EFFECT_GIFT_ID` is optional — Bot API 7.6 effect on the gift DM;
    empty = no effect; pick a celebratory id like 🎉/❤️. Video assets are bundled
    at `apps/bot/src/assets/welcome-gift/<gender>-<lang>.mp4` (square video-note
    MP4, ≤60s, e.g. `male-ru.mp4`, `female-en.mp4`); they ride the standard code
    rsync, no ffmpeg needed (the bot just sends a ready
    file). A missing asset for a (gender, language) pair degrades gracefully to
    the gift DM only, so partial coverage is safe — drop in more MP4s over time.
    Idempotent via a `welcome_gift` `ticket_ledger` row (no extra schema beyond
    the wallet columns above).
  - **Famine discount (same flag).** On the 2nd consecutive no-match week
    (tier ≥ 2) the no-match DM grants a one-time **77% discount on a single
    ticket**, valid 30 days, applied to the date gate's `self` scope and the
    store's "1 ticket" bundle (`services/ticket-discount.ts`). Optional env
    overrides `FAMINE_DISCOUNT_PCT` (default `77`) and `FAMINE_DISCOUNT_TTL_DAYS`
    (default `30`). Requires `db:push` of the new
    `User.ticket_discount_pct` / `ticket_discount_granted_at` /
    `ticket_discount_expires_at` / `ticket_discount_consumed_at` columns first
    (additive, non-destructive). No new system dependency; runs inside the
    existing no-match cron + ticket Mini App routes. Inert unless
    `TICKET_FEATURE_ENABLED`.
- Pre-date coordination (feature-flagged): `COORDINATION_FEATURE_ENABLED`
  (default `false` — leave off until launch). When on, the bot offers matched
  users a way to find each other ~1h before the date (share Telegram, request
  partner's, or an anonymous bot-relayed chat). Requires `db:push` of the new
  `User.telegramUsername`, `Match.coord*`/`proxy*` columns, and the
  `proxy_messages` table first. Runs on the existing date-lifecycle
  `setInterval` — no new cron schedule. Variant C (anonymous proxy) is a
  documented, narrow carve-out to the no-in-app-chat invariant
  (PRODUCT_SPEC.md §Core Principles): post-match, time-boxed, text-only,
  fully logged, with an in-line Report button.
- Venue change v2 (feature-flagged, paid): `VENUE_CHANGE_FEATURE_ENABLED`
  (default `false` — leave off until launch) + `VENUE_CHANGE_STARS` (default
  `150`, the flat Telegram Stars price of one settled change). When on, BOTH
  sides' scheduled cards carry a "Change venue" button into the shared likes
  board (3 km catalog, hearts with ~4 s live sync, overlap = agreement —
  calendar mechanics); a settled change costs `VENUE_CHANGE_STARS` paid
  natively in Stars (hetero: the man pays + the female-only express unilateral
  swap; same-sex: the initiator). Decline/lapse NEVER cancels the match — the
  original venue stands. No free text anywhere (the v1 mandatory-comment
  carve-out is gone). Telegram-only. **Requires `db:push` of the additive v2
  `Match` columns first** (`venue_likes_a/b`, `venue_change_photo_url/name`,
  `venue_change_paid_by_id/paid_at`, `venue_change_pay_declined_at`,
  `venue_change_offer_pay_sent_at`, `venue_change_ping_sent_to_a/b_at`,
  `venue_change_express_at` — non-destructive), and redeploy the Mini App
  bundle (`venue-change.html`, fully reworked board UI). Payments ride the
  Stars rails (`venue:<matchId>:<mode>` payload in `handlers/payments.ts`; no
  merchant account — same XTR mechanics as tickets, independent of
  `TICKET_STARS_ENABLED`); a lost parallel-pay race is auto-refunded via
  `refundStarPayment`. The wish-card PNG reuses the date-card satori stack +
  bundled fonts (no new system dependency); Places venue photos stream through
  `GET /v1/venue-change/photo`, so `PLACES_API_KEY` is needed (already required
  for the venue picker). The lapse/express-revert sweep runs on the existing
  date-lifecycle `setInterval`. **Since 2026-07-26 there is also one new hourly
  cron** — `VENUE_CHANGE_REFUND_CRON_SCHEDULE` (default `0 * * * *`, registered
  only when the flag is on) — retrying failed Stars refunds and reversing
  purchases abandoned mid-settle, the twin of `REMATCH_REFUND_CRON_SCHEDULE`.
  **Requires `db:push` of the new additive `venue_change_purchases` table
  first** (non-destructive; the settle path writes to it on every payment, so a
  DB missing it throws `P2022` on the `successful_payment` boundary — push the
  schema BEFORE restarting). Rollback: flip the flag off; the additive
  columns/table may stay.
- Gennety Premium (feature-flagged, recurring subscription, §Premium):
  `PREMIUM_FEATURE_ENABLED` (default `false` — leave off until launch),
  `PREMIUM_STARS` (default `750`, the monthly Telegram Stars price — exactly
  what Telegram's Star store bills $17.99 for),
  `PREMIUM_PRICE_USD_DISPLAY` (default `$17.99`, display-only; it must always
  name the real cost of `PREMIUM_STARS`, so the two are edited together — a
  cheaper label over a 750⭐ charge misleads), and
  `PREMIUM_APPSTORE_PRODUCT_ID` (default `premium_monthly`, the StoreKit 2
  auto-renewable subscription id — matched by full id or last dot-segment). When
  on, the menu shows a ✨ Gennety Premium row → hub → the Premium Mini App
  (`premium.html`), and the venue-change board shows premium venues locked with a
  subscribe-in-place upsell; a subscriber's venue changes are free. **Standalone
  per-user entitlement** (`services/premium.ts`) — decoupled from venue-change.
  - **Telegram Stars recurring rail.** `POST /v1/premium/stars-invoice` mints a
    `createInvoiceLink` with `subscription_period=2592000` (Telegram supports
    only the 30-day period; empty provider token + `XTR`, no merchant account).
    The `sub:premium` payload is settled by the bot's `successful_payment`
    handler on the first charge AND every auto-renewal, exactly-once via the
    recurring `telegram_payment_charge_id`. Cancellation is native (Telegram →
    Settings → Subscriptions) OR **in-chat via the menu agent** (the user asks to
    cancel → `offer_cancel_premium` tool → a nonce-bound confirm card → Bot API
    `editUserStarSubscription`, `handlers/menu/premium-cancel.ts`); either way the
    entitlement simply lapses at `premiumUntil` (no early revoke, no mid-period
    refund). After a confirmed in-chat cancel the bot asks the churn reason and
    stores it on the `cancelled` `subscription_ledger.note`. Telegram-only.
  - **iOS StoreKit rail (parallel).** `POST /v1/premium/appstore/transaction`
    (JWT) + the existing App Store Server Notifications webhook
    (`/v1/webhooks/appstore`, now routes SUBSCRIBED/DID_RENEW/EXPIRED/REFUND/
    REVOKE for the premium product) reuse the `APPSTORE_*` config already
    deployed for tickets. No new Apple keys.
  - **Premium venues.** Curated venues carry a `tier` (`base`/`premium`); premium
    rows may exceed the ≤ MODERATE price cap and are seeded with
    `pnpm seed-venues:pull --tier=premium` (relaxed price gate; every other
    quality gate stays) → review → `seed-venues:import --apply`. The auto-assign
    concierge picker stays base-only.
  - **In-chat cancellation.** No new env. The menu agent's `offer_cancel_premium`
    tool + `handlers/menu/premium-cancel.ts` handle it; the churn reason lands in
    the additive `subscription_ledger.note` column (see below). Telegram-only —
    App Store subs are guided to iOS Settings, iOS cancels natively via Apple, so
    no `/v1/*` contract change.
  - **Requires `db:push` first** of the additive `users.premium_*` columns, the
    new `subscription_ledger` table (now including the additive nullable
    `subscription_ledger.note` churn-reason column — non-destructive; a DB
    missing it throws `P2022` on an in-chat cancel), `curated_venues.tier`, and
    `matches.venue_change_tier` (all non-destructive; deploy code + push schema
    BEFORE flipping the flag — the new columns are read by the venue board and
    the entitlement service). Redeploy the Mini App bundle (`premium.html` +
    reworked `venue-change.html`). No new system dependency. Rollback: flip
    `PREMIUM_FEATURE_ENABLED` off; the additive columns/table may stay. An
    entitlement already granted stays valid regardless of the flag.
- Referral program (feature-flagged, "Give a date, get a date", see
  `REFERRAL_PRODUCT_SPEC.md`): `REFERRAL_FEATURE_ENABLED` (default `false` —
  leave off until launch). Rides the already-on `TICKET_FEATURE_ENABLED` +
  `PREMIUM_FEATURE_ENABLED` (it pays rewards in Date Tickets AND complimentary
  Premium months). Tunables: `REFERRAL_INVITEE_PREMIUM_MONTHS` (default `1`, the
  invited user's welcome Premium month shown on the onboarding wow screen),
  `REFERRAL_LADDER` (default `1:1:1,3:1:1,5:1:1,10:2:2` =
  `<count>:<ticketsDelta>:<monthsDelta>`, the referrer's milestone ladder —
  cumulative 1/1, 2/2, 3/3, 5/5), and `REFERRAL_DAILY_REWARD_CAP` (default `3`,
  a per-referrer 24h anti-fraud reward-hold). The reward fires at the invited friend's **verification** (the
  anti-fraud gate); the invitee's Premium month is granted at the onboarding
  screen. **Requires `db:push` of the additive `users.referral_verified_count`
  (default 0) / `referral_counted_at` / `referral_invitee_premium_at` columns
  first** (non-destructive; the referrer tally + invitee once-markers). Rewards
  reuse `ticket_ledger` (`referral_milestone`) + `subscription_ledger`
  (`referral`) — no new tables. Also **redeploy the Mini App bundle**
  (`referral.html` ships with the Vite build — the referrer ladder + one-tap
  share). Uses `BOT_USERNAME` (invite deep link) + `PUBLIC_BASE_URL` (the public
  HMAC-signed `GET /v1/referral/card` image Telegram fetches for the shared
  photo) — both already set. The branded share card reuses the date/match-card
  satori stack + bundled fonts (no new system dependency); a render failure
  degrades the share to a rich text article. Runs inline at verification / the
  onboarding screen — no new cron. iOS: `GET/POST /v1/me/referral*` (JWT) +
  `features.referral` in `/v1/app/config`. Rollback: flip the flag off; the
  additive columns may stay. Telegram-first; iOS attribution via a referral code.
- Promo codes (feature-flagged, independent campaign links, see
  `PROMO_CODES_PRODUCT_SPEC.md`): `PROMO_FEATURE_ENABLED` (default `false` — leave
  off until launch). Rides the already-on `TICKET_FEATURE_ENABLED` +
  `PREMIUM_FEATURE_ENABLED`. Grants a NEW user **1 free Date Ticket + 3 months
  Premium** at a richer, distinct onboarding wow screen (new users only,
  first-touch, mutually exclusive with referral). Tunables (all optional):
  `PROMO_DEFAULT_TICKETS` (`1`) / `PROMO_DEFAULT_PREMIUM_MONTHS` (`3`, the
  `promo:create` defaults), `PROMO_ATTRIBUTION_TTL_MIN` (`60`, iOS
  fingerprint-match window), `PROMO_APP_STORE_URL` (the App Store URL the
  `GET /v1/promo/:code` landing bounces iOS visitors to; empty → no redirect),
  and the emergency `PROMO_MANUAL_ENTRY_ENABLED` (`false` — a pre-wired
  manual-entry fallback field, off by product decision). **Requires `db:push` of
  the additive `users.promo_redeemed_at` column + the new `promo_codes` /
  `promo_redemptions` tables first** (non-destructive). Rewards reuse
  `ticket_ledger` (`promo`) + `subscription_ledger` (`promo`). Also **redeploy
  the Mini App bundle** (`onboarding.html` ships the new promo wow screen).
  Create codes with the CLI: `pnpm promo:create --code=SUMMER3M --tickets=1
  --months=3 --max=500 --expires=2026-09-01` (also `promo:disable` /
  `promo:stats` / `promo:list`; writes to the `DATABASE_URL` in scope — run with
  prod env for prod). Telegram uses `t.me/<bot>?start=promo_<CODE>` (reliable);
  iOS is a custom deferred deep link (clipboard + coarse fingerprint via the
  in-memory `services/promo-attribution.ts`, `GET /v1/promo/:code` landing +
  `POST /v1/me/promo/claim-deferred` + `/v1/me/promo/claim`, JWT), **best-effort
  with no manual fallback** — a miss silently loses the gift (flip
  `PROMO_MANUAL_ENTRY_ENABLED` if painful). `features.promo` in `/v1/app/config`;
  iOS client tasks in `~/Desktop/Gennety-iOS/IMPLEMENTATION_PLAN.md`. Runs inline
  at the wow screen — no new cron, no new system dependency. Rollback: flip the
  flag off; the additive columns/tables may stay. Launch: deploy code + push
  schema BEFORE flipping the flag (the new columns are read by onboarding state),
  create at least one code, then set `PROMO_FEATURE_ENABLED=true`.
- Rematch (feature-flagged, paid on-demand engine re-run, PRODUCT_SPEC §3.11 /
  `REMATCH_PRODUCT_SPEC.md`): `REMATCH_FEATURE_ENABLED` (default `false` — leave
  off until launch). When on, a man whom the Thursday batch left unpaired, or
  whose match expired without a date, gets a DM offering one paid re-run of the
  matching engine for himself; the woman it finds never buys and never sees a
  price — she gets an ordinary pitch with gift framing. Telegram-only (Stars is a
  Telegram rail); no `/v1/*` or OpenAPI change. Tunables: `REMATCH_STARS`
  (default `150`), `REMATCH_PRICE_USD_DISPLAY` (`$2.99`, display-only),
  `REMATCH_MAX_PER_WEEK` (`2`), `REMATCH_COOLDOWN_HOURS` (`24`),
  `REMATCH_GIFT_CAP_DAYS` (`7`, protects a candidate from serial gift-pitching),
  `REMATCH_PRE_BATCH_BLACKOUT_HOURS` (`6`, keeps a single-seeker run from taking
  a candidate the globally-optimal Thursday batch needed; `0` disables),
  `REMATCH_FAILED_LOOKBACK_DAYS` (`14`), and `REMATCH_REFUND_CRON_SCHEDULE`
  (`0 * * * *`). **Requires `db:push` of the additive `matches.source` (default
  `'weekly'`) / `matches.rematch_paid_by_id` columns and the new
  `rematch_purchases` table FIRST** (non-destructive, but `matches.source` is
  read unconditionally by the pitch + the admin algorithm route, so a DB missing
  it throws `P2022` on every dispatch — push the schema BEFORE restarting).
  Payments ride the existing Stars rails (`rematch:v1` payload in
  `handlers/payments.ts`; no merchant account, same XTR mechanics as tickets and
  independent of `TICKET_STARS_ENABLED`). The refund-retry cron is registered
  only when the flag is on. No Mini App change, no new system dependency.
  **Pricing note:** 150⭐ follows the ticket rate ($6.99/350⭐ = $0.02/⭐ → ≈$3.00);
  at the more conservative $0.024/⭐ rate documented under `PREMIUM_STARS`, 150⭐
  bills nearer $3.59 — if you want Premium's strict "never under-promise the
  charge" convention, set `REMATCH_STARS=125` or raise the display price (both
  env-only). Rollback: flip the flag off; the additive columns/table may stay.
- Date card (feature-flagged): `DATE_CARD_FEATURE_ENABLED` (default `false` —
  leave off until launch). When on, each side's `scheduled` confirmation is a
  rendered PNG date card (partner photo + venue photo + details) sent
  screenshot/forward-protected, with a Share button that re-sends a copy with
  the partner's face blurred (PRODUCT_SPEC.md §3.7a). Telegram-only in v1.
  Requires `db:push` of the new `Match.venuePhotoUrl` / `venuePhotoName`
  columns first. No new system dependency: rendering uses `satori`,
  `@resvg/resvg-js`, and `@napi-rs/canvas` (prebuilt binaries pulled by
  `pnpm install --frozen-lockfile`, **not** ffmpeg/Chromium), and the bundled
  Roboto + Archivo Black TTFs in `apps/bot/src/assets/fonts/` ride the standard
  code rsync.
  **Venue photos require `PLACES_API_KEY` — no key, no venue photo** (the card
  still renders, on its branded gradient). Since 2026-07-25 Google Places is the
  SINGLE source: the retired `CuratedVenue.photoUrl` fallback is gone, and
  curated venues — the primary assignment source — have their cover resolved
  from their stored `placeId` at assignment time (`fetchPlacePhotoName`, one
  extra Places request per scheduled date; also fires at a §3.7b venue-change
  agreement / express mint). Google's bytes are fetched at render, credited on
  the card, never persisted. (`PLACES_API_KEY` re-verified present on the
  droplet 2026-07-25, and a live probe of a real curated Kyiv venue returned its
  cover photo — superseding the stale "empty" note in the 2026-07-13 flag table
  below.) Runs inline at venue finalization —
  no new cron. Any render failure degrades to the existing plain-text scheduled
  DM, so the flag is safe to toggle live with `pm2 restart gennety-bot
  --update-env`.
- Match card (feature-flagged): `MATCH_CARD_FEATURE_ENABLED` (default `false`).
  When on, the match-pitch photo album is replaced by the rendered collage
  card set (card 1 = photo + name/vibe panel, following cards = one full-bleed
  photo each; PRODUCT_SPEC.md §3.3). Uses the same satori/resvg/canvas stack
  and bundled fonts as the date card plus `apps/bot/src/assets/brand/butterfly-logo.svg`
  and the Unbounded woffs in `assets/fonts/` (all ride the code rsync), and one
  extra OpenAI call per side for the short card copy. Any copy/render/send
  failure falls back to the plain protected media group, so the flag is safe to
  toggle live with `pm2 restart gennety-bot --update-env`. No schema change.
- Type Radar (feature-flagged visual appearance calibration, §Type Radar /
  `TYPE_RADAR_PRODUCT_SPEC.md`): `TYPE_RADAR_ENABLED` (default `false` — the
  whole feature ships dark) + `TYPE_PREF_FLOOR` (default `1.0` = the `V_type`
  match multiplier is a pure no-op even when enabled; launch value ≈ `0.7`,
  the weakest factor — read directly by the match engine, mirroring
  `AGE_RANGE_PREF_*`). When on, the conversational onboarding shows a skippable
  visual "choose your type" step **before** the Magic Prompt (a `web_app` button
  into `radar.html` + an inline Skip); submit/skip resumes the flow. The
  compiled per-set preference vector (`Profile.typePrefTags`) scores a partner's
  `Profile.appearanceTags` — the candidate side is tagged by an **isolated**
  cheap vision pass on the verified branch (separate from the Elo attractiveness
  call, so a tagging regression never perturbs the live Elo seed; no extra call
  while dark). **Requires `db:push` of the additive `Profile.type_radar_answers`
  / `type_pref_tags` / `type_radar_completed_at` / `type_radar_age_band` /
  `appearance_tags` and `match_score_logs.score_type` columns first** (all
  nullable/defaulted, non-destructive). Also **redeploy the Mini App bundle**
  (`radar.html` ships with the Vite build) — the 24 band-A calibration portraits
  live in `apps/webapp/public/radar/a/*.jpg` and ride the webapp rsync. No new
  system dependency (tagging reuses `OPENAI_API_KEY` via the `visionFast`
  model). Rollout is two-stage: (1) `db:push` + deploy code + Mini App with the
  flag OFF (everything inert); (2) flip `TYPE_RADAR_ENABLED=true` to start
  collecting radar answers while `TYPE_PREF_FLOOR=1.0` keeps scoring unchanged
  (shadow); later lower `TYPE_PREF_FLOOR` (e.g. `0.7`) to let `V_type` actually
  re-rank. `WEBAPP_URL` must be a real HTTPS host for the picker button (dev
  without a tunnel degrades to Skip-only). Rollback: flip the flag off; the
  additive columns/images may stay.
- Type Radar "thinking state" (always-on, rides `TYPE_RADAR_ENABLED`):
  `RADAR_THINKING_ENABLED` (default **`true`** — `config.ts` reads
  `!== "false"`). The ~10.7s status sequence played in chat between the radar
  Mini App closing and the next onboarding question
  (`TYPE_RADAR_PRODUCT_SPEC.md` → *Close → "thinking state" → next question*;
  PRODUCT_SPEC §1.3): four scripted beats then a profile counter decelerating
  onto a 160–220 total. **No schema change, no Mini App redeploy, no new
  dependency** — it is bot-side only and reuses the existing
  `runStatusSequence` primitive, so a full server code deploy carries it.
  Localized in all five languages.
  Two things worth knowing before flipping it:
  - It is a **deliberate labor illusion**. Nothing is scanned — the radar
    verdicts are saved before it starts, and matching doesn't run until the
    Thursday batch. Founder-approved (2026-07-27) with the copy as specified.
  - It **holds the user ~10.7s** (plus a 2.2s lead-in that waits out the Mini
    App's own close animation) before their next onboarding question. That is
    real added time in the funnel — watch
    `GET /admin/analytics/onboarding-funnel` for a drop-off bump at the
    AI-memory / photos step after enabling it.

  Set `RADAR_THINKING_ENABLED=false` + `pm2 restart gennety-bot --update-env`
  to drop straight to the next question; nothing else changes. That kill switch
  is the whole rollback.
- Founder notifications (feature-flagged private ops feed): `FOUNDER_NOTIFY_ENABLED`
  — **ON in production since 2026-07-16** (founder bot `@sverkausbot`, chat id set).
  When on, a SEPARATE founder bot DMs the founder four things: (1) each new user's
  full profile + photos on first activation (no AI-memory dump), (2) a tokenized
  weekly-matches report link after the Thursday batch, (3) both date cards + venue
  when a date locks in, (4) the full profile + **phone number** + photos when a
  user freezes or hard-deletes their account (bot Settings→Delete/Freeze and mobile
  `DELETE /v1/me`; the delete path snapshots the row and downloads any photo
  bytes before the storage cleanup + Prisma cascade run). (Item 4 briefly sent
  an anonymous event instead, 2026-07-16 → 2026-07-28, over a since-reverted
  GDPR concern — see PRODUCT_SPEC.md §2.1 and `legal/privacy-policy.md` §12.2.)
  Requires `FOUNDER_BOT_TOKEN` (a bot from BotFather —
  kept distinct from `BOT_TOKEN`; `file_id`s are per-bot so the founder bot uploads
  raw bytes), `FOUNDER_TELEGRAM_ID` (the founder's numeric chat id — they must
  `/start` the founder bot once), and `PUBLIC_BASE_URL` (default
  `https://dating-api.gennety.com`, used to build the report link). **Requires
  `db:push` of the additive `users.founder_notified_at` column and the new
  `founder_reports` table first** (non-destructive; the idempotency marker +
  report snapshots). The report page (`GET /v1/founder/report/:token`) is served
  by the existing public API — no Caddy/DNS change. Photos in the report stream
  through the main bot, so no `PLACES_API_KEY` dependency. Runs inline at
  activation / venue-finalize / the weekly cron — no new cron schedule. The
  founder-facing dashboard "Weekly matches" tab lives in the separate
  `gennety-dating-dashboard` repo and consumes `GET /admin/analytics/weekly-matches`.
  **Since 2026-07-26 also requires `db:push` of the additive nullable
  `founder_reports.expires_at` column** — report links now expire after 90 days
  (the token is the page's sole auth and rides in the URL, so it also sits in
  access logs). A null means never-expires, so links created before the upgrade
  keep working. Rollback: flip the flag off; the additive column/table may stay.
- Optional cron overrides: `MATCH_CRON_SCHEDULE`, `CRON_TIMEZONE`,
  `EXPIRY_CRON_SCHEDULE`, `NO_MATCH_NOTICE_CRON_SCHEDULE`,
  `PROPOSAL_COUNTDOWN_CRON_SCHEDULE`, `RE_ENGAGEMENT_CRON_SCHEDULE`,
  `MATCH_NUDGE_CRON_SCHEDULE`,
  `STATUS_TIMER_CRON_SCHEDULE`, `AUTO_UNSUSPEND_CRON_SCHEDULE`,
  `EMBEDDING_REFRESH_CRON_SCHEDULE`, `SELFIE_RETENTION_CRON_SCHEDULE`,
  `VENUE_REVALIDATION_CRON_SCHEDULE`, `TICKET_EXPIRY_CRON_SCHEDULE`,
  `RETENTION_CRON_SCHEDULE`,
  `REMATCH_REFUND_CRON_SCHEDULE`, `VENUE_CHANGE_REFUND_CRON_SCHEDULE`,
  `PROFILER_CRON_SCHEDULE`, `DATE_LIFECYCLE_TICK_MS`, `DISPATCH_DELAY_MS`,
  `MATCH_PREROLL_DELAY_MS`
- Data retention (always-on, no feature flag, added 2026-07-26):
  `RETENTION_CRON_SCHEDULE` (default `45 3 * * *`, Europe/Kyiv) deletes aged OTP
  challenges (7 d), dead refresh sessions (30 d past unusable), and proxy-chat
  messages (90 d). No schema change, no new env beyond the schedule, no new
  system dependency. **Deletes are irreversible, so verify the backlog before
  the first production run**: check `SELECT count(*) FROM phone_otps WHERE
  created_at < now() - interval '7 days';` (and the same for `email_otps`,
  `user_sessions`, `proxy_messages`) so the first sweep's numbers are expected
  rather than a surprise. Batched at ≤1000 rows per table per tick, so a large
  backlog drains over several nights instead of one long-running transaction.
  **The `user_sessions` window is deliberately tied to `JWT_REFRESH_TTL` (30 d)
  — if you raise that env var, raise `SESSION_RETENTION_MS` with it**, or
  refresh-token reuse detection quietly stops firing for long-lived tokens.
  Rollback: set the schedule far-future (e.g. `0 0 31 2 *`); nothing else reads
  the worker.
- Onboarding funnel analytics (always-on, no feature flag): step-level
  drop-off + hesitation telemetry feeding `GET /admin/analytics/onboarding-funnel`
  and the weekly `GET /admin/analytics/founder-digest` (consumed by the external
  **Hermes** agent — see `HERMES_AGENT_PROMPT.md`). Requires `db:push` of the new
  additive `onboarding_step_events` table first (non-destructive; missing table →
  the collector's best-effort telemetry just logs a warning and onboarding still
  works, but the endpoint returns empty until the table exists). No new env, no
  new system dependency; writes ride the existing onboarding collector.
- Profiler (Phase 1b, always-on): post-onboarding Q&A batches that fuel
  icebreakers + date-planning hints (NOT matching). No feature flag —
  `PROFILER_CRON_SCHEDULE` (default `*/15 * * * *`) only tunes cadence; set it
  far-future to effectively pause. Requires `db:push` of the new
  `profiler_answers` table, `ProfilerPriority` enum, and the
  `Profile.time_zone` / `profiler_*` columns first (additive, non-destructive).
  **2026-07-26 update — requires `db:push` of two more additive
  `profiles` columns before deploying the code**: `profiler_answer_window_until`
  and `profiler_question_message_id` (both nullable; a DB missing them throws
  `P2022` on the first question sent, which surfaces as a PM2 restart loop).
  They bound how long an open question may claim the user's free text
  (PRODUCT_SPEC §Phase 1b), so an unrelated message no longer gets recorded as
  its answer. No new env and no new system dependency; the same release also
  halves the Profiler shimmer, drops its emoji, stops streaming the question
  text, shortens `PROFILER_STALL_TIMEOUT_MS` to 6 h, and expands the question
  bank with situational questions that repeat each drop cycle — all code-only.

Production safety checks:

- `DEV_OTP_BYPASS_TELEGRAM_IDS` must be empty in production; startup refuses
  any non-empty value outside the explicit development runtime.
- Keep `ONBOARDING_FACT_COLLECTOR_ENABLED=false` during the first production
  deploy. Before enabling it: back up PostgreSQL, run
  `pnpm --filter @gennety/db db:push`, run `pnpm onboarding:backfill` and
  inspect aggregate counts, then run `pnpm onboarding:backfill:apply`.
  Enable Development first and complete the two-account E2E. Production
  rollback is the env flag; the additive `onboarding_progress` table may stay.
- `OTP_LOG_TO_CONSOLE` must be `false` or unset in production. It only relaxes
  local identity checks when `NODE_ENV=development`; otherwise startup fails.
- `JWT_SECRET` must contain at least 32 cryptographically random bytes (the
  template uses 64 hex characters), otherwise the public API refuses to start.
  Access tokens are accepted only as HS256 tokens issued by
  `gennety-public-api` for the `gennety-mobile` audience; changing these claims
  is an API migration, not a deploy-time toggle.
- `PUBLIC_PORT` should remain `3101` unless Caddy is changed too.
- `ADMIN_PORT` should remain `3100` unless Caddy is changed too.
- `WEBAPP_URL` should point to `https://dating-calendar.gennety.com`.

## Logs And Operations

PM2:

```sh
ssh root@167.172.178.229 'pm2 status'
ssh root@167.172.178.229 'pm2 describe gennety-bot'
ssh root@167.172.178.229 'pm2 logs gennety-bot --lines 200 --nostream'
ssh root@167.172.178.229 'pm2 monit'
```

PM2 log files:

```text
/root/.pm2/logs/gennety-bot-out.log
/root/.pm2/logs/gennety-bot-error.log
```

Warning: bot error logs can include Telegram context objects. Do not paste raw
logs into public issues or commits without checking for tokens/user data.

Caddy:

```sh
ssh root@167.172.178.229 'systemctl status caddy --no-pager'
ssh root@167.172.178.229 'journalctl -u caddy -n 200 --no-pager'
ssh root@167.172.178.229 'caddy validate --config /etc/caddy/Caddyfile'
ssh root@167.172.178.229 'systemctl reload caddy'
```

PM2 startup:

```sh
ssh root@167.172.178.229 'systemctl status pm2-root --no-pager'
ssh root@167.172.178.229 'pm2 save'
```

Manual bot restart:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pm2 restart gennety-bot --update-env
pm2 logs gennety-bot --lines 100 --nostream
```

If the PM2 process is missing:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pm2 start bash --name gennety-bot -- -c "cd /opt/gennety && ./apps/bot/node_modules/.bin/tsx apps/bot/src/index.ts"
pm2 save
systemctl status pm2-root --no-pager
```

## Database Operations

Generate Prisma client:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pnpm --filter @gennety/db db:generate
```

Push current Prisma schema to production:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pnpm --filter @gennety/db db:push
```

Check Prisma version/config:

```sh
ssh root@167.172.178.229 'pnpm --dir /opt/gennety --filter @gennety/db exec prisma --version'
```

Current production logs showed this schema drift pattern:

```text
Prisma P2022: The column `users.referral_source` does not exist in the current database.
```

If that appears after deploying code that references a new column, run
`pnpm --filter @gennety/db db:push` on the droplet and restart PM2.

## Curated Venue Seeding

The concierge venue picker is curated-first (`curated_venues` table; Google
Places is the fallback). After the `CuratedVenue` schema reaches a DB (via
`db:push`), populate the base with the two-phase seeder. It needs `PLACES_API_KEY`
in env and writes to whichever DB `DATABASE_URL` points at — run it with prod env
to seed production.

```sh
# 1. Fill in scripts/curated-venues.config.json (university domain + centre lat/lng).
# 2. Pull candidates from Google Places under the production quality gate:
pnpm seed-venues:pull
# 3. Hand-edit scripts/curated-venues.candidates.json:
#    flip "approved": true on keepers, tweak "priority" (1 best … 3 ok) + "vibeTags".
# 4. Dry-run, then apply:
pnpm seed-venues:import
pnpm seed-venues:import --apply
```

Re-running `--pull` overwrites the candidates file; `--import --apply` is
idempotent (upsert on domain+Place id, with name/address fallback) so it's safe
to re-run after edits.
The import also deletes rows matching the operator brand blocklist.

For the reviewed Kyiv expansion, refresh and validate the committed approved
catalog before importing:

```sh
pnpm sync-venues:kyiv
pnpm sync-venues:kyiv --apply
pnpm sync-venues:kyiv --check
pnpm seed-venues:import --in=scripts/curated-venues.kyiv.approved.json --apply
```

When the operator hands over a raw list of venue NAMES (no place ids), resolve
and triage it first — `sync-venues:kyiv` needs stable place ids and fails on
anything below the quality gate:

```sh
# 1. Put the names in scripts/curated-venues.kyiv.additions.json
#    ({"name": "...", "tier": "base|premium|alternative"}).
pnpm resolve-venues:kyiv --write          # names -> place ids + review flags
# 2. Read the flags. A `name-mismatch` is Google answering with a DIFFERENT
#    venue — confirm the address, then set "acceptMatch": true, or fix "query".
pnpm merge-venues:kyiv                    # dry run: what is accepted/rejected
pnpm merge-venues:kyiv --apply            # fold into the expansion manifest
#    --promote-expensive re-tiers EXPENSIVE base venues to premium instead of
#    dropping them (an operator decision — off by default).
# 3. Reconcile + re-tag, then import as above.
pnpm sync-venues:kyiv --apply
pnpm backfill-venue-facets --only-missing --apply
```

`backfill-venue-facets --only-missing` matters: `sync-venues:kyiv` rebuilds rows
from Google Places, which knows nothing about Venue Intent V2 facets. It now
carries existing `facetTags`/`hardCapabilities` across a rebuild, but venues
added for the first time have none, and without `hardCapabilities` a row fails
the V2 indoor/outdoor hard filter and never gets picked.

## Caddy Or Domain Changes

Edit and validate:

```sh
ssh root@167.172.178.229
nano /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -n 80 --no-pager
```

DNS for `gennety.com` is managed at Hostinger. All Gennety Dating API domains
must stay prefixed with `dating-` or `api-admin`; `api.gennety.com` belongs to
a sibling project and must not be used here.

## Rollback

Code rollback is currently file sync based, not git based on the server.

Fast rollback options:

1. Re-sync a known-good local checkout to `/opt/gennety`.
2. Restore a previous local commit, then run the full server deploy again.
3. If only env changed, restore one of `/opt/gennety/.env.bak.*`, then restart
   PM2.
4. If only Mini App changed, rebuild and rerun `./scripts/deploy-webapp.sh`
   from a known-good local checkout.

Env rollback:

```sh
ssh root@167.172.178.229
cd /opt/gennety
ls -lt .env.bak.*
cp .env.bak.YYYYMMDD-HHMMSS .env
pm2 restart gennety-bot --update-env
pm2 save
```

## Post-Deploy Checklist

```sh
ssh root@167.172.178.229 'pm2 status'
ssh root@167.172.178.229 'pm2 logs gennety-bot --lines 100 --nostream'
curl -s https://dating-api.gennety.com/v1/ping
curl -sI https://dating-calendar.gennety.com
curl -sI https://dating-calendar.gennety.com/onboarding.html
curl -sI https://dating-calendar.gennety.com/verification.html
curl -sI https://dating-calendar.gennety.com/ticket.html
curl -sI https://dating-calendar.gennety.com/tickets.html
curl -sI https://dating-calendar.gennety.com/venue-change.html
curl -sI https://api-admin.gennety.com
```

Then check:

- PM2 `gennety-bot` is `online`.
- Bot log says `Bot @gennetybot started`.
- Bot log says admin API is listening on `:3100` when `ADMIN_API_KEY` is set.
- Bot log says public API is listening on `:3101`.
- Public `/v1/ping` returns `{ "ok": true, ... }`.
- Calendar, onboarding, and verification Mini Apps return HTTP `200`.
- Admin API returns HTTP `401` without bearer auth.
# Venue Intent V2 rollout

This release is additive. Before enabling it, take the standard production DB
backup, deploy code, then run the documented production `db:push`. Do not drop
legacy vibe or venue columns. Backfill curated rows with `city_key` (`ua:kyiv`,
`ua:kharkiv`, `ua:odesa`) via the reviewed venue import inputs; duplicate legacy
domain rows may remain because runtime deduplicates them.

Before live rollout, audit every active `base` curated row used by V2: rating
must be at least 4.0 with at least 30 reviews; commercial/admission categories
must have a provider `price_level` or one operator-confirmed canonical price tag
(`free`, `inexpensive`, `moderate`). Rows without this evidence remain stored
for operator repair and Venue Change, but fail closed for the initial automatic
assignment. No schema migration is required for this policy update.

Start with all three flags at zero/off. Then enable the master flag with shadow
10% and live 0%. Keep shadow for at least seven days and 30 completed pairs.
Advance live 10% → 50% → 100% with at least 48 hours per step. Roll live back to
0 immediately on any hard-constraint violation, fake/closed assignment,
finalisation error regression, or venue-change-rate increase over baseline by
more than five percentage points. Shadow can remain on during rollback.
