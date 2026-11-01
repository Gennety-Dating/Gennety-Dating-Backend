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

## Demo mode

Same code, flag off, so ideas do not appear in demo. When turned on there, synthetic data
only: nothing reads a real library.
