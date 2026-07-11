import { formatDate, formatSlot, formatTime, slotDayKey } from "./slots.js";
import {
  savePickedSet,
  loadPickedSet,
  clearPicked,
  savePeerSeen,
  loadPeerSeen,
} from "./device-storage.js";
import {
  fetchCalendarState,
  postCalendarPicks,
  CalendarApiError,
  type CalendarState,
} from "./api.js";
import { hasNewSlot, pruneSlotsToProposedTimes } from "./calendar-selection.js";
import { pickLang, tr, type Lang } from "./i18n.js";
import { classifyDaySlots, classifySlot, type DayClass, type SlotClass } from "./state-render.js";

/**
 * Calendar Mini App entry point.
 *
 * View states (PRODUCT_SPEC.md §3.6):
 *   - 'dates'        — pick a calendar day; tap opens the time bottom sheet
 *   - 'agreed'       — server locked in a single slot, success card
 *   - 'multi-overlap'— post-save state when intersection > 1; user picks
 *                       the final one via radio buttons + Confirm
 *   - 'waiting'      — post-save state when actor saved first and peer
 *                       hasn't replied; success card + Close / Edit buttons
 *
 * Time picking happens in a native-feeling bottom sheet on top of the dates
 * view rather than a separate screen — tapping a date slides up the slot
 * list, tapping backdrop / Telegram BackButton collapses it back.
 *
 * Polling: 4s while document is visible. State fingerprint guards against
 * re-rendering when nothing material changed (keeps the sheet alive across
 * polls).
 */

const POLL_MS = 4000;
const SHEET_ANIM_MS = 320;

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

// Bot API 8.0+ — fullscreen mode removes the top sheet gap and lets the
// design's hero/CTA composition breathe. Older clients silently skip.
try {
  if (app?.isVersionAtLeast?.("8.0") && !app.isFullscreen) {
    app.requestFullscreen?.();
  }
  const chromeColor =
    document.documentElement.dataset.theme === "light" ? "#f5f5f5" : "#030303";
  app?.setHeaderColor?.(chromeColor);
  app?.setBackgroundColor?.(chromeColor);
  app?.setBottomBarColor?.(chromeColor);
} catch {
  // Best-effort cosmetic boot — never crash the app over chrome theming.
}

// In fullscreen mode Telegram floats the close × / menu ⋯ buttons over the
// content, and `env(safe-area-inset-top)` does not include them. Pull the
// real reserve from `contentSafeAreaInset` so the title doesn't slide under
// the chrome. Sub to `contentSafeAreaChanged` because the value updates
// when the user toggles fullscreen or the keyboard appears.
applyContentInsets();
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any)?.onEvent?.("contentSafeAreaChanged", applyContentInsets);
} catch {
  // Older clients without the event — fallback CSS value still applies.
}

function applyContentInsets(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inset = (app as any)?.contentSafeAreaInset;
  if (!inset) return;
  if (typeof inset.top === "number" && inset.top > 0) {
    document.documentElement.style.setProperty("--tg-content-top", `${inset.top}px`);
  }
  if (typeof inset.bottom === "number" && inset.bottom >= 0) {
    document.documentElement.style.setProperty("--tg-content-bottom", `${inset.bottom}px`);
  }
}

const params = new URLSearchParams(location.search);
const matchId = app?.initDataUnsafe?.start_param ?? params.get("match") ?? "";
const lang: Lang = pickLang(params.get("lang") ?? app?.initDataUnsafe?.user?.language_code);
document.documentElement?.setAttribute("lang", lang);

const pageEl = document.getElementById("page");
const titleEl = document.getElementById("title");
const bannerEl = document.getElementById("banner");
const slotsEl = document.getElementById("slots");
const agreedEl = document.getElementById("agreed");
const waitingEl = document.getElementById("waiting");
const multiOverlapEl = document.getElementById("multi-overlap");
const noContextEl = document.getElementById("no-context");
const legendEl = document.getElementById("legend");
const ctaBarEl = document.getElementById("cta-bar");
const ctaBtnEl = document.getElementById("cta") as HTMLButtonElement | null;
const ctaLabelEl = ctaBtnEl?.querySelector<HTMLSpanElement>(".label") ?? null;
const confettiCanvasEl = document.getElementById("confetti-canvas");
const sheetEl = document.getElementById("sheet");
const sheetBackdropEl = document.getElementById("sheet-backdrop");
const sheetTitleEl = document.getElementById("sheet-title");
const sheetBodyEl = document.getElementById("sheet-body");
const sheetCtaEl = document.getElementById("sheet-cta") as HTMLButtonElement | null;
const sheetCtaLabelEl = sheetCtaEl?.querySelector<HTMLSpanElement>(".label") ?? null;

type ViewState = "dates" | "agreed" | "multi-overlap" | "waiting";

interface DayGroup {
  key: string;
  date: Date;
  isos: string[];
}

let view: ViewState = "dates";
let proposedTimes: string[] = [];
let peerSlots = new Set<string>();
let peerSeen = new Set<string>();
let confirmedMine = new Set<string>();
let selected = new Set<string>();
let agreedTime: string | null = null;
let overlapCandidates: string[] = [];
let multiOverlapChoice: string | null = null;
let sheetDayKey: string | null = null;
let isFirstMover = true;
let saving = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let sheetHideTimer: ReturnType<typeof setTimeout> | null = null;

if (titleEl) titleEl.textContent = tr(lang, "titleDate");
applyLegendCopy();
ctaBtnEl?.addEventListener("click", handleAnyCtaClick);
sheetCtaEl?.addEventListener("click", handleAnyCtaClick);
sheetBackdropEl?.addEventListener("click", () => closeSheet(true));
setupSheetDrag();
// Telegram BackButton — collapses the sheet rather than killing the app.
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any)?.BackButton?.onClick?.(onBackButton);
} catch {
  // Older clients ignore.
}

// Swipe-down on the handle / header collapses the sheet. We intentionally
// don't intercept touches over the scrollable body so the user can still
// scroll the slot list — only the top drag-affordance area pulls down.
function setupSheetDrag(): void {
  if (!sheetEl) return;
  const handle = sheetEl.querySelector<HTMLElement>(".sheet-handle");
  const header = sheetEl.querySelector<HTMLElement>(".sheet-header");
  const targets = [handle, header].filter((el): el is HTMLElement => el !== null);
  if (targets.length === 0) return;

  let startY = 0;
  let deltaY = 0;
  let dragging = false;

  const onStart = (e: TouchEvent): void => {
    if (!sheetEl.classList.contains("is-open")) return;
    if (e.touches.length !== 1) return;
    startY = e.touches[0]!.clientY;
    deltaY = 0;
    dragging = true;
    sheetEl.style.transition = "none";
    if (sheetBackdropEl) sheetBackdropEl.style.transition = "none";
  };

  const onMove = (e: TouchEvent): void => {
    if (!dragging) return;
    const y = e.touches[0]!.clientY;
    deltaY = Math.max(0, y - startY);
    sheetEl.style.transform = `translateY(${deltaY}px)`;
    if (sheetBackdropEl) {
      sheetBackdropEl.style.opacity = String(Math.max(0.15, 1 - deltaY / 400));
    }
  };

  const onEnd = (): void => {
    if (!dragging) return;
    dragging = false;
    sheetEl.style.transition = "";
    if (sheetBackdropEl) sheetBackdropEl.style.transition = "";
    if (deltaY > 80) {
      // Past threshold — animate the rest of the way down.
      sheetEl.style.transform = "";
      if (sheetBackdropEl) sheetBackdropEl.style.opacity = "";
      closeSheet(true);
    } else {
      // Snap back to fully open.
      sheetEl.style.transform = "";
      if (sheetBackdropEl) sheetBackdropEl.style.opacity = "";
    }
  };

  for (const el of targets) {
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
  }
}

if (!matchId || !slotsEl) {
  if (noContextEl) {
    noContextEl.textContent = tr(lang, "noContext");
    noContextEl.hidden = false;
  }
  if (pageEl) pageEl.hidden = true;
} else {
  void boot();
}

async function boot(): Promise<void> {
  const cached = await loadPickedSet(matchId);
  if (cached && cached.length > 0) selected = new Set(cached);

  try {
    const state = await fetchCalendarState(app!.initData, matchId);
    applyState(state, /* firstLoad */ true);
  } catch (err) {
    if (err instanceof CalendarApiError) {
      app?.showAlert(errorMessage(err));
    } else {
      app?.showAlert(tr(lang, "errNetwork"));
    }
    return;
  }

  // Seed the "peer-seen" snapshot. First-ever open snapshots whatever peer
  // already has — nothing flashes NEW. From then on, NEW = peerSlots minus
  // the snapshot, refreshed at every successful save.
  const cachedSeen = await loadPeerSeen(matchId);
  if (cachedSeen !== null) {
    peerSeen = new Set(cachedSeen);
  } else {
    peerSeen = new Set(peerSlots);
    void savePeerSeen(matchId, Array.from(peerSeen));
  }

  if (agreedTime) view = "agreed";
  render();
  schedulePoll();
  document.addEventListener("visibilitychange", onVisibility);
}

function applyState(state: CalendarState, firstLoad: boolean): void {
  proposedTimes = state.proposedTimes;
  peerSlots = new Set(state.peerSlots);
  confirmedMine = new Set(state.mySlots);
  agreedTime = state.agreedTime;
  isFirstMover = state.isFirstMover;
  selected = pruneSlotsToProposedTimes(selected, proposedTimes);

  // First load with no draft: mirror server picks so re-tapping un-selects.
  // Returning users with a draft keep their unsaved changes.
  if (firstLoad && selected.size === 0) {
    selected = new Set(confirmedMine);
  }
}

function render(): void {
  hideStatics();

  // Sheet lifecycle in one place: visible iff we're on dates AND a day is
  // selected. Covers the post-save case where `view` stayed "dates" but
  // `sheetDayKey` got cleared — without this the sheet (and its spinner)
  // hung over the dates list.
  const shouldShowSheet = view === "dates" && sheetDayKey !== null;
  if (!shouldShowSheet) {
    hideSheet(false);
  }

  switch (view) {
    case "agreed":
      renderAgreed();
      break;
    case "multi-overlap":
      renderMultiOverlap();
      break;
    case "waiting":
      renderWaiting();
      break;
    case "dates":
    default:
      renderDates();
      if (sheetDayKey !== null) {
        // Polling-triggered renders keep the sheet alive so the user
        // doesn't get yanked back to the date list mid-pick.
        const group = groupedByDay().find((g) => g.key === sheetDayKey);
        if (!group) {
          closeSheet(false);
        } else {
          buildSheetContent(group);
          ensureSheetVisible();
        }
      }
  }
}

function hideStatics(): void {
  if (slotsEl) {
    slotsEl.hidden = true;
    slotsEl.innerHTML = "";
  }
  if (agreedEl) {
    agreedEl.hidden = true;
    agreedEl.innerHTML = "";
    agreedEl.className = "";
  }
  if (waitingEl) {
    waitingEl.hidden = true;
    waitingEl.innerHTML = "";
    waitingEl.className = "";
  }
  if (multiOverlapEl) {
    multiOverlapEl.hidden = true;
    multiOverlapEl.innerHTML = "";
  }
  if (bannerEl) {
    bannerEl.hidden = true;
    bannerEl.className = "";
    bannerEl.textContent = "";
  }
  if (legendEl) legendEl.hidden = true;
  if (titleEl) titleEl.hidden = false;
  hideCta();
  hideConfetti();
}

// ── CTA ────────────────────────────────────────────────────────

function showCta(label: string, options: { disabled?: boolean } = {}): void {
  if (!ctaBarEl || !ctaBtnEl) return;
  ctaBarEl.hidden = false;
  if (ctaLabelEl) ctaLabelEl.textContent = label;
  ctaBtnEl.classList.remove("is-loading");
  ctaBtnEl.disabled = options.disabled === true;
}

function hideCta(): void {
  if (!ctaBarEl || !ctaBtnEl) return;
  ctaBarEl.hidden = true;
  ctaBtnEl.classList.remove("is-loading");
  ctaBtnEl.disabled = false;
}

function setCtaLoading(label: string): void {
  if (!ctaBarEl || !ctaBtnEl) return;
  ctaBarEl.hidden = false;
  if (ctaLabelEl) ctaLabelEl.textContent = label;
  ctaBtnEl.classList.add("is-loading");
  ctaBtnEl.disabled = true;
}

function handleAnyCtaClick(): void {
  if (saving) return;
  if (view === "multi-overlap") {
    void handleConfirmOverlap();
  } else if (view === "agreed") {
    app?.close();
  } else {
    void handleSave();
  }
}

function setSheetCtaState(canSubmit: boolean): void {
  if (!sheetCtaEl || !sheetCtaLabelEl) return;
  sheetCtaEl.classList.remove("is-loading");
  sheetCtaEl.disabled = !canSubmit;
  sheetCtaLabelEl.textContent = tr(lang, canSubmit ? saveButtonKey() : "btnSave");
}

function setSheetCtaLoading(label: string): void {
  if (!sheetCtaEl || !sheetCtaLabelEl) return;
  sheetCtaEl.classList.add("is-loading");
  sheetCtaEl.disabled = true;
  sheetCtaLabelEl.textContent = label;
}

function onBackButton(): void {
  if (sheetDayKey !== null) closeSheet(true);
}

// ── Bottom sheet ───────────────────────────────────────────────

function buildSheetContent(group: DayGroup): void {
  if (sheetTitleEl) sheetTitleEl.textContent = formatDate(group.date, lang);
  if (!sheetBodyEl) return;
  sheetBodyEl.innerHTML = "";
  for (const iso of group.isos) {
    const btn = renderSlotShell(iso, "time");
    const cls = classifySlot(iso, selected, peerSlots);
    paintSlotState(btn, cls, null, formatTime(new Date(iso), lang), isNewPeerSlot(iso));
    btn.addEventListener("click", () => onTapTime(iso));
    sheetBodyEl.appendChild(btn);
  }
  setSheetCtaState(canSubmitSelection());
}

function openSheet(): void {
  if (!sheetEl || !sheetBackdropEl) return;
  if (sheetHideTimer !== null) {
    clearTimeout(sheetHideTimer);
    sheetHideTimer = null;
  }
  // Wipe any leftover inline drag styles from a previous interaction so
  // the .is-open transition starts cleanly from translateY(100%).
  sheetEl.style.transform = "";
  sheetEl.style.transition = "";
  sheetBackdropEl.style.opacity = "";
  sheetBackdropEl.style.transition = "";
  const wasHidden = sheetEl.hasAttribute("hidden");
  sheetEl.removeAttribute("hidden");
  sheetBackdropEl.removeAttribute("hidden");
  if (wasHidden) {
    // Force layout so the transition fires from translateY(100%).
    void sheetEl.offsetHeight;
    requestAnimationFrame(() => {
      sheetEl.classList.add("is-open");
      sheetBackdropEl.classList.add("is-open");
    });
  } else {
    sheetEl.classList.add("is-open");
    sheetBackdropEl.classList.add("is-open");
  }
  setSheetCtaState(canSubmitSelection());
  hideCta();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any)?.BackButton?.show?.();
  } catch {
    // ignored
  }
}

function ensureSheetVisible(): void {
  if (!sheetEl) return;
  if (sheetEl.hasAttribute("hidden")) {
    openSheet();
  } else {
    setSheetCtaState(canSubmitSelection());
    hideCta();
  }
}

function closeSheet(animate: boolean): void {
  sheetDayKey = null;
  if (!sheetEl || !sheetBackdropEl) {
    updateCtaForPicker();
    return;
  }
  sheetEl.classList.remove("is-open");
  sheetBackdropEl.classList.remove("is-open");
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (app as any)?.BackButton?.hide?.();
  } catch {
    // ignored
  }
  if (sheetHideTimer !== null) {
    clearTimeout(sheetHideTimer);
    sheetHideTimer = null;
  }
  if (animate) {
    sheetHideTimer = setTimeout(() => {
      sheetEl.setAttribute("hidden", "");
      sheetBackdropEl.setAttribute("hidden", "");
      sheetHideTimer = null;
    }, SHEET_ANIM_MS);
  } else {
    sheetEl.setAttribute("hidden", "");
    sheetBackdropEl.setAttribute("hidden", "");
  }
  updateCtaForPicker();
}

function hideSheet(animate: boolean): void {
  if (sheetDayKey === null && sheetEl?.hasAttribute("hidden")) return;
  closeSheet(animate);
}

// ── Renderers ──────────────────────────────────────────────────

function renderAgreed(): void {
  if (!agreedEl || !agreedTime) return;
  if (titleEl) titleEl.hidden = true;
  agreedEl.hidden = false;
  agreedEl.classList.add("success-page");
  agreedEl.innerHTML = `
    <svg class="check-svg" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 13L9 17L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <div class="agreed-card">
      <h2 class="agreed-date" data-role="date"></h2>
      <p class="agreed-time" data-role="time"></p>
    </div>
    <p class="agreed-subtitle" data-role="subtitle"></p>
    <button type="button" class="remind-chip" data-role="remind">
      <span class="remind-chip-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </span>
      <span class="remind-chip-label" data-role="remind-label"></span>
    </button>
  `;
  const slot = new Date(agreedTime);
  agreedEl.querySelector<HTMLElement>('[data-role="date"]')!.textContent =
    formatDate(slot, lang);
  agreedEl.querySelector<HTMLElement>('[data-role="time"]')!.textContent =
    formatTime(slot, lang);
  agreedEl.querySelector<HTMLElement>('[data-role="subtitle"]')!.textContent =
    tr(lang, "agreedSubtitle");

  const remindBtn = agreedEl.querySelector<HTMLButtonElement>('[data-role="remind"]')!;
  const remindLabel = agreedEl.querySelector<HTMLElement>('[data-role="remind-label"]')!;
  remindLabel.textContent = tr(lang, "btnRemind");
  // Cosmetic only — date-lifecycle.ts already sends the T-3h ice-breaker
  // + T-1h safety brief, so a real reminder schedule isn't needed.
  remindBtn.addEventListener("click", () => {
    if (remindBtn.classList.contains("is-armed")) return;
    remindBtn.classList.add("is-armed");
    remindLabel.textContent = tr(lang, "btnRemindArmed");
    app?.HapticFeedback?.impactOccurred?.("light");
  });

  showCta(tr(lang, "btnClose"));
  runConfetti();
}

function renderWaiting(): void {
  if (!waitingEl) return;
  if (titleEl) titleEl.hidden = true;
  waitingEl.hidden = false;
  waitingEl.classList.add("saved-page");
  waitingEl.innerHTML = `
    <div class="saved-hero">
      <h2 class="saved-eyebrow" data-role="eyebrow"></h2>
      <div class="saved-check">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M5 12.5L10 17L19 7.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <h3 class="saved-title" data-role="title"></h3>
      <p class="saved-subtitle" data-role="subtitle"></p>
      <div class="saved-picks" data-role="picks"></div>
    </div>
    <div class="saved-actions">
      <div class="saved-actions-inner">
        <button type="button" class="btn-secondary" data-role="edit"></button>
        <button type="button" class="btn-primary" data-role="close">
          <span class="label"></span>
        </button>
      </div>
    </div>
  `;

  waitingEl.querySelector<HTMLElement>('[data-role="eyebrow"]')!.textContent =
    tr(lang, "titleWaiting");
  waitingEl.querySelector<HTMLElement>('[data-role="title"]')!.textContent =
    tr(lang, "waitingHeader");
  waitingEl.querySelector<HTMLElement>('[data-role="subtitle"]')!.textContent =
    tr(lang, "waitingSubtitle");

  const picksEl = waitingEl.querySelector<HTMLElement>('[data-role="picks"]')!;
  for (const iso of Array.from(confirmedMine).sort()) {
    const chip = document.createElement("span");
    chip.className = "saved-pick-chip";
    chip.textContent = formatSlot(new Date(iso), lang);
    picksEl.appendChild(chip);
  }

  const editBtn = waitingEl.querySelector<HTMLButtonElement>('[data-role="edit"]')!;
  editBtn.textContent = tr(lang, "btnEdit");
  editBtn.addEventListener("click", () => {
    view = "dates";
    render();
  });

  const closeBtn = waitingEl.querySelector<HTMLButtonElement>('[data-role="close"]')!;
  closeBtn.querySelector<HTMLElement>(".label")!.textContent = tr(lang, "btnClose");
  closeBtn.addEventListener("click", () => app?.close());

  // The waiting screen ships its own bottom actions inline (matches the
  // design's two-button column), so the sticky CTA stays hidden here.
  hideCta();
}

function renderMultiOverlap(): void {
  if (!multiOverlapEl) return;
  if (titleEl) titleEl.hidden = true;
  multiOverlapEl.hidden = false;
  multiOverlapEl.innerHTML = `
    <div class="overlap-hero">
      <h2 data-role="header"></h2>
      <p data-role="subtitle"></p>
    </div>
    <div class="overlap-list" data-role="list"></div>
  `;
  multiOverlapEl.querySelector<HTMLElement>('[data-role="header"]')!.textContent =
    tr(lang, "multiOverlapHeader");
  multiOverlapEl.querySelector<HTMLElement>('[data-role="subtitle"]')!.textContent =
    tr(lang, "multiOverlapSubtitle");

  // Pre-select the first overlap candidate so the Confirm CTA is
  // immediately actionable (matches screen_7 mockup).
  if (multiOverlapChoice === null && overlapCandidates.length > 0) {
    multiOverlapChoice = overlapCandidates[0]!;
  }

  const list = multiOverlapEl.querySelector<HTMLElement>('[data-role="list"]')!;
  for (const iso of overlapCandidates) {
    const card = document.createElement("div");
    card.className = "overlap-card";
    card.dataset.iso = iso;
    if (iso === multiOverlapChoice) card.classList.add("is-selected");

    const date = new Date(iso);
    const text = document.createElement("div");
    text.className = "overlap-text";
    const dayEl = document.createElement("span");
    dayEl.className = "overlap-day";
    dayEl.textContent = `${formatDate(date, lang)},`;
    const timeEl = document.createElement("span");
    timeEl.className = "overlap-time";
    timeEl.textContent = formatTime(date, lang);
    text.append(dayEl, timeEl);
    card.appendChild(text);

    card.addEventListener("click", () => {
      if (multiOverlapChoice === iso) return;
      multiOverlapChoice = iso;
      for (const el of list.querySelectorAll<HTMLElement>(".overlap-card")) {
        el.classList.toggle("is-selected", el.dataset.iso === iso);
      }
      app?.HapticFeedback?.selectionChanged?.();
      showCta(tr(lang, "btnConfirm"));
    });

    list.appendChild(card);
  }

  showCta(tr(lang, "btnConfirm"), { disabled: multiOverlapChoice === null });
}

function renderDates(): void {
  if (!slotsEl) return;
  if (titleEl) {
    titleEl.hidden = false;
    titleEl.textContent = tr(lang, "titleDate");
  }
  updateNegotiationBanner({ minimal: false });
  if (legendEl) legendEl.hidden = false;

  slotsEl.hidden = false;
  slotsEl.innerHTML = "";

  for (const group of groupedByDay()) {
    const btn = renderSlotShell(group.key, "day");
    const dayClass = classifyDay(group);
    paintSlotState(btn, dayClass, formatDateParts(group.date), null, dayHasNewPeer(group));
    btn.addEventListener("click", () => onTapDate(group.key));
    slotsEl.appendChild(btn);
  }

  updateCtaForPicker();
}

function onTapDate(key: string): void {
  const group = groupedByDay().find((g) => g.key === key);
  if (!group) return;
  sheetDayKey = key;
  app?.HapticFeedback?.selectionChanged?.();
  buildSheetContent(group);
  openSheet();
}

function repaintDateStates(): void {
  if (view !== "dates" || !slotsEl) return;
  slotsEl.innerHTML = "";
  for (const group of groupedByDay()) {
    const btn = renderSlotShell(group.key, "day");
    const dayClass = classifyDay(group);
    paintSlotState(btn, dayClass, formatDateParts(group.date), null, dayHasNewPeer(group));
    btn.addEventListener("click", () => onTapDate(group.key));
    slotsEl.appendChild(btn);
  }
}

// ── Slot DOM ───────────────────────────────────────────────────

function renderSlotShell(key: string, kind: "day" | "time"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "slot";
  btn.dataset.kind = kind;
  btn.dataset.key = key;
  return btn;
}

interface DateParts {
  weekday: string;
  dayOfMonth: string;
}

function formatDateParts(date: Date): DateParts {
  const locale = localeFor(lang);
  const weekday = date.toLocaleDateString(locale, { weekday: "long" });
  const dayOfMonth = date.toLocaleDateString(locale, { day: "numeric", month: "long" });
  return { weekday: `${weekday},`, dayOfMonth };
}

function localeFor(l: Lang): string | undefined {
  if (l === "ru") return "ru-RU";
  if (l === "uk") return "uk-UA";
  if (l === "de") return "de-DE";
  if (l === "pl") return "pl-PL";
  return undefined;
}

function paintSlotState(
  btn: HTMLButtonElement,
  cls: SlotClass | DayClass,
  date: DateParts | null,
  time: string | null,
  isNew: boolean,
): void {
  btn.classList.remove("state-you", "state-match", "state-both", "has-topbar");

  const label = document.createElement("span");
  if (time) {
    label.className = "slot-time-label";
    label.textContent = time;
  } else if (date) {
    label.className = "slot-label";
    const weekday = document.createElement("span");
    weekday.className = "slot-weekday";
    weekday.textContent = date.weekday;
    const day = document.createElement("span");
    day.className = "slot-day";
    day.textContent = date.dayOfMonth;
    label.append(weekday, day);
  }

  // "Other time" (same day, different slot) is the one status whose tag is
  // long in every locale. Lift it into a top strip that continues the same
  // gradient frame rather than letting it wrap and grow the body row. The
  // NEW pill rides into that strip too, so it never collides with the lifted
  // label; the body keeps only the pair dots. Every other state below keeps
  // its plain row layout and its corner NEW sticker.
  if (cls === "mixed") {
    btn.classList.add("state-both", "has-topbar");

    const topbar = document.createElement("span");
    topbar.className = "slot-topbar";
    const tag = document.createElement("span");
    tag.className = "indicator-tag";
    tag.textContent = tr(lang, "legendAlternative");
    topbar.appendChild(tag);
    if (isNew) {
      const sticker = document.createElement("span");
      sticker.className = "badge-new";
      sticker.textContent = tr(lang, "badgeNew");
      topbar.appendChild(sticker);
    }
    btn.appendChild(topbar);

    const main = document.createElement("span");
    main.className = "slot-main";
    main.appendChild(label);
    main.appendChild(makeIndicator("", "pair", undefined, /* showTag */ false));
    btn.appendChild(main);
    return;
  }

  btn.appendChild(label);

  if (cls !== "empty") {
    if (cls === "mine") {
      btn.classList.add("state-you");
      btn.appendChild(makeIndicator(tr(lang, "legendMine"), "single", "you"));
    } else if (cls === "peer") {
      btn.classList.add("state-match");
      btn.appendChild(makeIndicator(tr(lang, "legendPeer"), "single", "match"));
    } else if (cls === "overlap") {
      btn.classList.add("state-both");
      btn.appendChild(makeIndicator(tr(lang, "legendOverlap"), "pair"));
    }
  }

  // Sticker NEW — direct child of the slot so it can sit absolutely on
  // the top-right corner, not crowd the indicator row. Skip "mine" and
  // "empty": only peer-side changes are "new" to this user.
  if (isNew && cls !== "empty" && cls !== "mine") {
    const sticker = document.createElement("span");
    sticker.className = "badge-new";
    sticker.textContent = tr(lang, "badgeNew");
    btn.appendChild(sticker);
  }
}

function makeIndicator(
  label: string,
  variant: "single" | "pair",
  dot?: "you" | "match",
  showTag = true,
): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "slot-indicator";
  if (showTag) {
    const tag = document.createElement("span");
    tag.className = "indicator-tag";
    tag.textContent = label;
    wrap.appendChild(tag);
  }
  if (variant === "single") {
    const d = document.createElement("span");
    d.className = "indicator-dot";
    if (dot === "match") d.style.background = "var(--brand)";
    wrap.appendChild(d);
  } else {
    const pair = document.createElement("span");
    pair.className = "indicator-pair";
    const a = document.createElement("span");
    a.className = "indicator-pair-dot";
    a.style.background = "var(--self)";
    const b = document.createElement("span");
    b.className = "indicator-pair-dot";
    b.style.background = "var(--brand)";
    pair.append(a, b);
    wrap.appendChild(pair);
  }
  return wrap;
}

// ── Banner ─────────────────────────────────────────────────────

function updateNegotiationBanner(opts: { minimal: boolean }): void {
  if (!bannerEl) return;

  let copy: string | null = null;
  if (peerSlots.size > 0 && selected.size > 0 && !hasSelectedPeerOverlap()) {
    copy = tr(lang, "bannerProposingAlternative");
  } else if (!isFirstMover && confirmedMine.size === 0) {
    copy = tr(lang, "bannerPeerPicked");
  }

  if (!copy) {
    bannerEl.hidden = true;
    bannerEl.className = "";
    bannerEl.textContent = "";
    return;
  }
  bannerEl.hidden = false;
  bannerEl.className = opts.minimal ? "banner banner-minimal" : "banner";
  bannerEl.textContent = copy;
}

// ── CTA on picker views ────────────────────────────────────────

function updateCtaForPicker(): void {
  if (saving) return;
  const canSubmit = canSubmitSelection();
  if (sheetDayKey !== null) {
    // Sheet owns the CTA while it's open — keep the sticky white button
    // hidden so the two don't stack.
    setSheetCtaState(canSubmit);
    hideCta();
  } else if (canSubmit) {
    showCta(tr(lang, saveButtonKey()));
  } else {
    hideCta();
  }
}

function saveButtonKey(): "btnSave" | "btnSuggestTime" | "btnConfirm" {
  if (selected.size === 0) return "btnSave";
  if (peerSlots.size > 0 && hasSelectedPeerOverlap()) return "btnConfirm";
  return "btnSuggestTime";
}

function hasSelectedPeerOverlap(): boolean {
  for (const iso of selected) {
    if (peerSlots.has(iso)) return true;
  }
  return false;
}

function isDirty(): boolean {
  if (selected.size !== confirmedMine.size) return true;
  for (const iso of selected) if (!confirmedMine.has(iso)) return true;
  return false;
}

function canSubmitSelection(): boolean {
  return isDirty() && hasNewSlot(selected, confirmedMine);
}

function onTapTime(iso: string): void {
  if (selected.has(iso)) selected.delete(iso);
  else selected.add(iso);
  void savePickedSet(matchId, Array.from(selected));
  app?.HapticFeedback?.selectionChanged?.();
  // Repaint the sheet so the tapped slot updates immediately, and the
  // dates list behind the backdrop so its day-card state class follows
  // the new selection.
  const group = sheetDayKey
    ? groupedByDay().find((g) => g.key === sheetDayKey)
    : null;
  if (group) buildSheetContent(group);
  repaintDateStates();
  updateCtaForPicker();
}

// ── Save / confirm ─────────────────────────────────────────────

async function handleSave(): Promise<void> {
  if (!app || saving) return;
  selected = pruneSlotsToProposedTimes(selected, proposedTimes);
  if (!canSubmitSelection()) {
    updateCtaForPicker();
    return;
  }
  void savePickedSet(matchId, Array.from(selected));
  saving = true;
  const loadingLabel = tr(lang, "btnSaving");
  if (sheetDayKey !== null) setSheetCtaLoading(loadingLabel);
  else setCtaLoading(loadingLabel);

  try {
    const res = await postCalendarPicks(app.initData, matchId, Array.from(selected));
    confirmedMine = new Set(res.mySlots);
    peerSlots = new Set(res.peerSlots);
    agreedTime = res.agreedTime;
    overlapCandidates = res.overlapCandidates ?? [];
    saving = false;
    // Successful save = the user has "seen and responded to" everything the
    // peer had at this point. Snapshot it so the next batch of peer changes
    // is what gets NEW-badged on next open / next poll.
    peerSeen = new Set(peerSlots);
    void savePeerSeen(matchId, Array.from(peerSeen));
    // Collapse the bottom sheet — the user committed their picks, so the
    // post-save view (waiting / agreed / overlap / dates) should be fully
    // visible. Polling-triggered renders still preserve the sheet because
    // they go through a different code path.
    sheetDayKey = null;

    if (agreedTime) {
      void clearPicked(matchId);
      app.HapticFeedback?.notificationOccurred?.("success");
      view = "agreed";
    } else if (overlapCandidates.length > 1) {
      multiOverlapChoice = null;
      view = "multi-overlap";
    } else if (confirmedMine.size > 0) {
      // Show the "Saved / waiting" confirmation on every successful save,
      // not just for the first mover. The second mover deserves the same
      // ack even though the peer already has picks recorded.
      app.HapticFeedback?.notificationOccurred?.("success");
      view = "waiting";
    } else {
      view = "dates";
    }
    render();
  } catch (err) {
    saving = false;
    const msg = err instanceof CalendarApiError ? errorMessage(err) : tr(lang, "errNetwork");
    app.showAlert(msg);
    updateCtaForPicker();
  }
}

async function handleConfirmOverlap(): Promise<void> {
  if (!app || saving || !multiOverlapChoice) return;
  saving = true;
  setCtaLoading(tr(lang, "btnSaving"));

  try {
    const res = await postCalendarPicks(app.initData, matchId, [multiOverlapChoice]);
    confirmedMine = new Set(res.mySlots);
    peerSlots = new Set(res.peerSlots);
    agreedTime = res.agreedTime;
    overlapCandidates = res.overlapCandidates ?? [];
    saving = false;
    peerSeen = new Set(peerSlots);
    void savePeerSeen(matchId, Array.from(peerSeen));
    sheetDayKey = null;

    if (agreedTime) {
      void clearPicked(matchId);
      app.HapticFeedback?.notificationOccurred?.("success");
      view = "agreed";
    } else {
      // Edge: peer's set changed mid-confirm — drop back to picker.
      view = "dates";
    }
    render();
  } catch (err) {
    saving = false;
    const msg = err instanceof CalendarApiError ? errorMessage(err) : tr(lang, "errNetwork");
    app.showAlert(msg);
    showCta(tr(lang, "btnConfirm"), { disabled: multiOverlapChoice === null });
  }
}

// ── Polling ────────────────────────────────────────────────────

function schedulePoll(): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, POLL_MS);
}

async function poll(): Promise<void> {
  pollTimer = null;
  if (document.visibilityState !== "visible") return;
  if (saving) {
    schedulePoll();
    return;
  }
  if (view === "multi-overlap") {
    schedulePoll();
    return;
  }
  try {
    const state = await fetchCalendarState(app!.initData, matchId);
    // Skip render unless server-side state actually changed — otherwise
    // the waiting/agreed screens re-mount every 4s and their pop/check
    // animations flash.
    const before = stateFingerprint();
    applyState(state, /* firstLoad */ false);
    const after = stateFingerprint();

    if (before === after) {
      schedulePoll();
      return;
    }

    if (agreedTime) {
      view = "agreed";
    } else if (view === "waiting" && peerSlots.size > 0) {
      // Peer joined while we were waiting; fall back to the picker so the
      // user can see overlapped slots paint live.
      view = "dates";
    }
    render();
  } catch {
    // Polling errors are swallowed; the next save will surface a real one.
  }
  schedulePoll();
}

function stateFingerprint(): string {
  const peer = Array.from(peerSlots).sort().join(",");
  const mine = Array.from(confirmedMine).sort().join(",");
  return `${agreedTime ?? ""}|${peer}|${mine}|${isFirstMover}`;
}

function onVisibility(): void {
  if (document.visibilityState === "visible") {
    schedulePoll();
  } else if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ── i18n helpers ───────────────────────────────────────────────

function applyLegendCopy(): void {
  if (!legendEl) return;
  for (const el of legendEl.querySelectorAll<HTMLElement>("[data-legend]")) {
    const k = el.dataset.legend;
    if (k === "mine") el.textContent = tr(lang, "legendMine");
    else if (k === "peer") el.textContent = tr(lang, "legendPeer");
    else if (k === "overlap") el.textContent = tr(lang, "legendOverlap");
  }
}

function groupedByDay(): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const iso of proposedTimes) {
    const date = new Date(iso);
    const key = slotDayKey(date);
    const existing = groups.get(key);
    if (existing) {
      existing.isos.push(iso);
    } else {
      groups.set(key, { key, date, isos: [iso] });
    }
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      isos: group.isos.sort((a, b) => new Date(a).getTime() - new Date(b).getTime()),
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

function classifyDay(group: DayGroup): DayClass {
  return classifyDaySlots(group.isos, selected, peerSlots);
}

function isNewPeerSlot(iso: string): boolean {
  return peerSlots.has(iso) && !peerSeen.has(iso);
}

function dayHasNewPeer(group: DayGroup): boolean {
  for (const iso of group.isos) {
    if (isNewPeerSlot(iso)) return true;
  }
  return false;
}

function errorMessage(err: CalendarApiError): string {
  switch (err.reason) {
    case "expired":
    case "missing-hash":
    case "bad-hash":
    case "missing-auth-date":
      return tr(lang, "errExpired");
    case "match-not-found":
    case "user-not-found":
      return tr(lang, "errMatchGone");
    case "invalid-slot":
      return tr(lang, "errInvalidSlot");
    case "wrong-state":
      return tr(lang, "errWrongState");
    case "not-participant":
      return tr(lang, "errNotParticipant");
    default:
      return `${tr(lang, "errGeneric")} (HTTP ${err.status})`;
  }
}

// ── Confetti (success only) ────────────────────────────────────

function runConfetti(): void {
  if (!confettiCanvasEl) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  confettiCanvasEl.hidden = false;
  confettiCanvasEl.innerHTML = "";
  const colors = ["#8b253b", "#b6304f", "#d16b80", "#f0c96b"];
  for (let i = 0; i < 40; i++) {
    const piece = document.createElement("div");
    piece.className = "confetti";
    const color = colors[Math.floor(Math.random() * colors.length)]!;
    const size = Math.random() * 6 + 4;
    piece.style.backgroundColor = color;
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.width = `${size}px`;
    piece.style.height = `${size}px`;
    const duration = Math.random() * 2 + 2;
    const delay = Math.random() * 1.5;
    piece.style.animation = `fall ${duration}s linear ${delay}s infinite`;
    confettiCanvasEl.appendChild(piece);
  }
}

function hideConfetti(): void {
  if (!confettiCanvasEl) return;
  confettiCanvasEl.hidden = true;
  confettiCanvasEl.innerHTML = "";
}
