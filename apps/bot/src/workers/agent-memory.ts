import { sweepAgentMemory } from "../services/agent-memory.js";
import { sweepMemoryWriter, type MemoryWriterSweepResult, type WriterDeps } from "../services/agent-memory-writer.js";

/**
 * Long-term memory sweep (decision 2026-11-19, spec
 * `docs/product/domains/long-term-memory.md` phases 5 and 8.4).
 *
 * Each tick reads a small batch of app chats and Telegram histories that went
 * quiet with something unread — one `MODELS.fast` call each, plus an embedding
 * per written note — and, at most once an hour, expires resolved stories and
 * followups. With the flag off and no preview list nothing is selected.
 */
const RETENTION_EVERY_MS = 60 * 60 * 1000;
let lastRetentionAt = 0;

export async function agentMemoryTick(
  deps: WriterDeps & { batch?: number } = {},
): Promise<MemoryWriterSweepResult & { expired: number; closed: number }> {
  const result = await sweepMemoryWriter(deps);
  const now = (deps.now ?? (() => new Date()))();
  let retention = { expired: 0, closed: 0 };
  if (now.getTime() - lastRetentionAt >= RETENTION_EVERY_MS) {
    lastRetentionAt = now.getTime();
    retention = await sweepAgentMemory(now);
  }
  return { ...result, ...retention };
}
