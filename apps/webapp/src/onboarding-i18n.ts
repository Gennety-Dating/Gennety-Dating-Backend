import { pickLang, type Lang } from "./i18n.js";

export interface OnboardingStrings {
  back: string;
  next: string;
  more: string;
  // Intro typewriter scenes, in play order (each is one auto-advancing screen).
  // Scene indices map to onboarding.tsx's visual dispatch (see onboarding-route).
  wasteLines: string[][]; // scene 0 — "modern apps eat your time" (+ app-icon reveal)
  burnoutLines: string[][]; // scene 1 — "we burn out first"
  cost2026Lines: string[][]; // scene 2 — "what does a relationship cost in 2026?"
  statHookLines: string[][]; // scene 4 — "only 3% ..." (after the stats drum)
  exhaustionLines: string[]; // scene 5 — swipe-simulator cycling lines
  statLabels: [string, string, string];
  statFootnote: string;
  pivotLines: string[][]; // scene 6 — "we see these problems / so we built Gennety"
  matchmakerLines: string[][]; // scene 7 — "you get a personal AI matchmaker"
  // scene 8 — an intro/explainer + gender selector, then a scripted chat demo of
  // the real Gennety decision flow (no swipe): partner card → "date with them?" →
  // yes → glass confirm → waiting → "it's mutual". Mirrors the shared product
  // copy; partner names are fixed English demo names.
  matchDemo: {
    introTitle: string; // bold headline on the intro screen (no specifics)
    choosePrompt: string;
    chooseWoman: string;
    chooseMan: string;
    man: { name: string; age: number; tagline: string; question: string }; // question = matchDecisionQuestionM
    woman: { name: string; age: number; tagline: string; question: string }; // question = matchDecisionQuestionF
    userYes: string;
    confirmLead: string; // = matchTextYesConfirm
    confirmGo: string; // = matchBtnConfirmGo
    goBack: string; // = matchBtnKeepDeciding
    waiting: string;
    mutual: string; // short form of matchBothAccepted
  };
  howItWorksSteps: Array<{ title: string; body: string }>;
  dateFlowSteps: Array<{ title: string; body: string }>;
  profileName: string;
  profileRole: string;
  profileAlt: string;
  consentTitle: string;
  consentLead: string;
  consentTermsPrefix: string;
  consentTerms: string;
  consentAnd: string;
  consentPrivacy: string;
  consentResearch: string;
  continue: string;
  saving: string;
  languageTitle: string;
  languageLead: string;
  // Registration v2 sign-up fork + phone gate (general track).
  pathTitle: string;
  pathLead: string;
  pathStudentTitle: string;
  pathStudentSub: string;
  pathGeneralTitle: string;
  pathGeneralSub: string;
  phoneTitle: string;
  phoneLead: string;
  phoneShare: string;
  phoneSharing: string;
  phoneMeta: string;
  phoneTimeout: string;
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
  themeTitle: string;
  themeLead: string;
  themeDark: string;
  themeLight: string;
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
  more: "Learn more",
  wasteLines: [["Modern dating apps eat up so much time on endless scrolling through profile after profile"]],
  burnoutLines: [["We burn out before we ever find our person"]],
  cost2026Lines: [["What does it cost to find a relationship in 2026?"]],
  statHookLines: [["Only 3% of people who use dating apps ever make it to a date"]],
  exhaustionLines: [
    "Endlessly browsing people like products.",
    "It feels more like scrolling a TikTok feed",
    "where people spend weeks searching",
    "and chats that lead nowhere",
  ],
  statLabels: ["hours", "swipes", "in in-app purchases"],
  statFootnote: "That's what the average user of modern dating apps spends to find a relationship.",
  pivotLines: [["We see these problems"], ["So we built ", "Gennety"]],
  matchmakerLines: [
    ["You get a personal AI matchmaker that works around the clock to find the person who perfectly fits you"],
  ],
  matchDemo: {
    introTitle: "Now — let's find your person. Here's how it works in Gennety.",
    choosePrompt: "Who should I show you?",
    chooseWoman: "A woman",
    chooseMan: "A man",
    man: {
      name: "Timur",
      age: 24,
      tagline: "Easy-going, but calm to be around",
      question: "So — want to go on a date with him?",
    },
    woman: {
      name: "Sonya",
      age: 21,
      tagline: "Warm and lively — laughs before you finish the joke",
      question: "So — want to go on a date with her?",
    },
    userYes: "Yes",
    confirmLead: "Love that ✨ Confirm below — and I'll take care of the rest:",
    confirmGo: "💫 Yes, I'm going",
    goBack: "← Go back",
    waiting: "Waiting for the other side…",
    mutual: "It's mutual 🤍",
  },
  howItWorksSteps: [
    {
      title: "Quick start",
      body: "Import your memory from ChatGPT or another AI chat and answer a few questions, so we understand who's right for you.",
    },
    {
      title: "We search 24/7",
      body: "Your personal AI matchmaker works around the clock, reading thousands of profiles to pick the one person who truly fits.",
    },
    {
      title: "Skip straight to the date",
      body: "No chat, no texting in Gennety — you just choose who to go on dates with. Your personal AI agents agree on a time that works for you both and pick the place.",
    },
  ],
  dateFlowSteps: [
    {
      title: "You both said yes",
      body: "The moment you both agree, your personal AI agents take it from there. No 'so when are you free?' — there's nothing to text.",
    },
    {
      title: "You pick when",
      body: "In a shared calendar you each mark the evenings you're free and see the other's picks live. The first time that works for you both becomes the date. If there are several — you choose.",
    },
    {
      title: "We pick where",
      body: "You name the vibe — a quiet cafe, a park walk, a small museum — and where you'll set off from. Your AI concierge finds a real, vetted spot near you both.",
    },
    {
      title: "Time and place are set",
      body: "You both get a card: the place, the address, a maps link, and the exact date and time.\n\nYou can always clarify any details right in the chat — a simple text or a voice message. Your personal agent knows everything about your date, so it'll point you the right way if anything comes up.",
    },
    {
      title: "Just before you meet",
      body: "A few hours before the date we'll share a little about your partner's interests: a favourite film, actor, sport and other facts that make it easy to start talking. Plus a couple of conversation tips.\n\nWe'll also open an urgent-cancel button, in case you suddenly can't make it.",
    },
    {
      title: "Then you tell us how it went",
      body: "The next day we'll ask how it went. Your honest feedback quietly sharpens who we pick for you next.",
    },
  ],
  profileName: "Alexander, 28",
  profileRole: "Tech founder",
  profileAlt: "Portrait of a young professional",
  consentTitle: "One quick formality",
  consentLead: "Gennety matches people using deep context, so we need your explicit consent before continuing.",
  consentTermsPrefix: "I accept the",
  consentTerms: "terms of service",
  consentAnd: "and",
  consentPrivacy: "privacy policy",
  consentResearch: "My anonymized data may be used to improve matchmaking.",
  continue: "Continue",
  saving: "Saving...",
  languageTitle: "Choose your language",
  languageLead: "The bot and every Mini App will continue in the selected language.",
  pathTitle: "How will you sign up?",
  pathLead: "Pick the path that fits you — students get perks.",
  pathStudentTitle: "With university email",
  pathStudentSub: "For students — unlocks perks.",
  pathGeneralTitle: "With phone number",
  pathGeneralSub: "One tap via Telegram. No SMS code.",
  phoneTitle: "Your phone number",
  phoneLead: "Verify in one tap — Telegram shares your number with us. No SMS code.",
  phoneShare: "Continue with my number",
  phoneSharing: "Confirming…",
  phoneMeta: "We use your number only to confirm you're a real person.",
  phoneTimeout: "Couldn't confirm your number. Try again.",
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
  aiMemoryTitle: "Would you like to import memory from other AI apps to give your personal AI matchmaker more context about you?",
  aiMemoryAria: "ChatGPT, Claude and Gemini",
  aiMemoryAccept: "Yes, connect",
  aiMemoryAccepting: "Connecting...",
  aiMemoryLater: "Later",
  aiMemorySaving: "Saving...",
  themeTitle: "Choose your look",
  themeLead: "Pick a theme for the app. You can change it anytime in Settings.",
  themeDark: "Dark",
  themeLight: "Light",
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
  more: "Подробнее",
  wasteLines: [["Современные приложения для знакомств съедают кучу времени на бесконечный перебор анкет"]],
  burnoutLines: [["Мы выгораем раньше, чем находим своего человека"]],
  cost2026Lines: [["Сколько стоит найти отношения в 2026 году?"]],
  statHookLines: [["Только 3% людей, которые пользуются приложениями для знакомств, доходят до свидания"]],
  exhaustionLines: [
    "Бесконечный перебор людей, как товаров.",
    "Больше похоже на скроллинг TikTok-ленты",
    "в которой люди тратят недели на поиск",
    "и переписки, которые ни к чему не приводят",
  ],
  statLabels: ["часов", "свайпов", "на покупки внутри приложений"],
  statFootnote: "Столько тратит средний пользователь современных приложений для знакомств, чтобы найти отношения.",
  pivotLines: [["Мы видим эти проблемы"], ["Поэтому мы создали ", "Gennety"]],
  matchmakerLines: [
    ["У тебя будет личный AI-матчмейкер, который работает круглосуточно и находит идеально подходящую тебе пару"],
  ],
  matchDemo: {
    introTitle: "Сейчас найдём твоего человека. Вот как это работает в Gennety.",
    choosePrompt: "Кого тебе показать?",
    chooseWoman: "Девушку",
    chooseMan: "Парня",
    man: {
      name: "Timur",
      age: 24,
      tagline: "Лёгкий на подъём, но рядом с ним спокойно",
      question: "Ну что — хочешь пойти с ним на свидание?",
    },
    woman: {
      name: "Sonya",
      age: 21,
      tagline: "Тёплая и живая, смеётся раньше, чем дошутишь",
      question: "Ну что — хочешь пойти с ней на свидание?",
    },
    userYes: "Да",
    confirmLead: "Отлично ✨ Подтверди — и дальше всё сделаю я:",
    confirmGo: "💫 Да, иду на свидание",
    goBack: "← Назад",
    waiting: "Ждём ответа второй стороны…",
    mutual: "Взаимно 🤍",
  },
  howItWorksSteps: [
    {
      title: "Быстрый вход",
      body: "Импортируй память из ChatGPT или другого AI-чата и ответь на несколько вопросов, чтобы мы лучше понимали, какой человек тебе подойдёт.",
    },
    {
      title: "Мы ищем 24/7",
      body: "Личный AI-матчмейкер работает круглосуточно и из тысяч профилей выбирает того, кто действительно подходит.",
    },
    {
      title: "Сразу к свиданию",
      body: "В Gennety нет чата и переписок — ты только выбираешь, с кем ходить на свидания. А удобное вам обоим время и место согласуют ваши личные AI-агенты.",
    },
  ],
  dateFlowSteps: [
    {
      title: "Вы оба сказали «да»",
      body: "Как только оба согласились, дальше всё берут на себя ваши личные AI-агенты. Никаких «ну что, когда удобно?» — переписываться не нужно.",
    },
    {
      title: "Ты выбираешь, когда",
      body: "В общем календаре каждый отмечает свободные вечера и видит выбор другого вживую. Первое время, что подходит обоим, становится свиданием. Если их несколько — выбираешь ты.",
    },
    {
      title: "Мы выбираем, где",
      body: "Ты говоришь вайб — тихое кафе, прогулка в парке, маленький музей — и откуда поедешь. AI-консьерж находит реально проверенное место рядом с вами.",
    },
    {
      title: "Место и время согласованы",
      body: "Вы оба получаете карточку: место, адрес, ссылку на карту и точные дату и время.\n\nУ тебя всегда есть возможность уточнить детали прямо в чате простым сообщением или голосовым сообщением. Твой личный агент знает все детали твоей встречи, поэтому сориентирует если что.",
    },
    {
      title: "Перед самой встречей",
      body: "За несколько часов до свидания мы дадим краткую информацию об увлечениях партнёра: любимый фильм, актёр, вид спорта и другие факты, которые помогут легко начать диалог. Также ты получишь пару советов для общения.\n\nКроме того, откроется кнопка срочной отмены свидания — на случай, если ты вдруг не сможешь прийти.",
    },
    {
      title: "А потом расскажешь, как прошло",
      body: "На следующий день спросим, как всё прошло. Твой честный отзыв тихо улучшает то, кого мы подберём дальше.",
    },
  ],
  profileName: "Александр, 28",
  profileRole: "Основатель tech-стартапа",
  profileAlt: "Портрет молодого профессионала",
  consentTitle: "Сначала короткая формальность",
  consentLead: "Gennety подбирает людей по глубокому контексту, поэтому нам нужно явное согласие перед продолжением.",
  consentTermsPrefix: "Я принимаю",
  consentTerms: "условия использования",
  consentAnd: "и",
  consentPrivacy: "политику конфиденциальности",
  consentResearch: "Можно использовать мои обезличенные данные для улучшения матчмейкинга.",
  continue: "Продолжить",
  saving: "Сохраняю...",
  languageTitle: "Выбери язык",
  languageLead: "Бот и все Mini App продолжат работу на выбранном языке.",
  pathTitle: "Как регистрируемся?",
  pathLead: "Выбери свой способ — студентам достаются бонусы.",
  pathStudentTitle: "По университетской почте",
  pathStudentSub: "Для студентов — открывает бонусы.",
  pathGeneralTitle: "По номеру телефона",
  pathGeneralSub: "В один тап через Telegram. Без SMS-кода.",
  phoneTitle: "Твой номер телефона",
  phoneLead: "Подтверди в один тап — Telegram передаст нам твой номер. Без SMS-кода.",
  phoneShare: "Продолжить с моим номером",
  phoneSharing: "Подтверждаю…",
  phoneMeta: "Номер нужен только чтобы подтвердить, что ты реальный человек.",
  phoneTimeout: "Не удалось подтвердить номер. Попробуй ещё раз.",
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
  aiMemoryTitle: "Хочешь импортировать память из других AI-приложений, чтобы дать личному AI-матчмейкеру больше контекста о тебе?",
  aiMemoryAria: "ChatGPT, Claude и Gemini",
  aiMemoryAccept: "Да, подключить",
  aiMemoryAccepting: "Подключаю...",
  aiMemoryLater: "Позже",
  aiMemorySaving: "Сохраняю...",
  themeTitle: "Выбери оформление",
  themeLead: "Выбери тему приложения. Поменять можно в любой момент в настройках.",
  themeDark: "Тёмная",
  themeLight: "Светлая",
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
  more: "Детальніше",
  wasteLines: [["Сучасні застосунки для знайомств зʼїдають купу часу на безкінечний перебір анкет"]],
  burnoutLines: [["Ми вигораємо раніше, ніж знаходимо свою людину"]],
  cost2026Lines: [["Скільки коштує знайти стосунки у 2026 році?"]],
  statHookLines: [["Лише 3% людей, які користуються застосунками для знайомств, доходять до побачення"]],
  exhaustionLines: [
    "Нескінченний перебір людей, наче товарів.",
    "Більше схоже на скролінг стрічки TikTok",
    "де люди витрачають тижні на пошук",
    "і листування, які ні до чого не ведуть",
  ],
  statLabels: ["годин", "свайпів", "на покупки в застосунках"],
  statFootnote: "Стільки витрачає середній користувач сучасних застосунків для знайомств, щоб знайти стосунки.",
  pivotLines: [["Ми бачимо ці проблеми"], ["Тому ми створили ", "Gennety"]],
  matchmakerLines: [
    ["У тебе буде особистий AI-матчмейкер, який працює цілодобово й знаходить ідеально підходящу тобі пару"],
  ],
  matchDemo: {
    introTitle: "Зараз знайдемо твою людину. Ось як це працює в Gennety.",
    choosePrompt: "Кого тобі показати?",
    chooseWoman: "Дівчину",
    chooseMan: "Хлопця",
    man: {
      name: "Timur",
      age: 24,
      tagline: "Легкий на підйом, але поруч з ним спокійно",
      question: "Хочеш піти з ним на побачення?",
    },
    woman: {
      name: "Sonya",
      age: 21,
      tagline: "Тепла і жива, сміється раніше, ніж дожартуєш",
      question: "Хочеш піти з нею на побачення?",
    },
    userYes: "Так",
    confirmLead: "Чудово ✨ Підтверди — і далі все зроблю я:",
    confirmGo: "💫 Так, іду на побачення",
    goBack: "← Назад",
    waiting: "Чекаємо на відповідь іншої сторони…",
    mutual: "Взаємно 🤍",
  },
  howItWorksSteps: [
    {
      title: "Швидкий вхід",
      body: "Імпортуй памʼять з ChatGPT чи іншого AI-чату та дай відповідь на кілька запитань, щоб ми краще розуміли, яка людина тобі підійде.",
    },
    {
      title: "Ми шукаємо 24/7",
      body: "Особистий AI-матчмейкер працює цілодобово й з тисяч профілів обирає того, хто справді підходить.",
    },
    {
      title: "Одразу до побачення",
      body: "У Gennety немає чату й листувань — ти лише обираєш, з ким ходити на побачення. А зручний для вас обох час і місце узгоджують ваші особисті AI-агенти.",
    },
  ],
  dateFlowSteps: [
    {
      title: "Ви обоє сказали «так»",
      body: "Щойно обоє погодились, далі все беруть на себе ваші особисті AI-агенти. Жодних «ну що, коли зручно?» — листуватися не треба.",
    },
    {
      title: "Ти обираєш, коли",
      body: "У спільному календарі кожен позначає вільні вечори й бачить вибір іншого вживу. Перший час, що підходить обом, стає побаченням. Якщо їх кілька — обираєш ти.",
    },
    {
      title: "Ми обираємо, де",
      body: "Ти кажеш вайб — тихе кафе, прогулянка в парку, маленький музей — і звідки поїдеш. AI-консьєрж знаходить реально перевірене місце поруч із вами.",
    },
    {
      title: "Місце й час узгоджені",
      body: "Ви обоє отримуєте картку: місце, адресу, посилання на карту й точні дату та час.\n\nУ тебе завжди є можливість уточнити деталі прямо в чаті — звичайним повідомленням або голосовим. Твій особистий агент знає всі деталі твоєї зустрічі, тож зорієнтує, якщо що.",
    },
    {
      title: "Перед самою зустріччю",
      body: "За кілька годин до побачення ми дамо коротку інформацію про захоплення партнера: улюблений фільм, актор, вид спорту та інші факти, які допоможуть легко почати діалог. Також ти отримаєш пару порад для спілкування.\n\nКрім того, відкриється кнопка термінового скасування побачення — на випадок, якщо ти раптом не зможеш прийти.",
    },
    {
      title: "А потім розкажеш, як минуло",
      body: "Наступного дня спитаємо, як усе минуло. Твій чесний відгук тихо покращує те, кого ми підберемо далі.",
    },
  ],
  profileName: "Олександр, 28",
  profileRole: "Засновник tech-стартапу",
  profileAlt: "Портрет молодого професіонала",
  consentTitle: "Спочатку коротка формальність",
  consentLead: "Gennety підбирає людей за глибоким контекстом, тому нам потрібна твоя явна згода.",
  consentTermsPrefix: "Я приймаю",
  consentTerms: "умови використання",
  consentAnd: "та",
  consentPrivacy: "політику конфіденційності",
  consentResearch: "Можна використовувати мої знеособлені дані для покращення матчмейкінгу.",
  continue: "Продовжити",
  saving: "Зберігаю...",
  languageTitle: "Обери мову",
  languageLead: "Бот і всі Mini App продовжать роботу обраною мовою.",
  pathTitle: "Як реєструємось?",
  pathLead: "Обери свій спосіб — студентам дістаються бонуси.",
  pathStudentTitle: "За університетською поштою",
  pathStudentSub: "Для студентів — відкриває бонуси.",
  pathGeneralTitle: "За номером телефону",
  pathGeneralSub: "В один тап через Telegram. Без SMS-коду.",
  phoneTitle: "Твій номер телефону",
  phoneLead: "Підтверди в один тап — Telegram передасть нам твій номер. Без SMS-коду.",
  phoneShare: "Продовжити з моїм номером",
  phoneSharing: "Підтверджую…",
  phoneMeta: "Номер потрібен лише щоб підтвердити, що ти реальна людина.",
  phoneTimeout: "Не вдалося підтвердити номер. Спробуй ще раз.",
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
  aiMemoryTitle: "Хочеш імпортувати пам'ять з інших AI-застосунків, щоб дати особистому AI-матчмейкеру більше контексту про тебе?",
  aiMemoryAria: "ChatGPT, Claude і Gemini",
  aiMemoryAccept: "Так, підключити",
  aiMemoryAccepting: "Підключаю...",
  aiMemoryLater: "Пізніше",
  aiMemorySaving: "Зберігаю...",
  themeTitle: "Обери вигляд",
  themeLead: "Обери тему застосунку. Змінити можна будь-коли в налаштуваннях.",
  themeDark: "Темна",
  themeLight: "Світла",
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
  more: "Mehr erfahren",
  wasteLines: [["Moderne Dating-Apps fressen so viel Zeit mit endlosem Scrollen, Profil um Profil"]],
  burnoutLines: [["Wir brennen aus, bevor wir unseren Menschen finden"]],
  cost2026Lines: [["Was kostet es, 2026 eine Beziehung zu finden?"]],
  statHookLines: [["Nur 3% der Menschen, die Dating-Apps nutzen, schaffen es je zu einem Date"]],
  exhaustionLines: [
    "Endloses Durchblättern von Menschen wie Produkten.",
    "Es fühlt sich eher an wie das Scrollen durch einen TikTok-Feed",
    "in dem man Wochen mit Suchen verbringt",
    "und Chats, die zu nichts führen",
  ],
  statLabels: ["Stunden", "Swipes", "für In-App-Käufe"],
  statFootnote: "So viel gibt ein durchschnittlicher Nutzer moderner Dating-Apps aus, um eine Beziehung zu finden.",
  pivotLines: [["Wir sehen diese Probleme"], ["Deshalb haben wir ", "Gennety gebaut"]],
  matchmakerLines: [
    ["Du bekommst einen persönlichen KI-Matchmaker, der rund um die Uhr die Person findet, die perfekt zu dir passt"],
  ],
  matchDemo: {
    introTitle: "Jetzt finden wir deinen Menschen. So funktioniert es bei Gennety.",
    choosePrompt: "Wen soll ich dir zeigen?",
    chooseWoman: "Eine Frau",
    chooseMan: "Einen Mann",
    man: {
      name: "Timur",
      age: 24,
      tagline: "Unkompliziert, aber angenehm ruhig",
      question: "Und — willst du mit ihm auf ein Date gehen?",
    },
    woman: {
      name: "Sonya",
      age: 21,
      tagline: "Warm und lebendig — lacht, bevor du die Pointe erreichst",
      question: "Und — willst du mit ihr auf ein Date gehen?",
    },
    userYes: "Ja",
    confirmLead: "Stark ✨ Bestätige unten — den Rest übernehme ich:",
    confirmGo: "💫 Ja, ich gehe hin",
    goBack: "← Zurück",
    waiting: "Warten auf die andere Person…",
    mutual: "Beidseitig 🤍",
  },
  howItWorksSteps: [
    {
      title: "Schneller Einstieg",
      body: "Importiere dein Gedächtnis aus ChatGPT oder einem anderen KI-Chat und beantworte ein paar Fragen, damit wir besser verstehen, wer zu dir passt.",
    },
    {
      title: "Wir suchen rund um die Uhr",
      body: "Dein persönlicher KI-Matchmaker arbeitet rund um die Uhr und wählt aus Tausenden Profilen genau die Person, die wirklich passt.",
    },
    {
      title: "Direkt zum Date",
      body: "In Gennety gibt es keinen Chat und kein Schreiben — du wählst nur, mit wem du auf ein Date gehst. Eure persönlichen KI-Agenten stimmen eine für euch beide passende Zeit ab und suchen den Ort aus.",
    },
  ],
  dateFlowSteps: [
    {
      title: "Ihr habt beide Ja gesagt",
      body: "Sobald ihr beide zustimmt, übernehmen eure persönlichen KI-Agenten. Kein 'und, wann passt's?' — du musst nichts schreiben.",
    },
    {
      title: "Du wählst, wann",
      body: "In einem gemeinsamen Kalender markiert jeder die freien Abende und sieht die Auswahl des anderen live. Die erste Zeit, die euch beiden passt, wird zum Date. Gibt es mehrere — wählst du.",
    },
    {
      title: "Wir wählen, wo",
      body: "Du nennst die Stimmung — ruhiges Café, Spaziergang im Park, kleines Museum — und von wo du losfährst. Dein KI-Concierge findet einen echten, geprüften Ort in eurer Nähe.",
    },
    {
      title: "Zeit und Ort stehen",
      body: "Ihr bekommt beide eine Karte: Ort, Adresse, einen Karten-Link und das genaue Datum mit Uhrzeit.\n\nDu kannst Details jederzeit direkt im Chat klären — per einfacher Nachricht oder Sprachnachricht. Dein persönlicher Agent kennt alle Details eures Treffens und hilft dir weiter, falls etwas unklar ist.",
    },
    {
      title: "Kurz vor dem Treffen",
      body: "Ein paar Stunden vor dem Date geben wir dir ein paar Infos zu den Interessen deines Partners: Lieblingsfilm, Schauspieler, Sportart und andere Fakten, mit denen sich leicht ein Gespräch beginnen lässt. Dazu ein paar Tipps fürs Gespräch.\n\nAußerdem öffnet sich ein Button für die kurzfristige Absage — falls du doch nicht kommen kannst.",
    },
    {
      title: "Danach erzählst du, wie es war",
      body: "Am nächsten Tag fragen wir, wie es gelaufen ist. Dein ehrliches Feedback schärft leise, wen wir als Nächstes für dich auswählen.",
    },
  ],
  profileName: "Alexander, 28",
  profileRole: "Tech-Gründer",
  profileAlt: "Porträt eines jungen Berufstätigen",
  consentTitle: "Eine kurze Formalität",
  consentLead: "Gennety matcht Menschen anhand von tiefem Kontext. Deshalb brauchen wir vorab deine ausdrückliche Zustimmung.",
  consentTermsPrefix: "Ich akzeptiere die",
  consentTerms: "Nutzungsbedingungen",
  consentAnd: "und die",
  consentPrivacy: "Datenschutzerklärung",
  consentResearch: "Meine anonymisierten Daten dürfen zur Verbesserung des Matchmakings verwendet werden.",
  continue: "Weiter",
  saving: "Speichern...",
  languageTitle: "Wähle deine Sprache",
  languageLead: "Der Bot und alle Mini Apps werden in der gewählten Sprache fortfahren.",
  pathTitle: "Wie möchtest du dich anmelden?",
  pathLead: "Wähl deinen Weg — Studierende bekommen Extras.",
  pathStudentTitle: "Mit Universitäts-E-Mail",
  pathStudentSub: "Für Studierende — schaltet Extras frei.",
  pathGeneralTitle: "Mit Telefonnummer",
  pathGeneralSub: "Ein Tipp über Telegram. Kein SMS-Code.",
  phoneTitle: "Deine Telefonnummer",
  phoneLead: "Mit einem Tipp bestätigen — Telegram teilt uns deine Nummer. Kein SMS-Code.",
  phoneShare: "Mit meiner Nummer fortfahren",
  phoneSharing: "Bestätige…",
  phoneMeta: "Wir nutzen deine Nummer nur, um zu bestätigen, dass du echt bist.",
  phoneTimeout: "Nummer konnte nicht bestätigt werden. Versuch es gleich noch mal.",
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
  aiMemoryTitle: "Möchtest du Erinnerungen aus anderen KI-Apps importieren, damit dein persönlicher KI-Matchmaker mehr Kontext über dich hat?",
  aiMemoryAria: "ChatGPT, Claude und Gemini",
  aiMemoryAccept: "Ja, verbinden",
  aiMemoryAccepting: "Verbinden...",
  aiMemoryLater: "Später",
  aiMemorySaving: "Speichern...",
  themeTitle: "Wähle dein Design",
  themeLead: "Wähle ein Theme für die App. Du kannst es jederzeit in den Einstellungen ändern.",
  themeDark: "Dunkel",
  themeLight: "Hell",
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
  more: "Więcej",
  wasteLines: [["Współczesne aplikacje randkowe pochłaniają mnóstwo czasu na bezustanne przewijanie profilu za profilem"]],
  burnoutLines: [["Wypalamy się, zanim znajdziemy swojego człowieka"]],
  cost2026Lines: [["Ile kosztuje znalezienie związku w 2026 roku?"]],
  statHookLines: [["Tylko 3% osób, które korzystają z aplikacji randkowych, dochodzi do randki"]],
  exhaustionLines: [
    "Niekończące się przeglądanie ludzi jak produktów.",
    "Bardziej przypomina to przewijanie feedu TikToka",
    "w którym ludzie spędzają tygodnie na szukaniu",
    "i rozmowy, które prowadzą donikąd",
  ],
  statLabels: ["godzin", "przesunięć", "na zakupy w aplikacjach"],
  statFootnote: "Tyle wydaje przeciętny użytkownik nowoczesnych aplikacji randkowych, aby znaleźć związek.",
  pivotLines: [["Widzimy te problemy"], ["Dlatego stworzyliśmy ", "Gennety"]],
  matchmakerLines: [
    ["Dostajesz osobistego AI-matchmakera, który działa całą dobę i znajduje osobę idealnie do ciebie dopasowaną"],
  ],
  matchDemo: {
    introTitle: "Teraz znajdziemy twoją osobę. Tak to działa w Gennety.",
    choosePrompt: "Kogo mam ci pokazać?",
    chooseWoman: "Kobietę",
    chooseMan: "Mężczyznę",
    man: {
      name: "Timur",
      age: 24,
      tagline: "Lekki na start, ale spokojnie przy nim",
      question: "No i jak — chcesz iść z nim na randkę?",
    },
    woman: {
      name: "Sonya",
      age: 21,
      tagline: "Ciepła i żywa — śmieje się, zanim skończysz żart",
      question: "No i jak — chcesz iść z nią na randkę?",
    },
    userYes: "Tak",
    confirmLead: "Świetnie ✨ Potwierdź poniżej — resztą zajmę się ja:",
    confirmGo: "💫 Tak, idę na randkę",
    goBack: "← Wróć",
    waiting: "Czekamy na drugą osobę…",
    mutual: "Wzajemne 🤍",
  },
  howItWorksSteps: [
    {
      title: "Szybki start",
      body: "Zaimportuj pamięć z ChatGPT lub innego czatu AI i odpowiedz na kilka pytań, żebyśmy lepiej rozumieli, kto do ciebie pasuje.",
    },
    {
      title: "Szukamy 24/7",
      body: "Twój osobisty AI-matchmaker działa całą dobę i z tysięcy profili wybiera osobę, która naprawdę pasuje.",
    },
    {
      title: "Od razu na randkę",
      body: "W Gennety nie ma czatu ani pisania — wybierasz tylko, z kim chodzić na randki. A dogodny dla was obojga czas i miejsce ustalają wasi osobiści agenci AI.",
    },
  ],
  dateFlowSteps: [
    {
      title: "Oboje powiedzieliście „tak”",
      body: "Gdy tylko oboje się zgodzicie, dalej wszystkim zajmują się wasi osobiści agenci AI. Żadnego „no to kiedy ci pasuje?” — nie trzeba pisać.",
    },
    {
      title: "Ty wybierasz, kiedy",
      body: "We wspólnym kalendarzu każdy zaznacza wolne wieczory i na żywo widzi wybór drugiej osoby. Pierwszy termin, który pasuje wam obojgu, staje się randką. Jeśli jest ich kilka — wybierasz ty.",
    },
    {
      title: "My wybieramy, gdzie",
      body: "Mówisz, jaki klimat chcesz — cicha kawiarnia, spacer po parku, małe muzeum — i skąd wyruszysz. Twój konsjerż AI znajduje prawdziwe, sprawdzone miejsce blisko was.",
    },
    {
      title: "Czas i miejsce ustalone",
      body: "Oboje dostajecie kartę: miejsce, adres, link do mapy oraz dokładną datę i godzinę.\n\nZawsze możesz doprecyzować szczegóły bezpośrednio na czacie — zwykłą wiadomością lub głosową. Twój osobisty agent zna wszystkie szczegóły waszego spotkania, więc podpowie, gdyby co.",
    },
    {
      title: "Tuż przed spotkaniem",
      body: "Kilka godzin przed randką damy ci krótką informację o zainteresowaniach partnera: ulubiony film, aktor, sport i inne fakty, które pomogą łatwo zacząć rozmowę. A także parę wskazówek do rozmowy.\n\nOprócz tego pojawi się przycisk pilnego odwołania randki — na wypadek, gdybyś nagle nie mógł przyjść.",
    },
    {
      title: "A potem opowiesz, jak poszło",
      body: "Następnego dnia zapytamy, jak poszło. Twoja szczera opinia po cichu poprawia to, kogo dobierzemy dalej.",
    },
  ],
  profileName: "Aleksander, 28",
  profileRole: "Założyciel startupu tech",
  profileAlt: "Portret młodego profesjonalisty",
  consentTitle: "Krótka formalność",
  consentLead: "Gennety dobiera ludzi na podstawie głębokiego kontekstu, dlatego potrzebujemy Twojej wyraźnej zgody.",
  consentTermsPrefix: "Akceptuję",
  consentTerms: "warunki usługi",
  consentAnd: "i",
  consentPrivacy: "politykę prywatności",
  consentResearch: "Moje zanonimizowane dane mogą służyć do ulepszania matchmakingu.",
  continue: "Dalej",
  saving: "Zapisywanie...",
  languageTitle: "Wybierz język",
  languageLead: "Bot i wszystkie Mini App będą działać w wybranym języku.",
  pathTitle: "Jak chcesz się zarejestrować?",
  pathLead: "Wybierz swoją ścieżkę — studenci dostają bonusy.",
  pathStudentTitle: "Przez e-mail uczelniany",
  pathStudentSub: "Dla studentów — odblokowuje bonusy.",
  pathGeneralTitle: "Przez numer telefonu",
  pathGeneralSub: "Jednym dotknięciem przez Telegram. Bez kodu SMS.",
  phoneTitle: "Twój numer telefonu",
  phoneLead: "Potwierdź jednym dotknięciem — Telegram udostępni nam Twój numer. Bez kodu SMS.",
  phoneShare: "Kontynuuj z moim numerem",
  phoneSharing: "Potwierdzam…",
  phoneMeta: "Numer służy tylko do potwierdzenia, że jesteś prawdziwą osobą.",
  phoneTimeout: "Nie udało się potwierdzić numeru. Spróbuj ponownie.",
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
  aiMemoryTitle: "Chcesz zaimportować pamięć z innych aplikacji AI, aby Twój osobisty AI-matchmaker miał więcej kontekstu o Tobie?",
  aiMemoryAria: "ChatGPT, Claude i Gemini",
  aiMemoryAccept: "Tak, połącz",
  aiMemoryAccepting: "Łączenie...",
  aiMemoryLater: "Później",
  aiMemorySaving: "Zapisywanie...",
  themeTitle: "Wybierz wygląd",
  themeLead: "Wybierz motyw aplikacji. Możesz go zmienić w każdej chwili w ustawieniach.",
  themeDark: "Ciemny",
  themeLight: "Jasny",
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
