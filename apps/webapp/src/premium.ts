import { apiFetch } from "./api.js";
import "./theme.css";
import "./premium.css";
import { icon, type IconName } from "./icons";
import { butterflyLoader } from "./butterfly-loader";
import { wireContentInsets } from "./telegram-insets";
import { wireReturnBackButton, returnParams } from "./return-to.js";
import { referralChip } from "./referral-hint.js";

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
  more: string;
  // Plan picker (§3.8 — 1 / 3 / 6 months).
  planMonthly: string;
  plan3: string;
  plan6: string;
  planPerMonth: (p: string) => string;
  planSave: (pct: number) => string;
  planOneOff: string;
  price: (p: string) => string;
  subscribe: (p: string) => string;
  /**
   * The CTA for a PACKAGE. Separate from `subscribe` because that one appends a
   * "/mo" rate suffix, and a package's price is a total: rendering "$75.56/mo"
   * on the button that charges $75.56 once misstates the price on the one
   * control whose whole job is to state it.
   */
  buyPackage: (p: string) => string;
  activeBadge: string;
  activePlateUntil: (d: string) => string;
  manage: string;
  payFailed: string;
}

const COPY: Record<Lang, Copy> = {
  en: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "The good stuff, unlocked.",
    b1t: "Unlimited dates",
    b1d: "Every date is covered — no ticket, no per-date fee.",
    b1x: "A date normally costs one Date Ticket each. With Premium your own place at the table is always covered, however often you go — and buying a ticket for your date, if you want to, still costs one ticket.",
    b4t: "Every evening time",
    b4d: "The late slots in the calendar stay open for you.",
    b4x: "The last hours of each day are the ones people actually want, so they are a Premium band — anyone else opens them for a one-off fee, per date. With Premium they are simply open, on every date you plan, for both of you.",
    b3t: "Free venue changes",
    b3d: "Swap your date spot as often as you like — no fee.",
    b3x: "Changing the venue normally costs a small fee each time. With Premium every swap on the venue board is free, right up until the date — rethink the spot as many times as you both want.",
    b2t: "Premium venues",
    b2d: "A hand-picked tier of nicer places in the venue board",
    b2x: "Premium unlocks a separate tier of hand-picked spots — nicer, more memorable places that stay locked for everyone else. They show up on the venue board the moment your subscription is active.",
    b2link: "See the places",
    more: "More perks are on the way.",
    planMonthly: "1 month",
  plan3: "3 months",
  plan6: "6 months",
  planPerMonth: (p: string) => `${p}/mo`,
  planSave: (pct: number) => `−${pct}%`,
  planOneOff: "one payment · no auto-renewal",
  price: (p) => `${p}/month · cancel anytime`,
    subscribe: (p) => `Subscribe — ${p}/mo`,
    buyPackage: (p) => `Get Premium — ${p}`,
    activeBadge: "PREMIUM ACTIVE",
    activePlateUntil: (d) => `until ${d}`,
    manage: "Manage or cancel anytime in Telegram → Settings → Subscriptions.",
    payFailed: "That didn't go through. Try again in a moment.",
  },
  ru: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "Лучшее — открыто.",
    b1t: "Безлимитные свидания",
    b1d: "Каждое свидание покрыто — без билета и без оплаты за раз.",
    b1x: "Обычно свидание стоит по одному билету с человека. С Premium твоё место всегда покрыто, сколько бы свиданий ни было — а оплатить билет за спутницу, если захочешь, по-прежнему стоит один билет.",
    b4t: "Любое вечернее время",
    b4d: "Поздние слоты в календаре открыты для тебя.",
    b4x: "Последние часы каждого дня — те, которые на самом деле нужны, поэтому это Premium-полоса: остальные открывают её разово и за отдельную плату, на одно свидание. С Premium она просто открыта, на каждом свидании, сразу для вас двоих.",
    b3t: "Бесплатная смена места",
    b3d: "Меняй место свидания сколько угодно — без оплаты.",
    b3x: "Обычно каждая смена места стоит небольшую сумму. С Premium любая замена в подборе мест — бесплатна, вплоть до самого свидания. Пересматривайте место столько раз, сколько захотите вдвоём.",
    b2t: "Премиум-заведения",
    b2d: "Отобранный тир мест получше в подборе",
    b2x: "Premium открывает отдельный тир заведений — места получше, отобранные вручную, которые для остальных закрыты. Они появляются в подборе сразу, как только подписка активна.",
    b2link: "Посмотреть места",
    more: "Дальше будет больше.",
    planMonthly: "1 месяц",
  plan3: "3 месяца",
  plan6: "6 месяцев",
  planPerMonth: (p: string) => `${p}/мес`,
  planSave: (pct: number) => `−${pct}%`,
  planOneOff: "один платёж · без автопродления",
  price: (p) => `${p}/месяц · отмена в любой момент`,
    subscribe: (p) => `Оформить — ${p}/мес`,
    buyPackage: (p) => `Оформить — ${p}`,
    activeBadge: "PREMIUM АКТИВЕН",
    activePlateUntil: (d) => `до ${d}`,
    manage: "Управлять и отменить — в Telegram → Настройки → Подписки.",
    payFailed: "Не прошло. Попробуй ещё раз через минуту.",
  },
  uk: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "Найкраще — відкрито.",
    b1t: "Безлімітні побачення",
    b1d: "Кожне побачення покрите — без квитка й без оплати за раз.",
    b1x: "Зазвичай побачення коштує по одному квитку з людини. З Premium твоє місце завжди покрите, скільки б побачень не було — а сплатити квиток за супутницю, якщо захочеш, і далі коштує один квиток.",
    b4t: "Будь-який вечірній час",
    b4d: "Пізні слоти в календарі відкриті для тебе.",
    b4x: "Останні години кожного дня — ті, які насправді потрібні, тому це Premium-смуга: решта відкриває її разово й за окрему плату, на одне побачення. З Premium вона просто відкрита, на кожному побаченні, одразу для вас двох.",
    b3t: "Безкоштовна зміна місця",
    b3d: "Змінюй місце побачення скільки завгодно — без оплати.",
    b3x: "Зазвичай кожна зміна місця коштує невелику суму. З Premium будь-яка заміна в підборі місць — безкоштовна, аж до самого побачення. Переглядайте місце стільки разів, скільки захочете вдвох.",
    b2t: "Преміум-заклади",
    b2d: "Відібраний тір кращих місць у підборі",
    b2x: "Premium відкриває окремий тір закладів — кращі місця, відібрані вручну, які для інших закриті. Вони з’являються в підборі щойно підписка активна.",
    b2link: "Подивитись місця",
    more: "Далі буде більше.",
    planMonthly: "1 місяць",
  plan3: "3 місяці",
  plan6: "6 місяців",
  planPerMonth: (p: string) => `${p}/міс`,
  planSave: (pct: number) => `−${pct}%`,
  planOneOff: "один платіж · без автопродовження",
  price: (p) => `${p}/місяць · скасування будь-коли`,
    subscribe: (p) => `Оформити — ${p}/міс`,
    buyPackage: (p) => `Оформити — ${p}`,
    activeBadge: "PREMIUM АКТИВНИЙ",
    activePlateUntil: (d) => `до ${d}`,
    manage: "Керувати та скасувати — у Telegram → Налаштування → Підписки.",
    payFailed: "Не вдалося. Спробуй ще раз за хвилину.",
  },
  de: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "Das Beste, freigeschaltet.",
    b1t: "Unbegrenzte Dates",
    b1d: "Jedes Date ist abgedeckt — kein Ticket, keine Gebühr pro Date.",
    b1x: "Ein Date kostet normalerweise pro Person ein Date-Ticket. Mit Premium ist dein eigener Platz immer abgedeckt, egal wie oft — und das Ticket deiner Begleitung zu übernehmen kostet weiterhin ein Ticket.",
    b4t: "Jede Abendzeit",
    b4d: "Die späten Slots im Kalender bleiben für dich offen.",
    b4x: "Die letzten Stunden jedes Tages sind die, die man wirklich will — deshalb sind sie ein Premium-Band: alle anderen öffnen es einmalig gegen Gebühr, pro Date. Mit Premium ist es einfach offen, bei jedem Date, für euch beide.",
    b3t: "Kostenlose Ortswechsel",
    b3d: "Wechsle den Date-Ort so oft du willst — ohne Gebühr.",
    b3x: "Normalerweise kostet jeder Ortswechsel eine kleine Gebühr. Mit Premium ist jeder Wechsel im Ortsboard kostenlos — bis zum Date. Überdenkt den Ort so oft ihr beide wollt.",
    b2t: "Premium-Orte",
    b2d: "Eine handverlesene Auswahl schönerer Orte im Ortsboard",
    b2x: "Premium schaltet eine eigene Kategorie handverlesener Orte frei — schönere, besondere Plätze, die für alle anderen gesperrt bleiben. Sie erscheinen im Ortsboard, sobald dein Abo aktiv ist.",
    b2link: "Orte ansehen",
    more: "Mehr kommt bald.",
    planMonthly: "1 Monat",
  plan3: "3 Monate",
  plan6: "6 Monate",
  planPerMonth: (p: string) => `${p}/Mon.`,
  planSave: (pct: number) => `−${pct}%`,
  planOneOff: "einmalige Zahlung · keine Verlängerung",
  price: (p) => `${p}/Monat · jederzeit kündbar`,
    subscribe: (p) => `Abonnieren — ${p}/Mon.`,
    buyPackage: (p) => `Premium holen — ${p}`,
    activeBadge: "PREMIUM AKTIV",
    activePlateUntil: (d) => `bis ${d}`,
    manage: "Verwalten oder kündigen in Telegram → Einstellungen → Abos.",
    payFailed: "Das hat nicht geklappt. Bitte gleich nochmal.",
  },
  pl: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "To, co najlepsze — odblokowane.",
    b1t: "Nielimitowane randki",
    b1d: "Każda randka jest pokryta — bez biletu i bez opłaty za randkę.",
    b1x: "Randka zwykle kosztuje po jednym bilecie od osoby. Z Premium twoje miejsce jest zawsze pokryte, niezależnie od liczby randek — a pokrycie biletu partnerki, jeśli zechcesz, nadal kosztuje jeden bilet.",
    b4t: "Każda wieczorna godzina",
    b4d: "Późne sloty w kalendarzu są dla ciebie otwarte.",
    b4x: "Ostatnie godziny każdego dnia to te, których naprawdę się chce — dlatego są pasmem Premium: reszta otwiera je jednorazowo za opłatą, na jedną randkę. Z Premium są po prostu otwarte, na każdej randce, od razu dla was obojga.",
    b3t: "Darmowa zmiana miejsca",
    b3d: "Zmieniaj miejsce randki ile chcesz — bez opłat.",
    b3x: "Zwykle każda zmiana miejsca kosztuje niewielką opłatę. Z Premium każda zmiana w tablicy miejsc jest darmowa — aż do samej randki. Zmieniajcie miejsce tyle razy, ile chcecie.",
    b2t: "Miejsca premium",
    b2d: "Wyselekcjonowany zestaw lepszych miejsc w tablicy",
    b2x: "Premium odblokowuje osobny poziom ręcznie wybranych miejsc — lepszych i bardziej wyjątkowych, zamkniętych dla pozostałych. Pojawiają się w tablicy, gdy tylko subskrypcja jest aktywna.",
    b2link: "Zobacz miejsca",
    more: "Więcej wkrótce.",
    planMonthly: "1 miesiąc",
  plan3: "3 miesiące",
  plan6: "6 miesięcy",
  planPerMonth: (p: string) => `${p}/mies.`,
  planSave: (pct: number) => `−${pct}%`,
  planOneOff: "jedna płatność · bez odnowienia",
  price: (p) => `${p}/miesiąc · anulujesz kiedy chcesz`,
    subscribe: (p) => `Subskrybuj — ${p}/mies.`,
    buyPackage: (p) => `Kup Premium — ${p}`,
    activeBadge: "PREMIUM AKTYWNE",
    activePlateUntil: (d) => `do ${d}`,
    manage: "Zarządzaj lub anuluj w Telegram → Ustawienia → Subskrypcje.",
    payFailed: "Nie udało się. Spróbuj ponownie za chwilę.",
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
  /** Drives the "invite a friend instead" referral cross-promo link. */
  referralEnabled?: boolean;
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

function haptic(kind: "success" | "error"): void {
  try {
    app?.HapticFeedback?.notificationOccurred(kind);
  } catch {
    /* noop */
  }
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

async function fetchState(): Promise<PremiumState> {
  const res = await apiFetch(`${apiBase}/v1/premium/state`, {
    method: "GET",
    headers: { Authorization: `tma ${getInitData()}` },
  });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return (await res.json()) as PremiumState;
}

async function mintInvoice(plan: string): Promise<string> {
  const res = await apiFetch(`${apiBase}/v1/premium/stars-invoice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${getInitData()}`,
    },
    body: JSON.stringify({ plan }),
  });
  if (!res.ok) throw new Error(`invoice ${res.status}`);
  const body = (await res.json()) as { link: string };
  return body.link;
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
      d="M 50 35 C 20 0, -10 30, 15 55 C -5 75, 25 100, 48 65 L 52 65 C 75 100, 105 75, 85 55 C 110 30, 80 0, 50 35 Z"
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
    ["heart", "twinkle", s.b1t, s.b1d, s.b1x],
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
  scroll.append(el("p", "pm-more", s.more));

  // Referral cross-promo: a quiet secondary way to get Premium without paying,
  // shown only on the sales screen (never once already subscribed) and only
  // while the program is actually live.
  //
  // It sits at the TAIL OF THE SCROLL, never in `.pm-action` below. That footer
  // is `flex: none`, so anything added to it grows it and pushes the subscribe
  // CTA and its price line up the screen — which is exactly what this row used
  // to do, at ~39px, or ~57px once its two-line copy wrapped. The footer now
  // holds the CTA and the price and nothing else, so it cannot move.
  if (state.referralEnabled) {
    scroll.append(
      referralChip({
        lang,
        onTap: () => {
          haptic("success");
          location.href = `referral.html?${returnParams("premium", { lang })}`;
        },
      }),
    );
  }

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

  const paint = (): void => {
    const price = selected?.priceDisplay ?? state.priceDisplay;
    // "/mo" belongs only on the recurring plan. A package charges its total
    // once, so appending a rate to it would put a wrong price on the button.
    btnLabel.textContent =
      selected && !selected.recurring ? s.buyPackage(price) : s.subscribe(price);
    // The monthly plan keeps the terms line exactly as it shipped. A package
    // replaces it with the ONE thing that differs and is not visible on the row
    // above: it does not come back next month. Saying that only where it is
    // true also keeps the line to one row — the Russian "renews monthly ·
    // cancel anytime" wrapped to two and grew this `flex: none` footer.
    terms.textContent = selected && !selected.recurring ? s.planOneOff : s.price(price);
  };

  if (plans.length > 1) {
    const picker = el("div", "pm-plans");
    picker.setAttribute("role", "radiogroup");
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

      const meta = el("span", "pm-plan-meta");
      meta.append(el("span", "pm-plan-price", plan.priceDisplay ?? `${plan.stars} ⭐`));
      if (plan.perMonthDisplay && plan.months > 1) {
        meta.append(el("span", "pm-plan-permonth", s.planPerMonth(plan.perMonthDisplay)));
      }

      row.append(head, meta);
      row.addEventListener("click", () => {
        if (busy) return;
        selected = plan;
        for (const other of picker.querySelectorAll(".pm-plan")) {
          const isMe = other === row;
          other.classList.toggle("is-selected", isMe);
          other.setAttribute("aria-checked", isMe ? "true" : "false");
        }
        haptic("success");
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
  action.append(btn);

  // Only the price/terms sit under the button now. How to cancel lives in the
  // bot conversation (the agent can explain it and cancel on request), not here.
  action.append(terms);

  page.append(scroll, action);
  root.replaceChildren(page);
}

async function subscribe(btn: HTMLButtonElement, plan: string): Promise<void> {
  if (busy) return;
  busy = true;
  btn.disabled = true;
  let link: string;
  try {
    link = await mintInvoice(plan);
  } catch {
    busy = false;
    btn.disabled = false;
    app?.showAlert(s.payFailed);
    return;
  }
  const open = app?.openInvoice;
  if (!open) {
    busy = false;
    btn.disabled = false;
    window.open(link, "_blank");
    return;
  }
  open.call(app, link, (status: string) => {
    if (status === "paid") {
      haptic("success");
      renderLoading();
      void pollUntilActive();
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

async function pollUntilActive(attempt = 0): Promise<void> {
  try {
    const state = await fetchState();
    if (state.active) {
      busy = false;
      renderActive(state);
      return;
    }
  } catch {
    /* retry */
  }
  if (attempt >= 15) {
    busy = false;
    void load();
    return;
  }
  setTimeout(() => void pollUntilActive(attempt + 1), 1500);
}

async function load(): Promise<void> {
  // Standalone visual preview (no Telegram/initData): `?preview=active` shows the
  // subscribed status plate, `?preview=offer` the sales screen. Harmless in prod.
  const preview = params.get("preview");
  if (preview === "active" || preview === "offer") {
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
      referralEnabled: true,
    };
    if (preview === "active") renderActive(mock);
    else renderOffer(mock);
    return;
  }
  renderLoading();
  try {
    const state = await fetchState();
    if (state.active) renderActive(state);
    else renderOffer(state);
  } catch {
    renderOffer({
      ok: false,
      featureEnabled: true,
      active: false,
      premiumUntil: null,
      autoRenew: false,
      priceStars: 0,
      priceDisplay: "$17.99",
    });
  }
}

app?.ready?.();
app?.expand?.();

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
