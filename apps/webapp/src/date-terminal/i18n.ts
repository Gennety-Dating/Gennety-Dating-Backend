/**
 * Copy for the Date Terminal (Contact Sync).
 *
 * Inlined like every other Mini App here — `apps/webapp` deliberately does not
 * depend on `@gennety/shared`. Held to the two product-wide voice rules the
 * canvas table states: the bot refers to ITSELF in the masculine where the
 * language inflects it («поймал», «впіймав»), and it says «ты» to the user —
 * «вы» only where it genuinely means the two of them («тряхните вместе»).
 * "Date Terminal" and "Contact Sync" are product names and stay in English.
 */

export type Lang = "en" | "ru" | "uk" | "de" | "pl";

export interface TerminalStrings {
  kicker: string;
  loading: string;
  /** `{time}` — the date's own time. */
  titleEarly: string;
  titleApproach: string;
  titleReady: string;
  titleArmed: string;
  titleSynced: string;
  titleClosed: string;
  titleNoVenue: string;
  /** `{time}` — when the sync opens; `{radius}` — the geofence in metres. */
  subEarly: string;
  subApproach: string;
  subReady: string;
  subArmed: string;
  /** This phone's shake is in; the other one's is not (yet, or not in time). */
  subWaiting: string;
  subSynced: string;
  subClosed: string;
  subNoVenue: string;
  /** The radar row's label. `{venue}` — the venue's name. */
  arrival: string;
  arrivalFallback: string;
  metres: string;
  kilometres: string;
  locating: string;
  inRange: string;
  geoDenied: string;
  geoUnavailable: string;
  motionDenied: string;
  motionUnsupported: string;
  /** The SERVER refused the shake as too far — said with its own radius. */
  tooFar: string;
  tooEarly: string;
  offline: string;
  activate: string;
  locked: string;
  retryLocation: string;
  openMap: string;
  close: string;
  deckLoading: string;
  /** The stub's printed field name — the part torn off at the door. */
  stubLabel: string;
}

const en: TerminalStrings = {
  kicker: "Date Terminal",
  loading: "Opening the terminal…",
  titleEarly: "Your date is at {time}",
  titleApproach: "Head to the place",
  titleReady: "You're here",
  titleArmed: "Shake together",
  titleSynced: "Contact Sync ✓",
  titleClosed: "This terminal is closed",
  titleNoVenue: "Contact Sync is off",
  subEarly: "Contact Sync opens at {time}, within {radius} m of the place.",
  subApproach: "Contact Sync unlocks within {radius} m of the place.",
  subReady: "Turn on Contact Sync, then shake your phones together.",
  subArmed: "Hold both phones and shake them at the same moment.",
  subWaiting: "Got yours. Now shake together with the other phone.",
  subSynced: "The date's on me — your next ticket is free. Something to talk about:",
  subClosed: "It opens on the day of a date. Your chat has the details.",
  subNoVenue: "I can't pin this date's place precisely, so there's nothing to sync against.",
  arrival: "Arrival at {venue}",
  arrivalFallback: "Arrival at the place",
  metres: "{n} m",
  kilometres: "{n} km",
  locating: "Finding you…",
  inRange: "You're within {radius} m",
  geoDenied: "I need your location to open Contact Sync — allow it and try again.",
  geoUnavailable: "Your phone isn't giving me a location yet. Step outside for a moment.",
  motionDenied: "I need motion access for this — allow it in your browser settings.",
  motionUnsupported: "This phone can't feel a shake. The date is still on — enjoy it.",
  tooFar: "The server sees you more than {radius} m from the place. Get a little closer and shake again.",
  tooEarly: "Not yet — Contact Sync opens at {time}.",
  offline: "Can't reach me right now. Trying again.",
  activate: "Turn on Contact Sync",
  locked: "Contact Sync locked",
  retryLocation: "Allow location",
  openMap: "Map",
  close: "Close",
  deckLoading: "Dealing your cards…",
  stubLabel: "Admit",
};

const ru: TerminalStrings = {
  kicker: "Date Terminal",
  loading: "Открываю терминал…",
  titleEarly: "Свидание в {time}",
  titleApproach: "Иди к месту",
  titleReady: "Ты на месте",
  titleArmed: "Тряхните вместе",
  titleSynced: "Contact Sync ✓",
  titleClosed: "Терминал закрыт",
  titleNoVenue: "Contact Sync выключен",
  subEarly: "Contact Sync откроется в {time}, в радиусе {radius} м от места.",
  subApproach: "Contact Sync разблокируется в радиусе {radius} м от места.",
  subReady: "Включи Contact Sync — и тряхните телефоны вместе.",
  subArmed: "Возьмите оба телефона и тряхните их одновременно.",
  subWaiting: "Твоё поймал. Теперь тряхните вместе со вторым телефоном.",
  subSynced: "Свидание засчитано, билет на следующее — от меня. О чём поговорить:",
  subClosed: "Он открывается в день свидания. Все детали — в чате.",
  subNoVenue: "Не могу точно отметить место этого свидания, так что синхронизировать не с чем.",
  arrival: "Прибытие в «{venue}»",
  arrivalFallback: "Прибытие на место",
  metres: "{n} м",
  kilometres: "{n} км",
  locating: "Ищу тебя…",
  inRange: "Ты в радиусе {radius} м",
  geoDenied: "Мне нужна твоя геолокация, чтобы открыть Contact Sync — разреши её и попробуй ещё раз.",
  geoUnavailable: "Телефон пока не отдаёт геолокацию. Выйди на секунду на открытое место.",
  motionDenied: "Нужен доступ к движению — разреши его в настройках браузера.",
  motionUnsupported: "Этот телефон не чувствует тряску. Свидание от этого не хуже — наслаждайся.",
  tooFar: "Сервер видит тебя дальше {radius} м от места. Подойди чуть ближе и тряхни ещё раз.",
  tooEarly: "Ещё рано — Contact Sync откроется в {time}.",
  offline: "Не достучаться до меня. Пробую снова.",
  activate: "Включить Contact Sync",
  locked: "Contact Sync заблокирован",
  retryLocation: "Разрешить геолокацию",
  openMap: "Карта",
  close: "Закрыть",
  deckLoading: "Раздаю карточки…",
  stubLabel: "Вход",
};

const uk: TerminalStrings = {
  kicker: "Date Terminal",
  loading: "Відкриваю термінал…",
  titleEarly: "Побачення о {time}",
  titleApproach: "Прямуй до місця",
  titleReady: "Ти на місці",
  titleArmed: "Струсіть разом",
  titleSynced: "Contact Sync ✓",
  titleClosed: "Термінал закрито",
  titleNoVenue: "Contact Sync вимкнено",
  subEarly: "Contact Sync відкриється о {time}, у радіусі {radius} м від місця.",
  subApproach: "Contact Sync розблокується у радіусі {radius} м від місця.",
  subReady: "Увімкни Contact Sync — і струсіть телефони разом.",
  subArmed: "Візьміть обидва телефони й струсіть їх одночасно.",
  subWaiting: "Твоє впіймав. Тепер струсіть разом із другим телефоном.",
  subSynced: "Побачення зараховано, квиток на наступне — від мене. Про що поговорити:",
  subClosed: "Він відкривається в день побачення. Усі деталі — в чаті.",
  subNoVenue: "Не можу точно позначити місце цього побачення, тож синхронізувати нема з чим.",
  arrival: "Прибуття до «{venue}»",
  arrivalFallback: "Прибуття на місце",
  metres: "{n} м",
  kilometres: "{n} км",
  locating: "Шукаю тебе…",
  inRange: "Ти в радіусі {radius} м",
  geoDenied: "Мені потрібна твоя геолокація, щоб відкрити Contact Sync — дозволь її і спробуй ще раз.",
  geoUnavailable: "Телефон поки не віддає геолокацію. Вийди на секунду на відкрите місце.",
  motionDenied: "Потрібен доступ до руху — дозволь його в налаштуваннях браузера.",
  motionUnsupported: "Цей телефон не відчуває струсу. Побачення від цього не гірше — насолоджуйся.",
  tooFar: "Сервер бачить тебе далі ніж за {radius} м від місця. Підійди трохи ближче і струсни ще раз.",
  tooEarly: "Ще зарано — Contact Sync відкриється о {time}.",
  offline: "Не достукатися до мене. Пробую знову.",
  activate: "Увімкнути Contact Sync",
  locked: "Contact Sync заблоковано",
  retryLocation: "Дозволити геолокацію",
  openMap: "Мапа",
  close: "Закрити",
  deckLoading: "Роздаю картки…",
  stubLabel: "Вхід",
};

const de: TerminalStrings = {
  kicker: "Date Terminal",
  loading: "Terminal wird geöffnet…",
  titleEarly: "Dein Date um {time}",
  titleApproach: "Auf zum Treffpunkt",
  titleReady: "Du bist da",
  titleArmed: "Gemeinsam schütteln",
  titleSynced: "Contact Sync ✓",
  titleClosed: "Dieses Terminal ist geschlossen",
  titleNoVenue: "Contact Sync ist aus",
  subEarly: "Contact Sync öffnet um {time}, im Umkreis von {radius} m um den Ort.",
  subApproach: "Contact Sync wird im Umkreis von {radius} m um den Ort freigeschaltet.",
  subReady: "Schalte Contact Sync ein — dann schüttelt eure Handys gemeinsam.",
  subArmed: "Nehmt beide Handys und schüttelt sie im selben Moment.",
  subWaiting: "Deins habe ich. Jetzt gemeinsam mit dem anderen Handy schütteln.",
  subSynced: "Das Date geht auf mich — dein nächstes Ticket ist frei. Worüber ihr reden könnt:",
  subClosed: "Es öffnet sich am Tag eines Dates. Alle Details stehen im Chat.",
  subNoVenue: "Ich kann den Ort dieses Dates nicht genau verorten, also gibt es nichts zu synchronisieren.",
  arrival: "Ankunft bei „{venue}“",
  arrivalFallback: "Ankunft am Ort",
  metres: "{n} m",
  kilometres: "{n} km",
  locating: "Ich suche dich…",
  inRange: "Du bist im Umkreis von {radius} m",
  geoDenied: "Ich brauche deinen Standort, um Contact Sync zu öffnen — erlaube ihn und versuch es noch mal.",
  geoUnavailable: "Dein Handy liefert noch keinen Standort. Geh kurz ins Freie.",
  motionDenied: "Dafür brauche ich Bewegungszugriff — erlaube ihn in den Browsereinstellungen.",
  motionUnsupported: "Dieses Handy spürt kein Schütteln. Das Date findet trotzdem statt — genieß es.",
  tooFar: "Der Server sieht dich weiter als {radius} m vom Ort entfernt. Geh ein Stück näher und schüttel noch mal.",
  tooEarly: "Noch nicht — Contact Sync öffnet um {time}.",
  offline: "Ich bin gerade nicht erreichbar. Versuche es erneut.",
  activate: "Contact Sync einschalten",
  locked: "Contact Sync gesperrt",
  retryLocation: "Standort erlauben",
  openMap: "Karte",
  close: "Schließen",
  deckLoading: "Ich teile die Karten aus…",
  stubLabel: "Einlass",
};

const pl: TerminalStrings = {
  kicker: "Date Terminal",
  loading: "Otwieram terminal…",
  titleEarly: "Randka o {time}",
  titleApproach: "Idź na miejsce",
  titleReady: "Jesteś na miejscu",
  titleArmed: "Potrząśnijcie razem",
  titleSynced: "Contact Sync ✓",
  titleClosed: "Ten terminal jest zamknięty",
  titleNoVenue: "Contact Sync jest wyłączony",
  subEarly: "Contact Sync otworzy się o {time}, w promieniu {radius} m od miejsca.",
  subApproach: "Contact Sync odblokuje się w promieniu {radius} m od miejsca.",
  subReady: "Włącz Contact Sync — i potrząśnijcie razem telefonami.",
  subArmed: "Weźcie oba telefony i potrząśnijcie nimi w tej samej chwili.",
  subWaiting: "Twoje mam. Teraz potrząśnijcie razem z drugim telefonem.",
  subSynced: "Randka zaliczona, bilet na następną ode mnie. O czym pogadać:",
  subClosed: "Otwiera się w dniu randki. Wszystkie szczegóły są w czacie.",
  subNoVenue: "Nie mogę dokładnie wskazać miejsca tej randki, więc nie ma z czym synchronizować.",
  arrival: "Przybycie do „{venue}”",
  arrivalFallback: "Przybycie na miejsce",
  metres: "{n} m",
  kilometres: "{n} km",
  locating: "Szukam cię…",
  inRange: "Jesteś w promieniu {radius} m",
  geoDenied: "Potrzebuję twojej lokalizacji, żeby otworzyć Contact Sync — zezwól na nią i spróbuj ponownie.",
  geoUnavailable: "Telefon nie podaje jeszcze lokalizacji. Wyjdź na chwilę na otwartą przestrzeń.",
  motionDenied: "Potrzebuję dostępu do ruchu — zezwól na niego w ustawieniach przeglądarki.",
  motionUnsupported: "Ten telefon nie wyczuwa potrząśnięcia. Randka i tak trwa — baw się dobrze.",
  tooFar: "Serwer widzi cię dalej niż {radius} m od miejsca. Podejdź trochę bliżej i potrząśnij jeszcze raz.",
  tooEarly: "Jeszcze nie — Contact Sync otworzy się o {time}.",
  offline: "Nie mogę się teraz połączyć. Próbuję ponownie.",
  activate: "Włącz Contact Sync",
  locked: "Contact Sync zablokowany",
  retryLocation: "Zezwól na lokalizację",
  openMap: "Mapa",
  close: "Zamknij",
  deckLoading: "Rozdaję karty…",
  stubLabel: "Wejście",
};

export const TERMINAL_TABLES: Record<Lang, TerminalStrings> = { en, ru, uk, de, pl };

export function pickLang(raw: string | null | undefined): Lang {
  const base = (raw ?? "").toLowerCase().slice(0, 2);
  return base === "ru" || base === "uk" || base === "de" || base === "pl" ? base : "en";
}

export function stringsFor(lang: Lang): TerminalStrings {
  return TERMINAL_TABLES[lang];
}

/** Replace `{name}` placeholders. Unknown ones are left visible on purpose. */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in vars ? String(vars[key]) : whole,
  );
}
