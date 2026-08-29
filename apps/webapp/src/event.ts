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

let events: EventRow[] = [];
let openTicketFor: string | null = null;
let qrTimer: ReturnType<typeof setTimeout> | null = null;

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
      if (event.hasTicket) {
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

async function post(path: string, body?: unknown): Promise<Response> {
  return apiFetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { Authorization: `tma ${initData}`, "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

root.addEventListener("click", (ev) => {
  const target = (ev.target as HTMLElement).closest("[data-apply],[data-claim],[data-ticket],[data-back],[data-rotate]");
  if (!(target instanceof HTMLElement)) return;

  const apply = target.dataset.apply;
  const claim = target.dataset.claim;
  const ticket = target.dataset.ticket;
  const rotate = target.dataset.rotate;

  void (async () => {
    try {
      if (target.dataset.back) {
        openTicketFor = null;
        if (qrTimer) clearTimeout(qrTimer);
        renderList();
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
