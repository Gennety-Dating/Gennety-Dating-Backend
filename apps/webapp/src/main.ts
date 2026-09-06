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
  primeTimeStarsInvoice,
} from "./api.js";
import { butterflySuccessMarkup, onSuccessSettle } from "./butterfly-success.js";
import { hasNewSlot, pruneSlotsToProposedTimes } from "./calendar-selection.js";
import { planDayRows } from "./prime-band.js";
import { pickLang, tr, type Lang } from "./i18n.js";
import { classifyDaySlots, classifySlot, type DayClass, type SlotClass } from "./state-render.js";
import { icon } from "./icons.js";
import { returnParams } from "./return-to.js";

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
const primeSheetEl = document.getElementById("prime-sheet");
const primeBackdropEl = document.getElementById("prime-backdrop");
const primeTitleEl = document.getElementById("prime-title");
const primeBodyEl = document.getElementById("prime-body");
const primePayEl = document.getElementById("prime-pay") as HTMLButtonElement | null;
const primePayLabelEl = primePayEl?.querySelector<HTMLSpanElement>(".label") ?? null;
const primePremiumEl = document.getElementById("prime-premium") as HTMLButtonElement | null;
const primeDismissEl = document.getElementById("prime-dismiss") as HTMLButtonElement | null;

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
/**
 * The paid evening band (PRIME_TIME_PRODUCT_SPEC §7). The server has already
 * resolved every reason the band might be open — a subscription on either side,
 * a paid pass, a pair it cannot reach — so `primeLocked` is the whole gate and
 * this file re-derives none of it.
 */
let primeLocked = false;
let primeSlots = new Set<string>();
let primeStars = 0;
let primeBusy = false;
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
  primeLocked = state.primeTime?.locked === true;
  // Kept whatever `locked` says. The evening section does not disappear once
  // the band opens — it goes neutral (§3 of the redesign): a list that silently
  // loses its grouping the moment you pay reads as if the purchase moved the
  // times somewhere, and the pair still benefits from seeing where the evening
  // starts. The server sends the band for both states already.
  primeSlots = new Set(state.primeTime?.slots ?? []);
  primeStars = state.primeTime?.stars ?? 0;
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

primePayEl?.addEventListener("click", () => void onPrimePay());
primePremiumEl?.addEventListener("click", () => openPremiumFromPrime());
primeDismissEl?.addEventListener("click", () => closePrimeSheet());
primeBackdropEl?.addEventListener("click", () => closePrimeSheet());

function onBackButton(): void {
  // Topmost layer first — the unlock sheet sits ABOVE the time picker, so a
  // back that closed the picker underneath it would leave an orphan on screen.
  if (primeSheetEl && !primeSheetEl.hasAttribute("hidden")) {
    closePrimeSheet();
    return;
  }
  if (sheetDayKey !== null) closeSheet(true);
}

// ── Prime Time unlock sheet ────────────────────────────────────────────

function openPrimeSheet(): void {
  if (!primeSheetEl || !primeBackdropEl) return;
  app?.HapticFeedback?.impactOccurred?.("light");
  if (primeTitleEl) primeTitleEl.textContent = tr(lang, "primeSheetTitle");
  if (primeBodyEl) primeBodyEl.textContent = tr(lang, "primeSheetBody");
  if (primePayLabelEl) primePayLabelEl.replaceChildren(...priceLabel("primeSheetCtaPay"));
  if (primePremiumEl) primePremiumEl.textContent = tr(lang, "primeSheetCtaPremium");
  if (primeDismissEl) primeDismissEl.textContent = tr(lang, "primeSheetDismiss");
  setPrimeBusy(false);
  primeSheetEl.removeAttribute("hidden");
  primeBackdropEl.removeAttribute("hidden");
  void primeSheetEl.offsetHeight;
  requestAnimationFrame(() => {
    primeSheetEl.classList.add("is-open");
    primeBackdropEl.classList.add("is-open");
  });
}

function closePrimeSheet(): void {
  if (!primeSheetEl || !primeBackdropEl) return;
  primeSheetEl.classList.remove("is-open");
  primeBackdropEl.classList.remove("is-open");
  setTimeout(() => {
    primeSheetEl.setAttribute("hidden", "");
    primeBackdropEl.setAttribute("hidden", "");
  }, 320);
}

function setPrimeBusy(busy: boolean): void {
  primeBusy = busy;
  if (primePayEl) {
    primePayEl.disabled = busy;
    primePayEl.classList.toggle("is-loading", busy);
  }
}

async function onPrimePay(): Promise<void> {
  if (primeBusy || !app) return;
  setPrimeBusy(true);
  try {
    const { link, settled } = await primeTimeStarsInvoice(app!.initData, matchId);
    // Demo mode settles for free and sends no link — the band is already open.
    if (settled || !link) {
      app?.HapticFeedback?.notificationOccurred?.("success");
      void refreshAfterUnlock();
      return;
    }
    const open = app.openInvoice;
    if (!open) {
      // A client too old for openInvoice can still follow the link.
      setPrimeBusy(false);
      window.open(link, "_blank");
      return;
    }
    open.call(app, link, (status) => {
      if (status === "paid") {
        app?.HapticFeedback?.notificationOccurred?.("success");
        // The band is opened by the SERVER on `successful_payment`, so the only
        // honest confirmation is the state that comes back — never the callback.
        void refreshAfterUnlock();
        return;
      }
      setPrimeBusy(false);
      if (status === "failed") {
        app?.HapticFeedback?.notificationOccurred?.("error");
        app?.showAlert?.(tr(lang, "primeUnlockFailed"));
      }
    });
  } catch {
    setPrimeBusy(false);
    app?.HapticFeedback?.notificationOccurred?.("error");
    app?.showAlert?.(tr(lang, "primeUnlockFailed"));
  }
}

/**
 * Poll until the band is actually open. `successful_payment` reaches the bot on
 * its own connection, so the Mini App can come back from the invoice before the
 * settle has landed — a single refetch would redraw the grid still locked.
 */
async function refreshAfterUnlock(attempt = 0): Promise<void> {
  try {
    const state = await fetchCalendarState(app!.initData, matchId);
    applyState(state, false);
    if (!primeLocked) {
      setPrimeBusy(false);
      closePrimeSheet();
      render();
      return;
    }
  } catch {
    // fall through to the retry
  }
  if (attempt >= 6) {
    setPrimeBusy(false);
    closePrimeSheet();
    render();
    // Say what happened. Giving up silently closes the sheet on a band that is
    // still visibly locked, seconds after Telegram confirmed the charge — and
    // the only move that reads as available from there is paying again.
    //
    // Deliberately NOT `primeUnlockFailed`: the payment did not fail. The
    // settle simply has not landed yet, and the ordinary 4s poll opens the band
    // on its own, so the honest line is "it is paid, it is coming".
    app?.showAlert?.(tr(lang, "primeUnlockPending"));
    return;
  }
  setTimeout(() => void refreshAfterUnlock(attempt + 1), 700);
}

function openPremiumFromPrime(): void {
  app?.HapticFeedback?.impactOccurred?.("light");
  location.href = `premium.html?${returnParams("calendar", { match: matchId, lang })}`;
}

// ── Bottom sheet ───────────────────────────────────────────────

function buildSheetContent(group: DayGroup): void {
  if (sheetTitleEl) sheetTitleEl.textContent = formatDate(group.date, lang);
  if (!sheetBodyEl) return;
  // A poll-driven rebuild (the peer marked a slot) must not yank the user
  // back up the list mid-pick — it wipes and re-appends every row, which
  // resets scrollTop to 0. Where a *fresh* open lands is openSheet's call.
  const keepScrollTop = sheetBodyEl.scrollTop;
  const body = sheetBodyEl;
  body.innerHTML = "";

  // The evening band is ONE section, not N flagged rows: a header, the rows,
  // and — while it is locked — a single caption carrying the price. Three rows
  // each wearing their own padlock and their own "Premium" plate read as three
  // errors in the list; one softly tinted section with one offer under it reads
  // as what it is. `band` is the open wrapper while we are inside that run;
  // every other row goes straight into the body, untouched by any of this.
  let band: HTMLElement | null = null;

  for (const row of planDayRows(group.isos, primeSlots)) {
    const btn = renderSlotShell(row.iso, "time");
    const cls = classifySlot(row.iso, selected, peerSlots);
    paintSlotState(btn, cls, null, formatTime(new Date(row.iso), lang), isNewPeerSlot(row.iso));

    if (row.bandStart) band = openPrimeBand(body);

    if (row.prime && primeLocked) {
      // A locked row keeps its time, its fill and its height — it is an offer,
      // not a hole, and dimming it into a grey stub is the one thing that would
      // make a commercial row read as an invalid one. Its only state marker is
      // a compact padlock; NO click handler goes on it, because the whole band
      // carries one (see openPrimeBand) and a second would double-fire through
      // it on every tap.
      btn.classList.add("is-locked");
      btn.setAttribute("aria-haspopup", "dialog");
      // Only on an otherwise-empty row. A slot carrying a pick indicator is
      // showing pair state, and that always outranks band decor. The server
      // grandfathers any band a pair has already marked (prime-time.ts §13.1),
      // so this is a guard rather than a case that ships today.
      if (cls === "empty") btn.appendChild(icon("lock", "icon prime-lock"));
    } else {
      btn.addEventListener("click", () => onTapTime(row.iso));
    }

    (band ?? body).appendChild(btn);

    if (row.bandEnd) {
      if (primeLocked && band) band.appendChild(primeBandCaption());
      band = null;
    }
  }

  body.scrollTop = keepScrollTop;
  setSheetCtaState(canSubmitSelection());
}

/**
 * Open the evening section and return the wrapper the band's rows go into.
 *
 * The wrapper is what carries the soft brand wash, so the tint is one surface
 * behind the whole run rather than a gradient repeated per row. It is also the
 * single click target for the locked state: the rows, the caption, the header
 * and the gaps between them all lead to the same sheet, and every interactive
 * child inside it is a real `<button>`, so keyboard activation bubbles here too.
 */
function openPrimeBand(host: HTMLElement): HTMLElement {
  const el = document.createElement("div");
  el.className = primeLocked ? "prime-band" : "prime-band is-open";
  el.setAttribute("role", "group");

  const header = document.createElement("div");
  header.className = "prime-band-header";
  const title = document.createElement("span");
  title.className = "prime-band-title";
  title.textContent = tr(lang, primeLocked ? "primeBandLocked" : "primeBandOpen");
  // The header is the group's name — without this a screen reader reads the
  // evening rows as three more unlabelled times in the same flat list.
  el.setAttribute("aria-label", title.textContent);
  // The crest leads the header only while the band is locked: once the pair
  // owns the evening there is no tier left to name, and a mark that keeps
  // selling after the sale is the thing the open state exists to stop.
  if (primeLocked) header.appendChild(primeCrest());
  header.appendChild(title);
  if (!primeLocked) {
    // One quiet "it's yours" at section level. Repeating it per row would be
    // the same noise the locked state just stopped making.
    const tag = document.createElement("span");
    tag.className = "prime-band-tag";
    tag.append(icon("check", "icon"), document.createTextNode(tr(lang, "primeBandOpenTag")));
    header.appendChild(tag);
  }
  el.appendChild(header);

  if (primeLocked) el.addEventListener("click", () => openPrimeSheet());
  host.appendChild(el);
  return el;
}

/**
 * The brand butterfly, in the metallic vertical gradient the Premium Mini App
 * gives its own crest (theme-aware through the .pt-bf-a / .pt-bf-b stops).
 * Static trusted markup — no user data reaches this string.
 *
 * The gradient id is per-instance: a day's sheet holds one band today, but SVG
 * ids are document-global, and duplicates make every later crest resolve its
 * fill to the FIRST definition — fine until the stops ever differ, then broken
 * silently. Same precaution the venue board takes for the same reason.
 */
let crestSeq = 0;
function primeCrest(): HTMLElement {
  const id = `pt-bf-grad-${++crestSeq}`;
  const host = document.createElement("span");
  host.className = "prime-band-crest";
  host.setAttribute("aria-hidden", "true");
  host.innerHTML = `
    <svg viewBox="-12 -10 124 120" focusable="false">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop class="pt-bf-a" offset="0" />
          <stop class="pt-bf-b" offset="1" />
        </linearGradient>
      </defs>
      <path
        d="M 50 35 C 20 0, -10 30, 15 55 C -5 75, 25 100, 48 65 L 52 65 C 75 100, 105 75, 85 55 C 110 30, 80 0, 50 35 Z"
        fill="url(#${id})"
      />
    </svg>`;
  return host;
}

/**
 * The band's one paywall affordance: a single quiet action row under the last
 * locked slot. Deliberately not a filled button — the loud one lives in the
 * sheet this opens, and there is exactly one of those per screen.
 */
function primeBandCaption(): HTMLElement {
  const cta = document.createElement("button");
  cta.type = "button";
  cta.className = "prime-band-cta";
  cta.setAttribute("aria-haspopup", "dialog");
  cta.append(...priceLabel("primeBandCta"));
  return cta;
}

/**
 * A Stars price rendered with OUR star, never the platform ⭐ — that character
 * renders as Apple's art on iOS, Google's on Android and a font glyph on the
 * web, which is the whole reason this app authors its icon set. Same rule the
 * venue board's `iconBtn(..., withStar)` already follows.
 *
 * The `{stars}` placeholder is therefore replaced by a NODE, not by text, so
 * the copy stays one translated sentence with the price as a chip at its end.
 * A locale that somehow lost the placeholder still renders its whole sentence
 * — with the price appended rather than dropped, because a button that asks
 * for an unnamed amount of money is the one outcome worth guarding against.
 */
function priceLabel(key: "primeBandCta" | "primeSheetCtaPay"): Node[] {
  const [rawBefore, rawAfter = ""] = tr(lang, key).split("{stars}");
  // The chip carries its own leading gap, so the space a locale leaves around
  // the placeholder would double it — visibly, right after an em dash.
  const before = rawBefore.replace(/\s+$/, "");
  const after = rawAfter.replace(/^\s+/, "");
  const price = document.createElement("span");
  price.className = "prime-price";
  price.append(icon("star", "icon prime-star"), document.createTextNode(String(primeStars)));
  const nodes: Node[] = [];
  if (before) nodes.push(document.createTextNode(before));
  nodes.push(price);
  if (after) nodes.push(document.createTextNode(after));
  return nodes;
}

/**
 * The slot list opens at the LATEST time, not the earliest.
 *
 * The grid runs 13:00 → 19:30 and dates are overwhelmingly planned for the
 * evening, so the bottom of the list is where the answer usually is. It also
 * leaves a row half-cut above the fold, which is the only affordance on this
 * screen saying the list scrolls at all — opening at 13:00 shows a full row
 * at the top edge and reads like the list simply starts there.
 *
 * Must run with the sheet's `hidden` attribute already off: a `display: none`
 * element reports `scrollHeight = 0` and the assignment silently no-ops.
 */
function anchorSheetToLatest(): void {
  if (!sheetBodyEl) return;
  sheetBodyEl.scrollTop = sheetBodyEl.scrollHeight;
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
  // Every path that makes the sheet visible funnels through here, so this is
  // the one place that owns the opening scroll position.
  anchorSheetToLatest();
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
  // The shared brand success mark (butterfly-success.ts). This used to be an
  // 84px stroked tick of its own — one of four unrelated checkmarks the Mini
  // Apps had grown. Deliberately unlabelled: the card below states the date, and
  // a caption here would announce the same success twice.
  agreedEl.innerHTML = `
    ${butterflySuccessMarkup()}
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
      // Buzzes when the butterfly lands, not on the save response — the mark
      // mounts in the render() below and the pulse is what makes its landing
      // land as an event. Safe here rather than inside renderAgreed(), which a
      // poll can re-run: these two branches fire once per real commit.
      onSuccessSettle(() => app.HapticFeedback?.notificationOccurred?.("success"));
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
      // Buzzes when the butterfly lands, not on the save response — the mark
      // mounts in the render() below and the pulse is what makes its landing
      // land as an event. Safe here rather than inside renderAgreed(), which a
      // poll can re-run: these two branches fire once per real commit.
      onSuccessSettle(() => app.HapticFeedback?.notificationOccurred?.("success"));
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
  // `primeLocked` belongs here now that it changes the sheet's SHAPE, not just
  // a per-row tint: the peer starting a subscription mid-negotiation has to
  // swap the evening header and drop the caption, and without this the poll
  // that learned about it would skip the redraw.
  return `${agreedTime ?? ""}|${peer}|${mine}|${isFirstMover}|${primeLocked}`;
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
    // `backwards` is load-bearing, not a flourish. The pieces are staggered by
    // up to 1.5s, and with the default `fill: none` a piece renders its OWN
    // style during its delay — no transform, so it sits at y=0, opaque, pinned
    // flush to the top edge until its turn comes. Measured on the real render
    // at 390x844: 40/40 parked at the top edge at t=0, 33 still there at 400ms,
    // 21 at 800ms. That is the "confetti sticks to the top for the first couple
    // of seconds" report. With `backwards` the delay is spent holding the 0%
    // keyframe instead — translateY(-10vh), i.e. above the screen — so a piece
    // is invisible until it actually starts falling.
    //
    // It has to ride the SHORTHAND. An `animation-fill-mode` rule in
    // onboarding-adjacent CSS would be silently dead: this shorthand is an
    // inline style, and it resets fill-mode to `none` no matter what the
    // stylesheet says. Verified — the CSS-only version of this fix changed
    // nothing at all.
    piece.style.animation = `fall ${duration}s linear ${delay}s infinite backwards`;
    confettiCanvasEl.appendChild(piece);
  }
}

function hideConfetti(): void {
  if (!confettiCanvasEl) return;
  confettiCanvasEl.hidden = true;
  confettiCanvasEl.innerHTML = "";
}
