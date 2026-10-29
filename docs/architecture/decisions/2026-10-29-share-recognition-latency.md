<!-- WHEN_TO_READ: Optimising iOS share recognition, JSON-LD product lookup, Instagram metadata or video cache concurrency. -->

# Share recognition latency — 2026-10-29

The founder asked to shorten recognition and expose useful actions sooner
while quickly collecting wishlist items from shops and videos.

1. A single explicit JSON-LD Product with a name, photo and unambiguous
   category can become a link candidate without a model round-trip. The
   product's original name and brand are preserved; the existing validation,
   price banding, budget, cache and SSRF perimeter still apply. Listing pages,
   incomplete metadata and unknown/conflicting categories keep the AI path.
2. Instagram share stubs go directly to the existing metadata reader, whose
   guarded GET follows redirects and parses the final page. Resolving the
   stub beforehand fetched the same final HTML twice. Profiler is unchanged.
3. Concurrent reads of the same shared video, language and city share one
   promise. Failures clear the promise, and successful reads also cache the
   canonical URL. City belongs in the cache key because it affects venue
   suggestions in the prompt.
4. Demo uses these same code paths when enabled; no flag, API, schema,
   dependency, consent rule or confirmation requirement changes. Nothing is
   written to the wishlist without the owner's existing confirmation.
5. Controlled measurements, median of three runs: cold structured product
   604 → 102 ms with page delay 100 ms and AI delay 500 ms; Instagram metadata
   508 → 304 ms with redirect delay 100 ms and final-page delay 200 ms.
   These are measurements of real code with fake upstream transport, not
   production or physical-device latency. The first full AI read of a video
   was not benchmarked.
6. The iOS companion change makes completed cards actionable during other
   lookups, loads capacity independently, parses photos/text concurrently,
   prefers product URLs over preview images and cancels dismissed reads.
   Its reproducible benchmark and raw samples live in the iOS repository at
   `docs/performance/share-recognition-2026-10-29/`.

Validation: 119 tests across lookup, extract, share read, share metadata,
share routes and safe fetch; bot TypeScript typecheck; scoped ESLint.
Production rollout is pending. No deployment is implied by these measurements.
