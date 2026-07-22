import { InlineKeyboard, type Api, type RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  magicContextPrompt,
  DEFAULT_SESSION,
  type SessionData,
  type Language,
} from "@gennety/shared";
import { env } from "../../config.js";
import type { BotContext } from "../../session.js";
import { buildMiniAppUrl } from "../../services/mini-app-url.js";
import { typeRadarInviteCopy } from "../../services/type-radar-copy.js";
import { runAgentTurn, type AgentTurnResult } from "../../services/onboarding-agent.js";

/**
 * Type Radar onboarding gate wiring (§Type Radar, step 5B). The agent raises
 * `typeRadarRequested`; this module sends the invite (web_app + Skip), handles
 * the Skip callback, and resumes the onboarding agent after the picker is
 * submitted (from the Mini App route) or skipped (from the callback) — moving
 * the user on to the Magic Prompt / photos step exactly as if the gate hadn't
 * been there. Off by default (`TYPE_RADAR_ENABLED`).
 */

/** Callback data for the inline Skip button on the radar invite. */
export const RADAR_SKIP_CALLBACK = "radar:skip";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Send the radar invite to a Telegram chat: the intro text + a `web_app` button
 * that opens the radar Mini App and an inline Skip button. When `WEBAPP_URL`
 * isn't a real HTTPS host (dev without a tunnel) the web_app button is omitted
 * and only Skip is offered, so the flow never wedges.
 */
export async function sendTypeRadarInvite(
  api: Api<RawApi>,
  chatId: number,
  telegramId: bigint,
  text: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { language: true, theme: true },
  });
  const lang = (user?.language ?? "en") as Language;
  const theme = user?.theme ?? "dark";
  const copy = typeRadarInviteCopy(lang);

  const keyboard = new InlineKeyboard();
  const host = env.WEBAPP_URL;
  if (typeof host === "string" && host.startsWith("https://")) {
    const url = buildMiniAppUrl("radar", { lang, theme });
    keyboard.webApp(copy.button, url).row();
  }
  keyboard.text(copy.skip, RADAR_SKIP_CALLBACK);

  await api.sendMessage(chatId, text, { reply_markup: keyboard });
}

/**
 * Stamp the radar as done for a user who tapped Skip. `typeRadarCompletedAt`
 * marks both "submitted" and "skipped"; a skip leaves `typePrefTags` null, so
 * `V_type` stays neutral. Upsert-safe if the Profile row doesn't exist yet.
 */
export async function markTypeRadarSkipped(telegramId: bigint): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;
  const now = new Date();
  await prisma.profile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, typeRadarCompletedAt: now },
    update: { typeRadarCompletedAt: now },
  });
}

/** Session fields to apply after the resume, derived from the agent result. */
export function sessionPatchAfterRadar(result: AgentTurnResult): Partial<SessionData> {
  if (result.contextDumpStarted || result.contextPromptRequested) {
    // Accepted path: the Magic Prompt was just shown — buffer the paste next.
    return { awaitingContextDump: true, contextDumpBuffer: "", expectingPhoto: false };
  }
  // Declined path (or anything else): photos, or nothing special.
  return { expectingPhoto: result.expectingPhoto, awaitingContextDump: false };
}

/**
 * Resume the onboarding agent after the radar is submitted/skipped and dispatch
 * the next step to the chat: the Magic Prompt (accepted) or the photo request
 * (declined). Returns the session patch the caller must apply (to `ctx.session`
 * for the Skip callback, or the persisted session for the Mini App route).
 */
export async function resumeOnboardingAfterRadar(
  api: Api<RawApi>,
  telegramId: bigint,
  chatId: number,
): Promise<{ sessionPatch: Partial<SessionData> }> {
  const result = await runAgentTurn(telegramId, { kind: "resume" });

  // Send the Magic Prompt above the reply, mirroring the conversational handler.
  if (result.contextPromptRequested) {
    const prompt = magicContextPrompt(
      (await userLanguage(telegramId)) ?? "en",
    );
    try {
      await api.sendMessage(chatId, `<pre>${escapeHtml(prompt)}</pre>`, {
        parse_mode: "HTML",
      });
    } catch {
      await api.sendMessage(chatId, prompt).catch(() => {});
    }
  }

  if (result.reply) {
    await api.sendMessage(chatId, result.reply).catch(() => {});
  }

  return { sessionPatch: sessionPatchAfterRadar(result) };
}

/**
 * Inline Skip handler: stamp the radar as done (no prefs), strip the invite
 * buttons, and resume onboarding to the next step. Fires while the user is still
 * mid-onboarding, so it is registered before the completed-user menu delegation.
 */
export async function handleRadarSkip(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const rawId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (rawId == null || chatId == null) return;
  const telegramId = BigInt(rawId);
  // One-use: remove the buttons so Skip / open-picker can't be replayed.
  await ctx.editMessageReplyMarkup().catch(() => {});
  await markTypeRadarSkipped(telegramId);
  const { sessionPatch } = await resumeOnboardingAfterRadar(ctx.api, telegramId, chatId);
  Object.assign(ctx.session, sessionPatch);
}

async function userLanguage(telegramId: bigint): Promise<Language | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { language: true },
  });
  return (user?.language ?? null) as Language | null;
}

/**
 * Persist a session patch directly to the `bot_sessions` store, for callers
 * without a live grammY `ctx` (the Mini App submit route). Session key is the
 * chat id string, which equals the telegram id for private chats.
 */
export async function patchOnboardingSession(
  telegramId: bigint,
  patch: Partial<SessionData>,
): Promise<void> {
  const key = String(telegramId);
  const row = await prisma.botSession.findUnique({ where: { key } });
  const current = (row?.data ?? {}) as Partial<SessionData>;
  const next: SessionData = { ...DEFAULT_SESSION, ...current, ...patch };
  await prisma.botSession.upsert({
    where: { key },
    create: { key, data: next as unknown as object },
    update: { data: next as unknown as object },
  });
}
