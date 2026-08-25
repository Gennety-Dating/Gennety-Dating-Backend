/**
 * Copy for the Living Canvas sheet (PRODUCT_SPEC §6.1).
 *
 * Inlined rather than taken from `@gennety/shared`, like every other Mini App
 * here — `apps/webapp` deliberately does not depend on that package.
 *
 * Two voice rules this table is held to, both product-wide and both easy to
 * break one string at a time: the bot refers to ITSELF in the masculine in
 * every language that inflects it (`VOICE_SELF_GENDER`), and it addresses the
 * user informally — «ты», never «вы» — except where «вы» genuinely means the
 * two of them (PRODUCT_SPEC → 2026-08-20). Both are asserted by tests.
 */

export type Lang = "en" | "ru" | "uk" | "de" | "pl";

export interface CanvasStrings {
  /** Between drops. */
  idleTitle: string;
  idleBody: string;
  idleNoDrop: string;
  /** A pitch is on the table and THIS side has not answered. */
  decisionTitle: string;
  decisionBody: string;
  /** Time and place still being agreed. */
  planningTitle: string;
  planningBody: string;
  /** Locked in, more than 45 minutes out. */
  scheduledTitle: string;
  /** Inside the radar window. */
  radarTitle: string;
  radarPeerUnknown: string;
  radarPeerEnRoute: string;
  radarPeerArrived: string;
  radarBothArrived: string;
  /** At the venue, waiting for the two shakes. */
  bumpTitle: string;
  bumpBody: string;
  bumpAction: string;
  bumpWaiting: string;
  bumpDenied: string;
  /** Verified — the deck is open. */
  inProgressTitle: string;
  inProgressBody: string;
  /** The T+24h prompt is out and this side still owes an answer. */
  feedbackTitle: string;
  feedbackBody: string;
  /** Shared actions. */
  openChat: string;
  /** Countdown units, so a number never renders with English letters in it. */
  days: string;
  hours: string;
  minutes: string;
  soon: string;
  offline: string;
}

const en: CanvasStrings = {
  idleTitle: "I'm looking",
  idleBody: "Next drop in {time}. Until then the map is yours.",
  idleNoDrop: "I check every evening. You'll hear from me the moment I find someone.",
  decisionTitle: "Someone's waiting on your answer",
  decisionBody: "Open the chat and tell me yes or no — {time} left.",
  planningTitle: "Sorting out the details",
  planningBody: "Time and place aren't settled yet. I'll tell you the moment they are.",
  scheduledTitle: "Your date is in {time}",
  radarTitle: "Almost time",
  radarPeerUnknown: "No word from them yet.",
  radarPeerEnRoute: "On the way — arriving {eta}.",
  radarPeerArrived: "They're already there.",
  radarBothArrived: "You're both here ✨",
  bumpTitle: "You're at the table",
  bumpBody: "Shake your phones together to confirm you both made it.",
  bumpAction: "Shake to confirm",
  bumpWaiting: "Got yours. Waiting for the other phone.",
  bumpDenied: "I need motion access for this — allow it in your browser settings.",
  inProgressTitle: "You made it ✨",
  inProgressBody: "The date's on me — your next ticket is free. Something to talk about:",
  feedbackTitle: "How did it go?",
  feedbackBody: "Open the chat — it's two questions and it makes the next one better.",
  openChat: "Open the chat",
  days: "{n}d",
  hours: "{n}h",
  minutes: "{n}m",
  soon: "any moment",
  offline: "Can't reach me right now. Trying again.",
};

const ru: CanvasStrings = {
  idleTitle: "Я ищу",
  idleBody: "Следующий дроп через {time}. А пока карта твоя.",
  idleNoDrop: "Смотрю каждый вечер. Напишу, как только найду.",
  decisionTitle: "От тебя ждут ответа",
  decisionBody: "Открой чат и скажи да или нет — осталось {time}.",
  planningTitle: "Договариваемся о деталях",
  planningBody: "Время и место ещё не закреплены. Скажу, как только будут.",
  scheduledTitle: "Твоё свидание через {time}",
  radarTitle: "Уже скоро",
  radarPeerUnknown: "Пока тихо с той стороны.",
  radarPeerEnRoute: "В пути — прибытие в {eta}.",
  radarPeerArrived: "Уже на месте.",
  radarBothArrived: "Вы оба на месте ✨",
  bumpTitle: "Ты за столиком",
  bumpBody: "Тряхните телефоны вместе — так я пойму, что вы оба дошли.",
  bumpAction: "Тряхнуть",
  bumpWaiting: "Твоё поймал. Жду второй телефон.",
  bumpDenied: "Нужен доступ к движению — разреши его в настройках браузера.",
  inProgressTitle: "Вы дошли ✨",
  inProgressBody: "Свидание засчитано, билет на следующее — от меня. О чём поговорить:",
  feedbackTitle: "Как всё прошло?",
  feedbackBody: "Открой чат — два вопроса, и следующее свидание будет точнее.",
  openChat: "Открыть чат",
  days: "{n} д",
  hours: "{n} ч",
  minutes: "{n} мин",
  soon: "вот-вот",
  offline: "Не достучаться до меня. Пробую снова.",
};

const uk: CanvasStrings = {
  idleTitle: "Я шукаю",
  idleBody: "Наступний дроп через {time}. А поки карта твоя.",
  idleNoDrop: "Дивлюся щовечора. Напишу, щойно знайду.",
  decisionTitle: "Від тебе чекають відповіді",
  decisionBody: "Відкрий чат і скажи так чи ні — лишилось {time}.",
  planningTitle: "Узгоджуємо деталі",
  planningBody: "Час і місце ще не закріплені. Скажу, щойно будуть.",
  scheduledTitle: "Твоє побачення через {time}",
  radarTitle: "Уже скоро",
  radarPeerUnknown: "Поки тихо з того боку.",
  radarPeerEnRoute: "У дорозі — прибуття о {eta}.",
  radarPeerArrived: "Уже на місці.",
  radarBothArrived: "Ви обоє на місці ✨",
  bumpTitle: "Ти за столиком",
  bumpBody: "Струсіть телефони разом — так я зрозумію, що ви обоє дійшли.",
  bumpAction: "Струснути",
  bumpWaiting: "Твоє впіймав. Чекаю на другий телефон.",
  bumpDenied: "Потрібен доступ до руху — дозволь його в налаштуваннях браузера.",
  inProgressTitle: "Ви дійшли ✨",
  inProgressBody: "Побачення зараховано, квиток на наступне — від мене. Про що поговорити:",
  feedbackTitle: "Як усе минуло?",
  feedbackBody: "Відкрий чат — два питання, і наступне побачення буде точнішим.",
  openChat: "Відкрити чат",
  days: "{n} д",
  hours: "{n} год",
  minutes: "{n} хв",
  soon: "ось-ось",
  offline: "Не достукатися до мене. Пробую знову.",
};

const de: CanvasStrings = {
  ...en,
  idleTitle: "Ich suche",
  idleBody: "Nächster Drop in {time}. Bis dahin gehört dir die Karte.",
  idleNoDrop: "Ich schaue jeden Abend. Du hörst von mir, sobald ich jemanden finde.",
  decisionTitle: "Jemand wartet auf deine Antwort",
  decisionBody: "Öffne den Chat und sag ja oder nein — noch {time}.",
  planningTitle: "Wir klären die Details",
  planningBody: "Zeit und Ort stehen noch nicht fest. Ich sage Bescheid, sobald sie es tun.",
  scheduledTitle: "Dein Date in {time}",
  radarTitle: "Gleich so weit",
  radarPeerUnknown: "Von der anderen Seite noch nichts.",
  radarPeerEnRoute: "Unterwegs — Ankunft {eta}.",
  radarPeerArrived: "Schon da.",
  radarBothArrived: "Ihr seid beide da ✨",
  bumpTitle: "Du bist am Tisch",
  bumpBody: "Schüttelt eure Handys gemeinsam — so weiß ich, dass ihr beide da seid.",
  bumpAction: "Schütteln",
  bumpWaiting: "Deins habe ich. Warte auf das andere Handy.",
  bumpDenied: "Dafür brauche ich Bewegungszugriff — erlaube ihn in den Browsereinstellungen.",
  inProgressTitle: "Ihr habt es geschafft ✨",
  inProgressBody: "Das Date geht auf mich — dein nächstes Ticket ist frei. Worüber ihr reden könnt:",
  feedbackTitle: "Wie war es?",
  feedbackBody: "Öffne den Chat — zwei Fragen, und das nächste Date wird besser.",
  openChat: "Chat öffnen",
  days: "{n} T",
  hours: "{n} Std",
  minutes: "{n} Min",
  soon: "gleich",
  offline: "Ich bin gerade nicht erreichbar. Versuche es erneut.",
};

const pl: CanvasStrings = {
  ...en,
  idleTitle: "Szukam",
  idleBody: "Następny drop za {time}. Na razie mapa jest twoja.",
  idleNoDrop: "Sprawdzam co wieczór. Odezwę się, gdy tylko kogoś znajdę.",
  decisionTitle: "Ktoś czeka na twoją odpowiedź",
  decisionBody: "Otwórz czat i powiedz tak albo nie — zostało {time}.",
  planningTitle: "Ustalamy szczegóły",
  planningBody: "Czas i miejsce jeszcze nie są ustalone. Dam znać, gdy będą.",
  scheduledTitle: "Twoja randka za {time}",
  radarTitle: "Już za chwilę",
  radarPeerUnknown: "Z drugiej strony na razie cisza.",
  radarPeerEnRoute: "W drodze — przyjazd o {eta}.",
  radarPeerArrived: "Już na miejscu.",
  radarBothArrived: "Oboje jesteście na miejscu ✨",
  bumpTitle: "Jesteś przy stoliku",
  bumpBody: "Potrząśnijcie telefonami razem — tak się dowiem, że oboje dotarliście.",
  bumpAction: "Potrząśnij",
  bumpWaiting: "Twoje mam. Czekam na drugi telefon.",
  bumpDenied: "Potrzebuję dostępu do ruchu — zezwól na niego w ustawieniach przeglądarki.",
  inProgressTitle: "Udało się ✨",
  inProgressBody: "Randka zaliczona, bilet na następną ode mnie. O czym pogadać:",
  feedbackTitle: "Jak poszło?",
  feedbackBody: "Otwórz czat — dwa pytania, a następna randka będzie lepsza.",
  openChat: "Otwórz czat",
  days: "{n} dn",
  hours: "{n} godz",
  minutes: "{n} min",
  soon: "lada moment",
  offline: "Nie mogę się teraz połączyć. Próbuję ponownie.",
};

const TABLES: Record<Lang, CanvasStrings> = { en, ru, uk, de, pl };

export function isLang(value: string | null): value is Lang {
  return value === "en" || value === "ru" || value === "uk" || value === "de" || value === "pl";
}

export function stringsFor(lang: Lang): CanvasStrings {
  return TABLES[lang];
}

export const CANVAS_TABLES = TABLES;
