import QRCode from "qrcode";
import { apiBase, apiFetch } from "./api.js";
import { applyTheme, getTheme } from "./theme.js";
import "./event.css";

/**
 * The attendee's launch-event screen (LAUNCH_EVENTS_PRODUCT_SPEC.md §6).
 *
 * Three states, in one page: what is on, whether you are in, and — once you
 * are — the door code.
 *
 * ── The one thing that is not obvious ───────────────────────────────────
 *
 * The QR is minted server-side with a short TTL and re-fetched here before it
 * expires, so the code on screen is always fresh. That is not a nicety: the
 * TTL is what makes a forwarded screenshot useless, and a client that fetched
 * once and displayed forever would quietly hand that property back.
 */

const tg = window.Telegram?.WebApp;
const initData = tg?.initData ?? "";

/** Re-mint this many ms before the current code lapses, so the screen never
 *  shows an expired one to a door. */
const QR_REFRESH_MARGIN_MS = 15_000;

interface EventTier {
  id: string;
  title: string;
  spotsLeft: number;
}

interface EventRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  venueName: string;
  venueAddress: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  admission: "none" | "pending" | "admitted" | "reserve";
  hasTicket: boolean;
  tiers: EventTier[];
}

interface LivePairing {
  pairingId: string;
  roundIndex: number;
  closesAt: string;
  partnerFirstName: string | null;
  spotLabel: string;
  code: number;
  mission: string | null;
  iConfirmed: boolean;
  mutual: boolean;
}

interface LiveState {
  checkedIn: boolean;
  paused: boolean;
  pairing: LivePairing | null;
}

let events: EventRow[] = [];
let openTicketFor: string | null = null;
let qrTimer: ReturnType<typeof setTimeout> | null = null;
/** Which event's live screen is open, if any — the poll's own cancel token. */
let openLiveFor: string | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;
/** Last mutual we celebrated, so a poll cannot re-fire the haptic every 5s. */
let celebrated: string | null = null;

const root = document.getElementById("app") as HTMLElement;

function h(html: string): string {
  return html;
}

function esc(value: string | null | undefined): string {
  return (value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * The event's own city clock, never the device's — a traveller reading their
 * phone's time would turn up at the wrong hour. Same rule the date card and
 * the calendar already follow.
 */
function formatWhen(iso: string, timeZone: string, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, {
      weekday: "short",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

const COPY = {
  ru: {
    title: "Вечеринки",
    empty: "Пока ничего не запланировано в твоём городе. Мы напишем, когда появится.",
    apply: "Подать заявку",
    pending: "Заявка на рассмотрении",
    reserve: "Ты в резерве — напишем, если освободится место",
    admitted: "Ты в списке",
    getTicket: "Получить билет",
    showTicket: "Показать билет",
    ticketTitle: "Твой вход",
    ticketHint: "Покажи этот код на входе. Он обновляется сам.",
    spotsLeft: "мест осталось",
    full: "Мест не осталось",
    back: "Назад",
    rotate: "Код скомпрометирован — обновить",
    error: "Что-то пошло не так. Попробуй ещё раз.",
    party: "Идёт вечеринка",
    liveTitle: "Твой раунд",
    liveDoor: "Сначала покажи код на входе — тогда начнём знакомить.",
    liveWaiting: "Свободный раунд — бар вон там 🍸 Следующий скоро.",
    liveMeet: "Найди",
    liveAt: "у места",
    liveCode: "код",
    liveMet: "Мы нашли друг друга",
    liveMetDone: "Отмечено. Ждём вторую сторону.",
    liveMutual: "Вы нашли друг друга ✨",
    livePause: "Взять паузу",
    liveResume: "Я вернулся",
    livePaused: "Ты на паузе. Следующий раунд пропустим.",
  },
  en: {
    title: "Parties",
    empty: "Nothing planned in your city yet. We'll tell you when there is.",
    apply: "Apply",
    pending: "Application under review",
    reserve: "You're on the reserve list — we'll ping you if a spot opens",
    admitted: "You're on the list",
    getTicket: "Get ticket",
    showTicket: "Show ticket",
    ticketTitle: "Your entry",
    ticketHint: "Show this at the door. It refreshes itself.",
    spotsLeft: "spots left",
    full: "No spots left",
    back: "Back",
    rotate: "Code leaked — refresh it",
    error: "Something went wrong. Try again.",
    party: "Party in progress",
    liveTitle: "Your round",
    liveDoor: "Show your code at the door first — then we'll start introducing you.",
    liveWaiting: "Free round — bar's that way 🍸 Next one shortly.",
    liveMeet: "Find",
    liveAt: "at",
    liveCode: "code",
    liveMet: "We crossed paths",
    liveMetDone: "Noted. Waiting on the other side.",
    liveMutual: "You found each other ✨",
    livePause: "Take a break",
    liveResume: "I'm back",
    livePaused: "You're sitting out. We'll skip the next round.",
  },
} as const;

const lang = (tg?.initDataUnsafe?.user?.language_code ?? "en").startsWith("ru") ? "ru" : "en";
const t = COPY[lang];

async function load(): Promise<void> {
  const res = await apiFetch(`${apiBase}/v1/events`, {
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) throw new Error(`events ${res.status}`);
  const body = (await res.json()) as { events: EventRow[] };
  events = body.events;
}

function renderList(): void {
  if (!events.length) {
    root.innerHTML = h(`<div class="ev-empty">${esc(t.empty)}</div>`);
    return;
  }
  root.innerHTML = events
    .map((event) => {
      const when = formatWhen(event.startsAt, event.timeZone, lang);
      const tier = event.tiers[0];
      let action = "";
      if (event.hasTicket && event.status === "live") {
        // While the party is on, the round is what the screen is for; the QR
        // is one tap away and only matters at the door.
        action =
          `<button class="ev-cta" data-live="${esc(event.id)}">${esc(t.party)}</button>` +
          `<button class="ev-secondary" data-ticket="${esc(event.id)}">${esc(t.showTicket)}</button>`;
      } else if (event.hasTicket) {
        action = `<button class="ev-cta" data-ticket="${esc(event.id)}">${esc(t.showTicket)}</button>`;
      } else if (event.admission === "admitted") {
        action = tier
          ? tier.spotsLeft > 0
            ? `<button class="ev-cta" data-claim="${esc(event.id)}" data-tier="${esc(tier.id)}">${esc(t.getTicket)}</button>`
            : `<div class="ev-note">${esc(t.full)}</div>`
          : `<div class="ev-note">${esc(t.admitted)}</div>`;
      } else if (event.admission === "pending") {
        action = `<div class="ev-note">${esc(t.pending)}</div>`;
      } else if (event.admission === "reserve") {
        action = `<div class="ev-note">${esc(t.reserve)}</div>`;
      } else {
        action = `<button class="ev-cta" data-apply="${esc(event.id)}">${esc(t.apply)}</button>`;
      }

      const spots =
        tier && event.admission === "admitted" && !event.hasTicket && tier.spotsLeft > 0
          ? `<div class="ev-spots">${tier.spotsLeft} ${esc(t.spotsLeft)}</div>`
          : "";

      return h(`
        <article class="ev-card">
          <h2 class="ev-title">${esc(event.title)}</h2>
          <div class="ev-when">${esc(when)}</div>
          <div class="ev-venue">${esc(event.venueName)}<span>${esc(event.venueAddress)}</span></div>
          ${spots}
          ${action}
        </article>`);
    })
    .join("");
}

async function renderTicket(eventId: string): Promise<void> {
  const event = events.find((e) => e.id === eventId);
  openTicketFor = eventId;
  root.innerHTML = h(`
    <section class="ev-ticket">
      <button class="ev-back" data-back="1">← ${esc(t.back)}</button>
      <h2 class="ev-title">${esc(event?.title ?? t.ticketTitle)}</h2>
      <canvas id="ev-qr" width="260" height="260"></canvas>
      <p class="ev-hint">${esc(t.ticketHint)}</p>
      <button class="ev-rotate" data-rotate="${esc(eventId)}">${esc(t.rotate)}</button>
    </section>`);
  await refreshQr(eventId);
}

async function refreshQr(eventId: string): Promise<void> {
  if (qrTimer) clearTimeout(qrTimer);
  // The user may have navigated away while the request was in flight; drawing
  // into a canvas that no longer exists would throw and kill the screen.
  if (openTicketFor !== eventId) return;

  const res = await apiFetch(`${apiBase}/v1/events/${eventId}/ticket/qr`, {
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) return;
  const body = (await res.json()) as { code: string; expiresAt: string };

  const canvas = document.getElementById("ev-qr") as HTMLCanvasElement | null;
  if (!canvas || openTicketFor !== eventId) return;
  await QRCode.toCanvas(canvas, body.code, { width: 260, margin: 1 });

  const msLeft = new Date(body.expiresAt).getTime() - Date.now() - QR_REFRESH_MARGIN_MS;
  qrTimer = setTimeout(() => void refreshQr(eventId), Math.max(5_000, msLeft));
}

/** Poll cadence while a round is on screen — §9.2.5's "5 s in-round poll". */
const LIVE_POLL_MS = 5_000;

/**
 * The party screen.
 *
 * Deliberately has no message field, no list of who else is here, and no
 * verdict: Party Mode lives inside NO IN-APP CHAT rather than carving an
 * exception out of it, and the thumbs open two hours after the event with the
 * recap so nobody is visibly rating people standing in the room.
 */
async function renderLive(eventId: string): Promise<void> {
  openLiveFor = eventId;
  openTicketFor = null;
  if (qrTimer) clearTimeout(qrTimer);
  await pollLive(eventId);
}

async function pollLive(eventId: string): Promise<void> {
  if (liveTimer) clearTimeout(liveTimer);
  // The user may have gone back while the request was in flight; painting then
  // would replace whatever screen they are actually looking at.
  if (openLiveFor !== eventId) return;

  const res = await apiFetch(`${apiBase}/v1/events/${eventId}/live`, {
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok || openLiveFor !== eventId) return;
  const state = (await res.json()) as LiveState;
  if (openLiveFor !== eventId) return;

  paintLive(eventId, state);
  liveTimer = setTimeout(() => void pollLive(eventId), LIVE_POLL_MS);
}

function paintLive(eventId: string, state: LiveState): void {
  const event = events.find((e) => e.id === eventId);
  const head =
    `<button class="ev-back" data-back="1">← ${esc(t.back)}</button>` +
    `<h2 class="ev-title">${esc(event?.title ?? t.liveTitle)}</h2>`;

  // Check-in is the gate (§9.1) — until the door has scanned them, the honest
  // answer is what to do about it, not an empty round.
  if (!state.checkedIn) {
    root.innerHTML = h(`<section class="ev-live">${head}
      <p class="ev-hint">${esc(t.liveDoor)}</p>
      <button class="ev-cta" data-ticket="${esc(eventId)}">${esc(t.showTicket)}</button>
    </section>`);
    return;
  }

  const chip = state.paused
    ? `<button class="ev-secondary" data-resume="${esc(eventId)}">${esc(t.liveResume)}</button>`
    : `<button class="ev-secondary" data-pause="${esc(eventId)}">${esc(t.livePause)}</button>`;

  if (!state.pairing) {
    root.innerHTML = h(`<section class="ev-live">${head}
      <p class="ev-hint">${esc(state.paused ? t.livePaused : t.liveWaiting)}</p>
      ${chip}
    </section>`);
    return;
  }

  const p = state.pairing;
  if (p.mutual && celebrated !== p.pairingId) {
    celebrated = p.pairingId;
    tg?.HapticFeedback?.notificationOccurred?.("success");
  }

  const met = p.mutual
    ? `<div class="ev-mutual">${esc(t.liveMutual)}</div>`
    : p.iConfirmed
      ? `<div class="ev-note">${esc(t.liveMetDone)}</div>`
      : `<button class="ev-cta" data-met="${esc(p.pairingId)}" data-live-event="${esc(eventId)}">${esc(t.liveMet)}</button>`;

  root.innerHTML = h(`<section class="ev-live">${head}
    <div class="ev-round">${esc(t.liveMeet)} <strong>${esc(p.partnerFirstName ?? "")}</strong></div>
    <div class="ev-spot">${esc(t.liveAt)} <strong>${esc(p.spotLabel)}</strong></div>
    <div class="ev-code"><span>${esc(t.liveCode)}</span><b>${p.code}</b></div>
    ${p.mission ? `<p class="ev-mission">${esc(p.mission)}</p>` : ""}
    ${met}
    ${chip}
  </section>`);
}

async function post(path: string, body?: unknown): Promise<Response> {
  return apiFetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { Authorization: `tma ${initData}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

root.addEventListener("click", (ev) => {
  const target = (ev.target as HTMLElement).closest(
    "[data-apply],[data-claim],[data-ticket],[data-back],[data-rotate],[data-live],[data-met],[data-pause],[data-resume]",
  );
  if (!(target instanceof HTMLElement)) return;

  const apply = target.dataset.apply;
  const claim = target.dataset.claim;
  const ticket = target.dataset.ticket;
  const rotate = target.dataset.rotate;

  void (async () => {
    try {
      if (target.dataset.back) {
        openTicketFor = null;
        openLiveFor = null;
        if (qrTimer) clearTimeout(qrTimer);
        if (liveTimer) clearTimeout(liveTimer);
        renderList();
        return;
      }
      if (target.dataset.live) {
        await renderLive(target.dataset.live);
        return;
      }
      if (target.dataset.met) {
        target.setAttribute("disabled", "true");
        await post(`/v1/events/${target.dataset.liveEvent}/pairings/${target.dataset.met}/met`);
        // Repaint from the server rather than from the tap: whether this is a
        // mutual is the server's answer, and guessing it here is exactly how a
        // blind decision stops being blind.
        await pollLive(target.dataset.liveEvent ?? "");
        return;
      }
      if (target.dataset.pause || target.dataset.resume) {
        const id = target.dataset.pause ?? target.dataset.resume ?? "";
        target.setAttribute("disabled", "true");
        await post(`/v1/events/${id}/pause`, { paused: Boolean(target.dataset.pause) });
        await pollLive(id);
        return;
      }
      if (apply) {
        target.setAttribute("disabled", "true");
        await post(`/v1/events/${apply}/apply`);
        await load();
        renderList();
        return;
      }
      if (claim) {
        target.setAttribute("disabled", "true");
        const res = await post(`/v1/events/${claim}/ticket`, { tierId: target.dataset.tier });
        await load();
        if (res.ok) await renderTicket(claim);
        else renderList();
        return;
      }
      if (ticket) {
        await renderTicket(ticket);
        return;
      }
      if (rotate) {
        await post(`/v1/events/${rotate}/ticket/rotate`);
        await refreshQr(rotate);
        tg?.HapticFeedback?.notificationOccurred?.("success");
      }
    } catch {
      root.innerHTML = h(`<div class="ev-empty">${esc(t.error)}</div>`);
    }
  })();
});

async function boot(): Promise<void> {
  applyTheme(getTheme());
  tg?.ready?.();
  tg?.expand?.();
  document.title = t.title;
  try {
    await load();
    renderList();
  } catch {
    root.innerHTML = h(`<div class="ev-empty">${esc(t.error)}</div>`);
  }
}

void boot();
