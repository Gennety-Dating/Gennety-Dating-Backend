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
calls `search_screenshots`, `read_screenshot` and `show_screenshots` on intent.
Telegram has no part of this.

## Flow

The phone downsizes the image to at most 1600 px, recognises text with Vision,
hashes the original and calls `POST /v1/me/screenshots/uploads`. It PUTs to the
signed URL, then calls `POST /v1/me/screenshots/{id}/commit`, where the server
checks the real bytes (JPEG or PNG, size, pixels). A one-minute cron
(`workers/screenshot-library.ts`) takes six queued items, newest first, reads
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
afterwards would lose results. The agent can narrow by kind and by the day a
screenshot was taken, and can list without a query, newest first with a total, for
«все мои рестораны». An item with no capture time counts by its import. Pages are
20 when listing and 8 when searching, with `nextOffset` while more remain. The distance limit is a starting value and has not
been measured on a labelled set.

## Cost

Prices at the time of writing, `gpt-6-luna`: $0.10 input and $0.50 output per
million tokens. Estimated, not measured: 3,000 to 6,000 input and 300 to 500 output
tokens per screenshot, which is $0.00045 to $0.00085. The ceiling per answer is now
1,500 tokens and a cut answer costs a second request. The cron logs real token
counts (`[screenshots] read tokens`), which should replace this estimate. Indexing
runs outside a request, so it does not spend the person's daily chat budget. Its
limits are 2,000 items per library and 1,000 indexed per person per day. The Batch
API, half the price for the old archive, is not implemented yet.

## Before turning the flag on

Create the private `screenshots` bucket. Publish the policy text in
`legal/screenshot-library-draft.md` after legal review. Run the labelled search set
and the physical iPhone timings. Compare real token counts with the estimate.
