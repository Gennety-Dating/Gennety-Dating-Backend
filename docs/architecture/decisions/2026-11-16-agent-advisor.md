<!-- WHEN_TO_READ: Touching the chat agent's advice voice, its stance on who pays, the advice dossier, correspondence screenshots, or agent-initiated messages. -->

# 2026-11-16 — the agent becomes an opinionated relationship adviser

The founder asked for a more proactive agent that gives advice on chats and relationships, is radical rather than soft and accommodating, holds the culture that the man pays, and adapts to the person from their profile. The specification is `docs/product/domains/agent-advisor.md`. Nothing is built.

1. Radical is defined as direct, not cruel. The verdict comes first, the agent may say the person is wrong, and the anti-try-hard law and the no-pickup-artist rule stay in force.
2. The stance is one explicit list of beliefs in shared constants (the man pays on a first date, whoever invites plans, and so on). It is rendered per side, as a norm for men and as permission for women. It is not a second persona.
3. «The man pays» is a voice for an existing mechanic: the date gate already lets only a male user pay for both tickets. It is not a new product rule.
4. `voice-and-tone.md` §5 «never pushy» for men is narrowed to «never pushy about the product». This edit waits for the founder's answer on bluntness (spec open question 2).
5. The advice dossier is a read-only tool on the user's own side only. It never carries the partner's decision or feedback (blind decision invariant).
6. Third-party correspondence from screenshots is read for the answer only and never stored. The other person did not consent.
7. Proactive messages fire on product events only, with a frequency cap, quiet hours and a back-off after two ignored messages. The demo bot sends none by default.
8. Danger and distress switch the radical voice off. Manipulation, tracking or pressure on someone else is never helped.
9. Open for the founder: same-sex payer (default: whoever invited), bluntness ceiling, proactive cap (default 3 days), demo proactive (default off), where the softer/harsher hint lives (default: profile summary, no schema change).
