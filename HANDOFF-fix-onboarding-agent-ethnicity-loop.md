# Handoff: Fix onboarding-agent ethnicity-guard tool loop

> Self-contained brief for a fresh Claude Code session. Paste this prompt to start.
> The bug was found during E2E testing on 2026-05-29 in the Gennety Dating repo.

## Context

The onboarding conversational agent (`apps/bot/src/services/onboarding-agent.ts`)
has a regression introduced by commit **`ce07f84` fix: tighten onboarding
ethnicity prompt** (2026-05-29). The new ethnicity guard
(`shouldBlockContextDumpForEthnicity` at ~line 873) blocks
`request_context_dump` when ethnicity hasn't been asked, but the surrounding
code wasn't updated to handle that error branch correctly. The result is a
runaway tool loop that hits `MAX_TOOL_ROUNDS=8` per user turn and sends the
user a broken DM (the instruction "Скопируй промпт выше…" with no actual
prompt above it).

## Reproduction (verified in dev DB, telegram_id 5986970093)

User flow:
1. User completes Mini-App entry, sends name + age, sends gender + preference
   + partner_pref + first hobby in one dump, sends height.
2. After "180 см", the LLM:
   - calls `save_profile_data` WITHOUT height (ignores user's latest message) →
     tool returns `error: missing height`
   - calls `request_context_dump` → guard blocks: `error: ask ethnicity first`
   - repeats `request_context_dump` 7 more times → all blocked
   - loop hits MAX_TOOL_ROUNDS=8, exits
3. The user DM is `contextDumpInstruction` ("Скопируй промпт выше…") with NO
   actual `magicContextPrompt` above it. User reports "не спросил
   национальность, промпт не скинул".

## Root cause (concrete file + line refs)

[apps/bot/src/services/onboarding-agent.ts:1514-1523](apps/bot/src/services/onboarding-agent.ts#L1514-L1523):

```ts
if (fnName === "request_context_dump") {
  history.push({ role: "assistant", content: magicContextPrompt(...) });
  history.push({ role: "assistant", content: contextDumpInstruction(...) });
  break;
}
```

This block runs UNCONDITIONALLY when the tool name is `request_context_dump`
— regardless of whether the guard fired. So:
- Even when the tool returned `{success: false, error: "ask ethnicity"}`, the
  magic prompt + instruction get pushed to history as `assistant` messages.
- The LLM sees the conflicting state on the next round (tool said error, but
  prompt is in history) and re-issues `request_context_dump`.
- `stopAfterToolRound` is NOT set on the guard-error branch, so the outer
  round loop continues, repeating the same dance.
- The final reply sent to the user is `lastAssistant.content` which is the
  TAIL of the pushed messages — `contextDumpInstruction`. The magic prompt
  message is the one BEFORE it, never surfaced as a separate Telegram DM
  because the bot caller only sees `result.reply` (one string), and the
  separate copyable Telegram message is sent based on the
  `contextPromptRequested` flag — which is FALSE when guard fires.

So the user gets the instruction "paste the prompt above into ChatGPT" with
no prompt above. Looks broken; is broken.

## Fix plan

### 1. Make the magic-prompt push conditional on guard success

Move lines 1514-1523 INSIDE the success branch (around line 1418-1427), or
gate them on `contextPromptRequested === true`. Specifically:

```ts
case "request_context_dump":
  if (shouldBlockContextDumpForEthnicity(user, history)) {
    result = JSON.stringify({
      success: false,
      error: "Before request_context_dump, ask the user ONE short optional ethnicity/nationality question..."
    });
    stopAfterToolRound = true;  // <-- ADD THIS: force LLM to produce a text reply (asking ethnicity) instead of looping
  } else {
    contextPromptRequested = true;
    contextDumpStarted = true;
    result = JSON.stringify({
      success: true,
      message: "Magic Prompt has been sent. The server is stopping this turn..."
    });
    stopAfterToolRound = true;
  }
  break;
```

And the post-switch block at line 1514-1523 should be:

```ts
if (fnName === "request_context_dump" && contextPromptRequested) {
  history.push({ role: "assistant", content: magicContextPrompt(user?.language ?? "en") });
  history.push({ role: "assistant", content: contextDumpInstruction(user?.language) });
  break;
}
```

The key change: `contextPromptRequested` is only `true` when the tool
actually succeeded (guard didn't fire), so the magic prompt only gets pushed
when it was legitimately requested.

### 2. Force a text reply on guard error

`stopAfterToolRound = true` on the guard-error branch ensures the outer loop
breaks after ONE round. The LLM gets one shot to produce a text reply asking
for ethnicity. If LLM still chose a tool call instead of text, the next user
message will give it another opportunity — but it won't infinite-loop within
a single turn.

### 3. Add a regression test

In [apps/bot/src/services/onboarding-agent.test.ts](apps/bot/src/services/onboarding-agent.test.ts):

```ts
it("does NOT push magic prompt to history when ethnicity guard blocks request_context_dump", async () => {
  // Setup: user without ethnicity, history without ethnicity prompt
  // LLM emits request_context_dump tool call
  // Assert: tool result is the guard error
  // Assert: history does NOT contain magicContextPrompt content
  // Assert: history does NOT contain contextDumpInstruction content
  // Assert: stopAfterToolRound caused exactly ONE round (not 8)
  // Assert: contextPromptRequested === false in turn result
});
```

This test would have caught the bug. Existing test
`"blocks request_context_dump until ethnicity has been asked once"` only
verified that the tool returns an error — not that the surrounding state
stays clean.

### 4. (Bonus, optional) Add structured logging

Add `console.log("[onboarding-agent]", { telegramId, round, tool, success })`
inside the round loop. Production debugging this from DB-archaeology took 20
minutes; with logs it'd be 30 seconds. Don't log message content (PII).

## Out of scope for this fix (separate tasks)

- The `save_profile_data` call ignored the user's "180 см" message and
  returned `missing height`. This is a separate LLM-behavior issue
  (probably a prompt regression elsewhere) — investigate after the
  primary fix.
- Replacing the regex-based `hasEthnicityPromptAlreadyHappened` with a
  deterministic DB flag `profiles.ethnicity_asked_at` — better long-term
  but bigger change.
- Replacing the LLM-driven onboarding with a state machine — too big to
  fold in here, but the recurring "new feature breaks old behavior"
  pattern is real and architectural. Worth a separate design doc.

## Verification

```sh
# 1. Apply the fix to onboarding-agent.ts (sections 1 + 2 above)
# 2. Add the regression test
pnpm --filter @gennety/bot exec vitest run src/services/onboarding-agent.test.ts
# 3. Full suite still green
pnpm --filter @gennety/bot exec vitest run
# 4. Manual smoke in @gennetytestbot with the dev DB cleared
#    - /start, complete onboarding through height
#    - Assert: bot asks ethnicity ONCE
#    - Reply "skip" or give ethnicity
#    - Assert: magic prompt sent as a separate copyable Telegram message
```

## Files of interest

- [apps/bot/src/services/onboarding-agent.ts:1409-1530](apps/bot/src/services/onboarding-agent.ts#L1409-L1530) — the round loop and tool case where the fix lands
- [apps/bot/src/services/onboarding-agent.ts:865-878](apps/bot/src/services/onboarding-agent.ts#L865-L878) — the ethnicity guard (don't touch logic, just don't fight it)
- [apps/bot/src/services/onboarding-agent.test.ts](apps/bot/src/services/onboarding-agent.test.ts) — where the regression test goes
- [packages/shared/src/ai/prompts.ts:33-63](packages/shared/src/ai/prompts.ts#L33-L63) — `magicContextPrompt` (don't change)
- [apps/bot/src/services/onboarding-agent.ts:52-107](apps/bot/src/services/onboarding-agent.ts#L52-L107) — `contextDumpInstruction` (don't change)

## Commit message suggestion

```
fix: stop pushing magic prompt to history when ethnicity guard blocks request_context_dump

The ethnicity guard introduced in ce07f84 returns an error result when
the user hasn't been asked about ethnicity yet, but the post-switch
block kept unconditionally pushing magicContextPrompt + contextDumpInstruction
to the assistant message history. The LLM saw conflicting state (tool
error vs. prompt in history) and re-issued request_context_dump in
every round until MAX_TOOL_ROUNDS, sending the user a broken DM (the
instruction with no prompt above it).

Fix: gate the magic prompt push on contextPromptRequested (which is
only true on the success branch). Also set stopAfterToolRound on the
guard-error branch so the LLM gets one round to produce a text reply
asking for ethnicity instead of looping.

Adds a regression test that asserts no magic prompt in history and
loop breaks after one round when the guard fires.
```
