<!-- WHEN_TO_READ: You change ideas, their uses or anything that reads them. -->

# 2026-11-01 — Ideas: a separate layer over the screenshot library

**Kind:** founder brief, with design decisions by the implementer.

**What.** A new layer of ideas, sources, confirmed preferences, reminders and impressions, behind
`MEMORY_IDEAS_ENABLED`. Import still grants nothing. Uses are granted per idea on the server.

**Why this shape.** A screenshot, a guess, a wish and a preference answer different questions, and the
earlier library was right not to mix them. Reusing `ScreenshotItem` would have tied a wish said in
chat to an image that may be deleted.

**Decided here.**

- A gift or a reference clears all three uses, and changing the mark back does not restore them, so a
  grant cannot silently return.
- A split idea starts without uses.
- An idea with no sources closes. Staying after its last source would be the hidden copy the brief forbids.
- Grants and deletion through chat fail closed when the consent check cannot answer. Profile writes
  keep failing open, as decided on 2026-10-15; this is a stricter rule for this layer only.
- Revoking and deleting work with the flag off. Saving and granting do not.

**Rejected.** A library-wide switch for each use: it would turn one tap into consent for everything the
library later imports.

**Recorded in.** `docs/product/domains/memory-ideas.md`.
