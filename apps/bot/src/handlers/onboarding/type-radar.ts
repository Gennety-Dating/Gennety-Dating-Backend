import { InlineKeyboard, type Api, type RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  DEFAULT_SESSION,
  type SessionData,
  type Language,
} from "@gennety/shared";
import { env } from "../../config.js";
import type { BotContext } from "../../session.js";
import { buildMiniAppUrl } from "../../services/mini-app-url.js";
import { typeRadarInviteCopy } from "../../services/type-radar-copy.js";
import { runAgentTurn, type AgentTurnResult } from "../../services/onboarding-agent.js";
import { voicePromptAskPayload } from "./voice-prompt.js";
import { replyPanelMarkupFor } from "../../services/reply-panel.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import {
  radarThinkingSteps,
  RADAR_MINI_APP_CLOSE_LEAD_MS,
} from "../../services/radar-thinking.js";



/** Callback data for the inline Skip button on the radar invite. */
export const RADAR_SKIP_CALLBACK = "radar:skip";

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
  // Declined path (or anything else): photos, or nothing special.
  return { expectingPhoto: result.expectingPhoto };
}


export async function resumeOnboardingAfterRadar(
  api: Api<RawApi>,
  telegramId: bigint,
  chatId: number,
): Promise<{ sessionPatch: Partial<SessionData> }> {
  const result = await runAgentTurn(telegramId, { kind: "resume" });

  const sessionPatch = sessionPatchAfterRadar(result);

  if (result.reply) {
    if (result.voicePromptRequested === true) {
      const language = (await userLanguage(telegramId)) ?? "en";
      const ask = voicePromptAskPayload(language, result.reply);
      try {
        await api.sendMessage(chatId, ask.text, ask.options);
        sessionPatch.expectingVoicePrompt = true;
        // The ask carries the voice panel, which REPLACES whatever the photo
        // stage had up — so the session has to agree, or the next sync reads a
        // stale "photos" and emits a removal that kills it.
        sessionPatch.replyPanel = "voice";
      } catch {
        // Same best-effort contract as the ordinary reply below.
      }
      return { sessionPatch };
    }

    let panelMarkup: ReturnType<typeof replyPanelMarkupFor> | undefined;
    if (sessionPatch.expectingPhoto === true) {
      panelMarkup = replyPanelMarkupFor("photos", (await userLanguage(telegramId)) ?? "en");
    }
    try {
      await api.sendMessage(chatId, result.reply, panelMarkup ?? {});
      if (panelMarkup) sessionPatch.replyPanel = "photos";
    } catch {
      // Best-effort, unchanged: a failed resume message must not fail the radar
      // save the Mini App depends on.
    }
  }

  return { sessionPatch };
}

export interface RadarThinkingOptions {
  /** Injectable wait — tests pass a no-op so the ~10s sequence costs nothing. */
  wait?: (ms: number) => Promise<void>;
  /** Injectable `[0,1)` source for the scan-counter curve (tests seed it). */
  rng?: () => number;
}


export async function runRadarThinkingThenResume(
  api: Api<RawApi>,
  telegramId: bigint,
  chatId: number,
  options: RadarThinkingOptions = {},
): Promise<{ sessionPatch: Partial<SessionData> }> {
  if (env.RADAR_THINKING_ENABLED) {
    const wait = options.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    try {
      await wait(RADAR_MINI_APP_CLOSE_LEAD_MS);
      const lang = (await userLanguage(telegramId)) ?? "en";
      await runStatusSequence(api, chatId, radarThinkingSteps(lang, options.rng), {
        rich: true,
        ...(options.wait ? { wait: options.wait } : {}),
      });
    } catch (err) {
      console.warn("[radar] thinking sequence failed", {
        telegramId: String(telegramId),
        err,
      });
    }
  }
  return resumeOnboardingAfterRadar(api, telegramId, chatId);
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

async function userLanguage(telegramId: bigint): Promise<Language | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { language: true },
  });
  return (user?.language ?? null) as Language | null;
}
