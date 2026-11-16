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

# 2026-11-16 — the agent reacts to shared videos, knows the trends, and proposes videos

The founder asked for an agent that gives emotional relief, knows trends such as looksmaxxing and aura farming, reacts to a shared TikTok with its own radical take, and later sends people videos picked for them. The specification is `docs/product/domains/agent-video-takes.md`. Nothing is built.

1. Today the chat agent cannot see shared videos on either surface. A link reaches the model as bare text with no reader, and a Telegram video without a caption never reaches the agent. The share-sheet and Profiler readers exist, but chat uses neither.
2. Phase 1 pre-reads the first video link in a turn with the share sheet's `readSharedVideo`. The result goes in as an untrusted block, and the agent answers with the advisor's shape. The depth stays at cover, caption and author (the 2026-10-24 decision). The agent says what it actually saw, and a closed read produces a question, never invented content.
3. Radical applies to the content, never to a body. There are no looks ratings or comparisons, and `scoreLeague` is never surfaced. The agent opposes harmful looksmaxxing practices and argues with the blackpill frame. Signs of distress about looks switch the conversation to the advisor's safety mode. These red lines ship with phase 1.
4. Trend knowledge comes from a glossary in shared constants, injected on demand. A weekly cloud routine drafts updates and the founder approves them in the work bot. Entries unchecked for 60 days drop out. There is no live web search per turn.
5. Discovery starts with a curated list in shared constants, Style Picks style: a link plus our own description, take and tags, with no rehosting. TikTok has no commercial search API, scraping is excluded on terms-of-service grounds, and Instagram hashtag search is not worth it. Videos are proposed only when asked for or inside a conversation. Proactive video sends wait for the advisor's proactive messages and then share their budget.
6. Founder answers: curated list first; a pool of user shares is wanted, with a threshold of at least three distinct sharers, safety and a founder-approved lead source, but only after a separate yes on its schema change; YouTube Data API only later and only as a curator's tool (new external API, needs a yes); reading video files (frames and audio) is deferred.
7. Demo mode: reactions, red lines and the glossary are identical; proposals come from the curated list only; nothing is sent proactively; demo shares never feed the pool.
