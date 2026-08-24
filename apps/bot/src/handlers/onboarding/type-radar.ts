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
import { voicePromptAskText, voicePromptKeyboard } from "./voice-prompt.js";
import { photoStagePanelMarkup } from "../../services/photo-stage-panel.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import {
  radarThinkingSteps,
  RADAR_MINI_APP_CLOSE_LEAD_MS,
} from "../../services/radar-thinking.js";

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

  const sessionPatch = sessionPatchAfterRadar(result);

  if (result.reply) {
    // On the declined path this reply IS the photo request — i.e. the upload
    // stage's first plain-text message, which is where the persistent bottom
    // panel attaches (PRODUCT_SPEC §1.3). The radar gate intercepts the photos
    // question before `handleConversational` ever sends it, so without doing it
    // here the panel simply never appears while TYPE_RADAR_ENABLED is on —
    // which is every environment since 2026-07-23.
    //
    // The flag is set only after the send actually succeeds: marking the panel
    // shown when its message was lost would suppress every later attempt to
    // establish it, leaving the user with no way into the editor at all.
    // A radar resume lands on ai_memory or photos, never on the voice prompt
    // (that question sits after photos), so this branch is unreachable today.
    // It is here anyway because the alternative is an exception in the
    // one-sender rule, and an exception is how the eight bare senders happened:
    // the reply is delivered from nine places and only the rule keeps them
    // agreeing. This function owns no session, so the claim rides the patch.
    if (result.voicePromptRequested === true) {
      const language = (await userLanguage(telegramId)) ?? "en";
      try {
        await api.sendMessage(chatId, voicePromptAskText(language, result.reply), {
          reply_markup: voicePromptKeyboard(language),
        });
        sessionPatch.expectingVoicePrompt = true;
      } catch {
        // Same best-effort contract as the ordinary reply below.
      }
      return { sessionPatch };
    }

    let panelMarkup: ReturnType<typeof photoStagePanelMarkup> | undefined;
    if (sessionPatch.expectingPhoto === true) {
      panelMarkup = photoStagePanelMarkup((await userLanguage(telegramId)) ?? "en");
    }
    try {
      await api.sendMessage(chatId, result.reply, panelMarkup ?? {});
      if (panelMarkup) sessionPatch.photoStagePanelShown = true;
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

/**
 * Play the Type Radar "thinking state" sequence, then resume onboarding —
 * the completion path for a user who actually rated the deck
 * (`TYPE_RADAR_PRODUCT_SPEC.md`).
 *
 * Ordering matters. The caller has already answered the Mini App's submit
 * request, so this runs detached while the Mini App finishes its own ✓ screen;
 * we wait {@link RADAR_MINI_APP_CLOSE_LEAD_MS} for it to close, play the status
 * beats in the now-visible chat, and only then resume the agent — whose next
 * message (Magic Prompt or photo request) lands in the deleted status's place.
 *
 * The sequence is cosmetic and must never cost the user their next onboarding
 * step: everything up to the resume is caught, and `runStatusSequence` already
 * swallows send/edit/delete failures on its own. A resume failure still
 * propagates so the caller logs it exactly as before.
 *
 * NOT used by the Skip path — nothing was rated there, so "Checking your
 * ratings" would be a straight-up lie.
 */
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
