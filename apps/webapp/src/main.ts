import { formatDate, formatSlot, formatTime, slotDayKey } from "./slots.js";
import { savePickedSet, loadPickedSet, clearPicked } from "./device-storage.js";
import {
  fetchCalendarState,
  postCalendarPicks,
  CalendarApiError,
  type CalendarState,
} from "./api.js";
import { pickLang, tr, type Lang } from "./i18n.js";
import { classifyDaySlots, classifySlot, type DayClass, type SlotClass } from "./state-render.js";

/**
 * Calendar Mini App entry point.
 *
 * View states (PRODUCT_SPEC.md §3.6):
 *   - 'dates'        — first step: pick a calendar day
 *   - 'times'        — second step: mark exact time slots for that day
 *   - 'agreed'       — server locked in a single slot, success card
 *   - 'multi-overlap'— post-save state when intersection > 1; user picks
 *                       the final one via radio buttons + Confirm
 *   - 'waiting'      — post-save state when actor saved first and peer
 *                       hasn't replied; success card + Close / Edit buttons
 *
 * Transitions:
 *   - On save → response decides next view (agreed / multi-overlap /
 *     waiting / back to date selection)
 *   - On poll → only `agreed` can override; other views persist
 *   - User taps Close / Edit / Confirm → handled inline
 *
 * Polling interval: 4s while document is visible. We don't poll while
 * saving (to avoid clobbering an in-flight edit).
 */

const POLL_MS = 4000;

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

const params = new URLSearchParams(location.search);
const matchId = app?.initDataUnsafe?.start_param ?? params.get("match") ?? "";
const lang: Lang = pickLang(params.get("lang"));

const titleEl = document.getElementById("title");
const bannerEl = document.getElementById("banner");
const slotsEl = document.getElementById("slots");
const agreedEl = document.getElementById("agreed");
const waitingEl = document.getElementById("waiting");
const multiOverlapEl = document.getElementById("multi-overlap");
const noContextEl = document.getElementById("no-context");
const legendEl = document.getElementById("legend");

type ViewState = "dates" | "times" | "agreed" | "multi-overlap" | "waiting";

interface DayGroup {
  key: string;
  date: Date;
  isos: string[];
}

let view: ViewState = "dates";
let proposedTimes: string[] = [];
let peerSlots = new Set<string>();
let confirmedMine = new Set<string>();
let selected = new Set<string>();
let agreedTime: string | null = null;
let overlapCandidates: string[] = [];
let multiOverlapChoice: string | null = null;
let selectedDayKey: string | null = null;
let isFirstMover = true;
let saving = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

if (titleEl) titleEl.textContent = tr(lang, "titleDate");
applyLegendCopy();

if (!matchId || !slotsEl) {
  if (noContextEl) noContextEl.textContent = tr(lang, "noContext");
  if (slotsEl) slotsEl.style.display = "none";
} else {
  if (noContextEl) noContextEl.style.display = "none";
  void boot();
  if (app) {
    app.MainButton.setText(tr(lang, "btnSuggestTime"));
    app.MainButton.hide();
    app.MainButton.onClick(handleMainButton);
  }
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
  selected = pruneToProposedTimes(selected);

  // First load: if the user has nothing cached locally, mirror the
  // server's view so toggles feel intuitive (re-tapping a slot
  // un-selects it). If they had a cache we keep it — that's their
  // unsaved draft from a previous session.
  if (firstLoad && selected.size === 0) {
    selected = new Set(confirmedMine);
  }
}

function render(): void {
  hideAll();
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
    case "times":
      renderTimes();
      break;
    case "dates":
    default:
      renderDates();
  }
}

function hideAll(): void {
  if (slotsEl) slotsEl.style.display = "none";
  if (agreedEl) agreedEl.style.display = "none";
  if (waitingEl) waitingEl.style.display = "none";
  if (multiOverlapEl) multiOverlapEl.style.display = "none";
  if (bannerEl) bannerEl.style.display = "none";
  if (legendEl) legendEl.style.display = "none";
  app?.MainButton.hide();
}

function renderAgreed(): void {
  if (!agreedEl || !agreedTime) return;
  if (titleEl) titleEl.textContent = tr(lang, "titleAgreed");
  agreedEl.style.display = "block";
  agreedEl.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = tr(lang, "agreedHeader");
  const time = document.createElement("p");
  time.className = "agreed-time";
  time.textContent = formatSlot(new Date(agreedTime), lang);
  const p = document.createElement("p");
  p.textContent = tr(lang, "agreedSubtitle");
  agreedEl.append(h, time, p);
}

function renderWaiting(): void {
  if (!waitingEl) return;
  if (titleEl) titleEl.textContent = tr(lang, "titleWaiting");
  waitingEl.style.display = "block";
  waitingEl.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = tr(lang, "waitingHeader");
  const p = document.createElement("p");
  p.textContent = tr(lang, "waitingSubtitle");
  // Show the user's confirmed picks below as a read-only summary so
  // they can see what was saved.
  const picksWrap = document.createElement("div");
  picksWrap.className = "picks-summary";
  for (const iso of Array.from(confirmedMine).sort()) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = formatSlot(new Date(iso), lang);
    picksWrap.appendChild(chip);
  }
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn-primary";
  close.textContent = tr(lang, "btnClose");
  close.addEventListener("click", () => app?.close());
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn-secondary";
  edit.textContent = tr(lang, "btnEdit");
  edit.addEventListener("click", () => {
    view = "dates";
    render();
  });
  actions.append(close, edit);
  waitingEl.append(h, p, picksWrap, actions);
}

function renderMultiOverlap(): void {
  if (!multiOverlapEl) return;
  if (titleEl) titleEl.textContent = tr(lang, "titleConfirm");
  multiOverlapEl.style.display = "block";
  multiOverlapEl.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = tr(lang, "multiOverlapHeader");
  const p = document.createElement("p");
  p.textContent = tr(lang, "multiOverlapSubtitle");
  const list = document.createElement("div");
  list.className = "radio-list";
  for (const iso of overlapCandidates) {
    const opt = document.createElement("label");
    opt.className = "radio-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "overlap";
    input.value = iso;
    input.checked = multiOverlapChoice === iso;
    input.addEventListener("change", () => {
      multiOverlapChoice = iso;
      app?.MainButton.enable();
      app?.MainButton.show();
    });
    const text = document.createElement("span");
    text.textContent = formatSlot(new Date(iso), lang);
    opt.append(input, text);
    list.appendChild(opt);
  }
  multiOverlapEl.append(h, p, list);
  // Reuse MainButton as the Confirm CTA for native feel.
  if (app) {
    app.MainButton.setText(tr(lang, "btnConfirm"));
    if (multiOverlapChoice) {
      app.MainButton.enable();
      app.MainButton.show();
    } else {
      app.MainButton.disable();
      app.MainButton.show();
    }
  }
}

function renderDates(): void {
  if (!slotsEl) return;
  if (titleEl) titleEl.textContent = tr(lang, "titleDate");
  if (bannerEl) {
    updateNegotiationBanner();
  }
  if (legendEl) legendEl.style.display = "flex";

  // Repaint the date list. The exact DateTime allowlist stays server-owned;
  // this step only groups those slots into a calmer first choice.
  slotsEl.style.display = "grid";
  slotsEl.className = "slots date-grid";
  slotsEl.innerHTML = "";
  for (const group of groupedByDay()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot date-slot";
    btn.dataset.day = group.key;
    btn.textContent = formatDate(group.date, lang);
    applySlotClass(btn, classifyDay(group));
    btn.addEventListener("click", () => {
      selectedDayKey = group.key;
      view = "times";
      app?.HapticFeedback?.selectionChanged?.();
      render();
    });
    slotsEl.appendChild(btn);
  }
  updateMainButton();
}

function renderTimes(): void {
  if (!slotsEl) return;
  const group = groupedByDay().find((g) => g.key === selectedDayKey);
  if (!group) {
    selectedDayKey = null;
    view = "dates";
    renderDates();
    return;
  }

  if (titleEl) titleEl.textContent = tr(lang, "titleTime");
  updateNegotiationBanner();
  if (legendEl) legendEl.style.display = "flex";
  slotsEl.style.display = "block";
  slotsEl.className = "slots times";
  slotsEl.innerHTML = "";

  const header = document.createElement("div");
  header.className = "time-header";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "back-date";
  back.setAttribute("aria-label", tr(lang, "btnBackToDates"));
  back.textContent = "‹";
  back.addEventListener("click", () => {
    selectedDayKey = null;
    view = "dates";
    app?.HapticFeedback?.selectionChanged?.();
    render();
  });
  const dateLabel = document.createElement("div");
  dateLabel.className = "time-header-title";
  dateLabel.textContent = formatDate(group.date, lang);
  header.append(back, dateLabel);

  const list = document.createElement("div");
  list.className = "time-list";
  for (const iso of group.isos) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "slot time-slot";
    btn.dataset.iso = iso;
    btn.textContent = formatTime(new Date(iso), lang);
    applySlotClass(btn, classifySlot(iso, selected, peerSlots));
    btn.addEventListener("click", () => onTapTime(iso));
    list.appendChild(btn);
  }

  slotsEl.append(header, list);
  updateMainButton();
}

function applySlotClass(btn: HTMLButtonElement, cls: DayClass | SlotClass): void {
  btn.classList.remove("mine", "peer", "overlap", "mixed", "empty");
  btn.classList.add(cls);
  const existingTag = btn.querySelector(".tag");
  if (existingTag) existingTag.remove();
  if (cls === "peer" || cls === "overlap" || cls === "mixed") {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent =
      cls === "overlap"
        ? tr(lang, "legendOverlap")
        : cls === "mixed"
          ? tr(lang, "legendAlternative")
          : tr(lang, "legendPeer");
    btn.appendChild(tag);
  }
}

function onTapTime(iso: string): void {
  if (selected.has(iso)) selected.delete(iso);
  else selected.add(iso);
  void savePickedSet(matchId, Array.from(selected));
  app?.HapticFeedback?.selectionChanged?.();
  renderTimes();
}

function updateMainButton(): void {
  if (!app) return;
  if (saving) return;
  if (isDirty()) {
    app.MainButton.setText(tr(lang, saveButtonKey()));
    app.MainButton.enable();
    app.MainButton.show();
  } else {
    app.MainButton.hide();
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

function updateNegotiationBanner(): void {
  if (!bannerEl) return;

  if (peerSlots.size > 0 && selected.size > 0 && !hasSelectedPeerOverlap()) {
    bannerEl.style.display = "block";
    bannerEl.textContent = tr(lang, "bannerProposingAlternative");
    return;
  }

  if (!isFirstMover && confirmedMine.size === 0) {
    bannerEl.style.display = "block";
    bannerEl.textContent = tr(lang, "bannerPeerPicked");
    return;
  }

  bannerEl.style.display = "none";
  bannerEl.textContent = "";
}

function isDirty(): boolean {
  if (selected.size !== confirmedMine.size) return true;
  for (const iso of selected) if (!confirmedMine.has(iso)) return true;
  return false;
}

function handleMainButton(): void {
  if (view === "multi-overlap") {
    void handleConfirmOverlap();
  } else {
    void handleSave();
  }
}

async function handleSave(): Promise<void> {
  if (!app || saving) return;
  selected = pruneToProposedTimes(selected);
  saving = true;
  app.MainButton.setText(tr(lang, "btnSaving"));
  app.MainButton.showProgress();
  app.MainButton.disable();

  try {
    const res = await postCalendarPicks(app.initData, matchId, Array.from(selected));
    confirmedMine = new Set(res.mySlots);
    peerSlots = new Set(res.peerSlots);
    agreedTime = res.agreedTime;
    overlapCandidates = res.overlapCandidates ?? [];
    saving = false;
    app.MainButton.hideProgress();

    if (agreedTime) {
      void clearPicked(matchId);
      app.HapticFeedback?.notificationOccurred?.("success");
      view = "agreed";
    } else if (overlapCandidates.length > 1) {
      multiOverlapChoice = null;
      view = "multi-overlap";
    } else if (confirmedMine.size > 0 && peerSlots.size === 0) {
      app.HapticFeedback?.notificationOccurred?.("success");
      view = "waiting";
    } else {
      // Both submitted but no overlap (or empty self-set after edit) —
      // stay in the picker so user can keep adjusting.
      view = "dates";
    }
    render();
  } catch (err) {
    saving = false;
    app.MainButton.hideProgress();
    app.MainButton.enable();
    const msg = err instanceof CalendarApiError ? errorMessage(err) : tr(lang, "errNetwork");
    app.showAlert(msg);
    updateMainButton();
  }
}

function pruneToProposedTimes(values: ReadonlySet<string>): Set<string> {
  if (values.size === 0) return new Set();
  const allowed = new Set(proposedTimes);
  const pruned = new Set<string>();
  for (const iso of values) {
    if (allowed.has(iso) && !Number.isNaN(new Date(iso).getTime())) {
      pruned.add(iso);
    }
  }
  return pruned;
}

async function handleConfirmOverlap(): Promise<void> {
  if (!app || saving || !multiOverlapChoice) return;
  saving = true;
  app.MainButton.showProgress();
  app.MainButton.disable();

  try {
    // Re-POST with just the chosen overlap. Server sees intersection=1
    // and auto-locks — same code path as instant-agree.
    const res = await postCalendarPicks(app.initData, matchId, [multiOverlapChoice]);
    confirmedMine = new Set(res.mySlots);
    peerSlots = new Set(res.peerSlots);
    agreedTime = res.agreedTime;
    overlapCandidates = res.overlapCandidates ?? [];
    saving = false;
    app.MainButton.hideProgress();

    if (agreedTime) {
      void clearPicked(matchId);
      app.HapticFeedback?.notificationOccurred?.("success");
      view = "agreed";
    } else {
      // Edge case: peer changed their picks between our save and confirm
      // and the chosen slot is no longer overlapping. Fall back to dates.
      view = "dates";
    }
    render();
  } catch (err) {
    saving = false;
    app.MainButton.hideProgress();
    app.MainButton.enable();
    const msg = err instanceof CalendarApiError ? errorMessage(err) : tr(lang, "errNetwork");
    app.showAlert(msg);
  }
}

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
  // Don't disturb an in-flight multi-overlap confirm flow.
  if (view === "multi-overlap") {
    schedulePoll();
    return;
  }
  try {
    const state = await fetchCalendarState(app!.initData, matchId);
    applyState(state, /* firstLoad */ false);
    // Polling can only PROMOTE the view to 'agreed' — it never demotes
    // 'waiting' back to 'dates' because the user's UI choice (showing
    // success) shouldn't flicker as peer's empty array stays empty.
    if (agreedTime) {
      view = "agreed";
    }
    render();
  } catch {
    // Swallow polling errors — the next save will surface a real one.
  }
  schedulePoll();
}

function onVisibility(): void {
  if (document.visibilityState === "visible") {
    schedulePoll();
  } else if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function applyLegendCopy(): void {
  if (!legendEl) return;
  const items = legendEl.querySelectorAll<HTMLElement>("[data-legend]");
  for (const el of items) {
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
    case "invalid-iso":
      return tr(lang, "errInvalidSlot");
    case "wrong-state":
      return tr(lang, "errWrongState");
    case "not-participant":
      return tr(lang, "errNotParticipant");
    default:
      return `${tr(lang, "errGeneric")} (HTTP ${err.status})`;
  }
}
