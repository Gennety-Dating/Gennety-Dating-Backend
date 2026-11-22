<!-- WHEN_TO_READ: Touching `GET /v1/app/config → recommendedIosVersion`, `IOS_RECOMMENDED_APP_VERSION`, or the iOS "new version is out" mascot and button; before replacing its version source. -->

# 2026-11-22 — The soft iOS update hint reads its version from our backend

## 2026-11-22 — `recommendedIosVersion` on `/v1/app/config`; iTunes Lookup rejected

**Kind:** founder decision (the source) + agent design (the rest)

**What:**

1. The founder asked for a non-intrusive "a new version is out" hint in the app: the mascot says it once per version and a glowing button stays at the top until the app is updated. The look was approved on 2026-11-22 from a simulator recording. Asked where the app learns about a new version, the founder answered «Наш бэкенд» (over Apple's iTunes Lookup).
2. `GET /v1/app/config` gains an optional `recommendedIosVersion` (string or null), from env `IOS_RECOMMENDED_APP_VERSION`, empty by default → null → no hint. No schema change; additive for every client.
3. It is separate from `minSupportedIosVersion`: the hint never locks anyone out, and a build below the floor sees the forced screen and no hint.
4. The iOS client shows nothing when the field is absent or empty, and also refuses while its App Store link is the placeholder (no numeric App Store id), so a value set too early cannot send people to a dead page.
5. Demo mode: nothing to branch (`docs/product/demo-mode.md`).

**Why:** the founder decides when a release is worth announcing, with no new external API and nothing published in the App Store required to test it.

**Rejected:** iTunes Lookup (a new external service, works only for a published app, no control over the moment); reusing `minSupportedIosVersion` (that one locks the app).

**Not decided here:** the production deploy and the value itself. Both need the founder's separate «да».
