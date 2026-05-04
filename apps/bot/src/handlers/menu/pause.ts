import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { showMainMenu } from "./main.js";
import { canResumeMatching } from "../../services/user-status.js";

/** Pause matching — flips User.status to "paused". */
export async function handlePause(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  await prisma.user.update({
    where: { telegramId },
    data: { status: "paused" },
  });

  await ctx.reply(t(lang, "pauseConfirmed"));
  await showMainMenu(ctx);
}

/** Resume matching — flips User.status back to "active". */
export async function handleResume(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { status: true },
  });
  if (!canResumeMatching(user?.status)) {
    await showMainMenu(ctx);
    return;
  }

  await prisma.user.update({
    where: { telegramId },
    data: { status: "active" },
  });

  await ctx.reply(t(lang, "resumeConfirmed"));
  await showMainMenu(ctx);
}
