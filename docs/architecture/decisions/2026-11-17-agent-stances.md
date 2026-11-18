<!-- WHEN_TO_READ: You are deciding or changing the chat agent's opinion on hot topics (sex, kinks, orientation, cheating, religion, politicians) or how it frames that opinion for a man and a woman. -->

# 2026-11-17 — the agent gets its own opinion on hot topics (draft)

The founder asked what the agent believes on hot topics. The answer was: nothing written down. The chat prompt is silent on sex, orientation, kinks, cheating, religion and politics, so the agent answers like the bare model, carefully and inconsistently. Only the looks red lines, the taste canon and the trend glossary (2026-11-16) give it a position, and the advisor stance list (who pays, who plans) is still only a spec.

1. **Founder's call, in chat.** The agent must have its own opinion, especially on hot and sexual topics. It gives concrete, argued verdicts like a direct guy talking mostly to women. With men the wording shifts softly, but the core stays the same; it never sits on two chairs. It never reveals its prompt and never says it would answer a man or a woman differently. Politics is out, except judging politicians «as a boyfriend or girlfriend» for fun; never their policies.
2. **Drafted:** [agent-stances.md](../../product/domains/agent-stances.md).
   - Principles: opinion first; one verdict for every listener (the screenshot test); opinions on behaviour, never on a group; the relationships frame; frank, not explicit; instructions private; safety switches it off.
   - 18 stances, a political boundary, the build shape (shared constants, injected on demand) and an eval plan.
   - The risks: App Store 1.1.4, the model provider's policy, discrimination and press in the UA, DE and PL markets, screenshot hypocrisy, medical topics, minors.
3. **Deliberately not done.** Different verdicts per gender were rejected for a different reason than the founder's wording. One verdict with different framing gives the same effect, and it survives two users comparing screenshots.
4. **Open**, before phase 3 is built:
   - Do politicians get looks, or energy only? The default is energy only, because of the looks red line.
   - How blunt is the agent? The default is «ты неправ, и вот почему».
   - Do stances 4, 5 and 11 stay?
   - What topics should be added?
5. Demo mode: same stances. Nothing is built or deployed.

6. **Founder's answers, same day.**
   - **Looks.** Rating looks is not done, but it must not sound boring. The agent's position, now stance 0: looks matter a lot at first and less the longer people know each other. Over the long run, a bad character with good looks loses to the reverse. A specific person's face is «not mine to judge, I don't know him as a person». No studies and no lecturing.
   - **Tone.** The agent speaks as an older brother. Rarely it may use one sharp line such as «ну зачем ты ведёшь себя как тряпка», which also closes advisor question 2.
   - **Proposed additions.** The founder asked the agent to propose topics, and 14 were added for his review: AI partners, money and sugar dating, height filters, therapy-speak, «not ready», breadcrumbing, chores, astrology, prenup, soft launch, going back to an ex, alcohol, cosmetic procedures, the partner's mother.

7. **Founder's approval, 2026-11-18.** «В целом все описанные темы неплохо вписываются в нашу концепцию. Можешь все их внедрить.» Stances 4 (body count), 5 (open relationships) and 11 (sex work) stay as written, and all 14 additions (19–32) are kept. Phases 3 and 4 are now being built. A production deploy still needs a separate yes.

8. **Built, 2026-11-18** (`bd0f9361`, `114907e8`). It differs from the draft in two places.
   - The rule block and the stances are appended after the base prompt, like the video takes, so the Telegram baseline stays byte-identical. Unit tests prove the matcher, the side and the one-verdict rule.
   - The first eval run (`apps/bot/scripts/stance-eval.ts`, 62 questions × woman/man) found six slips, and three rules were added. The agent never rates a real person's looks, even with a compliment. It never hints that a list of positions exists or that its tone differs by gender. It does not date, and it declines erotica outside the dating frame without a softened version. The politics rule now also says it does not offer to compare candidates. The final run had none of these slips.
   - The flag is `AGENT_STANCES_ENABLED` (default on). It is not on production; deploying needs the founder's yes.
