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

interface RecapPairing {
  pairingId: string;
  partnerFirstName: string | null;
  /** This side's own answer. Null until given; once given it is final. */
  myThumb: boolean | null;
  mutual: boolean;
}

interface RecapState {
  open: boolean;
  opensAt: string | null;
  eventTitle: string;
  pairings: RecapPairing[];
  feedbackSubmitted: boolean;
  discount: { pct: number; expiresAt: string } | null;
}

let events: EventRow[] = [];
let openTicketFor: string | null = null;
let qrTimer: ReturnType<typeof setTimeout> | null = null;
/** Which event's live screen is open, if any — the poll's own cancel token. */
let openLiveFor: string | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;
/** Last mutual we celebrated, so a poll cannot re-fire the haptic every 5s. */
let celebrated: string | null = null;
/** Which event's recap is open — the recap does not poll, so this is only the
 *  back button's memory and the target for a re-paint after a thumb. */
let openRecapFor: string | null = null;
let recapState: RecapState | null = null;

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
    recap: "Итоги вечера",
    recapTitle: "Как прошёл вечер",
    recapNotYet: "Откроем чуть позже — пока все ещё расходятся.",
    recapNobody: "Ты никого не отметил в этот вечер. Расскажи, как было.",
    recapAsk: "С кем хочется увидеться ещё?",
    recapYes: "Да",
    recapNo: "Нет",
    recapAnswered: "Ответ записан",
    recapMutual: "Взаимно ✨ Скоро всё устроим",
    recapNoRecap: "Не нашли твоих итогов по этому вечеру.",
    fbTitle: "Как тебе вечер?",
    fbRating: "Оценка",
    fbSafety: "Было комфортно?",
    fbFine: "Всё хорошо",
    fbUncomfortable: "Некомфортно",
    fbUnsafe: "Небезопасно",
    fbText: "Что запомнилось? (по желанию)",
    fbSend: "Отправить",
    fbThanks: "Спасибо — это правда помогает.",
    fbDiscount: "Скидка {pct}% на следующий билет на свидание",
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
    recap: "Last night",
    recapTitle: "How the evening went",
    recapNotYet: "Opening a little later — everyone's still heading home.",
    recapNobody: "You didn't mark anyone that evening. Tell us how it was.",
    recapAsk: "Who would you like to see again?",
    recapYes: "Yes",
    recapNo: "No",
    recapAnswered: "Answer recorded",
    recapMutual: "It's mutual \u2728 We'll set it up shortly",
    recapNoRecap: "We have no recap for you for that evening.",
    fbTitle: "How was it?",
    fbRating: "Rating",
    fbSafety: "Did you feel comfortable?",
    fbFine: "All good",
    fbUncomfortable: "Uncomfortable",
    fbUnsafe: "Unsafe",
    fbText: "Anything that stayed with you? (optional)",
    fbSend: "Send",
    fbThanks: "Thank you — this genuinely helps.",
    fbDiscount: "{pct}% off your next date ticket",
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
      } else if (event.hasTicket && Date.parse(event.endsAt) < Date.now()) {
        // The evening is over, so the ticket is a souvenir and the recap is the
        // thing. Offered on `hasTicket` rather than on check-in, which this
        // payload does not carry — someone who never came gets a plain "no
        // recap" rather than a button that is not there, and the difference is
        // one tap against another round trip on every card in the list.
        action = `<button class="ev-cta" data-recap="${esc(event.id)}">${esc(t.recap)}</button>`;
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

/**
 * The morning after (§11).
 *
 * Deliberately NOT polled. The live screen refreshes every few seconds because
 * a round can open under the user; nothing here changes without them, except a
 * partner's thumb — and learning of a mutual on the next open rather than
 * mid-scroll costs nothing, while a poll on a screen with a text field in it
 * would fight the keyboard.
 */
async function renderRecap(eventId: string): Promise<void> {
  openRecapFor = eventId;
  openLiveFor = null;
  if (liveTimer) clearTimeout(liveTimer);

  const res = await apiFetch(`${apiBase}/v1/events/${eventId}/recap`, {
    headers: { Authorization: `tma ${initData}` },
  });
  if (!res.ok) {
    root.innerHTML = h(`
      <section class="ev-live">
        <button class="ev-back" data-back="1">← ${esc(t.back)}</button>
        <div class="ev-empty">${esc(t.recapNoRecap)}</div>
      </section>`);
    return;
  }
  recapState = (await res.json()) as RecapState;
  if (openRecapFor !== eventId) return;
  paintRecap(eventId, recapState);
}

function paintRecap(eventId: string, state: RecapState): void {
  const header =
    `<button class="ev-back" data-back="1">← ${esc(t.back)}</button>` +
    `<h2 class="ev-title">${esc(state.eventTitle || t.recapTitle)}</h2>`;

  if (!state.open) {
    root.innerHTML = h(`
      <section class="ev-live">
        ${header}
        <div class="ev-note">${esc(t.recapNotYet)}</div>
      </section>`);
    return;
  }

  const people = state.pairings.length
    ? `<div class="ev-recap-ask">${esc(t.recapAsk)}</div>` +
      state.pairings
        .map((p) => {
          const name = esc(p.partnerFirstName ?? "—");
          // Answered is a dead end by design: the first answer is final, so
          // the buttons go away rather than staying tappable and doing nothing.
          if (p.myThumb !== null) {
            const note = p.mutual ? t.recapMutual : t.recapAnswered;
            return `<div class="ev-recap-row is-done"><span>${name}</span>` +
              `<span class="ev-recap-note${p.mutual ? " is-mutual" : ""}">${esc(note)}</span></div>`;
          }
          return `<div class="ev-recap-row"><span>${name}</span>
            <span class="ev-recap-actions">
              <button class="ev-thumb is-no" data-thumb="${esc(p.pairingId)}" data-value="0" data-recap-event="${esc(eventId)}">${esc(t.recapNo)}</button>
              <button class="ev-thumb is-yes" data-thumb="${esc(p.pairingId)}" data-value="1" data-recap-event="${esc(eventId)}">${esc(t.recapYes)}</button>
            </span></div>`;
        })
        .join("")
    : `<div class="ev-note">${esc(t.recapNobody)}</div>`;

  const discount = state.discount
    ? `<div class="ev-recap-discount">${esc(
        t.fbDiscount.replace("{pct}", String(state.discount.pct)),
      )}</div>`
    : "";

  const feedback = state.feedbackSubmitted
    ? `<div class="ev-recap-thanks">${esc(t.fbThanks)}</div>${discount}`
    : `<form class="ev-fb" data-fb="${esc(eventId)}">
        <h3 class="ev-fb-title">${esc(t.fbTitle)}</h3>
        <div class="ev-fb-label">${esc(t.fbRating)}</div>
        <div class="ev-fb-scale">
          ${Array.from({ length: 10 }, (_, i) => i + 1)
            .map(
              (n) =>
                `<button type="button" class="ev-fb-num" data-rating="${n}">${n}</button>`,
            )
            .join("")}
        </div>
        <div class="ev-fb-label">${esc(t.fbSafety)}</div>
        <div class="ev-fb-safety">
          <button type="button" class="ev-fb-chip" data-safety="everything_fine">${esc(t.fbFine)}</button>
          <button type="button" class="ev-fb-chip" data-safety="uncomfortable">${esc(t.fbUncomfortable)}</button>
          <button type="button" class="ev-fb-chip is-unsafe" data-safety="unsafe">${esc(t.fbUnsafe)}</button>
        </div>
        <textarea class="ev-fb-text" rows="3" placeholder="${esc(t.fbText)}"></textarea>
        <button type="submit" class="ev-cta">${esc(t.fbSend)}</button>
      </form>`;

  root.innerHTML = h(`<section class="ev-live">${header}${people}${feedback}</section>`);
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
    "[data-apply],[data-claim],[data-ticket],[data-back],[data-rotate],[data-live],[data-met]," +
      "[data-pause],[data-resume],[data-recap],[data-thumb],[data-rating],[data-safety]",
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
        openRecapFor = null;
        if (qrTimer) clearTimeout(qrTimer);
        if (liveTimer) clearTimeout(liveTimer);
        renderList();
        return;
      }
      if (target.dataset.live) {
        await renderLive(target.dataset.live);
        return;
      }
      if (target.dataset.recap) {
        await renderRecap(target.dataset.recap);
        return;
      }
      if (target.dataset.thumb) {
        const eventId = target.dataset.recapEvent ?? "";
        target.setAttribute("disabled", "true");
        await post(`/v1/events/${eventId}/pairings/${target.dataset.thumb}/thumbs`, {
          value: target.dataset.value === "1",
        });
        // Re-read rather than painting the tap: whether this turned out to be
        // mutual is the server's answer, and deciding it here is exactly how a
        // blind decision stops being blind.
        await renderRecap(eventId);
        return;
      }
      if (target.dataset.rating || target.dataset.safety) {
        // Selection only — the form is submitted by its own button. Marking
        // the choice in the DOM rather than in a variable keeps the state
        // where the user can see it, which is also where the submit reads it.
        const group = target.dataset.rating ? "[data-rating]" : "[data-safety]";
        target
          .closest("form")
          ?.querySelectorAll(group)
          .forEach((el) => el.classList.remove("is-picked"));
        target.classList.add("is-picked");
        tg?.HapticFeedback?.selectionChanged?.();
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

root.addEventListener("submit", (ev) => {
  const form = (ev.target as HTMLElement).closest("form[data-fb]");
  if (!(form instanceof HTMLFormElement)) return;
  ev.preventDefault();
  const eventId = form.dataset.fb ?? "";
  const rating = form.querySelector("[data-rating].is-picked") as HTMLElement | null;
  const safety = form.querySelector("[data-safety].is-picked") as HTMLElement | null;
  const text = (form.querySelector(".ev-fb-text") as HTMLTextAreaElement | null)?.value ?? "";

  void (async () => {
    try {
      form.querySelector("[type=submit]")?.setAttribute("disabled", "true");
      await post(`/v1/events/${eventId}/feedback`, {
        rating: rating ? Number(rating.dataset.rating) : null,
        safety: safety?.dataset.safety ?? null,
        text: text.trim() || null,
      });
      // Re-read so the discount line comes from the server. It may be one the
      // user already held rather than one this answer earned, and the screen
      // must say what is true rather than what the tap hoped for.
      await renderRecap(eventId);
      tg?.HapticFeedback?.notificationOccurred?.("success");
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
    // The T+18h message links straight here, so a recap opened from it must
    // not make the reader find their own event in a list first.
    const params = new URLSearchParams(location.search);
    const deepEventId = params.get("eventId");
    if (params.get("view") === "recap" && deepEventId) {
      await renderRecap(deepEventId);
      return;
    }
    renderList();
  } catch {
    root.innerHTML = h(`<div class="ev-empty">${esc(t.error)}</div>`);
  }
}

void boot();
