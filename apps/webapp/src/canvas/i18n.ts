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
  /** At the venue, waiting for the two holds (the shake until 2026-09-29). */
  bumpTitle: string;
  bumpBody: string;
  /**
   * The radar and bump states hand the user to the Date Terminal, which owns
   * the gesture since 2026-09-11 — a hold of both phones since 2026-09-29.
   */
  terminalAction: string;
  bumpWaiting: string;
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
  /**
   * A 401: the Mini App's session (its initData) has expired, which no retry
   * can fix — only opening it again from the chat does. Kept apart from
   * `offline`, which promises that retrying will get through (A13-M31).
   */
  reopenFromChat: string;
  /**
   * The transit dock (decision 2026-09-11, `canvas/transit-dock.ts`). `{time}`
   * arrives formatted by `formatTravelTime`, `{n}` by the terminal's
   * `formatDistance`, and `{app}` is a brand ("Apple Maps"). Brands appear here
   * only inside sentences: the buttons print them bare (`deep-links.ts`), since
   * a row that is the same word in every language would fail the uk ≠ ru rule.
   */
  dockLabel: string;
  /** The on-foot / by-car pair, named as a group. */
  dockModes: string;
  dockWalking: string;
  dockDriving: string;
  dockEtaWalking: string;
  dockEtaDriving: string;
  /** A sentence per unit, so each language puts the number where it goes. */
  dockAwayMetres: string;
  dockAwayKilometres: string;
  /** Before the first fix, and when there will not be one. */
  dockLocating: string;
  dockNoLocation: string;
  /** Accessible names of the two hand-offs. */
  dockUber: string;
  dockMaps: string;
  /** Travel time, spelled out — unlike the countdown's compact "9m". */
  dockMinutes: string;
  dockHours: string;
  dockHoursMinutes: string;
}

const en: CanvasStrings = {
  idleTitle: "Finding you a match",
  idleBody: "Next match in {time}. Until then the map is yours.",
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
  bumpBody: "Put your phones together and hold — that's how I'll know you both made it.",
  terminalAction: "Open the date screen",
  bumpWaiting: "Got yours. Waiting for the other phone.",
  inProgressTitle: "You made it ✨",
  inProgressBody: "The date counts — your next ticket is on us. Something to talk about:",
  feedbackTitle: "How did it go?",
  feedbackBody: "Open the chat — it's two questions and it makes the next one better.",
  openChat: "Open the chat",
  days: "{n}d",
  hours: "{n}h",
  minutes: "{n}m",
  soon: "any moment",
  offline: "Can't reach me right now. Trying again.",
  reopenFromChat: "This session has expired. Open the map again from the chat.",
  dockLabel: "Getting there",
  dockModes: "On foot or by car",
  dockWalking: "On foot",
  dockDriving: "By car",
  dockEtaWalking: "{time} on foot",
  dockEtaDriving: "{time} by car",
  dockAwayMetres: "You're {n} m away",
  dockAwayKilometres: "You're {n} km away",
  dockLocating: "Finding where you are…",
  dockNoLocation: "Turn on location and I'll work out the trip.",
  dockUber: "Get an Uber there",
  dockMaps: "Directions in {app}",
  dockMinutes: "{n} min",
  dockHours: "{h} h",
  dockHoursMinutes: "{h} h {m} min",
};

const ru: CanvasStrings = {
  idleTitle: "Ищем тебе пару",
  idleBody: "Следующий подбор через {time}. А пока карта твоя.",
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
  bumpBody: "Сложите телефоны вместе и удерживайте — так я пойму, что вы оба дошли.",
  terminalAction: "Открыть экран свидания",
  bumpWaiting: "Твоё поймал. Жду второй телефон.",
  inProgressTitle: "Вы дошли ✨",
  inProgressBody: "Свидание засчитано — следующий билет от нас. О чём поговорить:",
  feedbackTitle: "Как всё прошло?",
  feedbackBody: "Открой чат — два вопроса, и следующее свидание будет точнее.",
  openChat: "Открыть чат",
  days: "{n} д",
  hours: "{n} ч",
  minutes: "{n} мин",
  soon: "вот-вот",
  offline: "Не достучаться до меня. Пробую снова.",
  reopenFromChat: "Сессия устарела. Открой карту заново из чата.",
  dockLabel: "Как добраться",
  dockModes: "Пешком или на машине",
  dockWalking: "Пешком",
  dockDriving: "На машине",
  dockEtaWalking: "{time} пешком",
  dockEtaDriving: "{time} на машине",
  dockAwayMetres: "До места {n} м",
  dockAwayKilometres: "До места {n} км",
  dockLocating: "Смотрю, где ты…",
  dockNoLocation: "Включи геолокацию — посчитаю дорогу.",
  dockUber: "Вызвать Uber туда",
  dockMaps: "Маршрут в {app}",
  dockMinutes: "{n} мин",
  dockHours: "{h} ч",
  dockHoursMinutes: "{h} ч {m} мин",
};

const uk: CanvasStrings = {
  idleTitle: "Шукаємо тобі пару",
  idleBody: "Наступний підбір через {time}. А поки карта твоя.",
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
  bumpBody: "Складіть телефони разом і утримуйте — так я зрозумію, що ви обоє дійшли.",
  terminalAction: "Відкрити екран побачення",
  bumpWaiting: "Твоє впіймав. Чекаю на другий телефон.",
  inProgressTitle: "Ви дійшли ✨",
  inProgressBody: "Побачення зараховано — наступний квиток від нас. Про що поговорити:",
  feedbackTitle: "Як усе минуло?",
  feedbackBody: "Відкрий чат — два питання, і наступне побачення буде точнішим.",
  openChat: "Відкрити чат",
  days: "{n} д",
  hours: "{n} год",
  minutes: "{n} хв",
  soon: "ось-ось",
  offline: "Не достукатися до мене. Пробую знову.",
  reopenFromChat: "Сесія застаріла. Відкрий мапу знову з чату.",
  dockLabel: "Як дістатися",
  dockModes: "Пішки чи автівкою",
  dockWalking: "Пішки",
  dockDriving: "Автівкою",
  dockEtaWalking: "{time} пішки",
  dockEtaDriving: "{time} автівкою",
  dockAwayMetres: "До місця {n} м",
  dockAwayKilometres: "До місця {n} км",
  dockLocating: "Дивлюся, де ти…",
  dockNoLocation: "Увімкни геолокацію — порахую дорогу.",
  dockUber: "Викликати Uber туди",
  dockMaps: "Маршрут у {app}",
  dockMinutes: "{n} хв",
  dockHours: "{h} год",
  dockHoursMinutes: "{h} год {m} хв",
};

const de: CanvasStrings = {
  ...en,
  idleTitle: "Wir suchen ein Match für dich",
  idleBody: "Nächste Auswahl in {time}. Bis dahin gehört dir die Karte.",
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
  bumpBody: "Legt eure Handys zusammen und haltet gedrückt — so weiß ich, dass ihr beide da seid.",
  terminalAction: "Date-Bildschirm öffnen",
  bumpWaiting: "Deins habe ich. Warte auf das andere Handy.",
  inProgressTitle: "Ihr habt es geschafft ✨",
  inProgressBody: "Das Date zählt — dein nächstes Ticket geht auf uns. Worüber ihr reden könnt:",
  feedbackTitle: "Wie war es?",
  feedbackBody: "Öffne den Chat — zwei Fragen, und das nächste Date wird besser.",
  openChat: "Chat öffnen",
  days: "{n} T",
  hours: "{n} Std",
  minutes: "{n} Min",
  soon: "gleich",
  offline: "Ich bin gerade nicht erreichbar. Versuche es erneut.",
  reopenFromChat: "Diese Sitzung ist abgelaufen. Öffne die Karte erneut aus dem Chat.",
  dockLabel: "Anfahrt",
  dockModes: "Zu Fuß oder mit dem Auto",
  dockWalking: "Zu Fuß",
  dockDriving: "Mit dem Auto",
  dockEtaWalking: "{time} zu Fuß",
  dockEtaDriving: "{time} mit dem Auto",
  dockAwayMetres: "Noch {n} m entfernt",
  dockAwayKilometres: "Noch {n} km entfernt",
  dockLocating: "Ich suche deinen Standort…",
  dockNoLocation: "Gib deinen Standort frei, dann rechne ich den Weg aus.",
  dockUber: "Mit Uber hinfahren",
  dockMaps: "Route in {app}",
  dockMinutes: "{n} Min",
  dockHours: "{h} Std",
  dockHoursMinutes: "{h} Std {m} Min",
};

const pl: CanvasStrings = {
  ...en,
  idleTitle: "Szukamy ci pary",
  idleBody: "Następne dopasowanie za {time}. Na razie mapa jest twoja.",
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
  bumpBody: "Połóżcie telefony razem i przytrzymajcie — tak się dowiem, że oboje dotarliście.",
  terminalAction: "Otwórz ekran randki",
  bumpWaiting: "Twoje mam. Czekam na drugi telefon.",
  inProgressTitle: "Udało się ✨",
  inProgressBody: "Randka zaliczona — następny bilet od nas. O czym pogadać:",
  feedbackTitle: "Jak poszło?",
  feedbackBody: "Otwórz czat — dwa pytania, a następna randka będzie lepsza.",
  openChat: "Otwórz czat",
  days: "{n} dn",
  hours: "{n} godz",
  minutes: "{n} min",
  soon: "lada moment",
  offline: "Nie mogę się teraz połączyć. Próbuję ponownie.",
  reopenFromChat: "Sesja wygasła. Otwórz mapę ponownie z czatu.",
  dockLabel: "Dojazd",
  dockModes: "Pieszo czy autem",
  dockWalking: "Pieszo",
  dockDriving: "Autem",
  dockEtaWalking: "{time} pieszo",
  dockEtaDriving: "{time} autem",
  dockAwayMetres: "Do miejsca {n} m",
  dockAwayKilometres: "Do miejsca {n} km",
  dockLocating: "Sprawdzam, gdzie jesteś…",
  dockNoLocation: "Włącz lokalizację, a policzę drogę.",
  dockUber: "Zamów tam Ubera",
  dockMaps: "Trasa w {app}",
  dockMinutes: "{n} min",
  dockHours: "{h} godz",
  dockHoursMinutes: "{h} godz {m} min",
};

const TABLES: Record<Lang, CanvasStrings> = { en, ru, uk, de, pl };

export function isLang(value: string | null): value is Lang {
  return value === "en" || value === "ru" || value === "uk" || value === "de" || value === "pl";
}

export function stringsFor(lang: Lang): CanvasStrings {
  return TABLES[lang];
}

export const CANVAS_TABLES = TABLES;
