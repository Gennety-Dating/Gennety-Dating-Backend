<!-- WHEN_TO_READ: Places answers 403, venue photos are missing, the nightly re-validation fails for every place, or you are changing `places-health.ts` / `utils/places-error.ts` or the founder alert about Google Places. -->

# 2026-11-22 — The founder hears about a Google Places outage the first night

## 2026-11-22 — Alert on a wholly failed re-validation night; Google's reason goes to the log

**Kind:** founder decision (asked for the alert and the reason in the log) + agent design (the rest)

**What:**

1. When every place of a nightly re-validation batch fails, the founder bot gets one message with Google's reason and what stops working. It repeats every failed night. A partly failed night is silent.
2. "Answers again" is sent once, on the first night with no failures. That memory lives in the process, so a restart can drop the recovery message but never an outage message.
3. `NOT_FOUND` answers count as deactivations, never as an outage. Nothing about deactivation changed.
4. The photo proxy, Place Details and the photo lookup log Google's `status`, `reason` and `message` (`utils/places-error.ts`, 160 characters, keys and long numbers scrubbed); the photo proxy also names the host that refused, because `fetch` follows Places to its image CDN.
5. Demo mode: re-validation is not scheduled there, so no alert; the log change applies to both.

**Why:** on 2026-11-22 the production log held 22 807 lines of `photo proxy failed … HTTP 403` and nobody knew. The cause was not photos: the key was refused on every Places (New) method with a bare `PERMISSION_DENIED`, for twenty-one nights in a row. Earlier outages counted back from the log: 2026-08-03 (one night), 2026-09-03…09 (seven), 2026-10-03 (one). The key was the same throughout September to November. The reason on Google's side is not known from here: the early-month starts point at billing, `location.ts` recorded a key API restriction on 2026-09-07. It can only be read in the Google Cloud console.

**Rejected:** throwing from the tick so `guardedTick` alerts (its degraded state is in memory, and one bad night would read as a crashed job); an alert from the photo proxy (it fires only when somebody opens the app, and per request); a quota explanation (the documented 403 for photos, but every method was refused).

**Not done here:** no negative cache for refused photos, so iOS's two attempts still both reach Google; no change to how long photo names are stored (Google's docs forbid caching them).
