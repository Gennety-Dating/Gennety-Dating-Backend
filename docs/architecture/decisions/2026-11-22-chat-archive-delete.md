<!-- WHEN_TO_READ: Touching archiving, deleting or listing the agent's chats (`chat_sessions.archived_at`, `DELETE /v1/chat/sessions`), or the app's chat header menu and history pane. -->

# 2026-11-22 — A chat with the agent can be archived and deleted

## 2026-11-22 — Archive is out of sight, deletion is real; history moves to the right of the chat

**Kind:** founder request and «Да» to the prototype + agent design (the rest)

**What:**

1. The founder asked to archive and delete chats, reach the archive through settings, replace the header's History button with three dots and open the history by a swipe. The prototype «Чаты Gennety» was approved with a plain «Да»: the history to the RIGHT of the chat (the finger goes right to left; the opposite way is the system Back) and the «Предметы» icon set.
2. Archive: `chat_sessions.archived_at`. The chat leaves the history list and the Today rows and stays in the agent's `search_past_chats` / `read_past_chat`. Restoring, or the person's next message in it, clears the column. Order never changes.
3. Deletion is permanent and has no undo: photos first (fail closed, 503 and nothing erased from the chat), then the row with messages, title, summary and embedding. It runs under the person's chat lock, so a reply in flight goes with the chat.
4. `forget=true` deletes the memory notes whose last source is this chat; the app offers it as a switch, on by default. Reminders and wishlist items stay.
5. `archivedCount` in the list answer is the client's sign that the server can do it; without it the app offers neither action.
6. Demo mode: nothing to branch (`docs/product/demo-mode.md`).

**Why:** until now there was no deletion on purpose: a chat cut from the list would have stayed in the summary the agent searches, promising a forgetting that did not happen. This one removes the row the search reads.

**Rejected:** a soft delete with a recovery window (says «deleted» while everything stays); the history on the left as in ChatGPT (fights the system Back and the row swipe); hiding archived chats from the agent (then archive would be a slower deletion).

**Not decided here:** the production deploy and the migration on the live database: the founder's separate «да».
