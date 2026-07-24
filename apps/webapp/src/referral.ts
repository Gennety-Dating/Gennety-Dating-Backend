import "./theme.css";
import "./referral.css";
import { wireContentInsets } from "./telegram-insets";

/**
 * Referral Mini App (§Referral) — "Give a date, get a date". A small vanilla-TS
 * page that shows the referrer's milestone ladder (with $ value at each rung)
 * and a one-tap Invite button. The button mints a prepared inline message
 * server-side (`POST /v1/referral/share-message`) and hands its id to
 * `WebApp.shareMessage`, so the user forwards a branded invite in one tap with
 * nothing to fill in. Reward accounting is entirely server-side.
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
 * Preview mode — renders the full ladder UI with mock data and no network call,
 * so the screen can be opened in a plain browser (no Telegram, no initData) for
 * design review. Triggered explicitly by `?preview` or implicitly whenever
 * there is no Telegram initData (i.e. opened outside a Mini App). The real
 * in-Telegram flow is unaffected: inside a Mini App `initData` is always
 * present, so this never masks the live `/v1/referral/state` fetch there.
 */
const PREVIEW = params.has("preview") || getInitData() === "";

const PREVIEW_STATE: ReferralState = {
  ok: true,
  inviteLink: "https://t.me/gennetybot?start=referral_preview",
  verifiedCount: 3,
  earnedTickets: 2,
  earnedMonths: 2,
  earnedUsd: "$37.96",
  ladder: [
    { atCount: 1, tickets: 1, months: 1, usd: "$18.98", reached: true },
    { atCount: 3, tickets: 2, months: 2, usd: "$37.96", reached: true },
    { atCount: 5, tickets: 3, months: 3, usd: "$56.94", reached: false },
    { atCount: 10, tickets: 5, months: 5, usd: "$94.90", reached: false },
  ],
  next: { atCount: 5, remaining: 2, usd: "$56.94" },
  inviteeMonths: 1,
};

interface LadderRung {
  atCount: number;
  tickets: number;
  months: number;
  usd: string;
  reached: boolean;
}
interface ReferralState {
  ok: true;
  inviteLink: string;
  verifiedCount: number;
  earnedTickets: number;
  earnedMonths: number;
  earnedUsd: string;
  ladder: LadderRung[];
  next: { atCount: number; remaining: number; usd: string } | null;
  inviteeMonths: number;
}

interface Copy {
  title: string;
  tagline: string;
  statFriends: string;
  statEarned: string;
  statValue: string;
  earnedUnit: (t: number, m: number) => string;
  progress: (remaining: number, usd: string) => string;
  maxed: string;
  rungFriends: (n: number) => string;
  rungReward: (t: number, m: number) => string;
  got: string;
  total: string;
  share: string;
  shareHint: string;
  shareSent: string;
  shareFail: string;
  loadFail: string;
}

const COPY: Record<Lang, Copy> = {
  en: {
    title: "Give a date, get a date",
    tagline:
      "Every friend who joins and gets verified grows your matching pool — and earns you free dates & Premium.",
    statFriends: "VERIFIED",
    statEarned: "EARNED",
    statValue: "VALUE",
    earnedUnit: (t, m) => `${t}🎟 · ${m}mo`,
    progress: (r, usd) => `${r} more verified → ${usd}`,
    maxed: "Top reward reached — legend 💛",
    rungFriends: (n) => `${n} friend${n === 1 ? "" : "s"}`,
    rungReward: (t, m) => `+${t} ticket · +${m} month Premium`,
    got: "EARNED",
    total: "TOTAL",
    share: "📤 Invite a friend",
    shareHint: "Forwarded in one tap — nothing to fill in.",
    shareSent: "Invite sent 💫",
    shareFail: "Couldn't open the share sheet — try again.",
    loadFail: "Couldn't load your referrals — try again.",
  },
  ru: {
    title: "Подари свидание — получи своё",
    tagline:
      "Каждый друг, который присоединился и прошёл верификацию, расширяет твой пул матчей — и приносит тебе бесплатные свидания и Premium.",
    statFriends: "ВЕРИФИЦ.",
    statEarned: "ЗАРАБОТАНО",
    statValue: "НА СУММУ",
    earnedUnit: (t, m) => `${t}🎟 · ${m}мес`,
    progress: (r, usd) => `ещё ${r} верифиц. → ${usd}`,
    maxed: "Высшая награда достигнута — легенда 💛",
    rungFriends: (n) => `${n} ${n === 1 ? "друг" : n < 5 ? "друга" : "друзей"}`,
    rungReward: (t, m) => `+${t} билет · +${m} мес Premium`,
    got: "ПОЛУЧЕНО",
    total: "ВСЕГО",
    share: "📤 Пригласить друга",
    shareHint: "Пересылается одним тапом — ничего заполнять не нужно.",
    shareSent: "Приглашение отправлено 💫",
    shareFail: "Не удалось открыть окно шеринга — попробуй ещё раз.",
    loadFail: "Не удалось загрузить рефералов — попробуй ещё раз.",
  },
  uk: {
    title: "Подаруй побачення — отримай своє",
    tagline:
      "Кожен друг, який приєднався та пройшов верифікацію, розширює твій пул матчів — і приносить тобі безкоштовні побачення та Premium.",
    statFriends: "ВЕРИФІК.",
    statEarned: "ЗАРОБЛЕНО",
    statValue: "НА СУМУ",
    earnedUnit: (t, m) => `${t}🎟 · ${m}міс`,
    progress: (r, usd) => `ще ${r} верифік. → ${usd}`,
    maxed: "Найвищу нагороду досягнуто — легенда 💛",
    rungFriends: (n) => `${n} ${n === 1 ? "друг" : n < 5 ? "друга" : "друзів"}`,
    rungReward: (t, m) => `+${t} квиток · +${m} міс Premium`,
    got: "ОТРИМАНО",
    total: "УСЬОГО",
    share: "📤 Запросити друга",
    shareHint: "Пересилається одним тапом — нічого заповнювати не треба.",
    shareSent: "Запрошення надіслано 💫",
    shareFail: "Не вдалося відкрити вікно поширення — спробуй ще раз.",
    loadFail: "Не вдалося завантажити рефералів — спробуй ще раз.",
  },
  de: {
    title: "Schenk ein Date, bekomm ein Date",
    tagline:
      "Jeder Freund, der beitritt und verifiziert wird, vergrößert deinen Match-Pool — und bringt dir kostenlose Dates & Premium.",
    statFriends: "VERIFIZIERT",
    statEarned: "VERDIENT",
    statValue: "WERT",
    earnedUnit: (t, m) => `${t}🎟 · ${m}Mon`,
    progress: (r, usd) => `${r} weitere verifiziert → ${usd}`,
    maxed: "Höchste Belohnung erreicht — Legende 💛",
    rungFriends: (n) => `${n} Freund${n === 1 ? "" : "e"}`,
    rungReward: (t, m) => `+${t} Ticket · +${m} Monat Premium`,
    got: "ERHALTEN",
    total: "GESAMT",
    share: "📤 Freund einladen",
    shareHint: "In einem Tap geteilt — nichts auszufüllen.",
    shareSent: "Einladung gesendet 💫",
    shareFail: "Teilen-Fenster ließ sich nicht öffnen — versuch es erneut.",
    loadFail: "Empfehlungen konnten nicht geladen werden — versuch es erneut.",
  },
  pl: {
    title: "Podaruj randkę — zdobądź swoją",
    tagline:
      "Każdy znajomy, który dołączy i przejdzie weryfikację, powiększa twoją pulę dopasowań — i daje ci darmowe randki oraz Premium.",
    statFriends: "ZWERYFIK.",
    statEarned: "ZDOBYTO",
    statValue: "WARTOŚĆ",
    earnedUnit: (t, m) => `${t}🎟 · ${m}mies`,
    progress: (r, usd) => `jeszcze ${r} zweryfik. → ${usd}`,
    maxed: "Najwyższa nagroda osiągnięta — legenda 💛",
    rungFriends: (n) => `${n} ${n === 1 ? "znajomy" : "znajomych"}`,
    rungReward: (t, m) => `+${t} bilet · +${m} mies Premium`,
    got: "ZDOBYTE",
    total: "RAZEM",
    share: "📤 Zaproś znajomego",
    shareHint: "Przesyłane jednym dotknięciem — nic do wypełnienia.",
    shareSent: "Zaproszenie wysłane 💫",
    shareFail: "Nie udało się otworzyć okna udostępniania — spróbuj ponownie.",
    loadFail: "Nie udało się wczytać poleconych — spróbuj ponownie.",
  },
};
const s = COPY[lang];

const root = document.getElementById("root") as HTMLElement;

function esc(v: string): string {
  return v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function renderLoading(): void {
  root.innerHTML = `<div class="ref-wrap"><div class="ref-skeleton"></div></div>`;
}

function renderError(msg: string): void {
  root.innerHTML = `<div class="ref-wrap"><p class="ref-error">${esc(msg)}</p></div>`;
}

function render(state: ReferralState): void {
  const rungs = state.ladder
    .map((r) => {
      const cls = r.reached ? "ref-rung done" : "ref-rung";
      const marker = r.reached ? "✓" : String(r.atCount);
      const usdTag = r.reached ? s.got : s.total;
      return `
        <li class="${cls}">
          <span class="ref-n">${esc(marker)}</span>
          <span class="ref-body"><b>${esc(s.rungFriends(r.atCount))}</b><span>${esc(
            s.rungReward(r.tickets, r.months),
          )}</span></span>
          <span class="ref-usd">${esc(r.usd)}<small>${esc(usdTag)}</small></span>
        </li>`;
    })
    .join("");

  const progressPct = state.next
    ? Math.round((state.verifiedCount / state.next.atCount) * 100)
    : 100;
  const progressLine = state.next
    ? `<div class="ref-progress"><span>${esc(
        s.progress(state.next.remaining, state.next.usd),
      )}</span></div><div class="ref-bar"><i style="width:${progressPct}%"></i></div>`
    : `<div class="ref-progress"><span>${esc(s.maxed)}</span></div>`;

  root.innerHTML = `
    <div class="ref-wrap">
      <div class="ref-hero">
        <div class="ref-badge">🎁</div>
        <h1 class="ref-title">${esc(s.title)}</h1>
        <p class="ref-tag">${esc(s.tagline)}</p>
      </div>
      <div class="ref-stats">
        <div class="ref-stat"><b>${state.verifiedCount}</b><span>${esc(s.statFriends)}</span></div>
        <div class="ref-stat"><b>${esc(
          s.earnedUnit(state.earnedTickets, state.earnedMonths),
        )}</b><span>${esc(s.statEarned)}</span></div>
        <div class="ref-stat value"><b>${esc(state.earnedUsd)}</b><span>${esc(
          s.statValue,
        )}</span></div>
      </div>
      ${progressLine}
      <ol class="ref-ladder">${rungs}</ol>
      <button class="ref-share" id="ref-share">${esc(s.share)}</button>
      <p class="ref-share-hint">${esc(s.shareHint)}</p>
    </div>`;

  const btn = document.getElementById("ref-share") as HTMLButtonElement;
  btn.addEventListener("click", () => void onShare(btn));
}

let sharing = false;
async function onShare(btn: HTMLButtonElement): Promise<void> {
  if (sharing) return;
  sharing = true;
  btn.disabled = true;
  if (PREVIEW) {
    // No Telegram share sheet in a plain browser — just acknowledge.
    app?.showAlert?.(s.shareSent) ?? alert(s.shareSent);
    sharing = false;
    btn.disabled = false;
    return;
  }
  try {
    const res = await fetch(`${apiBase}/v1/referral/share-message`, {
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

async function boot(): Promise<void> {
  app?.ready?.();
  app?.expand?.();
  wireContentInsets(app);
  renderLoading();
  if (PREVIEW) {
    render(PREVIEW_STATE);
    return;
  }
  try {
    const res = await fetch(`${apiBase}/v1/referral/state`, {
      headers: { Authorization: `tma ${getInitData()}` },
    });
    if (!res.ok) throw new Error(String(res.status));
    const state = (await res.json()) as ReferralState;
    render(state);
  } catch {
    renderError(s.loadFail);
  }
}

void boot();
