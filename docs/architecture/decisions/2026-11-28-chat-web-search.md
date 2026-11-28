<!-- WHEN_TO_READ: You touch the app chat agent's `search_web` tool (`chat-web-search.ts`), `CHAT_WEB_SEARCH_*` limits, `CHAT_WEB_SEARCH_ENABLED`, the «Looking things up» rules in `CHAT_ADDENDUM`, or someone asks why the agent searches the web (or why it once asked for a link instead). -->

# 2026-11-28 — the app chat agent searches the web itself (`search_web`)

**Kind:** founder request (iOS chat, 2026-11-28): «попросил найти магазин
парфюмерии в Киеве и что у них на Чёрную пятницу — он не смог, попросил
ссылку, отработал не автономно и не показал шагов».

**Why.** The agent had no general web search. `web_search` existed only inside
the wishlist product look-up and `check_event`. A question about a shop and its
Black Friday sale had nothing to search with, so the model asked the person for
a link. No tool ran, so the app showed no «Ищу в интернете…» step: the step
comes from the tool that runs (`chat-activity.ts`).

## What changed

1. A new function tool `search_web(query)` on every app chat turn
   (`chat-web-search.ts`). It uses the same rail as the wishlist and
   `check_event`: OpenAI Responses with the hosted `web_search` tool, model
   `WISHLIST_SEARCH_MODEL`, the existing key. It adds no new provider and no
   new dependency.
   1. Only the query the agent wrote is sent out. The conversation is not.
      Links are removed from the query, as in `check_event`.
   2. The person's home city goes as the search's approximate
      `user_location`, and the instructions say to look there unless the
      request names another place.
   3. The search model writes a short factual summary. Only pages the search
      cited or read are passed on as `sources` (https, tracking stripped). An
      answer no page backs is `not_found`.
   4. Limits live in `@gennety/shared` `web-search.ts`: 8 searches per person
      per UTC day and 2 per turn, a 25 s timeout and a 3 h cache in
      `WebLookupCache` (kind `chat_web`). Only found answers are cached. The
      token budget gate is shared with the other look-ups.
2. The tool reports the existing `web` activity step, so the app shows «Ищу в
   интернете…» while it runs. No contract change: `web` was already a key of
   `GET /v1/chat/activity`.
3. `CHAT_ADDENDUM` gets a «Looking things up» block. Anything current or
   uncertain (a shop and what it has, sales, prices, hours, addresses, events,
   news) is searched first, in the same turn. The agent never asks for a link
   and never tells the person to search. It gives one or two links as plain
   URLs and says so plainly when nothing was found.
4. The kill switch is `CHAT_WEB_SEARCH_ENABLED=false`. Unset means on.

## Consciously not done

1. The Telegram menu agent does not get the tool yet. The founder's complaint
   was about the app chat. The tool is self-contained, so Telegram can reuse it
   later.
2. There is no new step key such as «reading the page». One `web` step covers
   the whole search, as it does for the wishlist.

## Demo mode

Demo accounts reach the same chat turn. Their searches are real look-ups
within the same limits. Demo mode does not fake web results.
