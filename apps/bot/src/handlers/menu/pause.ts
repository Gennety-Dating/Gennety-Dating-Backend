import type { BotContext } from "../../session.js";
import { t } from "@gennety/shared";
import { showMainMenu } from "./main.js";
import { transitionAccountStatus } from "../../services/account-status-transitions.js";

/** Pause matching — flips User.status to "paused". */
export async function handlePause(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const result = await transitionAccountStatus({ telegramId }, "pause");
  if (result.kind === "forbidden" || result.kind === "not_found") {
    await ctx.reply(t(lang, "statusActionUnavailable"));
    await showMainMenu(ctx);
    return;
  }

  if (result.kind === "changed") await ctx.reply(t(lang, "pauseConfirmed"));
  await showMainMenu(ctx);
}

/** Resume matching — flips User.status back to "active". */
export async function handleResume(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const result = await transitionAccountStatus({ telegramId }, "resume");
  if (result.kind === "forbidden" || result.kind === "not_found") {
    await ctx.reply(t(lang, "statusActionUnavailable"));
    await showMainMenu(ctx);
    return;
  }

  if (result.kind === "changed") await ctx.reply(t(lang, "resumeConfirmed"));
  await showMainMenu(ctx);
}
