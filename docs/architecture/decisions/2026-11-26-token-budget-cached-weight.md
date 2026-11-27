<!-- WHEN_TO_READ: A person hits «На сегодня я выговорился» / 429 `daily_token_budget` sooner than expected, you touch `LLM_*_TOKEN_BUDGET`, `services/token-usage.ts`, the `[llm-usage]` / `[chat] turn usage` log lines, or the detail of earlier photos in the app chat context. -->

# 2026-11-26 — token budget: cached tokens at a tenth, measured per call; request laid out for the cache

**Kind:** founder request («Да, замер и правка» on 2026-11-26) after the
founder hit the daily agent limit in the iOS chat after what felt like a
short conversation.

**Why.** Measured with the real prompt builder on an empty profile: one call
of the app chat sends a 47.5k-character system prompt and 27 tools
(15k characters of JSON), about 16k tokens before any history or photo. A
turn with one tool round is two such calls, and up to ten earlier photos rode
along at full detail on every call. The budget counted OpenAI's
`total_tokens`, cached prompt tokens included, so 180 000 tokens a day were
roughly ten calls — a handful of real turns. The bill does not grow that way:
OpenAI serves the repeated prefix from its prompt cache at about a tenth.

## What changed

1. Both budgets (per person per day, global per hour) count a cached prompt
   token at `LLM_CACHED_TOKEN_WEIGHT` (default 0.1, clamped 0..1; 1 restores
   the old whole count) and every fresh and completion token whole. The
   arithmetic lives in `services/token-usage.ts` (`usageOf`).
   `LLM_USER_DAILY_TOKEN_BUDGET` stays 180 000.
2. Measurement: every OpenAI call logs one `[llm-usage]` line (key, model,
   prompt, cached, completion, counted) and every app chat turn one
   `[chat] turn usage` line (calls, photos in context, the same sums).
   `LLM_USAGE_LOG=false` silences both.
3. Earlier photos in the app chat context (up to ten from the last eight
   rows) go as `detail: "low"`, about 85 tokens instead of 1–1.5k each. The
   photo of the current turn keeps full detail. A question about fine print
   in an older screenshot now gets a coarser look; the agent's reply about it
   on its own turn is still in the history.

## Deliberately not done

1. The person's local time («Their local time now … at 13:13») sits at
   character ~34.5k of the 47.5k system prompt and changes every minute, so
   the last ~13k characters and the history are never cache hits across
   turns. Moving the per-minute lines to the end of the prompt would raise
   the cache share; not done here because it reorders what the model reads.
2. The history window (30 rows), the tool rounds (up to 5 + a closing call)
   and the 180 000 ceiling are unchanged. Decide them from the new log lines.
3. Counters stay in memory (reset on restart), as before.

## Part 2 — the request laid out for the cache (same day)

**Kind:** founder request («Построй план … и реализуй его полностью» on
2026-11-26), with the condition «без ухудшения качества общения».

**Why.** The provider reuses a prompt only up to the first token that changed
since the previous call. Three things broke it early on every turn: the live
data (person card, notes, the clock to the minute) sat in the middle of the
system prompt, in front of ~13k characters of fixed rules; the live part sat
before the history, so the history was never reused; and the 30-row window
moved every turn, so the history's start changed every turn anyway.

1. Layout of an app chat call: the fixed rules (persona, playbook, the chat
   addenda, then memory, taste, looks, video, stance and concept rules in
   their old order) → «Earlier in this chat» as its own system message → the
   history → one system message «This turn — live data» (the person's
   context, timeline and language, the person card, memory notes, the shared
   video, the positions named, the reminder clock, «This person, for the rules
   above», the vibe and reaction rules offered this turn, the context chip) →
   the person's message. No text was dropped or reworded; `splitRuleBlocks`
   (`services/prompt-layout.ts`) only moves the rule texts in front.
   `buildSystemPromptParts` gives the shared prompt in its two halves;
   `buildSystemPrompt` still returns exactly the old string.
2. ~~The history window shows 30–39 rows, starting on a multiple of ten.~~
   Reverted in part 3: the provider never reuses the history on its own, so
   the extra rows were only paid for. The window is the old fixed 30 again.
3. App chat calls carry `prompt_cache_key` = a SHA-256 slice of the user id
   (never the id itself). A 400 that names the parameter switches it off for
   the process and the call is retried at once without it, so it can never
   cost a reply. `LLM_PROMPT_CACHE_KEY=false` never sends it.
4. The Telegram agent gets the same order inside its single system message:
   fixed rules first, then the live part under the same header. Its 12-message
   history and its calls are unchanged (no cache key there).

**Measured** with the real prompt builder, two turns a minute apart in a
45-row chat, the second after one exchange: the part of the request equal to
the previous call (what the cache can serve) went from 73.9 % to 92.8 %;
fresh characters per call from ~17.7k to ~5k. This was a character estimate that assumed prefix caching. Part 3 measured the provider: it reuses less, so the real gain is the rules and tools block.

**Deliberately not done**, each because it would cost quality or needs data
first:

1. Shrinking photos on upload: OpenAI already scales them, and a phone
   screenshot cut to 1024 px loses the small text the agent reads; the server
   also has no image library (a new dependency needs its own «да»).
2. Rewording tool descriptions or trimming the persona and playbook: after
   the reorder they sit in the cached prefix, counted at a tenth; rewording
   without the live evals risks how the agent behaves for a small gain.
3. Preloading facts to save tool rounds: needs the `[chat] turn usage` lines
   from production to know which rounds happen. Rounds now mostly re-read the
   cached prefix.
4. The shared-video reader (one fast vision call on the cover, cached six
   hours), voice (Whisper) and onboarding were checked and left as they are.
5. Earlier photos are still signed afresh each turn, so the history stops
   being a cache hit at the first earlier photo (within the last eight rows).

## Part 3 — measured on production, the layout corrected (2026-11-28)

After the deploy (`83f8376e`) the founder's first two app chat turns showed
`cached=0` at ~21k prompt tokens each, while a small side call in the same
minute got 1800 of 1914 cached. Probes against gpt-6-luna from the Mac, with
the real persona and the real 27 tools, showed how its cache behaves. Each
probe sent two requests a few seconds apart and read the cache on the second.

1. The same request twice: 6368 of 6371 tokens cached, with
   `prompt_cache_key` and without it. Caching works with tools and the key.
2. The leading run of system messages and the tools are reused as ONE block.
   - A change in the last characters of the system message gives 0 cached.
   - One tool appended to the end of the list also gives 0 cached.
   - Prefix matching inside that block does not happen.
3. Past that block, only a whole earlier request is reused.
   - With the live part kept in the history (an experiment), the next turn
     got 10004 of 10029 cached.
   - With the live part right before the person's message (our layout), the
     history identical in both turns was NOT reused. Only the block was:
     6362 of 10041.
4. A new chat's first turn is `[rules, live, message]`, so its leading system
   run held the live part. The second turn's run did not hold it, so the cache
   missed. That is exactly the production `cached=0`. From the third turn on,
   the block was reused (6362).

Changes:

1. `livePartIndex` (`services/prompt-layout.ts`) places the live part. With
   history above, it goes right before the person's message. With none, it goes
   right after the message, so it never joins the leading system run. Probe:
   the second turn then got 6368 cached instead of 0.
2. The history window is the fixed 30 again: `steppedWindowSize` and its
   `count` are removed.
3. Telegram: the live part was the tail of its only system message, so by
   item 2 its cache could never hit. It now rides its own system message,
   placed by `livePartIndex`, and is never written into the stored history.

What the cache now covers: the rules and tools block on every turn but a
chat's first, at a tenth. The history and the live part are paid in full.
Caching the history would mean keeping each turn's live part in it, about
1–3k extra tokens a turn. That is not done.

## Deploy

Parts 1 and 2 are deployed (`83f8376e`, 2026-11-26). Part 3 waits for the
founder's «да» (`docs/operations/deploy-journal/pending.md`).
No schema, no migration, no new required env; demo mode: same code, same
defaults, no flow change.
