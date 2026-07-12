/**
 * Venue change v2 Mini App (PRODUCT_SPEC §3.7b — paid multiplayer board).
 *
 * Opened from either side's scheduled-date DM via a `web_app` button →
 * `venue-change.html?match={id}&lang={en|ru|uk|de|pl}`. Full-screen Telegram
 * Web App on the shared Liquid Glass tokens (theme.css), brand burgundy accent.
 *
 * Flow (no disclaimers — straight into the board):
 *   1. Board — the current venue pinned on top ("picked for you", the eternal
 *      default), then the 3 km catalog. Marking a place is LOCAL and free: the
 *      partner sees nothing and no venue can be agreed until the explicit
 *      Suggest/Confirm CTA is tapped, so a stray tap is never a decision. The
 *      CTA's label switches to "Confirm this place" the moment a mark of mine
 *      overlaps one of theirs — that tap is the one that agrees. Cards the
 *      partner (or both of us) marked are wrapped in a framed "window" whose
 *      bottom band spells out what happened in words, rather than leaving a
 *      lone glyph to carry the meaning. Peer marks land live (~4 s polling).
 *   2. Detail — gallery + chips + Maps link; mark/unmark, and (for her) the
 *      express unilateral swap (its own Stars invoice = its own confirmation).
 *   3. Agreed — the payment screen per the payer matrix: his pay(/decline)
 *      fork, her pay-self / offer-him fork, or the priceless "agreed" wait.
 *      Payments open a native Stars invoice (WebApp.openInvoice).
 *   4. Settled — the new venue is locked; the board closes for this date.
 * A lapse (unpaid agreement) closes the board too — the original venue simply
 * stands. Nothing here can ever cancel the match.
 *
 * Every glyph on screen is an authored vector from `icons.ts` — no platform
 * emoji, which would render as Apple art on iOS and blur when animated.
 */

import "./venue-change.css";
import {
  fetchVenueBoardState,
  fetchVenueChangeCatalog,
  submitVenueLikes,
  confirmVenueChoice,
  offerVenuePay,
  declineVenuePayApi,
  venueStarsInvoice,
  venueChangePhotoUrl,
  CalendarApiError,
  type VenueBoardState,
  type VenueChangeCatalogItem,
} from "./api.js";
import { icon, categoryIcon, type IconName } from "./icons.js";
import { wireContentInsets } from "./telegram-insets.js";

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

// Bot API 8.0+ — immersive fullscreen removes the top sheet gap so the design
// composition fills the screen. Older clients silently fall through to expand().
const chromeColor =
  document.documentElement.dataset.theme === "light" ? "#f5f5f5" : "#030303";
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
app?.MainButton?.hide?.();

const params = new URLSearchParams(location.search);
const matchId = app?.initDataUnsafe?.start_param ?? params.get("match") ?? "";
const queryLang = params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? "";
// Dev-only visual preview: `?preview` walks the board/detail/pay screens with
// mock data so the theming is reviewable without an eligible match. Inert in prod.
const previewMode = import.meta.env.DEV && params.get("preview") !== null;
// Telegram populates `app.initData` asynchronously on some clients — read it
// fresh at call time (see the calendar Mini App for the war story).
const getInitData = (): string => app?.initData ?? "";

type Lang = "en" | "ru" | "uk" | "de" | "pl";
const SUPPORTED: ReadonlySet<Lang> = new Set(["en", "ru", "uk", "de", "pl"]);
const lang: Lang = SUPPORTED.has(queryLang as Lang) ? (queryLang as Lang) : "en";
document.documentElement?.setAttribute("lang", lang);

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

interface Strings {
  boardTitle: string;
  boardLead: string;
  currentBadge: string;
  /** Captions on the framed peer/match/mine cards — they say what happened. */
  capPeer: (name: string) => string;
  capBoth: string;
  capMine: string;
  badgeNew: string;
  /** Contextual banner above the list — explains the current situation. */
  bannerPeerPicked: (name: string) => string;
  bannerMatch: string;
  bannerSuggest: string;
  /** Bottom CTA — appears only when there is something to submit. */
  ctaSuggest: string;
  ctaConfirm: string;
  ctaSaving: string;
  confirmHint: string;
  catalogEmpty: string;
  categoryLabels: Record<string, string>;
  kmAway: (km: number) => string;
  detailFallbackSummary: string;
  openMaps: string;
  back: string;
  heartAdd: string;
  heartRemove: string;
  expressBtn: (stars: number) => string;
  expressHint: string;
  overlapTitle: string;
  overlapLead: string;
  agreedTitle: string;
  agreedWaitNote: string;
  agreedDeclinedNote: string;
  payBtn: (stars: number) => string;
  paySelfBtn: (stars: number) => string;
  offerBtn: string;
  offerSentNote: string;
  declineBtn: string;
  finalizing: string;
  settledTitle: string;
  settledPeerPaid: string;
  settledNote: string;
  closedChanged: string;
  closedCutoff: string;
  closedGeneric: string;
  loading: string;
  fallbackNoMatch: string;
  errGeneric: string;
  errNetwork: string;
  payFailed: string;
}

const T: Record<Lang, Strings> = {
  en: {
    boardTitle: "Your date spot",
    boardLead: "Mark the places you'd like. Your match sees them — and nothing changes until you confirm.",
    currentBadge: "Picked for you",
    capPeer: (name) => `${name} marked this place`,
    capBoth: "You both marked this one",
    capMine: "You marked this",
    badgeNew: "New",
    bannerPeerPicked: (name) => `${name} marked the places below. Mark the ones you like too.`,
    bannerMatch: "You agree on a place — confirm to make it your date spot.",
    bannerSuggest: "Your match will see your marks. Agree on one and the venue changes.",
    ctaSuggest: "Suggest these places",
    ctaConfirm: "Confirm this place",
    ctaSaving: "Saving…",
    confirmHint: "Nothing changes until you confirm.",
    catalogEmpty: "No suitable places nearby right now. Your venue stays as is.",
    categoryLabels: {
      cafe: "Cafe",
      coffee_shop: "Coffee shop",
      restaurant: "Restaurant",
      park: "Park",
      museum: "Museum",
      lounge: "Lounge",
    },
    kmAway: (km) => `${km} km`,
    detailFallbackSummary: "A relaxed spot for a first date.",
    openMaps: "Open in Google Maps",
    back: "Back",
    heartAdd: "Suggest together",
    heartRemove: "Remove my mark",
    expressBtn: (stars) => `Change right now — ${stars}`,
    expressHint: "Your match will get an updated date card.",
    overlapTitle: "Your hearts met!",
    overlapLead: "You matched on several places — pick the one.",
    agreedTitle: "You agreed on a new spot",
    agreedWaitNote: "Agreed. One last touch and your date cards update.",
    agreedDeclinedNote: "The venue stays as planned for now.",
    payBtn: (stars) => `Lock it in — ${stars}`,
    paySelfBtn: (stars) => `Lock it in myself — ${stars}`,
    offerBtn: "Ask them to lock it in",
    offerSentNote: "Your ask is on its way. You can still lock it in yourself anytime.",
    declineBtn: "Not this time",
    finalizing: "Locking in your new spot…",
    settledTitle: "New spot locked in!",
    settledPeerPaid: "Your match locked it in for you",
    settledNote: "Your date cards are updated. See you there!",
    closedChanged: "The venue for this date was already changed.",
    closedCutoff: "It's too close to the date to change the venue now.",
    closedGeneric: "Changing the venue isn't available for this date.",
    loading: "Loading…",
    fallbackNoMatch: "Open this from your scheduled-date message in the bot.",
    errGeneric: "Something went wrong. Try again.",
    errNetwork: "Network error. Check your connection and try again.",
    payFailed: "The payment didn't go through. Nothing was charged — try again.",
  },
  ru: {
    boardTitle: "Место свидания",
    boardLead: "Отметьте места, которые нравятся. Партнёр их увидит — пока вы не подтвердите, ничего не меняется.",
    currentBadge: "Выбрано для вас",
    capPeer: (name) => `Выбор ${name}`,
    capBoth: "Вы оба отметили это место",
    capMine: "Вы отметили",
    badgeNew: "Новое",
    bannerPeerPicked: (name) => `${name} присматривает места ниже. Отметьте те, что нравятся и вам.`,
    bannerMatch: "Вы сошлись на месте — подтвердите, чтобы закрепить его.",
    bannerSuggest: "Партнёр увидит ваши отметки. Совпадёте — место сменится.",
    ctaSuggest: "Предложить эти места",
    ctaConfirm: "Подтвердить это место",
    ctaSaving: "Сохраняем…",
    confirmHint: "Пока не подтвердите — ничего не меняется.",
    catalogEmpty: "Подходящих мест рядом сейчас нет. Ваше место остаётся в силе.",
    categoryLabels: {
      cafe: "Кафе",
      coffee_shop: "Кофейня",
      restaurant: "Ресторан",
      park: "Парк",
      museum: "Музей",
      lounge: "Лаундж",
    },
    kmAway: (km) => `${km} км`,
    detailFallbackSummary: "Спокойное место для первого свидания.",
    openMaps: "Открыть в Google Maps",
    back: "Назад",
    heartAdd: "Предложить вместе",
    heartRemove: "Убрать отметку",
    expressBtn: (stars) => `Поменять сразу — ${stars}`,
    expressHint: "Партнёр получит обновлённую карточку свидания.",
    overlapTitle: "Ваши сердечки совпали!",
    overlapLead: "Вы совпали в нескольких местах — выберите одно.",
    agreedTitle: "Вы сошлись на новом месте",
    agreedWaitNote: "Согласовано. Последний штрих — и карточки свидания обновятся.",
    agreedDeclinedNote: "Место пока остаётся прежним.",
    payBtn: (stars) => `Закрепить — ${stars}`,
    paySelfBtn: (stars) => `Закрепить самой — ${stars}`,
    offerBtn: "Предложить закрепить партнёру",
    offerSentNote: "Предложение отправлено. Закрепить самой можно в любой момент.",
    declineBtn: "Не в этот раз",
    finalizing: "Закрепляем новое место…",
    settledTitle: "Новое место закреплено!",
    settledPeerPaid: "Партнёр закрепил его для вас",
    settledNote: "Карточки свидания обновлены. До встречи!",
    closedChanged: "Место для этого свидания уже меняли.",
    closedCutoff: "Слишком близко к свиданию, чтобы менять место.",
    closedGeneric: "Смена места недоступна для этого свидания.",
    loading: "Загрузка…",
    fallbackNoMatch: "Откройте это из сообщения о свидании в боте.",
    errGeneric: "Что-то пошло не так. Попробуйте снова.",
    errNetwork: "Ошибка сети. Проверьте соединение и попробуйте снова.",
    payFailed: "Оплата не прошла. Ничего не списано — попробуйте ещё раз.",
  },
  uk: {
    boardTitle: "Місце побачення",
    boardLead: "Позначте місця, які подобаються. Партнер їх побачить — доки не підтвердите, нічого не змінюється.",
    currentBadge: "Обрано для вас",
    capPeer: (name) => `Вибір ${name}`,
    capBoth: "Ви обоє позначили це місце",
    capMine: "Ви позначили",
    badgeNew: "Нове",
    bannerPeerPicked: (name) => `${name} придивляється до місць нижче. Позначте ті, що подобаються й вам.`,
    bannerMatch: "Ви зійшлися на місці — підтвердіть, щоб закріпити його.",
    bannerSuggest: "Партнер побачить ваші позначки. Збіжаться — місце зміниться.",
    ctaSuggest: "Запропонувати ці місця",
    ctaConfirm: "Підтвердити це місце",
    ctaSaving: "Зберігаємо…",
    confirmHint: "Доки не підтвердите — нічого не змінюється.",
    catalogEmpty: "Підходящих місць поруч зараз немає. Ваше місце залишається.",
    categoryLabels: {
      cafe: "Кафе",
      coffee_shop: "Кав'ярня",
      restaurant: "Ресторан",
      park: "Парк",
      museum: "Музей",
      lounge: "Лаундж",
    },
    kmAway: (km) => `${km} км`,
    detailFallbackSummary: "Спокійне місце для першого побачення.",
    openMaps: "Відкрити в Google Maps",
    back: "Назад",
    heartAdd: "Запропонувати разом",
    heartRemove: "Прибрати позначку",
    expressBtn: (stars) => `Змінити одразу — ${stars}`,
    expressHint: "Партнер отримає оновлену картку побачення.",
    overlapTitle: "Ваші серденька збіглися!",
    overlapLead: "Ви збіглися в кількох місцях — оберіть одне.",
    agreedTitle: "Ви зійшлися на новому місці",
    agreedWaitNote: "Погоджено. Останній штрих — і картки побачення оновляться.",
    agreedDeclinedNote: "Місце поки залишається тим самим.",
    payBtn: (stars) => `Закріпити — ${stars}`,
    paySelfBtn: (stars) => `Закріпити самій — ${stars}`,
    offerBtn: "Запропонувати закріпити партнеру",
    offerSentNote: "Пропозицію надіслано. Закріпити самій можна будь-коли.",
    declineBtn: "Не цього разу",
    finalizing: "Закріплюємо нове місце…",
    settledTitle: "Нове місце закріплено!",
    settledPeerPaid: "Партнер закріпив його для вас",
    settledNote: "Картки побачення оновлено. До зустрічі!",
    closedChanged: "Місце для цього побачення вже змінювали.",
    closedCutoff: "Занадто близько до побачення, щоб змінювати місце.",
    closedGeneric: "Зміна місця недоступна для цього побачення.",
    loading: "Завантаження…",
    fallbackNoMatch: "Відкрийте це з повідомлення про побачення в боті.",
    errGeneric: "Щось пішло не так. Спробуйте ще раз.",
    errNetwork: "Помилка мережі. Перевірте з'єднання та спробуйте ще раз.",
    payFailed: "Оплата не пройшла. Нічого не списано — спробуйте ще раз.",
  },
  de: {
    boardTitle: "Euer Date-Ort",
    boardLead: "Markiere Orte, die dir gefallen. Dein Match sieht sie — bis du bestätigst, ändert sich nichts.",
    currentBadge: "Für euch gewählt",
    capPeer: (name) => `${name}s Wahl`,
    capBoth: "Ihr habt beide diesen Ort markiert",
    capMine: "Von dir markiert",
    badgeNew: "Neu",
    bannerPeerPicked: (name) => `${name} schaut sich die Orte unten an. Markiere die, die dir auch gefallen.`,
    bannerMatch: "Ihr seid euch einig — bestätige, um den Ort zu übernehmen.",
    bannerSuggest: "Dein Match sieht deine Markierungen. Stimmt ihr überein, wechselt der Ort.",
    ctaSuggest: "Diese Orte vorschlagen",
    ctaConfirm: "Diesen Ort bestätigen",
    ctaSaving: "Wird gespeichert…",
    confirmHint: "Bis zur Bestätigung ändert sich nichts.",
    catalogEmpty: "Gerade keine passenden Orte in der Nähe. Euer Ort bleibt bestehen.",
    categoryLabels: {
      cafe: "Café",
      coffee_shop: "Coffee Shop",
      restaurant: "Restaurant",
      park: "Park",
      museum: "Museum",
      lounge: "Lounge",
    },
    kmAway: (km) => `${km} km`,
    detailFallbackSummary: "Ein entspannter Ort für ein erstes Date.",
    openMaps: "In Google Maps öffnen",
    back: "Zurück",
    heartAdd: "Gemeinsam vorschlagen",
    heartRemove: "Markierung entfernen",
    expressBtn: (stars) => `Sofort ändern — ${stars}`,
    expressHint: "Dein Match bekommt eine aktualisierte Date-Karte.",
    overlapTitle: "Eure Herzen haben sich getroffen!",
    overlapLead: "Ihr habt mehrere Orte gemeinsam — wählt einen aus.",
    agreedTitle: "Ihr habt euch auf einen neuen Ort geeinigt",
    agreedWaitNote: "Vereinbart. Ein letzter Schritt — dann werden eure Karten aktualisiert.",
    agreedDeclinedNote: "Der Ort bleibt vorerst wie geplant.",
    payBtn: (stars) => `Sichern — ${stars}`,
    paySelfBtn: (stars) => `Selbst sichern — ${stars}`,
    offerBtn: "Deinem Match das Sichern anbieten",
    offerSentNote: "Anfrage unterwegs. Du kannst jederzeit selbst sichern.",
    declineBtn: "Nicht diesmal",
    finalizing: "Neuer Ort wird gesichert…",
    settledTitle: "Neuer Ort gesichert!",
    settledPeerPaid: "Dein Match hat ihn für dich gesichert",
    settledNote: "Eure Date-Karten sind aktualisiert. Bis dann!",
    closedChanged: "Der Ort für dieses Date wurde bereits geändert.",
    closedCutoff: "Zu kurz vor dem Date, um den Ort zu ändern.",
    closedGeneric: "Das Ändern des Ortes ist für dieses Date nicht verfügbar.",
    loading: "Wird geladen…",
    fallbackNoMatch: "Öffne dies über deine Date-Nachricht im Bot.",
    errGeneric: "Etwas ist schiefgelaufen. Versuch es erneut.",
    errNetwork: "Netzwerkfehler. Prüfe deine Verbindung und versuch es erneut.",
    payFailed: "Die Zahlung ging nicht durch. Nichts wurde abgebucht — versuch es erneut.",
  },
  pl: {
    boardTitle: "Miejsce randki",
    boardLead: "Zaznacz miejsca, które Ci się podobają. Twoja para je zobaczy — dopóki nie potwierdzisz, nic się nie zmienia.",
    currentBadge: "Wybrane dla was",
    capPeer: (name) => `Wybór ${name}`,
    capBoth: "Oboje zaznaczyliście to miejsce",
    capMine: "Zaznaczone przez Ciebie",
    badgeNew: "Nowe",
    bannerPeerPicked: (name) => `${name} przygląda się miejscom poniżej. Zaznacz te, które podobają się też Tobie.`,
    bannerMatch: "Zgadzacie się co do miejsca — potwierdź, aby je ustawić.",
    bannerSuggest: "Twoja para zobaczy Twoje zaznaczenia. Zgodzicie się — miejsce się zmieni.",
    ctaSuggest: "Zaproponuj te miejsca",
    ctaConfirm: "Potwierdź to miejsce",
    ctaSaving: "Zapisywanie…",
    confirmHint: "Dopóki nie potwierdzisz, nic się nie zmienia.",
    catalogEmpty: "Brak odpowiednich miejsc w pobliżu. Wasze miejsce pozostaje.",
    categoryLabels: {
      cafe: "Kawiarnia",
      coffee_shop: "Kawiarnia",
      restaurant: "Restauracja",
      park: "Park",
      museum: "Muzeum",
      lounge: "Lounge",
    },
    kmAway: (km) => `${km} km`,
    detailFallbackSummary: "Spokojne miejsce na pierwszą randkę.",
    openMaps: "Otwórz w Google Maps",
    back: "Wstecz",
    heartAdd: "Zaproponuj razem",
    heartRemove: "Usuń zaznaczenie",
    expressBtn: (stars) => `Zmień od razu — ${stars}`,
    expressHint: "Twoja para dostanie zaktualizowaną kartę randki.",
    overlapTitle: "Wasze serduszka się spotkały!",
    overlapLead: "Zgadzacie się w kilku miejscach — wybierz jedno.",
    agreedTitle: "Zgodziliście się na nowe miejsce",
    agreedWaitNote: "Uzgodnione. Ostatni krok — i wasze karty się zaktualizują.",
    agreedDeclinedNote: "Miejsce na razie zostaje bez zmian.",
    payBtn: (stars) => `Zatwierdź — ${stars}`,
    paySelfBtn: (stars) => `Zatwierdź samodzielnie — ${stars}`,
    offerBtn: "Zaproponuj parze zatwierdzenie",
    offerSentNote: "Propozycja wysłana. Możesz zatwierdzić samodzielnie w każdej chwili.",
    declineBtn: "Nie tym razem",
    finalizing: "Zatwierdzamy nowe miejsce…",
    settledTitle: "Nowe miejsce zatwierdzone!",
    settledPeerPaid: "Twoja para zatwierdziła je dla Ciebie",
    settledNote: "Karty randki zaktualizowane. Do zobaczenia!",
    closedChanged: "Miejsce tej randki było już zmieniane.",
    closedCutoff: "Zbyt blisko randki, aby zmieniać miejsce.",
    closedGeneric: "Zmiana miejsca jest niedostępna dla tej randki.",
    loading: "Ładowanie…",
    fallbackNoMatch: "Otwórz to z wiadomości o randce w bocie.",
    errGeneric: "Coś poszło nie tak. Spróbuj ponownie.",
    errNetwork: "Błąd sieci. Sprawdź połączenie i spróbuj ponownie.",
    payFailed: "Płatność nie przeszła. Nic nie pobrano — spróbuj ponownie.",
  },
};
const s = T[lang];

function categoryLabel(category: string): string {
  return s.categoryLabels[category] ?? category;
}

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

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------

interface ElAttrs {
  class?: string;
  text?: string;
  href?: string;
  target?: string;
  rel?: string;
  type?: string;
  disabled?: boolean;
  ariaHidden?: boolean;
  bg?: string | null;
  onClick?: (e: Event) => void;
}
function el(tag: string, attrs: ElAttrs = {}, children: Array<Node | string> = []): HTMLElement {
  const node = document.createElement(tag);
  if (attrs.class) node.className = attrs.class;
  if (attrs.text != null) node.textContent = attrs.text;
  if (attrs.href) (node as HTMLAnchorElement).href = attrs.href;
  if (attrs.target) node.setAttribute("target", attrs.target);
  if (attrs.rel) node.setAttribute("rel", attrs.rel);
  if (attrs.type) node.setAttribute("type", attrs.type);
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
function mapsHref(name: string, address: string, mapsUri: string | null): string {
  if (mapsUri && /^https?:\/\//i.test(mapsUri)) return mapsUri;
  const q = [name, address].filter(Boolean).join(", ");
  return `https://maps.google.com/?q=${encodeURIComponent(q)}`;
}
function openExternal(url: string): boolean {
  const opener = (app as unknown as { openLink?: (u: string) => void } | undefined)?.openLink;
  if (opener) {
    opener(url);
    return true;
  }
  return false;
}

// ── Centered states ──
function showLoading(text = s.loading): void {
  setBack(null);
  mount(
    el("div", { class: "vc-page" }, [
      el("div", { class: "vc-center" }, [el("div", { class: "spinner" }), el("p", { text })]),
    ]),
  );
}
function showMessage(mark: IconName, text: string, sub?: string): void {
  setBack(null);
  const nodes: Node[] = [
    el("div", { class: "vc-state-icon" }, [icon(mark, "icon vc-state-glyph")]),
    el("p", { text }),
  ];
  if (sub) nodes.push(el("p", { class: "vc-note", text: sub }));
  mount(el("div", { class: "vc-page" }, [el("div", { class: "vc-center" }, nodes)]));
}

// ---------------------------------------------------------------------------
// App state + polling
// ---------------------------------------------------------------------------

let boardState: VenueBoardState | null = null;
let catalog: VenueChangeCatalogItem[] = [];
/**
 * Two-tier selection, exactly like the Calendar Mini App: `confirmed` is what
 * the server has for me, `selection` is what I'm marking right now. Marks are
 * LOCAL and free — nothing reaches the partner (and nothing can agree on a
 * venue) until the explicit Confirm/Suggest CTA is tapped. A stray tap is
 * therefore never a decision, it's just a mark you can tap off again.
 */
let confirmed = new Set<string>();
let selection = new Set<string>();
/** Peer keys already seen — anything new since then gets the NEW badge. */
let peerSeen = new Set<string>();
/** Which screen is showing — polling only live-updates the board itself. */
let screen: "board" | "detail" | "overlap" | "agreed" | "other" = "other";
let pollTimer: number | null = null;
/** Suppresses poll re-routing while a payment / request is in flight. */
let busy = false;
let saving = false;

function isDirty(): boolean {
  if (selection.size !== confirmed.size) return true;
  for (const k of selection) if (!confirmed.has(k)) return true;
  return false;
}

/** Keys I've marked that the partner already marked → confirming AGREES. */
function selectedOverlap(): string[] {
  const peer = new Set(boardState?.peerLikes ?? []);
  return [...selection].filter((k) => peer.has(k));
}

function catalogByKey(key: string): VenueChangeCatalogItem | null {
  return catalog.find((v) => keyOf(v) === key) ?? null;
}
function keyOf(v: VenueChangeCatalogItem): string {
  return v.placeId ?? `${v.name}|${v.address}`;
}

function startPolling(): void {
  if (pollTimer != null || previewMode) return;
  pollTimer = window.setInterval(() => {
    void (async () => {
      if (busy) return;
      try {
        const fresh = await fetchVenueBoardState(getInitData(), matchId);
        const prev = boardState;
        boardState = fresh;
        if (!prev) return;
        // Status flips (agreement, settle, lapse, his decline) re-route.
        if (fresh.status !== prev.status || fresh.myAction !== prev.myAction) {
          route();
          return;
        }
        // On the live board only the partner's marks move under us — patch the
        // cards that actually changed rather than rebuilding the list (which
        // would replay every entry animation and read as a flash).
        if (screen === "board" && fresh.peerLikes.join() !== prev.peerLikes.join()) {
          const changed = new Set([...fresh.peerLikes, ...prev.peerLikes]);
          for (const key of changed) patchCard(key);
          syncBoardChrome();
        }
      } catch {
        /* transient poll failure — next tick retries */
      }
    })();
  }, 4000);
}
function stopPolling(): void {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function errorMessage(err: unknown): string {
  if (!(err instanceof CalendarApiError)) return s.errNetwork;
  switch (err.reason) {
    case "already-changed":
      return s.closedChanged;
    case "past-cutoff":
      return s.closedCutoff;
    default:
      return s.errGeneric;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function route(): void {
  const st = boardState;
  if (!st) return;
  if (st.settled) {
    stopPolling();
    renderSettled(st);
    return;
  }
  if (st.status === "agreed" && st.agreed) {
    renderAgreed(st);
    return;
  }
  if (st.status === "agreed" && !st.agreed) {
    // Hidden express mint on the partner's side — hold on the (frozen) board.
    renderBoard();
    return;
  }
  if (!st.open) {
    stopPolling();
    const msg =
      st.closedReason === "already-changed" || st.status === "lapsed"
        ? s.closedChanged
        : st.closedReason === "past-cutoff"
          ? s.closedCutoff
          : s.closedGeneric;
    showMessage("pin", msg, st.original.name ?? undefined);
    return;
  }
  renderBoard();
}

async function main(): Promise<void> {
  if (!matchId && !previewMode) {
    showMessage("map", s.fallbackNoMatch);
    return;
  }
  showLoading();

  if (previewMode) {
    boardState = mockState();
    catalog = mockCatalog();
    confirmed = new Set(boardState.myLikes);
    selection = new Set(boardState.myLikes);
    peerSeen = new Set();
    route();
    return;
  }

  try {
    boardState = await fetchVenueBoardState(getInitData(), matchId);
    if (boardState.open) {
      catalog = await fetchVenueChangeCatalog(getInitData(), matchId);
    }
  } catch (err) {
    showMessage("pin", errorMessage(err));
    return;
  }
  confirmed = new Set(boardState.myLikes);
  selection = new Set(boardState.myLikes);
  // First open snapshots nothing: every mark the partner already has is NEW to
  // me, which is exactly what I want to see on the very first visit.
  peerSeen = new Set();
  startPolling();
  route();
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/**
 * Live handles into the mounted board. Marking a place must NOT re-render the
 * page: a full re-mount replays every entry animation and reads as a flash.
 * Instead the board is built once and every later change is a surgical class /
 * text swap on these nodes, so the CSS transitions do the work smoothly.
 */
interface CardRefs {
  frame: HTMLElement;
  heart: HTMLElement;
  cap: HTMLElement;
}
const cardRefs = new Map<string, CardRefs>();
let bannerEl: HTMLElement | null = null;
let barEl: HTMLElement | null = null;
let ctaBtn: HTMLButtonElement | null = null;

function renderBoard(): void {
  screen = "board";
  setBack(null);
  const st = boardState;
  if (!st) return;
  cardRefs.clear();

  const header = el("div", { class: "vc-header" }, [
    el("h1", { class: "vc-h1", text: s.boardTitle }),
    el("p", { class: "vc-lead", text: s.boardLead }),
  ]);

  // The current venue — the eternal default, pinned on top.
  const current = el("div", { class: "vc-current glass-in" }, [
    el("div", { class: "vc-current-badge", text: s.currentBadge }),
    el("div", { class: "vc-current-name", text: st.original.name ?? "" }),
    el("div", { class: "vc-current-addr", text: st.original.address ?? "" }),
  ]);

  // Contextual banner — says what's going on and what the next tap will do, so
  // the board never leans on the marks alone to carry meaning.
  bannerEl = el("div", { class: "vc-banner" });

  const nodes: Node[] = [header, current, bannerEl];
  if (catalog.length === 0) {
    nodes.push(el("p", { class: "vc-lead", text: s.catalogEmpty }));
  } else {
    nodes.push(el("div", { class: "vc-list" }, catalog.map((v) => renderVenueCard(v))));
  }

  // The CTA bar lives in the DOM permanently and slides in/out — creating and
  // destroying it per tap is what made the layout jump.
  ctaBtn = el("button", {
    class: "btn-primary",
    type: "button",
    onClick: () => void submitSelection(),
  }) as HTMLButtonElement;
  barEl = el("div", { class: "vc-bar is-hidden" }, [
    ctaBtn,
    el("p", { class: "vc-note vc-note-center", text: s.confirmHint }),
  ]);

  mount(el("div", { class: "vc-page" }, [el("div", { class: "vc-scroll" }, nodes), barEl]));
  syncBoardChrome();
}

/** Repaint the banner + CTA from the current selection, in place. */
function syncBoardChrome(): void {
  const st = boardState;
  if (!st) return;

  if (bannerEl) {
    const agreeing = selectedOverlap().length > 0;
    let mark: IconName = "heart";
    let markCls = "icon vc-banner-icon";
    let copy = "";
    if (agreeing) {
      mark = "spark";
      copy = s.bannerMatch;
    } else if (st.peerLikes.length > 0 && selection.size === 0) {
      mark = "heart-filled";
      markCls += " is-peer";
      copy = s.bannerPeerPicked(st.partnerName);
    } else if (selection.size > 0) {
      markCls += " is-self";
      copy = s.bannerSuggest;
    }
    bannerEl.classList.toggle("is-match", agreeing);
    bannerEl.hidden = copy === "";
    if (copy) {
      bannerEl.replaceChildren(icon(mark, markCls), el("span", { text: copy }));
    }
  }

  if (barEl && ctaBtn) {
    const dirty = isDirty();
    barEl.classList.toggle("is-hidden", !dirty);
    if (dirty) {
      const agreeing = selectedOverlap().length > 0;
      ctaBtn.textContent = saving ? s.ctaSaving : agreeing ? s.ctaConfirm : s.ctaSuggest;
      ctaBtn.disabled = saving;
    }
  }
}

/** Repaint ONE card's marked state — the only thing a tap changes. */
function patchCard(key: string): void {
  const refs = cardRefs.get(key);
  if (!refs) return;
  const mine = selection.has(key);
  const theirs = boardState?.peerLikes.includes(key) ?? false;
  const both = mine && theirs;

  refs.frame.className =
    "vc-frame" +
    (mine || theirs ? " is-marked" : "") +
    (both ? " is-match" : theirs ? " is-peer" : mine ? " is-mine" : "");

  refs.heart.className = `vc-heart${mine ? " is-mine" : ""}${theirs ? " is-theirs" : ""}`;
  refs.heart.replaceChildren(icon(mine ? "heart-filled" : "heart", "icon vc-heart-icon"));

  refs.cap.replaceChildren(...captionKids(key, mine, theirs));
}

/** Caption content: identity dots (white = me, burgundy = them) + the words. */
function captionKids(key: string, mine: boolean, theirs: boolean): Node[] {
  if (!mine && !theirs) return [];
  const dots: Node[] = [];
  if (mine) dots.push(el("span", { class: "vc-cap-dot is-self" }));
  if (theirs) dots.push(el("span", { class: "vc-cap-dot is-peer" }));

  const text = mine && theirs
    ? s.capBoth
    : theirs
      ? s.capPeer(boardState?.partnerName ?? "")
      : s.capMine;

  const kids: Node[] = [
    el("span", { class: "vc-cap-dots" }, dots),
    el("span", { class: "vc-cap-text", text }),
  ];
  if (theirs && !peerSeen.has(key)) {
    kids.push(el("span", { class: "vc-badge-new", text: s.badgeNew }));
  }
  return kids;
}

/**
 * A button carrying an authored mark. `withStar` appends our own star glyph —
 * never the platform ⭐, which renders as Apple/Google art.
 */
function iconBtn(
  cls: string,
  mark: IconName,
  label: string,
  onClick: () => void,
  withStar = false,
): HTMLElement {
  const kids: Node[] = [icon(mark, "icon btn-icon"), el("span", { text: label })];
  if (withStar) kids.push(icon("star", "icon btn-icon btn-star"));
  return el("button", { class: cls, type: "button", onClick }, kids);
}

/** The mark button — an authored vector heart (never a platform emoji). */
function heartButton(v: VenueChangeCatalogItem): HTMLElement {
  const key = keyOf(v);
  const mine = selection.has(key);
  const theirs = boardState?.peerLikes.includes(key) ?? false;
  return el(
    "button",
    {
      class: `vc-heart${mine ? " is-mine" : ""}${theirs ? " is-theirs" : ""}`,
      type: "button",
      onClick: (e) => {
        e.stopPropagation();
        toggleMark(v);
      },
    },
    [icon(mine ? "heart-filled" : "heart", "icon vc-heart-icon")],
  );
}

/**
 * One venue row. The frame + caption band are ALWAYS in the DOM — bare cards
 * simply keep the frame transparent and the band collapsed — so marking a place
 * expands them through a CSS transition instead of rebuilding the list.
 */
function renderVenueCard(v: VenueChangeCatalogItem): HTMLElement {
  const key = keyOf(v);
  const mine = selection.has(key);
  const theirs = boardState?.peerLikes.includes(key) ?? false;
  const both = mine && theirs;

  const chips: Node[] = [
    el("span", { class: "vc-chip" }, [
      categoryIcon(v.category, "icon vc-chip-icon"),
      el("span", { text: s.kmAway(v.distanceKm) }),
    ]),
  ];
  if (v.rating != null) {
    chips.push(
      el("span", { class: "vc-chip" }, [
        icon("star", "icon vc-chip-icon vc-chip-star"),
        el("span", { text: v.rating.toFixed(1) }),
      ]),
    );
  }

  const meta = el("div", { class: "vc-card-meta" }, [
    el("div", { class: "vc-card-name", text: v.name }),
    el("div", { class: "vc-card-addr", text: v.address }),
    el("div", { class: "vc-card-tags" }, chips),
  ]);

  const heart = heartButton(v);
  const card = el(
    "div",
    {
      class: "vc-card",
      onClick: () => {
        haptic("select");
        renderDetail(v);
      },
    },
    [venueThumb(v), meta, heart],
  );

  const cap = el("div", { class: "vc-cap" }, captionKids(key, mine, theirs));
  const frame = el(
    "div",
    {
      class:
        "vc-frame" +
        (mine || theirs ? " is-marked" : "") +
        (both ? " is-match" : theirs ? " is-peer" : mine ? " is-mine" : ""),
    },
    [card, cap],
  );

  cardRefs.set(key, { frame, heart, cap });
  return frame;
}

function venueThumb(v: VenueChangeCatalogItem, className = "vc-thumb"): HTMLElement {
  const url = thumbUrl(v);
  return el("div", { class: className, bg: url }, url ? [] : [categoryIcon(v.category, "icon vc-thumb-icon")]);
}

/**
 * Mark / unmark — purely local. No network, no partner visibility, no
 * agreement: those all wait for the explicit CTA, so an accidental tap costs
 * nothing and is undone by tapping again.
 */
function toggleMark(v: VenueChangeCatalogItem): void {
  const key = keyOf(v);
  if (selection.has(key)) selection.delete(key);
  else selection.add(key);
  haptic("select");
  if (screen === "board") {
    patchCard(key);
    syncBoardChrome();
  }
}

/** Submit the marks (Suggest) — or, when they overlap the partner's, agree. */
async function submitSelection(): Promise<void> {
  if (previewMode || saving) return;
  saving = true;
  busy = true;
  syncBoardChrome();
  try {
    const res = await submitVenueLikes(getInitData(), matchId, [...selection]);
    confirmed = new Set(selection);
    if (res.agreed) {
      boardState = await fetchVenueBoardState(getInitData(), matchId);
      haptic("success");
      saving = false;
      busy = false;
      route();
      return;
    }
    if (res.overlapCandidates.length > 1) {
      saving = false;
      busy = false;
      renderOverlapSheet(res.overlapCandidates);
      return;
    }
    boardState = await fetchVenueBoardState(getInitData(), matchId);
    // My marks are now on the server, so the partner's are no longer "new" news
    // to me — and the CTA retires until I change something again.
    peerSeen = new Set(boardState.peerLikes);
    haptic("success");
    saving = false;
    busy = false;
    if (screen === "board") {
      for (const key of cardRefs.keys()) patchCard(key);
      syncBoardChrome();
    } else {
      route();
    }
  } catch (err) {
    saving = false;
    busy = false;
    haptic("error");
    app?.showAlert(errorMessage(err));
    syncBoardChrome();
  }
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function renderDetail(v: VenueChangeCatalogItem): void {
  screen = "detail";
  setBack(() => {
    renderBoard();
  });

  const urls = galleryUrls(v);
  const shots =
    urls.length > 0
      ? urls.map((u) => el("div", { class: `vc-shot${urls.length === 1 ? " is-single" : ""}`, bg: u }))
      : [el("div", { class: "vc-shot is-single" }, [categoryIcon(v.category, "icon vc-shot-icon")])];
  const gallery = el("div", { class: "vc-gallery" }, shots);

  const nodes: Node[] = [gallery];

  if (shots.length > 1) {
    const dots = el(
      "div",
      { class: "vc-dots" },
      shots.map((_, i) => el("div", { class: `vc-dot${i === 0 ? " is-active" : ""}` })),
    );
    nodes.push(dots);
    gallery.addEventListener(
      "scroll",
      () => {
        const w = (gallery.firstElementChild as HTMLElement | null)?.offsetWidth ?? 1;
        const idx = Math.round(gallery.scrollLeft / (w + 10));
        const children = dots.children;
        for (let i = 0; i < children.length; i++) {
          children[i].classList.toggle("is-active", i === idx);
        }
      },
      { passive: true },
    );
  }

  nodes.push(el("div", { class: "vc-detail-name", text: v.name }));

  const tags = el("div", { class: "vc-detail-tags" }, [
    el("span", { class: "vc-chip", text: categoryLabel(v.category) }),
    el("span", { class: "vc-chip", text: s.kmAway(v.distanceKm) }),
    ...(v.rating != null
      ? [el("span", { class: "vc-chip" }, [
          el("span", { class: "vc-chip-star", text: "★", ariaHidden: true }),
          ` ${v.rating.toFixed(1)}${v.userRatingCount ? ` · ${v.userRatingCount}` : ""}`,
        ])]
      : []),
  ]);
  nodes.push(tags);

  nodes.push(el("p", { class: "vc-summary", text: v.editorialSummary || s.detailFallbackSummary }));

  if (v.address) {
    nodes.push(el("div", { class: "vc-info-row" }, [
      icon("pin", "icon vc-info-icon"),
      el("span", { class: "vc-info-text", text: v.address }),
    ]));
  }

  const href = mapsHref(v.name, v.address, v.mapsUri);
  const mapsRow = el("a", { class: "vc-info-row", href, target: "_blank", rel: "noopener" }, [
    icon("map", "icon vc-info-icon"),
    el("span", { class: "vc-info-text", text: s.openMaps }),
    icon("chevron", "icon vc-info-chevron"),
  ]);
  mapsRow.addEventListener("click", (e) => {
    haptic("light");
    if (openExternal(href)) e.preventDefault();
  });
  nodes.push(mapsRow);

  const bar: Node[] = [];
  // Marking is local and reversible; the board's Confirm CTA is the only thing
  // that reaches the partner, so this button can never commit a venue by itself.
  // It repaints itself in place — re-rendering the page would flash the screen.
  const markBtn = el("button", { class: "btn-primary", type: "button" });
  const paintMarkBtn = (): void => {
    const mine = selection.has(keyOf(v));
    markBtn.className = mine ? "btn-secondary" : "btn-primary";
    markBtn.replaceChildren(
      icon(mine ? "heart-filled" : "heart", "icon btn-icon"),
      el("span", { text: mine ? s.heartRemove : s.heartAdd }),
    );
  };
  markBtn.addEventListener("click", () => {
    toggleMark(v);
    paintMarkBtn();
  });
  paintMarkBtn();
  bar.push(markBtn);
  if (boardState?.expressAvailable && boardState.priceStars != null) {
    const price = boardState.priceStars;
    bar.push(
      iconBtn("btn-express", "bolt", s.expressBtn(price), () => {
        haptic("light");
        void startExpress(v);
      }, true),
    );
    bar.push(el("p", { class: "vc-note", text: s.expressHint }));
  }

  mount(page([el("div", { class: "vc-detail" }, nodes)], bar));
}

// ---------------------------------------------------------------------------
// Overlap sheet (>1 simultaneous matches — the actor picks one)
// ---------------------------------------------------------------------------

function renderOverlapSheet(keys: string[]): void {
  screen = "overlap";
  setBack(() => {
    renderBoard();
  });
  const header = el("div", { class: "vc-header" }, [
    el("h1", { class: "vc-h1", text: s.overlapTitle }),
    el("p", { class: "vc-lead", text: s.overlapLead }),
  ]);
  const cards = keys
    .map((k) => catalogByKey(k))
    .filter((v): v is VenueChangeCatalogItem => v != null)
    .map((v) =>
      el(
        "div",
        {
          class: "vc-card is-match",
          onClick: () => {
            haptic("success");
            void confirmOverlap(v);
          },
        },
        [
          venueThumb(v),
          el("div", { class: "vc-card-meta" }, [
            el("div", { class: "vc-card-name", text: v.name }),
            el("div", { class: "vc-card-addr", text: v.address }),
          ]),
          icon("chevron", "icon vc-card-chevron"),
        ],
      ),
    );
  mount(page([header, el("div", { class: "vc-list" }, cards)]));
}

async function confirmOverlap(v: VenueChangeCatalogItem): Promise<void> {
  if (previewMode) return;
  busy = true;
  showLoading();
  try {
    await confirmVenueChoice(getInitData(), matchId, keyOf(v));
    boardState = await fetchVenueBoardState(getInitData(), matchId);
    route();
  } catch (err) {
    haptic("error");
    app?.showAlert(errorMessage(err));
    renderBoard();
  } finally {
    busy = false;
  }
}

// ---------------------------------------------------------------------------
// Agreed (payment matrix screens)
// ---------------------------------------------------------------------------

function renderAgreed(st: VenueBoardState): void {
  screen = "agreed";
  setBack(null);
  const agreed = st.agreed;
  if (!agreed) return;

  const venue = catalogByKey(agreed.key);
  const hero = venue
    ? venueThumb(venue, "vc-agreed-photo")
    : el("div", { class: "vc-agreed-photo" }, [icon("pin", "icon vc-shot-icon")]);

  const card = el("div", { class: "vc-agreed glass-in" }, [
    hero,
    el("div", { class: "vc-agreed-badge" }, [icon("spark", "icon")]),
    el("div", { class: "vc-current-name", text: agreed.name }),
    el("div", { class: "vc-current-addr", text: agreed.address }),
  ]);

  const header = el("div", { class: "vc-header" }, [
    el("h1", { class: "vc-h1", text: s.agreedTitle }),
  ]);

  const nodes: Node[] = [header, card];
  const bar: Node[] = [];
  const price = st.priceStars;

  switch (st.myAction) {
    case "pay":
    case "pay_or_decline":
      if (price != null) {
        bar.push(
          iconBtn("btn-primary", "check", s.payBtn(price), () => void payAgreed(), true),
        );
      }
      if (st.myAction === "pay_or_decline") {
        bar.push(
          el("button", {
            class: "btn-secondary",
            type: "button",
            text: s.declineBtn,
            onClick: () => void declinePay(),
          }),
        );
      }
      break;
    case "pay_or_offer":
      if (price != null) {
        bar.push(
          iconBtn("btn-primary", "check", s.paySelfBtn(price), () => void payAgreed(), true),
        );
      }
      if (st.canOfferPartner) {
        bar.push(iconBtn("btn-glass", "letter", s.offerBtn, () => void offerPay()));
      } else if (st.offerSent) {
        nodes.push(el("p", { class: "vc-note vc-note-center", text: s.offerSentNote }));
      }
      break;
    case "wait":
      nodes.push(el("p", { class: "vc-note vc-note-center", text: s.agreedWaitNote }));
      break;
    default:
      // His post-decline view — neutral, decision is out of his hands now.
      nodes.push(el("p", { class: "vc-note vc-note-center", text: s.agreedDeclinedNote }));
      break;
  }

  mount(page(nodes, bar));
}

async function payAgreed(): Promise<void> {
  if (previewMode) return;
  haptic("light");
  busy = true;
  try {
    const { link } = await venueStarsInvoice(getInitData(), matchId, "agreed");
    openInvoiceAndFinalize(link);
  } catch (err) {
    busy = false;
    haptic("error");
    app?.showAlert(errorMessage(err));
  }
}

async function startExpress(v: VenueChangeCatalogItem): Promise<void> {
  if (previewMode) return;
  busy = true;
  try {
    const { link } = await venueStarsInvoice(getInitData(), matchId, "express", keyOf(v));
    openInvoiceAndFinalize(link);
  } catch (err) {
    busy = false;
    haptic("error");
    app?.showAlert(errorMessage(err));
  }
}

/**
 * Open the native Stars sheet; on `paid`, hold a "locking in…" spinner while
 * the bot's successful_payment settle lands, then show the settled screen.
 */
function openInvoiceAndFinalize(link: string): void {
  const open = app?.openInvoice;
  if (!open) {
    busy = false;
    // Ancient client without openInvoice — the link still works as a URL.
    if (!openExternal(link)) window.open(link, "_blank");
    return;
  }
  open.call(app, link, (status) => {
    if (status === "paid") {
      haptic("success");
      showLoading(s.finalizing);
      void pollUntilSettled();
    } else {
      busy = false;
      if (status === "failed") {
        haptic("error");
        app?.showAlert(s.payFailed);
      }
      // cancelled/pending — back to wherever we were.
      route();
    }
  });
}

async function pollUntilSettled(attempt = 0): Promise<void> {
  try {
    boardState = await fetchVenueBoardState(getInitData(), matchId);
    if (boardState.settled) {
      busy = false;
      route();
      return;
    }
  } catch {
    /* retry below */
  }
  if (attempt >= 15) {
    // The settle DM will still land in chat; don't strand the user here.
    busy = false;
    route();
    return;
  }
  window.setTimeout(() => void pollUntilSettled(attempt + 1), 1200);
}

async function declinePay(): Promise<void> {
  if (previewMode) return;
  busy = true;
  showLoading();
  try {
    await declineVenuePayApi(getInitData(), matchId);
    boardState = await fetchVenueBoardState(getInitData(), matchId);
  } catch {
    /* state refetch below still routes correctly */
  }
  busy = false;
  haptic("light");
  route();
}

async function offerPay(): Promise<void> {
  if (previewMode) return;
  busy = true;
  try {
    await offerVenuePay(getInitData(), matchId);
    boardState = await fetchVenueBoardState(getInitData(), matchId);
    haptic("success");
  } catch (err) {
    haptic("error");
    app?.showAlert(errorMessage(err));
  }
  busy = false;
  route();
}

// ---------------------------------------------------------------------------
// Settled
// ---------------------------------------------------------------------------

function renderSettled(st: VenueBoardState): void {
  screen = "other";
  setBack(null);
  const settled = st.settled;
  if (!settled) return;

  const nodes: Node[] = [
    el("div", { class: "vc-settled-burst", ariaHidden: true }, [
      el("div", { class: "vc-settled-check" }, [icon("check", "icon")]),
    ]),
    el("h1", { class: "vc-h1 vc-h1-center", text: s.settledTitle }),
  ];
  if (settled.peerPaid) {
    nodes.push(el("p", { class: "vc-note vc-note-center vc-note-love", text: s.settledPeerPaid }));
  }
  nodes.push(
    el("div", { class: "vc-current glass-in" }, [
      el("div", { class: "vc-current-name", text: settled.name }),
      el("div", { class: "vc-current-addr", text: settled.address }),
    ]),
  );
  nodes.push(el("p", { class: "vc-note vc-note-center", text: s.settledNote }));

  const href = mapsHref(settled.name, settled.address, settled.mapsUri);
  const maps = iconBtn("btn-glass", "map", s.openMaps, () => {
    if (!openExternal(href)) window.open(href, "_blank");
  });
  mount(page([el("div", { class: "vc-settled" }, nodes)], [maps]));
}

// ---------------------------------------------------------------------------
// Dev preview mocks
// ---------------------------------------------------------------------------

function mockCatalog(): VenueChangeCatalogItem[] {
  const mk = (
    placeId: string,
    name: string,
    address: string,
    category: string,
    distanceKm: number,
    rating: number,
    count: number,
    summary: string,
  ): VenueChangeCatalogItem => ({
    source: "curated",
    placeId,
    name,
    address,
    lat: 0,
    lng: 0,
    mapsUri: null,
    category,
    distanceKm,
    photoUrl: null,
    photoRefs: [],
    rating,
    userRatingCount: count,
    editorialSummary: summary,
  });
  return [
    mk("p1", "Кофейня «Молоко»", "ул. Крещатик, 14", "cafe", 0.4, 4.7, 320, "Уютная спешелти-кофейня с видом на бульвар."),
    mk("p2", "Bar Chill", "ул. Лютеранская, 3", "lounge", 0.9, 4.5, 210, "Тихий коктейльный бар с мягким светом."),
    mk("p3", "Парк «Владимирская горка»", "Владимирский спуск", "park", 1.3, 4.8, 540, "Панорама Днепра и тенистые аллеи."),
  ];
}

function mockState(): VenueBoardState {
  const view = params.get("preview") ?? "board";
  const base: VenueBoardState = {
    status: "liking",
    open: true,
    closedReason: null,
    original: { name: "Кафе «Старое место»", address: "ул. Прорезная, 8", mapsUri: null },
    partnerName: "Sofia",
    myLikes: ["p1"],
    peerLikes: ["p2"],
    agreed: null,
    myAction: null,
    priceStars: 150,
    canOfferPartner: false,
    offerSent: false,
    payDeclined: false,
    expressAvailable: true,
    settled: null,
  };
  if (view === "agreed") {
    return {
      ...base,
      status: "agreed",
      open: false,
      agreed: { key: "p1", name: "Кофейня «Молоко»", address: "ул. Крещатик, 14", mapsUri: null, expiresAt: null },
      myAction: (params.get("action") as VenueBoardState["myAction"]) ?? "pay_or_offer",
      canOfferPartner: true,
      expressAvailable: false,
    };
  }
  if (view === "settled") {
    return {
      ...base,
      status: "settled",
      open: false,
      settled: { name: "Кофейня «Молоко»", address: "ул. Крещатик, 14", mapsUri: null, peerPaid: true },
    };
  }
  return base;
}

// Entry point — invoked last, after every module-level binding above is
// initialized (calling earlier would hit the temporal dead zone).
void main();
