<!-- WHEN_TO_READ: You touch ideas: what a person wants, why they saved it, where it may be used, their sources, or anything reading those (planning, overlaps, matching, Style Picks, reminders, the morning after). -->

# Ideas: what a person wants

Founder brief of 2026-11-01. Decision: `docs/architecture/decisions/2026-11-01-memory-ideas.md`.
Behind `MEMORY_IDEAS_ENABLED`, off by default. The path it serves is: saved, understood,
confirmed, chosen, planned, tried, refined.

## What is what

A source is what was saved: a screenshot, a link, words in chat, a manual save or a
wishlist position. An idea is the thing itself. The intent says where the person stands.
A confirmed preference is something they said about themselves. A plan is one date. An
impression is what they felt after it. Those are separate tables or columns, and no one
of them becomes another without the person.

A model's reading stays on the screenshot. The idea's reason, recipient and uses are only
ever written from the person's answer.

## Identity

Two sources join by themselves only on a catalog place, a catalog key or a canonical link.
A name is not an identity: «Роза» in two cities stays two ideas, and the same words in one
city come back as `candidates` for the person to decide. A wrong join is undone with
`split`: the sources move out and the new idea starts with no uses, because a grant was
given to the idea they were wrongly part of.

## Intent

`interested`, `want`, `planned`, `tried`, `dropped`. Only a real plan sets `planned`, and a
cancelled plan restores the earlier intent. Dropping a wish does not cancel a booked date.
`tried` is what the person said; it proves no visit and no purchase.

## Uses

Personal search needs no grant and has no switch. Three uses are granted one by one, are
checked on the server and are read live by each consumer: own dates, matching, showing to
a partner through the existing wishlist. Connecting Photos grants none of them. «Только для
меня» is the absence of all three. Only the person can turn one on; a gift or a reference
cannot be turned on until that mark changes. Turning one off, and deleting, work with the
flag off as well.

The rules live in `packages/shared/src/memory-ideas.ts` (`usableForOwnDates` and friends),
so a consumer never reads a raw column.

## Lifecycle

Deleting one source leaves the idea while another source states it. Deleting a screenshot
takes its source with it, and an idea with nothing left closes. Disconnecting the library
does this for every screenshot, so no hidden copy survives as personalisation. Closing an
idea clears its text, cancels its reminders and revokes preferences that came from it. A
wishlist position has its own delete and stays. A catch-all sweep in `workers/memory-ideas.ts`
covers screenshots hidden by a path that knows nothing about ideas. Account deletion cascades.

Each change writes a history row in one transaction, and a repeated `Idempotency-Key`
returns the idea as it stands.

## In chat

`services/chat-memory.ts`. Reading and narrowing run at once. Saving, changing a meaning,
widening a use, confirming a preference and deleting pass `personConsented` in its strict
form, which reads only the person's last message and refuses when it cannot answer.
Screenshot text, a link and the assistant's own words never count as a yes. The agent finds
an idea first, asks when several match and tells the deletion scope before deleting.

A finding becomes an idea through `save_idea` with `screenshotId`; kind and title come from
the screenshot unless said otherwise (item is gift, media is culture, text and other are
note, the rest keep their name). After showing something saved the agent may ask one short
question: «Хочу сюда / Нравится атмосфера / Идея для свидания / Просто сохранить», which are
`this_place`, `atmosphere`, `date_idea` and `reference`. A reason and a recipient come only
from the person's words; the consent check says so. A skipped question on a saved idea is
`skip_idea_question` and is not asked again for ten years, unlike the app's «позже». A question about
a screenshot not yet saved has no row to remember it; the prompt asks not to repeat it, and the code does not enforce that.

`check_event` with `idea_id` writes the verdict to the idea: a single confirmed day as
`confirmed`, outdated as `outdated`, no source as `unknown`. An outage or a limit writes nothing.
A run of several days becomes `unknown` with no date, because one date would rule out its other
days; it reads as `needsCheck`, and is checked again next time. The check is also offered with ideas on and the library card off.

`planning_ideas` reads the current pair's `planningSuggestions`, a booked date first. It passes no
city: ideas keep a city as written, in any language, and a spelling is not a known mismatch. The
suggestion carries `city`, and the agent is told to check it, which is an instruction, not a filter. It books and moves nothing.

`confirm_preference` refuses, on every path, words about allergies, diet, health, beliefs,
politics and sexuality, by an explicit list in five languages (`isSensitivePreference`, 422
`sensitive-value`). A list is not a classifier: it over-refuses («без алкоголя») and can miss a
paraphrase, so the prompt rule stays. A confirmed `experience` or `ambience` that is one of the venue
ids orders planning suggestions by the catalog's tags and adds or orders the first chips of a venue
intent. `format` is kept but changes neither. Nothing here touches hard constraints or the final selection.

`GET /v1/me/memory/vibe-question` asks once two or more saved moods or activities exist and that
facet is unanswered: ambience if at least half are moods, else experience, then the other. Options
are the venue ids in five languages. The answer is `POST /preferences`; matching stays a separate grant.

Adding to the wishlist stays the card. An item may name its `ideaId`; the tap adds a wishlist source to
that idea, or makes a new idea when none is named. Removing the position calls `dropWishlistSource`,
with the flag on or off. An idea with reason `gift` gets a card only after the strict consent check on
the person's last message. Wishlist rules and the paid sheet are untouched.

`use_style_reference` marks a saved look `style`. Only kind `outfit`. Style Picks reads the words live,
and the set's cache key holds the digest, so the next read regenerates.

`record_impression` writes place, format and repeat after a date the person confirmed going to, and
answers with `next`, their allowed untried ideas. The person goes to the existing `record_date_feedback`.
Nothing of it reaches the partner, and blind rules are not touched.

## Where ideas reach

`services/memory-planning.ts`. Everything reads the grants at call time and nothing is cached,
so revoking takes effect on the next read.

- Venue board: a wanted place moves a few positions in the viewer's order. The set stays the
  pair's, as `venue-change-personalization.ts` requires. A suggestion never books, pays, or moves
  a date; a change still goes through the existing board.
- Planning (`GET /v1/me/memory/matches/{id}/planning`): allowed wishes minus a known mismatch in
  city, date or check. An unconfirmed date comes back as `needsCheck`. Unknown never excludes,
  and it is never told as a fact.
- A pair's overlap: same place or same `topic`, from ideas both sides allowed, after both said
  yes, with no block either way. The viewer gets their own title back. An empty answer reads the
  same whatever the cause.
- Map: the person's points where the catalog knows the place, and the rest listed without a point.
  It is its own read, separate from frequent places and the date map, and counts no visit.
- Matching: a confirmed preference with its own grant joins the embedding input as one short
  line, via `embeddingDirty`, so a revocation is out of the next vector. Hard filters run before
  any of this, and the pitch does not read these rows. No quality gain is claimed: not measured.
- Style Picks: looks marked `style`, as words. No image and no one's body. The digest hash
  changes with them, so the cached set follows.
- A date's memo: the owner's only. Weather, dress code and opening hours are not in it. The
  briefing's own visibility gate is untouched. Health data is not read here at all.
- After a date: `reconcilePlans` ties an idea to a real scheduled date and restores it after a
  cancellation. Only a visit the person confirmed allows an impression, and only that sets
  `tried`. Place, format and repeat are separate, nothing says anything about the partner,
  «не хочу оценивать» counts as an answer, and a later answer corrects it.
- Reminders: only for an idea with a date, at most one per occasion, one push a day per person,
  held in quiet hours, claimed before sending. The idea is re-read at send time, so a dropped
  wish, a moved date, a revoked use or a block ends it without a push.

## Demo mode

Same code, flag off, so ideas do not appear in demo. When turned on there, synthetic data
only: nothing reads a real library.
