<!-- WHEN_TO_READ: You are designing or building Pinterest Connect — the read-only Pinterest OAuth link, the aesthetic profile it produces (palette, styles, interiors, fashion, place vibes), its use in matching / the agent / venue picks, its storage, disconnect and deletion, or Pinterest's API review. Status: DESIGN ONLY, nothing built, waiting for the founder's «да». -->

# Pinterest Connect — aesthetic taste from boards and pins

Status: design for the founder's approval, written 2026-11-22. Nothing is built.
Decision record: `docs/architecture/decisions/2026-11-22-pinterest-connect.md`.
Mockup: `docs/product/mockups/pinterest-connect.html`.

## What it is

A person may connect their Pinterest account with read-only access. Gennety
reads their boards and pins once, reduces them on the server to a short list of
coarse taste tags, and forgets the pins. The tags describe how the person likes
things to look: a colour palette, a few style families, what their boards are
about (interiors, fashion, food, travel and so on), and the kind of places they
save. The person sees the result on a «Твой вкус» card, can remove any tag that
is not them, and can disconnect, which deletes everything.

The tags are used in three places, all invisible to anyone but the owner: the
agent may lean on them when the person asks about style, an outfit or a place;
venue picks may lean toward places that fit both people; and matching may use
an aesthetic similarity factor whose weight starts at zero. The partner never
sees a tag, a swatch or a sentence derived from them.

The founder's reference is a connect sheet from another app. We copy its
structure (round close button, provider title and icon, «what it will be able
to do» with two allowed and one struck-through action, one pill button), not
its branding.

## What Pinterest allows and requires (researched 2026-11-22)

The pages on developers.pinterest.com and policy.pinterest.com did not load
from the cloud container that wrote this spec (the hosts are outside its
network allow-list). Every fact below comes from search-engine excerpts of
those pages and of third-party guides, read on 2026-11-22. Phase 0 re-reads
the primary pages before anything is built, and any difference wins over this
section.

1. **Access tiers.**
   - Trial access is the first tier. Several guides (2026) state that a Trial
     app can only be authorised by the Pinterest account that owns it, so only
     the founder's own Pinterest could be connected. Pinterest's rate-limit page
     sets Trial at 1,000 requests per day for the whole app.
   - Standard access opens the app to any user who authorises it. The upgrade
     needs an approved Trial app that follows the Developer Guidelines, and a
     screen recording of the app completing an action through the API. The
     review checks that users go through the OAuth flow properly and that no
     sensitive information is stored (Pinterest access-tier page, excerpt).
     The use case and privacy-policy link given at Trial are reviewed again.
     There is no published turnaround; community threads report days to weeks
     and denials for vague use-case descriptions.
   - No fee is published for either tier.
2. **OAuth and scopes.**
   - API v5 uses the OAuth 2.0 authorization-code flow. The `redirect_uri` must
     match a registered value exactly, and Pinterest's examples are https URLs.
     No source confirmed that a custom URL scheme is accepted as a redirect.
   - Read-only scopes: `user_accounts:read` (the account), `boards:read`
     (public boards, group boards included), `pins:read` (public pins). Secret
     boards and pins need `boards:read_secret` and `pins:read_secret`.
   - The scope string in the token response is what was actually granted and
     can differ from what was asked; the server stores the granted set.
3. **Tokens.**
   - Pinterest's token page says apps activated on or after 2025-09-25
     receive the continuous refresh token automatically: it expires after 60
     days and can be refreshed indefinitely. The legacy 365-day token is no
     longer supported.
   - The access-token lifetime was not in the official excerpts; third-party
     guides give 30 days. Guides say each refresh returns a new refresh token,
     so the server always stores the latest one.
4. **Rate limits.** Trial: 1,000 requests per day for all requests. Standard:
   100 requests per second per user per app overall, with stricter
   per-category limits per minute per user per app; the category numbers
   differ between sources, and Pinterest says every limit can change without
   notice. One connect costs about 5–15 requests (account, board pages, pin
   pages), far below either limit.
5. **Terms on using the data.** This is the gate for the whole feature.
   - The Developer and API Terms and the Developer Guidelines were revised with
     effect from 2026-08-18 (Pinterest developer newsletter, August 2026).
   - They forbid using Pinterest Data, copies and derivatives included, to
     build or improve AI or machine-learning models without Pinterest's written
     consent; the excerpt says an email suffices as written consent.
   - They forbid combining one person's account information with other
     people's accounts or with other services, «except as required to provide
     the specified services to our mutual customers», and joining Pinterest
     Data with personally identifiable information, direct identifiers
     included.
   - Third-party summaries say the guidelines forbid storing information
     obtained through the API, except campaign analytics. The official excerpt
     did not confirm this blanket rule, so it is treated as possibly true.
   - Scraping and automated extraction are forbidden unless Pinterest permits
     them, and a developer may not replace Pinterest's own consent screens.
   - Pinterest's Ad Data Terms (a separate policy, for ads data) ask for
     identifiable data to be deleted or anonymised within six months once there
     is no business need. They do not obviously apply here, but the design
     keeps well inside them.
   - Reading of the terms for this design: analysing one person's own pins, at
     their request, to show them and use for them a taste summary is a
     per-user inference, not model training, and it is the «specified service»
     the person asked for. It still derives data, links it to a Gennety
     account and stores it. That is close enough to the forbidden lines that
     Gennety asks Pinterest in writing before building (phase 0). This
     repeats the Spotify lesson: Spotify's policy forbids building user
     profiles, so music on the profile became display-only
     (`profile-music.md`).
6. **Mobile OAuth.** `ASWebAuthenticationSession` works with any OAuth
   provider that accepts a browser redirect. Because Pinterest's redirect is an
   https URL on our API host, the iOS app uses the pattern the Spotify import
   already uses: the session opens Pinterest's authorize URL, Pinterest
   redirects to our server callback, the server exchanges the code and ends in
   `gennety://pinterest-connect?status=…`, which the session catches with the
   callback scheme `gennety`. No Pinterest SDK and no client secret on the
   phone.
7. **Sources** (all read through search excerpts on 2026-11-22):
   - developers.pinterest.com: set-up-authentication-and-authorization,
     key-concepts/access-tiers, reference/rate-limits, api/v5/oauth-token,
     /terms (Developer and API Terms).
   - policy.pinterest.com: developer-guidelines, ad-data-terms.
   - community.pinterest.biz: Developer Monthly Newsletter, August 2026 (terms
     update effective 2026-08-18); «Upgrading from trial to standard».
   - github.com/pinterest/api-quickstart (scope list and defaults).
   - Third-party 2026 guides used only where marked: upload-post.com,
     blotato.com, activepieces.com, pinbridge.io, n8n community thread.

## Placement: recommendation

Two placements were compared: (A) an optional step in onboarding, and (B) a
connector in Settings and on the profile, like Apple Health (Tempo Sync).
**Recommended: B, plus one soft offer card after onboarding (a hybrid without
a new onboarding step).**

1. **Why not an onboarding step.**
   - Until Pinterest grants Standard access, only the founder's account can
     connect. An onboarding step would ship dead for everyone else.
   - Onboarding already carries the mandatory verification gate. Every extra
     screen before it costs completion, and a step that leaves the app for a
     Pinterest login costs more than an ordinary screen.
   - Many people, a large share of men, have no Pinterest. For them the step is
     a «skip» that teaches nothing.
   - The taste first matters at the first venue pick and the first match, days
     after onboarding, so collecting it earlier buys nothing.
   - The consent reads better in context («hey, this is what we do with it»)
     than in a stack of onboarding permissions, and Pinterest's review only
     needs the OAuth flow, not a particular screen.
2. **What B looks like.**
   - iOS Settings gets the «Pinterest» row in the same «Связанные сервисы» group
     as «Apple Health». Tapping it opens the connect sheet; once connected it
     opens the «Твой вкус» card.
   - The own profile shows a small «Твой вкус» block under «О себе», visible to
     the owner only, with a «Подключить Pinterest» link while not connected.
3. **The soft offer (the hybrid part).**
   - One card, shown once, after onboarding and verification are done, on the
     next app open where nothing more urgent is on screen. It says what the
     connection gives and opens the same sheet. «Не сейчас» hides it for good;
     the Settings row stays.
   - The agent may mention Pinterest once, only when the person asks about
     their style, an outfit or a date place and has not connected; never
     proactively.
4. **Revisit.** If the connection rate from Settings plus the card stays low
   after Standard access, an onboarding step can be reconsidered with data.

## Phases

### Phase 0 — permission from Pinterest (no code)

1. The founder registers a Pinterest business account for Gennety (if there
   is none) and creates the app in the Pinterest developer portal with the
   redirect `https://<api host>/v1/integrations/pinterest/callback`. The app
   id and secret go into the server's environment file only, never the repo.
2. The use-case text for Trial is written from this spec: read-only scopes,
   per-user taste summary shown to and used for that person only, no pins
   stored, no training, delete on disconnect.
3. Gennety emails Pinterest's developer support with the same description
   and asks for written confirmation that it is allowed under the
   2026-08-18 terms, specifically:
   - per-user inference with a vision model on the person's own pins, at
     their request;
   - storing only the derived coarse tags against the Gennety account, until
     disconnect or 60 days without a refresh;
   - sending pin images to a model provider that processes them without
     training (OpenAI API), as Gennety's processor.
4. The primary pages listed under «Sources» are re-read and this spec is
   corrected where they differ.
5. Exit: written consent from Pinterest, or a refusal. A refusal ends the
   feature (see «Rejected alternatives»).

### Phase 1 — connect, disconnect, tokens (backend + iOS)

1. **Flag.** `PINTEREST_CONNECT_ENABLED` (default off) drives
   `AppConfig.features.pinterestConnect`. Off means no Settings row, no card,
   no offer, and every route below answers 404. The switch covers reads too:
   with the flag off, no reader sees a stored profile.
2. **Routes** (proposed, mirroring `/v1/integrations/spotify/*` and
   `/v1/me/rhythm`; the contract goes into `openapi/gennety-v1.yaml` when
   built).
   - `POST /v1/integrations/pinterest/authorize` returns `{ authorizeUrl }`
     with scopes `user_accounts:read boards:read pins:read` and a signed,
     single-use `state` that expires after 10 minutes. PKCE is added if
     Pinterest supports it; the server is a confidential client either way.
   - `GET /v1/integrations/pinterest/callback` (public, Pinterest's redirect)
     checks the state, exchanges the code, stores the tokens, queues the first
     read, and redirects to `gennety://pinterest-connect?status=<status>`:
     - `ok` — connected, the read is running; the app shows «Смотрю твои
       доски…» and polls `GET /v1/me/aesthetic`;
     - `cancelled` — the person pressed Cancel on Pinterest's page;
     - `missing_scope` — boards or pins were not granted; nothing is kept;
     - `not_allowed` — Pinterest refused the account (Trial: not the owner);
     - `expired` — the state went stale or was replayed;
     - `failed` — anything else.
   - `GET /v1/me/aesthetic` returns the owner's view: `status` (`syncing`,
     `ready`, `empty`, `needs_reconnect`, `failed`), the visible tags, the
     swatches, `boardsRead`, `pinsRead`, `syncedAt`, `consentedAt`.
   - `POST /v1/me/aesthetic/refresh` re-reads now, at most once per 24 hours.
   - `PATCH /v1/me/aesthetic` hides or restores one tag («Это не про меня»).
     A hidden tag is never used anywhere and survives a refresh.
   - `DELETE /v1/me/aesthetic` disconnects: deletes the tokens, the profile
     and the hidden list at once, and asks Pinterest to revoke the token if
     Pinterest offers a revoke call. The person can also remove Gennety in
     Pinterest's own settings; the next refresh then fails and is treated as a
     disconnect.
3. **Token storage.**
   - Access and refresh tokens are encrypted with AES-256-GCM under a key
     held in the server environment (`PINTEREST_TOKEN_KEY`), never in the
     database in clear and never in logs. The repo has no such helper yet; it
     is one small module with its own tests.
   - Stored beside them: the granted scopes, the expiry times, the status,
     the last read time. Not stored: the Pinterest user id, username, display
     name, profile picture or email.
   - A monthly job refreshes the token and re-reads the pins, so a
     continuous refresh token (60 days) never lapses while the person is
     active. A failed refresh sets `needs_reconnect` and stops all reads.
4. **iOS.** The connect sheet (see mockup) opens from the Settings row, the
   profile block and the offer card. «Разрешить доступ только на чтение»
   calls `authorize` and opens `ASWebAuthenticationSession` with callback
   scheme `gennety`. The «Твой вкус» card is the connected state.
5. **Copy.** All strings live in shared i18n in five languages and follow
   `voice-and-tone.md` (static strings: normal capitalisation, plain words).

### Phase 2 — reading and reducing the pins

1. **What is read.**
   - The account call only confirms the token works; nothing from it is kept.
   - Boards: public boards (and group boards) the person owns or follows as
     a collaborator, newest activity first, at most 50 boards.
   - Pins: the most recent pins of those boards, at most 40 per board and 300
     in total. Per pin only `id`, `board_id`, `title`, `description`,
     `alt_text`, `dominant_color` and the smallest image size that is at least
     236 px wide (field names to be checked against the live v5 reference in
     phase 0).
   - Secret boards are not read in v1 (no `*_read_secret` scope): they are
     where people keep weddings, pregnancies and other private plans, and
     asking for them weakens trust and the review.
2. **Sensitive filter, before any model sees anything.**
   - A board or pin whose name or text matches the excluded-topic word list
     (`AESTHETIC_EXCLUDED_TERMS`, five languages) is dropped whole. The list
     covers weddings and engagement, babies, pregnancy and parenting, health,
     medicine, body weight and dieting, religion, politics, sexuality and
     sexual content, and money troubles.
   - The model is also told to ignore people in images and never to describe
     a body, a face, a religion, a health state, an orientation, a relationship
     plan or a political view. Its output is a closed list, so it has nowhere
     to put such a guess.
3. **Palette, no model.** The kept pins' `dominant_color` values are snapped to
   a fixed 24-colour reference palette in shared constants. The five most
   frequent reference colours become the swatches (never raw pin colours), and
   the share of warm, cool, neutral, dark and saturated colours picks one or
   two palette families: `warm_neutral`, `cool_neutral`, `monochrome`,
   `earthy`, `pastel`, `jewel`, `bright`, `dark_moody`.
4. **One model call.**
   - Input: a stratified sample of at most 36 kept pins (spread across boards
     by pin count), each as a low-detail image plus its title and alt text,
     fenced as untrusted data, plus the kept board names.
   - Model: `MODELS.visionFast`, strict JSON schema output, prompt
     `aestheticProfilePrompt` in `packages/shared/src/ai/prompts.ts`.
   - Output, every value from closed lists in shared constants
     (`AESTHETIC_TAGS`), each with a weight from 0 to 1:
     - `styles` (at most 3): minimal, classic, romantic, boho, vintage,
       streetwear, sporty, avant_garde, cozy, maximalist, industrial,
       scandinavian, mediterranean, japandi;
     - `domains` (at most 4, with the share of pins): interiors, fashion,
       food_drink, travel, art_design, architecture, nature, beauty, fitness,
       crafts, cars, tech;
     - `placeVibes` (at most 3): candlelit, rooftop_view, garden_green,
       industrial_loft, classic_cafe, wine_bar, gallery_museum, seaside,
       bookish, design_hotel, street_food;
     - `dressCode` (one or none): relaxed, smart_casual, dressy.
   - Validation drops unknown or repeated values and clamps weights; it never
     fills gaps. Fewer than two valid tags in total counts as `empty`.
5. **Thresholds.** Fewer than 20 kept pins, or fewer than 2 boards with kept
   pins, gives `empty` and stores no tags («Пинов пока мало…»).
6. **After the read.** Pins, images, board names and texts exist only in the
   job's memory and are discarded when the job ends, success or failure. They
   are not logged, cached, embedded or written to any table or bucket.
7. **Cost and time.** One read is about 5–15 Pinterest requests and one vision
   call on at most 36 low-detail images. The exact cost is measured on the
   founder's account in this phase and capped by a constant; a read is
   expected to finish in under a minute and runs in the background.

### Phase 3 — where the tags are used

1. **The owner's card.** «Твой вкус» shows the swatches, the style, domain and
   place-vibe chips, the counts and the last read date, «Обновить» and
   «Отключить и удалить». Each chip has «Это не про меня». It says plainly who
   sees it: «Видишь только ты».
2. **The agent** (app chat and Telegram, one account).
   - The agent context gets one short block (at most 80 tokens) with the
     visible tags in words, owner only, behind the flag.
   - The agent may use it when the person talks about style, an outfit for a
     date, their home or a place to go. It never quotes a pin or a board, never
     says «I saw on your Pinterest», and never uses it to judge the person.
   - The agent stances and red lines stay as they are; the block adds no new
     topic.
3. **Venue picks.**
   - The place vibes map onto the venue catalog's `vibeTags` and facets through
     a hand-written table in shared constants (for example `candlelit` → wine,
     cocktails; `rooftop_view` → rooftop, view; `bookish` → books, coffee;
     `garden_green` → garden, nature). Unmapped vibes map to nothing.
   - Like Tempo Sync Tier 2, the vibes only reweight the draw inside the
     existing diversity band (`applyVenueDiversity`), using what both sides
     share; with one side unconnected, the connected side leads at half weight.
     They never override budget, distance, opening hours or the person's own
     venue intent.
   - The venue reason line shown to either person never cites taste («because
     she likes candles» is exactly what is ruled out).
4. **Matching.**
   - A centred factor inside `composeScore`, the same shape as `V_rhythm`:
     `V_aesthetic = 1 + w·(2·sim − 1)`, where `sim` is a weighted overlap of
     styles, place vibes and palette families. It is exactly 1 when either
     side has no profile, so not connecting is never a loss.
   - `AESTHETIC_MATCH_WEIGHT` defaults to 0 and is capped at 0.05. The pair
     similarity is logged at any weight so the weight can later be set from
     outcome data. Not part of `allocationFingerprint`.
5. **Vibe Check.** The style-picks digest (`style-picks.md`) may read the
   styles and `dressCode` as two more signals, behind its own flag and only
   after the privacy policy names this use.
6. **Who never sees it.** The partner (no tags, no swatches, no «вам обоим
   нравится» lines in v1), the pitch, the wingman tip, icebreakers (they would
   reveal the partner's taste), the profile embedding, the founder feed,
   per-user admin reads, push texts and analytics other than pair aggregates
   with cells under 20 suppressed. A fence test
   (`apps/bot/src/services/aesthetic/boundary.test.ts`) holds the list of
   readers, as `rhythm/boundary.test.ts` does for Tempo Sync.

### Phase 4 — Pinterest review and switch-on

1. The flow is tested end to end on the founder's account under Trial
   (`docs/operations/runbooks/`).
2. The privacy policy gains a Pinterest section (what is read, what is
   kept, who sees it, retention, deletion, the model provider), drafted as
   `legal/pinterest-connect-draft.md` like the Tempo Sync draft, and published
   with a `LEGAL_DOCS_VERSION` bump.
3. The Standard access request is filed with a screen recording of the iOS
   connect flow, the use-case text and the policy link.
4. After approval, the flag goes on in production with the matching weight
   still 0.

### Phase 5 — later, each its own decision

1. Telegram and the Mini App: the same sheet in the Mini App, opened from the
   bot's settings; OAuth then runs in Telegram's browser.
2. A partner-facing shared-taste line on the pitch, only with both people's
   opt-in.
3. An onboarding step, if phase 3 data argues for it.
4. Secret boards, if people ask for them.

## Storage, retention, deletion

1. **Proposed tables** (schema change, needs the founder's «да»).
   - `pinterest_connections`: `user_id` (primary key, cascade on user
     delete), encrypted access and refresh tokens, their expiry times, granted
     scopes, `status`, `last_read_at`, `consent_version`, `consented_at`.
   - `user_aesthetic_profiles`: `user_id` (primary key, cascade), the tags as
     JSON (`AestheticProfileV1`), the swatches, `boards_read`, `pins_read`,
     the hidden tags, `algo_version`, `synced_at`.
   - `match_score_logs.aesthetic_similarity`: a nullable column for the
     shadow log.
   - No vector index and no embedding.
2. **Retention.** A profile not refreshed for 60 days is absent for every
   reader and deleted by the nightly retention sweep, together with the
   connection row. Pins are never retained (phase 2, step 6).
3. **Disconnect and account deletion.** `DELETE /v1/me/aesthetic` and account
   deletion remove both rows at once (hard delete). Disconnect also stops
   every reader immediately, because readers only see rows that exist.
4. **GDPR.** The data export includes the visible and hidden tags, the
   swatches, the counts and the dates, never the tokens. The lawful basis is
   consent, versioned per sheet text like Tempo Sync; withdrawing it is the
   disconnect.

## Failure states

1. **Cancelled on Pinterest's page.** The sheet stays open, nothing is kept,
   no error copy beyond a quiet line.
2. **Scope not granted.** «Без доступа к доскам вкус не собрать» with
   «Попробовать снова»; no tokens kept.
3. **Not allowed (Trial, or Pinterest refuses the account).** «Pinterest пока
   не пускает новые аккаунты — подключим, как только откроют»; the row shows
   «Скоро». In practice the flag stays off until Standard access, so people
   should never see this.
4. **Too few pins.** `empty`: «Пинов пока мало, чтобы понять вкус. Добавь
   досок — и обнови.» The connection is kept so «Обновить» works.
5. **Read failed (Pinterest down, rate-limited, model failed).** `failed`
   with an automatic retry after 1, 6 and 24 hours, then a «Обновить» button.
   A previous profile, if any, stays in use until it goes stale.
6. **Token revoked or expired.** `needs_reconnect`: the profile stays for
   the owner to see until it goes stale, readers stop using it at once, and
   the card offers «Переподключить».
7. **Flag turned off.** Everything disappears from the app; rows are kept
   until the retention sweep, so turning the flag on again within 60 days
   loses nothing.

## Demo mode

1. The demo bot is Telegram, and v1 is iOS-only, so the demo shows nothing:
   no row, no card, no offer.
2. The feature adds no gate, no paid step and no two-sided negotiation step,
   so the demo driver and the puppet need no branch. The puppet has no
   aesthetic profile, so `V_aesthetic` is 1 and venue reweighting is neutral
   for every demo pair.
3. When phase 5 brings the sheet to the Mini App, the demo behaves as
   production: a visitor may connect their real Pinterest (real OAuth, real
   read), the puppet stays unconnected. That is the default to confirm with
   the founder at that point.

## Open questions for the founder

1. Placement: B plus the one-time offer card, as recommended, or an
   onboarding step?
2. Pin images to OpenAI's vision model (recommended, like the screenshot
   library), or text and dominant colours only (cheaper, much weaker)?
3. Keep the refresh token for a monthly automatic update (recommended), or a
   one-time read that keeps no token, like the Spotify import, with
   «Обновить» meaning a new Pinterest login?
4. Secret boards: leave them out in v1 (recommended)?
5. Who writes to Pinterest in phase 0, and from which account: the developer
   app has to belong to a Pinterest business account the founder controls.
6. Matching weight 0 with a shadow log first (recommended), as with Tempo
   Sync?
7. A partner-facing «общий вкус» line: out of v1 (recommended)?

## Needs the founder's «да» before any code (AGENTS.md rule 5)

1. A new external API: Pinterest API v5.
2. Schema changes: `pinterest_connections`, `user_aesthetic_profiles`,
   `match_score_logs.aesthetic_similarity`.
3. New production secrets: `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET`,
   `PINTEREST_TOKEN_KEY` (server environment only).
4. A privacy-policy change and its publication.

## Rejected alternatives

1. **Reading public boards from a pasted link through Pinterest's public
   widget JSON**, the endpoint the share sheet already uses for single pins
   (`apps/bot/src/services/share-video/read.ts`). It needs no app review, but
   the widget exists for embeds: reading whole boards to build a taste profile
   is the automated extraction the guidelines forbid, and it skips
   Pinterest's consent screen. Rejected unless Pinterest says it is fine in
   writing. What is reused from that code: the pin and `pin.it` link parsing,
   and the image-size choice.
2. **Keeping the pins** (for re-analysis or a «your pins» gallery). It is
   what the review checks against, and nothing in the product needs them.
3. **Feeding Pinterest into the profile embedding.** It would leak taste into
   every downstream reader and is hard to delete cleanly.
4. **A hosted third-party Pinterest MCP connector.** The «full connector» the
   founder mentions exists for AI assistants (Claude, ChatGPT), mostly from
   third-party vendors and with write scopes; Gennety's users would still need
   our own OAuth app, and routing their tokens through a vendor adds a
   processor for no gain.
