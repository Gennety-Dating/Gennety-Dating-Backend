-- Background-scan indexes (2026-10-13). Purely additive: three plain btree
-- indexes, no column or row is touched. Order against the code restart does not
-- matter — the old code runs the same queries, only slower.

-- CreateIndex
CREATE INDEX "users_status_status_message_id_idx" ON "users"("status", "status_message_id");

-- CreateIndex
CREATE INDEX "matches_peer_wait_message_id_a_idx" ON "matches"("peer_wait_message_id_a");

-- CreateIndex
CREATE INDEX "matches_peer_wait_message_id_b_idx" ON "matches"("peer_wait_message_id_b");
