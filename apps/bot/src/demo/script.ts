import type { Language } from "@gennety/shared";

/**
 * What the demo says out loud.
 *
 * The demo shows the real product, so most of what a visitor reads is ordinary
 * production copy. These are the few places where the demo has to speak as
 * itself: to explain that a gate is fake, to explain what would normally take
 * days, and to point out the one capability that is easy to miss because it has
 * no button — that the bot is a conversational agent you can just talk to.
 *
 * Every beat is triggered by a state the driver *observes* (the collector
 * reached the photo stage; onboarding finished but liveness has not; the match
 * became `scheduled`), never by a callback wired into the production handlers.
 * That is what keeps demo mode from breaking when those flows change.
 *
 * Languages: `ru`, `uk` and `en` are written out; `de` and `pl` fall back to
 * `en`. A deliberate scope call — these are long explanatory paragraphs for an
 * audience that is Russian-, Ukrainian- or English-speaking in practice, and a
 * half-translated demo reads worse than an English one. If a German or Polish
 * demo is ever needed, add the two blocks here; nothing else has to change.
 */

export type DemoBeat =
  | "intro"
  | "photos"
  | "verification"
  | "matchmaking"
  | "date_ready"
  | "predate"
  | "declined"
  | "finale"
  | "stuck"
  | "restarted";

type BeatCopy = Partial<Record<Language, string>> & { en: string };

const SCRIPT: Record<DemoBeat, BeatCopy> = {
  // ── 1. First contact, before onboarding starts ──────────────────────────
  intro: {
    ru:
      "Это демо-режим Gennety. 👋\n\n" +
      "Всё, что вы увидите дальше — настоящий продукт: те же экраны, те же " +
      "карточки, та же логика. Отличий ровно четыре, и все в вашу пользу:\n\n" +
      "• фотографии можно загрузить любые — они не обязаны быть вашими;\n" +
      "• проверка личности пройдёт в любом случае;\n" +
      "• оплата симулируется, деньги не списываются;\n" +
      "• ждать ничего не придётся — то, на что в жизни уходят дни, здесь " +
      "занимает секунды.\n\n" +
      "И главное, что легко пропустить: этот бот — не набор кнопок. У вас " +
      "есть личный AI-агент, и с ним можно просто разговаривать — текстом или " +
      "голосовым сообщением, в любой момент. Он видит весь диалог и все детали " +
      "вашего свидания в реальном времени: спросите «почему именно она?», " +
      "«когда у меня свидание?», «поменяй мне описание профиля», «отмени " +
      "свидание» — и он ответит или сделает. Попробуйте по ходу, это самая " +
      "интересная часть.\n\n" +
      "Начнём. 👇",
    uk:
      "Це демо-режим Gennety. 👋\n\n" +
      "Усе, що ви побачите далі — справжній продукт: ті самі екрани, ті самі " +
      "картки, та сама логіка. Відмінностей рівно чотири, і всі на вашу " +
      "користь:\n\n" +
      "• фотографії можна завантажити будь-які — вони не мусять бути вашими;\n" +
      "• перевірка особи пройде в будь-якому разі;\n" +
      "• оплата симулюється, гроші не списуються;\n" +
      "• чекати нічого не доведеться — те, на що в житті йдуть дні, тут займає " +
      "секунди.\n\n" +
      "І головне, що легко пропустити: цей бот — не набір кнопок. У вас є " +
      "особистий AI-агент, і з ним можна просто розмовляти — текстом або " +
      "голосовим повідомленням, будь-коли. Він бачить увесь діалог і всі " +
      "деталі вашого побачення в реальному часі: запитайте «чому саме вона?», " +
      "«коли в мене побачення?», «зміни мені опис профілю», «скасуй " +
      "побачення» — і він відповість або зробить. Спробуйте дорогою, це " +
      "найцікавіша частина.\n\n" +
      "Почнімо. 👇",
    en:
      "This is the Gennety demo. 👋\n\n" +
      "Everything you are about to see is the real product — same screens, same " +
      "cards, same logic. There are exactly four differences, all in your " +
      "favour:\n\n" +
      "• upload any photos you like — they don't have to be of you;\n" +
      "• the identity check will pass no matter what;\n" +
      "• payments are simulated, nothing is charged;\n" +
      "• you won't wait for anything — what takes days in real life takes " +
      "seconds here.\n\n" +
      "And the part that's easiest to miss: this bot isn't a set of buttons. " +
      "You have a personal AI agent, and you can simply talk to it — by text or " +
      "voice, at any point. It sees the whole conversation and every detail of " +
      "your date in real time: ask it \"why her?\", \"when is my date?\", " +
      "\"rewrite my bio\", \"cancel the date\" — it will answer, or do it. Try " +
      "it as you go; it's the most interesting part.\n\n" +
      "Let's start. 👇",
  },

  // ── 2. The collector reached the photo stage ────────────────────────────
  photos: {
    ru:
      "📷 Небольшая ремарка перед фотографиями.\n\n" +
      "В настоящем продукте это важный шаг: фото проверяются и потом " +
      "сверяются с вашим лицом при верификации. В демо этого нет — загрузите " +
      "любые три картинки, какие под рукой. Свои, чужие, пейзажи — всё " +
      "подойдёт, ничего не проверяется.",
    uk:
      "📷 Невелика ремарка перед фотографіями.\n\n" +
      "У справжньому продукті це важливий крок: фото перевіряються, а потім " +
      "звіряються з вашим обличчям під час верифікації. У демо цього немає — " +
      "завантажте будь-які три картинки, які є під рукою. Свої, чужі, " +
      "пейзажі — усе підійде, нічого не перевіряється.",
    en:
      "📷 One note before the photos.\n\n" +
      "In the real product this step matters: photos are validated and later " +
      "matched against your face during verification. Not here — upload any " +
      "three images you have to hand. Yours, someone else's, landscapes — " +
      "anything works, nothing is checked.",
  },

  // ── 3. Onboarding finished, liveness gate is next ───────────────────────
  verification: {
    ru:
      "🪪 Дальше — верификация личности.\n\n" +
      "В продакшене это обязательный шаг и именно он держит платформу " +
      "настоящей: живой человек снимает себя на камеру, AWS подтверждает, что " +
      "это живое лицо, а не фото или видео, и затем оно сверяется с " +
      "фотографиями в профиле. Без этого аккаунт в подбор не попадает.\n\n" +
      "Здесь проверка запустится по-настоящему — вы увидите тот же экран и ту " +
      "же камеру — но результат всегда будет положительным. Даже если " +
      "фотографии в профиле не ваши, вас пропустят.",
    uk:
      "🪪 Далі — верифікація особи.\n\n" +
      "У продакшені це обов'язковий крок, і саме він тримає платформу " +
      "справжньою: жива людина знімає себе на камеру, AWS підтверджує, що це " +
      "живе обличчя, а не фото чи відео, і потім воно звіряється з " +
      "фотографіями в профілі. Без цього акаунт у підбір не потрапляє.\n\n" +
      "Тут перевірка запуститься по-справжньому — ви побачите той самий екран " +
      "і ту саму камеру — але результат завжди буде позитивним. Навіть якщо " +
      "фотографії в профілі не ваші, вас пропустять.",
    en:
      "🪪 Identity verification is next.\n\n" +
      "In production this step is mandatory, and it is what keeps the platform " +
      "real: a live person films themselves, AWS confirms it is a live face " +
      "rather than a photo or a video, and that face is then matched against " +
      "the profile photos. Without it an account never enters matching.\n\n" +
      "Here the check will genuinely run — same screen, same camera — but the " +
      "result is always a pass. Even if the profile photos aren't yours, " +
      "you'll be let through.",
  },

  // ── 4. Verified. Explain matchmaking, then hand over the pitch ──────────
  matchmaking: {
    ru:
      "✅ Готово, вы в системе. Теперь — как это работает на самом деле.\n\n" +
      "У каждого пользователя есть свой AI-матчмейкер. Он собирает контекст из " +
      "онбординга, ваших ответов и психологического портрета, а потом " +
      "прогоняет всех кандидатов города через несколько слоёв: совместимость " +
      "по смыслу, по темпу и характеру, по возрасту, по привлекательности, " +
      "плюс жёсткие фильтры — верификация, город, отсутствие повторов. " +
      "Из этого остаётся один человек.\n\n" +
      "По расписанию — регулярно, а не по запросу — вам приходит одна " +
      "анкета. Не лента, не свайпы: один человек, которого выбрали для вас. " +
      "Вы говорите да или нет, и если оба сказали да, я довожу вас до " +
      "реального свидания.\n\n" +
      "Ждать неделю мы сейчас не будем. Вот ваша анкета — посмотрите её и " +
      "просто напишите мне текстом, что хотите пойти на свидание. Дальше я " +
      "проведу вас по всему флоу. 👇",
    uk:
      "✅ Готово, ви в системі. Тепер — як це працює насправді.\n\n" +
      "У кожного користувача є свій AI-метчмейкер. Він збирає контекст із " +
      "онбордингу, ваших відповідей і психологічного портрета, а потім " +
      "проганяє всіх кандидатів міста крізь кілька шарів: сумісність за " +
      "змістом, за темпом і характером, за віком, за привабливістю, плюс " +
      "жорсткі фільтри — верифікація, місто, відсутність повторів. Із цього " +
      "лишається одна людина.\n\n" +
      "За розкладом — регулярно, а не на запит — вам приходить одна анкета. " +
      "Не стрічка, не свайпи: одна людина, яку обрали для вас. Ви кажете так " +
      "чи ні, і якщо обидва сказали так, я доводжу вас до справжнього " +
      "побачення.\n\n" +
      "Чекати тиждень ми зараз не будемо. Ось ваша анкета — подивіться її й " +
      "просто напишіть мені текстом, що хочете піти на побачення. Далі я " +
      "проведу вас усім флоу. 👇",
    en:
      "✅ You're in. Now — how this actually works.\n\n" +
      "Every user has their own AI matchmaker. It builds context from " +
      "onboarding, your answers and your psychological profile, then runs every " +
      "candidate in your city through several layers: compatibility by meaning, " +
      "by tempo and character, by age, by attractiveness — plus hard filters " +
      "like verification, city, and never repeating a pair. One person comes " +
      "out of that.\n\n" +
      "On a schedule — regularly, not on demand — you get one profile. No feed, " +
      "no swiping: one person, chosen for you. You say yes or no, and if you " +
      "both say yes, I take it all the way to a real date.\n\n" +
      "We won't wait a week right now. Here is your profile — take a look, then " +
      "just reply in plain text that you want to go on the date. I'll walk you " +
      "through the rest. 👇",
  },

  // ── 5. Date is scheduled. Hand the visitor the card and get out of the way ─
  //
  // This beat exists because the demo used to skip it: twelve seconds after the
  // date locked in, the pre-date replay buried the date card under ice-breakers,
  // a safety brief and a feedback form. The card is the centrepiece of the whole
  // product and it carries three live affordances (venue change, Maps, the
  // blurred share copy) that a visitor never got to touch.
  date_ready: {
    ru:
      "📍 Свидание назначено — карточка выше.\n\n" +
      "Прежде чем я покажу, что происходит дальше, потыкайте её. Всё рабочее:\n\n" +
      "• «Сменить место» — общая доска с вариантами рядом. Вы отмечаете, что " +
      "нравится, партнёр видит это вживую, совпало — место меняется. В " +
      "продакшене шаг платный, здесь бесплатный;\n" +
      "• «Открыть в картах» — заведение настоящее, можно проверить;\n" +
      "• «Поделиться» — та же карточка для друзей, но лицо пары размыто;\n" +
      "• и спросите агента что угодно про свидание — текстом или голосом.\n\n" +
      "Как наиграетесь — жмите кнопку. Если не нажмёте, я сам продолжу через " +
      "несколько минут.",
    uk:
      "📍 Побачення призначено — картка вище.\n\n" +
      "Перш ніж я покажу, що відбувається далі, потикайте її. Усе робоче:\n\n" +
      "• «Змінити місце» — спільна дошка з варіантами поруч. Ви позначаєте, що " +
      "подобається, партнер бачить це наживо, збіглося — місце змінюється. У " +
      "продакшені крок платний, тут безкоштовний;\n" +
      "• «Відкрити в картах» — заклад справжній, можна перевірити;\n" +
      "• «Поділитися» — та сама картка для друзів, але обличчя пари розмите;\n" +
      "• і запитайте агента будь-що про побачення — текстом або голосом.\n\n" +
      "Як награєтеся — тисніть кнопку. Якщо не натиснете, я сам продовжу за " +
      "кілька хвилин.",
    en:
      "📍 The date is set — the card is above.\n\n" +
      "Before I show you what happens next, play with it. All of it is live:\n\n" +
      "• \"Change venue\" — a shared board of alternatives nearby. You heart what " +
      "you like, your match sees it in real time, an overlap changes the place. " +
      "In production this step is paid; here it's free;\n" +
      "• \"Open in Maps\" — the venue is real, go check;\n" +
      "• \"Share\" — the same card for friends, with your match's face blurred;\n" +
      "• and ask the agent anything about the date — by text or voice.\n\n" +
      "Tap the button when you're done. If you don't, I'll carry on by myself in " +
      "a few minutes.",
  },

  // ── 6. The days before the date, compressed ─────────────────────────────
  predate: {
    ru:
      "📅 Свидание назначено — и в настоящем продукте на этом моменте " +
      "наступает пауза на несколько дней.\n\n" +
      "Вот что происходит в это время. Я жду до даты и не беспокою вас без " +
      "повода. За несколько часов до встречи присылаю подсказки: о чём с этим " +
      "человеком интереснее всего говорить, какие темы у вас пересекаются, " +
      "пару готовых вопросов, чтобы снять неловкость и заполнить паузу, если " +
      "она возникнет. Отдельно — короткий совет, который видите только вы: то, " +
      "что стоит знать про вашу пару. Ближе к встрече напоминаю детали: место, " +
      "время, как добраться. А на следующий день после свидания спрашиваю, как " +
      "всё прошло — и этот ответ делает следующий подбор точнее.\n\n" +
      "Сейчас я проиграю всё это подряд, без ожидания. 👇",
    uk:
      "📅 Побачення призначено — і в справжньому продукті на цьому моменті " +
      "настає пауза на кілька днів.\n\n" +
      "Ось що відбувається в цей час. Я чекаю до дати й не турбую вас без " +
      "приводу. За кілька годин до зустрічі надсилаю підказки: про що з цією " +
      "людиною найцікавіше говорити, які теми у вас перетинаються, кілька " +
      "готових запитань, щоб зняти незручність і заповнити паузу, якщо вона " +
      "виникне. Окремо — коротка порада, яку бачите тільки ви: те, що варто " +
      "знати про вашу пару. Ближче до зустрічі нагадую деталі: місце, час, як " +
      "дістатися. А наступного дня після побачення запитую, як усе минуло — і " +
      "ця відповідь робить наступний підбір точнішим.\n\n" +
      "Зараз я програю все це поспіль, без очікування. 👇",
    en:
      "📅 The date is set — and in the real product this is where a pause of " +
      "several days begins.\n\n" +
      "Here is what happens during it. I wait, and I don't bother you without " +
      "reason. A few hours before you meet, I send conversation help: what this " +
      "person is most interesting to talk to about, where your interests " +
      "overlap, and a couple of ready-made questions to break the ice or fill a " +
      "pause if one shows up. Separately, a short tip only you see — something " +
      "worth knowing about your match. Closer to the time I remind you of the " +
      "details: place, time, how to get there. And the day after, I ask how it " +
      "went — and that answer makes the next match sharper.\n\n" +
      "I'll play all of it now, back to back. 👇",
  },

  // ── Recovery: the visitor passed on the profile ─────────────────────────
  declined: {
    ru:
      "Так и работает продукт: отказ окончательный. Эта пара больше никогда " +
      "не встретится в подборе, и в жизни вы бы просто дождались следующей " +
      "анкеты.\n\n" +
      "Но мы здесь ради демо — могу показать тот же путь ещё раз.",
    uk:
      "Так і працює продукт: відмова остаточна. Ця пара більше ніколи не " +
      "зустрінеться в підборі, і в житті ви б просто дочекалися наступної " +
      "анкети.\n\n" +
      "Але ми тут заради демо — можу показати той самий шлях ще раз.",
    en:
      "That's how the product works: a pass is final. This pair will never be " +
      "shown to each other again, and in real life you would simply wait for " +
      "the next profile.\n\n" +
      "But we're here for the demo — I can show you the same path again.",
  },

  // ── The demo ran all the way through ────────────────────────────────────
  //
  // Deliberately NOT the `declined` copy. Both endings leave a terminal match
  // row, and for the first day of demo mode both produced "you passed on this
  // person, in production that's final" — told to someone who had just been
  // walked through a successful date from pitch to post-date feedback.
  finale: {
    ru:
      "🎬 Вот и весь продукт — от регистрации до отзыва после свидания.\n\n" +
      "В жизни этот путь занял бы полторы недели: подбор по расписанию, сутки " +
      "на решение, переписка о времени, выбор места, ожидание до встречи и " +
      "вопрос на следующий день. Здесь всё это уложилось в несколько минут, но " +
      "экраны, карточки и логика были ровно те же.\n\n" +
      "Хотите пройти заново с чистого листа — /restart. Или могу показать ещё " +
      "одну анкету и второй заход по флоу.",
    uk:
      "🎬 Ось і весь продукт — від реєстрації до відгуку після побачення.\n\n" +
      "У житті цей шлях зайняв би півтора тижня: підбір за розкладом, доба на " +
      "рішення, узгодження часу, вибір місця, очікування до зустрічі й " +
      "запитання наступного дня. Тут усе це вклалося в кілька хвилин, але " +
      "екрани, картки й логіка були рівно ті самі.\n\n" +
      "Хочете пройти заново з чистого аркуша — /restart. Або можу показати ще " +
      "одну анкету й другий захід по флоу.",
    en:
      "🎬 That's the whole product — from sign-up to the post-date feedback.\n\n" +
      "In real life this path takes about a week and a half: a match on a " +
      "schedule, a day to decide, agreeing a time, choosing a place, the wait " +
      "until you meet, and the question the day after. Here it took minutes — " +
      "but the screens, the cards and the logic were exactly the same.\n\n" +
      "Want to run it again from scratch? /restart. Or I can show you another " +
      "profile and a second pass through the flow.",
  },

  // ── The puppet's move failed several times running ──────────────────────
  //
  // The demo's worst failure is not an error, it is silence: a step that
  // refuses is retried every tick forever while the chat says nothing, which is
  // exactly how a ticket gate stood still for hours in front of whoever was
  // being shown the product. Saying so out loud costs a sentence and turns a
  // dead demo into a recoverable one.
  //
  // Deliberately vague about WHAT broke — the visitor cannot act on
  // `insufficient-balance`, and the log carries the real reason for us.
  stuck: {
    ru:
      "🛠 Кажется, я застрял на этом шаге — это демо, и здесь такое бывает.\n\n" +
      "Дальше сам не поеду, чтобы не морочить вам голову. Напишите /restart — " +
      "начнём с чистого листа, это займёт пару минут.",
    uk:
      "🛠 Здається, я застряг на цьому кроці — це демо, тут таке буває.\n\n" +
      "Далі сам не поїду, щоб не морочити вам голову. Напишіть /restart — " +
      "почнемо з чистого аркуша, це займе пару хвилин.",
    en:
      "🛠 Looks like I'm stuck on this step — it's a demo, it happens.\n\n" +
      "I'm not going to pretend otherwise and keep you waiting. Send /restart " +
      "and we'll begin from a clean slate; it takes a couple of minutes.",
  },

  restarted: {
    ru:
      "🔄 Демо сброшено. Профиль, фотографии и свидание удалены — начинаем с " +
      "чистого листа.\n\nНапишите /start, когда будете готовы.",
    uk:
      "🔄 Демо скинуто. Профіль, фотографії та побачення видалено — " +
      "починаємо з чистого аркуша.\n\nНапишіть /start, коли будете готові.",
    en:
      "🔄 Demo reset. Profile, photos and date are gone — clean slate.\n\n" +
      "Send /start whenever you're ready.",
  },
};

/**
 * Callback data for the demo's own two buttons.
 *
 * They live beside the labels rather than in the router: the driver builds the
 * keyboards and the router answers the taps, so a constant owned by either one
 * would make the other import it and close a cycle.
 */
export const DEMO_CONTINUE_CALLBACK = "demo:continue";
export const DEMO_PREDATE_CALLBACK = "demo:predate";

/**
 * Button labels.
 *
 * The two "show me a profile again" endings read differently on purpose: after
 * a pass the visitor is being offered the SAME path back, after a finished demo
 * they are being offered a second run. Same handler, different promise.
 */
const CONTINUE_LABEL: BeatCopy = {
  ru: "▶️ Показать анкету снова",
  uk: "▶️ Показати анкету знову",
  en: "▶️ Show me the profile again",
};

const ANOTHER_LABEL: BeatCopy = {
  ru: "▶️ Показать ещё одну анкету",
  uk: "▶️ Показати ще одну анкету",
  en: "▶️ Show me another profile",
};

const PREDATE_LABEL: BeatCopy = {
  ru: "▶️ Что происходит дальше",
  uk: "▶️ Що відбувається далі",
  en: "▶️ What happens next",
};

export function demoText(beat: DemoBeat, language: Language | null): string {
  return resolve(SCRIPT[beat], language);
}

export function demoContinueLabel(
  beat: "declined" | "finale",
  language: Language | null,
): string {
  return resolve(beat === "finale" ? ANOTHER_LABEL : CONTINUE_LABEL, language);
}

export function demoPredateLabel(language: Language | null): string {
  return resolve(PREDATE_LABEL, language);
}

function resolve(copy: BeatCopy, language: Language | null): string {
  if (!language) return copy.en;
  return copy[language] ?? copy.en;
}
