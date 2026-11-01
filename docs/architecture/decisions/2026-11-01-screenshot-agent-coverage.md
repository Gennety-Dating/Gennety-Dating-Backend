# 2026-11-01 — Screenshot library: what the agent can do with all nine kinds

1 entries.

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
