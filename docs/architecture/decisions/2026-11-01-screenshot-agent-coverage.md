# 2026-11-01 — Screenshot library: what the agent can do with all nine kinds

2 entries.

## 2026-11-01 — Stage A: reading, search, sight and event checks

Kind: founder brief and design. Spec: `docs/product/domains/screenshot-library.md`.

The founder listed nine kinds of things people save and what each is for. This stage
makes the agent able to read and find all nine. It writes nothing new about the person:
the wish list, map, venue choice, Style Picks, gift recipient, tastes, atmosphere and
stated wishes get their writing points in stage B, on a shared model.

No schema change. `category` already is a free string in the table, the reindex state
reuses `processing_version`, `attempts` and `next_attempt_at`.

`category` on the wire stays the four first values for good: the shipped iOS decoder is
a closed enum and an unknown value fails the whole page. New field `kind` is a documented
string, like every later vocabulary in this API.

The reading has no field for a recipient, a reason or a preference. The founder's rule
is that the model describes and the person says, so a guess has nowhere to be stored.

Word search changed on evidence: the labelled set showed plain substrings answering
«car insurance» with «recipe card». Words now match from a word's start, whole below five
letters, and a description's words must all be present. A keyword still finds alone.

Agent looks on «inspiration» too; only `find_saved` can raise the connect card. A new tool
`check_event` trusts a source only if the search's own record cites its site.

Not measured, and said so in the spec: the distance limit (no embedding key was available
to this session, so 0.72 stays unmeasured), `check_event` and the reading against the live
provider, prompt behaviour in live evals, token counts.

Demo mode: same code, flag off, nothing changes.

Nothing was deployed. The flag stays off.

## 2026-11-01 — Stage B: the nine kinds on ideas

Kind: lead session's brief and design. Spec: `docs/product/domains/memory-ideas.md`, section In chat.

No new tables and no migration. Everything writes through the existing ideas model, behind
`MEMORY_IDEAS_ENABLED`. API changes are additive: `topic`, `vibeIds`, a suggestion's `city`,
`GET /v1/me/memory/vibe-question`, error `sensitive-value`.

Choices worth keeping: sensitive words are refused in the service, not only in the tool, so the app's route
holds too; a planning tool passes no city, because free-text cities in different languages would read as a
mismatch and exclude what fits; a run of several days stores no date; a re-confirmed preference marks the
embedding dirty.

Defects fixed in the ideas code: a repeat check of the same date cancelled the reminder for good; asking again
after cancelling reported a reminder that stayed cancelled; a saved idea stayed `planned` after its date's place
moved; history keys stopped an idea being planned again after moving back; tool arguments outside the
vocabularies reached the database; `reason` was dropped when a save joined an existing idea; a recipient was
stored on a non-gift; merged ideas left their preferences on the closed one; re-confirming dropped matching
without marking the vector.

Not measured: how the model behaves with these tools and prompts. No live model, provider or device was used.
