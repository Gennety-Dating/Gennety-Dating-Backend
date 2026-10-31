# 2026-10-31 — Private screenshot library

1 entries.

## 2026-10-31 — Private screenshot library behind a flag

Kind: founder decision and design. Spec: `docs/product/domains/screenshot-library.md`.

The founder approved, in chat: reduced copies and text of each screenshot go to
OpenAI, because text alone cannot find an interior or a product; a default period of
90 days and a cap of 2,000 per library; the old archive through the cheaper Batch API,
which is not built yet; one short consent sheet on connecting, no onboarding step,
which reconciles the request with the 2026-10-08 preference against warning screens,
since uploading a library to the cloud is not implied by the feature; additive
migration and pushing to main with the flag off.

Design choices: its own tables instead of the matching vector; state in rows and a
cron because the project has no queue; `generation` instead of trusting request order;
no vector index because rows are filtered by owner first; a deleted row gives up its
content hash so the unique pair binds live rows only; one card holding several
sources, because a reply carries one attachment.

Public policy text is a draft, `legal/screenshot-library-draft.md`, and the live
policy version does not change while the flag is off. The internal ROPA and DPIA
record the activity as not live. A lawyer has to review the text before the flag
goes on, because screenshots can hold other people's data.

Left undone on purpose: the Batch API path, a measured search threshold, measured
token counts with the real model. Going forward: read the domain file first, and
keep the flag off until its checklist is done. Nothing was deployed.
