/**
 * Venue change Mini App (PRODUCT_SPEC §3.7b — female-exclusive one-shot swap).
 *
 * Opened from the female's scheduled-date DM via a `web_app` button →
 * `venue-change.html?match={id}&lang={en|ru|uk|de|pl}`. Full-screen Telegram
 * Web App, "Premium Lavender Glass" design (shared with the Ticket Mini Apps).
 *
 * Flow:
 *   1. Disclaimer (mandatory, blocking) — one-time / irreversible / partner can
 *      cancel the match / 3 km radius. Single "I understand" button.
 *   2. Catalog — alternatives within 3 km of the original venue (curated-first,
 *      Places fallback) as cards with **real venue photos**. Tap a card → 3.
 *   3. Detail — photo gallery + info + Google Maps link + "Propose this place".
 *      Only on "Propose" do we go to the reason step.
 *   4. Reason — mandatory ≥N-char explanation. On send we POST the pick +
 *      comment; the bot relays it to the male, who accepts or declines.
 *
 * The comment draft is cached to DeviceStorage so a swipe-down dismiss doesn't
 * wipe what she typed (same pattern as the calendar / feedback apps).
 */

import "./venue-change.css";
import {
  fetchVenueChangeState,
  fetchVenueChangeCatalog,
  proposeVenueChange,
  venueChangePhotoUrl,
  CalendarApiError,
  type VenueChangeState,
  type VenueChangeCatalogItem,
} from "./api.js";
import { wireContentInsets } from "./telegram-insets.js";

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

// Bot API 8.0+ — immersive fullscreen removes the top sheet gap so the design
// composition fills the screen. Older clients silently fall through to expand().
try {
  if (app?.isVersionAtLeast?.("8.0") && !app.isFullscreen) {
    app.requestFullscreen?.();
  }
  app?.setHeaderColor?.("#120E1C");
  app?.setBackgroundColor?.("#120E1C");
  app?.setBottomBarColor?.("#120E1C");
} catch {
  // Best-effort cosmetic boot — never crash over chrome theming.
}
// Reserve room for Telegram's floating close × / menu ⋯ in fullscreen.
wireContentInsets(app);
// We drive the flow with our own in-page buttons; make sure a stale MainButton
// from a previous version can never linger.
app?.MainButton?.hide?.();

const params = new URLSearchParams(location.search);
const matchId = app?.initDataUnsafe?.start_param ?? params.get("match") ?? "";
const queryLang = params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? "";
// Telegram populates `app.initData` asynchronously (notably after a
// `requestFullscreen()` boot on some clients), so the value at module load can
// be empty — freezing it in a const then sends an empty `tma` header → 401
// "Missing tma initData". Read it fresh at call time, exactly like the
// calendar / onboarding Mini Apps do.
const getInitData = (): string => app?.initData ?? "";

type Lang = "en" | "ru" | "uk" | "de" | "pl";
const SUPPORTED: ReadonlySet<Lang> = new Set(["en", "ru", "uk", "de", "pl"]);
const lang: Lang = SUPPORTED.has(queryLang as Lang) ? (queryLang as Lang) : "en";
document.documentElement?.setAttribute("lang", lang);

interface Strings {
  disclaimerTitle: string;
  disclaimerLead: string;
  disclaimerBullets: string[];
  disclaimerContinue: string;
  catalogTitle: string;
  catalogLead: string;
  catalogEmpty: string;
  categoryLabels: Record<string, string>;
  kmAway: (km: number) => string;
  detailProposeBtn: string;
  detailFallbackSummary: string;
  openMaps: string;
  back: string;
  commentTitle: string;
  commentLead: string;
  commentPlaceholder: string;
  mainConfirm: string;
  mainSending: string;
  loading: string;
  fallbackNoMatch: string;
  ineligibleGeneric: string;
  ineligibleNotFemale: string;
  ineligiblePastCutoff: string;
  ineligibleAlreadyUsed: string;
  ineligibleDisabled: string;
  successAlert: string;
  errTooShort: string;
  errRange: string;
  errGeneric: string;
  errNetwork: string;
  counter: (n: number, min: number) => string;
}

const T: Record<Lang, Strings> = {
  en: {
    disclaimerTitle: "Change the venue",
    disclaimerLead: "A few things to know before you pick a new place.",
    disclaimerBullets: [
      "You can propose a different place only once. This can't be undone.",
      "Your match chooses: accept the new place, or cancel the date (cancelling ends the match forever).",
      "Only places within 3 km of the original venue, so the trip stays comfortable for both of you.",
    ],
    disclaimerContinue: "I understand, continue",
    catalogTitle: "Pick a new place",
    catalogLead: "Spots within 3 km of your original venue. Tap one to see more.",
    catalogEmpty: "No suitable places nearby right now. Your original venue stays as is.",
    categoryLabels: {
      cafe: "Cafe",
      coffee_shop: "Coffee shop",
      restaurant: "Restaurant",
      park: "Park",
      museum: "Museum",
      lounge: "Lounge",
    },
    kmAway: (km) => `${km} km away`,
    detailProposeBtn: "Propose this place",
    detailFallbackSummary: "A relaxed spot for a first date.",
    openMaps: "Open in Google Maps",
    back: "Back",
    commentTitle: "Tell your match why",
    commentLead: "Only your match sees this note.",
    commentPlaceholder:
      "Write why you'd like to change the place (e.g. it's cosier / closer for me / I want to try their desserts)",
    mainConfirm: "Send to my match",
    mainSending: "Sending…",
    loading: "Loading…",
    fallbackNoMatch: "Open this from your scheduled-date message in the bot.",
    ineligibleGeneric: "Changing the venue isn't available for this date.",
    ineligibleNotFemale: "Only your match can change this venue.",
    ineligiblePastCutoff: "It's too close to the date to change the venue now.",
    ineligibleAlreadyUsed: "You've already used your one venue change for this date.",
    ineligibleDisabled: "Changing the venue isn't available right now.",
    successAlert: "Sent! Your match will accept the new place or keep the date as is.",
    errTooShort: "Please write at least a short note for your match.",
    errRange: "That place is too far from the original venue. Pick one closer.",
    errGeneric: "Couldn't send your request. Try again.",
    errNetwork: "Network error. Check your connection and try again.",
    counter: (n, min) => (n < min ? `${n}/${min} — a little more` : `${n} characters`),
  },
  ru: {
    disclaimerTitle: "Смена места",
    disclaimerLead: "Несколько важных моментов перед выбором нового места.",
    disclaimerBullets: [
      "Предложить другое место можно только один раз. Это нельзя отменить.",
      "Партнёр выбирает: согласиться на новое место или отменить свидание (отмена аннулирует метч навсегда).",
      "Только места в радиусе 3 км от исходного, чтобы дорога осталась удобной для вас обоих.",
    ],
    disclaimerContinue: "Я понимаю, продолжить",
    catalogTitle: "Выберите новое место",
    catalogLead: "Места в радиусе 3 км от исходного. Нажмите, чтобы узнать больше.",
    catalogEmpty: "Подходящих мест рядом сейчас нет. Исходное место остаётся в силе.",
    categoryLabels: {
      cafe: "Кафе",
      coffee_shop: "Кофейня",
      restaurant: "Ресторан",
      park: "Парк",
      museum: "Музей",
      lounge: "Лаундж",
    },
    kmAway: (km) => `${km} км`,
    detailProposeBtn: "Предложить это место",
    detailFallbackSummary: "Спокойное место для первого свидания.",
    openMaps: "Открыть в Google Maps",
    back: "Назад",
    commentTitle: "Объясните партнёру почему",
    commentLead: "Эту записку увидит только ваш партнёр.",
    commentPlaceholder:
      "Напишите, почему хотите изменить место (например: там уютнее / мне ближе / хочу попробовать их десерты)",
    mainConfirm: "Отправить партнёру",
    mainSending: "Отправляем…",
    loading: "Загрузка…",
    fallbackNoMatch: "Откройте это из сообщения о свидании в боте.",
    ineligibleGeneric: "Смена места недоступна для этого свидания.",
    ineligibleNotFemale: "Сменить это место может только ваш партнёр.",
    ineligiblePastCutoff: "Слишком близко к свиданию, чтобы менять место.",
    ineligibleAlreadyUsed: "Вы уже использовали свою единственную смену места.",
    ineligibleDisabled: "Смена места сейчас недоступна.",
    successAlert: "Отправлено! Партнёр согласится на новое место или оставит свидание как есть.",
    errTooShort: "Напишите хотя бы короткое пояснение для партнёра.",
    errRange: "Это место слишком далеко от исходного. Выберите ближе.",
    errGeneric: "Не удалось отправить запрос. Попробуйте снова.",
    errNetwork: "Ошибка сети. Проверьте соединение и попробуйте снова.",
    counter: (n, min) => (n < min ? `${n}/${min} — ещё немного` : `${n} символов`),
  },
  uk: {
    disclaimerTitle: "Зміна місця",
    disclaimerLead: "Кілька важливих моментів перед вибором нового місця.",
    disclaimerBullets: [
      "Запропонувати інше місце можна лише один раз. Це не можна скасувати.",
      "Партнер обирає: погодитися на нове місце або скасувати побачення (скасування анулює метч назавжди).",
      "Лише місця в радіусі 3 км від початкового, щоб дорога залишалася зручною для вас обох.",
    ],
    disclaimerContinue: "Я розумію, продовжити",
    catalogTitle: "Оберіть нове місце",
    catalogLead: "Місця в радіусі 3 км від початкового. Натисніть, щоб дізнатися більше.",
    catalogEmpty: "Підходящих місць поруч зараз немає. Початкове місце залишається.",
    categoryLabels: {
      cafe: "Кафе",
      coffee_shop: "Кав'ярня",
      restaurant: "Ресторан",
      park: "Парк",
      museum: "Музей",
      lounge: "Лаундж",
    },
    kmAway: (km) => `${km} км`,
    detailProposeBtn: "Запропонувати це місце",
    detailFallbackSummary: "Спокійне місце для першого побачення.",
    openMaps: "Відкрити в Google Maps",
    back: "Назад",
    commentTitle: "Поясніть партнеру чому",
    commentLead: "Цю записку побачить лише ваш партнер.",
    commentPlaceholder:
      "Напишіть, чому хочете змінити місце (наприклад: там затишніше / мені ближче / хочу спробувати їхні десерти)",
    mainConfirm: "Надіслати партнеру",
    mainSending: "Надсилаємо…",
    loading: "Завантаження…",
    fallbackNoMatch: "Відкрийте це з повідомлення про побачення в боті.",
    ineligibleGeneric: "Зміна місця недоступна для цього побачення.",
    ineligibleNotFemale: "Змінити це місце може лише ваш партнер.",
    ineligiblePastCutoff: "Занадто близько до побачення, щоб змінювати місце.",
    ineligibleAlreadyUsed: "Ви вже використали свою єдину зміну місця.",
    ineligibleDisabled: "Зміна місця зараз недоступна.",
    successAlert: "Надіслано! Партнер погодиться на нове місце або залишить побачення як є.",
    errTooShort: "Напишіть хоча б коротке пояснення для партнера.",
    errRange: "Це місце надто далеко від початкового. Оберіть ближче.",
    errGeneric: "Не вдалося надіслати запит. Спробуйте ще раз.",
    errNetwork: "Помилка мережі. Перевірте з'єднання та спробуйте ще раз.",
    counter: (n, min) => (n < min ? `${n}/${min} — ще трохи` : `${n} символів`),
  },
  de: {
    disclaimerTitle: "Ort ändern",
    disclaimerLead: "Ein paar Dinge, die du vor der Wahl wissen solltest.",
    disclaimerBullets: [
      "Du kannst nur einmal einen anderen Ort vorschlagen. Das lässt sich nicht rückgängig machen.",
      "Dein Match entscheidet: den neuen Ort akzeptieren oder das Date absagen (Absagen beendet das Match für immer).",
      "Nur Orte im Umkreis von 3 km des ursprünglichen Ortes, damit der Weg für euch beide bequem bleibt.",
    ],
    disclaimerContinue: "Ich verstehe, weiter",
    catalogTitle: "Neuen Ort wählen",
    catalogLead: "Orte im Umkreis von 3 km. Tippe auf einen, um mehr zu sehen.",
    catalogEmpty: "Gerade keine passenden Orte in der Nähe. Dein ursprünglicher Ort bleibt bestehen.",
    categoryLabels: {
      cafe: "Café",
      coffee_shop: "Coffee Shop",
      restaurant: "Restaurant",
      park: "Park",
      museum: "Museum",
      lounge: "Lounge",
    },
    kmAway: (km) => `${km} km entfernt`,
    detailProposeBtn: "Diesen Ort vorschlagen",
    detailFallbackSummary: "Ein entspannter Ort für ein erstes Date.",
    openMaps: "In Google Maps öffnen",
    back: "Zurück",
    commentTitle: "Sag deinem Match warum",
    commentLead: "Nur dein Match sieht diese Notiz.",
    commentPlaceholder:
      "Schreibe, warum du den Ort ändern möchtest (z. B. gemütlicher / näher für mich / ich möchte ihre Desserts probieren)",
    mainConfirm: "An mein Match senden",
    mainSending: "Senden…",
    loading: "Wird geladen…",
    fallbackNoMatch: "Öffne dies über deine Date-Nachricht im Bot.",
    ineligibleGeneric: "Das Ändern des Ortes ist für dieses Date nicht verfügbar.",
    ineligibleNotFemale: "Nur dein Match kann diesen Ort ändern.",
    ineligiblePastCutoff: "Es ist zu kurz vor dem Date, um den Ort jetzt zu ändern.",
    ineligibleAlreadyUsed: "Du hast deine eine Ortsänderung für dieses Date bereits genutzt.",
    ineligibleDisabled: "Das Ändern des Ortes ist gerade nicht verfügbar.",
    successAlert: "Gesendet! Dein Match akzeptiert den neuen Ort oder behält das Date bei.",
    errTooShort: "Bitte schreibe deinem Match wenigstens eine kurze Notiz.",
    errRange: "Dieser Ort ist zu weit vom ursprünglichen entfernt. Wähle einen näheren.",
    errGeneric: "Anfrage konnte nicht gesendet werden. Versuch es erneut.",
    errNetwork: "Netzwerkfehler. Prüfe deine Verbindung und versuch es erneut.",
    counter: (n, min) => (n < min ? `${n}/${min} — etwas mehr` : `${n} Zeichen`),
  },
  pl: {
    disclaimerTitle: "Zmiana miejsca",
    disclaimerLead: "Kilka rzeczy, które warto wiedzieć przed wyborem.",
    disclaimerBullets: [
      "Inne miejsce możesz zaproponować tylko raz. Tego nie da się cofnąć.",
      "Twoja para wybiera: zaakceptować nowe miejsce albo odwołać randkę (odwołanie kończy dopasowanie na zawsze).",
      "Tylko miejsca w promieniu 3 km od pierwotnego, aby dojazd był wygodny dla was obojga.",
    ],
    disclaimerContinue: "Rozumiem, dalej",
    catalogTitle: "Wybierz nowe miejsce",
    catalogLead: "Miejsca w promieniu 3 km. Dotknij, aby zobaczyć więcej.",
    catalogEmpty: "Brak odpowiednich miejsc w pobliżu. Pierwotne miejsce pozostaje.",
    categoryLabels: {
      cafe: "Kawiarnia",
      coffee_shop: "Kawiarnia",
      restaurant: "Restauracja",
      park: "Park",
      museum: "Muzeum",
      lounge: "Lounge",
    },
    kmAway: (km) => `${km} km stąd`,
    detailProposeBtn: "Zaproponuj to miejsce",
    detailFallbackSummary: "Spokojne miejsce na pierwszą randkę.",
    openMaps: "Otwórz w Google Maps",
    back: "Wstecz",
    commentTitle: "Wyjaśnij parze dlaczego",
    commentLead: "Tę notatkę zobaczy tylko Twoja para.",
    commentPlaceholder:
      "Napisz, dlaczego chcesz zmienić miejsce (np. jest przytulniej / bliżej dla mnie / chcę spróbować ich deserów)",
    mainConfirm: "Wyślij do pary",
    mainSending: "Wysyłanie…",
    loading: "Ładowanie…",
    fallbackNoMatch: "Otwórz to z wiadomości o randce w bocie.",
    ineligibleGeneric: "Zmiana miejsca jest niedostępna dla tej randki.",
    ineligibleNotFemale: "Tylko Twoja para może zmienić to miejsce.",
    ineligiblePastCutoff: "Zbyt blisko randki, aby teraz zmieniać miejsce.",
    ineligibleAlreadyUsed: "Wykorzystałeś już swoją jedną zmianę miejsca.",
    ineligibleDisabled: "Zmiana miejsca jest teraz niedostępna.",
    successAlert: "Wysłano! Twoja para zaakceptuje nowe miejsce lub zostawi randkę bez zmian.",
    errTooShort: "Napisz parze chociaż krótką notatkę.",
    errRange: "To miejsce jest zbyt daleko od pierwotnego. Wybierz bliższe.",
    errGeneric: "Nie udało się wysłać prośby. Spróbuj ponownie.",
    errNetwork: "Błąd sieci. Sprawdź połączenie i spróbuj ponownie.",
    counter: (n, min) => (n < min ? `${n}/${min} — jeszcze trochę` : `${n} znaków`),
  },
};
const s = T[lang];

const CATEGORY_EMOJI: Record<string, string> = {
  cafe: "☕",
  coffee_shop: "☕",
  restaurant: "🍽️",
  park: "🌳",
  museum: "🏛️",
  lounge: "🍸",
};
function categoryGlyph(category: string): string {
  return CATEGORY_EMOJI[category] ?? "📍";
}
function categoryLabel(category: string): string {
  return s.categoryLabels[category] ?? category;
}

// ── DeviceStorage (comment draft) ──
function ds(): TelegramWebAppDeviceStorage | null {
  return window.Telegram?.WebApp?.DeviceStorage ?? null;
}
function readKey(key: string): Promise<string | null> {
  const store = ds();
  if (!store) {
    try {
      return Promise.resolve(window.localStorage.getItem(key));
    } catch {
      return Promise.resolve(null);
    }
  }
  return new Promise((resolve) => store.getItem(key, (_e, v) => resolve(v ?? null)));
}
function writeKey(key: string, value: string): void {
  const store = ds();
  if (!store) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
    return;
  }
  store.setItem(key, value, () => undefined);
}
function clearKey(key: string): void {
  const store = ds();
  if (!store) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }
  store.removeItem(key, () => undefined);
}
const draftKey = `gennety.venue-change.${matchId}`;

function haptic(kind: "light" | "success" | "error" | "select"): void {
  const hf = app?.HapticFeedback;
  if (!hf) return;
  try {
    if (kind === "select") hf.selectionChanged();
    else if (kind === "light") hf.impactOccurred("light");
    else hf.notificationOccurred(kind === "success" ? "success" : "error");
  } catch {
    /* best-effort */
  }
}

// ── Tiny DOM helper ──
interface ElAttrs {
  class?: string;
  text?: string;
  href?: string;
  target?: string;
  rel?: string;
  type?: string;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  ariaHidden?: boolean;
  bg?: string | null;
  onClick?: () => void;
}
function el(tag: string, attrs: ElAttrs = {}, children: Array<Node | string> = []): HTMLElement {
  const node = document.createElement(tag);
  if (attrs.class) node.className = attrs.class;
  if (attrs.text != null) node.textContent = attrs.text;
  if (attrs.href) (node as HTMLAnchorElement).href = attrs.href;
  if (attrs.target) node.setAttribute("target", attrs.target);
  if (attrs.rel) node.setAttribute("rel", attrs.rel);
  if (attrs.type) node.setAttribute("type", attrs.type);
  if (attrs.placeholder) (node as HTMLTextAreaElement).placeholder = attrs.placeholder;
  if (attrs.maxLength != null) (node as HTMLTextAreaElement).maxLength = attrs.maxLength;
  if (attrs.disabled != null) (node as HTMLButtonElement).disabled = attrs.disabled;
  if (attrs.ariaHidden) node.setAttribute("aria-hidden", "true");
  if (attrs.bg) node.style.backgroundImage = `url("${attrs.bg}")`;
  if (attrs.onClick) node.addEventListener("click", attrs.onClick);
  for (const c of children) node.append(c);
  return node;
}

const root = document.getElementById("root");
function mount(node: Node): void {
  if (root) root.replaceChildren(node);
}

/** Build a page: a flexing scroll area + an optional pinned bottom action bar. */
function page(scroll: Array<Node>, bar?: Array<Node>): HTMLElement {
  const children: Node[] = [el("div", { class: "vc-scroll" }, scroll)];
  if (bar && bar.length) children.push(el("div", { class: "vc-bar" }, bar));
  return el("div", { class: "vc-page" }, children);
}

// ── Native back button wiring ──
let backHandler: (() => void) | null = null;
function setBack(handler: (() => void) | null): void {
  const bb = app?.BackButton;
  if (!bb) return;
  if (backHandler) bb.offClick(backHandler);
  backHandler = handler;
  if (handler) {
    bb.onClick(handler);
    bb.show();
  } else {
    bb.hide();
  }
}

// ── Photo helpers ──
function thumbUrl(v: VenueChangeCatalogItem): string | null {
  if (v.photoUrl) return v.photoUrl;
  if (v.photoRefs[0]) return venueChangePhotoUrl(getInitData(), v.photoRefs[0], 240);
  return null;
}
function galleryUrls(v: VenueChangeCatalogItem): string[] {
  if (v.photoUrl) return [v.photoUrl];
  return v.photoRefs.map((ref) => venueChangePhotoUrl(getInitData(), ref, 1000));
}
function mapsHref(v: VenueChangeCatalogItem): string {
  if (v.mapsUri && /^https?:\/\//i.test(v.mapsUri)) return v.mapsUri;
  const q = [v.name, v.address].filter(Boolean).join(", ");
  return `https://maps.google.com/?q=${encodeURIComponent(q)}`;
}
/**
 * Open a link the Telegram-native way when possible. Returns true when handled
 * (so the caller can `preventDefault`); false leaves the anchor's default
 * `target=_blank` to do the work on clients without `openLink`.
 */
function openExternal(url: string): boolean {
  const opener = (app as unknown as { openLink?: (u: string) => void } | undefined)?.openLink;
  if (opener) {
    opener(url);
    return true;
  }
  return false;
}

// ── Centered states ──
function showLoading(): void {
  setBack(null);
  mount(el("div", { class: "vc-page" }, [
    el("div", { class: "vc-center" }, [el("div", { class: "spinner" }), el("p", { text: s.loading })]),
  ]));
}
function showMessage(icon: string, text: string): void {
  setBack(null);
  mount(el("div", { class: "vc-page" }, [
    el("div", { class: "vc-center" }, [
      el("div", { class: "vc-state-icon", text: icon }),
      el("p", { text }),
    ]),
  ]));
}

let stateView: VenueChangeState | null = null;

async function main(): Promise<void> {
  if (!matchId) {
    showMessage("🗺️", s.fallbackNoMatch);
    return;
  }
  showLoading();

  try {
    stateView = await fetchVenueChangeState(getInitData(), matchId);
  } catch {
    showMessage("⚠️", s.errGeneric);
    return;
  }

  if (!stateView.eligible) {
    showMessage("🔒", ineligibleMessage(stateView.ineligibleReason));
    return;
  }

  renderDisclaimer();
}

function ineligibleMessage(reason: string | null): string {
  switch (reason) {
    case "not-female-initiator":
    case "not-participant":
      return s.ineligibleNotFemale;
    case "past-cutoff":
      return s.ineligiblePastCutoff;
    case "already-used":
      return s.ineligibleAlreadyUsed;
    case "feature-disabled":
      return s.ineligibleDisabled;
    default:
      return s.ineligibleGeneric;
  }
}

// ── Step 1: disclaimer ──
function renderDisclaimer(): void {
  setBack(null);
  const header = el("div", { class: "vc-header" }, [
    el("h1", { class: "vc-h1", text: s.disclaimerTitle }),
    el("p", { class: "vc-lead", text: s.disclaimerLead }),
  ]);
  const rules = el(
    "div",
    { class: "vc-disclaimer" },
    s.disclaimerBullets.map((b) =>
      el("div", { class: "vc-rule" }, [
        el("div", { class: "vc-rule-mark", text: "◆", ariaHidden: true }),
        el("div", { class: "vc-rule-text", text: b }),
      ]),
    ),
  );
  const cont = el("button", { class: "btn-primary", type: "button", text: s.disclaimerContinue, onClick: () => {
    haptic("light");
    void loadCatalog();
  } });
  mount(page([header, rules], [cont]));
}

// ── Step 2: catalog ──
let catalog: VenueChangeCatalogItem[] = [];

async function loadCatalog(): Promise<void> {
  showLoading();
  try {
    catalog = await fetchVenueChangeCatalog(getInitData(), matchId);
  } catch (err) {
    showMessage("⚠️", err instanceof CalendarApiError ? ineligibleMessage(err.reason ?? null) : s.errGeneric);
    return;
  }
  renderCatalog();
}

function renderCatalog(): void {
  setBack(() => renderDisclaimer());
  const header = el("div", { class: "vc-header" }, [
    el("h1", { class: "vc-h1", text: s.catalogTitle }),
    el("p", { class: "vc-lead", text: s.catalogLead }),
  ]);

  if (catalog.length === 0) {
    mount(page([header, el("p", { class: "vc-lead", text: s.catalogEmpty })]));
    return;
  }

  const list = el("div", { class: "vc-list" }, catalog.map((v) => renderVenueCard(v)));
  mount(page([header, list]));
}

function venueThumb(v: VenueChangeCatalogItem, className = "vc-thumb"): HTMLElement {
  const url = thumbUrl(v);
  return el("div", { class: className, bg: url }, url ? [] : [categoryGlyph(v.category)]);
}

function renderVenueCard(v: VenueChangeCatalogItem): HTMLElement {
  const tags = el("div", { class: "vc-card-tags" }, [
    el("span", { class: "vc-chip", text: s.kmAway(v.distanceKm) }),
    ...ratingChip(v),
  ]);
  const meta = el("div", { class: "vc-card-meta" }, [
    el("div", { class: "vc-card-name", text: v.name }),
    el("div", { class: "vc-card-addr", text: v.address }),
    tags,
  ]);
  return el("button", { class: "vc-card", type: "button", onClick: () => {
    haptic("select");
    renderDetail(v);
  } }, [venueThumb(v), meta, el("span", { class: "vc-card-chevron", text: "›", ariaHidden: true })]);
}

function ratingChip(v: VenueChangeCatalogItem): HTMLElement[] {
  if (v.rating == null) return [];
  const count = v.userRatingCount ? ` · ${v.userRatingCount}` : "";
  return [
    el("span", { class: "vc-chip" }, [
      el("span", { class: "vc-chip-star", text: "★", ariaHidden: true }),
      ` ${v.rating.toFixed(1)}${count}`,
    ]),
  ];
}

// ── Step 3: detail ──
function renderDetail(v: VenueChangeCatalogItem): void {
  setBack(() => renderCatalog());

  const urls = galleryUrls(v);
  const shots =
    urls.length > 0
      ? urls.map((u) => el("div", { class: `vc-shot${urls.length === 1 ? " is-single" : ""}`, bg: u }))
      : [el("div", { class: "vc-shot is-single", text: categoryGlyph(v.category) })];
  const gallery = el("div", { class: "vc-gallery" }, shots);

  const nodes: Node[] = [gallery];

  if (shots.length > 1) {
    const dots = el(
      "div",
      { class: "vc-dots" },
      shots.map((_, i) => el("div", { class: `vc-dot${i === 0 ? " is-active" : ""}` })),
    );
    nodes.push(dots);
    gallery.addEventListener("scroll", () => {
      const w = (gallery.firstElementChild as HTMLElement | null)?.offsetWidth ?? 1;
      const idx = Math.round(gallery.scrollLeft / (w + 10));
      const children = dots.children;
      for (let i = 0; i < children.length; i++) {
        children[i].classList.toggle("is-active", i === idx);
      }
    }, { passive: true });
  }

  nodes.push(el("div", { class: "vc-detail-name", text: v.name }));

  const tags = el("div", { class: "vc-detail-tags" }, [
    el("span", { class: "vc-chip", text: categoryLabel(v.category) }),
    el("span", { class: "vc-chip", text: s.kmAway(v.distanceKm) }),
    ...ratingChip(v),
  ]);
  nodes.push(tags);

  nodes.push(el("p", { class: "vc-summary", text: v.editorialSummary || s.detailFallbackSummary }));

  if (v.address) {
    nodes.push(el("div", { class: "vc-info-row" }, [
      el("span", { class: "vc-info-icon", text: "📍", ariaHidden: true }),
      el("span", { class: "vc-info-text", text: v.address }),
    ]));
  }

  const href = mapsHref(v);
  const mapsRow = el("a", { class: "vc-info-row", href, target: "_blank", rel: "noopener" }, [
    el("span", { class: "vc-info-icon", text: "🗺️", ariaHidden: true }),
    el("span", { class: "vc-info-text", text: s.openMaps }),
    el("span", { class: "vc-info-chevron", text: "›", ariaHidden: true }),
  ]);
  mapsRow.addEventListener("click", (e) => {
    // Prefer Telegram's native opener inside the WebView; fall back to the
    // anchor's default target=_blank on clients without `openLink`.
    haptic("light");
    if (openExternal(href)) e.preventDefault();
  });
  nodes.push(mapsRow);

  const propose = el("button", { class: "btn-primary", type: "button", text: s.detailProposeBtn, onClick: () => {
    haptic("light");
    renderComment(v);
  } });
  const back = el("button", { class: "btn-secondary", type: "button", text: s.back, onClick: () => renderCatalog() });

  mount(page([el("div", { class: "vc-detail" }, nodes)], [propose, back]));
}

// ── Step 4: reason ──
function renderComment(venue: VenueChangeCatalogItem): void {
  setBack(() => renderDetail(venue));
  const minComment = stateView?.minCommentLength ?? 10;
  let submitting = false;

  const header = el("div", { class: "vc-header" }, [
    el("h1", { class: "vc-h1", text: s.commentTitle }),
    el("p", { class: "vc-lead", text: s.commentLead }),
  ]);

  const chosen = el("div", { class: "vc-chosen" }, [
    venueThumb(venue, "vc-thumb"),
    el("div", { class: "vc-chosen-meta" }, [
      el("div", { class: "vc-chosen-name", text: venue.name }),
      el("div", { class: "vc-chosen-addr", text: venue.address }),
    ]),
  ]);

  const input = el("textarea", { class: "vc-textarea", placeholder: s.commentPlaceholder, maxLength: 1000 }) as HTMLTextAreaElement;
  const counter = el("div", { class: "vc-counter" });

  const send = el("button", { class: "btn-primary", type: "button", text: s.mainConfirm, disabled: true }) as HTMLButtonElement;
  const back = el("button", { class: "btn-secondary", type: "button", text: s.back, onClick: () => renderDetail(venue) });

  function sync(): void {
    const len = input.value.trim().length;
    counter.textContent = s.counter(len, minComment);
    if (!submitting) send.disabled = len < minComment;
  }

  input.addEventListener("input", () => {
    writeKey(draftKey, input.value);
    sync();
  });

  void readKey(draftKey).then((draft) => {
    if (draft && !input.value) input.value = draft;
    sync();
  });

  send.addEventListener("click", () => {
    if (submitting) return;
    const comment = input.value.trim();
    if (comment.length < minComment) {
      app?.showAlert(s.errTooShort);
      return;
    }
    submitting = true;
    send.disabled = true;
    send.replaceChildren(el("span", { class: "btn-spin", ariaHidden: true }), ` ${s.mainSending}`);
    void submitProposal(venue, comment, () => {
      submitting = false;
      send.textContent = s.mainConfirm;
      sync();
    });
  });

  mount(page([header, chosen, input, counter], [send, back]));
  sync();
  setTimeout(() => input.focus(), 50);
}

async function submitProposal(
  venue: VenueChangeCatalogItem,
  comment: string,
  onError: () => void,
): Promise<void> {
  try {
    await proposeVenueChange(getInitData(), {
      matchId,
      placeId: venue.placeId,
      name: venue.name,
      address: venue.address,
      lat: venue.lat,
      lng: venue.lng,
      mapsUri: venue.mapsUri,
      comment,
    });
    clearKey(draftKey);
    haptic("success");
    app?.showAlert(s.successAlert, () => app?.close());
  } catch (err) {
    haptic("error");
    app?.showAlert(errorMessage(err));
    onError();
  }
}

function errorMessage(err: unknown): string {
  if (!(err instanceof CalendarApiError)) return s.errNetwork;
  switch (err.reason) {
    case "comment-too-short":
      return s.errTooShort;
    case "out-of-range":
      return s.errRange;
    case "already-used":
      return s.ineligibleAlreadyUsed;
    case "past-cutoff":
      return s.ineligiblePastCutoff;
    default:
      return s.errGeneric;
  }
}

// Entry point — invoked last, after every module-level binding above is
// initialized. Calling main() before the `let stateView` / `let catalog`
// declarations would assign into them while still in their temporal dead
// zone (ReferenceError: Cannot access uninitialized variable).
void main();
