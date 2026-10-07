import { BUTTERFLY_PATH } from "./brand-butterfly.js";
import { apiFetch } from "./api.js";
import "./theme.css";
import "./premium.css";
import { icon, type IconName } from "./icons";
import { ctaLabel, ctaTerms } from "./premium-cta-label.js";
import { butterflyLoader } from "./butterfly-loader";
import { wireContentInsets } from "./telegram-insets";
import { keepOpenOnVerticalSwipe } from "./telegram-swipes.js";
import { wireReturnBackButton } from "./return-to.js";
import { invoiceOutcomeFor, premiumScreenFor, type InvoiceOutcome } from "./premium-load.js";
import { playPremiumReveal, prepareRevealField } from "./premium-reveal/reveal.js";

/**
 * Gennety Premium Mini App (PRODUCT_SPEC §Premium). A small vanilla-TS page that
 * shows the subscription benefits + price (or the active-until state) and mints
 * a recurring Telegram Stars subscription invoice via `WebApp.openInvoice`. The
 * trust boundary is the bot's `successful_payment` handler; this page just polls
 * `/v1/premium/state` until the entitlement activates.
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

/** Public showcase of the real venues Premium unlocks. */
const PLACES_URL = "https://gennety.com/places";

/** Open an external link via Telegram when available, else a normal new tab. */
function openExternal(url: string): void {
  try {
    if (app?.openLink) {
      app.openLink(url);
      return;
    }
  } catch {
    /* fall through */
  }
  window.open(url, "_blank");
}

interface Copy {
  crest: string;
  title: string;
  sub: string;
  // Benefits, in display order. Unlimited dates leads: it is the one perk that
  // changes what the product costs rather than what it looks like.
  b1t: string; // benefit 1 title
  b1d: string; // benefit 1 detail (short, always visible)
  b1x: string; // benefit 1 explanation (revealed on tap)
  /**
   * The paid evening band. Placed SECOND on purpose: the one path this feature
   * creates into this screen is the calendar's locked slot, and that reader is
   * looking for exactly this line — burying it under two venue perks makes them
   * scroll past the thing they came for. It names no slot count: the number is
   * env-side (`PRIME_TIME_SLOT_COUNT`) and the calendar's own sheet avoids it too.
   */
  b4t: string;
  b4d: string;
  b4x: string;
  b2t: string;
  b2d: string;
  b2x: string;
  b2link: string; // "see the actual premium places" link label
  b3t: string;
  b3d: string;
  b3x: string;
  // Plan picker (§3.8 — 1 / 3 / 6 months).
  planMonthly: string;
  plan3: string;
  plan6: string;
  planPerMonth: (p: string) => string;
  planSave: (pct: number) => string;
  /**
   * The terms line under a PACKAGE's button. It now carries the total, because
   * the button above it states a monthly RATE for every plan (§3.8): the sum
   * actually charged has to be legible somewhere before the invoice opens, and
   * this line already exists, so it costs the footer no height. Keep it to one
   * row — a wrap here grows a `flex: none` footer and pushes the CTA up.
   */
  planOneOff: (total: string) => string;
  price: (p: string) => string;
  subscribe: (p: string) => string;
  /**
   * The CTA for a package when the server could NOT give us a monthly rate —
   * `premiumPlanPerMonthDisplay` returns null whenever the configured price
   * display has no parseable amount. The button then states the total with no
   * rate suffix, because "$75.56/mo" on the control that charges $75.56 once is
   * the one lie this screen must never tell. The cells degrade the same way.
   */
  buyPackage: (p: string) => string;
  activeBadge: string;
  activePlateUntil: (d: string) => string;
  manage: string;
  payFailed: string;
  /**
   * The state request failed, so this page does not know whether the reader
   * already subscribes. Deliberately not the offer: see `premium-load.ts`.
   */
  loadFailed: string;
  retry: string;
  /**
   * «Premium после покупки» (стенд `design/premium-unlock/` в iOS-репо): строки
   * под надписью и кнопка. Те же слова, что у iOS (`premium.active.until`,
   * `premium.subtitle`, `premium.reveal.done`, `premium.active.title`).
   */
  revealUntil: (d: string) => string;
  revealWorks: string;
  revealDone: string;
  revealLabel: string;
}

const COPY: Record<Lang, Copy> = {
  en: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "The good stuff, unlocked.",
    b1t: "Unlimited dates",
    b1d: "Every date is covered — no ticket, no per-date fee.",
    b1x:
      "Your own seat on every date is always paid for. A ticket for your match is separate, if you'd like to treat them.",
    b4t: "Every evening time",
    b4d: "The late slots in the calendar stay open for you.",
    b4x: "Late evenings are the most wanted time. With Premium they're open on every date, for both of you.",
    b3t: "Free venue changes",
    b3d: "Change the venue for free — up to twice per date.",
    b3x: "Changing the venue normally costs a small fee each time. With Premium a swap on the venue board is free — up to twice per date, and no later than 5 hours before you meet.",
    b2t: "Premium venues",
    b2d: "A step-up selection of places",
    b2x: "Premium unlocks a separate tier of hand-picked spots — nicer, more memorable places that stay locked for everyone else. They show up on the venue board the moment your subscription is active.",
    b2link: "See the places",
    planMonthly: "1 month",
  plan3: "3 months",
  plan6: "6 months",
  planPerMonth: (p: string) => `${p}/mo`,
  planSave: (pct: number) => `−${pct}%`,
  planOneOff: (t) => `${t} once · no auto-renewal`,
  price: (p) => `${p}/month · cancel anytime`,
    subscribe: (p) => `Subscribe — ${p}/mo`,
    buyPackage: (p) => `Get Premium — ${p}`,
    activeBadge: "PREMIUM ACTIVE",
    activePlateUntil: (d) => `until ${d}`,
    manage: "Manage or cancel anytime in Telegram → Settings → Subscriptions.",
    payFailed: "That didn't go through. Try again in a moment.",
    loadFailed: "Couldn't load your Premium status.",
    retry: "Try again",
    revealUntil: (d) => `Active until ${d}`,
    revealWorks: "Works in the app and in Telegram.",
    revealDone: "Done",
    revealLabel: "Premium is active",
  },
  ru: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "Лучшее — открыто.",
    b1t: "Безлимитные свидания",
    b1d: "Каждое свидание покрыто — без билета и без оплаты за раз.",
    b1x: "Твоё место на свидании всегда оплачено. Билет для пары — отдельно, если захочешь угостить.",
    b4t: "Любое вечернее время",
    b4d: "Поздние слоты в календаре открыты для тебя.",
    b4x:
      "Поздние вечера — самое востребованное время. С Premium они открыты на каждом свидании, сразу для вас двоих.",
    b3t: "Бесплатная смена места",
    b3d: "Сменить место свидания можно без оплаты — до двух раз.",
    b3x: "Обычно каждая смена места стоит небольшую сумму. С Premium замена в подборе мест бесплатна — до двух раз на одно свидание и не позже чем за 5 часов до встречи.",
    b2t: "Премиум-заведения",
    b2d: "Подборка мест уровнем выше",
    b2x:
      "Premium открывает отдельную подборку заведений — места получше, отобранные вручную, которые для остальных закрыты. Они появляются в подборе сразу, как только подписка активна.",
    b2link: "Посмотреть места",
    planMonthly: "1 месяц",
  plan3: "3 месяца",
  plan6: "6 месяцев",
  planPerMonth: (p: string) => `${p}/мес`,
  planSave: (pct: number) => `−${pct}%`,
  planOneOff: (t) => `${t} разово · без автопродления`,
  price: (p) => `${p}/месяц · отмена в любой момент`,
    subscribe: (p) => `Оформить — ${p}/мес`,
    buyPackage: (p) => `Оформить — ${p}`,
    activeBadge: "PREMIUM АКТИВЕН",
    activePlateUntil: (d) => `до ${d}`,
    manage: "Управлять и отменить — в Telegram → Настройки → Подписки.",
    payFailed: "Не прошло. Попробуй ещё раз через минуту.",
    loadFailed: "Не удалось загрузить статус Premium.",
    retry: "Повторить",
    revealUntil: (d) => `Активен до ${d}`,
    revealWorks: "Работает и в приложении, и в Telegram.",
    revealDone: "Готово",
    revealLabel: "Premium активен",
  },
  uk: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "Найкраще — відкрито.",
    b1t: "Безлімітні побачення",
    b1d: "Кожне побачення покрите — без квитка й без оплати за раз.",
    b1x: "Твоє місце на побаченні завжди оплачено. Квиток для пари — окремо, якщо захочеш пригостити.",
    b4t: "Будь-який вечірній час",
    b4d: "Пізні слоти в календарі відкриті для тебе.",
    b4x:
      "Пізні вечори — найзатребуваніший час. З Premium вони відкриті на кожному побаченні, одразу для вас двох.",
    b3t: "Безкоштовна зміна місця",
    b3d: "Змінити місце побачення можна без оплати — до двох разів.",
    b3x: "Зазвичай кожна зміна місця коштує невелику суму. З Premium заміна в підборі місць безкоштовна — до двох разів на одне побачення і не пізніше ніж за 5 годин до зустрічі.",
    b2t: "Преміум-заклади",
    b2d: "Добірка місць рівнем вище",
    b2x:
      "Premium відкриває окрему добірку закладів — кращі місця, відібрані вручну, які для інших закриті. Вони з’являються в підборі щойно підписка активна.",
    b2link: "Подивитись місця",
    planMonthly: "1 місяць",
  plan3: "3 місяці",
  plan6: "6 місяців",
  planPerMonth: (p: string) => `${p}/міс`,
  planSave: (pct: number) => `−${pct}%`,
  planOneOff: (t) => `${t} разово · без автопродовження`,
  price: (p) => `${p}/місяць · скасування будь-коли`,
    subscribe: (p) => `Оформити — ${p}/міс`,
    buyPackage: (p) => `Оформити — ${p}`,
    activeBadge: "PREMIUM АКТИВНИЙ",
    activePlateUntil: (d) => `до ${d}`,
    manage: "Керувати та скасувати — у Telegram → Налаштування → Підписки.",
    payFailed: "Не вдалося. Спробуй ще раз за хвилину.",
    loadFailed: "Не вдалося завантажити статус Premium.",
    retry: "Спробувати ще",
    revealUntil: (d) => `Активний до ${d}`,
    revealWorks: "Працює і в застосунку, і в Telegram.",
    revealDone: "Готово",
    revealLabel: "Premium активний",
  },
  de: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "Das Beste, freigeschaltet.",
    b1t: "Unbegrenzte Dates",
    b1d: "Jedes Date ist abgedeckt — kein Ticket, keine Gebühr pro Date.",
    b1x:
      "Dein Platz beim Date ist immer bezahlt. Ein Ticket für dein Match kommt extra, falls du es einladen willst.",
    b4t: "Jede Abendzeit",
    b4d: "Die späten Slots im Kalender bleiben für dich offen.",
    b4x:
      "Späte Abende sind die gefragteste Zeit. Mit Premium sind sie bei jedem Date offen, für euch beide.",
    b3t: "Kostenlose Ortswechsel",
    b3d: "Den Ort kostenlos wechseln — bis zu zweimal pro Date.",
    b3x: "Normalerweise kostet jeder Ortswechsel eine kleine Gebühr. Mit Premium ist ein Wechsel im Ortsboard kostenlos — bis zu zweimal pro Date und spätestens 5 Stunden vor dem Treffen.",
    b2t: "Premium-Orte",
    b2d: "Eine Auswahl gehobener Orte",
    b2x: "Premium schaltet eine eigene Kategorie handverlesener Orte frei — schönere, besondere Plätze, die für alle anderen gesperrt bleiben. Sie erscheinen im Ortsboard, sobald dein Abo aktiv ist.",
    b2link: "Orte ansehen",
    planMonthly: "1 Monat",
  plan3: "3 Monate",
  plan6: "6 Monate",
  planPerMonth: (p: string) => `${p}/Mon.`,
  planSave: (pct: number) => `−${pct}%`,
  /* "einmalig", not "einmalige Zahlung": the total now sits in this line, and
     the longer noun pushed it past one row on a 320px screen. */
  planOneOff: (t) => `${t} einmalig · keine Verlängerung`,
  price: (p) => `${p}/Monat · jederzeit kündbar`,
    subscribe: (p) => `Abonnieren — ${p}/Mon.`,
    buyPackage: (p) => `Premium holen — ${p}`,
    activeBadge: "PREMIUM AKTIV",
    activePlateUntil: (d) => `bis ${d}`,
    manage: "Verwalten oder kündigen in Telegram → Einstellungen → Abos.",
    payFailed: "Das hat nicht geklappt. Bitte gleich nochmal.",
    loadFailed: "Dein Premium-Status konnte nicht geladen werden.",
    retry: "Erneut versuchen",
    revealUntil: (d) => `Aktiv bis ${d}`,
    revealWorks: "Gilt in der App und in Telegram.",
    revealDone: "Fertig",
    revealLabel: "Premium ist aktiv",
  },
  pl: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "To, co najlepsze — odblokowane.",
    b1t: "Nielimitowane randki",
    b1d: "Każda randka jest pokryta — bez biletu i bez opłaty za randkę.",
    b1x: "Twoje miejsce na randce jest zawsze opłacone. Bilet dla pary — osobno, jeśli zechcesz zaprosić.",
    b4t: "Każda wieczorna godzina",
    b4d: "Późne sloty w kalendarzu są dla ciebie otwarte.",
    b4x:
      "Późne wieczory to najbardziej rozchwytywany czas. Z Premium są otwarte na każdej randce, od razu dla was obojga.",
    b3t: "Darmowa zmiana miejsca",
    b3d: "Zmiana miejsca randki bez opłat — do dwóch razy.",
    b3x: "Zwykle każda zmiana miejsca kosztuje niewielką opłatę. Z Premium zmiana w tablicy miejsc jest darmowa — do dwóch razy na jedną randkę i nie później niż 5 godzin przed spotkaniem.",
    b2t: "Miejsca premium",
    b2d: "Wybór miejsc o klasę wyżej",
    b2x: "Premium odblokowuje osobny poziom ręcznie wybranych miejsc — lepszych i bardziej wyjątkowych, zamkniętych dla pozostałych. Pojawiają się w tablicy, gdy tylko subskrypcja jest aktywna.",
    b2link: "Zobacz miejsca",
    planMonthly: "1 miesiąc",
  plan3: "3 miesiące",
  plan6: "6 miesięcy",
  planPerMonth: (p: string) => `${p}/mies.`,
  planSave: (pct: number) => `−${pct}%`,
  planOneOff: (t) => `${t} jednorazowo · bez odnowienia`,
  price: (p) => `${p}/miesiąc · anulujesz kiedy chcesz`,
    subscribe: (p) => `Subskrybuj — ${p}/mies.`,
    buyPackage: (p) => `Kup Premium — ${p}`,
    activeBadge: "PREMIUM AKTYWNE",
    activePlateUntil: (d) => `do ${d}`,
    manage: "Zarządzaj lub anuluj w Telegram → Ustawienia → Subskrypcje.",
    payFailed: "Nie udało się. Spróbuj ponownie za chwilę.",
    loadFailed: "Nie udało się wczytać statusu Premium.",
    retry: "Spróbuj ponownie",
    revealUntil: (d) => `Aktywne do ${d}`,
    revealWorks: "Działa w aplikacji i w Telegramie.",
    revealDone: "Gotowe",
    revealLabel: "Premium jest aktywne",
  },
};

const s = COPY[lang];

interface PremiumState {
  ok: boolean;
  featureEnabled: boolean;
  active: boolean;
  premiumUntil: string | null;
  autoRenew: boolean;
  priceStars: number;
  priceDisplay: string;
  /**
   * The purchase plans, PRICED BY THE SERVER. This page never computes a
   * discount of its own: a bundle doing `stars × months × 0.85` locally is a
   * second implementation of the pricing rule, and a cached older bundle would
   * keep showing yesterday's number after a repricing — on the screen that asks
   * for money.
   */
  plans?: PremiumPlanOffer[];
}

interface PremiumPlanOffer {
  id: string;
  months: number;
  recurring: boolean;
  stars: number;
  discountPct: number;
  priceDisplay: string | null;
  perMonthDisplay: string | null;
}

const root = document.getElementById("root")!;
let busy = false;
/** `?preview=purchase`: состояние «после оплаты» — кнопка обходится без счёта. */
let previewPaid: PremiumState | null = null;

function haptic(kind: "success" | "error"): void {
  try {
    app?.HapticFeedback?.notificationOccurred(kind);
  } catch {
    /* noop */
  }
}

/** A soft impact — one per letter of the post-purchase reveal. */
function softImpact(): void {
  try {
    app?.HapticFeedback?.impactOccurred("soft");
  } catch {
    /* haptics are optional — absent on desktop and web */
  }
}

/**
 * The tick of a control moving between positions — not a notification. Telegram
 * exposes both, and `haptic()` above is the other one: it reports an outcome.
 */
function selectionHaptic(): void {
  try {
    app?.HapticFeedback?.selectionChanged();
  } catch {
    /* haptics are optional — absent on desktop and web */
  }
}

/**
 * Liquid-glass press for the CTA: the specular lands WHERE the finger lands.
 *
 * The pill is a piece of dark glass, and the difference between a texture and a
 * response is where its light comes from. A bloom that always swells out of the
 * centre is something the button does on its own; a highlight that appears under
 * the thumb and drains away when it lifts is the glass answering the touch —
 * that, not more animation, is what reads as expensive. So the resting state is
 * now perfectly still and ALL the motion is spent on the half second the finger
 * is down.
 *
 * Two custom properties carry the touch point into the stylesheet; the rise, the
 * settle, and the shadow collapsing as the pill presses into the page are CSS.
 * Pointer events rather than touch+mouse pairs: Telegram's WebView is Chromium
 * or WKWebView, both speak them, and one stream cannot double-fire on a tap.
 */
function wireGlassPress(btn: HTMLElement): void {
  const press = (e: PointerEvent): void => {
    const r = btn.getBoundingClientRect();
    if (!r.width || !r.height) return;
    btn.style.setProperty("--pm-px", `${((e.clientX - r.left) / r.width) * 100}%`);
    btn.style.setProperty("--pm-py", `${((e.clientY - r.top) / r.height) * 100}%`);
    btn.classList.add("is-pressed");
    // A soft IMPACT, not a notification: this is the surface yielding under the
    // finger, not the outcome of anything. `haptic()` above is the other kind.
    try {
      app?.HapticFeedback?.impactOccurred("soft");
    } catch {
      /* haptics are optional — absent on desktop and web */
    }
  };
  const release = (): void => btn.classList.remove("is-pressed");
  btn.addEventListener("pointerdown", press);
  btn.addEventListener("pointerup", release);
  btn.addEventListener("pointercancel", release);
  btn.addEventListener("pointerleave", release);
}

/** Numeric DD.MM.YYYY — the active plate shows the expiry date this way. */
function fmtDateNumeric(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}.${mm}.${d.getFullYear()}`;
  } catch {
    return iso.slice(0, 10);
  }
}

/** «6 ноября 2026 г.» — как системная дата в iOS; DD.MM.YYYY остаётся плашке. */
function fmtDateLong(iso: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
  } catch {
    return fmtDateNumeric(iso);
  }
}

async function fetchState(): Promise<PremiumState> {
  const res = await apiFetch(`${apiBase}/v1/premium/state`, {
    method: "GET",
    headers: { Authorization: `tma ${getInitData()}` },
  });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return (await res.json()) as PremiumState;
}

async function mintInvoice(plan: string): Promise<InvoiceOutcome> {
  const res = await apiFetch(`${apiBase}/v1/premium/stars-invoice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${getInitData()}`,
    },
    body: JSON.stringify({ plan }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // No JSON — the status alone decides (`invoiceOutcomeFor`).
  }
  return invoiceOutcomeFor(res.status, body);
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * The brand butterfly crest — the premium logo. A metallic vertical gradient
 * (theme-aware via the .pm-bf-a / .pm-bf-b CSS stops), a breathing monochrome
 * halo behind it, and a slow float. Static trusted markup — no user data.
 */
const BUTTERFLY_SVG = `
  <svg class="pm-butterfly" viewBox="-12 -10 124 120" role="img" aria-label="Gennety">
    <defs>
      <linearGradient id="pm-bf-grad" x1="0" y1="0" x2="0" y2="1">
        <stop class="pm-bf-a" offset="0" />
        <stop class="pm-bf-b" offset="1" />
      </linearGradient>
    </defs>
    <path
      d="${BUTTERFLY_PATH}"
      fill="url(#pm-bf-grad)"
    />
  </svg>`;

function crest(): HTMLElement {
  const logo = el("div", "pm-logo");
  logo.innerHTML = BUTTERFLY_SVG;
  return logo;
}

/**
 * A borderless glass benefit card that expands its explanation on tap. The tile
 * icon stays the SAME icon but plays a short, icon-specific animation on every
 * toggle (`data-anim` → a CSS keyframe: e.g. the star twinkles, the map
 * unfolds), so pressing a card gives a small, light animated response without
 * the icon ever changing.
 */
function benefitCard(
  ico: IconName,
  anim: "twinkle" | "flutter",
  title: string,
  short: string,
  long: string,
  link?: { label: string; href: string },
): HTMLElement {
  const wrap = el("div", "pm-benefit-wrap");

  const tile = el("div", "pm-benefit-tile");
  tile.dataset.anim = anim;
  tile.append(icon(ico));
  // The keyframe runs on the inner .icon; animationend bubbles up to the tile.
  tile.addEventListener("animationend", () => tile.classList.remove("is-play"));

  // The short detail line, with an optional inline "see the places" link chip
  // sitting right after the sentence (no icon, thin solid pill). It's a <span>
  // (not a nested <button>, which is invalid) with its own click that stops
  // propagation, so it opens the link immediately without toggling the card —
  // and being inline it doesn't grow the section's height.
  const detail = el("div", "pm-benefit-detail");
  detail.append(document.createTextNode(short));
  if (link) {
    detail.append(document.createTextNode(" "));
    const chip = el("span", "pm-benefit-link", link.label);
    chip.setAttribute("role", "button");
    chip.setAttribute("tabindex", "0");
    chip.addEventListener("click", (ev) => {
      ev.stopPropagation();
      haptic("success");
      openExternal(link.href);
    });
    detail.append(chip);
  }

  const txt = el("div", "pm-benefit-txt");
  txt.append(el("div", "pm-benefit-title", title), detail);

  const chevron = icon("chevron", "icon pm-benefit-chevron");

  const row = el("button", "pm-benefit-row") as HTMLButtonElement;
  row.type = "button";
  row.setAttribute("aria-expanded", "false");
  row.append(tile, txt, chevron);

  const panel = el("div", "pm-benefit-panel");
  const panelIn = el("div", "pm-benefit-panel-in");
  panelIn.append(el("p", "pm-benefit-long", long));
  panel.append(panelIn);

  row.addEventListener("click", () => {
    const open = wrap.classList.toggle("is-open");
    row.setAttribute("aria-expanded", open ? "true" : "false");
    // Replay the icon's own animation (same icon, just a quick move).
    tile.classList.remove("is-play");
    void tile.offsetWidth; // reflow so the animation restarts
    tile.classList.add("is-play");
    haptic("success");
    // Reveal the expanded panel above the pinned footer once it has grown.
    if (open) {
      window.setTimeout(() => {
        panel.scrollIntoView({ behavior: "smooth", block: "end" });
      }, 360);
    }
  });

  wrap.append(row, panel);
  return wrap;
}

function renderLoading(): void {
  const page = el("div", "pm-page");
  const center = el("div", "pm-center");
  center.append(butterflyLoader());
  page.append(center);
  root.replaceChildren(page);
}

/**
 * The state request failed. Not the offer (`premium-load.ts` says why): the
 * crest and a plain line on the same centred stage the loader and the active
 * plate use, and the page's own glass CTA as the retry — nothing on it can
 * charge anyone.
 */
function renderError(): void {
  const page = el("div", "pm-page");
  const center = el("div", "pm-center");

  const hero = el("div", "pm-hero");
  hero.append(crest());
  hero.append(el("h1", "pm-title pm-shimmer", s.title));
  center.append(hero);
  center.append(el("p", "pm-price", s.loadFailed));

  const retry = document.createElement("button");
  retry.className = "pm-cta";
  retry.type = "button";
  retry.append(el("span", undefined, s.retry));
  // No notification haptic: nothing has succeeded yet, and the glass press
  // below already answers the finger. `load` swaps the loader in at once, so
  // a second tap has no button left to land on.
  retry.addEventListener("click", () => void load());
  wireGlassPress(retry);
  center.append(retry);

  page.append(center);
  root.replaceChildren(page);
}

function renderActive(state: PremiumState): void {
  const page = el("div", "pm-page");
  const center = el("div", "pm-center");

  const hero = el("div", "pm-hero");
  hero.append(crest());
  hero.append(el("h1", "pm-title pm-shimmer", s.title));
  center.append(hero);

  // Enlarged liquid-glass status plate: the ACTIVE label + the expiry date in
  // numeric DD.MM.YYYY (replaces the old small pill + the "active until" line).
  const plate = el("div", "pm-plate");
  const label = el("div", "pm-plate-label");
  label.append(el("span", "pm-plate-dot"), el("span", "pm-shimmer", s.activeBadge));
  plate.append(label);
  plate.append(el("div", "pm-plate-date", s.activePlateUntil(fmtDateNumeric(state.premiumUntil))));
  center.append(plate);

  page.append(center);
  root.replaceChildren(page);
}

function renderOffer(state: PremiumState): void {
  const page = el("div", "pm-page");
  const scroll = el("div", "pm-scroll");

  const hero = el("div", "pm-hero");
  hero.append(crest());
  hero.append(el("h1", "pm-title pm-shimmer", s.title));
  scroll.append(hero);

  const list = el("div", "pm-benefits");
  // [icon, tap-animation, title, short detail, long explanation, optional link].
  // Tapping a card expands the explanation; the icon stays the same but plays
  // its own animation. The premium-venues card also carries an always-tappable
  // "see the places" chip that opens the public showcase.
  const cards: Array<
    [IconName, "twinkle" | "flutter", string, string, string, { label: string; href: string }?]
  > = [
    // Filled heart, not the outline one: the three cards under it (lock, star,
    // map) all carry solid marks, and a hairline heart at 22px read as a
    // lighter, thinner glyph than its neighbours.
    ["heart-filled", "twinkle", s.b1t, s.b1d, s.b1x],
    // The padlock is deliberately the SAME glyph the calendar plates a locked
    // row with: a user arriving from that tap recognises it before reading a
    // word. Same precedent as the venue board's own `vc-premium-hint`.
    ["lock", "twinkle", s.b4t, s.b4d, s.b4x],
    ["star", "twinkle", s.b2t, s.b2d, s.b2x, { label: s.b2link, href: PLACES_URL }],
    ["map", "flutter", s.b3t, s.b3d, s.b3x],
  ];
  for (const [ico, anim, tt, dd, xx, link] of cards) {
    list.append(benefitCard(ico, anim, tt, dd, xx, link));
  }
  scroll.append(list);

  // No referral chip here, by founder decision (2026-09-22): the referral
  // program pays out Date Tickets only, and its entry points live at ticket
  // bottlenecks (the ticket gate, the ticket store) and its own hub — never on
  // a Premium funnel.

  const action = el("div", "pm-action");

  // Plans, if the server sent a catalog. An older server (or a 1-plan future)
  // falls through to the original single monthly CTA rather than rendering an
  // empty picker — the button is what this screen is for.
  const plans = state.plans ?? [];
  let selected = plans.find((p) => p.id === "monthly") ?? plans[0] ?? null;

  const btn = el("button", "pm-cta") as HTMLButtonElement;
  const btnLabel = el("span");
  btn.append(btnLabel);
  const terms = el("p", "pm-price");

  // EVERY plan states a monthly RATE on the button, packages included: that is
  // the unit the three cells are compared on since they stopped printing totals,
  // and a button answering in a different unit than the control above it is how
  // someone ends up believing they picked a different price. The sum actually
  // charged moves to the terms line. Both rules — and the fallback for when the
  // server can give no rate at all — live in `premium-cta-label.ts`, which is
  // import-safe and therefore unit tested; this module is not.
  const paint = (): void => {
    const total = selected?.priceDisplay ?? state.priceDisplay;
    btnLabel.textContent = ctaLabel(s, selected, total);
    terms.textContent = ctaTerms(s, selected, total);
  };

  if (plans.length > 1) {
    const picker = el("div", "pm-plans");
    picker.setAttribute("role", "radiogroup");

    // The selection stays where it is and lights up in place: the chosen cell
    // fills with slow drifting clouds (`.pm-plan::before/::after`), which is
    // entirely a CSS state of `.is-selected`. Nothing here has to move it,
    // measure it, or time it — the class is the whole mechanism.
    for (const plan of plans) {
      const row = el("button", "pm-plan") as HTMLButtonElement;
      row.type = "button";
      row.setAttribute("role", "radio");

      const name = el(
        "span",
        "pm-plan-name",
        plan.months === 1 ? s.planMonthly : plan.months === 3 ? s.plan3 : s.plan6,
      );
      const head = el("span", "pm-plan-head");
      head.append(name);
      if (plan.discountPct > 0) {
        head.append(el("span", "pm-plan-save", s.planSave(plan.discountPct)));
      }

      // ONE price line per cell, and it is a monthly RATE wherever the plan has
      // one. The cell used to stack the total above the rate; the total is the
      // figure that makes the 6-month plan look like the expensive one, it is
      // not what the choice is made on, and dropping it takes a whole row out of
      // a `flex: none` footer for all three cells at once. It is not lost: the
      // terms line under the CTA states it for the plan actually selected.
      const meta = el("span", "pm-plan-meta");
      const cellPrice =
        plan.months > 1 && plan.perMonthDisplay
          ? s.planPerMonth(plan.perMonthDisplay)
          : (plan.priceDisplay ?? `${plan.stars} ⭐`);
      meta.append(el("span", "pm-plan-price", cellPrice));

      row.append(head, meta);
      row.addEventListener("click", () => {
        if (busy) return;
        // Re-tapping the chosen plan is not a switch: nothing changes, so
        // nothing should tick under the finger or repaint.
        if (selected?.id === plan.id) return;
        selected = plan;
        for (const other of picker.querySelectorAll(".pm-plan")) {
          const isMe = other === row;
          other.classList.toggle("is-selected", isMe);
          other.setAttribute("aria-checked", isMe ? "true" : "false");
        }
        // `selectionChanged`, not the success notification this used to fire:
        // one is the tick of a control moving between positions, the other is
        // the system telling you an operation completed. Choosing a plan is the
        // first thing; nothing has completed yet.
        selectionHaptic();
        paint();
      });

      const isSelected = selected?.id === plan.id;
      row.classList.toggle("is-selected", isSelected);
      row.setAttribute("aria-checked", isSelected ? "true" : "false");
      picker.append(row);
    }
    action.append(picker);
  }

  paint();
  btn.addEventListener("click", () => void subscribe(btn, selected?.id ?? "monthly"));
  wireGlassPress(btn);
  action.append(btn);

  // Only the price/terms sit under the button now. How to cancel lives in the
  // bot conversation (the agent can explain it and cancel on request), not here.
  action.append(terms);

  page.append(scroll, action);
  root.replaceChildren(page);
  // Поле надписи «Premium после покупки» — заранее и в простое: в момент оплаты
  // его уже не считать. Не поднялось — на оплате будет прежняя загрузка.
  const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1200));
  idle(() => void prepareRevealField());
}

async function subscribe(btn: HTMLButtonElement, plan: string): Promise<void> {
  if (busy) return;
  busy = true;
  btn.disabled = true;
  if (previewPaid) {
    // Без счёта Stars: «оплата прошла» после паузы, которую в Telegram
    // занимает лист оплаты, — дальше тот же путь, что на "paid".
    const paid = previewPaid;
    window.setTimeout(() => {
      haptic("success");
      void celebrate({ state: paid });
    }, 900);
    return;
  }
  let outcome: InvoiceOutcome;
  try {
    outcome = await mintInvoice(plan);
  } catch {
    outcome = { kind: "failed" };
  }
  if (outcome.kind === "already-active") {
    // The server refused a second recurring subscription: this screen is
    // stale, not broken. Re-read the state, which lands on the active plate.
    busy = false;
    void load();
    return;
  }
  if (outcome.kind === "failed") {
    busy = false;
    btn.disabled = false;
    app?.showAlert(s.payFailed);
    return;
  }
  const link = outcome.link;
  const open = app?.openInvoice;
  if (!open) {
    busy = false;
    btn.disabled = false;
    window.open(link, "_blank");
    return;
  }
  open.call(app, link, (status: string) => {
    if (status === "paid") {
      // Оплату Telegram уже подтвердил — праздник сразу, как на успехе покупки
      // в iOS; сервер подтверждает подписку параллельно.
      haptic("success");
      void celebrate();
    } else {
      busy = false;
      btn.disabled = false;
      if (status === "failed") {
        haptic("error");
        app?.showAlert(s.payFailed);
      }
    }
  });
}

async function pollUntilActive(
  attempt = 0,
  onActive: (state: PremiumState) => void = renderActive,
  onGiveUp: () => void = () => void load(),
): Promise<void> {
  try {
    const state = await fetchState();
    if (state.active) {
      busy = false;
      onActive(state);
      return;
    }
  } catch {
    /* retry */
  }
  if (attempt >= 15) {
    busy = false;
    onGiveUp();
    return;
  }
  setTimeout(() => void pollUntilActive(attempt + 1, onActive, onGiveUp), 1500);
}

/**
 * «Premium после покупки» (стенд `design/premium-unlock/` в iOS-репо, отделка
 * «Металл в воде», утверждена 2026-10-07): предложение уходит «под воду», и
 * «Premium» всплывает жидким металлом по буквам; «Готово» — плашка «Premium
 * активен». Играет ТОЛЬКО на оплате: холодный вход подписчика — сразу плашка.
 *
 * Сервер опрашивается параллельно: дата встаёт в строку, когда он ответил
 * (до `copyIn` строки всё равно не видно). Сервер так и не подтвердил —
 * `load()`, как и раньше. Шрифт или холст не поднялись — прежний путь:
 * загрузка, затем плашка.
 */
async function celebrate(preview?: { state: PremiumState; frozen?: number | undefined }): Promise<void> {
  const page = root.querySelector<HTMLElement>(".pm-page");
  const field = page ? await prepareRevealField() : null;
  if (!page || !field) {
    if (preview) {
      renderActive(preview.state);
      return;
    }
    renderLoading();
    void pollUntilActive();
    return;
  }
  let active: PremiumState | null = preview?.state ?? null;
  let finished = false;
  const handle = playPremiumReveal({
    page,
    field,
    copy: { works: s.revealWorks, done: s.revealDone, label: s.revealLabel },
    haptics: { drop: softImpact, settled: () => haptic("success") },
    frozen: preview?.frozen,
    decorate: wireGlassPress,
    onDone: () => {
      finished = true;
      handle.destroy();
      // Сервер ещё молчит — загрузка; опрос сам положит плашку.
      if (active) renderActive(active);
      else renderLoading();
    },
  });
  const showUntil = (state: PremiumState): void => {
    if (state.premiumUntil) handle.setUntil(s.revealUntil(fmtDateLong(state.premiumUntil)));
  };
  if (active) {
    showUntil(active);
    return;
  }
  void pollUntilActive(
    0,
    (state) => {
      active = state;
      if (finished) renderActive(state);
      else showUntil(state);
    },
    () => {
      handle.destroy();
      void load();
    },
  );
}

async function load(): Promise<void> {
  // Standalone visual preview (no Telegram/initData): `?preview=active` shows the
  // subscribed status plate, `?preview=offer` the sales screen, `?preview=error`
  // the could-not-load screen, `?preview=reveal` the post-purchase reveal over the
  // offer (`&t=<s>` freezes a frame), `?preview=purchase` the whole path: the
  // offer, whose CTA skips the Stars invoice, then the reveal and the plate.
  // Harmless in prod.
  const preview = params.get("preview");
  if (preview === "error") {
    renderError();
    return;
  }
  if (preview === "active" || preview === "offer" || preview === "reveal" || preview === "purchase") {
    const mock: PremiumState = {
      ok: true,
      featureEnabled: true,
      active: preview === "active",
      premiumUntil: preview === "active" ? "2026-11-24T00:00:00.000Z" : null,
      autoRenew: true,
      priceStars: 750,
      priceDisplay: "$17.99",
      plans: [
        {
          id: "monthly",
          months: 1,
          recurring: true,
          stars: 750,
          discountPct: 0,
          priceDisplay: "$17.99",
          perMonthDisplay: "$17.99",
        },
        {
          id: "months3",
          months: 3,
          recurring: false,
          stars: 1912,
          discountPct: 15,
          priceDisplay: "$45.86",
          perMonthDisplay: "$15.29",
        },
        {
          id: "months6",
          months: 6,
          recurring: false,
          stars: 3150,
          discountPct: 30,
          priceDisplay: "$75.56",
          perMonthDisplay: "$12.59",
        },
      ],
    };
    if (preview === "purchase") {
      previewPaid = {
        ...mock,
        active: true,
        premiumUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      };
    }
    if (preview === "active") renderActive(mock);
    else renderOffer(mock);
    // `?preview=reveal` — церемония поверх макета предложения, как после
    // оплаты; `&t=1.2` — застывший кадр.
    if (preview === "reveal") {
      const t = params.get("t");
      void celebrate({
        state: { ...mock, active: true, premiumUntil: "2026-11-24T00:00:00.000Z" },
        frozen: t != null && t !== "" ? Number(t) : undefined,
      });
    }
    return;
  }
  renderLoading();
  let state: PremiumState | null = null;
  try {
    state = await fetchState();
  } catch {
    state = null;
  }
  const screen = premiumScreenFor(state ? { ok: true, active: state.active } : { ok: false });
  if (screen === "error" || !state) renderError();
  else if (screen === "active") renderActive(state);
  else renderOffer(state);
}

app?.ready?.();
app?.expand?.();
keepOpenOnVerticalSwipe(app);

// Bot API 8.0+ — immersive fullscreen removes the top sheet gap so the paid
// composition fills the screen. Older clients silently fall through to expand().
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
// Reserve room for Telegram's floating close × / menu ⋯ in fullscreen.
wireContentInsets(app);

// A way back to whichever page handed off to this one (today: the venue-change
// board's premium CTA). Deliberately does nothing when this page was opened
// cold from the chat menu — there is no previous screen then. Always called,
// including in the no-return case, so a BackButton the previous page left
// showing cannot linger here with no handler behind it.
wireReturnBackButton(app?.BackButton);

void load();
