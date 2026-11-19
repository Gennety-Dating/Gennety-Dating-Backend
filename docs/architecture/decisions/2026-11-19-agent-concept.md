<!-- WHEN_TO_READ: You are changing how the chat agent holds attention, ends a conversation, argues, uses memory or jokes, or adding any agent prompt block, hint or proactive message — read what the founder's concept of 2026-11-19 decided and what still waits for him. -->

# 2026-11-19 — the agent concept: offline is the goal, no attention traps

1. **Founder's concept, in chat.** The Gennety chat is not a place where people get hooked. Anything that holds attention works only for the person and never gets in their way. The agent helps in personal moments, stays a friend and keeps a long memory. Its main job is trust: a firm spine, its own opinion and a clear grasp of what the person wants. It leads people offline, to dates and real life. It may be funny and shareable, and never forgets that goal. The founder asked for an audit and for the agent to be adapted to this without further questions, for prompt and persona changes. Flow and product-rule changes are to be asked first.
2. **Audit**, [agent-concept.md](../../product/domains/agent-concept.md) phase 1:
   - The app addendum tells the agent not to let people go: on «hi» or «ok» it must add «one light question about THEM».
   - About half of all replies end with a question.
   - The Telegram prompt has no clock.
   - Neither surface has a rule for ending a conversation.
   - The spine covers only hot topics.
   - The agent does not know the person's dating goal.
   - Telegram remembers 12 messages from 24 hours.
   - Humor is allowed only by omission.
   - Proactive messages: the profiler batches and the onboarding re-engagement chain are the two that call people back without a real step.
3. **Built, behind `AGENT_CONCEPT_ENABLED` (default on).**
   - One block of ten rules (`packages/shared/src/agent-concept.ts`) is appended after the stances on both surfaces. It says it wins over any line above. That overrules the app addendum's «don't just sign off» without editing `chat-agent.ts` text that other sessions are working in.
   - Two lines about the person follow the rules. The first is their local time, marked «night» in quiet hours. The second is their own relationship-intent answer in plain words, never as a label.
   - `buildSystemPrompt` is untouched, so the Telegram baseline is byte-identical.
4. **Deviation from the schema comment.** `Profile.relationshipIntents` was documented as «read by the soft V_intent multiplier and by nothing else». The agent now reads it too.
   - It is the owner's own answer, shown only to the owner, and it is used only to aim advice to that owner.
   - It still never reaches the partner, the pitch or the embedding.
   - No schema change.
5. **Proof**, `apps/bot/scripts/concept-eval.ts`: 16 multi-turn conversations × 2, `gpt-6-luna` answering and `gpt-6.1-sol` judging.
   - The mean concept score rose from 6.6 to 8.2.
   - Replies ending with a question fell from 49% to 15%.
   - The night goodbye rose from 4.0 to 8.5, «привет» from 4.5 to 8.0, and 3 a.m. loneliness from 4.0 to 8.5.
   - The first after-run left «развлеки меня», «просто ждать?» and flattery weak, so rules 2, 5, 7 and 10 were tightened once.
   - Comparison page: https://claude.ai/artifact/G1qWPVjuTPGGHv2UDBofe1 (private to the founder).
6. **Deliberately not done; waits for the founder** (agent-concept.md phase 4, each with a recommendation):
   - profiler batches stop after two ignored ones and get an off switch;
   - the re-engagement chain is capped at five touches for life;
   - Rematch is dropped from the expired-match notice;
   - quiet hours for the campus drop and the T+24h prompt;
   - one announcement push per week;
   - a per-type mute (schema);
   - the countdown banner is kept;
   - the Telegram agent gets the person card and past-chat search;
   - advisor phase 4 waits.
   No push, cron, button or limit was changed.
7. Demo mode: the same block; it costs nothing. Not deployed; production needs the founder's yes.
