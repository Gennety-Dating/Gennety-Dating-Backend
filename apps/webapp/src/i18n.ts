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
  /**
   * The paid evening band (PRIME_TIME_PRODUCT_SPEC §7).
   *
   * The band is drawn as ONE section in the time sheet, not as N flagged rows,
   * so the copy is section-level: a header, and — while it is locked — a single
   * caption carrying the price. Neither may name how many rows are gated:
   * that count is `PRIME_TIME_SLOT_COUNT`, an env value the server can move
   * without anyone re-translating five locales.
   *
   * Both headers are rendered uppercase by CSS, so they are written in normal
   * sentence case here.
   *
   * The locked header is the bare tier name in EVERY locale, and deliberately
   * so: the crest sits immediately left of it and the caption right under it
   * already says which hours are being opened, so a translated "evening, with
   * Premium" only restates its own neighbours. One shimmering word beside the
   * mark is the whole label — and it is the same word the venue board and the
   * Premium Mini App put on this tier, which is what makes the three read as
   * one purchase.
   */
  primeBandLocked: string;
  /** Same section once the band is open — neutral, no offer left to make. */
  primeBandOpen: string;
  /** The quiet "it's yours" mark beside the open header. */
  primeBandOpenTag: string;
  /**
   * `{stars}` — the real Stars charge. The band's only paywall affordance.
   *
   * The placeholder is replaced by a NODE, not by text: our own star glyph plus
   * the number (`priceLabel` in main.ts). No locale carries the platform ⭐ —
   * it renders as Apple's art on iOS and Google's on Android, which is the one
   * thing an authored icon set exists to prevent — and none carries a separator
   * before it either: the price is a chip at the end of the line, not a second
   * clause.
   */
  primeBandCta: string;
  primeSheetTitle: string;
  primeSheetBody: string;
  /** `{stars}` — as above: an authored glyph + the number, no USD figure. */
  primeSheetCtaPay: string;
  primeSheetCtaPremium: string;
  primeSheetDismiss: string;
  primeUnlockFailed: string;
  /** Charge confirmed, settle not visible yet — never phrased as a failure. */
  primeUnlockPending: string;
  noContext: string;
  // Location Mini App (Phase 3.7 — concierge map picker)
  locTitle: string;
  locSearchPlaceholder: string;
  locEmptyHint: string;
  locSelectedPrefix: string;
  locCustomPoint: string;
  /** Departure-point gate (PRODUCT_SPEC §3.7). `{city}` = the launched market. */
  locOutsideMarket: string;
  /** Demo-only shortcut on the block card (DEMO_MODE.md). */
  locJumpToCity: string;
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
  locSearchUnavailable: string;
  // Verification Mini App (AWS Rekognition Face Liveness)
  verifyConsentTitle: string;
  verifyConsentLead: string;
  verifyConsentWhat: string;
  verifyConsentWho: string;
  verifyConsentKeep: string;
  verifyConsentRefuse: string;
  verifyConsentAgreeBtn: string;
  verifyConsentPolicyLink: string;
  verifyConsentFailed: string;
  verifyMiniAppLoading: string;
  verifyMiniAppFinishing: string;
  verifyMiniAppError: string;
  verifyMiniAppRetry: string;
  verifyMiniAppCloseBtn: string;
  verifyMiniAppAlreadyVerified: string;
  /** `/init` refused because the profile has no photos (audit A13-H11). */
  verifyMiniAppPhotosRequired: string;
  verifyMiniAppNotConfigured: string;
}

const dict: Record<Lang, Strings> = {
  en: {
    title: "Pick a time for your date",
    titleDate: "Pick a date",
    titleTime: "Pick a time",
    titleAgreed: "Your date is set",
    titleWaiting: "Waiting for your match",
    titleConfirm: "Choose one option",
    bannerPeerPicked: "Your match marked these times. Tap any one and the time is set. Or suggest your own.",
    bannerProposingAlternative: "Tap your match's option to agree, or send your own time.",
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
    agreedSubtitle: "Next step's in the chat.",
    waitingHeader: "Saved",
    waitingSubtitle: "We'll message you as soon as your match replies.",
    multiOverlapHeader: "A few times match",
    multiOverlapSubtitle: "Pick one.",
    emptyHint: "Tap any slot you're free.",
    legendMine: "You",
    legendPeer: "Match",
    legendAlternative: "Other time",
    legendOverlap: "Both",
    badgeNew: "NEW",
    primeBandLocked: "Premium",
    primeBandOpen: "Evening",
    primeBandOpenTag: "Available",
    primeBandCta: "Open the evening for you two {stars}",
    primeSheetTitle: "Evening times",
    primeSheetBody: "Late evenings are for Premium. You can open them once, for both of you.",
    primeSheetCtaPay: "Open the evening — {stars}",
    primeSheetCtaPremium: "See Gennety Premium",
    primeSheetDismiss: "Pick another time",
    primeUnlockFailed: "That didn't go through. Try again.",
    primeUnlockPending:
      "Payment received. The evening times open in a moment — no need to pay again.",
    noContext: "No match context — reopen this from the bot.",
    locTitle: "Where will you be coming from?",
    locSearchPlaceholder: "Metro, address, place…",
    locEmptyHint: "Type an address or tap on the map.",
    locSelectedPrefix: "Selected: ",
    locCustomPoint: "Custom point on map",
    locOutsideMarket:
      "Gennety only works in {city} for now. Mark the spot inside the city you'll be setting off from.",
    locJumpToCity: "Drop the pin in {city}",
    locShareCurrent: "Share my location",
    locSharingCurrent: "Locating…",
    locCurrentLocation: "My current location",
    locConfirm: "Confirm",
    locConfirming: "Saving…",
    locSaved: "Saved ✨ Heading back to the bot.",
    locErrInvalidCoords: "Couldn't pin down that spot — try again.",
    locErrGeoDenied: "Location permission was denied. You can still type an address or tap the map.",
    locErrGeoUnavailable: "Couldn't read your current location. Try typing an address or tapping the map.",
    locErrGeoTimeout: "Location lookup timed out. Try again, or type an address.",
    locErrGeoUnsupported: "Location sharing isn't available in this browser. You can still type an address or tap the map.",
    locErrMapUnavailable: "The map couldn't load. Check your connection and try again.",
    locSearchUnavailable: "Search is unavailable right now — tap the map to drop your pin.",
    verifyConsentTitle: "Let's check it's you",
    verifyConsentLead:
      "This check records a short video of your face. That is biometric data, so we need your explicit permission first.",
    verifyConsentWhat:
      "What happens: you follow an on-screen prompt while your camera records a few seconds. One still frame from it is compared against your profile photos to confirm they are you.",
    verifyConsentWho:
      "Who processes it: the video streams from your device straight to Amazon Web Services in the EU — it never passes through our servers. We keep only the single still frame.",
    verifyConsentKeep:
      "How long: we delete that frame 90 days after you are verified. You stay verified.",
    verifyConsentRefuse:
      "If you would rather not: close this screen. You will not be matched, and you can delete your account at any time.",
    verifyConsentAgreeBtn: "I agree — start the check",
    verifyConsentPolicyLink: "Read the full Privacy Policy",
    verifyConsentFailed: "Couldn't save your consent. Try again.",
    verifyMiniAppLoading: "Opening verification…",
    verifyMiniAppFinishing: "Almost done. Checking results…",
    verifyMiniAppError: "Couldn't start verification. Try again.",
    verifyMiniAppRetry:
      "Couldn't quite confirm it's you. Nothing lost — tap Verify in the chat and try once more.",
    verifyMiniAppCloseBtn: "Close",
    verifyMiniAppAlreadyVerified:
      "You're already verified — nothing to do here.",
    verifyMiniAppPhotosRequired:
      "Add photos of yourself first — the check compares your selfie with them. The button is waiting in the chat.",
    verifyMiniAppNotConfigured:
      "Verification isn't available right now. Try again a bit later.",
  },
  ru: {
    title: "Выбери время для свидания",
    titleDate: "Выбери дату",
    titleTime: "Выбери время",
    titleAgreed: "Свидание назначено",
    titleWaiting: "Ждём твою пару",
    titleConfirm: "Выбери один вариант",
    bannerPeerPicked: "Пара отметила эти варианты. Нажми любой — и время назначено. Или предложи своё.",
    bannerProposingAlternative: "Нажми вариант пары, чтобы согласиться, или отправь своё время.",
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
    errMatchGone: "Не нашли этот мэтч. Открой календарь заново из бота.",
    errInvalidSlot: "Этот слот больше недоступен. Выбери другой.",
    errWrongState: "Этот мэтч сейчас не ждёт выбора времени.",
    errNotParticipant: "Ты не участник этого мэтча.",
    errGeneric: "Не удалось сохранить выбор. Попробуй ещё раз.",
    errNetwork: "Сетевая ошибка. Проверь соединение и попробуй ещё раз.",
    agreedHeader: "Готово 🎉",
    agreedSubtitle: "Дальше — в чате.",
    waitingHeader: "Сохранено",
    waitingSubtitle: "Напишем, как только пара ответит.",
    multiOverlapHeader: "Совпало несколько вариантов",
    multiOverlapSubtitle: "Выбери один.",
    emptyHint: "Отметь любой удобный слот.",
    legendMine: "Ты",
    legendPeer: "Пара",
    legendAlternative: "Другое время",
    legendOverlap: "Совпало",
    badgeNew: "NEW",
    primeBandLocked: "Premium",
    primeBandOpen: "Вечер",
    primeBandOpenTag: "Доступно",
    primeBandCta: "Открыть вечер для вас двоих {stars}",
    primeSheetTitle: "Вечернее время",
    primeSheetBody: "Поздние вечера — для Premium. Можно открыть их разово, сразу для вас двоих.",
    primeSheetCtaPay: "Открыть вечер — {stars}",
    primeSheetCtaPremium: "Посмотреть Gennety Premium",
    primeSheetDismiss: "Выбрать другое время",
    primeUnlockFailed: "Не прошло. Попробуй ещё раз.",
    primeUnlockPending:
      "Оплата прошла. Вечерние слоты откроются через несколько секунд — платить ещё раз не нужно.",
    noContext: "Нет контекста мэтча — открой заново из бота.",
    locTitle: "Откуда поедешь на свидание?",
    locSearchPlaceholder: "Метро, адрес, заведение…",
    locEmptyHint: "Введи адрес или тапни по карте.",
    locSelectedPrefix: "Выбрано: ",
    locCustomPoint: "Точка на карте",
    locOutsideMarket:
      "Gennety пока работает только в {city}. Отметь точку внутри города, откуда будешь выезжать.",
    locJumpToCity: "Поставить точку в {city}",
    locShareCurrent: "Поделиться геолокацией",
    locSharingCurrent: "Ищем геолокацию…",
    locCurrentLocation: "Моя текущая геолокация",
    locConfirm: "Подтвердить",
    locConfirming: "Сохраняем…",
    locSaved: "Сохранено ✨ Возвращайся в бота.",
    locErrInvalidCoords: "Не получилось определить точку — попробуй ещё раз.",
    locErrGeoDenied: "Доступ к геолокации отклонён. Можно ввести адрес или тапнуть по карте.",
    locErrGeoUnavailable: "Не удалось получить текущую геолокацию. Введи адрес или тапни по карте.",
    locErrGeoTimeout: "Поиск геолокации занял слишком много времени. Попробуй ещё раз или введи адрес.",
    locErrGeoUnsupported: "Геолокация недоступна в этом браузере. Можно ввести адрес или тапнуть по карте.",
    locErrMapUnavailable: "Не удалось загрузить карту. Проверь соединение и попробуй ещё раз.",
    locSearchUnavailable: "Поиск сейчас недоступен — поставь точку на карте.",
    verifyConsentTitle: "Проверим, что это ты",
    verifyConsentLead:
      "Проверка записывает короткое видео твоего лица. Это биометрические данные, поэтому нам нужно твоё явное согласие.",
    verifyConsentWhat:
      "Что произойдёт: ты выполнишь подсказку на экране, пока камера снимает несколько секунд. Один кадр из этого видео сравнивается с фотографиями в профиле, чтобы подтвердить, что это ты.",
    verifyConsentWho:
      "Кто обрабатывает: видео идёт с твоего устройства напрямую в Amazon Web Services в ЕС — оно не проходит через наши серверы. Мы храним только один кадр.",
    verifyConsentKeep:
      "Сколько хранится: мы удаляем этот кадр через 90 дней после верификации. Статус «проверен» при этом остаётся.",
    verifyConsentRefuse:
      "Если не хочешь: просто закрой этот экран. Подбор пар не начнётся, и аккаунт можно удалить в любой момент.",
    verifyConsentAgreeBtn: "Даю согласие — начать проверку",
    verifyConsentPolicyLink: "Полная политика конфиденциальности",
    verifyConsentFailed: "Не удалось сохранить согласие. Попробуй ещё раз.",
    verifyMiniAppLoading: "Открываем верификацию…",
    verifyMiniAppFinishing: "Готово. Проверяем результат…",
    verifyMiniAppError: "Не удалось запустить проверку. Попробуй ещё раз.",
    verifyMiniAppRetry:
      "Не получилось убедиться, что это ты. Ничего страшного — нажми «Пройти верификацию» в чате и попробуй ещё раз.",
    verifyMiniAppCloseBtn: "Закрыть",
    verifyMiniAppAlreadyVerified: "Проверка уже пройдена — здесь делать нечего.",
    verifyMiniAppPhotosRequired:
      "Сначала добавь свои фото — проверка сравнивает с ними селфи. Кнопка уже ждёт в чате.",
    verifyMiniAppNotConfigured:
      "Верификация сейчас недоступна. Попробуй позже.",
  },
  uk: {
    title: "Обери час для побачення",
    titleDate: "Обери дату",
    titleTime: "Обери час",
    titleAgreed: "Побачення призначено",
    titleWaiting: "Чекаємо на твою пару",
    titleConfirm: "Обери один варіант",
    bannerPeerPicked:
      "Пара позначила ці варіанти. Натисни будь-який — і час призначено. Або запропонуй свій.",
    bannerProposingAlternative: "Натисни варіант пари, щоб погодитись, або надішли свій час.",
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
    errMatchGone: "Не знайшли цей метч. Відкрий календар знову з бота.",
    errInvalidSlot: "Цей слот уже недоступний. Обери інший.",
    errWrongState: "Цей метч зараз не чекає вибору часу.",
    errNotParticipant: "Ти не учасник цього метчу.",
    errGeneric: "Не вдалося зберегти вибір. Спробуй ще раз.",
    errNetwork: "Мережева помилка. Перевір з'єднання й спробуй ще раз.",
    agreedHeader: "Готово 🎉",
    agreedSubtitle: "Далі — в чаті.",
    waitingHeader: "Збережено",
    waitingSubtitle: "Напишемо, щойно пара відповість.",
    multiOverlapHeader: "Збіглося кілька варіантів",
    multiOverlapSubtitle: "Обери один.",
    emptyHint: "Познач будь-який зручний слот.",
    legendMine: "Ти",
    legendPeer: "Пара",
    legendAlternative: "Інший час",
    legendOverlap: "Збіг",
    badgeNew: "NEW",
    primeBandLocked: "Premium",
    primeBandOpen: "Вечір",
    primeBandOpenTag: "Доступно",
    primeBandCta: "Відкрити вечір для вас двох {stars}",
    primeSheetTitle: "Вечірній час",
    primeSheetBody: "Пізні вечори — для Premium. Можна відкрити їх разово, одразу для вас двох.",
    primeSheetCtaPay: "Відкрити вечір — {stars}",
    primeSheetCtaPremium: "Переглянути Gennety Premium",
    primeSheetDismiss: "Обрати інший час",
    primeUnlockFailed: "Не вийшло. Спробуй ще раз.",
    primeUnlockPending:
      "Оплата пройшла. Вечірні слоти відкриються за кілька секунд — платити ще раз не треба.",
    noContext: "Немає контексту метчу — відкрий знову з бота.",
    locTitle: "Звідки поїдеш на побачення?",
    locSearchPlaceholder: "Метро, адреса, заклад…",
    locEmptyHint: "Введи адресу або тапни по карті.",
    locSelectedPrefix: "Обрано: ",
    locCustomPoint: "Точка на карті",
    locOutsideMarket:
      "Gennety поки працює лише в {city}. Познач точку всередині міста, звідки будеш виїжджати.",
    locJumpToCity: "Поставити точку в {city}",
    locShareCurrent: "Поділитися геолокацією",
    locSharingCurrent: "Шукаємо геолокацію…",
    locCurrentLocation: "Моя поточна геолокація",
    locConfirm: "Підтвердити",
    locConfirming: "Зберігаємо…",
    locSaved: "Збережено ✨ Повертайся в бота.",
    locErrInvalidCoords: "Не вдалося визначити точку — спробуй ще раз.",
    locErrGeoDenied: "Доступ до геолокації відхилено. Можна ввести адресу або тапнути по карті.",
    locErrGeoUnavailable: "Не вдалося отримати поточну геолокацію. Введи адресу або тапни по карті.",
    locErrGeoTimeout: "Пошук геолокації тривав занадто довго. Спробуй ще раз або введи адресу.",
    locErrGeoUnsupported: "Геолокація недоступна в цьому браузері. Можна ввести адресу або тапнути по карті.",
    locErrMapUnavailable: "Не вдалося завантажити карту. Перевір з'єднання та спробуй ще раз.",
    locSearchUnavailable: "Пошук зараз недоступний — постав точку на карті.",
    verifyConsentTitle: "Перевіримо, що це ти",
    verifyConsentLead:
      "Перевірка записує коротке відео твого обличчя. Це біометричні дані, тому нам потрібна твоя явна згода.",
    verifyConsentWhat:
      "Що відбудеться: ти виконаєш підказку на екрані, поки камера знімає кілька секунд. Один кадр із цього відео порівнюється з фото у профілі, щоб підтвердити, що це ти.",
    verifyConsentWho:
      "Хто обробляє: відео йде з твого пристрою напряму в Amazon Web Services у ЄС — воно не проходить через наші сервери. Ми зберігаємо лише один кадр.",
    verifyConsentKeep:
      "Скільки зберігається: ми видаляємо цей кадр через 90 днів після верифікації. Статус «перевірено» залишається.",
    verifyConsentRefuse:
      "Якщо не хочеш: просто закрий цей екран. Підбір пар не почнеться, і акаунт можна видалити будь-коли.",
    verifyConsentAgreeBtn: "Погоджуюсь — почати перевірку",
    verifyConsentPolicyLink: "Повна політика конфіденційності",
    verifyConsentFailed: "Не вдалося зберегти згоду. Спробуй ще раз.",
    verifyMiniAppLoading: "Відкриваємо верифікацію…",
    verifyMiniAppFinishing: "Готово. Перевіряємо результат…",
    verifyMiniAppError: "Не вдалося запустити перевірку. Спробуй ще раз.",
    verifyMiniAppRetry:
      "Не вдалося переконатися, що це ти. Нічого страшного — натисни «Пройти верифікацію» в чаті й спробуй ще раз.",
    verifyMiniAppCloseBtn: "Закрити",
    verifyMiniAppAlreadyVerified: "Перевірку вже пройдено — тут робити нічого.",
    verifyMiniAppPhotosRequired:
      "Спершу додай свої фото — перевірка порівнює з ними селфі. Кнопка вже чекає в чаті.",
    verifyMiniAppNotConfigured:
      "Верифікація зараз недоступна. Спробуй пізніше.",
  },
  de: {
    title: "Wähle eine Zeit für dein Date",
    titleDate: "Wähle ein Datum",
    titleTime: "Wähle eine Uhrzeit",
    titleAgreed: "Euer Date steht",
    titleWaiting: "Warten auf dein Match",
    titleConfirm: "Wähle eine Option",
    bannerPeerPicked:
      "Dein Match hat diese Zeiten markiert. Tipp eine an, und die Zeit steht. Oder schlag deine eigene vor.",
    bannerProposingAlternative:
      "Tipp die Option deines Matches an, um zuzustimmen, oder schick deine eigene Zeit.",
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
    agreedSubtitle: "Weiter geht's im Chat.",
    waitingHeader: "Gespeichert",
    waitingSubtitle: "Wir schreiben dir, sobald dein Match antwortet.",
    multiOverlapHeader: "Mehrere Zeiten passen",
    multiOverlapSubtitle: "Wähl eine aus.",
    emptyHint: "Tippe einen Slot an, an dem du frei bist.",
    legendMine: "Du",
    legendPeer: "Match",
    legendAlternative: "Andere Zeit",
    legendOverlap: "Beide",
    badgeNew: "NEW",
    primeBandLocked: "Premium",
    primeBandOpen: "Abend",
    primeBandOpenTag: "Verfügbar",
    primeBandCta: "Den Abend für euch beide öffnen {stars}",
    primeSheetTitle: "Abendzeiten",
    primeSheetBody: "Späte Abende sind für Premium. Du kannst sie einmalig öffnen, für euch beide.",
    primeSheetCtaPay: "Abend öffnen — {stars}",
    primeSheetCtaPremium: "Gennety Premium ansehen",
    primeSheetDismiss: "Andere Zeit wählen",
    primeUnlockFailed: "Hat nicht geklappt. Versuch es noch mal.",
    primeUnlockPending:
      "Zahlung eingegangen. Die Abendzeiten öffnen gleich — du musst nicht noch mal zahlen.",
    noContext: "Kein Match-Kontext - öffne das bitte erneut aus dem Bot.",
    locTitle: "Von wo kommst du zum Date?",
    locSearchPlaceholder: "Metro, Adresse, Ort...",
    locEmptyHint: "Gib eine Adresse ein oder tippe auf die Karte.",
    locSelectedPrefix: "Ausgewählt: ",
    locCustomPoint: "Eigener Punkt auf der Karte",
    locOutsideMarket:
      "Gennety ist vorerst nur in {city} aktiv. Markiere den Punkt innerhalb der Stadt, von dem du losfährst.",
    locJumpToCity: "Punkt in {city} setzen",
    locShareCurrent: "Meinen Standort teilen",
    locSharingCurrent: "Standort wird gesucht...",
    locCurrentLocation: "Mein aktueller Standort",
    locConfirm: "Bestätigen",
    locConfirming: "Speichern...",
    locSaved: "Gespeichert. Zurück zum Bot.",
    locErrInvalidCoords: "Der Punkt ließ sich nicht bestimmen — versuch es erneut.",
    locErrGeoDenied: "Standortzugriff wurde abgelehnt. Du kannst weiter eine Adresse eingeben oder auf die Karte tippen.",
    locErrGeoUnavailable: "Dein aktueller Standort konnte nicht gelesen werden. Gib eine Adresse ein oder tippe auf die Karte.",
    locErrGeoTimeout: "Standortsuche ist abgelaufen. Versuch es erneut oder gib eine Adresse ein.",
    locErrGeoUnsupported: "Standortfreigabe ist in diesem Browser nicht verfügbar. Du kannst eine Adresse eingeben oder auf die Karte tippen.",
    locErrMapUnavailable: "Die Karte konnte nicht geladen werden. Prüfe deine Verbindung und versuch es erneut.",
    locSearchUnavailable: "Die Suche ist gerade nicht verfügbar — tippe auf die Karte, um deinen Punkt zu setzen.",
    verifyConsentTitle: "Prüfen wir, ob du es bist",
    verifyConsentLead:
      "Diese Prüfung nimmt ein kurzes Video deines Gesichts auf. Das sind biometrische Daten, deshalb brauchen wir vorher deine ausdrückliche Einwilligung.",
    verifyConsentWhat:
      "Was passiert: Du folgst einer Anweisung auf dem Bildschirm, während die Kamera ein paar Sekunden aufnimmt. Ein Einzelbild daraus wird mit deinen Profilfotos verglichen, um zu bestätigen, dass du es bist.",
    verifyConsentWho:
      "Wer verarbeitet: Das Video geht von deinem Gerät direkt an Amazon Web Services in der EU — es läuft nie über unsere Server. Wir speichern nur das eine Einzelbild.",
    verifyConsentKeep:
      "Wie lange: Wir löschen dieses Bild 90 Tage nach deiner Verifizierung. Verifiziert bleibst du.",
    verifyConsentRefuse:
      "Wenn du lieber nicht möchtest: Schließ diesen Bildschirm. Du wirst nicht gematcht und kannst dein Konto jederzeit löschen.",
    verifyConsentAgreeBtn: "Ich stimme zu — Prüfung starten",
    verifyConsentPolicyLink: "Vollständige Datenschutzerklärung",
    verifyConsentFailed: "Einwilligung konnte nicht gespeichert werden. Versuch es nochmal.",
    verifyMiniAppLoading: "Verifizierung wird geöffnet...",
    verifyMiniAppFinishing: "Gleich fertig. Ergebnis wird geprüft...",
    verifyMiniAppError:
      "Verifizierung konnte nicht gestartet werden. Versuch es gleich noch mal.",
    verifyMiniAppRetry:
      "Wir konnten nicht ganz bestätigen, dass du es bist. Nichts verloren - tippe im Chat auf Verifizieren und versuch es noch einmal.",
    verifyMiniAppCloseBtn: "Schließen",
    verifyMiniAppAlreadyVerified:
      "Du bist bereits verifiziert - hier gibt's nichts zu tun.",
    verifyMiniAppPhotosRequired:
      "Füge zuerst Fotos von dir hinzu - die Prüfung vergleicht dein Selfie mit ihnen. Der Button wartet schon im Chat.",
    verifyMiniAppNotConfigured:
      "Verifizierung ist derzeit nicht verfügbar. Versuch es später noch mal.",
  },
  pl: {
    title: "Wybierz termin randki",
    titleDate: "Wybierz datę",
    titleTime: "Wybierz godzinę",
    titleAgreed: "Randka umówiona",
    titleWaiting: "Czekamy na twoją parę",
    titleConfirm: "Wybierz jedną opcję",
    bannerPeerPicked:
      "Twoja para zaznaczyła te terminy. Kliknij dowolny — i termin ustalony. Albo zaproponuj własny.",
    bannerProposingAlternative: "Kliknij termin swojej pary, żeby się zgodzić, albo wyślij swój.",
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
    agreedSubtitle: "Dalej — na czacie.",
    waitingHeader: "Zapisano",
    waitingSubtitle: "Napiszemy, gdy tylko twoja para odpowie.",
    multiOverlapHeader: "Pasuje kilka terminów",
    multiOverlapSubtitle: "Wybierz jeden.",
    emptyHint: "Kliknij dowolny slot, gdy masz czas.",
    legendMine: "Ty",
    legendPeer: "Para",
    legendAlternative: "Inny termin",
    legendOverlap: "Oboje",
    badgeNew: "NEW",
    primeBandLocked: "Premium",
    primeBandOpen: "Wieczór",
    primeBandOpenTag: "Dostępne",
    primeBandCta: "Otwórz wieczór dla was dwojga {stars}",
    primeSheetTitle: "Wieczorne godziny",
    primeSheetBody: "Późne wieczory są dla Premium. Możesz je otworzyć jednorazowo, od razu dla was obojga.",
    primeSheetCtaPay: "Otwórz wieczór — {stars}",
    primeSheetCtaPremium: "Zobacz Gennety Premium",
    primeSheetDismiss: "Wybierz inną godzinę",
    primeUnlockFailed: "Nie udało się. Spróbuj jeszcze raz.",
    primeUnlockPending:
      "Płatność przeszła. Wieczorne godziny otworzą się za chwilę — nie trzeba płacić ponownie.",
    noContext: "Brak kontekstu dopasowania - otwórz to ponownie z bota.",
    locTitle: "Skąd będziesz jechać na randkę?",
    locSearchPlaceholder: "Metro, adres, miejsce...",
    locEmptyHint: "Wpisz adres albo kliknij na mapie.",
    locSelectedPrefix: "Wybrano: ",
    locCustomPoint: "Własny punkt na mapie",
    locOutsideMarket:
      "Gennety działa na razie tylko w {city}. Zaznacz punkt w granicach miasta, z którego wyruszysz.",
    locJumpToCity: "Zaznacz punkt w {city}",
    locShareCurrent: "Udostępnij lokalizację",
    locSharingCurrent: "Szukamy lokalizacji...",
    locCurrentLocation: "Moja aktualna lokalizacja",
    locConfirm: "Potwierdź",
    locConfirming: "Zapisywanie...",
    locSaved: "Zapisano. Wróć do bota.",
    locErrInvalidCoords: "Nie udało się ustalić punktu — spróbuj ponownie.",
    locErrGeoDenied: "Odmówiono dostępu do lokalizacji. Nadal możesz wpisać adres albo kliknąć mapę.",
    locErrGeoUnavailable: "Nie udało się odczytać aktualnej lokalizacji. Wpisz adres albo kliknij mapę.",
    locErrGeoTimeout: "Wyszukiwanie lokalizacji trwało zbyt długo. Spróbuj ponownie albo wpisz adres.",
    locErrGeoUnsupported: "Udostępnianie lokalizacji nie jest dostępne w tej przeglądarce. Możesz wpisać adres albo kliknąć mapę.",
    locErrMapUnavailable: "Nie udało się załadować mapy. Sprawdź połączenie i spróbuj ponownie.",
    locSearchUnavailable: "Wyszukiwarka jest teraz niedostępna — dotknij mapy, aby postawić punkt.",
    verifyConsentTitle: "Sprawdźmy, czy to ty",
    verifyConsentLead:
      "Ta weryfikacja nagrywa krótkie wideo twojej twarzy. To dane biometryczne, więc najpierw potrzebujemy twojej wyraźnej zgody.",
    verifyConsentWhat:
      "Co się stanie: wykonasz polecenie z ekranu, podczas gdy kamera nagra kilka sekund. Jedna klatka z tego nagrania zostanie porównana ze zdjęciami w profilu, żeby potwierdzić, że to ty.",
    verifyConsentWho:
      "Kto przetwarza: wideo idzie z twojego urządzenia prosto do Amazon Web Services w UE — nigdy nie przechodzi przez nasze serwery. Przechowujemy tylko tę jedną klatkę.",
    verifyConsentKeep:
      "Jak długo: usuwamy tę klatkę 90 dni po weryfikacji. Status zweryfikowanego zostaje.",
    verifyConsentRefuse:
      "Jeśli wolisz nie: zamknij ten ekran. Nie zostaniesz dopasowany i możesz usunąć konto w dowolnym momencie.",
    verifyConsentAgreeBtn: "Zgadzam się — zacznij weryfikację",
    verifyConsentPolicyLink: "Pełna polityka prywatności",
    verifyConsentFailed: "Nie udało się zapisać zgody. Spróbuj ponownie.",
    verifyMiniAppLoading: "Otwieramy weryfikację...",
    verifyMiniAppFinishing: "Już prawie. Sprawdzamy wynik...",
    verifyMiniAppError:
      "Nie udało się uruchomić weryfikacji. Spróbuj ponownie.",
    verifyMiniAppRetry:
      "Nie udało się do końca potwierdzić, że to ty. Nic straconego - kliknij Zweryfikuj na czacie i spróbuj jeszcze raz.",
    verifyMiniAppCloseBtn: "Zamknij",
    verifyMiniAppAlreadyVerified: "Weryfikacja już zaliczona — tu nie ma co robić.",
    verifyMiniAppPhotosRequired:
      "Najpierw dodaj swoje zdjęcia - kontrola porównuje z nimi selfie. Przycisk czeka już na czacie.",
    verifyMiniAppNotConfigured:
      "Weryfikacja jest teraz niedostępna. Spróbuj później.",
  },
};

export function pickLang(raw: string | null | undefined): Lang {
  return raw === "ru" || raw === "uk" || raw === "de" || raw === "pl" ? raw : "en";
}

/** Russian/Ukrainian/Polish plural selection (1 → one, 2-4 → few, else → many). */
function slavicPlural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/**
 * Polish plural selection. Unlike Russian/Ukrainian, only exactly 1 takes the
 * singular — 21, 31… take the "many" form ("21 biletów", not "21 bilet").
 */
function polishPlural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Fully declined "{count} {unit}" phrase for Date Tickets (e.g. "1 date
 * ticket" vs "2 date tickets", "1 билет на свидание" vs "2 билета…" vs
 * "5 билетов…") — used by the referral invite screen, where the whole word is
 * spelled out and a flat `{tickets}` placeholder can't express plural rules on
 * its own. (It replaced a months helper when referrals stopped granting
 * Premium, 2026-09-22.)
 */
export function ticketsPhrase(lang: Lang, tickets: number): string {
  switch (lang) {
    case "de":
      return `${tickets} Date-Ticket${tickets === 1 ? "" : "s"}`;
    case "ru":
      return `${tickets} ${slavicPlural(tickets, "билет", "билета", "билетов")} на свидание`;
    case "uk":
      return `${tickets} ${slavicPlural(tickets, "квиток", "квитки", "квитків")} на побачення`;
    case "pl":
      return `${tickets} ${polishPlural(tickets, "bilet", "bilety", "biletów")} na randkę`;
    default:
      return `${tickets} date ticket${tickets === 1 ? "" : "s"}`;
  }
}

export function tr(lang: Lang, key: keyof Strings): string {
  return dict[lang][key];
}
