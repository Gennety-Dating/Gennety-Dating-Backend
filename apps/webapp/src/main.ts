import { generateSlots, formatSlot } from "./slots.js";
import { loadPickedIso, savePickedIso, clearPicked } from "./device-storage.js";

/**
 * Entry point for the Gennety Calendar Mini App.
 *
 * Iteration 3 of progressive scheduling (PRODUCT_SPEC.md §3.3):
 *   1. User opens this Web App via the `matchScheduleBtnCalendar` button.
 *   2. We read the match id from `Telegram.WebApp.initDataUnsafe.start_param`
 *      (set via the `?match=` param on the t.me link), restore any
 *      previous selection from DeviceStorage, and render the slot grid.
 *   3. Tapping a slot caches it in DeviceStorage and posts it back to
 *      the bot as `{ matchId, pickedIso }` via `Telegram.WebApp.sendData`.
 *
 * There is *no chat UI* and no free-text input — in line with the
 * Zero-Chat core principle.
 */

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

const matchId = app?.initDataUnsafe?.start_param ?? new URLSearchParams(location.search).get("match") ?? "";

const slots = generateSlots();
const container = document.getElementById("slots");

if (!matchId || !container) {
  if (container) container.textContent = "No match context — reopen this from the bot.";
} else {
  renderSlots();
}

async function renderSlots(): Promise<void> {
  const previouslyPicked = await loadPickedIso(matchId);

  for (const slot of slots) {
    const btn = document.createElement("button");
    btn.className = "slot";
    btn.textContent = formatSlot(slot);
    const iso = slot.toISOString();
    if (previouslyPicked === iso) btn.classList.add("selected");

    btn.addEventListener("click", () => {
      void onPick(iso, btn);
    });
    container!.appendChild(btn);
  }
}

async function onPick(iso: string, clicked: HTMLButtonElement): Promise<void> {
  // Visually mark selection
  for (const el of container!.querySelectorAll<HTMLButtonElement>("button.slot")) {
    el.classList.remove("selected");
  }
  clicked.classList.add("selected");

  await savePickedIso(matchId, iso);

  if (!app) {
    console.log("Picked", { matchId, iso });
    return;
  }
  app.sendData(JSON.stringify({ matchId, pickedIso: iso }));
  // `sendData` auto-closes the Web App, but call close() as belt+braces.
  // After a successful submission we can also clear the cache.
  void clearPicked(matchId);
  app.close();
}
