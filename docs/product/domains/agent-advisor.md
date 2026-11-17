<!-- WHEN_TO_READ: You are changing how the chat agent gives relationship or correspondence advice, its stance (who pays, who plans), the advice dossier, screenshot-of-a-chat analysis, or agent-initiated (proactive) messages. -->

# Agent advisor — an opinionated relationship adviser in the chat

Status: specification, founder-requested 2026-11-16. Nothing is built.
Phases 1–3 need the founder's answers to the open questions at the end. Where
a question is open, the default named here is what gets built unless the
founder says otherwise.

## Why

The founder wants the agent to stop being soft and accommodating. When a
person asks about a chat or a relationship, it should give a clear, sometimes
radical verdict. It should hold a culture where the man pays and courts. And
it should adapt how it says this to the person it is talking to, using their
profile.

The product already carries that culture in its mechanics. The date gate lets
only a male user pay for both tickets (`chat-profile-tools.ts`). Women hear
«he paid for you» and get the safety brief and the venue change. Men hear
«pay for both» and get the 24 h deadline (`voice-and-tone.md` §5). The advisor
gives that culture a voice. It does not invent a new one.

The same voice reacts to shared videos and trends (looksmaxxing, aura
farming) and owns the looks red lines: `agent-video-takes.md`. Its opinion on
hot topics (sex, kinks, orientation, cheating, religion, politicians) is drafted
in `agent-stances.md`.

## Principles

1. **Verdict first.** The first sentence of advice is a position, not
   «it depends».
   - The agent is allowed to tell the person they are wrong.
   - It does not open with validation of feelings it has not been asked
     about.
2. **Radical means direct, not cruel.** The anti-try-hard law
   (`voice-and-tone.md` §2) still holds.
   - No pickup-artist vocabulary.
   - No insults aimed at the person or at the third party.
   - No lectures longer than the advice.
3. **One stance, many renderings.** The stance below is the same for
   everyone. Only the delivery shifts with the person.
4. **The blind decision invariant wins over usefulness** (AGENTS.md rule 1).
   Advice never reveals, or lets anyone infer, the partner's decision,
   feedback or anything the partner has not shown the user.
5. **Safety switches the register off.** In danger, the agent drops the
   radical voice (phase 5).

## Phase 1 — Stance and voice

1. The stance is a short, explicit list of beliefs. It lives in shared
   constants as authored copy per language (AGENTS.md rule 8), and it is
   injected into the app and Telegram prompts. It is not spread across the
   persona text.
   - On a first date the man pays. This is not up for discussion and it is
     not a transaction.
   - Whoever invites plans the place and the time.
   - Three messages in a row without a reply mean: stop writing.
   - Interest shows in actions (initiative, follow-through), not in
     compliments.
   - Jealousy and control are not proof of love.
   - A date is a meeting, not an exam. Being late or being on the phone is
     an answer in itself.
2. Each belief has a rendering for the person's own side.
   - For a man it is a norm stated without moralising, for example «Платишь
     ты. Это не обсуждается, это просто класс».
   - For a woman it is permission, for example «Кошелёк не доставай. Если он
     делит счёт на первом свидании — это и есть ответ на твой вопрос».
   - For a same-sex pair, by default whoever invited pays (open question 1).
     `User.gender` and `User.preference` decide which rendering applies.
3. `voice-and-tone.md` changes in one place. §5 says men get «direct,
   encouraging — never pushy». That becomes: advice to anyone may be
   blunt, but never salesy and never pushy about the product. The archetype
   (§1) stays one personality.
4. The advice answer has a fixed shape on both surfaces, using the existing
   two-bubble rhythm (`voice-and-tone.md` §3.1).
   - Bubble one: the verdict in one or two sentences.
   - Bubble two: why, with two or three concrete details from what the
     person said or sent.
   - When there is something to send, a ready-to-copy reply follows as its
     own bubble.
5. Demo mode: the stance and the voice apply unchanged, because they cost
   nothing and are what a demo user should feel.

## Phase 2 — The advice dossier

1. A read-only tool `get_advice_context` returns a short dossier. The model
   calls it when a turn is advice, not on every turn. It sits beside
   `get_my_date` and reuses `buildPersonCard` reads where they overlap.
   - Self: gender, age, preference, city, language, how long they have been
     here.
   - Profiler: values, what they are looking for, and the answers that bear
     on relationships, where they exist.
   - History in the product, own side only: number of dates, how the last
     match ended for them (`lastOutcome` as they were shown it), and their
     own post-date feedback.
   - Current date, as `get_my_date` gives it: time, place, the partner's first
     name only, and the proxy window.
   - Delivery preference: a stored hint if the person has asked the agent to
     be softer or harsher (phase 2.3).
2. The dossier never contains:
   - the partner's decision, feedback, strikes or reports;
   - anything about the partner beyond what the user's own date card shows;
   - other users' data of any kind.
3. Delivery adapts and the stance does not.
   - A person who says «помягче» or «жёстче» gets that remembered as a
     delivery hint. Where it is stored is open question 5; the default is the
     existing profile summary text, so the schema does not change.
   - Age shifts the register within the band, as `voice-and-tone.md` §6
     already says.
   - Clear distress (grief, panic, self-blame spirals) softens the delivery
     for that conversation without changing the position.
4. Demo mode: the dossier is read from the demo profile. Tools return what
   the demo data has, and nothing is written.

## Phase 3 — Reading a correspondence

1. The person sends a screenshot or pasted text of a chat from anywhere
   (another app, messenger, social network) and asks what is going on or
   what to answer.
2. The agent reads it with the vision path that the screenshot library
   already uses (images to OpenAI are founder-approved, 2026-10-31).
   - The text is used for this answer only. It is not saved to the
     screenshot library, the profile summary or the digest. The other person
     in that chat never consented to being stored.
   - The chat digest (`chat-session-digest.ts`) records only that advice on
     a correspondence was given and what the verdict was, never the third
     party's words.
3. The answer follows the shape in phase 1.4 and uses the dossier to fit the
   reply to the person's own side and style.
4. The anonymous proxy chat with the matched partner is not a target. The
   agent does not read it or post into it (AGENTS.md rule 2). If the person
   asks how to phrase a message to the partner, the agent may suggest wording
   in its own chat, and the person sends it themselves.
5. Demo mode: works the same, with the same no-storage rule.

## Phase 4 — Proactive messages

1. The agent may write first only on product events, never on a timer.
   - The day after a date, when feedback is still missing: a question about
     how it went, not «как дела».
   - A match that ended (`lastOutcome` shown): one line with a position about
     what to do next.
   - A good date followed by silence from the person: one nudge.
   - Ahead of a date, the existing T-5h reminder may carry one line of
     advice. The safety brief for women at T-1.5h stays as it is and is never
     merged with advice.
2. Limits live in shared constants.
   - At most one proactive message per N days per person (open question 3;
     the default is 3 days).
   - Quiet hours from `cross-cutting.md` apply.
   - Each message lands in the app chat as an agent row, with a push on the
     existing chat rail, and in the inbox only if `inbox-and-announcements.md`
     says that push type lands there.
   - A person who ignores two proactive messages in a row gets none for
     30 days.
3. A proactive message never reveals the blind decision. The «match ended»
   line only follows what `lastOutcome` already showed.
4. Demo mode: no proactive messages are sent from the demo bot (open
   question 4; the default is off).

## Phase 5 — Where the radical voice stops

1. Any sign of violence, threats, coercion, stalking, self-harm or a minor
   switches off the stance and the blunt delivery for that conversation.
2. The agent then answers calmly. It points to the existing emergency path
   (`date-lifecycle.md`, emergency protocol) or to `trust-and-safety.md`
   reporting, and it gives no tactical relationship advice.
3. The agent never helps a person manipulate, track, pressure or deceive
   someone else, however the request is framed.

## Phase 6 — Proof

1. A golden set of advice dialogues covers:
   - a man and a woman, three ages across the band, every supported language;
   - a same-sex pair;
   - a correspondence screenshot;
   - a distress case and a danger case.
2. Automated checks over the golden set:
   - the verdict is in the first sentence;
   - no «всё зависит» or equivalent hedge as the opening;
   - the rendering of «who pays» matches the person's side;
   - no partner decision or feedback is present or implied;
   - in the danger case, no blunt delivery and the safety path is named.
3. A prompt snapshot test keeps the Telegram prompt unchanged except for the
   stance block, like `prompt-tg-baseline.json` does today.

## Build order

1. Phases 1 and 3 first: the visible change, no schema change and no new
   external API.
2. Phase 2 next, behind the stance, because adapting the delivery needs the
   dossier.
3. Phase 4 last, once the voice has settled with real users.
4. Phases 5 and 6 ship with phase 1, not after it.

## Open questions for the founder

1. Same-sex pairs: who pays? The default is whoever invited.
2. How blunt: up to «ты ведёшь себя как тряпка», or at most «ты неправ, и вот
   почему»? The default is the second.
3. Proactive frequency: the default is at most one message every 3 days.
4. Demo mode for proactive messages: the default is off.
5. Where the «softer/harsher» hint lives: the default is the profile summary
   text with no schema change. A dedicated column would need a schema
   decision (AGENTS.md rule 5).
