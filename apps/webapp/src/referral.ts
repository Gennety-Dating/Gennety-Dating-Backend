import { apiFetch } from "./api.js";
import "./theme.css";
import "./referral.css";
import { icon, type IconName } from "./icons";
import { butterflyLoaderMarkup } from "./butterfly-loader";
import { wireContentInsets } from "./telegram-insets";
import { wireReturnBackButton, type ReturnPage } from "./return-to.js";

/**
 * Referral Mini App (§Referral) — "Invite friends, earn Date Tickets". A small
 * vanilla-TS page that states the one rule (every friend who passes
 * verification: tickets for both sides), what the referrer has earned so far,
 * how many rewards are left under the lifetime cap, and a one-tap Invite
 * button. The button mints a prepared inline message server-side
 * (`POST /v1/referral/share-message`) and hands its id to
 * `WebApp.shareMessage`, so the user forwards a branded invite in one tap with
 * nothing to fill in. Reward accounting is entirely server-side.
 *
 * Tickets only, by founder decision (2026-09-22): the program no longer grants
 * Premium in any form, and no referral is ever expressed in money — so there is
 * no milestone ladder, no "months" and no USD value on this screen any more.
 */

const app = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

type Lang = "en" | "ru" | "uk" | "de" | "pl";
const rawLang = params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? "en";
const lang: Lang = (["en", "ru", "uk", "de", "pl"] as const).includes(rawLang as Lang)
  ? (rawLang as Lang)
  : "en";

const getInitData = (): string => app?.initData ?? "";

/**
 * Preview mode — renders the full UI with mock data and no network call, so
 * the screen can be opened in a plain browser (no Telegram, no initData) for
 * design review. Triggered explicitly by `?preview` or implicitly whenever
 * there is no Telegram initData (i.e. opened outside a Mini App). The real
 * in-Telegram flow is unaffected: inside a Mini App `initData` is always
 * present, so this never masks the live `/v1/referral/state` fetch there.
 * `?preview=maxed` shows the cap-reached state.
 */
const PREVIEW = params.has("preview") || getInitData() === "";

/** `GET /v1/referral/state`. Every field but `inviteLink` is a count. */
interface ReferralState {
  ok: true;
  inviteLink: string;
  /** Invited friends who passed verification. */
  verifiedCount: number;
  /** Tickets already credited to the referrer's wallet. */
  earnedTickets: number;
  /** Tickets held back by the daily velocity cap; credited automatically. */
  pendingTickets: number;
  /** Tickets the referrer gets per verified friend. */
  ticketsPerFriend: number;
  /** Tickets the invited friend gets once THEY pass verification (0 = none). */
  inviteeTickets: number;
  /** Lifetime cap on rewarded friends. */
  rewardCap: number;
  /** Rewards still available under `rewardCap`. */
  rewardsLeft: number;
}

const PREVIEW_STATE: ReferralState =
  params.get("preview") === "maxed"
    ? {
        ok: true,
        inviteLink: "https://t.me/gennetybot?start=referral_preview",
        verifiedCount: 22,
        earnedTickets: 20,
        pendingTickets: 0,
        ticketsPerFriend: 1,
        inviteeTickets: 1,
        rewardCap: 20,
        rewardsLeft: 0,
      }
    : {
        ok: true,
        inviteLink: "https://t.me/gennetybot?start=referral_preview",
        verifiedCount: 3,
        earnedTickets: 2,
        pendingTickets: 1,
        ticketsPerFriend: 1,
        inviteeTickets: 1,
        rewardCap: 20,
        rewardsLeft: 17,
      };

/**
 * A count from the wire, or `fallback` when it is missing or not a sane
 * number — so a server a release behind degrades to a shorter screen rather
 * than printing "NaN" on it.
 */
function count(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

function normalize(raw: Partial<ReferralState>): ReferralState {
  const rewardCap = count(raw.rewardCap, 0);
  return {
    ok: true,
    inviteLink: typeof raw.inviteLink === "string" ? raw.inviteLink : "",
    verifiedCount: count(raw.verifiedCount, 0),
    earnedTickets: count(raw.earnedTickets, 0),
    pendingTickets: count(raw.pendingTickets, 0),
    ticketsPerFriend: count(raw.ticketsPerFriend, 1),
    inviteeTickets: count(raw.inviteeTickets, 0),
    rewardCap,
    rewardsLeft: Math.min(count(raw.rewardsLeft, rewardCap), rewardCap),
  };
}

interface Copy {
  title: string;
  /** The one rule; `invitee` 0 drops the "for them" half. */
  rule: (tickets: number, invitee: number) => string;
  statVerified: string;
  statEarned: string;
  pending: (n: number) => string;
  rewardsLeft: (left: number, cap: number) => string;
  maxed: string;
  share: string;
  /** Said next to the button, so nobody expects the ticket on send. */
  timing: string;
  shareHint: string;
  shareSent: string;
  shareFail: string;
  loadFail: string;
}

const COPY: Record<Lang, Copy> = {
  en: {
    title: "Invite friends",
    rule: (t, i) =>
      i > 0
        ? `Every friend who passes verification: +${t}\u00a0🎟 for you, +${i}\u00a0🎟 for them.`
        : `Every friend who passes verification: +${t}\u00a0🎟 for you.`,
    statVerified: "VERIFIED",
    statEarned: "TICKETS EARNED",
    pending: (n) => `+${n}\u00a0🎟 on the way — credited automatically.`,
    rewardsLeft: (left, cap) => `${left} of ${cap} rewards left`,
    maxed: "You've earned every reward — thank you\u00a0💛",
    share: "Invite a friend",
    timing: "Tickets arrive once your friend passes verification.",
    shareHint: "Forwarded in one tap — nothing to fill in.",
    shareSent: "Invite sent",
    shareFail: "Couldn't open the share sheet — try again.",
    loadFail: "Couldn't load your referrals — try again.",
  },
  ru: {
    title: "Пригласи друзей",
    rule: (t, i) =>
      i > 0
        ? `За каждого друга, прошедшего верификацию: +${t}\u00a0🎟 тебе и +${i}\u00a0🎟 ему.`
        : `За каждого друга, прошедшего верификацию: +${t}\u00a0🎟 тебе.`,
    statVerified: "ПРОШЛИ ВЕРИФИКАЦИЮ",
    statEarned: "БИЛЕТОВ ПОЛУЧЕНО",
    pending: (n) => `+${n}\u00a0🎟 уже в пути — начислим автоматически.`,
    rewardsLeft: (left, cap) => `Осталось наград: ${left} из ${cap}`,
    maxed: "Все награды получены — спасибо\u00a0💛",
    share: "Пригласить друга",
    timing: "Билеты придут, когда друг пройдёт верификацию.",
    shareHint: "Пересылается одним тапом — ничего заполнять не нужно.",
    shareSent: "Приглашение отправлено",
    shareFail: "Не удалось открыть окно шеринга — попробуй ещё раз.",
    loadFail: "Не удалось загрузить рефералов — попробуй ещё раз.",
  },
  uk: {
    title: "Запроси друзів",
    rule: (t, i) =>
      i > 0
        ? `За кожного друга, який пройшов верифікацію: +${t}\u00a0🎟 тобі й +${i}\u00a0🎟 йому.`
        : `За кожного друга, який пройшов верифікацію: +${t}\u00a0🎟 тобі.`,
    statVerified: "ПРОЙШЛИ ВЕРИФІКАЦІЮ",
    statEarned: "КВИТКІВ ОТРИМАНО",
    pending: (n) => `+${n}\u00a0🎟 уже в дорозі — нарахуємо автоматично.`,
    rewardsLeft: (left, cap) => `Залишилося нагород: ${left} з ${cap}`,
    maxed: "Усі нагороди отримано — дякуємо\u00a0💛",
    share: "Запросити друга",
    timing: "Квитки прийдуть, коли друг пройде верифікацію.",
    shareHint: "Пересилається одним тапом — нічого заповнювати не треба.",
    shareSent: "Запрошення надіслано",
    shareFail: "Не вдалося відкрити вікно поширення — спробуй ще раз.",
    loadFail: "Не вдалося завантажити рефералів — спробуй ще раз.",
  },
  de: {
    title: "Freunde einladen",
    rule: (t, i) =>
      i > 0
        ? `Für jeden Freund, der die Verifizierung besteht: +${t}\u00a0🎟 für dich und +${i}\u00a0🎟 für ihn.`
        : `Für jeden Freund, der die Verifizierung besteht: +${t}\u00a0🎟 für dich.`,
    statVerified: "VERIFIZIERT",
    statEarned: "TICKETS VERDIENT",
    pending: (n) => `+${n}\u00a0🎟 unterwegs — wird automatisch gutgeschrieben.`,
    rewardsLeft: (left, cap) => `Noch ${left} von ${cap} Belohnungen übrig`,
    maxed: "Du hast alle Belohnungen geholt — danke\u00a0💛",
    share: "Freund einladen",
    timing: "Die Tickets kommen, sobald dein Freund die Verifizierung besteht.",
    shareHint: "In einem Tap geteilt — nichts auszufüllen.",
    shareSent: "Einladung gesendet",
    shareFail: "Teilen-Fenster ließ sich nicht öffnen — versuch es erneut.",
    loadFail: "Empfehlungen konnten nicht geladen werden — versuch es erneut.",
  },
  pl: {
    title: "Zaproś znajomych",
    rule: (t, i) =>
      i > 0
        ? `Za każdego znajomego, który przejdzie weryfikację: +${t}\u00a0🎟 dla ciebie i +${i}\u00a0🎟 dla niego.`
        : `Za każdego znajomego, który przejdzie weryfikację: +${t}\u00a0🎟 dla ciebie.`,
    statVerified: "ZWERYFIKOWANI",
    statEarned: "ZDOBYTE BILETY",
    pending: (n) => `+${n}\u00a0🎟 w drodze — dopiszemy automatycznie.`,
    rewardsLeft: (left, cap) => `Pozostało nagród: ${left} z ${cap}`,
    maxed: "Masz już wszystkie nagrody — dziękujemy\u00a0💛",
    share: "Zaproś znajomego",
    timing: "Bilety przyjdą, gdy znajomy przejdzie weryfikację.",
    shareHint: "Przesyłane jednym dotknięciem — nic do wypełnienia.",
    shareSent: "Zaproszenie wysłane",
    shareFail: "Nie udało się otworzyć okna udostępniania — spróbuj ponownie.",
    loadFail: "Nie udało się wczytać poleconych — spróbuj ponownie.",
  },
};
const s = COPY[lang];

const root = document.getElementById("root") as HTMLElement;

function esc(v: string): string {
  return v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** Inline SVG markup for a line icon (borderless, inherits currentColor). */
function glyph(name: IconName, cls = "ref-ic"): string {
  return icon(name, cls).outerHTML;
}

function renderLoading(): void {
  root.innerHTML = `<div class="ref-wrap"><div class="ref-loading">${butterflyLoaderMarkup()}</div></div>`;
}

function renderError(msg: string): void {
  root.innerHTML = `<div class="ref-wrap"><p class="ref-error">${esc(msg)}</p></div>`;
}

/**
 * How much of the lifetime cap is left — one line, plus a bar while there is
 * anything left to fill. No cap from the server (a release behind) → nothing,
 * rather than a "0 of 0" that reads as "you're done".
 */
function progressMarkup(state: ReferralState): string {
  if (state.rewardCap <= 0) return "";
  if (state.rewardsLeft <= 0) {
    return `<div class="ref-progress"><span>${esc(s.maxed)}</span></div>`;
  }
  const used = state.rewardCap - state.rewardsLeft;
  const pct = Math.round((used / state.rewardCap) * 100);
  return `<div class="ref-progress"><span>${esc(
    s.rewardsLeft(state.rewardsLeft, state.rewardCap),
  )}</span></div><div class="ref-bar"><i style="width:${pct}%"></i></div>`;
}

function render(state: ReferralState): void {
  const pending =
    state.pendingTickets > 0
      ? `<p class="ref-pending">${esc(s.pending(state.pendingTickets))}</p>`
      : "";

  root.innerHTML = `
    <div class="ref-wrap">
      <div class="ref-hero">
        <h1 class="ref-title">${esc(s.title)}</h1>
        <p class="ref-rule">${esc(s.rule(state.ticketsPerFriend, state.inviteeTickets))}</p>
      </div>
      <div class="ref-stats">
        <div class="ref-stat"><b>${state.verifiedCount}</b><span>${esc(s.statVerified)}</span></div>
        <div class="ref-stat"><b class="ref-earn">${glyph("ticket")}${state.earnedTickets}</b><span>${esc(
          s.statEarned,
        )}</span></div>
      </div>
      ${pending}
      ${progressMarkup(state)}
      <div class="ref-foot">
        <button class="ref-share" id="ref-share">${glyph(
          "letter",
          "ref-ic ref-share-ic",
        )}<span>${esc(s.share)}</span></button>
        <p class="ref-timing">${esc(s.timing)}</p>
        <p class="ref-share-hint">${esc(s.shareHint)}</p>
      </div>
    </div>`;

  const btn = document.getElementById("ref-share") as HTMLButtonElement;
  btn.addEventListener("click", () => void onShare(btn));
}

/**
 * Сообщить серверу исход шеринга. Полностью best-effort: это аналитика, и её
 * сбой не имеет права ни задержать шторку, ни показать пользователю ошибку —
 * приглашение к этому моменту уже отправлено.
 */
async function reportShareResult(id: string, sent: boolean): Promise<void> {
  try {
    await apiFetch(`${apiBase}/v1/referral/share-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `tma ${getInitData()}` },
      body: JSON.stringify({ id, sent }),
    });
  } catch {
    // Потерянное событие воронки — приемлемо; сорванный шеринг — нет.
  }
}

let sharing = false;
async function onShare(btn: HTMLButtonElement): Promise<void> {
  if (sharing) return;
  sharing = true;
  btn.disabled = true;
  if (PREVIEW) {
    // No Telegram share sheet in a plain browser — just acknowledge.
    // Not `showAlert(...) ?? alert(...)`: showAlert returns undefined even when
    // it works, so `??` always ran the fallback too. PREVIEW is also reachable
    // inside Telegram via `?preview`, where that stacked a browser dialog on
    // top of the native one.
    if (app?.showAlert) app.showAlert(s.shareSent);
    else alert(s.shareSent);
    sharing = false;
    btn.disabled = false;
    return;
  }
  try {
    const res = await apiFetch(`${apiBase}/v1/referral/share-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `tma ${getInitData()}` },
      body: "{}",
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { id: string };
    const sheet = app?.shareMessage;
    if (sheet) {
      sheet(data.id, (sent) => {
        if (sent) app?.HapticFeedback?.notificationOccurred("success");
        // Единственное место, где вообще известно, ушло приглашение или человек
        // закрыл шторку: сервер видит только подготовку сообщения. Без этого
        // отчёта «отправлено» пришлось бы считать по подготовкам, и конверсия
        // перехода занижалась бы на все передуманные шеринги.
        void reportShareResult(data.id, sent);
      });
    } else {
      // Older clients without shareMessage — nothing to open.
      app?.showAlert?.(s.shareFail);
    }
  } catch {
    app?.HapticFeedback?.notificationOccurred("error");
    app?.showAlert?.(s.shareFail);
  } finally {
    sharing = false;
    btn.disabled = false;
  }
}

/**
 * The only screens that hand off here any more. Premium and the venue board
 * used to (the "invite a friend instead" chip on a Premium funnel) and are
 * deliberately NOT accepted as a way back: the program pays in tickets only and
 * has no entry point on a Premium surface, so a trail naming one is stale.
 */
const BACK_TARGETS: readonly ReturnPage[] = ["ticket-store", "ticket-gate"];

async function boot(): Promise<void> {
  app?.ready?.();
  app?.expand?.();
  // Bot API 8.0+ immersive fullscreen — removes the top sheet header so the page
  // fills the screen natively (older clients silently fall through to expand()).
  const chromeColor = document.documentElement.dataset.theme === "light" ? "#f5f5f5" : "#030303";
  try {
    if (app?.isVersionAtLeast?.("8.0") && !app.isFullscreen) {
      app.requestFullscreen?.();
    }
    app?.setHeaderColor?.(chromeColor);
    app?.setBackgroundColor?.(chromeColor);
    app?.setBottomBarColor?.(chromeColor);
  } catch {
    // Best-effort cosmetic boot — never crash over chrome theming.
  }
  wireContentInsets(app);
  // A way back to whichever ticket bottleneck sent the user here (the ticket
  // store or the date-ticket gate). Deliberately does nothing when this page
  // was opened cold from the bot menu — there is no previous screen then.
  wireReturnBackButton(app?.BackButton, location.search, undefined, BACK_TARGETS);
  renderLoading();
  if (PREVIEW) {
    render(PREVIEW_STATE);
    return;
  }
  try {
    const res = await apiFetch(`${apiBase}/v1/referral/state`, {
      headers: { Authorization: `tma ${getInitData()}` },
    });
    if (!res.ok) throw new Error(String(res.status));
    const state = normalize((await res.json()) as Partial<ReferralState>);
    render(state);
  } catch {
    renderError(s.loadFail);
  }
}

void boot();
