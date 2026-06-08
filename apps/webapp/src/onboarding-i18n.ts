import { pickLang, type Lang } from "./i18n.js";

export interface OnboardingStrings {
  back: string;
  next: string;
  hookTitle: string;
  introLines: string[][];
  exhaustionLines: string[];
  statLabels: [string, string, string];
  statFootnote: string;
  pivotLines: string[][];
  howItWorksSteps: Array<{ title: string; body: string }>;
  profileName: string;
  profileRole: string;
  profileAlt: string;
  consentTitle: string;
  consentLead: string;
  consentTermsPrefix: string;
  consentPrivacy: string;
  consentResearch: string;
  continue: string;
  saving: string;
  languageTitle: string;
  languageLead: string;
  emailTitle: string;
  emailLead: string;
  emailSend: string;
  emailSending: string;
  emailMeta: string;
  otpTitle: string;
  otpLead: (email: string) => string;
  otpDigit: (position: number) => string;
  otpConfirm: string;
  otpChecking: string;
  otpResend: string;
  otpResending: string;
  otpResendIn: (seconds: number) => string;
  otpChangeEmail: string;
  cityTitle: string;
  cityLead: string;
  cityDetect: string;
  cityDetecting: string;
  cityGeoMeta: string;
  cityPlaceholder: string;
  citySearching: string;
  cityGeoUnavailable: string;
  cityGeoDenied: string;
  aiMemoryTitle: string;
  aiMemoryAria: string;
  aiMemoryAccept: string;
  aiMemoryAccepting: string;
  aiMemoryLater: string;
  aiMemorySaving: string;
  handoffMissingSession: string;
  handoffFailed: string;
  handoffReadyTitle: string;
  handoffTitle: string;
  handoffLead: string;
  retry: string;
  doneTitle: string;
  doneLead: string;
  backToChat: string;
  syncingTitle: string;
  syncingLead: string;
  errors: Record<string, string>;
  genericError: string;
}

const en: OnboardingStrings = {
  back: "Go back",
  next: "Next",
  hookTitle: "What does it cost to find a relationship in 2026?",
  introLines: [
    ["Statistically, only 3% of people on modern dating apps ever make it to a date"],
    ["We're all wrapped up in work, study, or ourselves"],
    ["We don't meet on the street anymore"],
    ["We've stopped seeing each other in person"],
    [
      "It's hard to see something beautiful in a person when all you have is their digital avatar",
      " just like",
      " millions of others",
    ],
    ["We need real, in-person meetings"],
    ["But,", " what does it cost to find a relationship in 2026?"],
  ],
  exhaustionLines: [
    "It wears down your mental health and turns dating into a meat market",
    "Endlessly browsing people like products kills empathy",
    "You spend weeks on chats that lead nowhere",
  ],
  statLabels: ["hours", "swipes", "in in-app purchases"],
  statFootnote: "That's what the average user of modern dating apps spends to find a relationship.",
  pivotLines: [["We see these problems."], ["So we built ", "Gennety."]],
  howItWorksSteps: [
    {
      title: "Tell us about yourself — once",
      body: "Import your AI's memory or answer a few questions. No endless forms.",
    },
    {
      title: "Gennety finds the one",
      body: "No feed, no swiping — our AI matchmaker picks a single person for you.",
    },
    {
      title: "You meet in person",
      body: "No texting. We handle the time and place — you just show up.",
    },
  ],
  profileName: "Alexander, 28",
  profileRole: "Tech founder",
  profileAlt: "Portrait of a young professional",
  consentTitle: "One quick formality",
  consentLead: "Gennety matches people using deep context, so we need your explicit consent before continuing.",
  consentTermsPrefix: "I accept the service terms and",
  consentPrivacy: "privacy policy",
  consentResearch: "My anonymized data may be used to improve matchmaking.",
  continue: "Continue",
  saving: "Saving...",
  languageTitle: "Choose your language",
  languageLead: "The bot and every Mini App will continue in the selected language.",
  emailTitle: "University email",
  emailLead: "This is a required Gennety filter: matches stay within a real student context.",
  emailSend: "Get code",
  emailSending: "Sending...",
  emailMeta: "If you already verified your email on the website, this screen will be skipped.",
  otpTitle: "Email code",
  otpLead: (email) => `We sent a 6-digit code to ${email}. It expires soon.`,
  otpDigit: (position) => `OTP digit ${position}`,
  otpConfirm: "Confirm",
  otpChecking: "Checking...",
  otpResend: "Send code again",
  otpResending: "Sending...",
  otpResendIn: (seconds) => `Send again in ${seconds}s`,
  otpChangeEmail: "Change email",
  cityTitle: "Your matching city",
  cityLead: "Choose where you are ready to go on dates now. We do not save your home address.",
  cityDetect: "Detect automatically",
  cityDetecting: "Detecting city...",
  cityGeoMeta: "Location is used only to choose your city",
  cityPlaceholder: "Kyiv, Lviv, Warsaw...",
  citySearching: "Searching for a city...",
  cityGeoUnavailable: "We couldn't open location access. Choose a city using search.",
  cityGeoDenied: "Location isn't available. Choose a city using search.",
  aiMemoryTitle: "Would you like to import memory from other AI apps to give your AI matchmaker more context about you?",
  aiMemoryAria: "ChatGPT, Claude and Gemini",
  aiMemoryAccept: "Yes, connect",
  aiMemoryAccepting: "Connecting...",
  aiMemoryLater: "Later",
  aiMemorySaving: "Saving...",
  handoffMissingSession: "The Mini App session is not synchronized. Open it from the chat again.",
  handoffFailed: "The bot couldn't continue yet. Try again.",
  handoffReadyTitle: "The bot is waiting for you",
  handoffTitle: "Passing context to the bot",
  handoffLead: "Gennety will continue in the chat without extra screens.",
  retry: "Try again",
  doneTitle: "Done",
  doneLead: "The bot has continued onboarding in the chat. Close the Mini App when you're ready.",
  backToChat: "Return to chat",
  syncingTitle: "Synchronizing",
  syncingLead: "Checking your onboarding state before the next step.",
  errors: {
    "Invalid university email": "Enter a corporate or university email.",
    "invalid-email": "Enter a corporate or university email.",
    "email-linked-to-other-account": "This email is linked to another Telegram account.",
    mismatch: "The code doesn't match. Check the email and try again.",
    expired: "The code expired. Request a new one below.",
    exhausted: "Too many attempts. Request a new code.",
    "otp-cooldown": "A new code was already sent. Wait a few seconds.",
    "otp-send-failed": "We couldn't send the email. Try again.",
    "terms-required": "Accept the terms first.",
    "language-required": "Choose a language first.",
    "ai-memory-preference-required": "Choose whether to connect memory from AI apps first.",
    "invalid-ai-memory-preference": "We couldn't save your choice. Try again.",
    "email-required": "Verify your university email first.",
    "location-required": "Choose your matching city first.",
    "Invalid initData": "Open the Mini App from the bot chat to continue.",
    "Missing tma initData": "Open the Mini App from the bot chat to continue.",
    "Empty initData": "Open the Mini App from the bot chat to continue.",
  },
  genericError: "Something went wrong. Try again.",
};

const ru: OnboardingStrings = {
  ...en,
  back: "Назад",
  next: "Дальше",
  hookTitle: "Сколько стоит найти отношения в 2026 году?",
  introLines: [
    ["Статистически только 3% людей, которые пользуются современными дейтинг-приложениями, доходят до свидания"],
    ["Мы все зациклены на работе, учёбе или самих себе"],
    ["Мы больше не знакомимся на улицах"],
    ["Мы перестали видеться вживую"],
    [
      "Сложно разглядеть что-то прекрасное в человеке, когда перед тобой только его цифровой аватар",
      " такой же",
      " как и миллионы других",
    ],
    ["Нужны реальные встречи"],
    ["Но,", " сколько же стоит найти отношения в 2026 году?"],
  ],
  exhaustionLines: [
    "Он ухудшает твоё состояние и превращает знакомства в рынок людей",
    "Бесконечный перебор людей, как товаров, убивает эмпатию",
    "Ты тратишь недели на переписки, которые ни к чему не приводят",
  ],
  statLabels: ["часов", "свайпов", "на покупки внутри приложений"],
  statFootnote: "Столько тратит средний пользователь современных приложений для знакомств, чтобы найти отношения.",
  pivotLines: [["Мы видим эти проблемы."], ["Поэтому мы создали ", "Gennety."]],
  howItWorksSteps: [
    {
      title: "Расскажи о себе — один раз",
      body: "Импортируй память своего AI или ответь на пару вопросов. Никаких бесконечных анкет.",
    },
    {
      title: "Gennety находит одного",
      body: "Не лента и не свайпы — AI-сводник подбирает того самого.",
    },
    {
      title: "Вы встречаетесь вживую",
      body: "Без переписок. Время и место берём на себя — тебе остаётся прийти.",
    },
  ],
  profileName: "Александр, 28",
  profileRole: "Основатель tech-стартапа",
  profileAlt: "Портрет молодого профессионала",
  consentTitle: "Сначала короткая формальность",
  consentLead: "Gennety подбирает людей по глубокому контексту, поэтому нам нужно явное согласие перед продолжением.",
  consentTermsPrefix: "Я принимаю условия сервиса и",
  consentPrivacy: "политику приватности",
  consentResearch: "Можно использовать мои обезличенные данные для улучшения матчмейкинга.",
  continue: "Продолжить",
  saving: "Сохраняю...",
  languageTitle: "Выбери язык",
  languageLead: "Бот и все Mini App продолжат работу на выбранном языке.",
  emailTitle: "Университетская почта",
  emailLead: "Это обязательный фильтр Gennety: пары подбираются внутри реального студенческого контекста.",
  emailSend: "Получить код",
  emailSending: "Отправляю...",
  emailMeta: "Если ты уже подтвердил почту на сайте, этот экран будет пропущен.",
  otpTitle: "Код из письма",
  otpLead: (email) => `Мы отправили 6-значный код на ${email}. Он живёт недолго.`,
  otpDigit: (position) => `Цифра кода ${position}`,
  otpConfirm: "Подтвердить",
  otpChecking: "Проверяю...",
  otpResend: "Отправить код снова",
  otpResending: "Отправляю...",
  otpResendIn: (seconds) => `Отправить снова через ${seconds} сек.`,
  otpChangeEmail: "Изменить почту",
  cityTitle: "Город для мэтчей",
  cityLead: "Выбери город, где ты сейчас готов ходить на свидания. Мы не сохраняем домашний адрес.",
  cityDetect: "Определить автоматически",
  cityDetecting: "Определяю город...",
  cityGeoMeta: "Используем геопозицию только для выбора города",
  citySearching: "Ищу город...",
  cityGeoUnavailable: "Не получилось открыть геолокацию. Выбери город через поиск.",
  cityGeoDenied: "Геолокация недоступна. Выбери город через поиск.",
  aiMemoryTitle: "Хочешь импортировать память из других AI-приложений, чтобы дать AI-матчмейкеру больше контекста о тебе?",
  aiMemoryAria: "ChatGPT, Claude и Gemini",
  aiMemoryAccept: "Да, подключить",
  aiMemoryAccepting: "Подключаю...",
  aiMemoryLater: "Позже",
  aiMemorySaving: "Сохраняю...",
  handoffMissingSession: "Сессия Mini App не синхронизирована. Открой вход из чата ещё раз.",
  handoffFailed: "Бот пока не смог продолжить. Попробуй ещё раз.",
  handoffReadyTitle: "Бот уже ждёт тебя",
  handoffTitle: "Передаю контекст боту",
  handoffLead: "Сейчас Gennety продолжит в чате, без лишних экранов.",
  retry: "Попробовать ещё раз",
  doneTitle: "Готово",
  doneLead: "Бот уже продолжил онбординг в чате. Закрой Mini App, когда будешь готов.",
  backToChat: "Вернуться в чат",
  syncingTitle: "Синхронизирую",
  syncingLead: "Проверяю состояние онбординга перед следующим шагом.",
  errors: {
    "Invalid university email": "Нужна корпоративная или университетская почта.",
    "invalid-email": "Нужна корпоративная или университетская почта.",
    "email-linked-to-other-account": "Эта почта уже привязана к другому Telegram аккаунту.",
    mismatch: "Код не совпал. Проверь письмо и попробуй ещё раз.",
    expired: "Код истёк. Запроси новый код ниже.",
    exhausted: "Слишком много попыток. Запроси новый код.",
    "otp-cooldown": "Новый код уже отправлен. Подожди несколько секунд.",
    "otp-send-failed": "Не удалось отправить письмо. Попробуй ещё раз.",
    "terms-required": "Сначала нужно принять условия.",
    "language-required": "Сначала выбери язык.",
    "ai-memory-preference-required": "Сначала выбери, хочешь ли подключить память из AI-приложений.",
    "invalid-ai-memory-preference": "Не получилось сохранить выбор. Попробуй ещё раз.",
    "email-required": "Сначала подтверди университетскую почту.",
    "location-required": "Сначала выбери город для мэтчей.",
    "Invalid initData": "Открой Mini App из чата с ботом, чтобы продолжить.",
    "Missing tma initData": "Открой Mini App из чата с ботом, чтобы продолжить.",
    "Empty initData": "Открой Mini App из чата с ботом, чтобы продолжить.",
  },
  genericError: "Что-то пошло не так. Попробуй ещё раз.",
};

const uk: OnboardingStrings = {
  ...en,
  back: "Назад",
  next: "Далі",
  hookTitle: "Скільки коштує знайти стосунки у 2026 році?",
  introLines: [
    ["Статистично лише 3% людей, які користуються сучасними дейтинг-застосунками, доходять до побачення"],
    ["Ми всі зациклені на роботі, навчанні чи самих собі"],
    ["Ми більше не знайомимось на вулицях"],
    ["Ми перестали бачитися наживо"],
    [
      "Складно розгледіти щось прекрасне в людині, коли перед тобою лише її цифровий аватар",
      " такий самий",
      " як і мільйони інших",
    ],
    ["Потрібні справжні зустрічі"],
    ["Але,", " скільки ж коштує знайти стосунки у 2026 році?"],
  ],
  exhaustionLines: [
    "Він погіршує твій стан і перетворює знайомства на ринок людей",
    "Нескінченний перебір людей, наче товарів, убиває емпатію",
    "Ти витрачаєш тижні на листування, які ні до чого не ведуть",
  ],
  statLabels: ["годин", "свайпів", "на покупки в застосунках"],
  statFootnote: "Стільки витрачає середній користувач сучасних застосунків для знайомств, щоб знайти стосунки.",
  pivotLines: [["Ми бачимо ці проблеми."], ["Тому ми створили ", "Gennety."]],
  howItWorksSteps: [
    {
      title: "Розкажи про себе — один раз",
      body: "Імпортуй памʼять свого AI або дай відповідь на кілька запитань. Жодних безкінечних анкет.",
    },
    {
      title: "Gennety знаходить одного",
      body: "Не стрічка й не свайпи — AI-сват підбирає того самого.",
    },
    {
      title: "Ви зустрічаєтесь наживо",
      body: "Без листувань. Час і місце беремо на себе — тобі лишається прийти.",
    },
  ],
  profileName: "Олександр, 28",
  profileRole: "Засновник tech-стартапу",
  profileAlt: "Портрет молодого професіонала",
  consentTitle: "Спочатку коротка формальність",
  consentLead: "Gennety підбирає людей за глибоким контекстом, тому нам потрібна твоя явна згода.",
  consentTermsPrefix: "Я приймаю умови сервісу та",
  consentPrivacy: "політику приватності",
  consentResearch: "Можна використовувати мої знеособлені дані для покращення матчмейкінгу.",
  continue: "Продовжити",
  saving: "Зберігаю...",
  languageTitle: "Обери мову",
  languageLead: "Бот і всі Mini App продовжать роботу обраною мовою.",
  emailTitle: "Університетська пошта",
  emailLead: "Це обов'язковий фільтр Gennety: пари підбираються в реальному студентському контексті.",
  emailSend: "Отримати код",
  emailSending: "Надсилаю...",
  emailMeta: "Якщо ти вже підтвердив пошту на сайті, цей екран буде пропущено.",
  otpTitle: "Код із листа",
  otpLead: (email) => `Ми надіслали 6-значний код на ${email}. Він діє недовго.`,
  otpDigit: (position) => `Цифра коду ${position}`,
  otpConfirm: "Підтвердити",
  otpChecking: "Перевіряю...",
  otpResend: "Надіслати код знову",
  otpResending: "Надсилаю...",
  otpResendIn: (seconds) => `Надіслати знову через ${seconds} с`,
  otpChangeEmail: "Змінити пошту",
  cityTitle: "Місто для метчів",
  cityLead: "Обери місто, де ти зараз готовий ходити на побачення. Ми не зберігаємо домашню адресу.",
  cityDetect: "Визначити автоматично",
  cityDetecting: "Визначаю місто...",
  cityGeoMeta: "Геопозицію використовуємо лише для вибору міста",
  citySearching: "Шукаю місто...",
  cityGeoUnavailable: "Не вдалося відкрити геолокацію. Обери місто через пошук.",
  cityGeoDenied: "Геолокація недоступна. Обери місто через пошук.",
  aiMemoryTitle: "Хочеш імпортувати пам'ять з інших AI-застосунків, щоб дати AI-матчмейкеру більше контексту про тебе?",
  aiMemoryAria: "ChatGPT, Claude і Gemini",
  aiMemoryAccept: "Так, підключити",
  aiMemoryAccepting: "Підключаю...",
  aiMemoryLater: "Пізніше",
  aiMemorySaving: "Зберігаю...",
  handoffMissingSession: "Сесію Mini App не синхронізовано. Відкрий вхід із чату ще раз.",
  handoffFailed: "Бот поки не зміг продовжити. Спробуй ще раз.",
  handoffReadyTitle: "Бот уже чекає на тебе",
  handoffTitle: "Передаю контекст боту",
  handoffLead: "Зараз Gennety продовжить у чаті без зайвих екранів.",
  retry: "Спробувати ще раз",
  doneTitle: "Готово",
  doneLead: "Бот уже продовжив онбординг у чаті. Закрий Mini App, коли будеш готовий.",
  backToChat: "Повернутися в чат",
  syncingTitle: "Синхронізую",
  syncingLead: "Перевіряю стан онбордингу перед наступним кроком.",
  errors: {
    ...en.errors,
    "Invalid university email": "Потрібна корпоративна або університетська пошта.",
    "invalid-email": "Потрібна корпоративна або університетська пошта.",
    "email-linked-to-other-account": "Ця пошта вже прив'язана до іншого Telegram-акаунта.",
    mismatch: "Код не збігається. Перевір лист і спробуй ще раз.",
    expired: "Термін коду минув. Запроси новий нижче.",
    exhausted: "Забагато спроб. Запроси новий код.",
    "otp-cooldown": "Новий код уже надіслано. Зачекай кілька секунд.",
    "otp-send-failed": "Не вдалося надіслати лист. Спробуй ще раз.",
    "terms-required": "Спочатку прийми умови.",
    "language-required": "Спочатку обери мову.",
    "ai-memory-preference-required": "Спочатку обери, чи підключати пам'ять з AI-застосунків.",
    "invalid-ai-memory-preference": "Не вдалося зберегти вибір. Спробуй ще раз.",
    "email-required": "Спочатку підтвердь університетську пошту.",
    "location-required": "Спочатку обери місто для метчів.",
    "Invalid initData": "Відкрий Mini App із чату з ботом, щоб продовжити.",
    "Missing tma initData": "Відкрий Mini App із чату з ботом, щоб продовжити.",
    "Empty initData": "Відкрий Mini App із чату з ботом, щоб продовжити.",
  },
  genericError: "Щось пішло не так. Спробуй ще раз.",
};

const de: OnboardingStrings = {
  ...en,
  back: "Zurück",
  next: "Weiter",
  hookTitle: "Was kostet es, 2026 eine Beziehung zu finden?",
  introLines: [
    ["Statistisch schaffen es nur 3% der Menschen in modernen Dating-Apps je zu einem Date"],
    ["Wir sind alle mit Arbeit, Studium oder uns selbst beschäftigt"],
    ["Wir lernen uns nicht mehr auf der Straße kennen"],
    ["Wir sehen uns nicht mehr persönlich"],
    [
      "Es ist schwer, etwas Schönes in einem Menschen zu sehen, wenn vor dir nur sein digitaler Avatar ist",
      " genauso einer",
      " wie Millionen andere",
    ],
    ["Wir brauchen echte Begegnungen"],
    ["Aber,", " was kostet es, 2026 eine Beziehung zu finden?"],
  ],
  exhaustionLines: [
    "Es belastet deine Psyche und macht Dating zu einem Menschenmarkt",
    "Endloses Durchsuchen von Menschen wie Produkten zerstört Empathie",
    "Du verbringst Wochen mit Chats, die nirgendwohin führen",
  ],
  statLabels: ["Stunden", "Swipes", "für In-App-Käufe"],
  statFootnote: "So viel gibt ein durchschnittlicher Nutzer moderner Dating-Apps aus, um eine Beziehung zu finden.",
  pivotLines: [["Wir sehen diese Probleme."], ["Deshalb haben wir ", "Gennety gebaut."]],
  howItWorksSteps: [
    {
      title: "Erzähl uns von dir — einmal",
      body: "Importiere das Gedächtnis deiner KI oder beantworte ein paar Fragen. Keine endlosen Formulare.",
    },
    {
      title: "Gennety findet die eine Person",
      body: "Kein Feed, kein Swipen — unser KI-Matchmaker wählt genau eine Person für dich.",
    },
    {
      title: "Ihr trefft euch persönlich",
      body: "Kein Chatten. Zeit und Ort übernehmen wir — du musst nur kommen.",
    },
  ],
  profileName: "Alexander, 28",
  profileRole: "Tech-Gründer",
  profileAlt: "Porträt eines jungen Berufstätigen",
  consentTitle: "Eine kurze Formalität",
  consentLead: "Gennety matcht Menschen anhand von tiefem Kontext. Deshalb brauchen wir vorab deine ausdrückliche Zustimmung.",
  consentTermsPrefix: "Ich akzeptiere die Nutzungsbedingungen und die",
  consentPrivacy: "Datenschutzerklärung",
  consentResearch: "Meine anonymisierten Daten dürfen zur Verbesserung des Matchmakings verwendet werden.",
  continue: "Weiter",
  saving: "Speichern...",
  languageTitle: "Wähle deine Sprache",
  languageLead: "Der Bot und alle Mini Apps werden in der gewählten Sprache fortfahren.",
  emailTitle: "Universitäts-E-Mail",
  emailLead: "Das ist ein Pflichtfilter von Gennety: Matches bleiben in einem echten studentischen Umfeld.",
  emailSend: "Code erhalten",
  emailSending: "Senden...",
  emailMeta: "Wenn du deine E-Mail bereits auf der Website bestätigt hast, wird dieser Bildschirm übersprungen.",
  otpTitle: "Code aus der E-Mail",
  otpLead: (email) => `Wir haben einen 6-stelligen Code an ${email} gesendet. Er läuft bald ab.`,
  otpDigit: (position) => `Codeziffer ${position}`,
  otpConfirm: "Bestätigen",
  otpChecking: "Prüfen...",
  otpResend: "Code erneut senden",
  otpResending: "Senden...",
  otpResendIn: (seconds) => `Erneut senden in ${seconds} Sek.`,
  otpChangeEmail: "E-Mail ändern",
  cityTitle: "Stadt für deine Matches",
  cityLead: "Wähle die Stadt, in der du aktuell auf Dates gehen möchtest. Deine Wohnadresse speichern wir nicht.",
  cityDetect: "Automatisch erkennen",
  cityDetecting: "Stadt wird erkannt...",
  cityGeoMeta: "Der Standort wird nur zur Auswahl der Stadt verwendet",
  citySearching: "Stadt wird gesucht...",
  cityGeoUnavailable: "Standortzugriff konnte nicht geöffnet werden. Wähle die Stadt über die Suche.",
  cityGeoDenied: "Standort ist nicht verfügbar. Wähle die Stadt über die Suche.",
  aiMemoryTitle: "Möchtest du Erinnerungen aus anderen AI-Apps importieren, damit dein AI-Matchmaker mehr Kontext über dich hat?",
  aiMemoryAria: "ChatGPT, Claude und Gemini",
  aiMemoryAccept: "Ja, verbinden",
  aiMemoryAccepting: "Verbinden...",
  aiMemoryLater: "Später",
  aiMemorySaving: "Speichern...",
  handoffMissingSession: "Die Mini-App-Sitzung ist nicht synchronisiert. Öffne sie erneut aus dem Chat.",
  handoffFailed: "Der Bot konnte noch nicht fortfahren. Versuch es erneut.",
  handoffReadyTitle: "Der Bot wartet auf dich",
  handoffTitle: "Kontext wird an den Bot übergeben",
  handoffLead: "Gennety macht gleich ohne zusätzliche Bildschirme im Chat weiter.",
  retry: "Erneut versuchen",
  doneTitle: "Fertig",
  doneLead: "Der Bot hat das Onboarding im Chat fortgesetzt. Schließe die Mini App, wenn du bereit bist.",
  backToChat: "Zurück zum Chat",
  syncingTitle: "Synchronisieren",
  syncingLead: "Dein Onboarding-Status wird vor dem nächsten Schritt geprüft.",
  errors: {
    ...en.errors,
    "Invalid university email": "Gib eine Firmen- oder Universitäts-E-Mail ein.",
    "invalid-email": "Gib eine Firmen- oder Universitäts-E-Mail ein.",
    "email-linked-to-other-account": "Diese E-Mail ist mit einem anderen Telegram-Konto verknüpft.",
    mismatch: "Der Code stimmt nicht. Prüfe die E-Mail und versuch es erneut.",
    expired: "Der Code ist abgelaufen. Fordere unten einen neuen an.",
    exhausted: "Zu viele Versuche. Fordere einen neuen Code an.",
    "otp-cooldown": "Ein neuer Code wurde bereits gesendet. Warte ein paar Sekunden.",
    "otp-send-failed": "Die E-Mail konnte nicht gesendet werden. Versuch es erneut.",
    "terms-required": "Akzeptiere zuerst die Bedingungen.",
    "language-required": "Wähle zuerst eine Sprache.",
    "ai-memory-preference-required": "Wähle zuerst, ob du Erinnerungen aus AI-Apps verbinden möchtest.",
    "invalid-ai-memory-preference": "Deine Auswahl konnte nicht gespeichert werden. Versuch es erneut.",
    "email-required": "Bestätige zuerst deine Universitäts-E-Mail.",
    "location-required": "Wähle zuerst deine Match-Stadt.",
    "Invalid initData": "Öffne die Mini App aus dem Bot-Chat, um fortzufahren.",
    "Missing tma initData": "Öffne die Mini App aus dem Bot-Chat, um fortzufahren.",
    "Empty initData": "Öffne die Mini App aus dem Bot-Chat, um fortzufahren.",
  },
  genericError: "Etwas ist schiefgelaufen. Versuch es erneut.",
};

const pl: OnboardingStrings = {
  ...en,
  back: "Wstecz",
  next: "Dalej",
  hookTitle: "Ile kosztuje znalezienie związku w 2026 roku?",
  introLines: [
    ["Statystycznie tylko 3% osób w nowoczesnych aplikacjach randkowych dochodzi do randki"],
    ["Wszyscy jesteśmy pochłonięci pracą, nauką albo sobą"],
    ["Już nie poznajemy się na ulicy"],
    ["Przestaliśmy widywać się na żywo"],
    [
      "Trudno dostrzec coś pięknego w człowieku, gdy masz przed sobą tylko jego cyfrowy awatar",
      " taki sam",
      " jak miliony innych",
    ],
    ["Potrzebujemy prawdziwych spotkań"],
    ["Ale,", " ile kosztuje znalezienie związku w 2026 roku?"],
  ],
  exhaustionLines: [
    "To obciąża psychikę i zmienia randkowanie w targ ludzi",
    "Niekończące się przeglądanie ludzi jak produktów zabija empatię",
    "Spędzasz tygodnie na rozmowach, które prowadzą donikąd",
  ],
  statLabels: ["godzin", "przesunięć", "na zakupy w aplikacjach"],
  statFootnote: "Tyle wydaje przeciętny użytkownik nowoczesnych aplikacji randkowych, aby znaleźć związek.",
  pivotLines: [["Widzimy te problemy."], ["Dlatego stworzyliśmy ", "Gennety."]],
  howItWorksSteps: [
    {
      title: "Opowiedz o sobie — raz",
      body: "Zaimportuj pamięć swojej AI albo odpowiedz na kilka pytań. Żadnych niekończących się ankiet.",
    },
    {
      title: "Gennety znajduje jedną osobę",
      body: "Bez kanału i bez przesuwania — nasz swat AI wybiera tę jedyną osobę.",
    },
    {
      title: "Spotykacie się na żywo",
      body: "Bez pisania. Czas i miejsce bierzemy na siebie — ty masz tylko przyjść.",
    },
  ],
  profileName: "Aleksander, 28",
  profileRole: "Założyciel startupu tech",
  profileAlt: "Portret młodego profesjonalisty",
  consentTitle: "Krótka formalność",
  consentLead: "Gennety dobiera ludzi na podstawie głębokiego kontekstu, dlatego potrzebujemy Twojej wyraźnej zgody.",
  consentTermsPrefix: "Akceptuję warunki usługi i",
  consentPrivacy: "politykę prywatności",
  consentResearch: "Moje zanonimizowane dane mogą służyć do ulepszania matchmakingu.",
  continue: "Dalej",
  saving: "Zapisywanie...",
  languageTitle: "Wybierz język",
  languageLead: "Bot i wszystkie Mini App będą działać w wybranym języku.",
  emailTitle: "E-mail uczelniany",
  emailLead: "To obowiązkowy filtr Gennety: dopasowania pozostają w prawdziwym środowisku studenckim.",
  emailSend: "Pobierz kod",
  emailSending: "Wysyłanie...",
  emailMeta: "Jeśli e-mail został już potwierdzony na stronie, ten ekran zostanie pominięty.",
  otpTitle: "Kod z e-maila",
  otpLead: (email) => `Wysłaliśmy 6-cyfrowy kod na ${email}. Wkrótce wygaśnie.`,
  otpDigit: (position) => `Cyfra kodu ${position}`,
  otpConfirm: "Potwierdź",
  otpChecking: "Sprawdzanie...",
  otpResend: "Wyślij kod ponownie",
  otpResending: "Wysyłanie...",
  otpResendIn: (seconds) => `Wyślij ponownie za ${seconds} s`,
  otpChangeEmail: "Zmień e-mail",
  cityTitle: "Miasto dopasowań",
  cityLead: "Wybierz miasto, w którym chcesz teraz chodzić na randki. Nie zapisujemy adresu domowego.",
  cityDetect: "Wykryj automatycznie",
  cityDetecting: "Wykrywanie miasta...",
  cityGeoMeta: "Lokalizacja służy wyłącznie do wyboru miasta",
  citySearching: "Szukanie miasta...",
  cityGeoUnavailable: "Nie udało się otworzyć lokalizacji. Wybierz miasto przez wyszukiwarkę.",
  cityGeoDenied: "Lokalizacja jest niedostępna. Wybierz miasto przez wyszukiwarkę.",
  aiMemoryTitle: "Chcesz zaimportować pamięć z innych aplikacji AI, aby Twój AI-matchmaker miał więcej kontekstu o Tobie?",
  aiMemoryAria: "ChatGPT, Claude i Gemini",
  aiMemoryAccept: "Tak, połącz",
  aiMemoryAccepting: "Łączenie...",
  aiMemoryLater: "Później",
  aiMemorySaving: "Zapisywanie...",
  handoffMissingSession: "Sesja Mini App nie jest zsynchronizowana. Otwórz ją ponownie z czatu.",
  handoffFailed: "Bot nie mógł jeszcze kontynuować. Spróbuj ponownie.",
  handoffReadyTitle: "Bot już na Ciebie czeka",
  handoffTitle: "Przekazuję kontekst do bota",
  handoffLead: "Gennety będzie kontynuować na czacie bez dodatkowych ekranów.",
  retry: "Spróbuj ponownie",
  doneTitle: "Gotowe",
  doneLead: "Bot kontynuuje onboarding na czacie. Zamknij Mini App, gdy będziesz gotowy.",
  backToChat: "Wróć do czatu",
  syncingTitle: "Synchronizacja",
  syncingLead: "Sprawdzamy stan onboardingu przed kolejnym krokiem.",
  errors: {
    ...en.errors,
    "Invalid university email": "Podaj firmowy lub uczelniany adres e-mail.",
    "invalid-email": "Podaj firmowy lub uczelniany adres e-mail.",
    "email-linked-to-other-account": "Ten e-mail jest połączony z innym kontem Telegram.",
    mismatch: "Kod się nie zgadza. Sprawdź e-mail i spróbuj ponownie.",
    expired: "Kod wygasł. Poproś o nowy poniżej.",
    exhausted: "Zbyt wiele prób. Poproś o nowy kod.",
    "otp-cooldown": "Nowy kod został już wysłany. Poczekaj kilka sekund.",
    "otp-send-failed": "Nie udało się wysłać e-maila. Spróbuj ponownie.",
    "terms-required": "Najpierw zaakceptuj warunki.",
    "language-required": "Najpierw wybierz język.",
    "ai-memory-preference-required": "Najpierw wybierz, czy połączyć pamięć z aplikacji AI.",
    "invalid-ai-memory-preference": "Nie udało się zapisać wyboru. Spróbuj ponownie.",
    "email-required": "Najpierw potwierdź uczelniany e-mail.",
    "location-required": "Najpierw wybierz miasto dopasowań.",
    "Invalid initData": "Otwórz Mini App z czatu z botem, aby kontynuować.",
    "Missing tma initData": "Otwórz Mini App z czatu z botem, aby kontynuować.",
    "Empty initData": "Otwórz Mini App z czatu z botem, aby kontynuować.",
  },
  genericError: "Coś poszło nie tak. Spróbuj ponownie.",
};

const strings: Record<Lang, OnboardingStrings> = { en, ru, uk, de, pl };

export function onboardingStrings(lang: Lang): OnboardingStrings {
  return strings[lang];
}

export function initialOnboardingLanguage(
  queryLanguage: string | null,
  telegramLanguage: string | undefined,
): Lang {
  return pickLang(queryLanguage ?? telegramLanguage);
}
