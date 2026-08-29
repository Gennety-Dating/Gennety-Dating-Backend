import jsQR from "jsqr";
import { apiBase, apiFetch } from "./api.js";
import "./gatekeeper.css";

/**
 * `/gatekeeper.html` — the venue door portal (LAUNCH_EVENTS_PRODUCT_SPEC.md §8).
 *
 * ── Who this page is for, because it decides almost everything ───────────
 *
 * Venue staff. NOT a Gennety user: no Telegram, no account, no `initData`, no
 * theme preference of their own. They authenticate with a per-event token the
 * admin hub mints and reads once, they are standing at a door in a dim room,
 * and they are holding a phone in one hand.
 *
 * So: the token lives in `localStorage` (typing a token per guest is not a
 * product), the page is dark unconditionally rather than theme-aware, the
 * verdict is the largest thing on screen, and every refusal names ITSELF
 * rather than collapsing into "invalid" — staff have to say a different
 * sentence to the person in front of them for each one.
 */

const params = new URLSearchParams(location.search);
const eventId = params.get("event") ?? "";
const lang = (params.get("lang") ?? "en").startsWith("ru") ? "ru" : "en";

const TOKEN_KEY = `gennety.gk.${eventId}`;
/** How long a verdict stays on screen before the scanner re-arms itself. */
const VERDICT_HOLD_MS = 2600;
/** The door polls its own headcount; slow, because nobody is watching it. */
const STATS_POLL_MS = 20_000;

const COPY = {
  ru: {
    title: "Вход",
    tokenAsk: "Введите ключ входа",
    tokenHint: "Ключ выдаёт организатор. Он сохранится на этом телефоне.",
    enter: "Войти",
    badToken: "Ключ не подошёл",
    scan: "Наведите на QR гостя",
    cameraDenied: "Нет доступа к камере. Разрешите его в настройках браузера.",
    manual: "Ввести код вручную",
    inside: "Внутри",
    of: "из",
    perk: "Напиток",
    perkDone: "Напиток выдан",
    searchGuest: "Найти по имени",
    noGuest: "Нет в списке",
    listEmpty: "Список не загрузился",
    checkedIn: "уже отмечен",
    close: "Закрыть",
    outcomes: {
      admitted: "Проходите",
      already_used: "Уже прошёл",
      expired: "Код устарел — попросите обновить",
      stale_code: "Старый код — попросите обновить",
      revoked: "Билет отозван",
      bad_signature: "Код не наш",
      malformed: "Код не читается",
      wrong_version: "Старая версия приложения",
      wrong_event: "Билет на другое мероприятие",
      unknown_ticket: "Билет не найден",
      offline: "Нет связи — сверьтесь со списком",
      error: "Ошибка. Попробуйте ещё раз",
    },
  },
  en: {
    title: "Door",
    tokenAsk: "Enter your door key",
    tokenHint: "The organiser gives you this. It stays on this phone.",
    enter: "Enter",
    badToken: "That key didn't work",
    scan: "Point at the guest's QR",
    cameraDenied: "No camera access. Allow it in your browser settings.",
    manual: "Type the code instead",
    inside: "Inside",
    of: "of",
    perk: "Drink",
    perkDone: "Drink given",
    searchGuest: "Find by name",
    noGuest: "Not on the list",
    listEmpty: "The list didn't load",
    checkedIn: "already checked in",
    close: "Close",
    outcomes: {
      admitted: "Let them in",
      already_used: "Already inside",
      expired: "Code expired — ask them to refresh",
      stale_code: "Old code — ask them to refresh",
      revoked: "Ticket revoked",
      bad_signature: "Not one of ours",
      malformed: "Unreadable code",
      wrong_version: "Outdated app",
      wrong_event: "Ticket for another event",
      unknown_ticket: "Ticket not found",
      offline: "Offline — check the guest list",
      error: "Something went wrong. Try again",
    },
  },
} as const;

const t = COPY[lang];

interface ScanVerdict {
  ok: boolean;
  outcome: keyof typeof t.outcomes;
  ticketId?: string;
  firstName?: string;
  age?: number;
  perkRedeemedAt?: string | null;
}

interface Guest {
  ticketId: string;
  firstName: string;
  age: number | null;
  photo: string | null;
  checkedInAt: string | null;
}

let token = "";
let manifest: Guest[] = [];
let statsTimer: ReturnType<typeof setInterval> | null = null;
let scanning = false;
let lastCode = "";

const root = document.getElementById("app") as HTMLElement;

function esc(value: string | null | undefined): string {
  return (value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

async function gk(path: string, init?: RequestInit): Promise<Response> {
  return apiFetch(`${apiBase}/gk/${eventId}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

// ── The token screen ──────────────────────────────────────────────────────

function renderTokenScreen(error?: string): void {
  root.innerHTML = `
    <div class="gk-gate">
      <h1 class="gk-gate-title">${esc(t.tokenAsk)}</h1>
      <input class="gk-input" id="gk-token" type="text" autocomplete="off"
             autocapitalize="off" autocorrect="off" spellcheck="false" />
      ${error ? `<div class="gk-gate-error">${esc(error)}</div>` : ""}
      <button class="gk-primary" id="gk-enter">${esc(t.enter)}</button>
      <p class="gk-gate-hint">${esc(t.tokenHint)}</p>
    </div>`;

  const input = document.getElementById("gk-token") as HTMLInputElement;
  const submit = async (): Promise<void> => {
    const candidate = input.value.trim();
    if (!candidate) return;
    token = candidate;
    const res = await gk("/auth", { method: "POST", body: "{}" });
    if (!res.ok) {
      token = "";
      renderTokenScreen(t.badToken);
      return;
    }
    try {
      localStorage.setItem(TOKEN_KEY, candidate);
    } catch {
      // A door phone in private mode still works — it just asks again tomorrow.
    }
    await startDoor();
  };

  document.getElementById("gk-enter")?.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  input.focus();
}

// ── The door ──────────────────────────────────────────────────────────────

async function startDoor(): Promise<void> {
  root.innerHTML = `
    <div class="gk-door">
      <div class="gk-stats" id="gk-stats"></div>
      <div class="gk-viewport">
        <video class="gk-video" id="gk-video" playsinline muted></video>
        <div class="gk-reticle"></div>
      </div>
      <div class="gk-prompt" id="gk-prompt">${esc(t.scan)}</div>
      <button class="gk-manual" id="gk-manual">${esc(t.manual)}</button>
      <div class="gk-verdict" id="gk-verdict" hidden></div>
    </div>`;

  document.getElementById("gk-manual")?.addEventListener("click", () => {
    const typed = prompt(t.manual);
    if (typed?.trim()) void submitCode(typed.trim());
  });

  void refreshStats();
  statsTimer = setInterval(() => void refreshStats(), STATS_POLL_MS);
  void loadManifest();
  await startCamera();
}

async function refreshStats(): Promise<void> {
  try {
    const res = await gk("/stats");
    if (!res.ok) return;
    const body = (await res.json()) as { insideNow: number; capacityTotal: number };
    const el = document.getElementById("gk-stats");
    if (el) {
      el.textContent = `${t.inside}: ${body.insideNow} ${t.of} ${body.capacityTotal}`;
    }
  } catch {
    // The headcount is a nicety; the door works without it.
  }
}

/**
 * Pull the guest list while there is still signal, so a scan that cannot reach
 * the server degrades into "check this name" rather than into nothing.
 */
async function loadManifest(): Promise<void> {
  try {
    const res = await gk("/manifest");
    if (!res.ok) return;
    const body = (await res.json()) as { guests: Guest[] };
    manifest = body.guests;
  } catch {
    // Offline already; the door falls back to refusing politely.
  }
}

// ── Reading the code ──────────────────────────────────────────────────────

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

async function startCamera(): Promise<void> {
  const video = document.getElementById("gk-video") as HTMLVideoElement;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
    });
  } catch {
    setPrompt(t.cameraDenied);
    return;
  }
  video.srcObject = stream;
  await video.play();
  scanning = true;

  // `BarcodeDetector` is hardware-accelerated where it exists and simply absent
  // on iOS Safari, which is most of the phones a venue will actually hand its
  // staff — so jsQR is the path that has to be reliable, not the fallback that
  // is allowed to rot.
  const detector = window.BarcodeDetector
    ? new window.BarcodeDetector({ formats: ["qr_code"] })
    : null;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const tick = async (): Promise<void> => {
    if (!scanning) {
      requestAnimationFrame(() => void tick());
      return;
    }
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      let found: string | null = null;
      if (detector) {
        try {
          const codes = await detector.detect(video);
          found = codes[0]?.rawValue ?? null;
        } catch {
          found = null;
        }
      } else if (ctx) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        found = jsQR(image.data, image.width, image.height)?.data ?? null;
      }
      // The camera sees the same code many times a second; one scan is one
      // guest, so a repeat of the code already on screen is ignored outright.
      if (found && found !== lastCode) {
        lastCode = found;
        await submitCode(found);
      }
    }
    requestAnimationFrame(() => void tick());
  };
  void tick();
}

function setPrompt(text: string): void {
  const el = document.getElementById("gk-prompt");
  if (el) el.textContent = text;
}

async function submitCode(code: string): Promise<void> {
  scanning = false;
  try {
    const res = await gk("/scan", { method: "POST", body: JSON.stringify({ code }) });
    if (!res.ok) {
      showVerdict({ ok: false, outcome: "error" });
      return;
    }
    showVerdict((await res.json()) as ScanVerdict);
  } catch {
    // No signal. The manifest is the honest fallback: it can say who is on the
    // list, and it deliberately cannot admit anyone — nothing offline is
    // allowed to write a check-in.
    showVerdict({ ok: false, outcome: "offline" });
  }
}

/**
 * The offline fallback, and the reason `loadManifest` exists at all.
 *
 * A scan that cannot reach the server used to say "check the guest list" and
 * show nothing, which is a sentence pointing at a list the page was holding and
 * never rendered. Staff get the actual list, searchable by name.
 *
 * It deliberately cannot admit anyone: there is no button here, and nothing
 * offline is allowed to write a check-in. That is the whole reason this is a
 * *list* and not a door — a phone that could let people in while it cannot
 * reach the server is a phone that can let the same ticket in twice.
 */
function renderOfflineList(el: HTMLElement): void {
  el.className = "gk-verdict is-no";
  el.hidden = false;

  if (manifest.length === 0) {
    el.innerHTML = `
      <div class="gk-outcome">${esc(t.outcomes.offline)}</div>
      <div class="gk-who">${esc(t.listEmpty)}</div>
      <button class="gk-perk" id="gk-close">${esc(t.close)}</button>`;
  } else {
    el.innerHTML = `
      <div class="gk-outcome">${esc(t.outcomes.offline)}</div>
      <input class="gk-input gk-search" id="gk-search" type="text" autocomplete="off"
             autocapitalize="off" autocorrect="off" spellcheck="false"
             placeholder="${esc(t.searchGuest)}" />
      <div class="gk-list" id="gk-list"></div>
      <button class="gk-perk" id="gk-close">${esc(t.close)}</button>`;

    const list = el.querySelector("#gk-list") as HTMLElement;
    const search = el.querySelector("#gk-search") as HTMLInputElement;
    const draw = (): void => {
      const q = search.value.trim().toLowerCase();
      const hits = q
        ? manifest.filter((g) => g.firstName.toLowerCase().includes(q))
        : manifest;
      list.innerHTML = hits.length
        ? hits
            .slice(0, 60)
            .map(
              (g) => `<div class="gk-list-row${g.checkedInAt ? " is-in" : ""}">
                <span>${esc(g.firstName)}${g.age ? `, ${g.age}` : ""}</span>
                ${g.checkedInAt ? `<span class="gk-list-tag">${esc(t.checkedIn)}</span>` : ""}
              </div>`,
            )
            .join("")
        : `<div class="gk-list-empty">${esc(t.noGuest)}</div>`;
    };
    search.addEventListener("input", draw);
    draw();
  }

  // No auto-dismiss: this one is READ rather than glanced at, and a list that
  // vanishes while someone is searching it is worse than no list.
  el.querySelector("#gk-close")?.addEventListener("click", () => {
    el.hidden = true;
    lastCode = "";
    scanning = true;
  });
}

function showVerdict(verdict: ScanVerdict): void {
  const el = document.getElementById("gk-verdict");
  if (!el) return;

  if (verdict.outcome === "offline") {
    renderOfflineList(el);
    return;
  }

  const label = t.outcomes[verdict.outcome] ?? t.outcomes.error;
  const who = verdict.firstName
    ? `<div class="gk-who">${esc(verdict.firstName)}${verdict.age ? `, ${verdict.age}` : ""}</div>`
    : "";
  const perk =
    verdict.ok && verdict.ticketId
      ? verdict.perkRedeemedAt
        ? `<div class="gk-perk-done">${esc(t.perkDone)}</div>`
        : `<button class="gk-perk" data-perk="${esc(verdict.ticketId)}">${esc(t.perk)}</button>`
      : "";

  el.className = `gk-verdict ${verdict.ok ? "is-ok" : "is-no"}`;
  el.hidden = false;
  el.innerHTML = `<div class="gk-outcome">${esc(label)}</div>${who}${perk}`;

  el.querySelector("[data-perk]")?.addEventListener("click", (ev) => {
    const id = (ev.currentTarget as HTMLElement).dataset.perk;
    if (id) void redeemPerk(id, ev.currentTarget as HTMLElement);
  });

  void refreshStats();

  // The scanner re-arms itself rather than waiting for a tap: the person
  // holding the phone has a queue in front of them and one free hand.
  setTimeout(() => {
    el.hidden = true;
    lastCode = "";
    scanning = true;
  }, VERDICT_HOLD_MS);
}

async function redeemPerk(ticketId: string, button: HTMLElement): Promise<void> {
  button.setAttribute("disabled", "true");
  try {
    const res = await gk(`/perk/${ticketId}`, { method: "POST", body: "{}" });
    button.outerHTML = `<div class="gk-perk-done">${esc(res.ok ? t.perkDone : t.outcomes.error)}</div>`;
  } catch {
    button.outerHTML = `<div class="gk-perk-done">${esc(t.outcomes.offline)}</div>`;
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  document.title = `Gennety · ${t.title}`;
  if (!eventId) {
    root.innerHTML = `<div class="gk-gate"><h1 class="gk-gate-title">?event=…</h1></div>`;
    return;
  }
  let saved = "";
  try {
    saved = localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    saved = "";
  }
  if (!saved) {
    renderTokenScreen();
    return;
  }
  token = saved;
  const res = await gk("/auth", { method: "POST", body: "{}" }).catch(() => null);
  if (!res?.ok) {
    // A revoked token must not leave a door phone in a half-authenticated
    // state that fails on every scan instead of on the way in.
    token = "";
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* nothing to clear */
    }
    renderTokenScreen(res ? t.badToken : undefined);
    return;
  }
  await startDoor();
}

void boot();

// Stop the poll if the page is torn down mid-shift; the camera stream dies
// with the document.
window.addEventListener("pagehide", () => {
  if (statsTimer) clearInterval(statsTimer);
  scanning = false;
});
