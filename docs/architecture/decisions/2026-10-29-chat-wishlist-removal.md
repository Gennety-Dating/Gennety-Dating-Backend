<!-- WHEN_TO_READ: Changing app chat wishlist tools, deletion authorization, or client compatibility. -->

# 2026-10-29 — Remove a wishlist item directly in app chat

The founder supplied a conversation where the agent recognized Another 13 as
already saved, then refused «тогда удали его» and sent them to Profile.
The owner deletion service existed; the chat agent had no removal tool.

1. An explicit request authorizes removing one item in chat. No extra profile
   screen or confirmation card is required. Read the current own list, resolve
   the reference from the conversation, and ask if the item is ambiguous.
2. Deletion uses the existing owner-scoped service and its image cleanup. The
   ID must have been returned by the live read in this turn. Removal shares
   the one-write budget and uses a code-owned localized success receipt.
3. The existing consent gate has a removal-specific check with the actual item
   name and brand. For removal only, missing/failed checks refuse the change.
   Existing profile-write fallback behavior is preserved.
4. Card support is irrelevant to removing a saved item: wishlist flag on is
   enough. Native API and Swift code do not change. Additions keep their button
   consent. Telegram menu tools are outside this request. Demo app chats use
   the same tools against isolated owner data under the same feature flag.
5. Production rollout is pending. No database, feature flags, deployment, or
   real account data were changed during implementation. Live-model regression
   checks use an in-memory database for the screenshot case and an ambiguous
   two-product reference.
