<!-- WHEN_TO_READ: A person hits «На сегодня я выговорился» / 429 `daily_token_budget` sooner than expected, you touch `LLM_*_TOKEN_BUDGET`, `services/token-usage.ts`, the `[llm-usage]` / `[chat] turn usage` log lines, or the detail of earlier photos in the app chat context. -->

# 2026-11-26 — token budget: cached tokens at a tenth, measured per call

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

## Deploy

Not deployed. Waits for the founder's «да» (`docs/operations/deploy-journal/pending.md`).
No schema, no migration, no new required env; demo mode: same code, same
defaults, no flow change.
