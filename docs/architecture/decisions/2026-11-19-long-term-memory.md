<!-- WHEN_TO_READ: You touch the agent's long-term memory: memory notes, the memory writer, the `recall`/`remember`/`update_memory`/`forget_memory` tools, the memory pause, or the `agent_memories` / `agent_memory_state` tables. -->

# 2026-11-19 — long-term memory of the agent

The founder asked for a «блок долговременных переписок»: the agent is a friend
who goes along with a person's love life, remembers their conversations, earns
trust and leads them offline. Spec: `docs/product/domains/long-term-memory.md`.

1. **Approved by the founder 2026-11-19** («Да, всё трое»): the schema and
   migration below, the screen «Что Gennety помнит», and the Telegram person
   card plus `search_past_chats` in this work (6.1, 6.2, 6.5). Questions 6.3
   and 6.4 were not answered separately, so they are built as recommended:
   the writer reads the last 90 days once (`AGENT_MEMORY_BACKFILL_DAYS`), and
   demo mode behaves as production. Both are one constant or one line to
   change. The screen still goes to the founder as a mockup before client
   work. Production and the live migration still wait for an explicit «да».
2. **Notes, not transcripts.** Memory is a set of short notes in the person's
   language, of five kinds: fact, person, story, followup and date. Notes are
   not a new copy of the chats and not an extension of ideas. Ideas stay what a
   person wants for dates, and notes are their life. Chat summaries stay the
   retrieval layer for a whole conversation.
   - Rejected: replaying more raw history. The cost grows with every chat, and
     the model still does not know what matters.
   - Rejected: one free-text «about the person» field, the way the advice
     dossier proposed for the delivery hint. A person cannot delete one line of
     it, it cannot say whether a story is open, and it rots.
   - Rejected: putting life facts into `MemoryPreference`. That table feeds
     venue choice and matching, and notes must feed nothing but the
     conversation.
3. **One memory for both surfaces.** Telegram and the app read and write the
   same notes. Before this, Telegram replayed 24 hours and saw no app chat.
   The agent audit proposes adding the person card and `search_past_chats` to
   Telegram in this same work (question 6.5).
4. **Written after the conversation, by the cheap model, checked by the
   server.** The writer runs where the chat digest already runs. The server
   checks ids, caps, the sensitive filter and the pause. Nothing is written on
   the reply's path.
5. **Proposed schema** (additive; no vector index, because a person has at
   most 120 notes):

   ```prisma
   model AgentMemory {
     id              String                       @id @default(uuid()) @db.Uuid
     userId          String                       @map("user_id") @db.Uuid
     /// fact | person | story | followup | date
     kind            String
     text            String
     subject         String?
     dueOn           DateTime?                    @map("due_on") @db.Date
     recurring       Boolean                      @default(false)
     /// open | resolved — story and followup only
     status          String?
     outcome         String?
     /// told | noticed
     provenance      String
     /// app | telegram
     surface         String
     sourceSessionId String?                      @map("source_session_id") @db.Uuid
     embedding       Unsupported("vector(1536)")?
     lastSeenAt      DateTime                     @default(now()) @map("last_seen_at")
     resolvedAt      DateTime?                    @map("resolved_at")
     createdAt       DateTime                     @default(now()) @map("created_at")
     updatedAt       DateTime                     @updatedAt @map("updated_at")

     user          User         @relation(fields: [userId], references: [id], onDelete: Cascade)
     sourceSession ChatSession? @relation(fields: [sourceSessionId], references: [id], onDelete: SetNull)

     @@index([userId, kind])
     @@index([userId, updatedAt])
     @@map("agent_memories")
   }

   model AgentMemoryState {
     userId            String    @id @map("user_id") @db.Uuid
     pausedAt          DateTime? @map("paused_at")
     telegramScannedAt DateTime? @map("telegram_scanned_at")
     updatedAt         DateTime  @updatedAt @map("updated_at")

     user User @relation(fields: [userId], references: [id], onDelete: Cascade)

     @@map("agent_memory_state")
   }

   // chat_sessions gains:
   //   memoryScannedCount Int @default(0) @map("memory_scanned_count")
   ```

   Migration `20261119120000_agent_memory`:

   ```sql
   CREATE TABLE "agent_memories" (
       "id" UUID NOT NULL DEFAULT gen_random_uuid(),
       "user_id" UUID NOT NULL,
       "kind" TEXT NOT NULL,
       "text" TEXT NOT NULL,
       "subject" TEXT,
       "due_on" DATE,
       "recurring" BOOLEAN NOT NULL DEFAULT false,
       "status" TEXT,
       "outcome" TEXT,
       "provenance" TEXT NOT NULL,
       "surface" TEXT NOT NULL,
       "source_session_id" UUID,
       "embedding" vector(1536),
       "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "resolved_at" TIMESTAMP(3),
       "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       "updated_at" TIMESTAMP(3) NOT NULL,
       CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
   );
   CREATE INDEX "agent_memories_user_id_kind_idx" ON "agent_memories"("user_id", "kind");
   CREATE INDEX "agent_memories_user_id_updated_at_idx" ON "agent_memories"("user_id", "updated_at");
   ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_user_id_fkey"
       FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
   ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_source_session_id_fkey"
       FOREIGN KEY ("source_session_id") REFERENCES "chat_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

   CREATE TABLE "agent_memory_state" (
       "user_id" UUID NOT NULL,
       "paused_at" TIMESTAMP(3),
       "telegram_scanned_at" TIMESTAMP(3),
       "updated_at" TIMESTAMP(3) NOT NULL,
       CONSTRAINT "agent_memory_state_pkey" PRIMARY KEY ("user_id")
   );
   ALTER TABLE "agent_memory_state" ADD CONSTRAINT "agent_memory_state_user_id_fkey"
       FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

   ALTER TABLE "chat_sessions" ADD COLUMN "memory_scanned_count" INTEGER NOT NULL DEFAULT 0;
   ```

   Rollback: drop both tables and the column. Existing chats start at
   `memory_scanned_count = 0`. With the flag on, the writer would read their
   whole history once. Whether to do that or to start from now is question
   6.3.
6. **Open questions for the founder.**
   1. A screen «Что Gennety помнит» in the app, or memory only through the
      chat? Recommended: the screen. A friend who remembers earns trust when
      the person can see and wipe what is kept, and the right of access asks
      for it anyway. «О чём мы говорили» already exists as the chat list.
   2. The schema and the migration above.
   3. Old conversations: does the writer read the existing chats once when the
      flag goes on, or start from today? Recommended: once, the last 90 days
      only, so the agent remembers from the first day.
   4. Demo mode: the same behaviour as production, with notes going away
      with the demo reset. Recommended: yes.
   5. Telegram also gets the person card and `search_past_chats` in this work,
      as the agent audit proposed (its principle 8)? Recommended: yes. Both
      are reads that already exist on the app and need no schema.
7. **Coordination.** `recall` maps to the `remembering` step, which the
   chat-statuses session introduces. Until it lands, `recall` reports
   `past_chats`. The persona is not edited here; the memory block is its own
   module, as the stances are.
8. **Built 2026-11-19 (behind `AGENT_MEMORY_ENABLED`, preview list
   `AGENT_MEMORY_USER_IDS`).** The deviations from the proposal are these.
   - The screen's API is `/v1/me/agent-memory`, because `/v1/me/memory` is
     already the ideas API. `GET` groups notes into clusters on the server,
     so both clients group the same way.
   - All four memory tools are outside the turn's single write budget,
     because that budget guards profile changes and «забудь Диму и запомни
     про Машу» must do both. «Забыть всё» is enforced in code to take two
     turns: the first call only arms it, and the confirmation counts only
     on a later turn within ten minutes.
   - Telegram gets the person card, the memory block and the four tools,
     plus `search_past_chats` over the app chats. All of it sits behind the
     same flag.
   - A followup the writer cannot close in 30 days past its due day is
     closed without an outcome, not with a made-up sentence.
   - `recall` reports `remembering`, which chat-statuses landed first
     (660f4fc4); the other three memory tools report `thinking`.
9. **Screen look (founder, 2026-11-19).** The founder sent a reference
   video and asked for the same screen in Gennety's design system: jelly
   clusters of bubbles, a tap opens a card, pulling a bubble out forgets
   it, with an undo. Mockup: https://claude.ai/artifact/K3inMXe2ttK16SbnUgV7VU.
   It waits for «да» before Swift work. Open point: the mockup gives each
   fact a topical glyph (a cap for КПИ, a house for Подол). The data has no
   glyph, so either the writer picks one from a fixed list into a new
   nullable `glyph` column (a schema change that needs a yes) or a bubble
   shows a glyph per kind.
10. **Memory and reminders stay apart** (`agent-reminders.md`, planned the
    same day). Memory never sends anything: a `followup` or a `date` note
    only shapes what the agent says when the person comes back. A reminder
    is the person's own request and is delivered at its time. «Напомни про
    др Маши» is a reminder for that tool; the date itself is also a memory
    note, and neither replaces the other.
11. **Opening a cloud is a focus, not a screen** (founder, 2026-11-19, on
    the first mockup, with a screen recording of ChatGPT's model-effort
    control). The tapped cloud lifts out of its tile and springs to the
    centre in about 0.4 s. The overview stays under a 16 px blur with a light
    dim. Tapping the blur returns the cloud to its tile. The card opens over
    the focused cloud and closes back to it. Reduced motion is a cross-fade.
    Mockup version 2 at the same link.
