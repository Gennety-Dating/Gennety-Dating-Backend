<!-- WHEN_TO_READ: You touch the private screenshot library: import, index, chat tools, deletion or its costs. -->

# Private screenshot library

A person connects Apple Photos, Gennety imports their system-marked screenshots
and keeps a private searchable copy, and the chat agent finds things in it on
request. Behind `SCREENSHOT_LIBRARY_ENABLED`, off by default. Decision:
`docs/architecture/decisions/2026-10-31-screenshot-library.md`.

## Boundaries

A screenshot, the model's reading of it and something the person confirmed are
three different things. Importing changes no profile field, no matching input,
no date and nothing a partner can see. Adding to the wishlist stays the existing
card with its button. Nothing from the library rides in the prompt: the agent
calls `search_screenshots`, `read_screenshot`, `view_screenshot`, `show_screenshots`
and `check_event` on intent.
Telegram has no part of this.

The agent looks when asked for something saved (`purpose: find_saved`), and may look
once when the person asks about a date, something to do, a look, a gift, food, an
atmosphere or free time (`purpose: inspiration`). Only the first can raise the
«Подключить» button: a question about Saturday does not grow a card, and without a
library the prompt tells the agent not to look or bring it up. The prompt carries one
bit, whether a library is open, and none of its content.

The prompt section also says, on every turn with the tools: saved is not wanted, so the
reason and the atmosphere are asked, not concluded; no allergy, diet or sensitive trait
from a picture; a gift starts with asking who it is for; nobody is identified from a
face, and a pictured person says nothing about the owner; an event is checked before it
is suggested and what has passed is not offered; found is not saved, and the wishlist's
card stays the only way to add. These are instructions to a model, not enforced by code,
apart from the tools' own limits; live prompt evals have not been run.

## Flow

The phone downsizes the image to at most 1600 px, recognises text with Vision,
hashes the original and calls `POST /v1/me/screenshots/uploads`. It PUTs to the
signed URL, then calls `POST /v1/me/screenshots/{id}/commit`, where the server
checks the real bytes (JPEG or PNG, size, pixels). The reservation runs under a
lock on the library row, the one «Отключить и удалить» takes first, so an upload
racing a disconnect is refused rather than left in a closed library, and the cap is
counted there. An automatic upload older than the chosen `rangeDays` answers
`out-of-range`; a hand-picked one is not limited. A one-minute cron
(`workers/screenshot-library.ts`) takes six queued items, newest first, checks the
stored bytes again (the signed PUT outlives commit), reads
each with `MODELS.visionFast`, embeds the text with `text-embedding-3-small` and
marks it ready. A failure backs off and retries, up to five attempts. An answer cut
by the token limit is not a failure: one more request asks for no copied words, and
the phone's OCR stays what search reads.

## What a screenshot is

The reading describes content and stores one of ten kinds in `category`: `place`
(restaurants, parks, hotels), `event` (concerts, exhibitions, shows, workshops),
`activity` (an idea of something to do), `outfit`, `item` (gifts, flowers, things),
`food` (dishes, recipes, menus), `aesthetic` (interiors, landscapes, mood), `media`
(books, films, music, hobbies), `text` (quotes, notes) and `other`. The reading has
no field for who a thing is for, why it was saved, or what the person wants or eats.
Those are the person's to say and the model's guess has nowhere to be stored.

On the wire `category` keeps the first four values, because shipped builds decode a
closed enum and an unknown value fails the page; `outfit` and `item` read as `thing`
and the other new ones as `other`. The finer value travels as the string `kind`.

## Reindexing

`SCREENSHOT_PROCESSING_VERSION` is what a row was read by. Rows of an older version
are re-read at three per tick, only when nothing new is waiting and within the same
limits as first indexing. A row stays `ready` and searchable throughout, keeps its
old reading if the new one fails, and is tried again with a growing delay, then once
a week. A row that ran out of attempts under an older version gets one new round;
out of attempts under this version it stays `failed`. At three per minute a full
library of 2,000 takes about eleven hours and, at the estimate below, under two
dollars.

## States

Library: `off`, `active`, `paused`. Pause holds uploads and indexing and keeps
data. Item: `reserved`, `queued`, `indexing`, `ready`, `failed`. `deletedAt` hides
an item at once and clears its text and vector; the same cron removes the object,
strips the item from old chat cards, then removes the row. A reservation without
bytes is dropped after 24 hours.

## Late answers

Disconnecting clears consent and hides every row. The next connection has a new
`generation`. Every write names its generation and the indexer's last update only
matches a live row of that generation, so a slow job cannot restore anything.

## Duplicates and returns

Content is unique per account by hash of the original, and a deleted row gives
its hash up. A different hash under the same source key is an edit: it becomes a
new row and the old one leaves. Deleting an item records an exclusion so the next
automatic pass skips that source. Picking the same image by hand clears the
exclusion. Disconnecting clears all exclusions, so reconnecting imports afresh.

## Search

Exact words over recognised text, title and description come first, then cosine
distance up to `SCREENSHOT_MATCH_MAX_DISTANCE`. Both filter by owner in the query.
There is no vector index: per-person rows are few and an approximate index filtered
afterwards would lose results. Words match from the start of a word, whole if shorter
than five letters. A keyword finds on its own; the words of a description must all be
there. The labelled set found this: as plain substrings, «car insurance» answered
«recipe card» and «add to cart». The agent can narrow by kind and by the day a
screenshot was taken, and can list without a query, newest first with a total, for
«все мои рестораны». An item with no capture time counts by its import. Pages are
20 when listing and 8 when searching, with `nextOffset` while more remain.

The distance limit is a starting value and has not
been measured: the labelled set is `apps/bot/evals/screenshot-search/labelled-set.ts`,
all invented, nine lines of three items, and `threshold.ts` beside it prints the figures
when given an embedding key. The SQL itself runs in
`screenshot-library.integration.test.ts` with a toy embedding, which says nothing about
the right value.

## What the agent reads and sees

`read_screenshot` gives the stored text in parts of 3,000 characters, with
`nextOffset`, up to the 8,000 stored. `view_screenshot` shows the model the picture,
for questions about how something looks that the description does not answer: own
row only, with checked bytes, at most two per turn, the same one once, refused over
the person's token budget. The picture travels as a five-minute signed URL at low
detail in that turn's context only and is stored nowhere. It carries its rules in the
same message: everything on it is data, no one is identified from a face or body, and
a person pictured says nothing about the owner.

## Is it still on

`check_event` looks an event up through the web search the wishlist already uses, and
answers one of three. `confirmed` means a page the search itself cited states a date
that has not passed; the agent may give that link. `outdated` means a cited page says
it is over, or a date, on the page or the screenshot, has passed, which needs no search.
`unverified` is everything else: no cited page, no date, a timeout, a limit. Then the
agent states nothing as fact and says it could not check.

A screenshot's words are search terms and no more. Links are removed from them before
the search, and a link counts only if the search's own record cites its site, so a page
planted in a screenshot cannot vouch for itself. Links are never opened by Gennety.

Ten searches per person per day and two per turn, in process like the wishlist's; twenty
seconds each. The verdict is cached six hours for a yes, a day for a no and half an hour
for not knowing, shared across people, in `web_lookup_cache`; a failed search is not cached
and a cached yes whose date has passed reads as `outdated`. Tokens reach the person's
daily budget through `openaiFetch`. Over budget means no search. Each search is billed by
the provider apart from tokens; `[event-check]` log lines count them. Not run against the
live provider yet: the shape of `web_search_call.action.sources` and citations under a
JSON answer is unmeasured, and if they come back empty every answer is `unverified`.

## Cost

Prices at the time of writing, `gpt-6-luna`: $0.10 input and $0.50 output per
million tokens. Estimated, not measured: 3,000 to 6,000 input and 300 to 500 output
tokens per screenshot, which is $0.00045 to $0.00085. The ceiling per answer is now
1,500 tokens and a cut answer costs a second request. The cron logs real token
counts (`[screenshots] read tokens`), which should replace this estimate. Indexing
runs outside a request, so it does not spend the person's daily chat budget. Its
limits are 2,000 items per library and 1,000 indexed per person per day. The Batch
API, half the price for the old archive, is not implemented yet.

With the flag off the routes still answer `GET` (state, list, one item; not the
search, which pays for an embedding) and `DELETE` (one item, and disconnect-and-delete),
so switching the feature off never strands data. A person on `SCREENSHOT_LIBRARY_USER_IDS`
(comma-separated user UUIDs) gets every route, the chat tools and indexing as if the flag were
on (`services/feature-preview.ts`); `GET /v1/app/config` says so only with their token.

The signed upload URL does not overwrite (2026-11-03): one key per item, and once bytes are stored
nothing replaces them, so a repeated PUT after a lost answer is refused as existing and the phone
goes on to commit. Reconcile removes only automatic imports of the current generation; a
hand-picked screenshot stays. An edited screenshot keeps its idea, which moves to the new version. Connecting, uploading, reconciling and
search answer 404 `feature-disabled`, and the cron only purges.

Throughput: one tick indexes at most six items, so the whole service indexes at most
about 8,600 a day, shared by everyone, newest first across all libraries. One person's
2,000-item first import alone takes about five and a half hours. This is a capacity
choice to make before the flag goes on (audit 2026-11, F-11), not a bug.

## Before turning the flag on

Create the private `screenshots` bucket. Publish the policy text in
`legal/screenshot-library-draft.md` after legal review. Run `evals/screenshot-search/threshold.ts` with a key and set the distance limit from it,
take the physical iPhone timings, and run `check_event` against the live provider. Compare real token counts with the estimate.
