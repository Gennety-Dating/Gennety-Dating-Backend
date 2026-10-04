/**
 * Copy for the Date Terminal (Contact Sync).
 *
 * Inlined like every other Mini App here — `apps/webapp` deliberately does not
 * depend on `@gennety/shared`. Held to the two product-wide voice rules the
 * canvas table states: the bot refers to ITSELF in the masculine where the
 * language inflects it («поймал», «впіймав»), and it says «ты» to the user —
 * «вы» only where it genuinely means the two of them («удерживайте вместе»).
 * "Date Terminal" and "Contact Sync" are internal names: since the copy audit
 * (founder, 2026-10-01) the screen says «обмен контактами» / "contact
 * exchange" in each language, and the old "Date Terminal" kicker is gone.
 */

export type Lang = "en" | "ru" | "uk" | "de" | "pl";

export interface TerminalStrings {
  loading: string;
  /** `{time}` — the date's own time. */
  titleEarly: string;
  titleApproach: string;
  titleReady: string;
  /** A hold is in; the server is waiting for the other phone. */
  titleWaiting: string;
  titleSynced: string;
  titleClosed: string;
  titleNoVenue: string;
  /** `{time}` — when the sync opens; `{radius}` — the geofence in metres. */
  subEarly: string;
  subApproach: string;
  subReady: string;
  /** This phone's hold is in; the server is waiting for the other one. */
  subWaiting: string;
  /**
   * The hold came back unpaired. Worded for both servers: the long-poll one
   * (the partner did not hold within 10 s) and the pre-deploy one that answers
   * at once — where the partner's hold may still complete the pair.
   */
  subAlone: string;
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
  /** The SERVER refused the hold as too far — said with its own radius. */
  tooFar: string;
  tooEarly: string;
  offline: string;
  /**
   * A 401: the Mini App's session (its initData) has expired, which no retry
   * can fix — only opening it again from the chat does. Kept apart from
   * `offline`, which promises that retrying will get through (A13-M31).
   */
  reopenFromChat: string;
  /** Beside the placement drawing, above the hold capsule. */
  holdHint: string;
  /** On the capsule itself. */
  holdLabel: string;
  /** The waiting capsule — the partner's name is not on this screen. */
  ceremonyWaiting: string;
  /** The capsule of the phone whose hold completed the pair, until the scene starts. */
  ceremonyReady: string;
  /** The plaque the scene ends on (the stand's «Встреча подтверждена»). */
  ceremonyTitle: string;
  ceremonySub: string;
  locked: string;
  retryLocation: string;
  openMap: string;
  close: string;
  deckLoading: string;
  /** The stub's printed field name — the part torn off at the door. */
  stubLabel: string;
}

const en: TerminalStrings = {
  loading: "Opening…",
  titleEarly: "Your date is at {time}",
  titleApproach: "Head to the place",
  titleReady: "You're here",
  titleWaiting: "Hold together",
  titleSynced: "Contact exchange ✓",
  titleClosed: "Closed for now",
  titleNoVenue: "Contact exchange is off",
  subEarly: "Contact exchange opens at {time}, within {radius} m of the place.",
  subApproach: "Contact exchange unlocks within {radius} m of the place.",
  subReady: "Contact exchange is open — confirm the meeting together.",
  subWaiting: "Got yours — now the other phone holds too.",
  subAlone: "Got yours. If the other phone missed it, hold together once more.",
  subSynced: "The date counts — your next ticket is on us. Something to talk about:",
  subClosed: "It opens on the day of a date. Your chat has the details.",
  subNoVenue: "Contact exchange isn't available for this date.",
  arrival: "Arrival at {venue}",
  arrivalFallback: "Arrival at the place",
  metres: "{n} m",
  kilometres: "{n} km",
  locating: "Finding you…",
  inRange: "You're within {radius} m",
  geoDenied: "I need your location to open contact exchange — allow it and try again.",
  geoUnavailable: "Your phone isn't giving me a location yet. Step outside for a moment.",
  tooFar: "The server sees you more than {radius} m from the place. Get a little closer and hold again.",
  tooEarly: "Not yet — contact exchange opens at {time}.",
  offline: "Can't reach me right now. Trying again.",
  reopenFromChat: "This session has expired. Open the date screen again from the chat.",
  holdHint: "Put the phones top edge to top edge and hold.",
  holdLabel: "Hold",
  ceremonyWaiting: "Waiting for your date…",
  ceremonyReady: "Ready",
  ceremonyTitle: "Meeting confirmed",
  ceremonySub: "The next ticket is on us",
  locked: "Contact exchange locked",
  retryLocation: "Allow location",
  openMap: "Map",
  close: "Close",
  deckLoading: "Dealing your cards…",
  stubLabel: "Admit",
};

const ru: TerminalStrings = {
  loading: "Открываю…",
  titleEarly: "Свидание в {time}",
  titleApproach: "Иди к месту",
  titleReady: "Ты на месте",
  titleWaiting: "Удерживайте вместе",
  titleSynced: "Обмен контактами ✓",
  titleClosed: "Пока закрыто",
  titleNoVenue: "Обмен контактами выключен",
  subEarly: "Обмен контактами откроется в {time}, в радиусе {radius} м от места.",
  subApproach: "Обмен контактами откроется в радиусе {radius} м от места.",
  subReady: "Обмен контактами открыт — подтвердите встречу вдвоём.",
  subWaiting: "Твоё поймал — теперь пусть удержит второй телефон.",
  subAlone: "Твоё поймал. Если второй телефон не успел — удерживайте вместе ещё раз.",
  subSynced: "Свидание засчитано — следующий билет от нас. О чём поговорить:",
  subClosed: "Откроется в день свидания. Все детали — в чате.",
  subNoVenue: "Для этого свидания обмен контактами недоступен.",
  arrival: "Прибытие в «{venue}»",
  arrivalFallback: "Прибытие на место",
  metres: "{n} м",
  kilometres: "{n} км",
  locating: "Ищу тебя…",
  inRange: "Ты в радиусе {radius} м",
  geoDenied: "Мне нужна твоя геолокация, чтобы открыть обмен контактами — разреши её и попробуй ещё раз.",
  geoUnavailable: "Телефон пока не отдаёт геолокацию. Выйди на секунду на открытое место.",
  tooFar: "Сервер видит тебя дальше {radius} м от места. Подойди чуть ближе и удержи ещё раз.",
  tooEarly: "Ещё рано — обмен контактами откроется в {time}.",
  offline: "Не достучаться до меня. Пробую снова.",
  reopenFromChat: "Сессия устарела. Открой экран свидания заново из чата.",
  holdHint: "Положите телефоны верхними краями друг к другу и удерживайте.",
  holdLabel: "Удерживай",
  ceremonyWaiting: "Ждём твою пару…",
  ceremonyReady: "Готово",
  ceremonyTitle: "Встреча подтверждена",
  ceremonySub: "Следующий билет — от нас",
  locked: "Обмен контактами закрыт",
  retryLocation: "Разрешить геолокацию",
  openMap: "Карта",
  close: "Закрыть",
  deckLoading: "Раздаю карточки…",
  stubLabel: "Вход",
};

const uk: TerminalStrings = {
  loading: "Відкриваю…",
  titleEarly: "Побачення о {time}",
  titleApproach: "Прямуй до місця",
  titleReady: "Ти на місці",
  titleWaiting: "Утримуйте разом",
  titleSynced: "Обмін контактами ✓",
  titleClosed: "Поки закрито",
  titleNoVenue: "Обмін контактами вимкнено",
  subEarly: "Обмін контактами відкриється о {time}, у радіусі {radius} м від місця.",
  subApproach: "Обмін контактами відкриється у радіусі {radius} м від місця.",
  subReady: "Обмін контактами відкрито — підтвердьте зустріч удвох.",
  subWaiting: "Твоє впіймав — тепер хай утримає другий телефон.",
  subAlone: "Твоє впіймав. Якщо другий телефон не встиг — утримуйте разом ще раз.",
  subSynced: "Побачення зараховано — наступний квиток від нас. Про що поговорити:",
  subClosed: "Відкриється в день побачення. Усі деталі — в чаті.",
  subNoVenue: "Для цього побачення обмін контактами недоступний.",
  arrival: "Прибуття до «{venue}»",
  arrivalFallback: "Прибуття на місце",
  metres: "{n} м",
  kilometres: "{n} км",
  locating: "Шукаю тебе…",
  inRange: "Ти в радіусі {radius} м",
  geoDenied: "Мені потрібна твоя геолокація, щоб відкрити обмін контактами — дозволь її і спробуй ще раз.",
  geoUnavailable: "Телефон поки не віддає геолокацію. Вийди на секунду на відкрите місце.",
  tooFar: "Сервер бачить тебе далі ніж за {radius} м від місця. Підійди трохи ближче і утримай ще раз.",
  tooEarly: "Ще зарано — обмін контактами відкриється о {time}.",
  offline: "Не достукатися до мене. Пробую знову.",
  reopenFromChat: "Сесія застаріла. Відкрий екран побачення знову з чату.",
  holdHint: "Покладіть телефони верхніми краями один до одного й утримуйте.",
  holdLabel: "Утримуй",
  ceremonyWaiting: "Чекаємо на твою пару…",
  ceremonyReady: "Готово",
  ceremonyTitle: "Зустріч підтверджено",
  ceremonySub: "Наступний квиток — від нас",
  locked: "Обмін контактами закрито",
  retryLocation: "Дозволити геолокацію",
  openMap: "Мапа",
  close: "Закрити",
  deckLoading: "Роздаю картки…",
  stubLabel: "Вхід",
};

const de: TerminalStrings = {
  loading: "Wird geöffnet…",
  titleEarly: "Dein Date um {time}",
  titleApproach: "Auf zum Treffpunkt",
  titleReady: "Du bist da",
  titleWaiting: "Gemeinsam halten",
  titleSynced: "Kontakttausch ✓",
  titleClosed: "Noch geschlossen",
  titleNoVenue: "Kontakttausch ist aus",
  subEarly: "Der Kontakttausch öffnet um {time}, im Umkreis von {radius} m um den Ort.",
  subApproach: "Der Kontakttausch wird im Umkreis von {radius} m um den Ort freigeschaltet.",
  subReady: "Der Kontakttausch ist offen — bestätigt euer Treffen gemeinsam.",
  subWaiting: "Deins habe ich — jetzt hält das andere Handy auch.",
  subAlone: "Deins habe ich. Hat das andere Handy es verpasst, haltet noch einmal gemeinsam.",
  subSynced: "Das Date zählt — dein nächstes Ticket geht auf uns. Worüber ihr reden könnt:",
  subClosed: "Es öffnet sich am Tag eines Dates. Alle Details stehen im Chat.",
  subNoVenue: "Für dieses Date ist kein Kontakttausch möglich.",
  arrival: "Ankunft bei „{venue}“",
  arrivalFallback: "Ankunft am Ort",
  metres: "{n} m",
  kilometres: "{n} km",
  locating: "Ich suche dich…",
  inRange: "Du bist im Umkreis von {radius} m",
  geoDenied:
    "Ich brauche deinen Standort, um den Kontakttausch zu öffnen — erlaube ihn und versuch es noch mal.",
  geoUnavailable: "Dein Handy liefert noch keinen Standort. Geh kurz ins Freie.",
  tooFar: "Der Server sieht dich weiter als {radius} m vom Ort entfernt. Geh ein Stück näher und halte noch mal.",
  tooEarly: "Noch nicht — der Kontakttausch öffnet um {time}.",
  offline: "Ich bin gerade nicht erreichbar. Versuche es erneut.",
  reopenFromChat: "Diese Sitzung ist abgelaufen. Öffne den Date-Bildschirm erneut aus dem Chat.",
  holdHint: "Legt die Handys mit den Oberkanten aneinander und haltet gedrückt.",
  holdLabel: "Gedrückt halten",
  ceremonyWaiting: "Warte auf dein Date…",
  ceremonyReady: "Bereit",
  ceremonyTitle: "Treffen bestätigt",
  ceremonySub: "Das nächste Ticket geht auf uns",
  locked: "Kontakttausch gesperrt",
  retryLocation: "Standort erlauben",
  openMap: "Karte",
  close: "Schließen",
  deckLoading: "Ich teile die Karten aus…",
  stubLabel: "Einlass",
};

const pl: TerminalStrings = {
  loading: "Otwieram…",
  titleEarly: "Randka o {time}",
  titleApproach: "Idź na miejsce",
  titleReady: "Jesteś na miejscu",
  titleWaiting: "Przytrzymajcie razem",
  titleSynced: "Wymiana kontaktów ✓",
  titleClosed: "Na razie zamknięte",
  titleNoVenue: "Wymiana kontaktów jest wyłączona",
  subEarly: "Wymiana kontaktów otworzy się o {time}, w promieniu {radius} m od miejsca.",
  subApproach: "Wymiana kontaktów odblokuje się w promieniu {radius} m od miejsca.",
  subReady: "Wymiana kontaktów jest otwarta — potwierdźcie spotkanie we dwoje.",
  subWaiting: "Twoje mam — teraz niech przytrzyma drugi telefon.",
  subAlone: "Twoje mam. Jeśli drugi telefon nie zdążył, przytrzymajcie razem jeszcze raz.",
  subSynced: "Randka zaliczona — następny bilet od nas. O czym pogadać:",
  subClosed: "Otwiera się w dniu randki. Wszystkie szczegóły są w czacie.",
  subNoVenue: "Dla tej randki wymiana kontaktów jest niedostępna.",
  arrival: "Przybycie do „{venue}”",
  arrivalFallback: "Przybycie na miejsce",
  metres: "{n} m",
  kilometres: "{n} km",
  locating: "Szukam cię…",
  inRange: "Jesteś w promieniu {radius} m",
  geoDenied:
    "Potrzebuję twojej lokalizacji, żeby otworzyć wymianę kontaktów — zezwól na nią i spróbuj ponownie.",
  geoUnavailable: "Telefon nie podaje jeszcze lokalizacji. Wyjdź na chwilę na otwartą przestrzeń.",
  tooFar: "Serwer widzi cię dalej niż {radius} m od miejsca. Podejdź trochę bliżej i przytrzymaj jeszcze raz.",
  tooEarly: "Jeszcze nie — wymiana kontaktów otworzy się o {time}.",
  offline: "Nie mogę się teraz połączyć. Próbuję ponownie.",
  reopenFromChat: "Sesja wygasła. Otwórz ekran randki ponownie z czatu.",
  holdHint: "Połóżcie telefony górnymi krawędziami do siebie i przytrzymajcie.",
  holdLabel: "Przytrzymaj",
  ceremonyWaiting: "Czekamy na twoją randkę…",
  ceremonyReady: "Gotowe",
  ceremonyTitle: "Spotkanie potwierdzone",
  ceremonySub: "Następny bilet od nas",
  locked: "Wymiana kontaktów zablokowana",
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
