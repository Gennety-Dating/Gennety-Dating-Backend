<!-- WHEN_TO_READ: You are changing Vibe Check (the iOS Shop's personal style picks) — the catalog, what the digest may read, the agent prompt, the "for you" and catalog badges, the cache, the outbound redirect, or the `stylePicks` flag. -->

## Vibe Check — personal style picks

The iOS Shop has a "Vibe Check" button. It opens up to six products (two
scents, two accents, two grooming items) chosen for this person by a dedicated
AI agent. Founder brief of 2026-10-08; the decision record is in the decision
journal (2026-10-08 — «Vibe Check»).

### Pipeline

1. **Digest, no model** (`apps/bot/src/services/style-picks/digest.ts`). The
   digest reads gender, preference, an age band, the photo-derived clothing
   `archetype` already stored in `appearanceTags`, the vibe axes (tempo,
   focus, social role, anchor tags without "music"), hobbies, the categories
   and vibe tags of places, the psychological summary clipped to 400
   characters, and up to five style-relevant Profiler answers.
   - Places are the venues of dates the person attended (the date map's
     source). Frequently visited places are added only while
     `STYLE_PICKS_FREQUENT_PLACES_ENABLED` and the person's own opt-in are both
     on (founder rule 2026-10-04). The digest reads categories and tags only,
     never a venue name or a day.
   - The digest never contains music from any provider, the Elo or
     attractiveness score or its seed details, the Health rhythm, a name, a
     contact, a photo or any id. `digest.test.ts` and `ai-boundary.test.ts`
     hold this.
   - A profile with no gender, or with fewer than two signals, gets no
     selection (204).
2. **Prefilter, no model** (`catalog.ts`). The prefilter keeps active products
   that fit the person's gender (unisex always fits). It ranks them by
   weighted tag overlap, where the archetype counts double. The shortlist has
   18 products, with at least 4 from each category.
3. **One model call** (`service.ts`, prompt `stylePicksPrompt` in
   `packages/shared/src/ai/prompts.ts`). The call uses `MODELS.agent` with
   strict JSON schema output. The input is about 1.5k tokens and the output
   about 600. The person's own text is fenced as untrusted data.
4. **Validation** (`validate.ts`). Validation drops unknown or repeated ids,
   keeps at most two picks per category, and clamps every string. Gaps are
   never filled. Fewer than three valid picks counts as a failure.
5. **Cache**. `style_pick_sets` keeps the latest set per person. The set is
   reused while the language and the hash of the digest plus shortlist are
   unchanged, for up to 7 days. A failed regeneration serves the last set.
   With nothing cached, the endpoint answers 204.

### Badges — the truth rule

- **`forYou`** is computed from the model's output and is never written by
  the model. A pick earns it with `fitScore >= 85` and
  `personalSignalCited = true`. At most two picks per set have it, the two
  highest scores.
- **`accolade` / `seenOn`** come only from `style_products.badges`. These
  are researched facts with a `sourceUrl`, written in five languages. The
  model is told never to invent awards, ratings or celebrities, and it has
  no way to emit a badge.
- The order on a card is `forYou` first, then the catalog badges in the
  person's language.

### Outbound links

`outUrl` points at `GET /v1/style/out/{itemId}?u&e&s&l`. The link carries an
HMAC over the user id, the item id and the expiry. Links last at least 7 days
and are rounded to a UTC day.

- A valid link writes a `style_clicks` row.
- An invalid or expired link still redirects but records nothing. A shopper
  is never blocked.
- The redirect adds `utm_source=gennety&utm_medium=app&utm_campaign=style_picks&utm_content=<category>`
  and the item's `affiliateParams`.
- A `uk` link goes to `urlUA` when the product has one.

### Catalog

The source of truth is `scripts/style-catalog.json`.
`pnpm seed-style:import` runs a dry run, and `pnpm seed-style:import --apply`
upserts on the slug. A product that leaves the file is deactivated, never
deleted. `catalog.test.ts` validates the file: tags must come from
`STYLE_TAGS`, links must be https, and every badge needs all five languages.

### Flag and privacy

`STYLE_PICKS_ENABLED` (default off) drives `features.stylePicks` in
`/v1/app/config`. While it is off, `GET /v1/me/style-picks` answers 204. The
flag should stay off until the privacy policy discloses this use. Policy v4.2
says appearance tags are used "only" for matching, and that there is no
advertising profiling (decision journal 2026-10-08).

### Demo mode

The demo bot shares the code. The flag is off there as well, so it shows the
same behaviour: no button, and 204.
