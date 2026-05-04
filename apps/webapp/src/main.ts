import { generateSlots, formatSlot } from "./slots.js";
import { loadPickedIso, savePickedIso, clearPicked } from "./device-storage.js";
import { postCalendarPick, CalendarApiError } from "./api.js";

/**
 * Entry point for the Gennety Calendar Mini App.
 *
 * Iteration 3 of progressive scheduling (PRODUCT_SPEC.md §3.3).
 *
 * UX flow:
 *   1. We receive the match id from `Telegram.WebApp.initDataUnsafe.start_param`
 *      (set via `?match=` on the t.me link the bot posts).
 *   2. Render the slot grid; restore any prior selection from DeviceStorage.
 *   3. User taps a slot → highlight + cache. The native MainButton at the
 *      bottom appears with text "Confirm".
 *   4. User taps Confirm → POST `/v1/calendar/pick` to the bot's public API
 *      with `Authorization: tma <initData>`. The bot validates the HMAC,
 *      records the pick, and DMs the user accordingly.
 *   5. On 2xx → close the Mini App. On error → showAlert and let the user
 *      retry without losing their selection.
 *
 * Why we don't use `Telegram.WebApp.sendData`: it's silently a no-op for Mini
 * Apps opened via InlineKeyboardButton (our production launch context). See
 * `apps/bot/src/public/routes/calendar.ts` for context.
 */

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

const matchId =
  app?.initDataUnsafe?.start_param ??
  new URLSearchParams(location.search).get("match") ??
  "";

const slots = generateSlots();
const container = document.getElementById("slots");

let selectedIso: string | null = null;
let confirming = false;

if (!matchId || !container) {
  if (container) container.textContent = "No match context — reopen this from the bot.";
} else {
  void renderSlots();
  if (app) {
    app.MainButton.setText("Confirm");
    app.MainButton.disable();
    app.MainButton.hide();
    app.MainButton.onClick(handleConfirm);
  }
}

async function renderSlots(): Promise<void> {
  const previouslyPicked = await loadPickedIso(matchId);

  for (const slot of slots) {
    const btn = document.createElement("button");
    btn.className = "slot";
    btn.textContent = formatSlot(slot);
    const iso = slot.toISOString();
    if (previouslyPicked === iso) {
      btn.classList.add("selected");
      onSelect(iso);
    }

    btn.addEventListener("click", () => {
      // Visually mark selection in-DOM
      for (const el of container!.querySelectorAll<HTMLButtonElement>("button.slot")) {
        el.classList.remove("selected");
      }
      btn.classList.add("selected");
      onSelect(iso);
    });
    container!.appendChild(btn);
  }
}

function onSelect(iso: string): void {
  selectedIso = iso;
  void savePickedIso(matchId, iso);
  if (app) {
    app.MainButton.show();
    app.MainButton.enable();
  }
}

async function handleConfirm(): Promise<void> {
  if (!app || !selectedIso || confirming) return;
  confirming = true;
  app.MainButton.showProgress();
  app.MainButton.disable();

  try {
    await postCalendarPick(app.initData, matchId, selectedIso);
    void clearPicked(matchId);
    app.close();
  } catch (err) {
    confirming = false;
    app.MainButton.hideProgress();
    app.MainButton.enable();
    const msg = errorMessage(err);
    app.showAlert(msg);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof CalendarApiError) {
    switch (err.reason) {
      case "expired":
      case "missing-hash":
      case "bad-hash":
      case "missing-auth-date":
        return "This calendar link expired. Please reopen it from the bot.";
      case "match-not-found":
      case "user-not-found":
        return "We couldn't find this match anymore. Please reopen the calendar from the bot.";
      case "invalid-slot":
        return "That slot isn't available anymore. Pick another one.";
      case "wrong-state":
        return "This match isn't waiting for a calendar pick.";
      case "not-participant":
        return "You're not part of this match.";
      default:
        return `Couldn't save your pick (HTTP ${err.status}). Try again.`;
    }
  }
  return "Network error. Check your connection and try again.";
}
