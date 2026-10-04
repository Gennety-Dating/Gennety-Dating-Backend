import { pickLang, type Lang } from "./i18n.js";

export interface OnboardingStrings {
  back: string;
  next: string;
  more: string;
  // Intro scenes, in play order (each is one auto-advancing screen). Scene
  // indices map to onboarding.tsx's visual dispatch (see onboarding-route).
  //
  // The six market-critique scenes that used to open this sequence — "apps eat
  // your time" + the competitor-icon rise, the burnout line + their crumble,
  // "what does a relationship cost", the statistics drum, "only 3% reach a
  // date", and the swipe simulator — were removed on 2026-08-20 (founder
  // decision, DECISIONS.md). Their strings went with them: a user who has
  // pressed Start has already decided to try, so arguing that the old apps are
  // bad is advertising's job, done before the install.
  pivotLines: string[][]; // scene 0 — "dating should lead to a meeting / so we built Gennety"
  matchmakerLines: string[][]; // scene 1 — "you get a personal AI matchmaker"
  howItWorksSteps: Array<{ title: string; body: string }>; // scene 2
  dateFlowSteps: Array<{ title: string; body: string }>;
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
  // Registration v2 sign-up fork + phone gate (general track).
  pathTitle: string;
  pathStudentTitle: string;
  pathStudentSub: string;
  pathGeneralTitle: string;
  pathGeneralSub: string;
  phoneTitle: string;
  phoneLead: string;
  phoneShare: string;
  phoneSharing: string;
  phoneTimeout: string;
  emailTitle: string;
  emailLead: string;
  emailSend: string;
  emailSending: string;
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
  cityPlaceholder: string;
  citySearching: string;
  cityGeoUnavailable: string;
  cityGeoDenied: string;
  /** Shown when geolocation / search lands outside every launched market. */
  cityOutsideMarket: string;
  /** Chip on a picker option we have not launched in. */
  cityComingSoon: string;
  /** Country group headers in the picker, by ISO-3166 alpha-2 code. */
  cityCountries: Record<string, string>;
  // The city-waitlist screen (the phase registration ENDS on for a city we
  // have not opened). `{city}` is the canonical city name from the catalog.
  waitlistTitle: (city: string) => string;
  waitlistLead: (city: string) => string;
  waitlistChangeCity: string;
  waitlistChanging: string;
  // Referral invite screen (§Referral) — shown once to an invited user. Grants
  // nothing itself: the invitee's Date Tickets land when THEY pass
  // verification. `{name}` is the referrer; `{ticketsPhrase}` a declined
  // "N date tickets" from `ticketsPhrase()` in i18n.ts.
  referralGiftTitle: string;
  referralGiftTitleNoName: string;
  referralGiftBody: string;
  referralGiftBodyNoName: string;
  referralGiftContinue: string;
  referralGiftBusy: string;
  // Promo welcome gift (PROMO_CODES_PRODUCT_SPEC.md) — the richer wow screen.
  promoGiftTitle: string;
  promoGiftTicketLine: string;
  promoGiftMonthsLine: string;
  promoGiftContinue: string;
  promoGiftClaiming: string;
  themeTitle: string;
  themeDark: string;
  themeLight: string;
  // The Mini App's own profile screens (PRODUCT_SPEC §1.3). Deliberately just a
  // question per screen — the control IS the explanation, so there are no lead
  // lines, no helper copy and no units spelled out anywhere but the drum.
  basicsNameTitle: string;
  basicsNamePlaceholder: string;
  basicsAgeTitle: string;
  basicsGenderTitle: string;
  basicsGenderMale: string;
  basicsGenderFemale: string;
  basicsPreferenceTitle: string;
  basicsPreferenceMen: string;
  basicsPreferenceWomen: string;
  basicsPreferenceBoth: string;
  basicsHeightTitle: string;
  basicsHeightUnit: string;
  // Relationship intent (PRODUCT_SPEC §1.3). The four labels ARE the axis: each
  // has to read as a taste, never as a confession, or social desirability drags
  // everyone toward the respectable end and the answer stops measuring anything.
  basicsIntentTitle: string;
  basicsIntentSpark: string;
  basicsIntentOpen: string;
  basicsIntentFalling: string;
  basicsIntentLongterm: string;
  /** Footnote under the options — the one place the owner is told nobody else
   *  sees this. Positive rather than a bare "not visible": on this screen the
   *  first question is "why are you asking", not "who will see it". */
  basicsIntentPrivate: string;
  handoffMissingSession: string;
  handoffFailed: string;
  handoffReadyTitle: string;
  handoffTitle: string;
  retry: string;
  doneTitle: string;
  doneLead: string;
  backToChat: string;
  syncingTitle: string;
  errors: Record<string, string>;
  genericError: string;
}

const en: OnboardingStrings = {
  back: "Go back",
  next: "Next",
  more: "Learn more",
  pivotLines: [["Dating is for meeting up, not for texting"], ["So we built ", "Gennety"]],
  matchmakerLines: [["Gennety looks for your match around the clock"]],
  howItWorksSteps: [
    {
      title: "Tell us about you",
      body: "A couple of minutes in the chat: who you are and who you're looking for. The more honest, the sharper the match.",
    },
    {
      title: "We search 24/7",
      body: "We go through thousands of profiles and pick one person — the one who truly fits.",
    },
    {
      title: "Skip straight to the date",
      body: "No chat, no texting in Gennety — you just choose who to go on dates with. Gennety agrees on a time and place that work for you both.",
    },
  ],
  dateFlowSteps: [
    {
      title: "You both said yes",
      body: "The moment you both agree, Gennety takes it from there. No 'so when are you free?' — there's nothing to text.",
    },
    {
      title: "You pick the time",
      body: "In a shared calendar you each mark the evenings you're free and see the other's picks live. The first time that works for you both becomes the date. If there are several — you choose.",
    },
    {
      title: "We find the place",
      body: "Tell us the mood — a quiet cafe, a park, a museum — and where you'll set off from. We'll find a vetted place that works for you both.",
    },
    {
      title: "It's all set",
      body: "You both get a card: the place, the address, a maps link, and the exact date and time.\n\nGot questions? Text or send a voice message in the chat. Gennety knows every detail of the date.",
    },
    {
      title: "Just before you meet",
      body: "A couple of hours before, we'll tell you what your match loves and what to talk about. If something comes up, an urgent-cancel button will appear.",
    },
    {
      title: "Then you tell us how it went",
      body: "The next day we'll ask how it went. Your feedback makes the next match sharper.",
    },
  ],
  consentTitle: "Before we start",
  consentLead: "One match a week. No swiping, no texting — straight to the meeting.",
  consentTermsPrefix: "I accept the",
  consentTerms: "terms of service",
  consentAnd: "and",
  consentPrivacy: "privacy policy",
  consentResearch: "I allow my anonymized data to be used to improve matching",
  continue: "Continue",
  saving: "Saving...",
  languageTitle: "Choose your language",
  pathTitle: "How will you sign in?",
  pathStudentTitle: "With university email",
  pathStudentSub: "For students — with perks",
  pathGeneralTitle: "With phone number",
  pathGeneralSub: "One tap via Telegram. No SMS code.",
  phoneTitle: "Confirm your number",
  phoneLead: "One tap and Telegram shares your number. No SMS. We only need it to make sure you're not a bot.",
  phoneShare: "Continue with my number",
  phoneSharing: "Confirming…",
  phoneTimeout: "Couldn't confirm your number. Try again.",
  emailTitle: "Your university email",
  emailLead: "We'll send a code — that's how we know you're really a student.",
  emailSend: "Get code",
  emailSending: "Sending...",
  otpTitle: "Enter the code",
  otpLead: (email) => `Sent to ${email}`,
  otpDigit: (position) => `OTP digit ${position}`,
  otpConfirm: "Confirm",
  otpChecking: "Checking...",
  otpResend: "Send code again",
  otpResending: "Sending...",
  otpResendIn: (seconds) => `Send again in ${seconds}s`,
  otpChangeEmail: "Change email",
  cityTitle: "Your city",
  cityLead: "For now we're in Kyiv. If you're in another city, we'll save you a spot in line.",
  cityDetect: "Detect automatically",
  cityDetecting: "Detecting city...",
  cityPlaceholder: "Kyiv",
  citySearching: "Searching for a city...",
  cityGeoUnavailable: "We couldn't open location access. Choose a city using search.",
  cityGeoDenied: "Location isn't available. Choose a city using search.",
  cityOutsideMarket:
    "We don't know that city yet. Pick one from the list — Kyiv if you're ready to go on dates there, or any other and we'll save your spot.",
  cityComingSoon: "Coming soon",
  cityCountries: { UA: "Ukraine", DE: "Germany" },
  waitlistTitle: (city) => `${city} — coming soon`,
  waitlistLead: () => "You're on the list. We'll message you as soon as we open.",
  waitlistChangeCity: "Choose another city",
  waitlistChanging: "One moment...",
  referralGiftTitle: "{name} invited you\u00a0🎟",
  referralGiftTitleNoName: "A friend invited you\u00a0🎟",
  referralGiftBody:
    "Finish sign-up and pass verification — you'll get {ticketsPhrase} as a welcome gift, and {name} gets one too.",
  referralGiftBodyNoName:
    "Finish sign-up and pass verification — you'll get {ticketsPhrase} as a welcome gift, and your friend gets one too.",
  referralGiftContinue: "Continue",
  referralGiftBusy: "One moment...",
  promoGiftTitle: "Your gift is unlocked",
  promoGiftTicketLine: "🎟 {tickets} free Date Ticket",
  promoGiftMonthsLine: "✨ {months} months of Gennety Premium",
  promoGiftContinue: "Claim & continue",
  promoGiftClaiming: "Activating...",
  themeTitle: "Light or dark?",
  themeDark: "Dark",
  themeLight: "Light",
  basicsNameTitle: "What should I call you?",
  basicsNamePlaceholder: "Your name",
  basicsAgeTitle: "How old are you?",
  basicsGenderTitle: "Are you a man or a woman?",
  basicsGenderMale: "I'm a man",
  basicsGenderFemale: "I'm a woman",
  basicsPreferenceTitle: "Who do you want to meet?",
  basicsPreferenceMen: "Men",
  basicsPreferenceWomen: "Women",
  basicsPreferenceBoth: "Both",
  basicsHeightTitle: "How tall are you?",
  basicsHeightUnit: "cm",
  basicsIntentTitle: "What are you looking for?",
  basicsIntentSpark: "A bright story",
  basicsIntentOpen: "See where it goes",
  basicsIntentFalling: "Fall for someone",
  basicsIntentLongterm: "Something long-term",
  basicsIntentPrivate: "Pick as many as you like. Only you can see this.",
  handoffMissingSession: "Open the app again from the chat.",
  handoffFailed: "The bot couldn't continue yet. Try again.",
  handoffReadyTitle: "The bot is waiting for you",
  handoffTitle: "Heading back to the chat…",
  retry: "Try again",
  doneTitle: "Done",
  doneLead: "Let's continue in the chat.",
  backToChat: "Return to chat",
  syncingTitle: "One moment…",
  errors: {
    "Invalid university email": "Enter a corporate or university email.",
    "invalid-email": "Enter a corporate or university email.",
    "email-linked-to-other-account": "This email is linked to another Telegram account.",
    mismatch: "The code doesn't match. Check the email and try again.",
    expired: "The code expired. Request a new one below.",
    exhausted: "Too many attempts. Request a new code.",
    "otp-cooldown": "A new code was already sent. Wait a few seconds.",
    "otp-send-failed": "We couldn't send the email. Try again.",
    "otp-daily-limit": "Too many codes for this email today. Try again tomorrow.",
    "email-plus-alias": "Use your address without the \"+\" part.",
    "terms-required": "Accept the terms first.",
    "language-required": "Choose a language first.",
    invalid_name: "Use letters only — 2 characters or more.",
    age_out_of_range: "Gennety is for people aged 18-55 right now.",
    height_out_of_range: "Pick a height between 140 and 220 cm.",
    "email-required": "Verify your university email first.",
    "location-required": "Choose your city first.",
    "city-not-supported": "Gennety isn't live in that city yet. Choose Kyiv to continue.",
    "city-not-waitlisted": "We couldn't save that city. Pick one from the list.",
    "Invalid initData": "Open the app again from the chat.",
    "Missing tma initData": "Open the app again from the chat.",
    "Empty initData": "Open the app again from the chat.",
  },
  genericError: "Something went wrong. Try again.",
};

const ru: OnboardingStrings = {
  ...en,
  back: "Назад",
  next: "Дальше",
  more: "Подробнее",
  pivotLines: [["Знакомства — чтобы встречаться, а не переписываться"], ["Поэтому мы создали ", "Gennety"]],
  matchmakerLines: [["Gennety ищет тебе пару круглосуточно"]],
  howItWorksSteps: [
    {
      title: "Расскажи о себе",
      body: "Пара минут в чате: кто ты и кого ищешь. Чем честнее, тем точнее подбор.",
    },
    {
      title: "Мы ищем 24/7",
      body: "Перебираем тысячи анкет и выбираем одного человека — того, кто правда подходит.",
    },
    {
      title: "Сразу к свиданию",
      body: "В Gennety нет чата и переписок — ты только выбираешь, с кем ходить на свидания. А время и место, удобные вам обоим, согласует Gennety.",
    },
  ],
  dateFlowSteps: [
    {
      title: "Вы оба сказали «да»",
      body: "Как только оба согласились, дальше всё берёт на себя Gennety. Никаких «ну что, когда удобно?» — переписываться не нужно.",
    },
    {
      title: "Ты выбираешь время",
      body: "В общем календаре каждый отмечает свободные вечера и видит выбор другого вживую. Первое время, что подходит обоим, становится свиданием. Если их несколько — выбираешь ты.",
    },
    {
      title: "Мы находим место",
      body: "Скажи, какое настроение — тихое кафе, парк, музей — и откуда поедешь. Мы найдём проверенное место, удобное обоим.",
    },
    {
      title: "Всё назначено",
      body: "Вы оба получаете карточку: место, адрес, ссылку на карту и точные дату и время.\n\nОстались вопросы — напиши или скажи голосом в чат. Gennety знает все детали свидания.",
    },
    {
      title: "Перед самой встречей",
      body: "За пару часов подскажем, что любит твоя пара и о чём заговорить. Если что-то случится, появится кнопка срочной отмены.",
    },
    {
      title: "А потом расскажешь, как прошло",
      body: "На следующий день спросим, как всё прошло. Твой отзыв делает следующий подбор точнее.",
    },
  ],
  consentTitle: "Прежде чем начать",
  consentLead: "Одна пара в неделю. Без свайпов и переписки — сразу встреча.",
  consentTermsPrefix: "Я принимаю",
  consentTerms: "условия использования",
  consentAnd: "и",
  consentPrivacy: "политику конфиденциальности",
  consentResearch: "Разрешаю использовать мои обезличенные данные, чтобы улучшать подбор",
  continue: "Продолжить",
  saving: "Сохраняю...",
  languageTitle: "Выбери язык",
  pathTitle: "Как войдёшь?",
  pathStudentTitle: "По университетской почте",
  pathStudentSub: "Для студентов — с бонусами",
  pathGeneralTitle: "По номеру телефона",
  pathGeneralSub: "В один тап через Telegram. Без SMS-кода.",
  phoneTitle: "Подтверди номер",
  phoneLead: "Один тап — и Telegram передаст номер. Без SMS. Он нужен только чтобы убедиться, что ты не бот.",
  phoneShare: "Продолжить с моим номером",
  phoneSharing: "Подтверждаю…",
  phoneTimeout: "Не удалось подтвердить номер. Попробуй ещё раз.",
  emailTitle: "Твоя почта вуза",
  emailLead: "Пришлём код — так мы поймём, что ты правда студент.",
  emailSend: "Получить код",
  emailSending: "Отправляю...",
  otpTitle: "Введи код",
  otpLead: (email) => `Отправили на ${email}`,
  otpDigit: (position) => `Цифра кода ${position}`,
  otpConfirm: "Подтвердить",
  otpChecking: "Проверяю...",
  otpResend: "Отправить код снова",
  otpResending: "Отправляю...",
  otpResendIn: (seconds) => `Отправить снова через ${seconds} сек.`,
  otpChangeEmail: "Изменить почту",
  cityTitle: "Твой город",
  cityLead: "Пока мы в Киеве. Если ты в другом городе — займём тебе место в очереди.",
  cityDetect: "Определить автоматически",
  cityDetecting: "Определяю город...",
  cityPlaceholder: "Киев",
  citySearching: "Ищу город...",
  cityGeoUnavailable: "Не получилось открыть геолокацию. Выбери город через поиск.",
  cityGeoDenied: "Геолокация недоступна. Выбери город через поиск.",
  cityOutsideMarket: "Такой город мы пока не знаем. Выбери из списка: Киев — если хочешь ходить на свидания там, или любой другой — и мы займём тебе место.",
  cityComingSoon: "Скоро",
  cityCountries: { UA: "Украина", DE: "Германия" },
  waitlistTitle: (city) => `${city} — скоро`,
  waitlistLead: () => "Ты в списке. Как только откроемся — сразу напишем.",
  waitlistChangeCity: "Выбрать другой город",
  waitlistChanging: "Секунду...",
  referralGiftTitle: "{name} зовёт тебя в Gennety\u00a0🎟",
  referralGiftTitleNoName: "Тебя пригласил друг\u00a0🎟",
  referralGiftBody:
    "Заверши регистрацию и пройди верификацию — получишь {ticketsPhrase} в подарок, и {name} тоже.",
  referralGiftBodyNoName:
    "Заверши регистрацию и пройди верификацию — получишь {ticketsPhrase} в подарок, и твой друг тоже.",
  referralGiftContinue: "Продолжить",
  referralGiftBusy: "Секунду...",
  promoGiftTitle: "Твой подарок активирован",
  promoGiftTicketLine: "🎟 {tickets} бесплатный билет на свидание",
  promoGiftMonthsLine: "✨ {months} мес. Gennety Premium",
  promoGiftContinue: "Забрать и продолжить",
  promoGiftClaiming: "Активирую...",
  themeTitle: "Светлая или тёмная?",
  themeDark: "Тёмная",
  themeLight: "Светлая",
  basicsNameTitle: "Как тебя зовут?",
  basicsNamePlaceholder: "Твоё имя",
  basicsAgeTitle: "Сколько тебе лет?",
  basicsGenderTitle: "Ты парень или девушка?",
  basicsGenderMale: "Я парень",
  basicsGenderFemale: "Я девушка",
  basicsPreferenceTitle: "С кем хочешь познакомиться?",
  basicsPreferenceMen: "Парней",
  basicsPreferenceWomen: "Девушек",
  basicsPreferenceBoth: "И тех, и других",
  basicsHeightTitle: "Какой у тебя рост?",
  basicsHeightUnit: "см",
  basicsIntentTitle: "Что ты ищешь?",
  basicsIntentSpark: "Яркая история",
  basicsIntentOpen: "Посмотрим, куда приведёт",
  basicsIntentFalling: "Влюбиться",
  basicsIntentLongterm: "Всерьёз и надолго",
  basicsIntentPrivate: "Можно несколько. Это видишь только ты.",
  handoffMissingSession: "Открой приложение заново из чата.",
  handoffFailed: "Бот пока не смог продолжить. Попробуй ещё раз.",
  handoffReadyTitle: "Бот уже ждёт тебя",
  handoffTitle: "Возвращаемся в чат…",
  retry: "Попробовать ещё раз",
  doneTitle: "Готово",
  doneLead: "Продолжим в чате.",
  backToChat: "Вернуться в чат",
  syncingTitle: "Секунду…",
  errors: {
    "Invalid university email": "Нужна корпоративная или университетская почта.",
    "invalid-email": "Нужна корпоративная или университетская почта.",
    "email-linked-to-other-account": "Эта почта уже привязана к другому Telegram аккаунту.",
    mismatch: "Код не совпал. Проверь письмо и попробуй ещё раз.",
    expired: "Код истёк. Запроси новый код ниже.",
    exhausted: "Слишком много попыток. Запроси новый код.",
    "otp-cooldown": "Новый код уже отправлен. Подожди несколько секунд.",
    "otp-send-failed": "Не удалось отправить письмо. Попробуй ещё раз.",
    "otp-daily-limit": "На эту почту сегодня уже отправили слишком много кодов. Попробуй завтра.",
    "email-plus-alias": "Укажи адрес без части с «+».",
    "terms-required": "Сначала нужно принять условия.",
    "language-required": "Сначала выбери язык.",
    invalid_name: "Только буквы — от 2 символов.",
    age_out_of_range: "Сейчас Gennety доступен для возраста 18-55.",
    height_out_of_range: "Выбери рост от 140 до 220 см.",
    "email-required": "Сначала подтверди университетскую почту.",
    "location-required": "Сначала выбери город.",
    "city-not-supported": "В этом городе Gennety пока не работает. Выбери Киев, чтобы продолжить.",
    "city-not-waitlisted": "Не получилось сохранить этот город. Выбери из списка.",
    "Invalid initData": "Открой приложение заново из чата.",
    "Missing tma initData": "Открой приложение заново из чата.",
    "Empty initData": "Открой приложение заново из чата.",
  },
  genericError: "Что-то пошло не так. Попробуй ещё раз.",
};

const uk: OnboardingStrings = {
  ...en,
  back: "Назад",
  next: "Далі",
  more: "Детальніше",
  pivotLines: [["Знайомства — щоб зустрічатися, а не листуватися"], ["Тому ми створили ", "Gennety"]],
  matchmakerLines: [["Gennety шукає тобі пару цілодобово"]],
  howItWorksSteps: [
    {
      title: "Розкажи про себе",
      body: "Пара хвилин у чаті: хто ти і кого шукаєш. Що чесніше, то точніший підбір.",
    },
    {
      title: "Ми шукаємо 24/7",
      body: "Перебираємо тисячі анкет і обираємо одну людину — ту, яка справді підходить.",
    },
    {
      title: "Одразу до побачення",
      body: "У Gennety немає чату й листувань — ти лише обираєш, з ким ходити на побачення. А зручні для вас обох час і місце узгоджує Gennety.",
    },
  ],
  dateFlowSteps: [
    {
      title: "Ви обоє сказали «так»",
      body: "Щойно обоє погодились, далі все бере на себе Gennety. Жодних «ну що, коли зручно?» — листуватися не треба.",
    },
    {
      title: "Ти обираєш час",
      body: "У спільному календарі кожен позначає вільні вечори й бачить вибір іншого вживу. Перший час, що підходить обом, стає побаченням. Якщо їх кілька — обираєш ти.",
    },
    {
      title: "Ми знаходимо місце",
      body: "Скажи, який настрій — тихе кафе, парк, музей — і звідки поїдеш. Ми знайдемо перевірене місце, зручне обом.",
    },
    {
      title: "Усе призначено",
      body: "Ви обоє отримуєте картку: місце, адресу, посилання на карту й точні дату та час.\n\nЛишилися питання — напиши або скажи голосом у чат. Gennety знає всі деталі побачення.",
    },
    {
      title: "Перед самою зустріччю",
      body: "За пару годин підкажемо, що любить твоя пара і про що заговорити. Якщо щось станеться, з'явиться кнопка термінового скасування.",
    },
    {
      title: "А потім розкажеш, як минуло",
      body: "Наступного дня спитаємо, як усе минуло. Твій відгук робить наступний підбір точнішим.",
    },
  ],
  consentTitle: "Перш ніж почати",
  consentLead: "Одна пара на тиждень. Без свайпів і листування — одразу зустріч.",
  consentTermsPrefix: "Я приймаю",
  consentTerms: "умови використання",
  consentAnd: "та",
  consentPrivacy: "політику конфіденційності",
  consentResearch: "Дозволяю використовувати мої знеособлені дані, щоб покращувати підбір",
  continue: "Продовжити",
  saving: "Зберігаю...",
  languageTitle: "Обери мову",
  pathTitle: "Як увійдеш?",
  pathStudentTitle: "За університетською поштою",
  pathStudentSub: "Для студентів — з бонусами",
  pathGeneralTitle: "За номером телефону",
  pathGeneralSub: "В один тап через Telegram. Без SMS-коду.",
  phoneTitle: "Підтверди номер",
  phoneLead: "Один тап — і Telegram передасть номер. Без SMS. Він потрібен лише щоб переконатися, що ти не бот.",
  phoneShare: "Продовжити з моїм номером",
  phoneSharing: "Підтверджую…",
  phoneTimeout: "Не вдалося підтвердити номер. Спробуй ще раз.",
  emailTitle: "Твоя університетська пошта",
  emailLead: "Надішлемо код — так ми зрозуміємо, що ти справді студент.",
  emailSend: "Отримати код",
  emailSending: "Надсилаю...",
  otpTitle: "Введи код",
  otpLead: (email) => `Надіслали на ${email}`,
  otpDigit: (position) => `Цифра коду ${position}`,
  otpConfirm: "Підтвердити",
  otpChecking: "Перевіряю...",
  otpResend: "Надіслати код знову",
  otpResending: "Надсилаю...",
  otpResendIn: (seconds) => `Надіслати знову через ${seconds} с`,
  otpChangeEmail: "Змінити пошту",
  cityTitle: "Твоє місто",
  cityLead: "Поки ми в Києві. Якщо ти в іншому місті — збережемо тобі місце в черзі.",
  cityDetect: "Визначити автоматично",
  cityDetecting: "Визначаю місто...",
  cityPlaceholder: "Київ",
  citySearching: "Шукаю місто...",
  cityGeoUnavailable: "Не вдалося відкрити геолокацію. Обери місто через пошук.",
  cityGeoDenied: "Геолокація недоступна. Обери місто через пошук.",
  cityOutsideMarket: "Такого міста ми поки не знаємо. Обери зі списку: Київ — якщо хочеш ходити на побачення там, або будь-яке інше — і ми збережемо тобі місце.",
  cityComingSoon: "Скоро",
  cityCountries: { UA: "Україна", DE: "Німеччина" },
  waitlistTitle: (city) => `${city} — скоро`,
  waitlistLead: () => "Ти в списку. Щойно відкриємося — одразу напишемо.",
  waitlistChangeCity: "Обрати інше місто",
  waitlistChanging: "Секунду...",
  referralGiftTitle: "{name} кличе тебе в Gennety\u00a0🎟",
  referralGiftTitleNoName: "Тебе запросив друг\u00a0🎟",
  referralGiftBody:
    "Заверши реєстрацію та пройди верифікацію — отримаєш {ticketsPhrase} у подарунок, і {name} теж.",
  referralGiftBodyNoName:
    "Заверши реєстрацію та пройди верифікацію — отримаєш {ticketsPhrase} у подарунок, і твій друг теж.",
  referralGiftContinue: "Продовжити",
  referralGiftBusy: "Секунду...",
  promoGiftTitle: "Твій подарунок активовано",
  promoGiftTicketLine: "🎟 {tickets} безкоштовний квиток на побачення",
  promoGiftMonthsLine: "✨ {months} міс. Gennety Premium",
  promoGiftContinue: "Забрати й продовжити",
  promoGiftClaiming: "Активую...",
  themeTitle: "Світла чи темна?",
  themeDark: "Темна",
  themeLight: "Світла",
  basicsNameTitle: "Як тебе звати?",
  basicsNamePlaceholder: "Твоє ім'я",
  basicsAgeTitle: "Скільки тобі років?",
  basicsGenderTitle: "Ти хлопець чи дівчина?",
  basicsGenderMale: "Я хлопець",
  basicsGenderFemale: "Я дівчина",
  basicsPreferenceTitle: "З ким хочеш познайомитися?",
  basicsPreferenceMen: "Хлопців",
  basicsPreferenceWomen: "Дівчат",
  basicsPreferenceBoth: "І тих, і тих",
  basicsHeightTitle: "Який у тебе зріст?",
  basicsHeightUnit: "см",
  basicsIntentTitle: "Що ти шукаєш?",
  basicsIntentSpark: "Яскрава історія",
  basicsIntentOpen: "Подивимось, куди приведе",
  basicsIntentFalling: "Закохатися",
  basicsIntentLongterm: "Всерйоз і надовго",
  basicsIntentPrivate: "Можна кілька. Це бачиш тільки ти.",
  handoffMissingSession: "Відкрий застосунок заново з чату.",
  handoffFailed: "Бот поки не зміг продовжити. Спробуй ще раз.",
  handoffReadyTitle: "Бот уже чекає на тебе",
  handoffTitle: "Повертаємось у чат…",
  retry: "Спробувати ще раз",
  doneTitle: "Готово",
  doneLead: "Продовжимо в чаті.",
  backToChat: "Повернутися в чат",
  syncingTitle: "Секунду…",
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
    "otp-daily-limit": "На цю пошту сьогодні вже надіслали забагато кодів. Спробуй завтра.",
    "email-plus-alias": "Вкажи адресу без частини з «+».",
    "terms-required": "Спочатку прийми умови.",
    "language-required": "Спочатку обери мову.",
    invalid_name: "Лише літери — від 2 символів.",
    age_out_of_range: "Зараз Gennety доступний для віку 18-55.",
    height_out_of_range: "Обери зріст від 140 до 220 см.",
    "email-required": "Спочатку підтвердь університетську пошту.",
    "location-required": "Спочатку обери місто.",
    "city-not-supported": "У цьому місті Gennety ще не працює. Обери Київ, щоб продовжити.",
    "city-not-waitlisted": "Не вдалося зберегти це місто. Обери зі списку.",
    "Invalid initData": "Відкрий застосунок заново з чату.",
    "Missing tma initData": "Відкрий застосунок заново з чату.",
    "Empty initData": "Відкрий застосунок заново з чату.",
  },
  genericError: "Щось пішло не так. Спробуй ще раз.",
};

const de: OnboardingStrings = {
  ...en,
  back: "Zurück",
  next: "Weiter",
  more: "Mehr erfahren",
  pivotLines: [["Dating ist zum Treffen da, nicht zum Schreiben"], ["Deshalb haben wir ", "Gennety gebaut"]],
  matchmakerLines: [["Gennety sucht rund um die Uhr jemanden für dich"]],
  howItWorksSteps: [
    {
      title: "Erzähl von dir",
      body: "Ein paar Minuten im Chat: wer du bist und wen du suchst. Je ehrlicher, desto genauer die Auswahl.",
    },
    {
      title: "Wir suchen rund um die Uhr",
      body: "Wir gehen Tausende Profile durch und wählen eine Person — die, die wirklich passt.",
    },
    {
      title: "Direkt zum Date",
      body: "In Gennety gibt es keinen Chat und kein Schreiben — du wählst nur, mit wem du auf ein Date gehst. Zeit und Ort, die euch beiden passen, stimmt Gennety ab.",
    },
  ],
  dateFlowSteps: [
    {
      title: "Ihr habt beide Ja gesagt",
      body: "Sobald ihr beide zustimmt, übernimmt Gennety. Kein 'und, wann passt's?' — du musst nichts schreiben.",
    },
    {
      title: "Du wählst die Zeit",
      body: "In einem gemeinsamen Kalender markiert jeder die freien Abende und sieht die Auswahl des anderen live. Die erste Zeit, die euch beiden passt, wird zum Date. Gibt es mehrere — wählst du.",
    },
    {
      title: "Wir finden den Ort",
      body: "Sag, welche Stimmung du willst — ruhiges Café, Park, Museum — und von wo du losfährst. Wir finden einen geprüften Ort, der euch beiden passt.",
    },
    {
      title: "Alles steht",
      body: "Ihr bekommt beide eine Karte: Ort, Adresse, einen Karten-Link und das genaue Datum mit Uhrzeit.\n\nNoch Fragen? Schreib oder sprich im Chat. Gennety kennt alle Details des Dates.",
    },
    {
      title: "Kurz vor dem Treffen",
      body: "Ein paar Stunden vorher verraten wir dir, was dein Match mag und worüber ihr reden könnt. Falls etwas dazwischenkommt, erscheint ein Button für die kurzfristige Absage.",
    },
    {
      title: "Danach erzählst du, wie es war",
      body: "Am nächsten Tag fragen wir, wie es gelaufen ist. Deine Rückmeldung macht die nächste Auswahl genauer.",
    },
  ],
  consentTitle: "Bevor es losgeht",
  consentLead: "Ein Match pro Woche. Kein Swipen, kein Schreiben — direkt zum Treffen.",
  consentTermsPrefix: "Ich akzeptiere die",
  consentTerms: "Nutzungsbedingungen",
  consentAnd: "und die",
  consentPrivacy: "Datenschutzerklärung",
  consentResearch: "Ich erlaube, meine anonymisierten Daten zur Verbesserung der Partnersuche zu verwenden",
  continue: "Weiter",
  saving: "Speichern...",
  languageTitle: "Wähle deine Sprache",
  pathTitle: "Wie meldest du dich an?",
  pathStudentTitle: "Mit Universitäts-E-Mail",
  pathStudentSub: "Für Studierende — mit Extras",
  pathGeneralTitle: "Mit Telefonnummer",
  pathGeneralSub: "Ein Tipp über Telegram. Kein SMS-Code.",
  phoneTitle: "Bestätige deine Nummer",
  phoneLead: "Ein Tipp, und Telegram teilt deine Nummer. Keine SMS. Wir brauchen sie nur, um sicherzugehen, dass du kein Bot bist.",
  phoneShare: "Mit meiner Nummer fortfahren",
  phoneSharing: "Bestätige…",
  phoneTimeout: "Nummer konnte nicht bestätigt werden. Versuch es gleich noch mal.",
  emailTitle: "Deine Uni-E-Mail",
  emailLead: "Wir schicken dir einen Code — so wissen wir, dass du wirklich studierst.",
  emailSend: "Code erhalten",
  emailSending: "Senden...",
  otpTitle: "Gib den Code ein",
  otpLead: (email) => `Gesendet an ${email}`,
  otpDigit: (position) => `Codeziffer ${position}`,
  otpConfirm: "Bestätigen",
  otpChecking: "Prüfen...",
  otpResend: "Code erneut senden",
  otpResending: "Senden...",
  otpResendIn: (seconds) => `Erneut senden in ${seconds} Sek.`,
  otpChangeEmail: "E-Mail ändern",
  cityTitle: "Deine Stadt",
  cityLead: "Noch sind wir nur in Kyjiw. Bist du in einer anderen Stadt, halten wir dir einen Platz auf der Warteliste frei.",
  cityDetect: "Automatisch erkennen",
  cityDetecting: "Stadt wird erkannt...",
  cityPlaceholder: "Kyjiw",
  citySearching: "Stadt wird gesucht...",
  cityGeoUnavailable: "Standortzugriff konnte nicht geöffnet werden. Wähle die Stadt über die Suche.",
  cityGeoDenied: "Standort ist nicht verfügbar. Wähle die Stadt über die Suche.",
  cityOutsideMarket:
    "Diese Stadt kennen wir noch nicht. Wähle eine aus der Liste — Kyjiw, wenn du dort auf Dates gehen möchtest, oder eine andere, dann halten wir dir den Platz frei.",
  cityComingSoon: "Bald",
  cityCountries: { UA: "Ukraine", DE: "Deutschland" },
  waitlistTitle: (city) => `${city} — bald`,
  waitlistLead: () => "Du stehst auf der Liste. Sobald wir starten, schreiben wir dir.",
  waitlistChangeCity: "Andere Stadt wählen",
  waitlistChanging: "Einen Moment...",
  referralGiftTitle: "{name} hat dich eingeladen\u00a0🎟",
  referralGiftTitleNoName: "Ein Freund hat dich eingeladen\u00a0🎟",
  referralGiftBody:
    "Schließ die Registrierung ab und bestehe die Verifizierung — du bekommst {ticketsPhrase} als Willkommensgeschenk, und {name} bekommt auch eins.",
  referralGiftBodyNoName:
    "Schließ die Registrierung ab und bestehe die Verifizierung — du bekommst {ticketsPhrase} als Willkommensgeschenk, und dein Freund bekommt auch eins.",
  referralGiftContinue: "Weiter",
  referralGiftBusy: "Einen Moment...",
  promoGiftTitle: "Dein Geschenk ist freigeschaltet",
  promoGiftTicketLine: "🎟 {tickets} gratis Date-Ticket",
  promoGiftMonthsLine: "✨ {months} Monate Gennety Premium",
  promoGiftContinue: "Einlösen & weiter",
  promoGiftClaiming: "Wird aktiviert...",
  themeTitle: "Hell oder dunkel?",
  themeDark: "Dunkel",
  themeLight: "Hell",
  basicsNameTitle: "Wie soll ich dich nennen?",
  basicsNamePlaceholder: "Dein Name",
  basicsAgeTitle: "Wie alt bist du?",
  basicsGenderTitle: "Bist du ein Mann oder eine Frau?",
  basicsGenderMale: "Ich bin ein Mann",
  basicsGenderFemale: "Ich bin eine Frau",
  basicsPreferenceTitle: "Wen möchtest du kennenlernen?",
  basicsPreferenceMen: "Männer",
  basicsPreferenceWomen: "Frauen",
  basicsPreferenceBoth: "Beide",
  basicsHeightTitle: "Wie groß bist du?",
  basicsHeightUnit: "cm",
  basicsIntentTitle: "Wonach suchst du?",
  basicsIntentSpark: "Eine kurze, intensive Geschichte",
  basicsIntentOpen: "Mal sehen, wohin es führt",
  basicsIntentFalling: "Mich verlieben",
  basicsIntentLongterm: "Etwas Langfristiges",
  basicsIntentPrivate: "Mehrere möglich. Das siehst nur du.",
  handoffMissingSession: "Öffne die App erneut aus dem Chat.",
  handoffFailed: "Der Bot konnte noch nicht fortfahren. Versuch es erneut.",
  handoffReadyTitle: "Der Bot wartet auf dich",
  handoffTitle: "Zurück in den Chat…",
  retry: "Erneut versuchen",
  doneTitle: "Fertig",
  doneLead: "Weiter geht's im Chat.",
  backToChat: "Zurück zum Chat",
  syncingTitle: "Einen Moment…",
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
    "otp-daily-limit": "Für diese E-Mail wurden heute zu viele Codes angefordert. Versuch es morgen erneut.",
    "email-plus-alias": "Gib deine Adresse ohne den „+“-Teil ein.",
    "terms-required": "Akzeptiere zuerst die Bedingungen.",
    "language-required": "Wähle zuerst eine Sprache.",
    invalid_name: "Nur Buchstaben — mindestens 2 Zeichen.",
    age_out_of_range: "Gennety ist derzeit für 18- bis 55-Jährige.",
    height_out_of_range: "Wähle eine Größe zwischen 140 und 220 cm.",
    "email-required": "Bestätige zuerst deine Universitäts-E-Mail.",
    "location-required": "Wähle zuerst deine Stadt.",
    "city-not-supported": "In dieser Stadt gibt es Gennety noch nicht. Wähle Kyjiw, um fortzufahren.",
    "city-not-waitlisted": "Diese Stadt konnten wir nicht speichern. Wähle eine aus der Liste.",
    "Invalid initData": "Öffne die App erneut aus dem Chat.",
    "Missing tma initData": "Öffne die App erneut aus dem Chat.",
    "Empty initData": "Öffne die App erneut aus dem Chat.",
  },
  genericError: "Etwas ist schiefgelaufen. Versuch es erneut.",
};

const pl: OnboardingStrings = {
  ...en,
  back: "Wstecz",
  next: "Dalej",
  more: "Więcej",
  pivotLines: [["Randki są po to, żeby się spotykać, a nie pisać"], ["Dlatego stworzyliśmy ", "Gennety"]],
  matchmakerLines: [["Gennety szuka dla ciebie pary przez całą dobę"]],
  howItWorksSteps: [
    {
      title: "Opowiedz o sobie",
      body: "Kilka minut na czacie: kim jesteś i kogo szukasz. Im szczerzej, tym trafniejsze dopasowanie.",
    },
    {
      title: "Szukamy 24/7",
      body: "Przeglądamy tysiące profili i wybieramy jedną osobę — tę, która naprawdę pasuje.",
    },
    {
      title: "Od razu na randkę",
      body: "W Gennety nie ma czatu ani pisania — wybierasz tylko, z kim chodzić na randki. A dogodny dla was obojga czas i miejsce ustala Gennety.",
    },
  ],
  dateFlowSteps: [
    {
      title: "Oboje powiedzieliście „tak”",
      body: "Gdy tylko oboje się zgodzicie, dalej wszystkim zajmuje się Gennety. Żadnego „no to kiedy ci pasuje?” — nie trzeba pisać.",
    },
    {
      title: "Ty wybierasz czas",
      body: "We wspólnym kalendarzu każdy zaznacza wolne wieczory i na żywo widzi wybór drugiej osoby. Pierwszy termin, który pasuje wam obojgu, staje się randką. Jeśli jest ich kilka — wybierasz ty.",
    },
    {
      title: "My znajdujemy miejsce",
      body: "Powiedz, jaki klimat — cicha kawiarnia, park, muzeum — i skąd wyruszysz. Znajdziemy sprawdzone miejsce, wygodne dla was obojga.",
    },
    {
      title: "Wszystko ustalone",
      body: "Oboje dostajecie kartę: miejsce, adres, link do mapy oraz dokładną datę i godzinę.\n\nMasz pytania — napisz albo nagraj głosówkę na czacie. Gennety zna wszystkie szczegóły randki.",
    },
    {
      title: "Tuż przed spotkaniem",
      body: "Kilka godzin wcześniej podpowiemy, co lubi twoja para i o czym zacząć rozmowę. Jeśli coś się stanie, pojawi się przycisk pilnego odwołania.",
    },
    {
      title: "A potem opowiesz, jak poszło",
      body: "Następnego dnia zapytamy, jak poszło. Twoja opinia sprawia, że kolejne dopasowanie będzie trafniejsze.",
    },
  ],
  consentTitle: "Zanim zaczniemy",
  consentLead: "Jedna para w tygodniu. Bez swipowania i pisania — od razu spotkanie.",
  consentTermsPrefix: "Akceptuję",
  consentTerms: "warunki usługi",
  consentAnd: "i",
  consentPrivacy: "politykę prywatności",
  consentResearch: "Zgadzam się na wykorzystanie moich zanonimizowanych danych do ulepszania dopasowań",
  continue: "Dalej",
  saving: "Zapisywanie...",
  languageTitle: "Wybierz język",
  pathTitle: "Jak się zalogujesz?",
  pathStudentTitle: "Przez e-mail uczelniany",
  pathStudentSub: "Dla studentów — z bonusami",
  pathGeneralTitle: "Przez numer telefonu",
  pathGeneralSub: "Jednym dotknięciem przez Telegram. Bez kodu SMS.",
  phoneTitle: "Potwierdź numer",
  phoneLead: "Jedno dotknięcie — i Telegram przekaże numer. Bez SMS. Potrzebujemy go tylko, żeby upewnić się, że nie jesteś botem.",
  phoneShare: "Kontynuuj z moim numerem",
  phoneSharing: "Potwierdzam…",
  phoneTimeout: "Nie udało się potwierdzić numeru. Spróbuj ponownie.",
  emailTitle: "Twój e-mail z uczelni",
  emailLead: "Wyślemy kod — tak sprawdzimy, że naprawdę studiujesz.",
  emailSend: "Pobierz kod",
  emailSending: "Wysyłanie...",
  otpTitle: "Wpisz kod",
  otpLead: (email) => `Wysłaliśmy na ${email}`,
  otpDigit: (position) => `Cyfra kodu ${position}`,
  otpConfirm: "Potwierdź",
  otpChecking: "Sprawdzanie...",
  otpResend: "Wyślij kod ponownie",
  otpResending: "Wysyłanie...",
  otpResendIn: (seconds) => `Wyślij ponownie za ${seconds} s`,
  otpChangeEmail: "Zmień e-mail",
  cityTitle: "Twoje miasto",
  cityLead: "Na razie jesteśmy w Kijowie. Jeśli mieszkasz w innym mieście — zarezerwujemy ci miejsce w kolejce.",
  cityDetect: "Wykryj automatycznie",
  cityDetecting: "Wykrywanie miasta...",
  cityPlaceholder: "Kijów",
  citySearching: "Szukanie miasta...",
  cityGeoUnavailable: "Nie udało się otworzyć lokalizacji. Wybierz miasto przez wyszukiwarkę.",
  cityGeoDenied: "Lokalizacja jest niedostępna. Wybierz miasto przez wyszukiwarkę.",
  cityOutsideMarket:
    "Tego miasta jeszcze nie znamy. Wybierz jedno z listy — Kijów, jeśli chcesz tam chodzić na randki, albo dowolne inne, a zarezerwujemy Ci miejsce.",
  cityComingSoon: "Wkrótce",
  cityCountries: { UA: "Ukraina", DE: "Niemcy" },
  waitlistTitle: (city) => `${city} — wkrótce`,
  waitlistLead: () => "Jesteś na liście. Gdy tylko ruszymy, od razu napiszemy.",
  waitlistChangeCity: "Wybierz inne miasto",
  waitlistChanging: "Chwileczkę...",
  referralGiftTitle: "{name} zaprasza cię do Gennety\u00a0🎟",
  referralGiftTitleNoName: "Zaprosił cię znajomy\u00a0🎟",
  referralGiftBody:
    "Dokończ rejestrację i przejdź weryfikację — dostaniesz {ticketsPhrase} w prezencie, a {name} też dostanie jeden.",
  referralGiftBodyNoName:
    "Dokończ rejestrację i przejdź weryfikację — dostaniesz {ticketsPhrase} w prezencie, a twój znajomy też dostanie jeden.",
  referralGiftContinue: "Dalej",
  referralGiftBusy: "Chwileczkę...",
  promoGiftTitle: "Twój prezent został odblokowany",
  promoGiftTicketLine: "🎟 {tickets} darmowy bilet na randkę",
  promoGiftMonthsLine: "✨ {months} mies. Gennety Premium",
  promoGiftContinue: "Odbierz i kontynuuj",
  promoGiftClaiming: "Aktywuję...",
  themeTitle: "Jasny czy ciemny?",
  themeDark: "Ciemny",
  themeLight: "Jasny",
  basicsNameTitle: "Jak mam się do Ciebie zwracać?",
  basicsNamePlaceholder: "Twoje imię",
  basicsAgeTitle: "Ile masz lat?",
  basicsGenderTitle: "Jesteś mężczyzną czy kobietą?",
  basicsGenderMale: "Jestem mężczyzną",
  basicsGenderFemale: "Jestem kobietą",
  basicsPreferenceTitle: "Kogo chcesz poznać?",
  basicsPreferenceMen: "Mężczyzn",
  basicsPreferenceWomen: "Kobiety",
  basicsPreferenceBoth: "Obie opcje",
  basicsHeightTitle: "Ile masz wzrostu?",
  basicsHeightUnit: "cm",
  basicsIntentTitle: "Czego szukasz?",
  basicsIntentSpark: "Jasna historia",
  basicsIntentOpen: "Zobaczymy, dokąd to zaprowadzi",
  basicsIntentFalling: "Zakochać się",
  basicsIntentLongterm: "Coś na dłużej",
  basicsIntentPrivate: "Możesz wybrać kilka. Widzisz to tylko ty.",
  handoffMissingSession: "Otwórz aplikację ponownie z czatu.",
  handoffFailed: "Bot nie mógł jeszcze kontynuować. Spróbuj ponownie.",
  handoffReadyTitle: "Bot już na Ciebie czeka",
  handoffTitle: "Wracamy do czatu…",
  retry: "Spróbuj ponownie",
  doneTitle: "Gotowe",
  doneLead: "Kontynuujemy na czacie.",
  backToChat: "Wróć do czatu",
  syncingTitle: "Chwileczkę…",
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
    "otp-daily-limit": "Na ten adres wysłano dziś zbyt wiele kodów. Spróbuj jutro.",
    "email-plus-alias": "Podaj adres bez części z „+”.",
    "terms-required": "Najpierw zaakceptuj warunki.",
    "language-required": "Najpierw wybierz język.",
    invalid_name: "Tylko litery — co najmniej 2 znaki.",
    age_out_of_range: "Gennety jest teraz dla osób w wieku 18-55 lat.",
    height_out_of_range: "Wybierz wzrost od 140 do 220 cm.",
    "email-required": "Najpierw potwierdź uczelniany e-mail.",
    "location-required": "Najpierw wybierz miasto.",
    "city-not-supported": "W tym mieście Gennety jeszcze nie działa. Wybierz Kijów, aby kontynuować.",
    "city-not-waitlisted": "Nie udało się zapisać tego miasta. Wybierz jedno z listy.",
    "Invalid initData": "Otwórz aplikację ponownie z czatu.",
    "Missing tma initData": "Otwórz aplikację ponownie z czatu.",
    "Empty initData": "Otwórz aplikację ponownie z czatu.",
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
