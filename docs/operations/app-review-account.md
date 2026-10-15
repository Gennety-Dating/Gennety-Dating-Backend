<!-- WHEN_TO_READ: You are preparing an App Store submission, setting up or turning off the reviewer demo account, or debugging the "Alex"/"Emma" accounts on production. -->

# App Store review account

Founder decision 2026-10-15 (decision journal). Apple's reviewer cannot receive a
university email, pass the selfie liveness check as a real student, or wait for an
18:00 drop that pairs them with a real person. Production therefore carries one narrow,
switchable exception.

## What it does

1. **Sign-in.** One fixed address (`APP_REVIEW_EMAIL`) signs in on the university-email
   rail with one fixed 6-digit code (`APP_REVIEW_CODE`). No mail is sent. Every other
   address is untouched. All callers share a lockout: 20 wrong codes in an hour lock the
   address for the rest of that hour. The usual per-email+IP limiter (10/h) also applies.
2. **Reviewer account "Alex".** The account is created on the first sign-in, already
   finished and verified, so the app skips onboarding and liveness and opens on Today.
   - Every later sign-in resets only the gates (status, onboarding, verification,
     consent); profile edits are kept.
   - A deleted account comes back on the next sign-in.
   - The wallet is kept at 2 tickets or more. These are `welcome_gift` grants, not revenue.
3. **Stand-in partner "Emma".** She lives in `workers/app-review-partner.ts`, which ticks
   every 20 s. She acts only after the reviewer's own step, through the same production
   functions a real partner's tap reaches:
   - she accepts the pitch;
   - she pays her half of the date ticket;
   - she takes the reviewer's first time slot;
   - she sends a departure point at Golden Gate, Kyiv.
4. **Replacement pair.** When a pair ends (decline, expiry, cancelled date), the old rows
   are deleted and a fresh pair is pitched about 2 minutes later.

## What keeps it away from real people

1. Both accounts live in a reserved negative `telegramId` band, `-779000099…-779000001`.
   The match engine drops that band from both Prisma eligibility scans and from the
   pgvector candidate SQL.
2. `createProposedMatch` admits a review account only when **both** sides are review
   accounts.
3. The accounts are not `syntheticAt` rows. The synthetic-partner worker would
   auto-decline them.
4. With both env values empty, the sign-in branch, the worker and the exclusion do
   nothing. The exclusion filter still runs, but it matches no rows.

## Turning it on (before submitting)

1. **Production `.env`.** Set a dedicated address and a random code. A repeated or
   sequential code is refused at boot.
   ```
   APP_REVIEW_EMAIL=appreview@gennety.com
   APP_REVIEW_CODE=<6 random digits>
   ```
2. **Restart.** Restart the bot; see the deployment runbook. The log shows
   `[cron] App Store review partner scheduled`.
3. **Sign in once yourself.** Use the iOS app with that address and code. Within about
   20 s Today shows Emma's pitch. Walk through it once.
4. **Fill in App Store Connect.** Under *App Review Information* → *Sign-in required*,
   enter the address and code. In *Notes*, paste the text from the iOS repo
   (`docs/operations/appstore-review-notes.md` §2). Tell the reviewer to pick a
   departure point **in Kyiv**: an origin outside the market is refused.

## Emma's photos

Without photos the pitch shows Emma with no pictures.

1. Upload 3–4 images of a **fictitious** person, generated or licensed for this use, to
   Supabase Storage under her user id.
2. Write the storage paths into `profiles.photos` for her row. Her row has
   `telegram_id = -779000002`.

A helper script was drafted but not committed: writing to the production database from
an agent session needs the founder's explicit go-ahead.

## Turning it off (after approval)

1. Empty both values and restart. Sign-in for that address then fails like any
   non-university address, and the worker stops.
2. Optionally delete both accounts through admin account deletion.

## Founder feed

The review pair behaves like a real pair, so the founder ops feed reports its
"date scheduled" moments too. That is expected noise during review.
