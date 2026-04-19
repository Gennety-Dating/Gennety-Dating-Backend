import { prisma } from "@gennety/db";
import type { StorageAdapter } from "grammy";

/**
 * grammY StorageAdapter backed by the `bot_sessions` table in PostgreSQL.
 * Sessions survive bot restarts — no more in-memory-only state.
 */
export function prismaSessionAdapter<T extends object>(
  defaults?: T,
): StorageAdapter<T> {
  return {
    async read(key: string): Promise<T | undefined> {
      const row = await prisma.botSession.findUnique({ where: { key } });
      if (!row) return undefined;
      const stored = row.data as T;
      return defaults ? { ...defaults, ...stored } : stored;
    },

    async write(key: string, value: T): Promise<void> {
      await prisma.botSession.upsert({
        where: { key },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: { key, data: value as any },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: { data: value as any },
      });
    },

    async delete(key: string): Promise<void> {
      await prisma.botSession.deleteMany({ where: { key } });
    },
  };
}
