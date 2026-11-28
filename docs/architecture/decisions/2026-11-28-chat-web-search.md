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
      `WebLookupCache` (kind `chat_web`). Found answers are cached (and, since the token economy below, «nothing found» for 30 min). The
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

## Token economy (same day, founder: «оптимизировать, чтобы эффективнее расходовал токены»)

Measured first: a search cost 15–21k tokens, nearly all of it fresh input,
because the search model made two look-ups by itself and read both pages'
results. The agent's own calls around it are mostly cached, and search results
never enter the chat history, so later turns do not pay for them.

1. One look-up per request: `max_tool_calls: 1` on the Responses call.
2. Little thinking: `reasoning: { effort: "low" }`, and `max_output_tokens`
   800 instead of 1500. The twelve-line answer measured 240–500 tokens.
3. The cache key is the query's words, with case, punctuation and order
   ignored (`queryWords`, cache version `chat-web:v2`). «Nothing found» is now
   kept for 30 minutes (`CHAT_WEB_SEARCH_NOT_FOUND_CACHE_MS`), so the same
   failed question asked again right away is not paid for twice. A failed
   request is still not kept.
4. Within one turn, a second query that repeats the first in other words
   (four words of five in common, `isNearDuplicateQuery`) gets the first
   result back with `repeated: true` and is not searched again. It still
   counts toward the 2 per turn.
5. One look-up sometimes misses a detail that two found. In the measurement
   these were a restaurant's hours and the IMAX session times. The `found`
   instruction now tells the agent to search once more with a narrower query
   naming the missing detail. That second search recovered the hours at 8.8k,
   so two searches together cost about what one did before.

Measured on six fixed Kyiv queries (shop sales, exhibitions, a restaurant,
IMAX, Rozetka), same instructions, before → after:

1. Tokens: 113k → 59k in total, 48 % less. Per search: ~9k instead of
   13–29k.
2. Speed: 8.0 s → 5.3 s on average.
3. Cited pages: the same or more on every query.

Consciously not done, each waiting for the founder:

1. A cheaper search model. It saves money, not the person's token budget,
   which counts tokens of any model alike.
2. More than 8 searches a day. At ~9k per search there is room for 12–15.
   This is a product limit, so the founder decides.
