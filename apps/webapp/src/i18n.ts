/**
 * Tiny i18n table for the Calendar Mini App. Mirrors the keys we'd ask
 * `@gennety/shared` for, but inlined so the webapp doesn't have to take
 * a workspace dependency on `shared` (per AGENTS.md "Avoid new
 * abstractions unless they remove real duplication").
 *
 * The active language is read from `?lang=` on the URL the bot
 * generates; the bot writes the user's `User.language` into that
 * query param when it sends the calendar button. Defaults to `en` for
 * resilience (e.g. someone bookmarks the URL).
 */

export type Lang = "en" | "ru" | "uk" | "de" | "pl";

interface Strings {
  title: string;
  titleDate: string;
  titleTime: string;
  titleAgreed: string;
  titleWaiting: string;
  titleConfirm: string;
  bannerPeerPicked: string;
  bannerProposingAlternative: string;
  btnSave: string;
  btnSuggestTime: string;
  btnSaving: string;
  btnConfirm: string;
  btnBackToDates: string;
  btnClose: string;
  btnEdit: string;
  btnRemind: string;
  btnRemindArmed: string;
  errExpired: string;
  errMatchGone: string;
  errInvalidSlot: string;
  errWrongState: string;
  errNotParticipant: string;
  errGeneric: string;
  errNetwork: string;
  agreedHeader: string;
  agreedSubtitle: string;
  waitingHeader: string;
  waitingSubtitle: string;
  multiOverlapHeader: string;
  multiOverlapSubtitle: string;
  emptyHint: string;
  legendMine: string;
  legendPeer: string;
  legendAlternative: string;
  legendOverlap: string;
  badgeNew: string;
  noContext: string;
  // Location Mini App (Phase 3.7 — concierge map picker)
  locTitle: string;
  locSearchPlaceholder: string;
  locEmptyHint: string;
  locSelectedPrefix: string;
  locCustomPoint: string;
  locShareCurrent: string;
  locSharingCurrent: string;
  locCurrentLocation: string;
  locConfirm: string;
  locConfirming: string;
  locSaved: string;
  locErrInvalidCoords: string;
  locErrGeoDenied: string;
  locErrGeoUnavailable: string;
  locErrGeoTimeout: string;
  locErrGeoUnsupported: string;
  locErrMapUnavailable: string;
  // Verification Mini App (Phase 6.3 — Persona embedded flow)
  verifyMiniAppLoading: string;
  verifyMiniAppFinishing: string;
  verifyMiniAppError: string;
  verifyMiniAppCloseBtn: string;
  verifyMiniAppAlreadyVerified: string;
  verifyMiniAppNotConfigured: string;
}

const dict: Record<Lang, Strings> = {
  en: {
    title: "Pick a time for your date",
    titleDate: "Pick a date",
    titleTime: "Pick a time",
    titleAgreed: "Date locked",
    titleWaiting: "Waiting for your match",
    titleConfirm: "Choose one option",
    bannerPeerPicked:
      "Your match marked these times. Tap one to instantly agree, or pick your own — they'll see it live.",
    bannerProposingAlternative:
      "You have a different time selected. Tap your match's slot to agree, or send your time as a counter-proposal.",
    btnSave: "Save",
    btnSuggestTime: "Suggest time",
    btnSaving: "Saving…",
    btnConfirm: "Confirm",
    btnBackToDates: "Back to dates",
    btnClose: "Close",
    btnEdit: "Change my picks",
    btnRemind: "Remind me",
    btnRemindArmed: "We'll remind",
    errExpired: "This calendar link expired. Reopen it from the bot.",
    errMatchGone: "Couldn't find this match anymore. Reopen the calendar from the bot.",
    errInvalidSlot: "That slot isn't available anymore. Pick another one.",
    errWrongState: "This match isn't waiting for a calendar pick.",
    errNotParticipant: "You're not part of this match.",
    errGeneric: "Couldn't save your pick. Try again.",
    errNetwork: "Network error. Check your connection and try again.",
    agreedHeader: "Locked in 🎉",
    agreedSubtitle: "Time agreed. Head back to the bot for the next steps.",
    waitingHeader: "Saved",
    waitingSubtitle:
      "We'll ping the bot the moment your match replies. You can close this window — we'll let you know.",
    multiOverlapHeader: "You both have a few options",
    multiOverlapSubtitle: "Pick the one that works best — this will lock in your date.",
    emptyHint: "Tap any slot you're free.",
    legendMine: "You",
    legendPeer: "Match",
    legendAlternative: "Other time",
    legendOverlap: "Both",
    badgeNew: "NEW",
    noContext: "No match context — reopen this from the bot.",
    locTitle: "Where will you be coming from?",
    locSearchPlaceholder: "Metro, address, place…",
    locEmptyHint: "Type an address or tap on the map.",
    locSelectedPrefix: "Selected: ",
    locCustomPoint: "Custom point on map",
    locShareCurrent: "Share my location",
    locSharingCurrent: "Locating…",
    locCurrentLocation: "My current location",
    locConfirm: "Confirm",
    locConfirming: "Saving…",
    locSaved: "Saved ✨ Heading back to the bot.",
    locErrInvalidCoords: "That location seems invalid — try again.",
    locErrGeoDenied: "Location permission was denied. You can still type an address or tap the map.",
    locErrGeoUnavailable: "Couldn't read your current location. Try typing an address or tapping the map.",
    locErrGeoTimeout: "Location lookup timed out. Try again, or type an address.",
    locErrGeoUnsupported: "Location sharing isn't available in this browser. You can still type an address or tap the map.",
    locErrMapUnavailable: "The map couldn't load. Check your connection and try again.",
    verifyMiniAppLoading: "Opening verification…",
    verifyMiniAppFinishing: "Almost done. Checking results…",
    verifyMiniAppError: "Couldn't start verification. Try again.",
    verifyMiniAppCloseBtn: "Close",
    verifyMiniAppAlreadyVerified:
      "You're already verified — nothing to do here.",
    verifyMiniAppNotConfigured:
      "Verification isn't available right now. Try again a bit later.",
  },
  ru: {
    title: "Выбери время для свидания",
    titleDate: "Выбери дату",
    titleTime: "Выбери время",
    titleAgreed: "Свидание зафиксировано",
    titleWaiting: "Ждём собеседника",
    titleConfirm: "Выбери один вариант",
    bannerPeerPicked:
      "Собеседник отметил эти варианты. Нажми один, чтобы мгновенно согласиться, или выбери свой — он(а) увидит вживую.",
    bannerProposingAlternative:
      "У тебя выбран другой вариант времени. Нажми слот собеседника, чтобы согласиться, или отправь своё время как встречное предложение.",
    btnSave: "Сохранить",
    btnSuggestTime: "Предложить время",
    btnSaving: "Сохраняем…",
    btnConfirm: "Подтвердить",
    btnBackToDates: "Назад к датам",
    btnClose: "Закрыть",
    btnEdit: "Изменить выбор",
    btnRemind: "Напомнить",
    btnRemindArmed: "Напомним",
    errExpired: "Ссылка на календарь устарела. Открой его заново из бота.",
    errMatchGone: "Не нашли этот матч. Открой календарь заново из бота.",
    errInvalidSlot: "Этот слот больше недоступен. Выбери другой.",
    errWrongState: "Этот матч сейчас не ждёт выбора времени.",
    errNotParticipant: "Ты не участник этого матча.",
    errGeneric: "Не удалось сохранить выбор. Попробуй ещё раз.",
    errNetwork: "Сетевая ошибка. Проверь соединение и попробуй ещё раз.",
    agreedHeader: "Готово 🎉",
    agreedSubtitle: "Время согласовано. Возвращайся в бота — следующий шаг там.",
    waitingHeader: "Сохранено",
    waitingSubtitle:
      "Бот пришлёт сообщение, как только собеседник ответит. Можешь закрыть это окно — мы напомним.",
    multiOverlapHeader: "У вас обоих есть несколько вариантов",
    multiOverlapSubtitle: "Выбери один — это и зафиксирует ваше свидание.",
    emptyHint: "Отметь любой удобный слот.",
    legendMine: "Ты",
    legendPeer: "Собеседник",
    legendAlternative: "Другое время",
    legendOverlap: "Совпало",
    badgeNew: "NEW",
    noContext: "Нет контекста матча — открой заново из бота.",
    locTitle: "Откуда поедешь на свидание?",
    locSearchPlaceholder: "Метро, адрес, заведение…",
    locEmptyHint: "Введи адрес или тапни по карте.",
    locSelectedPrefix: "Выбрано: ",
    locCustomPoint: "Точка на карте",
    locShareCurrent: "Поделиться геолокацией",
    locSharingCurrent: "Ищем геолокацию…",
    locCurrentLocation: "Моя текущая геолокация",
    locConfirm: "Подтвердить",
    locConfirming: "Сохраняем…",
    locSaved: "Сохранил ✨ Возвращайся в бота.",
    locErrInvalidCoords: "Странные координаты — попробуй ещё раз.",
    locErrGeoDenied: "Доступ к геолокации отклонён. Можно ввести адрес или тапнуть по карте.",
    locErrGeoUnavailable: "Не удалось получить текущую геолокацию. Введи адрес или тапни по карте.",
    locErrGeoTimeout: "Поиск геолокации занял слишком много времени. Попробуй ещё раз или введи адрес.",
    locErrGeoUnsupported: "Геолокация недоступна в этом браузере. Можно ввести адрес или тапнуть по карте.",
    locErrMapUnavailable: "Не удалось загрузить карту. Проверь соединение и попробуй ещё раз.",
    verifyMiniAppLoading: "Открываем верификацию…",
    verifyMiniAppFinishing: "Готово. Проверяем результат…",
    verifyMiniAppError: "Не удалось запустить проверку. Попробуйте ещё раз.",
    verifyMiniAppCloseBtn: "Закрыть",
    verifyMiniAppAlreadyVerified:
      "Ты уже верифицирован — здесь делать нечего.",
    verifyMiniAppNotConfigured:
      "Верификация сейчас недоступна. Попробуй позже.",
  },
  uk: {
    title: "Обери час для побачення",
    titleDate: "Обери дату",
    titleTime: "Обери час",
    titleAgreed: "Побачення зафіксовано",
    titleWaiting: "Чекаємо співрозмовника",
    titleConfirm: "Обери один варіант",
    bannerPeerPicked:
      "Співрозмовник позначив ці варіанти. Тапни один, щоб одразу погодитись, або обери свій — він(вона) побачить наживо.",
    bannerProposingAlternative:
      "У тебе обрано інший час. Тапни слот співрозмовника, щоб погодитись, або надішли свій час як зустрічну пропозицію.",
    btnSave: "Зберегти",
    btnSuggestTime: "Запропонувати час",
    btnSaving: "Зберігаємо…",
    btnConfirm: "Підтвердити",
    btnBackToDates: "Назад до дат",
    btnClose: "Закрити",
    btnEdit: "Змінити вибір",
    btnRemind: "Нагадати",
    btnRemindArmed: "Нагадаємо",
    errExpired: "Посилання на календар застаріло. Відкрий його знову з бота.",
    errMatchGone: "Не знайшли цей матч. Відкрий календар знову з бота.",
    errInvalidSlot: "Цей слот уже недоступний. Обери інший.",
    errWrongState: "Цей матч зараз не чекає вибору часу.",
    errNotParticipant: "Ти не учасник цього матчу.",
    errGeneric: "Не вдалося зберегти вибір. Спробуй ще раз.",
    errNetwork: "Мережева помилка. Перевір з'єднання й спробуй ще раз.",
    agreedHeader: "Готово 🎉",
    agreedSubtitle: "Час узгоджено. Повертайся в бота — далі вже там.",
    waitingHeader: "Збережено",
    waitingSubtitle:
      "Бот напише, щойно співрозмовник відповість. Можеш закрити це вікно — я нагадаю.",
    multiOverlapHeader: "У вас обох є кілька варіантів",
    multiOverlapSubtitle: "Обери один — це й зафіксує ваше побачення.",
    emptyHint: "Познач будь-який зручний слот.",
    legendMine: "Ти",
    legendPeer: "Твій match",
    legendAlternative: "Інший час",
    legendOverlap: "Збіг",
    badgeNew: "NEW",
    noContext: "Немає контексту матчу — відкрий знову з бота.",
    locTitle: "Звідки поїдеш на побачення?",
    locSearchPlaceholder: "Метро, адреса, заклад…",
    locEmptyHint: "Введи адресу або тапни по карті.",
    locSelectedPrefix: "Обрано: ",
    locCustomPoint: "Точка на карті",
    locShareCurrent: "Поділитися геолокацією",
    locSharingCurrent: "Шукаємо геолокацію…",
    locCurrentLocation: "Моя поточна геолокація",
    locConfirm: "Підтвердити",
    locConfirming: "Зберігаємо…",
    locSaved: "Зберіг ✨ Повертайся в бота.",
    locErrInvalidCoords: "Дивні координати — спробуй ще раз.",
    locErrGeoDenied: "Доступ до геолокації відхилено. Можна ввести адресу або тапнути по карті.",
    locErrGeoUnavailable: "Не вдалося отримати поточну геолокацію. Введи адресу або тапни по карті.",
    locErrGeoTimeout: "Пошук геолокації тривав занадто довго. Спробуй ще раз або введи адресу.",
    locErrGeoUnsupported: "Геолокація недоступна в цьому браузері. Можна ввести адресу або тапнути по карті.",
    locErrMapUnavailable: "Не вдалося завантажити карту. Перевір з'єднання та спробуй ще раз.",
    verifyMiniAppLoading: "Відкриваємо верифікацію…",
    verifyMiniAppFinishing: "Готово. Перевіряємо результат…",
    verifyMiniAppError: "Не вдалося запустити перевірку. Спробуйте ще раз.",
    verifyMiniAppCloseBtn: "Закрити",
    verifyMiniAppAlreadyVerified:
      "Ти вже верифікований — тут робити нічого.",
    verifyMiniAppNotConfigured:
      "Верифікація зараз недоступна. Спробуй пізніше.",
  },
  de: {
    title: "Wähle eine Zeit für dein Date",
    titleDate: "Wähle ein Datum",
    titleTime: "Wähle eine Uhrzeit",
    titleAgreed: "Date fixiert",
    titleWaiting: "Warten auf dein Match",
    titleConfirm: "Wähle eine Option",
    bannerPeerPicked:
      "Dein Match hat diese Zeiten markiert. Tippe eine an, um direkt zuzustimmen, oder wähle deine eigene Zeit - sie wird live angezeigt.",
    bannerProposingAlternative:
      "Du hast eine andere Zeit ausgewählt. Tippe auf den Slot deines Matches, um zuzustimmen, oder sende deine Zeit als Gegenvorschlag.",
    btnSave: "Speichern",
    btnSuggestTime: "Zeit vorschlagen",
    btnSaving: "Speichern...",
    btnConfirm: "Bestätigen",
    btnBackToDates: "Zurück zu Daten",
    btnClose: "Schließen",
    btnEdit: "Auswahl ändern",
    btnRemind: "Erinnern",
    btnRemindArmed: "Wir erinnern",
    errExpired: "Dieser Kalenderlink ist abgelaufen. Öffne ihn bitte erneut aus dem Bot.",
    errMatchGone: "Wir finden dieses Match nicht mehr. Öffne den Kalender bitte erneut aus dem Bot.",
    errInvalidSlot: "Dieser Slot ist nicht mehr verfügbar. Wähle einen anderen.",
    errWrongState: "Dieses Match wartet gerade nicht auf eine Kalenderauswahl.",
    errNotParticipant: "Du bist nicht Teil dieses Matches.",
    errGeneric: "Deine Auswahl konnte nicht gespeichert werden. Versuch es erneut.",
    errNetwork: "Netzwerkfehler. Prüfe deine Verbindung und versuch es erneut.",
    agreedHeader: "Fixiert",
    agreedSubtitle: "Die Zeit ist abgestimmt. Zurück zum Bot für die nächsten Schritte.",
    waitingHeader: "Gespeichert",
    waitingSubtitle:
      "Wir pingen den Bot, sobald dein Match antwortet. Du kannst dieses Fenster schließen - wir melden uns.",
    multiOverlapHeader: "Ihr habt mehrere gemeinsame Optionen",
    multiOverlapSubtitle: "Wähle die beste Option - damit wird euer Date fixiert.",
    emptyHint: "Tippe einen Slot an, an dem du frei bist.",
    legendMine: "Du",
    legendPeer: "Match",
    legendAlternative: "Andere Zeit",
    legendOverlap: "Beide",
    badgeNew: "NEW",
    noContext: "Kein Match-Kontext - öffne das bitte erneut aus dem Bot.",
    locTitle: "Von wo kommst du zum Date?",
    locSearchPlaceholder: "Metro, Adresse, Ort...",
    locEmptyHint: "Gib eine Adresse ein oder tippe auf die Karte.",
    locSelectedPrefix: "Ausgewählt: ",
    locCustomPoint: "Eigener Punkt auf der Karte",
    locShareCurrent: "Meinen Standort teilen",
    locSharingCurrent: "Standort wird gesucht...",
    locCurrentLocation: "Mein aktueller Standort",
    locConfirm: "Bestätigen",
    locConfirming: "Speichern...",
    locSaved: "Gespeichert. Zurück zum Bot.",
    locErrInvalidCoords: "Diese Position wirkt ungültig - versuch es erneut.",
    locErrGeoDenied: "Standortzugriff wurde abgelehnt. Du kannst weiter eine Adresse eingeben oder auf die Karte tippen.",
    locErrGeoUnavailable: "Dein aktueller Standort konnte nicht gelesen werden. Gib eine Adresse ein oder tippe auf die Karte.",
    locErrGeoTimeout: "Standortsuche ist abgelaufen. Versuch es erneut oder gib eine Adresse ein.",
    locErrGeoUnsupported: "Standortfreigabe ist in diesem Browser nicht verfügbar. Du kannst eine Adresse eingeben oder auf die Karte tippen.",
    locErrMapUnavailable: "Die Karte konnte nicht geladen werden. Prüfe deine Verbindung und versuch es erneut.",
    verifyMiniAppLoading: "Verifizierung wird geöffnet...",
    verifyMiniAppFinishing: "Gleich fertig. Ergebnis wird geprüft...",
    verifyMiniAppError:
      "Verifizierung konnte nicht gestartet werden. Versuch es gleich noch mal.",
    verifyMiniAppCloseBtn: "Schließen",
    verifyMiniAppAlreadyVerified:
      "Du bist bereits verifiziert - hier gibt's nichts zu tun.",
    verifyMiniAppNotConfigured:
      "Verifizierung ist derzeit nicht verfügbar. Versuch es später noch mal.",
  },
  pl: {
    title: "Wybierz termin randki",
    titleDate: "Wybierz datę",
    titleTime: "Wybierz godzinę",
    titleAgreed: "Randka ustalona",
    titleWaiting: "Czekamy na Twoje dopasowanie",
    titleConfirm: "Wybierz jedną opcję",
    bannerPeerPicked:
      "Twoje dopasowanie zaznaczyło te terminy. Kliknij jeden, aby od razu potwierdzić, albo wybierz własny - zobaczą go na żywo.",
    bannerProposingAlternative:
      "Masz wybraną inną godzinę. Kliknij slot dopasowania, aby się zgodzić, albo wyślij swoją propozycję.",
    btnSave: "Zapisz",
    btnSuggestTime: "Zaproponuj termin",
    btnSaving: "Zapisywanie...",
    btnConfirm: "Potwierdź",
    btnBackToDates: "Wróć do dat",
    btnClose: "Zamknij",
    btnEdit: "Zmień wybór",
    btnRemind: "Przypomnij",
    btnRemindArmed: "Przypomnimy",
    errExpired: "Ten link do kalendarza wygasł. Otwórz go ponownie z bota.",
    errMatchGone: "Nie możemy już znaleźć tego dopasowania. Otwórz kalendarz ponownie z bota.",
    errInvalidSlot: "Ten slot nie jest już dostępny. Wybierz inny.",
    errWrongState: "To dopasowanie nie czeka teraz na wybór terminu.",
    errNotParticipant: "Nie jesteś częścią tego dopasowania.",
    errGeneric: "Nie udało się zapisać wyboru. Spróbuj ponownie.",
    errNetwork: "Błąd sieci. Sprawdź połączenie i spróbuj ponownie.",
    agreedHeader: "Ustalone",
    agreedSubtitle: "Termin potwierdzony. Wróć do bota po kolejne kroki.",
    waitingHeader: "Zapisano",
    waitingSubtitle:
      "Damy znać botowi, gdy Twoje dopasowanie odpowie. Możesz zamknąć to okno - odezwiemy się.",
    multiOverlapHeader: "Macie kilka wspólnych opcji",
    multiOverlapSubtitle: "Wybierz najlepszą - to ustali termin randki.",
    emptyHint: "Kliknij dowolny slot, gdy masz czas.",
    legendMine: "Ty",
    legendPeer: "Dopasowanie",
    legendAlternative: "Inny termin",
    legendOverlap: "Oboje",
    badgeNew: "NEW",
    noContext: "Brak kontekstu dopasowania - otwórz to ponownie z bota.",
    locTitle: "Skąd będziesz jechać na randkę?",
    locSearchPlaceholder: "Metro, adres, miejsce...",
    locEmptyHint: "Wpisz adres albo kliknij na mapie.",
    locSelectedPrefix: "Wybrano: ",
    locCustomPoint: "Własny punkt na mapie",
    locShareCurrent: "Udostępnij lokalizację",
    locSharingCurrent: "Szukamy lokalizacji...",
    locCurrentLocation: "Moja aktualna lokalizacja",
    locConfirm: "Potwierdź",
    locConfirming: "Zapisywanie...",
    locSaved: "Zapisano. Wróć do bota.",
    locErrInvalidCoords: "Ta lokalizacja wygląda nieprawidłowo - spróbuj ponownie.",
    locErrGeoDenied: "Odmówiono dostępu do lokalizacji. Nadal możesz wpisać adres albo kliknąć mapę.",
    locErrGeoUnavailable: "Nie udało się odczytać aktualnej lokalizacji. Wpisz adres albo kliknij mapę.",
    locErrGeoTimeout: "Wyszukiwanie lokalizacji trwało zbyt długo. Spróbuj ponownie albo wpisz adres.",
    locErrGeoUnsupported: "Udostępnianie lokalizacji nie jest dostępne w tej przeglądarce. Możesz wpisać adres albo kliknąć mapę.",
    locErrMapUnavailable: "Nie udało się załadować mapy. Sprawdź połączenie i spróbuj ponownie.",
    verifyMiniAppLoading: "Otwieramy weryfikację...",
    verifyMiniAppFinishing: "Już prawie. Sprawdzamy wynik...",
    verifyMiniAppError:
      "Nie udało się uruchomić weryfikacji. Spróbuj ponownie.",
    verifyMiniAppCloseBtn: "Zamknij",
    verifyMiniAppAlreadyVerified:
      "Jesteś już zweryfikowany - tu nie ma co robić.",
    verifyMiniAppNotConfigured:
      "Weryfikacja jest teraz niedostępna. Spróbuj później.",
  },
};

export function pickLang(raw: string | null | undefined): Lang {
  return raw === "ru" || raw === "uk" || raw === "de" || raw === "pl" ? raw : "en";
}

export function tr(lang: Lang, key: keyof Strings): string {
  return dict[lang][key];
}
