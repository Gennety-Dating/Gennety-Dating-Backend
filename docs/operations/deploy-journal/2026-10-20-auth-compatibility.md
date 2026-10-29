<!-- WHEN_TO_READ: Native Telegram login shows a retry after returning from Telegram, or checking the pre-Pulse serializer compatibility backport. -->

# 2026-10-20 — Native auth response compatibility hotfix

Production's pre-Pulse user serializer omitted `analyticsOptIn`. The iOS
`AuthTokens.user` decoder requires that field. Thus a successful token exchange
could fail locally before the app adopted the tokens, showing the Telegram retry
notice. `/v1/me` uses the same serializer and had the same incompatibility.

## Change and scope

At 00:08 Europe/Kyiv, backported only `analyticsOptIn` to
`/opt/gennety/apps/bot/src/public/routes/serializers.ts`. The deployed Prisma
client predates Pulse, so an absent property becomes false; an explicit value
is preserved. Restarted only `gennety-bot` with a 30-second kill timeout.

This is **not a full main deployment**. No migration, dependency installation,
environment or secret edit, Mini App rebuild, demo restart, account alteration,
or verification bypass. Pending Pulse and other releases remain pending.
Twilio's SMS 403 is not resolved by this change.

Main's serializer now uses the same `user.analyticsOptIn ?? false` fallback, with
a regression test for legacy Prisma rows and explicit consent values.

## Verification

1. Ran the pre-change and candidate production serializers on a synthetic legacy
   user. Extracted the actual generated Swift `AuthTokens`/`SerializedUser` types
   from the current iOS checkout and decoded both responses. Before:
   `keyNotFound analyticsOptIn`. After: decoded, consent false.
2. All 21 targeted serializer, Telegram auth and phone auth tests passed.
   Bot typecheck and build (`tsc --noEmit`) passed. Tracked secret check passed.
3. After restart, public `/v1/ping` returned 200. Invalid ID token returned
   401 `Invalid Telegram token`. The poller started normally. The first probe
   during startup returned 502; the next probe passed after startup.
4. On 2026-10-21 the founder confirmed successful Telegram login on the personal
   iPhone after relaunch and retry. The earlier generic SDK failure did not recur.
   A brief consent-screen flash was separately traced to iOS publishing the
   signed-in state before loading the existing profile; the iOS fix and fresh
   main build are being verified separately.
5. SMS remains blocked by Twilio: a single authorized request on 2026-10-21
   returned HTTP 403 with error 60238. No provider configuration was changed.

The mandatory dependency audit was run and **failed on existing advisories**
(3 critical, 1 high, 3 moderate, of which 2 ignored), including `proxy-addr`.
No dependency changes were deployed in this emergency response-only backport.
This hotfix does not constitute a passing full-release security preflight;
the dependency findings remain work for the next full release.

## Integrity and rollback

The update checked both source checksums and atomically replaced the single file.
Original SHA-256: `3f2f3ac4e442ced82e58d4a9752d8db357e2381efb5e5bb198634bc5ab0f6177`.
Patched SHA-256: `972f33ca39d29938136d0f7db9f6e266f56b207df75ce852c2df3f574145abb5`.
Backup: `/opt/gennety-auth-compat-backup-20261020/serializers.ts`.

Rollback on the droplet: restore that file to the deployed serializer path,
restart `gennety-bot`, then verify `/v1/ping`. This restores the old native
decoding failure too, so rollback only if the backport itself causes a problem.
