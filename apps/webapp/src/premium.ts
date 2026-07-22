import "./theme.css";
import "./premium.css";
import { icon, type IconName } from "./icons";
import { wireContentInsets } from "./telegram-insets";

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

interface Copy {
  crest: string;
  title: string;
  sub: string;
  b1t: string; // benefit 1 title
  b1d: string; // benefit 1 detail (short, always visible)
  b1x: string; // benefit 1 explanation (revealed on tap)
  b2t: string;
  b2d: string;
  b2x: string;
  more: string;
  price: (p: string) => string;
  subscribe: (p: string) => string;
  activeBadge: string;
  activeUntil: (d: string) => string;
  manage: string;
  payFailed: string;
}

const COPY: Record<Lang, Copy> = {
  en: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "The good stuff, unlocked.",
    b1t: "Free venue changes",
    b1d: "Swap your date spot as often as you like — no fee.",
    b1x: "Changing the venue normally costs a small fee each time. With Premium every swap on the venue board is free, right up until the date — rethink the spot as many times as you both want.",
    b2t: "Premium venues",
    b2d: "A hand-picked tier of nicer places in the venue board.",
    b2x: "Premium unlocks a separate tier of hand-picked spots — nicer, more memorable places that stay locked for everyone else. They show up on the venue board the moment your subscription is active.",
    more: "More perks are on the way.",
    price: (p) => `${p}/month · cancel anytime`,
    subscribe: (p) => `Subscribe — ${p}/mo`,
    activeBadge: "PREMIUM ACTIVE",
    activeUntil: (d) => `You're Premium ✨ Active until ${d}.`,
    manage: "Manage or cancel anytime in Telegram → Settings → Subscriptions.",
    payFailed: "That didn't go through. Try again in a moment.",
  },
  ru: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "Лучшее — открыто.",
    b1t: "Бесплатная смена места",
    b1d: "Меняй место свидания сколько угодно — без оплаты.",
    b1x: "Обычно каждая смена места стоит небольшую сумму. С Premium любая замена в подборе мест — бесплатна, вплоть до самого свидания. Пересматривайте место столько раз, сколько захотите вдвоём.",
    b2t: "Премиум-заведения",
    b2d: "Отобранный тир мест получше в подборе.",
    b2x: "Premium открывает отдельный тир заведений — места получше, отобранные вручную, которые для остальных закрыты. Они появляются в подборе сразу, как только подписка активна.",
    more: "Дальше будет больше.",
    price: (p) => `${p}/месяц · отмена в любой момент`,
    subscribe: (p) => `Оформить — ${p}/мес`,
    activeBadge: "PREMIUM АКТИВЕН",
    activeUntil: (d) => `У тебя Premium ✨ Активен до ${d}.`,
    manage: "Управлять и отменить — в Telegram → Настройки → Подписки.",
    payFailed: "Не прошло. Попробуй ещё раз через минуту.",
  },
  uk: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "Найкраще — відкрито.",
    b1t: "Безкоштовна зміна місця",
    b1d: "Змінюй місце побачення скільки завгодно — без оплати.",
    b1x: "Зазвичай кожна зміна місця коштує невелику суму. З Premium будь-яка заміна в підборі місць — безкоштовна, аж до самого побачення. Переглядайте місце стільки разів, скільки захочете вдвох.",
    b2t: "Преміум-заклади",
    b2d: "Відібраний тір кращих місць у підборі.",
    b2x: "Premium відкриває окремий тір закладів — кращі місця, відібрані вручну, які для інших закриті. Вони з’являються в підборі щойно підписка активна.",
    more: "Далі буде більше.",
    price: (p) => `${p}/місяць · скасування будь-коли`,
    subscribe: (p) => `Оформити — ${p}/міс`,
    activeBadge: "PREMIUM АКТИВНИЙ",
    activeUntil: (d) => `У тебе Premium ✨ Активний до ${d}.`,
    manage: "Керувати та скасувати — у Telegram → Налаштування → Підписки.",
    payFailed: "Не вдалося. Спробуй ще раз за хвилину.",
  },
  de: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "Das Beste, freigeschaltet.",
    b1t: "Kostenlose Ortswechsel",
    b1d: "Wechsle den Date-Ort so oft du willst — ohne Gebühr.",
    b1x: "Normalerweise kostet jeder Ortswechsel eine kleine Gebühr. Mit Premium ist jeder Wechsel im Ortsboard kostenlos — bis zum Date. Überdenkt den Ort so oft ihr beide wollt.",
    b2t: "Premium-Orte",
    b2d: "Eine handverlesene Auswahl schönerer Orte im Ortsboard.",
    b2x: "Premium schaltet eine eigene Kategorie handverlesener Orte frei — schönere, besondere Plätze, die für alle anderen gesperrt bleiben. Sie erscheinen im Ortsboard, sobald dein Abo aktiv ist.",
    more: "Mehr kommt bald.",
    price: (p) => `${p}/Monat · jederzeit kündbar`,
    subscribe: (p) => `Abonnieren — ${p}/Mon.`,
    activeBadge: "PREMIUM AKTIV",
    activeUntil: (d) => `Du bist Premium ✨ Aktiv bis ${d}.`,
    manage: "Verwalten oder kündigen in Telegram → Einstellungen → Abos.",
    payFailed: "Das hat nicht geklappt. Bitte gleich nochmal.",
  },
  pl: {
    crest: "✨",
    title: "Gennety Premium",
    sub: "To, co najlepsze — odblokowane.",
    b1t: "Darmowa zmiana miejsca",
    b1d: "Zmieniaj miejsce randki ile chcesz — bez opłat.",
    b1x: "Zwykle każda zmiana miejsca kosztuje niewielką opłatę. Z Premium każda zmiana w tablicy miejsc jest darmowa — aż do samej randki. Zmieniajcie miejsce tyle razy, ile chcecie.",
    b2t: "Miejsca premium",
    b2d: "Wyselekcjonowany zestaw lepszych miejsc w tablicy.",
    b2x: "Premium odblokowuje osobny poziom ręcznie wybranych miejsc — lepszych i bardziej wyjątkowych, zamkniętych dla pozostałych. Pojawiają się w tablicy, gdy tylko subskrypcja jest aktywna.",
    more: "Więcej wkrótce.",
    price: (p) => `${p}/miesiąc · anulujesz kiedy chcesz`,
    subscribe: (p) => `Subskrybuj — ${p}/mies.`,
    activeBadge: "PREMIUM AKTYWNE",
    activeUntil: (d) => `Masz Premium ✨ Aktywne do ${d}.`,
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

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const tag = { en: "en-GB", ru: "ru-RU", uk: "uk-UA", de: "de-DE", pl: "pl-PL" }[lang];
  try {
    return new Intl.DateTimeFormat(tag, {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

async function fetchState(): Promise<PremiumState> {
  const res = await fetch(`${apiBase}/v1/premium/state`, {
    method: "GET",
    headers: { Authorization: `tma ${getInitData()}` },
  });
  if (!res.ok) throw new Error(`state ${res.status}`);
  return (await res.json()) as PremiumState;
}

async function mintInvoice(): Promise<string> {
  const res = await fetch(`${apiBase}/v1/premium/stars-invoice`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `tma ${getInitData()}`,
    },
    body: JSON.stringify({ product: "premium" }),
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
): HTMLElement {
  const wrap = el("div", "pm-benefit-wrap");

  const tile = el("div", "pm-benefit-tile");
  tile.dataset.anim = anim;
  tile.append(icon(ico));
  // The keyframe runs on the inner .icon; animationend bubbles up to the tile.
  tile.addEventListener("animationend", () => tile.classList.remove("is-play"));

  const txt = el("div", "pm-benefit-txt");
  txt.append(el("div", "pm-benefit-title", title), el("div", "pm-benefit-detail", short));

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
  center.append(el("div", "pm-spinner"));
  page.append(center);
  root.replaceChildren(page);
}

function renderActive(state: PremiumState): void {
  const page = el("div", "pm-page");
  const center = el("div", "pm-center");

  const hero = el("div", "pm-hero");
  hero.append(crest());

  const badge = el("div", "pm-badge");
  const badgeTxt = el("span", "pm-shimmer", s.activeBadge);
  badge.append(el("span", "pm-badge-dot"), badgeTxt);
  hero.append(badge);

  hero.append(el("h1", "pm-title pm-shimmer", s.title));
  hero.append(el("p", "pm-sub", s.activeUntil(fmtDate(state.premiumUntil))));
  center.append(hero);

  center.append(el("p", "pm-manage", s.manage));
  page.append(center);
  root.replaceChildren(page);
}

function renderOffer(state: PremiumState): void {
  const page = el("div", "pm-page");
  const scroll = el("div", "pm-scroll");

  const hero = el("div", "pm-hero");
  hero.append(crest());
  hero.append(el("h1", "pm-title pm-shimmer", s.title));
  hero.append(el("p", "pm-sub", s.sub));
  scroll.append(hero);

  const list = el("div", "pm-benefits");
  // [icon, tap-animation, title, short detail, long explanation]. Tapping a card
  // expands the explanation; the icon stays the same but plays its own animation.
  for (const [ico, anim, tt, dd, xx] of [
    ["map", "flutter", s.b1t, s.b1d, s.b1x],
    ["star", "twinkle", s.b2t, s.b2d, s.b2x],
  ] as const) {
    list.append(benefitCard(ico, anim, tt, dd, xx));
  }
  scroll.append(list);
  scroll.append(el("p", "pm-more", s.more));

  const action = el("div", "pm-action");

  const btn = el("button", "pm-cta") as HTMLButtonElement;
  btn.append(el("span", undefined, s.subscribe(state.priceDisplay)));
  btn.addEventListener("click", () => void subscribe(btn));
  action.append(btn);

  // Price/terms sit just under the button; the manage note is quietest, last.
  action.append(el("p", "pm-price", s.price(state.priceDisplay)));
  action.append(el("p", "pm-manage", s.manage));

  page.append(scroll, action);
  root.replaceChildren(page);
}

async function subscribe(btn: HTMLButtonElement): Promise<void> {
  if (busy) return;
  busy = true;
  btn.disabled = true;
  let link: string;
  try {
    link = await mintInvoice();
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
      priceDisplay: "$9.99",
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

void load();
