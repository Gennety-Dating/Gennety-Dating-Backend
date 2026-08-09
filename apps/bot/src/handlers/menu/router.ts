import { Composer, InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { AGENT_DENIAL_COPY, evaluateAgentAccess } from "../../services/agent-access.js";
import { showMainMenu } from "./main.js";
import { handleMyProfile } from "./my-profile.js";
import { handleMyDate } from "./my-date.js";
import { handleCitySwitchConfirm, handleCitySwitchOpen } from "./city-switch.js";
import {
  handleEditOpen,
  handleEditBioStart,
  handleEditBioInput,
  handleEditMajorStart,
  handleEditMajorInput,
  handleEditPrefsOpen,
  handleEditPartnerPreferencesStart,
  handleEditPartnerPreferencesInput,
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
  handleDeleteAccountStart,
  handleFreezeAccount,
  handleDeleteAccountConfirm,
  handleDeleteAccountExecute,
} from "./settings.js";
import { handleHelp } from "./help.js";
import { handleMyTickets } from "./tickets.js";
import { handlePremiumHub } from "./premium.js";
import { handleReferralHub } from "./referral.js";
import { runMenuAgentTurn, splitReplyIntoBubbles } from "../../services/menu-agent.js";
import {
  isClaimableMenuState,
  menuClaimIsLive,
  releaseMenuClaim,
  updateReleasesMenuClaim,
} from "../../services/menu-text-claim.js";
import { retirePhotoCards } from "../../services/photo-cards.js";
import { invalidatePendingAccountAction } from "./account-action.js";
import {
  PREM_CANCEL_YES_PREFIX,
  PREM_CANCEL_KEEP_PREFIX,
  PREM_CANCEL_FINAL_YES_PREFIX,
  PREM_CANCEL_REASON_SKIP,
  sendPremiumCancelConfirm,
  sendPremiumCancelAppStoreGuide,
  handlePremiumCancelConfirm,
  handlePremiumCancelFinalConfirm,
  handlePremiumCancelKeep,
  handlePremiumCancelReasonInput,
  handlePremiumCancelReasonSkip,
  invalidatePendingPremiumCancel,
} from "./premium-cancel.js";

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
  const isAccountActionCallback =
    data?.startsWith("menu:settings:freeze:") ||
    data?.startsWith("menu:settings:delete:proceed:") ||
    data?.startsWith("menu:settings:delete:yes:");
  if (ctx.session.pendingAccountAction && !isAccountActionCallback) {
    await invalidatePendingAccountAction(ctx);
  }
  const isPremiumCancelCallback =
    data?.startsWith(PREM_CANCEL_YES_PREFIX) ||
    data?.startsWith(PREM_CANCEL_KEEP_PREFIX) ||
    data?.startsWith(PREM_CANCEL_FINAL_YES_PREFIX);
  if (ctx.session.pendingPremiumCancel && !isPremiumCancelCallback) {
    await invalidatePendingPremiumCancel(ctx);
  }

  // A menu sub-flow that reads plain text owns the chat only while its claim is
  // live. Past the deadline — or once the user has moved on to a command or a
  // button that isn't the claim's own — the state is dropped here, BEFORE any
  // sub-flow sees the update, so the message falls through to the concierge
  // agent instead of being written over a profile field
  // (`services/menu-text-claim.ts`).
  if (
    isClaimableMenuState(ctx.session.menuState) &&
    (updateReleasesMenuClaim(ctx.session, {
      callbackData: data,
      text: ctx.message?.text,
    }) ||
      !menuClaimIsLive(ctx.session, ctx.session.menuState))
  ) {
    releaseMenuClaim(ctx.session);
  }

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
    if (data === "menu:edit:photos:delcard") {
      await handleEditPhotosDelete(ctx);
      return;
    }
    // If the user taps another menu action mid-upload, fall through and reset state.
    // Retire the surface FIRST: this is the manager closing, exactly like ✅ Done
    // and like reopening it, so its buttons have to go with it. Clearing the
    // tracking on its own loses the message ids forever, which left every card's
    // 🗑 and the panel's ➕ / ✅ sitting in the chat looking live and doing
    // nothing — permanently, since a later reopen has nothing left to retire.
    if (ctx.chat) {
      await retirePhotoCards(ctx.api, ctx.chat.id, ctx.session);
    } else {
      ctx.session.photoCards = [];
      ctx.session.photoManagerMsgId = null;
    }
    ctx.session.menuState = "idle";
    ctx.session.verifyPhotoRedo = false;
    ctx.session.pendingPhotos = [];
    ctx.session.pendingProfileMedia = [];
    ctx.session.pendingPhotoUniqueIds = [];
    ctx.session.pendingPhotoHashes = [];
    ctx.session.pendingPhotoScores = [];
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

  if (ctx.session.menuState === "edit_partner_preferences") {
    if (!data) {
      await handleEditPartnerPreferencesInput(ctx);
      return;
    }
    ctx.session.menuState = "idle";
  }

  // After an in-chat Premium cancellation, capture the churn reason: the next
  // free-text message is the reason (not an agent turn); a Skip button exits.
  if (ctx.session.menuState === "awaiting_premium_cancel_reason") {
    if (!data) {
      await handlePremiumCancelReasonInput(ctx);
      return;
    }
    if (data === PREM_CANCEL_REASON_SKIP) {
      await handlePremiumCancelReasonSkip(ctx);
      return;
    }
    // Any other action mid-flow → drop the reason capture and fall through.
    ctx.session.menuState = "idle";
    ctx.session.premiumCancelLedgerId = null;
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

      // Who may talk to the agent at all. Shared with the JWT surface, so a
      // moderated or still-gated account cannot reach the tools by switching
      // transport (see `services/agent-access.ts`).
      const account = await prisma.user.findUnique({
        where: { telegramId },
        select: { status: true, onboardingStep: true, suspendedUntil: true },
      });
      const access = evaluateAgentAccess(account);
      if (!access.allowed) {
        // `not_onboarded` is unreachable here (this router only runs for
        // completed users) but is handled rather than asserted away.
        await ctx.reply(
          access.reason === "not_onboarded"
            ? t(ctx.session.language, "finishOnboardingFirst")
            : t(ctx.session.language, AGENT_DENIAL_COPY[access.reason]),
        );
        return;
      }

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
      // Code-owned confirmation of anything that was actually written, so a
      // profile change is a visible fact rather than the model's own claim.
      for (const receipt of result.receipts ?? []) {
        await ctx.reply(`✓ ${receipt}`);
      }
      // A tool may ask us to follow the reply with a native affordance the
      // agent can't render — the Premium cancel-confirm card / iOS guide, or a
      // single button into an existing flow.
      if (result.action?.kind === "premium_cancel_confirm") {
        await sendPremiumCancelConfirm(ctx);
      } else if (result.action?.kind === "premium_cancel_appstore") {
        await sendPremiumCancelAppStoreGuide(ctx);
      } else if (result.action?.kind === "entry_point") {
        const { label, callbackData } = result.action.entry;
        await ctx.reply(t(ctx.session.language, "agentEntryPrompt"), {
          reply_markup: new InlineKeyboard().text(label, callbackData),
        });
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

    // Switch to a launched market (conditional row — only present for an
    // account registered in a city Gennety hasn't launched, §1.1)
    case "menu:city":
      await handleCitySwitchOpen(ctx);
      return;
    case "menu:city:switch":
      await handleCitySwitchConfirm(ctx);
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
    case "menu:edit:prefs:description":
      await handleEditPartnerPreferencesStart(ctx);
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
    case "menu:settings:delete":
      await handleDeleteAccountStart(ctx);
      return;
    // Legacy destructive keyboards intentionally fail closed. Route them
    // through the token consumer so Telegram receives an explicit expiry
    // alert instead of leaving the callback spinner hanging.
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

    // Gennety Premium hub (only reachable when PREMIUM_FEATURE_ENABLED)
    case "menu:premium":
      await handlePremiumHub(ctx);
      return;

    // Referral hub (only reachable when REFERRAL_FEATURE_ENABLED)
    case "menu:referral":
      await handleReferralHub(ctx);
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
      if (data.startsWith("menu:settings:freeze:")) {
        await handleFreezeAccount(ctx);
        return;
      }
      if (data.startsWith("menu:settings:delete:proceed:")) {
        await handleDeleteAccountConfirm(ctx);
        return;
      }
      if (data.startsWith("menu:settings:delete:yes:")) {
        await handleDeleteAccountExecute(ctx);
        return;
      }
      // In-chat Premium cancellation — two-stage nonce-bound confirm (offer →
      // final) / keep / reason skip, mirroring the Freeze/Delete fork.
      if (data.startsWith(PREM_CANCEL_FINAL_YES_PREFIX)) {
        await handlePremiumCancelFinalConfirm(ctx);
        return;
      }
      if (data.startsWith(PREM_CANCEL_YES_PREFIX)) {
        await handlePremiumCancelConfirm(ctx);
        return;
      }
      if (data.startsWith(PREM_CANCEL_KEEP_PREFIX)) {
        await handlePremiumCancelKeep(ctx);
        return;
      }
      if (data === PREM_CANCEL_REASON_SKIP) {
        await handlePremiumCancelReasonSkip(ctx);
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});
      return;
  }
});

export { menuRouter };

export function isPinnedMessageServiceUpdate(ctx: BotContext): boolean {
  const message = ctx.message;
  return Boolean(message && "pinned_message" in message);
}
