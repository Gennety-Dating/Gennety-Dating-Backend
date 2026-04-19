import { type Context, session, type SessionFlavor } from "grammy";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION } from "@gennety/shared";
import { prismaSessionAdapter } from "./prisma-session-adapter.js";

export type BotContext = Context & SessionFlavor<SessionData>;

export function sessionMiddleware() {
  return session<SessionData, BotContext>({
    initial: () => ({ ...DEFAULT_SESSION }),
    storage: prismaSessionAdapter<SessionData>(DEFAULT_SESSION),
  });
}
