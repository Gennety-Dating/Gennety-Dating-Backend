import type { Language } from "./types.js";

const translations = {
  en: {
    // --- Onboarding ---
    consentMessage:
      "Welcome to Gennety Dating!\n\n" +
      "Before we begin, please review our Privacy Policy and agree to our data retention terms.",
    consentAgree: "I Agree",
    welcome: "Gennety Dating 👀\nAI matchmaking built for students.",
    chooseLanguage: "Pick your language:",
    philosophyPitch:
      "Gennety runs on one idea: *Zero Chat*.\n\n" +
      "You never message your match. Our AI gets who you are, " +
      "finds someone actually compatible, and handles everything — time, place, the whole thing.\n\n" +
      "You just show up. Sound good?",
    philosophyContinue: "I'm in 🚀",
    askEmail: "Drop your uni email (like name@stanford.edu):",
    invalidEmail: "Hmm, that doesn't look like a uni email. Try your .edu or .ac.uk address.",
    otpSent: "Sent a 6-digit code to *{email}*. Drop it here:",
    otpInvalid: "That code didn't work. Try again:",
    otpExpired: "Code expired. Enter your email again:",
    otpTooManyAttempts: "Too many tries. Enter your email again for a fresh code.",
    otpCooldown: "Hold on — wait a minute before requesting a new code.",
    emailVerified: "Email confirmed ✅",
    askFirstName: "What's your name?",
    askSurname: "And your last name?",
    askAge: "How old are you?",
    invalidAge: "Enter an age between {min} and {max}.",
    askGender: "What's your gender?",
    askPreference: "Who are you into?",
    btnMale: "Male",
    btnFemale: "Female",
    btnMen: "Men",
    btnWomen: "Women",
    btnBoth: "Both",
    visualScreeningIntro:
      "Time to figure out your type 👀 I'll show you some photos — tap 👍 or 👎.",
    visualScreeningDone: "Got your taste saved ✅",
    llmDumpIntro:
      "Now for the fun part 🧠\n\n" +
      "Copy this prompt, paste it into ChatGPT or Claude, " +
      "and send me the full response.\n\n" +
      "This lets our AI actually understand you — way deeper than any questionnaire.",
    llmPrompt:
      "Please analyze me as a potential romantic partner. Include:\n" +
      "1. My core personality traits and values\n" +
      "2. My communication style\n" +
      "3. My interests and passions\n" +
      "4. What kind of partner would complement me\n" +
      "5. My potential deal-breakers in relationships\n\n" +
      "Format your response as a detailed JSON with these keys: personality_traits, communication_style, interests, ideal_partner, dealbreakers, summary.",
    llmAnalysing1: "Reading your profile... 🧠",
    llmAnalysing2: "Pulling out personality traits...",
    llmAnalysing3: "Building your psychological fingerprint...",
    llmDumpReceived: "Profile ready ✨",
    askPhotos: "Almost done! Send {min}–{max} photos of yourself. One at a time.",
    photoReceived: "Photo {n}/{max} ✅",
    photoRejected:
      "I need a clear photo of just *you* — one person, face visible.\n\n" +
      "No memes, no landscapes, no group shots. Try another one.",
    photoVisionError:
      "Couldn't process that photo. Try sending it again in a sec.",
    photosEnough: "You can send more (up to {max}) or hit the button to continue.",
    photosDone: "Photos uploaded ✅",
    profileReview:
      "Here's your profile:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Look good?",
    profileConfirm: "Looks good ✅",
    profileEdit: "Change something",
    onboardingComplete:
      "You're in! 🎉\n\n" +
      "Our AI is already looking for your match. " +
      "I'll hit you up as soon as someone special comes along.",
    btnLike: "👍",
    btnDislike: "👎",
    btnContinuePhotos: "Continue ➡️",
    finishOnboardingFirst:
      "Finish registration first, then the menu and settings will be available.\nType /start to continue.",

    // --- Main Menu ---
    menuTitle: "🎓 *Gennety Menu*\nWhat's up?",
    menuMyProfile: "👤 My Profile",
    menuEdit: "✏️ Edit Profile",
    menuPause: "⏸ Pause Matching",
    menuResume: "▶️ Resume Matching",
    menuSettings: "⚙️ Settings",
    menuHelp: "💬 Help",
    menuBack: "⬅️ Back",

    // --- My Profile ---
    myProfileBody:
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n" +
      "🌐 {language}\n\n" +
      "{summary}",
    myProfileNoBio: "_No bio yet._",

    // --- Edit Profile ---
    editProfileBody:
      "These are locked in:\n\n" +
      "• *Name:* {firstName} {surname}\n" +
      "• *Age:* {age}\n" +
      "• *University:* {university}\n\n" +
      "You can edit:",
    editBioBtn: "📝 Bio",
    editPrefsBtn: "🔍 Search Prefs",
    editMajorBtn: "🎓 Major",
    editProfilePhotosBtn: "📸 Re-upload Photos",
    editBioPrompt: "Send your new bio (max 500 chars):",
    editBioTooLong: "Too long — keep it under 500.",
    editBioSaved: "Bio updated ✅",
    editMajorPrompt: "What's your major? (max 100 chars):",
    editMajorTooLong: "Too long — keep it under 100.",
    editMajorSaved: "Major updated ✅",
    editPrefsTitle: "🔍 *Search Prefs*\n\nWhat do you want to change?",
    editPrefsAgeBtn: "🎂 Age Range",
    editPrefsVisualBtn: "👁 Visual Type",
    editPrefsBack: "⬅️ Back to Edit",
    editAgeRangePrompt: "What age range? (e.g. 20-28)\nMin: {min}, Max: {max}.",
    editAgeRangeInvalid: "Didn't get that. Two numbers like 20-28 (range {min}–{max}).",
    editAgeRangeSaved: "Age range updated ✅",
    editVisualRestart: "Let's redo your visual type 👀",
    editVisualDone: "Visual prefs updated ✅",
    editProfilePhotosStart: "Send new photos ({min}–{max}). One at a time.",
    editProfilePhotosSaved: "Photos updated ✅",

    // --- Pause / Resume ---
    pauseConfirmed: "Matching paused ⏸\nNo new matches until you resume.",
    resumeConfirmed: "Matching back on ▶️\nOur AI is on it.",

    // --- Settings ---
    settingsTitle: "⚙️ Settings",
    settingsLanguage: "🌐 Language",
    settingsLanguagePick: "Pick a language:",
    settingsLanguageSaved: "Language updated ✅",
    helpBody:
      "*Need help?* 💬\n\n" +
      "We don't do chats between users — that's by design. " +
      "Got an issue with a match, date, or the bot? Hit up support:\n\n" +
      "💬 [@gennetysupport](https://t.me/gennetysupport)",
    settingsDeleteAccount: "🗑 Delete Account",
    deleteAccountConfirm:
      "You sure? This will *permanently delete* your account.\n\n" +
      "Everything goes — profile, photos, matches, embeddings. " +
      "*Can't undo this.*",
    deleteAccountYes: "Yes, delete everything",
    deleteAccountNo: "Cancel",
    deleteAccountDone:
      "Account deleted. All data wiped.\n" +
      "Want to come back? Just send /start.",

    // --- Matching ---
    matchHeadline: "💘 Found you a match!",
    matchStreamStart: "Figuring out why you two click…",
    matchBtnAccept: "✅ Accept",
    matchBtnDecline: "❌ Pass",
    matchAccepted: "Nice! Waiting on the other person…",
    matchBothAccepted: "It's mutual 🔥 Let's find a time.",
    matchDeclined: "All good. Quick — *why*? Helps the AI learn.",
    matchDeclineThanks: "Noted. We'll keep looking 🎯",
    matchOtherDeclined: "Your match passed this time. We're on it though.",
    matchStarvationBoosted:
      "The algorithm didn't find a 10/10 match for you this week. " +
      "Quality over quantity — your priority is boosted to maximum for next Thursday's drop.",
    matchScheduleProposal:
      "How about one of these? Tap what works:",
    matchScheduleIter3:
      "Let's use the calendar — open it below and pick your slots.\nYour picks are saved locally, so nothing lost if you close the window.",
    matchScheduleBtnCalendar: "📅 Open Calendar",
    matchScheduleNoOverlap:
      "No overlap yet — next round.",
    matchScheduled: "Locked in! {venue} — see you there 🤝",
    matchSchedulePickedPrefix: "You picked: ",
    matchScheduleWaitingPeer: "Waiting on the other person…",
    venueConciergeIntro:
      "Time's locked 🗓️ Last step — let's nail the place.\n\n" +
      "Tell me the *vibe* (e.g. _quiet cafe_, _vegan spot_, _park walk_, _small museum_), " +
      "then tap 📎 → *Location* and share where you'll be coming from.",
    venueConciergeBtnLocation: "📍 Send my location",
    venueVibeNoted: "Vibe noted ✅ Now send your location pin.",
    venueLocationNoted: "Location pinned ✅ Now tell me the vibe.",
    venueSafetyOverride:
      "Heads up — picked a public café instead. We keep first dates in public spots.",
    venueWaitingPeer: "Got yours ✅ Waiting on the other person…",
    venueSearching: "Searching for the perfect spot between you two… 🔍",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Your date is in 3 hours! Some convo starters for you:\n\n",
    emergencyUnlocked:
      "Emergency cancel window is open.\n" +
      "If you really can't make it, tap below.\n" +
      "*You'll need to write a reason — it gets forwarded to your match exactly as you write it.*",
    emergencyBtn: "🚨 Cancel Date",
    emergencyAskReason:
      "Write your reason. This goes to your match *word for word*.",
    emergencyConfirmed:
      "Date cancelled. Your message was forwarded.",
    emergencyReceivedOther:
      "Your match cancelled the date. Here's what they said:\n\n\"{reason}\"",
    feedbackAsk:
      "How was yesterday's date? Your take helps the AI get better.\n" +
      "Drop a few sentences — good match? Anything you'd change?",
    feedbackThanks: "Thanks for the feedback ✨ We'll use it to improve your future matches.",
    // --- Reporting & Moderation ---
    reportBtn: "🚨 Report",
    reportAsk:
      "Tell us what happened. Be specific — the more detail you give, the better we can act on it.",
    reportThanksT1: "Got it — we'll use this to tune your future matches 🎯",
    reportThanksT2: "Reported. Thanks — we'll act on this.",
    reportThanksT3: "Reported. We're freezing their account for manual review — thanks for flagging.",
    reportFailed: "Couldn't process your report right now. Try again in a minute.",
    reportDuplicate: "You've already reported this match.",
    reportWarningStrike1:
      "⚠️ Heads up: we received a report about your recent match behavior. " +
      "Gennety expects respectful, reliable conduct. Another confirmed report will suspend your account.",
    reportSuspendedDM:
      "🚫 Your account has been suspended for 14 days due to repeated reports. " +
      "You won't receive matches during this period. It will auto-reactivate once the suspension ends.",
    reportBannedDM:
      "⛔ Your account has been permanently banned due to multiple confirmed reports.",
    reportPendingInvestigationDM:
      "🚫 Your account has been frozen pending a safety review. " +
      "Our team will contact you via @gennetysupport if further action is needed.",
    safetyNoteFemale:
      "Hey! Your Gennety date starts in an hour at **{location_name}**.\n\n" +
      "We care about your safety, so while you're getting ready, a quick first-date checklist:\n\n" +
      "📍 **Stick to the plan.** We picked a safe public venue for you. Don't agree to move the meeting to a private location or go to someone's place.\n" +
      "🚗 **Transport.** Get there and back on your own — public transport, taxi, or walking works. Just don't get in a car with someone you barely know.\n" +
      "📱 **Tell someone close.** Forward the meeting details to a friend or family, and if possible share your live location for the evening.\n" +
      "☕ **Stay aware.** Try not to leave your belongings or drink unattended.\n" +
      "🛑 **Your boundaries.** If you feel uncomfortable or your date's behavior seems off — you have every right to just get up and leave at any moment. Your safety always beats politeness.\n\n" +
      "Have a great evening ✨",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Next match in {d}d {h}h",
    statusHoursMinutes: "⏳ Matches drop in {h}h {m}m",
    statusMinutes: "🔥 Almost ready! Matches drop in {m}m",
    statusProcessing: "✨ Analyzing campus… Check back shortly.",

    // --- Voice notes ---
    voiceTranscriptionFailed:
      "Sorry, I couldn't hear that clearly — could you type it instead?",
    voiceTooLong:
      "That voice note's a bit long for me. Keep it under 5 minutes, or just type it out.",
  },
  ru: {
    // --- Onboarding ---
    consentMessage:
      "Добро пожаловать в Gennety Dating!\n\n" +
      "Перед началом ознакомьтесь с нашей Политикой конфиденциальности и примите условия хранения данных.",
    consentAgree: "Согласен",
    welcome: "Gennety Dating 👀\nAI-мэтчмейкинг для студентов.",
    chooseLanguage: "Выбери язык:",
    philosophyPitch:
      "Gennety работает по одному принципу: *Zero Chat*.\n\n" +
      "Ты не пишешь мэтчу. Наш ИИ разбирается, кто ты, " +
      "находит реально совместимого человека и берёт на себя всё — время, место, всю логистику.\n\n" +
      "Тебе только прийти. Заходишь?",
    philosophyContinue: "Го! 🚀",
    askEmail: "Скинь свою универскую почту (типа name@msu.edu.ru):",
    invalidEmail: "Хм, не похоже на универскую почту. Нужен адрес .edu / .ac.uk.",
    otpSent: "Код из 6 цифр улетел на *{email}*. Скинь сюда:",
    otpInvalid: "Не тот код. Попробуй ещё:",
    otpExpired: "Код протух. Введи почту заново:",
    otpTooManyAttempts: "Слишком много попыток. Введи почту заново — пришлём новый код.",
    otpCooldown: "Подожди минутку перед повторной отправкой.",
    emailVerified: "Почта подтверждена ✅",
    askFirstName: "Как тебя зовут?",
    askSurname: "Фамилия?",
    askAge: "Сколько тебе лет?",
    invalidAge: "Введи возраст от {min} до {max}.",
    askGender: "Твой пол?",
    askPreference: "Кто тебе интересен?",
    btnMale: "Мужчина",
    btnFemale: "Женщина",
    btnMen: "Мужчины",
    btnWomen: "Женщины",
    btnBoth: "Оба",
    visualScreeningIntro:
      "Определим твой тип 👀 Покажу фото — жми 👍 или 👎.",
    visualScreeningDone: "Вкус сохранён ✅",
    llmDumpIntro:
      "Теперь самое интересное 🧠\n\n" +
      "Скопируй промпт ниже, вставь в ChatGPT или Claude " +
      "и скинь мне полный ответ.\n\n" +
      "Так наш ИИ реально поймёт, кто ты — глубже любой анкеты.",
    llmPrompt:
      "Проанализируй меня как потенциального романтического партнёра. Включи:\n" +
      "1. Мои ключевые черты характера и ценности\n" +
      "2. Мой стиль общения\n" +
      "3. Мои интересы и увлечения\n" +
      "4. Какой партнёр мне подойдёт\n" +
      "5. Мои возможные dealbreakers в отношениях\n\n" +
      "Ответ в формате JSON с ключами: personality_traits, communication_style, interests, ideal_partner, dealbreakers, summary.",
    llmAnalysing1: "Читаю твой профиль... 🧠",
    llmAnalysing2: "Вытягиваю черты характера...",
    llmAnalysing3: "Собираю психологический портрет...",
    llmDumpReceived: "Профиль готов ✨",
    askPhotos: "Почти всё! Скинь {min}–{max} фото. По одному.",
    photoReceived: "Фото {n}/{max} ✅",
    photoRejected:
      "Нужно чёткое фото *только тебя* — одного человека, лицо видно.\n\n" +
      "Без мемов, пейзажей и групповых. Скинь другое.",
    photoVisionError:
      "Не получилось обработать фото. Попробуй ещё раз через секунду.",
    photosEnough: "Можешь скинуть ещё (до {max}) или жми кнопку.",
    photosDone: "Фото загружены ✅",
    profileReview:
      "Вот твой профиль:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Всё ок?",
    profileConfirm: "Всё ок ✅",
    profileEdit: "Поменять",
    onboardingComplete:
      "Ты в деле! 🎉\n\n" +
      "Наш ИИ уже ищет тебе пару. " +
      "Напишу, как только найду кого-то стоящего.",
    btnLike: "👍",
    btnDislike: "👎",
    btnContinuePhotos: "Дальше ➡️",
    finishOnboardingFirst:
      "Сначала заверши регистрацию — тогда меню и настройки станут доступны.\nНапиши /start, чтобы продолжить.",

    // --- Main Menu ---
    menuTitle: "🎓 *Меню Gennety*\nЧто делаем?",
    menuMyProfile: "👤 Мой профиль",
    menuEdit: "✏️ Редактировать",
    menuPause: "⏸ Пауза",
    menuResume: "▶️ Искать",
    menuSettings: "⚙️ Настройки",
    menuHelp: "💬 Помощь",
    menuBack: "⬅️ Назад",

    // --- My Profile ---
    myProfileBody:
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n" +
      "🌐 {language}\n\n" +
      "{summary}",
    myProfileNoBio: "_Описания пока нет._",

    // --- Edit Profile ---
    editProfileBody:
      "Это зафиксировано:\n\n" +
      "• *Имя:* {firstName} {surname}\n" +
      "• *Возраст:* {age}\n" +
      "• *Универ:* {university}\n\n" +
      "Можно поменять:",
    editBioBtn: "📝 Bio",
    editPrefsBtn: "🔍 Параметры поиска",
    editMajorBtn: "🎓 Специальность",
    editProfilePhotosBtn: "📸 Обновить фото",
    editBioPrompt: "Скинь новое описание (до 500 символов):",
    editBioTooLong: "Слишком длинно — уложись в 500.",
    editBioSaved: "Bio обновлён ✅",
    editMajorPrompt: "Какая у тебя специальность? (до 100 символов):",
    editMajorTooLong: "Слишком длинно — уложись в 100.",
    editMajorSaved: "Специальность обновлена ✅",
    editPrefsTitle: "🔍 *Параметры поиска*\n\nЧто меняем?",
    editPrefsAgeBtn: "🎂 Возраст",
    editPrefsVisualBtn: "👁 Визуальный тип",
    editPrefsBack: "⬅️ К редактированию",
    editAgeRangePrompt: "Какой возраст? (напр. 20-28)\nМин: {min}, Макс: {max}.",
    editAgeRangeInvalid: "Не понял. Два числа через дефис, напр. 20-28 (от {min} до {max}).",
    editAgeRangeSaved: "Диапазон обновлён ✅",
    editVisualRestart: "Пересмотрим твой тип 👀",
    editVisualDone: "Визуальные предпочтения обновлены ✅",
    editProfilePhotosStart: "Скинь новые фото ({min}–{max}). По одному.",
    editProfilePhotosSaved: "Фото обновлены ✅",

    // --- Pause / Resume ---
    pauseConfirmed: "Поиск на паузе ⏸\nНовых мэтчей не будет, пока не включишь.",
    resumeConfirmed: "Поиск запущен ▶️\nИИ уже работает.",

    // --- Settings ---
    settingsTitle: "⚙️ Настройки",
    settingsLanguage: "🌐 Язык",
    settingsLanguagePick: "Выбери язык:",
    settingsLanguageSaved: "Язык обновлён ✅",
    helpBody:
      "*Нужна помощь?* 💬\n\n" +
      "Чатов между юзерами у нас нет — это by design. " +
      "Проблема с мэтчем, свиданием или ботом? Пиши в саппорт:\n\n" +
      "💬 [@gennetysupport](https://t.me/gennetysupport)",
    settingsDeleteAccount: "🗑 Удалить аккаунт",
    deleteAccountConfirm:
      "Точно? Аккаунт будет *удалён навсегда*.\n\n" +
      "Всё пропадёт — профиль, фото, мэтчи, эмбеддинги. " +
      "*Это не откатить.*",
    deleteAccountYes: "Да, удалить всё",
    deleteAccountNo: "Отмена",
    deleteAccountDone:
      "Аккаунт удалён. Все данные стёрты.\n" +
      "Захочешь вернуться — отправь /start.",

    // --- Matching ---
    matchHeadline: "💘 Нашли тебе мэтч!",
    matchStreamStart: "Думаю, почему вы подходите…",
    matchBtnAccept: "✅ Принять",
    matchBtnDecline: "❌ Пас",
    matchAccepted: "Круто! Ждём ответа второй стороны…",
    matchBothAccepted: "Взаимно 🔥 Найдём время.",
    matchDeclined: "Ок. Коротко — *почему*? Так ИИ учится.",
    matchDeclineThanks: "Понял. Ищем дальше 🎯",
    matchOtherDeclined: "Мэтч в этот раз не сложился. Ищем дальше.",
    matchStarvationBoosted:
      "Алгоритм не нашёл тебе мэтч на 10/10 на этой неделе. " +
      "Лучше меньше, да лучше — твой приоритет поднят на максимум к следующему четвергу.",
    matchScheduleProposal: "Как тебе эти варианты? Жми подходящий:",
    matchScheduleIter3:
      "Давай через календарь — открой и выбери удобные слоты.\nВыбор сохраняется локально, не потеряется.",
    matchScheduleBtnCalendar: "📅 Открыть календарь",
    matchScheduleNoOverlap: "Не совпало — попробуем ещё.",
    matchScheduled: "Готово! {venue} — до встречи 🤝",
    matchSchedulePickedPrefix: "Ты выбрал: ",
    matchScheduleWaitingPeer: "Ждём выбор второй стороны…",
    venueConciergeIntro:
      "Время есть 🗓️ Последний шаг — выбираем место.\n\n" +
      "Напиши *вайб* (например _тихое кафе_, _веган_, _прогулка в парке_, _маленький музей_), " +
      "а потом нажми 📎 → *Геопозиция* и поделись, откуда поедешь.",
    venueConciergeBtnLocation: "📍 Отправить геолокацию",
    venueVibeNoted: "Вайб записан ✅ Теперь отправь геолокацию.",
    venueLocationNoted: "Геолокация получена ✅ Теперь напиши вайб.",
    venueSafetyOverride:
      "Небольшое уточнение — заменил на публичное кафе. Первые свидания у нас в людных местах.",
    venueWaitingPeer: "Принял ✅ Ждём вторую сторону…",
    venueSearching: "Ищу место, удобное обоим… 🔍",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Свидание через 3 часа! Вот темы для разговора:\n\n",
    emergencyUnlocked:
      "Окно экстренной отмены открыто.\n" +
      "Совсем не можешь прийти — жми кнопку ниже.\n" +
      "*Нужна причина — она уйдёт мэтчу ровно так, как ты её напишешь.*",
    emergencyBtn: "🚨 Отменить свидание",
    emergencyAskReason:
      "Напиши причину. Текст уйдёт мэтчу *как есть*.",
    emergencyConfirmed:
      "Свидание отменено. Сообщение переслано.",
    emergencyReceivedOther:
      "Мэтч отменил свидание. Вот что написал:\n\n\"{reason}\"",
    feedbackAsk:
      "Как вчерашнее свидание? Твой фидбэк поможет ИИ стать лучше.\n" +
      "Пару предложений — мэтч удачный? Что бы поменял?",
    feedbackThanks: "Спасибо за фидбэк ✨ Используем для улучшения.",
    // --- Reporting & Moderation ---
    reportBtn: "🚨 Пожаловаться",
    reportAsk:
      "Расскажи, что случилось. Чем конкретнее — тем эффективнее мы сможем отреагировать.",
    reportThanksT1: "Принято — учтём в будущих мэтчах 🎯",
    reportThanksT2: "Жалоба зарегистрирована. Спасибо — разберёмся.",
    reportThanksT3: "Жалоба зарегистрирована. Замораживаем их аккаунт для ручной проверки — спасибо, что сообщил(а).",
    reportFailed: "Не получилось обработать жалобу. Попробуй через минуту.",
    reportDuplicate: "Ты уже жаловался(ась) на этот мэтч.",
    reportWarningStrike1:
      "⚠️ На тебя поступила жалоба по недавнему мэтчу. " +
      "Gennety ожидает уважительного и надёжного поведения. Ещё одна подтверждённая жалоба — и аккаунт будет временно заблокирован.",
    reportSuspendedDM:
      "🚫 Твой аккаунт заблокирован на 14 дней из-за повторных жалоб. " +
      "В этот период мэтчи приходить не будут. Автоматически разблокируется после окончания срока.",
    reportBannedDM:
      "⛔ Твой аккаунт заблокирован навсегда из-за многократных подтверждённых жалоб.",
    reportPendingInvestigationDM:
      "🚫 Твой аккаунт заморожен для проверки безопасности. " +
      "Команда свяжется через @gennetysupport, если потребуются дальнейшие действия.",
    safetyNoteFemale:
      "Привет! Твое свидание от Gennety начнется уже через час в **{location_name}**.\n\n" +
      "Мы заботимся о твоей безопасности, поэтому, пока ты собираешься, вот небольшая памятка для первой встречи:\n\n" +
      "📍 **Придерживайся плана.** Мы подобрали для вас безопасное публичное место. Не соглашайся переносить встречу в уединенную локацию или ехать в гости.\n" +
      "🚗 **Транспорт.** Добирайся до места и обратно самостоятельно любым удобным тебе способом (на общественном транспорте, такси или пешком). Главное — не садись в машину к малознакомому человеку.\n" +
      "📱 **Предупреди близких.** Перешли подруге или кому-то из близких детали этой встречи и, по возможности, расшарь свою геопозицию на вечер.\n" +
      "☕ **Контроль.** Старайся не оставлять свои вещи и напиток без присмотра.\n" +
      "🛑 **Твои границы.** Если тебе некомфортно или поведение партнера кажется странным — ты имеешь полное право просто встать и уйти в любой момент. Твоя безопасность всегда важнее вежливости.\n\n" +
      "Желаем отличного вечера и приятных впечатлений! ✨",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Следующий мэтч через {d}д {h}ч",
    statusHoursMinutes: "⏳ Мэтчи прилетят через {h}ч {m}мин",
    statusMinutes: "🔥 Почти готово! Мэтчи прилетят через {m} мин",
    statusProcessing: "✨ Сканируем кампус… Загляни чуть позже.",

    // --- Voice notes ---
    voiceTranscriptionFailed:
      "Не расслышал — можешь написать текстом?",
    voiceTooLong:
      "Голосовое слишком длинное. До 5 минут — или просто напиши текстом.",
  },
  uk: {
    // --- Onboarding ---
    consentMessage:
      "Ласкаво просимо до Gennety Dating!\n\n" +
      "Перш ніж почати, ознайомтеся з нашою Політикою конфіденційності та прийміть умови зберігання даних.",
    consentAgree: "Згоден",
    welcome: "Gennety Dating 👀\nAI-метчмейкінг для студентів.",
    chooseLanguage: "Обери мову:",
    philosophyPitch:
      "Gennety працює за одним принципом: *Zero Chat*.\n\n" +
      "Ти не пишеш метчу. Наш ШІ розбирається, хто ти, " +
      "знаходить реально сумісну людину і бере на себе все — час, місце, всю логістику.\n\n" +
      "Тобі лише прийти. Заходиш?",
    philosophyContinue: "Го! 🚀",
    askEmail: "Скинь свою університетську пошту (типу name@knu.edu.ua):",
    invalidEmail: "Хм, не схоже на університетську пошту. Потрібна адреса .edu / .ac.uk.",
    otpSent: "Код із 6 цифр полетів на *{email}*. Скинь сюди:",
    otpInvalid: "Не той код. Спробуй ще:",
    otpExpired: "Код протермінувався. Введи пошту знову:",
    otpTooManyAttempts: "Забагато спроб. Введи пошту знову — надішлемо новий код.",
    otpCooldown: "Зачекай хвилинку перед повторним надсиланням.",
    emailVerified: "Пошту підтверджено ✅",
    askFirstName: "Як тебе звати?",
    askSurname: "Прізвище?",
    askAge: "Скільки тобі років?",
    invalidAge: "Введи вік від {min} до {max}.",
    askGender: "Твоя стать?",
    askPreference: "Хто тобі цікавий?",
    btnMale: "Чоловік",
    btnFemale: "Жінка",
    btnMen: "Чоловіки",
    btnWomen: "Жінки",
    btnBoth: "Обидва",
    visualScreeningIntro:
      "Визначимо твій тип 👀 Покажу фото — тисни 👍 або 👎.",
    visualScreeningDone: "Смак збережено ✅",
    llmDumpIntro:
      "Тепер найцікавіше 🧠\n\n" +
      "Скопіюй промпт нижче, встав у ChatGPT або Claude " +
      "і скинь мені повну відповідь.\n\n" +
      "Так наш ШІ реально зрозуміє, хто ти — глибше за будь-яку анкету.",
    llmPrompt:
      "Проаналізуй мене як потенційного романтичного партнера. Включи:\n" +
      "1. Мої ключові риси характеру та цінності\n" +
      "2. Мій стиль спілкування\n" +
      "3. Мої інтереси та захоплення\n" +
      "4. Який партнер мені підійде\n" +
      "5. Мої можливі dealbreakers у стосунках\n\n" +
      "Відповідь у форматі JSON з ключами: personality_traits, communication_style, interests, ideal_partner, dealbreakers, summary.",
    llmAnalysing1: "Читаю твій профіль... 🧠",
    llmAnalysing2: "Витягую риси характеру...",
    llmAnalysing3: "Збираю психологічний портрет...",
    llmDumpReceived: "Профіль готовий ✨",
    askPhotos: "Майже все! Скинь {min}–{max} фото. По одному.",
    photoReceived: "Фото {n}/{max} ✅",
    photoRejected:
      "Потрібне чітке фото *тільки тебе* — одна людина, обличчя видно.\n\n" +
      "Без мемів, пейзажів та групових фото. Скинь інше.",
    photoVisionError:
      "Не вдалося обробити фото. Спробуй ще раз через секунду.",
    photosEnough: "Можеш надіслати ще (до {max}) або тисни кнопку.",
    photosDone: "Фото завантажено ✅",
    profileReview:
      "Ось твій профіль:\n\n" +
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n\n" +
      "{summary}\n\n" +
      "Все ок?",
    profileConfirm: "Все ок ✅",
    profileEdit: "Змінити",
    onboardingComplete:
      "Ти в грі! 🎉\n\n" +
      "Наш ШІ вже шукає тобі пару. " +
      "Напишу, як тільки знайду когось стоящого.",
    btnLike: "👍",
    btnDislike: "👎",
    btnContinuePhotos: "Далі ➡️",
    finishOnboardingFirst:
      "Спочатку заверши реєстрацію — тоді меню та налаштування стануть доступні.\nНапиши /start, щоб продовжити.",

    // --- Main Menu ---
    menuTitle: "🎓 *Меню Gennety*\nЩо робимо?",
    menuMyProfile: "👤 Мій профіль",
    menuEdit: "✏️ Редагувати",
    menuPause: "⏸ Пауза",
    menuResume: "▶️ Шукати",
    menuSettings: "⚙️ Налаштування",
    menuHelp: "💬 Допомога",
    menuBack: "⬅️ Назад",

    // --- My Profile ---
    myProfileBody:
      "*{firstName} {surname}*, {age}\n" +
      "🎓 {university}\n" +
      "🌐 {language}\n\n" +
      "{summary}",
    myProfileNoBio: "_Опису ще немає._",

    // --- Edit Profile ---
    editProfileBody:
      "Це зафіксовано:\n\n" +
      "• *Ім'я:* {firstName} {surname}\n" +
      "• *Вік:* {age}\n" +
      "• *Універ:* {university}\n\n" +
      "Можна змінити:",
    editBioBtn: "📝 Bio",
    editPrefsBtn: "🔍 Параметри пошуку",
    editMajorBtn: "🎓 Спеціальність",
    editProfilePhotosBtn: "📸 Оновити фото",
    editBioPrompt: "Скинь новий опис (до 500 символів):",
    editBioTooLong: "Задовге — вклади в 500.",
    editBioSaved: "Опис оновлено ✅",
    editMajorPrompt: "Яка в тебе спеціальність? (до 100 символів):",
    editMajorTooLong: "Задовге — вклади в 100.",
    editMajorSaved: "Спеціальність оновлено ✅",
    editPrefsTitle: "🔍 *Параметри пошуку*\n\nЩо міняємо?",
    editPrefsAgeBtn: "🎂 Вік",
    editPrefsVisualBtn: "👁 Візуальний тип",
    editPrefsBack: "⬅️ До редагування",
    editAgeRangePrompt: "Який вік? (напр. 20-28)\nМін: {min}, Макс: {max}.",
    editAgeRangeInvalid: "Не зрозумів. Два числа через дефіс, напр. 20-28 (від {min} до {max}).",
    editAgeRangeSaved: "Діапазон оновлено ✅",
    editVisualRestart: "Переглянемо твій тип 👀",
    editVisualDone: "Візуальні вподобання оновлено ✅",
    editProfilePhotosStart: "Скинь нові фото ({min}–{max}). По одному.",
    editProfilePhotosSaved: "Фото оновлено ✅",

    // --- Pause / Resume ---
    pauseConfirmed: "Пошук на паузі ⏸\nНових метчів не буде, поки не ввімкнеш.",
    resumeConfirmed: "Пошук запущено ▶️\nШІ вже працює.",

    // --- Settings ---
    settingsTitle: "⚙️ Налаштування",
    settingsLanguage: "🌐 Мова",
    settingsLanguagePick: "Обери мову:",
    settingsLanguageSaved: "Мову оновлено ✅",
    helpBody:
      "*Потрібна допомога?* 💬\n\n" +
      "Чатів між юзерами у нас немає — це by design. " +
      "Проблема з метчем, побаченням чи ботом? Пиши в сапорт:\n\n" +
      "💬 [@gennetysupport](https://t.me/gennetysupport)",
    settingsDeleteAccount: "🗑 Видалити акаунт",
    deleteAccountConfirm:
      "Точно? Акаунт буде *видалено назавжди*.\n\n" +
      "Все зникне — профіль, фото, метчі, ембедінги. " +
      "*Це не відкотити.*",
    deleteAccountYes: "Так, видалити все",
    deleteAccountNo: "Скасувати",
    deleteAccountDone:
      "Акаунт видалено. Усі дані стерто.\n" +
      "Захочеш повернутись — надішли /start.",

    // --- Matching ---
    matchHeadline: "💘 Знайшли тобі метч!",
    matchStreamStart: "Думаю, чому ви підходите…",
    matchBtnAccept: "✅ Прийняти",
    matchBtnDecline: "❌ Пас",
    matchAccepted: "Круто! Чекаємо на відповідь іншої сторони…",
    matchBothAccepted: "Взаємно 🔥 Знайдемо час.",
    matchDeclined: "Ок. Коротко — *чому*? Так ШІ вчиться.",
    matchDeclineThanks: "Зрозуміли. Шукаємо далі 🎯",
    matchOtherDeclined: "Метч цього разу не склався. Шукаємо далі.",
    matchStarvationBoosted:
      "Алгоритм не знайшов тобі метч на 10/10 цього тижня. " +
      "Краще менше, та краще — твій пріоритет піднято на максимум до наступного четверга.",
    matchScheduleProposal: "Як тобі ці варіанти? Тисни зручний:",
    matchScheduleIter3:
      "Давай через календар — відкрий і обери слоти.\nВибір зберігається локально, не загубиться.",
    matchScheduleBtnCalendar: "📅 Відкрити календар",
    matchScheduleNoOverlap: "Не збіглося — спробуємо ще.",
    matchScheduled: "Готово! {venue} — до зустрічі 🤝",
    matchSchedulePickedPrefix: "Ти обрав: ",
    matchScheduleWaitingPeer: "Чекаємо на вибір іншої сторони…",
    venueConciergeIntro:
      "Час зафіксовано 🗓️ Останній крок — обираємо місце.\n\n" +
      "Напиши *вайб* (наприклад _тихе кафе_, _веган_, _прогулянка в парку_, _невеликий музей_), " +
      "а потім натисни 📎 → *Геолокація* і поділись, звідки виїжджатимеш.",
    venueConciergeBtnLocation: "📍 Надіслати геолокацію",
    venueVibeNoted: "Вайб записано ✅ Тепер надішли геолокацію.",
    venueLocationNoted: "Геолокацію отримано ✅ Тепер напиши вайб.",
    venueSafetyOverride:
      "Невеличке уточнення — заміняю на публічне кафе. Перші побачення у нас у людних місцях.",
    venueWaitingPeer: "Прийняв ✅ Чекаємо на іншу сторону…",
    venueSearching: "Шукаю місце, зручне обом… 🔍",

    // --- Phase 4: Date ---
    icebreakerIntro:
      "Побачення через 3 години! Ось теми для розмови:\n\n",
    emergencyUnlocked:
      "Вікно екстреного скасування відкрите.\n" +
      "Зовсім не можеш прийти — тисни кнопку нижче.\n" +
      "*Потрібна причина — вона піде метчу саме так, як ти її напишеш.*",
    emergencyBtn: "🚨 Скасувати побачення",
    emergencyAskReason:
      "Напиши причину. Текст піде метчу *як є*.",
    emergencyConfirmed:
      "Побачення скасовано. Повідомлення переслано.",
    emergencyReceivedOther:
      "Метч скасував побачення. Ось що написав:\n\n\"{reason}\"",
    feedbackAsk:
      "Як вчорашнє побачення? Твій фідбек допоможе ШІ стати кращим.\n" +
      "Пару речень — метч вдалий? Що б змінив?",
    feedbackThanks: "Дякую за фідбек ✨ Використаємо для покращення.",
    // --- Reporting & Moderation ---
    reportBtn: "🚨 Поскаржитися",
    reportAsk:
      "Розкажи, що сталося. Чим конкретніше — тим ефективніше ми зможемо зреагувати.",
    reportThanksT1: "Прийнято — врахуємо в майбутніх мєтчах 🎯",
    reportThanksT2: "Скаргу зареєстровано. Дякуємо — розберемося.",
    reportThanksT3: "Скаргу зареєстровано. Заморожуємо їхній акаунт для ручної перевірки — дякуємо, що повідомив(ла).",
    reportFailed: "Не вдалося обробити скаргу. Спробуй за хвилину.",
    reportDuplicate: "Ти вже скаржився(лася) на цей мєтч.",
    reportWarningStrike1:
      "⚠️ На тебе надійшла скарга щодо нещодавнього мєтчу. " +
      "Gennety очікує шанобливої та надійної поведінки. Ще одна підтверджена скарга — і акаунт буде тимчасово заблоковано.",
    reportSuspendedDM:
      "🚫 Твій акаунт заблоковано на 14 днів через повторні скарги. " +
      "У цей період мєтчі не надходитимуть. Автоматично розблокується після завершення терміну.",
    reportBannedDM:
      "⛔ Твій акаунт заблоковано назавжди через численні підтверджені скарги.",
    reportPendingInvestigationDM:
      "🚫 Твій акаунт заморожено для перевірки безпеки. " +
      "Команда зв'яжеться через @gennetysupport, якщо знадобляться подальші дії.",
    safetyNoteFemale:
      "Привіт! Твоє побачення від Gennety почнеться вже за годину в **{location_name}**.\n\n" +
      "Ми дбаємо про твою безпеку, тож поки ти збираєшся — невелика пам'ятка для першої зустрічі:\n\n" +
      "📍 **Дотримуйся плану.** Ми підібрали для вас безпечне публічне місце. Не погоджуйся переносити зустріч до усамітненої локації чи їхати в гості.\n" +
      "🚗 **Транспорт.** Добирайся туди і назад самостійно будь-яким зручним способом (громадським транспортом, таксі чи пішки). Головне — не сідай у машину до малознайомої людини.\n" +
      "📱 **Попередь близьких.** Перешли подрузі або комусь із близьких деталі цієї зустрічі і, якщо є можливість, поділися геолокацією на вечір.\n" +
      "☕ **Контроль.** Намагайся не залишати речі й напій без нагляду.\n" +
      "🛑 **Твої межі.** Якщо тобі некомфортно або поведінка партнера здається дивною — маєш повне право просто встати і піти в будь-який момент. Твоя безпека завжди важливіша за ввічливість.\n\n" +
      "Бажаємо чудового вечора і приємних вражень ✨",
    // --- Pinned status banner (live discrete timer) ---
    statusDaysHours: "⏳ Наступний метч через {d}д {h}г",
    statusHoursMinutes: "⏳ Метчі прилетять через {h}г {m}хв",
    statusMinutes: "🔥 Майже готово! Метчі прилетять за {m} хв",
    statusProcessing: "✨ Скануємо кампус… Зазирни трохи згодом.",

    // --- Voice notes ---
    voiceTranscriptionFailed:
      "Не розчув — можеш написати текстом?",
    voiceTooLong:
      "Голосове задовге. До 5 хвилин — або просто напиши текстом.",
  },
} as const;

export type TranslationKey = keyof (typeof translations)["en"];

/** Get a translated string, with optional placeholder replacement */
export function t(
  lang: Language,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  let text: string = translations[lang][key];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

/**
 * Escape Telegram Markdown v1 special characters so user-provided
 * content doesn't break `parse_mode: "Markdown"`.
 */
export function escapeMd(text: string): string {
  return text.replace(/([_*`\[])/g, "\\$1");
}
