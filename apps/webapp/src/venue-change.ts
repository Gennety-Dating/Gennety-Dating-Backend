/**
 * Venue change Mini App entry point (PRODUCT_SPEC §3.7).
 *
 * Opened from the female's scheduled-date DM via a `web_app` button →
 * `venue-change.html?match={id}&lang={en|ru|uk|de|pl}`.
 *
 * Three steps:
 *   1. Disclaimer (mandatory, blocking) — one-time / irreversible / partner can
 *      cancel the match / 3 km radius. Single "I understand" button.
 *   2. Catalog — alternatives within 3 km of the original venue (curated-first,
 *      Places fallback). Tap a card → step 3.
 *   3. Comment — mandatory ≥N-char explanation; the MainButton ("Confirm")
 *      stays disabled until the threshold is met. On confirm we POST the pick +
 *      comment; the bot relays it to the male, who accepts or declines.
 *
 * The comment draft is cached to DeviceStorage so a swipe-down dismiss doesn't
 * wipe what she typed (same pattern as the calendar / feedback apps).
 */

import {
  fetchVenueChangeState,
  fetchVenueChangeCatalog,
  proposeVenueChange,
  CalendarApiError,
  type VenueChangeCatalogItem,
} from "./api.js";

const app = window.Telegram?.WebApp;
app?.ready();
app?.expand();

const params = new URLSearchParams(location.search);
const matchId = app?.initDataUnsafe?.start_param ?? params.get("match") ?? "";
const queryLang = params.get("lang") ?? app?.initDataUnsafe?.user?.language_code ?? "";
const initData = app?.initData ?? "";

type Lang = "en" | "ru" | "uk" | "de" | "pl";
const SUPPORTED: ReadonlySet<Lang> = new Set(["en", "ru", "uk", "de", "pl"]);
const lang: Lang = SUPPORTED.has(queryLang as Lang) ? (queryLang as Lang) : "en";
document.documentElement?.setAttribute("lang", lang);

interface Strings {
  disclaimerTitle: string;
  disclaimerBullets: string[];
  disclaimerContinue: string;
  catalogTitle: string;
  catalogLead: string;
  catalogEmpty: string;
  commentTitle: string;
  commentPlaceholder: string;
  commentBack: string;
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
    disclaimerTitle: "Before you change the venue",
    disclaimerBullets: [
      "You can propose a different place only once. This can't be undone.",
      "Your match chooses: accept the new place, or cancel the date (cancelling ends the match forever).",
      "You can only pick places within 3 km of the original venue, so the trip stays comfortable for both of you.",
    ],
    disclaimerContinue: "I understand, continue",
    catalogTitle: "Pick a new place",
    catalogLead: "Spots within 3 km of your original venue.",
    catalogEmpty: "No suitable places nearby right now. Your original venue stays as is.",
    commentTitle: "Tell your match why",
    commentPlaceholder:
      "Write why you'd like to change the place (e.g. it's cosier / closer for me / I want to try their desserts)",
    commentBack: "← Back to places",
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
    disclaimerTitle: "Перед сменой места",
    disclaimerBullets: [
      "Предложить другое место можно только один раз. Это нельзя отменить.",
      "Партнёр выбирает: согласиться на новое место или отменить свидание (отмена аннулирует метч навсегда).",
      "Выбрать можно только места в радиусе 3 км от исходного, чтобы дорога осталась удобной для вас обоих.",
    ],
    disclaimerContinue: "Я понимаю, продолжить",
    catalogTitle: "Выберите новое место",
    catalogLead: "Места в радиусе 3 км от исходного.",
    catalogEmpty: "Подходящих мест рядом сейчас нет. Исходное место остаётся в силе.",
    commentTitle: "Объясните партнёру почему",
    commentPlaceholder:
      "Напишите, почему хотите изменить место (например: там уютнее / мне ближе / хочу попробовать их десерты)",
    commentBack: "← Назад к местам",
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
    disclaimerTitle: "Перед зміною місця",
    disclaimerBullets: [
      "Запропонувати інше місце можна лише один раз. Це не можна скасувати.",
      "Партнер обирає: погодитися на нове місце або скасувати побачення (скасування анулює метч назавжди).",
      "Обрати можна лише місця в радіусі 3 км від початкового, щоб дорога залишалася зручною для вас обох.",
    ],
    disclaimerContinue: "Я розумію, продовжити",
    catalogTitle: "Оберіть нове місце",
    catalogLead: "Місця в радіусі 3 км від початкового.",
    catalogEmpty: "Підходящих місць поруч зараз немає. Початкове місце залишається.",
    commentTitle: "Поясніть партнеру чому",
    commentPlaceholder:
      "Напишіть, чому хочете змінити місце (наприклад: там затишніше / мені ближче / хочу спробувати їхні десерти)",
    commentBack: "← Назад до місць",
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
    disclaimerTitle: "Bevor du den Ort änderst",
    disclaimerBullets: [
      "Du kannst nur einmal einen anderen Ort vorschlagen. Das lässt sich nicht rückgängig machen.",
      "Dein Match entscheidet: den neuen Ort akzeptieren oder das Date absagen (Absagen beendet das Match für immer).",
      "Du kannst nur Orte im Umkreis von 3 km des ursprünglichen Ortes wählen, damit der Weg für euch beide bequem bleibt.",
    ],
    disclaimerContinue: "Ich verstehe, weiter",
    catalogTitle: "Neuen Ort wählen",
    catalogLead: "Orte im Umkreis von 3 km deines ursprünglichen Ortes.",
    catalogEmpty: "Gerade keine passenden Orte in der Nähe. Dein ursprünglicher Ort bleibt bestehen.",
    commentTitle: "Sag deinem Match warum",
    commentPlaceholder:
      "Schreibe, warum du den Ort ändern möchtest (z. B. gemütlicher / näher für mich / ich möchte ihre Desserts probieren)",
    commentBack: "← Zurück zu den Orten",
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
    disclaimerTitle: "Zanim zmienisz miejsce",
    disclaimerBullets: [
      "Inne miejsce możesz zaproponować tylko raz. Tego nie da się cofnąć.",
      "Twoja para wybiera: zaakceptować nowe miejsce albo odwołać randkę (odwołanie kończy dopasowanie na zawsze).",
      "Możesz wybrać tylko miejsca w promieniu 3 km od pierwotnego, aby dojazd był wygodny dla was obojga.",
    ],
    disclaimerContinue: "Rozumiem, dalej",
    catalogTitle: "Wybierz nowe miejsce",
    catalogLead: "Miejsca w promieniu 3 km od pierwotnego.",
    catalogEmpty: "Brak odpowiednich miejsc w pobliżu. Pierwotne miejsce pozostaje.",
    commentTitle: "Wyjaśnij parze dlaczego",
    commentPlaceholder:
      "Napisz, dlaczego chcesz zmienić miejsce (np. jest przytulniej / bliżej dla mnie / chcę spróbować ich deserów)",
    commentBack: "← Wróć do miejsc",
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

// ── DOM helpers ──
function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
function showOnly(sectionId: string | null): void {
  for (const id of ["msg", "step-disclaimer", "step-catalog", "step-comment"]) {
    $(id).classList.toggle("hidden", id !== sectionId);
  }
}
function showMessage(text: string): void {
  $("msg").textContent = text;
  showOnly("msg");
  app?.MainButton.hide();
}

void main();

async function main(): Promise<void> {
  if (!matchId) {
    showMessage(s.fallbackNoMatch);
    return;
  }
  showMessage(s.loading);

  let state;
  try {
    state = await fetchVenueChangeState(initData, matchId);
  } catch {
    showMessage(s.errGeneric);
    return;
  }

  if (!state.eligible) {
    showMessage(ineligibleMessage(state.ineligibleReason));
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
  $("disclaimer-title").textContent = s.disclaimerTitle;
  const list = $("disclaimer-list");
  list.innerHTML = "";
  for (const bullet of s.disclaimerBullets) {
    const li = document.createElement("li");
    li.textContent = bullet;
    list.appendChild(li);
  }
  const btn = $("disclaimer-continue") as HTMLButtonElement;
  btn.textContent = s.disclaimerContinue;
  btn.onclick = () => void loadCatalog();
  showOnly("step-disclaimer");
  app?.MainButton.hide();
}

// ── Step 2: catalog ──
const MIN_COMMENT_DEFAULT = 10;
let minComment = MIN_COMMENT_DEFAULT;

async function loadCatalog(): Promise<void> {
  showMessage(s.loading);
  let venues: VenueChangeCatalogItem[];
  try {
    venues = await fetchVenueChangeCatalog(initData, matchId);
  } catch (err) {
    showMessage(err instanceof CalendarApiError ? ineligibleMessage(err.reason ?? null) : s.errGeneric);
    return;
  }

  $("catalog-title").textContent = s.catalogTitle;
  $("catalog-lead").textContent = s.catalogLead;
  const listEl = $("catalog-list");
  const emptyEl = $("catalog-empty");
  listEl.innerHTML = "";

  if (venues.length === 0) {
    emptyEl.textContent = s.catalogEmpty;
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
    for (const v of venues) {
      listEl.appendChild(renderVenueCard(v));
    }
  }
  showOnly("step-catalog");
  app?.MainButton.hide();
}

function renderVenueCard(v: VenueChangeCatalogItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "venue";

  const thumb = document.createElement("div");
  thumb.className = "thumb";
  if (v.photoUrl) {
    thumb.style.backgroundImage = `url("${v.photoUrl}")`;
  } else {
    thumb.textContent = CATEGORY_EMOJI[v.category] ?? "📍";
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = v.name;
  const addr = document.createElement("div");
  addr.className = "addr";
  addr.textContent = v.address;
  const dist = document.createElement("div");
  dist.className = "dist";
  dist.textContent = `${v.distanceKm} km`;
  meta.append(name, addr, dist);

  card.append(thumb, meta);
  card.onclick = () => renderComment(v);
  return card;
}

// ── Step 3: comment ──
// MainButton handlers must be de-registered before re-binding, otherwise
// picking a second venue (after "back") would leave the first venue's submit
// handler attached and fire a stale proposal. We track the live handler.
let mainHandler: (() => void) | null = null;

function renderComment(venue: VenueChangeCatalogItem): void {
  $("comment-title").textContent = s.commentTitle;
  $("comment-venue").textContent = venue.name;
  $("comment-addr").textContent = venue.address;

  const input = $("comment-input") as HTMLTextAreaElement;
  input.placeholder = s.commentPlaceholder;

  const back = $("comment-back");
  back.textContent = s.commentBack;
  back.onclick = () => void loadCatalog();

  const counter = $("comment-counter");
  let submitting = false;

  function sync(): void {
    const len = input.value.trim().length;
    counter.textContent = s.counter(len, minComment);
    if (!app) return;
    if (len >= minComment && !submitting) {
      app.MainButton.setText(s.mainConfirm);
      app.MainButton.show();
      app.MainButton.enable();
    } else if (!submitting) {
      app.MainButton.hide();
      app.MainButton.disable();
    }
  }

  input.oninput = () => {
    writeKey(draftKey, input.value);
    sync();
  };

  void readKey(draftKey).then((draft) => {
    if (draft && !input.value) input.value = draft;
    sync();
  });

  if (mainHandler) app?.MainButton.offClick(mainHandler);
  const onMain = async (): Promise<void> => {
    if (submitting) return;
    const comment = input.value.trim();
    if (comment.length < minComment) {
      app?.showAlert(s.errTooShort);
      return;
    }
    submitting = true;
    app?.MainButton.showProgress(false);
    app?.MainButton.setText(s.mainSending);
    try {
      await proposeVenueChange(initData, {
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
      app?.MainButton.hideProgress();
      app?.showAlert(s.successAlert, () => app?.close());
    } catch (err) {
      submitting = false;
      app?.MainButton.hideProgress();
      app?.showAlert(errorMessage(err));
      sync();
    }
  };
  mainHandler = () => void onMain();
  app?.MainButton.onClick(mainHandler);

  showOnly("step-comment");
  sync();
  input.focus();
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
