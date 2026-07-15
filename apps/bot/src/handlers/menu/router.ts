import { Composer } from "grammy";
import type { BotContext } from "../../session.js";
import { showMainMenu } from "./main.js";
import { handleMyProfile } from "./my-profile.js";
import { handleMyDate } from "./my-date.js";
import {
  handleEditOpen,
  handleEditBioStart,
  handleEditBioInput,
  handleEditMajorStart,
  handleEditMajorInput,
  handleEditPrefsOpen,
  handleEditAgeRangeStart,
  handleEditAgeRangeInput,
  handleEditPhotosStart,
  handleEditPhotosUpload,
  handleEditPhotosAdd,
  handleEditPhotosDelete,
} from "./edit-profile.js";
import {
  handleEditVideoStart,
  handleEditVideoUpload,
  handleEditVideoRemove,
} from "./video.js";
import { handlePause, handleResume } from "./pause.js";
import {
  handleSettingsOpen,
  handleSettingsLanguageOpen,
  handleSettingsLanguageSet,
  handleSettingsThemeOpen,
  handleSettingsThemeSet,
  handleSettingsVerify,
  handleDeleteAccountStart,
  handleFreezeAccount,
  handleDeleteAccountConfirm,
  handleDeleteAccountExecute,
} from "./settings.js";
import { handleHelp } from "./help.js";
import { handleMyTickets } from "./tickets.js";
import { runMenuAgentTurn, splitReplyIntoBubbles } from "../../services/menu-agent.js";

/**
 * Post-onboarding menu router.
 *
 * Active when `ctx.session.onboardingStep === "completed"`.
 * Dispatches by callback_data prefix and by `menuState` for multi-turn flows.
 */
const menuRouter = new Composer<BotContext>();

menuRouter.on(["message", "callback_query:data"], async (ctx) => {
  // Only act on completed users — guard for safety, the main router also checks.
  if (ctx.session.onboardingStep !== "completed") return;

  const data = ctx.callbackQuery?.data;

  // -----------------------------------------------------------------------
  // Multi-turn sub-flows: consume raw messages based on menuState
  // -----------------------------------------------------------------------

  // Edit photos: consumes raw photo messages.
  if (ctx.session.menuState === "edit_photos") {
    if (!data || data === "menu:edit:photos:continue") {
      await handleEditPhotosUpload(ctx);
      return;
    }
    if (data === "menu:edit:photos:add") {
      await handleEditPhotosAdd(ctx);
      return;
    }
    if (data.startsWith("menu:edit:photos:del:")) {
      await handleEditPhotosDelete(ctx);
      return;
    }
    // If the user taps another menu action mid-upload, fall through and reset state.
    ctx.session.menuState = "idle";
    ctx.session.pendingPhotos = [];
    ctx.session.pendingProfileMedia = [];
    ctx.session.pendingPhotoUniqueIds = [];
    ctx.session.pendingPhotoScores = [];
    ctx.session.photoManagerMsgId = null;
  }

  // Edit video: consumes a raw video message; Remove/Back are callbacks.
  if (ctx.session.menuState === "edit_video") {
    if (!data) {
      await handleEditVideoUpload(ctx);
      return;
    }
    if (data === "menu:video:remove") {
      await handleEditVideoRemove(ctx);
      return;
    }
    // Any other menu action mid-flow → reset state and fall through.
    ctx.session.menuState = "idle";
  }

  // Edit bio: consumes raw text messages.
  if (ctx.session.menuState === "edit_bio") {
    if (!data) {
      await handleEditBioInput(ctx);
      return;
    }
    // Button tap mid-flow → reset and fall through.
    ctx.session.menuState = "idle";
  }

  // Edit major: consumes raw text messages.
  if (ctx.session.menuState === "edit_major") {
    if (!data) {
      await handleEditMajorInput(ctx);
      return;
    }
    ctx.session.menuState = "idle";
  }

  // Edit age range: consumes raw text messages.
  if (ctx.session.menuState === "edit_age_range") {
    if (!data) {
      await handleEditAgeRangeInput(ctx);
      return;
    }
    ctx.session.menuState = "idle";
  }

  // -----------------------------------------------------------------------
  // No active sub-flow — free-form text goes to the LLM Router.
  // -----------------------------------------------------------------------
  if (!data) {
    if (isPinnedMessageServiceUpdate(ctx)) return;

    const text = ctx.message?.text?.trim();
    if (!text) {
      await showMainMenu(ctx);
      return;
    }

    try {
      const telegramId = BigInt(ctx.from!.id);
      const result = await runMenuAgentTurn(telegramId, text);
      const bubbles = splitReplyIntoBubbles(result.reply);
      for (let i = 0; i < bubbles.length; i++) {
        if (i > 0) {
          // A beat of "typing…" between bubbles so the split reads as chat,
          // not as a burst; scaled by bubble length, capped well under a nag.
          await ctx.replyWithChatAction("typing").catch(() => {});
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(1600, 350 + bubbles[i]!.length * 15)),
          );
        }
        await ctx.reply(bubbles[i]!);
      }
    } catch (err) {
      console.error("Menu agent error:", err);
      await showMainMenu(ctx);
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Callback routing
  // -----------------------------------------------------------------------
  switch (data) {
    case "menu:open":
    case "menu:back":
      await ctx.answerCallbackQuery();
      ctx.session.menuState = "idle";
      await showMainMenu(ctx);
      return;

    // My Profile
    case "menu:profile":
      await handleMyProfile(ctx);
      return;

    // My Date hub (conditional row — only present while a live match exists)
    case "menu:date":
      await handleMyDate(ctx);
      return;

    // Edit Profile
    case "menu:edit":
      await handleEditOpen(ctx);
      return;
    case "menu:edit:bio":
      await handleEditBioStart(ctx);
      return;
    case "menu:edit:major":
      await handleEditMajorStart(ctx);
      return;
    case "menu:edit:prefs":
      await handleEditPrefsOpen(ctx);
      return;
    case "menu:edit:prefs:age":
      await handleEditAgeRangeStart(ctx);
      return;
    case "menu:edit:photos":
      await handleEditPhotosStart(ctx);
      return;

    // Profile video (main-menu entry + stale Remove fallback)
    case "menu:video":
      await handleEditVideoStart(ctx);
      return;
    case "menu:video:remove":
      await handleEditVideoRemove(ctx);
      return;

    // Pause / Resume
    case "menu:pause":
      await handlePause(ctx);
      return;
    case "menu:resume":
      await handleResume(ctx);
      return;

    // Settings
    case "menu:settings":
      await handleSettingsOpen(ctx);
      return;
    case "menu:settings:lang":
      await handleSettingsLanguageOpen(ctx);
      return;
    case "menu:settings:theme":
      await handleSettingsThemeOpen(ctx);
      return;
    case "menu:settings:verify":
      await handleSettingsVerify(ctx);
      return;
    case "menu:settings:delete":
      await handleDeleteAccountStart(ctx);
      return;
    case "menu:settings:freeze":
      await handleFreezeAccount(ctx);
      return;
    case "menu:settings:delete:proceed":
      await handleDeleteAccountConfirm(ctx);
      return;
    case "menu:settings:delete:yes":
      await handleDeleteAccountExecute(ctx);
      return;

    // My Tickets (wallet + store; only reachable when TICKET_FEATURE_ENABLED)
    case "menu:tickets":
      await handleMyTickets(ctx);
      return;

    // Help
    case "menu:help":
      await handleHelp(ctx);
      return;

    default:
      if (data.startsWith("menu:lang:")) {
        await handleSettingsLanguageSet(ctx);
        return;
      }
      if (data.startsWith("menu:theme:")) {
        await handleSettingsThemeSet(ctx);
        return;
      }
  }
});

export { menuRouter };

export function isPinnedMessageServiceUpdate(ctx: BotContext): boolean {
  const message = ctx.message;
  return Boolean(message && "pinned_message" in message);
}
