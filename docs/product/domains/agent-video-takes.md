<!-- WHEN_TO_READ: You are changing how the chat agent reacts to a TikTok / Reels / YouTube link or video a user sends, the agent proposing videos to a user (discovery, the curated video list, the shared pool), the trend glossary, or the agent's red lines on looks, looksmaxxing and body image. -->

# Agent video takes — reacting to shared videos, proposing videos, knowing the trends

Status: founder-agreed 2026-11-16. Phases 1–4 are built behind
`AGENT_VIDEO_TAKES_ENABLED` (default on) and not yet deployed; the weekly
trend routine (phase 3.5) is not set up yet. Phases 1–4 need no schema change
and no new external API. Phases 5 and 6 each wait for an explicit founder yes
(AGENTS.md rule 5).

## Why

The founder wants the agent to give people emotional relief. It should be in
the know about what people watch now, including looksmaxxing and aura farming.
When a person sends it a TikTok or another video, it should react to that
video specifically and give its own radical opinion. Later it should send
people videos it thinks they would like, picked for them personally.

This builds on the advisor voice (`agent-advisor.md`). It is the same
Gennety, with the same verdict-first stance and the same safety switch. It is
not a second persona.

## What exists today (2026-11-16)

1. The chat agent cannot see shared videos.
   - In the app chat (`/v1/me/chat`, `services/chat-agent.ts`), a TikTok,
     Reels or YouTube link reaches the model as plain text. No tool reads it
     and nothing reads it in advance. So the model either says it cannot open
     the link or invents what is in it.
   - App chat attachments are images only (`imageUrls`). There is no path for
     a video file.
   - In Telegram (`handlers/menu/router.ts` → `services/menu-agent.ts`), only
     `ctx.message.text` reaches the agent. A video message without a caption
     never reaches it, and a link is plain text, as in the app.
2. Two readers exist, but chat uses neither.
   - `services/share-video/read.ts` serves the iOS share sheet (decision
     2026-10-24). It handles TikTok, Instagram and YouTube. It reads the cover,
     caption and author in one vision call and keeps an in-memory cache.
   - `services/short-video/*` serves the Profiler. It handles TikTok and
     Instagram, with a persistent cache in `ShortVideoAnalysis` that carries
     no user.
3. Both readers see only what a logged-out browser is served: no frames, no
   audio, no download. That depth was decided with the founder on 2026-10-24
   and stays.
4. A curated, tagged catalog matched to the person's digest already exists in
   Style Picks (`packages/shared/src/style-picks.ts`). The video list in
   phase 4 follows the same pattern.

## Principles

1. **The take is about the content, never about the person's body.** Radical
   means a clear position on a trend, a practice or an idea. It never means a
   verdict on how someone looks.
2. **Honest depth.** The agent says what it actually saw («по обложке и
   подписи…»). It never pretends to have watched a video it has not.
3. **One persona.** The advisor stance, the two-bubble shape and the safety
   switch apply unchanged (`agent-advisor.md` phases 1 and 5).
4. **Linking, not rehosting.** The product shows a link or the platform's
   official embed. It never downloads, stores or re-serves another
   platform's video.
5. **No mass collection.** Reading a link a person chose to send is a link
   preview. Crawling a platform is out (phase 4.1).

## Phase 1 — Reacting to a shared video in chat

1. Before the agent turn, on both surfaces, the server looks for a link the
   share sheet already recognises (`classifyShareVideoUrl`: TikTok,
   Instagram, YouTube). If the message has one, the server reads it with
   `readSharedVideo`.
   - At most one video per turn: the first link.
   - The read reuses the share sheet's cache and rate limiter. A link already
     read costs nothing.
2. The result enters the prompt as an untrusted block (`ai/untrusted.ts`):
   platform, author, the title, the summary and the cover description. The
   caption is third-party text and never counts as an instruction.
   - When the read is `closed` or fails, the block says so. The agent then
     asks what is in the video instead of guessing.
   - The model is never left with a bare URL and no block.
3. The reply has the advisor shape (`agent-advisor.md` phase 1.4).
   - Bubble one is the take: a position on what the video shows or promotes,
     in one or two sentences.
   - Bubble two is why, and what it means for this person. It uses the
     profile the agent already has and, once it exists, the advice dossier.
     Where it fits naturally, it ties back to dating, but this is not forced
     every time.
   - When the read found an item or a place, the existing wishlist card may
     follow, on the rules it already has.
4. Telegram also passes the caption of a video or link message to the agent.
   A video file without a link gets one line: send the link, or say what is
   in it. Reading video files is phase 6.
5. The digest (`chat-session-digest.ts`) records only the topic and the take,
   for example «прислал ролик про мьюинг, позиция: осанка да, челюсть нет».
   It never records the author's name or the caption text.
6. Demo mode: works the same, with the same cache and rate limit. A demo
   user's shares never feed anything shared (phase 5).

## Phase 2 — Red lines on looks

These ship with phase 1, not after it.

> **Changed 2026-11-21 (founder, variant C).** In the app chat a photo the
> person sent may be rated in numbers — aura, attractiveness, swag gap with
> who mogs whom, partner included — but only through the vibe card
> (`agent-vibe-cards.md`). Rules 2–4 and the internal-factor rule below stay;
> rule 1 still holds everywhere else (no rating in words, no photo, Telegram).

1. The agent never rates anyone's appearance.
   - No numbers, tiers or scales (PSL, «3/10», «mog», «sub-5»), for the person,
     the people in a video or the partner.
   - No comparison with the partner or with other users.
   - The internal attractiveness factor used for matching (`scoreLeague`, the
     `attractivenessBalance` line in `agent-insights.ts`) is never named,
     hinted at or turned into a verdict about looks.
2. The agent is firmly against practices that harm the body, and says so as a
   take, not a lecture.
   - Bone smashing and any self-inflicted face or bone «remodelling».
   - Extreme dieting, cutting and fasting for looks.
   - Steroids, peptides, SARMs or hormones without a doctor, and do-it-yourself
     injections.
   - Pushing cosmetic surgery as the answer to dating.
   - The «blackpill» frame (looks decide everything, so do not try). The agent
     argues with it directly.
3. The agent supports what actually helps, framed as for the person and not
   for a ranking: grooming, skincare basics, a haircut, how clothes fit,
   posture, sleep, training, good photos.
4. Signs of self-hatred about looks, disordered eating or body dysmorphia
   switch the conversation to the advisor's safety mode (`agent-advisor.md`
   phase 5). The agent becomes calm and gives no tactics. It suggests
   talking to someone they trust or to a doctor or psychologist, and, if the
   person may be in danger right now, their local emergency number. The
   product has no vetted list of help lines yet, so the agent never names a
   hotline number; a vetted list per market is a follow-up.
5. The red lines are authored once, in shared constants
   (`packages/shared/src/agent-takes.ts`, `LOOKS_RED_LINES`). Like every other
   model instruction in the product they are written in English; the person
   hears them in their own language through the reply. They are injected on
   both surfaces after the base prompt, so the Telegram base prompt stays
   byte-identical.
6. Demo mode: identical.

## How the agent knows what is cringe, which memes fit, and what is relevant

The founder asked how the agent will tell cringe from good, share memes, know
what fits a particular person, and keep up with trends. The answer is that
none of it is left to the model's general taste.

1. **Cringe or not is a written taste, owned by the product.**
   - `TASTE_CANON` in shared constants says what Gennety reads as cringe:
     try-hard, pickup-artist and alpha-grindset content, engagement bait,
     fake-deep, looks-as-destiny content.
   - It also says what Gennety reads as good: self-irony, real skill shown
     plainly, specific over polished, effortless confidence, kindness that is
     not performed.
   - The agent judges the content, never the person who made it or sent it.
     A mixed video gets «this part works, this part does not».
   - The canon goes into every turn on both surfaces. Changing the product's
     taste is an edit to one constant, reviewed like any other.
2. **Each trend comes with its own verdict.** A glossary entry carries
   Gennety's take, so the verdict on a trend such as mewing or aura farming
   is a position the founder approved, not a guess.
3. **Memes.**
   - A meme the person sends as a picture already reaches the agent through
     vision, in the app chat and in Telegram.
   - A meme video sent as a link goes through the phase 1 read.
   - The taste canon and the glossary decide the reaction.
   - The agent does not make memes and does not invent links. Memes it
     proposes come from the curated list (phase 4), where every entry is a
     verified link with our own words.
4. **Relevance for a particular person** comes from three signals, strongest
   first.
   - The moment: what the conversation is about right now (nerves before a
     date, after a rejection, doubting their looks, bored). The model passes
     it to `suggest_video`.
   - The topic of the conversation, as tags from a fixed vocabulary.
   - The person's interests: `Profile.hobbies` is free text in five
     languages and is mapped to the same tags by stems
     (`VIDEO_TAG_KEYWORDS`).
   - The person's language comes before English, and a video already sent is
     never sent again.
   - A candidate with no overlap is not offered. A random video is worse than
     none.
5. **Keeping up with trends** is the glossary, with entries dated and
   expiring after 60 days, refreshed weekly through phase 3.5. The model's
   own memory is never the source.

## Phase 3 — The trend glossary

1. The model's memory lags months behind what people watch. The agent's
   trend knowledge comes from a glossary, not from the model.
2. The glossary lives in shared constants (`TREND_GLOSSARY`). The meaning and
   the take are model guidance in English. The spellings are per language,
   because they are what people type. Each entry carries:
   - the term and its spellings (for example looksmaxxing, лукс-максинг, aura
     farming, «фарм ауры»); a trailing `*` marks a stem that matches every
     inflection;
   - what it means, in one or two sentences;
   - Gennety's take, as a short position the agent may voice;
   - the red line, where one applies (phase 2);
   - the date the entry was last checked.
3. The relevant entries are put into the prompt on demand. When the message,
   or the video read from phase 1, names a glossary term, only those entries
   are injected. The whole glossary never goes in.
4. Slang in the glossary is there so the agent understands people. The agent
   may use it rarely and with irony. The anti-try-hard law
   (`voice-and-tone.md` §2) holds.
5. Keeping it fresh (not set up yet; the delivery path to the work bot needs
   the founder's choice):
   - Once a week, a scheduled cloud routine researches current trends and
     drafts changes: new terms, updated takes, and entries to retire.
   - It sends the draft to the founder in the project's work bot. Nothing
     changes without the founder's approval.
   - Approved changes are committed to the constants and ship with the next
     deploy.
   - A second, free signal is the topics people shared in the past week
     (phase 1 reads, counted in aggregate, never per person). It goes into
     the same weekly draft.
   - Entries not checked for 60 days drop out of the prompt until they are
     confirmed again.
6. The agent does no live web search per turn. It is slow, costly and gives
   unvetted takes.
7. Demo mode: identical.

## Phase 4 — Proposing videos from a curated list

1. Sourcing, with honest limits.
   - TikTok has no public search API for a commercial product. Its Research
     API is for non-profit researchers, and its Display API returns only the
     user's own videos. Showing a known link or its official oEmbed is fine.
     Searching is not.
   - Scraping TikTok or Instagram search is against their terms, breaks
     often, and gets server addresses blocked. It is excluded.
   - Instagram's hashtag search needs a business account and app review,
     with tight caps. It is not worth it for this feature.
   - So the first source is a curated list that the product's own people
     choose.
2. The curated list lives in shared constants, like the Style Picks catalog.
   Each entry carries:
   - the platform and the canonical link;
   - our own one-line description and our own take;
   - tags from a fixed vocabulary that overlaps the profile's tags
     (interests, Type Radar archetype, Style Picks tags, relationship
     stage);
   - language and market, where they matter;
   - the date it was added.
   It stores no copy of the video, no frames and no caption.
3. The weekly glossary routine (phase 3.5) also proposes list candidates.
   The founder approves them in the same message.
4. Matching is a prefilter by tag overlap with the person's profile and
   digest, followed by the model picking at most one. Videos the person was
   already sent are excluded.
5. When a video is proposed:
   - when the person asks («скинь что-нибудь», «что сейчас смотрят»);
   - inside a conversation, when it fits, for example nerves before a date or
     a looksmaxxing question that a good video answers better;
   - at most one per conversation unless the person asks for more.
6. The agent does not message first with a video in this phase. Proactive
   video drops wait for the advisor's proactive messages
   (`agent-advisor.md` phase 4) and then share that same budget. There is no
   separate timer.
7. Delivery: a link with a one-line take in the agent's voice. In the app,
   the link opens the platform. An inline embed is a client decision for
   later.
8. What the person does with it (opens it, says they liked or hated it)
   becomes a delivery hint in the digest, the same way the advisor's
   «softer or harsher» hint works. It needs no new storage.
9. Demo mode: proposals come from the curated list only, with no proactive
   sends.

## Phase 5 — A pool from what people share (needs the founder's yes)

1. Videos people send in chat or through the share sheet could become a
   second source of the curated list.
2. A video enters the pool only when:
   - at least three different people sent it, so no one can learn that a
     particular person in their city sent a niche clip;
   - the vision read marked it safe, and it passes the phase 2 red lines;
   - it was not sent from the demo bot.
3. Pool entries do not go out to people directly. They go into the weekly
   draft, and the founder approves them into the list. The pool is a lead
   source, not a feed.
4. A persistent store of share counts per video needs a schema change: a
   share count on a table like `ShortVideoAnalysis`, or a new table. That is
   a founder decision under AGENTS.md rule 5. Until then, phase 3.5 counts
   topics only, in memory.

## Phase 6 — Later options (each needs the founder's yes)

1. **YouTube Data API as the curator's tool.** It is a legal search,
   including Shorts. The free quota is small, roughly a hundred searches a
   day. It is a new external API (AGENTS.md rule 5). If it is approved, it
   feeds only the weekly draft, never a live search per user. Check the
   quota and terms again before building.
2. **Reading the video file itself.** A person uploads the video, or a
   screen recording of it. The server samples frames and transcribes the
   audio through OpenAI, the already approved provider, for a real take on
   what was said. This costs more per turn and needs a video upload path on
   both surfaces.
3. **Inline embeds in the app chat**, using the platform's official embed.
   This is iOS client work.

## Proof

1. A golden set of dialogues covers:
   - a looksmaxxing video, an aura farming video and a video with a harmful
     practice (bone smashing);
   - a link the reader cannot open;
   - a person asking to be rated;
   - a distress case about looks;
   - a request for a video;
   - every supported language.
2. Automated checks over the golden set:
   - the take is in the first sentence;
   - no rating, score or comparison of looks appears;
   - the harmful practice is opposed;
   - a closed read produces a question, not invented content;
   - the distress case switches to the safety mode;
   - `scoreLeague` and the attractiveness factor never appear.
3. Unit tests cover:
   - link detection in chat on both surfaces;
   - the untrusted block;
   - glossary injection on demand;
   - dropping entries older than 60 days;
   - excluding a video already sent.

## What is built (2026-11-16, not deployed)

1. The shared module is `packages/shared/src/agent-takes.ts`. It holds:
   - `LOOKS_RED_LINES` and `TASTE_CANON`;
   - `TREND_GLOSSARY`, with stem matching and the 60-day expiry;
   - `CURATED_VIDEOS`, with the tag and moment vocabulary and
     `pickVideoCandidates`.
2. The bot module is `apps/bot/src/services/agent-video-takes.ts`.
   - `videoTakeBlocks` adds the taste, the red lines, the video rules, the
     shared-video block and the trend block to every agent turn.
   - The video link is looked for in this message and the two before it, so
     a follow-up question still has the video. The read reuses the share
     sheet's reader and its cache.
   - `suggest_video` is a read-only tool. Both surfaces run it through
     `executeAgentTool`.
3. The app chat (`chat-agent.ts`) and Telegram (`menu-agent.ts`) append the
   blocks after the base prompt, so `prompt-tg-baseline.json` is untouched.
4. In Telegram, a video message's caption now reaches the agent. A video file
   with no words gets `agentVideoNeedsLink`.
5. The chat digest prompt records only the topic and the take for a shared
   video, never the link, the handle or the caption.
6. `AGENT_VIDEO_TAKES_ENABLED=false` turns all of it off on both surfaces.
7. The seed data is checked as of 2026-11-16:
   - 31 glossary entries, from sources dated October–November 2026;
   - 17 YouTube videos, each verified through oEmbed (title and channel
     match). Nobody watched them end to end, so their takes stay modest.

## Build order

1. Phases 1 and 2 together: the visible fix, with the red lines in place
   from day one.
2. Phase 3: the glossary and the weekly draft with founder approval.
3. Phase 4: the curated list and proposals inside conversations.
4. Phases 5 and 6 only after the founder's explicit yes, each on its own.

## Decided with the founder (2026-11-16)

1. Discovery starts with the curated list only. YouTube Data API is a later,
   curator-only option.
2. The pool from user shares is wanted in principle. It is built only after
   a separate yes on its schema change.
3. The agent does not message first with a video until the advisor's
   proactive messages exist. After that, it shares their budget.
4. The weekly routine drafts the glossary and the founder approves it.
   Nothing changes automatically.
5. Reading video files is deferred to phase 6.
