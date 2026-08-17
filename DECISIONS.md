# DECISIONS.md — decision and deviation journal

> Living document (AGENTS.md protocol). This file holds what exists **nowhere
> else**: a decision voiced in conversation, a change of mind mid-task, a
> deviation from the plan, or a piece of scope deliberately not done.
>
> **Why it exists.** A new session reads files, not the conversation. Anything
> agreed in chat and never written down disappears with the context window — and
> the next session will faithfully rebuild the thing we decided against.
>
> Client-side decisions live in the iOS repo's `DECISIONS.md`
> (`~/Desktop/Gennety-iOS`). Both files load automatically via their `CLAUDE.md`.

## Write here when (mandatory)

1. **The founder makes a product decision in conversation** — including "no, we
   are not doing that", and including cases where no code changed.
2. **I change my own mind mid-task** — the implementation departs from what I
   wrote in the plan or in a previous block.
3. **A deviation from the plan** — different scope, different approach, or a
   different order than planned.
4. **Deliberately not done** — scope deferred or dropped, with the reason.
5. **A document turned out to be wrong** — PRODUCT_SPEC / ARCHITECTURE / deploy.md
   describes something the code does not do (or vice versa). Record it here and
   fix the document.

## Do NOT write here

- Ordinary implementation that followed the plan — the commit and the spec
  section already carry it.
- Details obvious from the code. The decision, yes; the mechanics, no.
- Bugs found and fixed: those belong in PRODUCT_SPEC/ARCHITECTURE next to the
  behaviour they changed, or in the deploy.md block for that release.

## Entry format

Newest entries go **on top**:

```
## YYYY-MM-DD — short title
**Kind:** founder decision | change of mind | deviation from plan | not done
**What:** one or two sentences.
**Why:** the reason, not a restatement of the decision.
**What it changes going forward:** what is now off-limits or required.
**Recorded in:** file/section, if the decision already landed in code or docs.
```

---

## 2026-08-17 — the handset is measured off a real iPhone, and Type Radar drops a face to gain a beat

**Kind:** founder decision + change of mind
**What:** two corrections to `GennetyHero` after the founder watched the second
cut. The drawn handset was rebuilt to real iPhone 16 Pro proportions, and the
Type Radar shot moved to a different stretch of the same recording. 45.2 s
(was 45.4).

**Why the handset was wrong, and it is not a matter of taste.** The founder's
words were that I had overlaid "a mockup of some unknown phone" when they had
asked for an iPhone. Correct, and the cause is that I proportioned the first
version by eye. Every dimension is now a fraction of screen width taken off a
402 pt device:

- **Screen corner radius 62/402 ≈ 0.145**, against the 0.098 I had used. This is
  the single biggest tell — 0.098 is a rounded rectangle, not a squircle, and no
  amount of bezel work compensates for it.
- **Dynamic Island 0.315 × 0.092 at 0.028 from the top.** I had derived its
  height from the status bar instead, which made it a flat slot.
- **A 0.017 black display border inside a 0.008 titanium rail**, as two layers.
  From the front that rail is a bright hairline; the single grey gradient band I
  had drawn reads as plastic.

**The status bar's backdrop is now the clip's own top rows, mirrored and
blurred**, and that is a fix for something the founder did not report. A flat
black strip is right on the Mini App screens and wrong on the Telegram ones,
whose translucent header runs under the status bar on a real phone — against
black it left a hard horizontal seam. It also turned out to be **the only way to
make the Dynamic Island visible at all**: a black pill on a black strip is
invisible, and an iPhone with no island is not an iPhone. On the genuinely dark
screens it stays invisible, which is what a real handset does there.

**Why the Type Radar window moved to the END of its clip, and it took two
passes.** The founder first said a profile looked bad; I read that as the mirror
selfie with the phone held across the face and moved the window to 10.0–16.8 s.
They then sent a screenshot naming the actual profile — a different man, the one
sitting at 75.5–76.5 s of the source, i.e. the FIRST face in the window I had
just chosen. **The lesson is the cheap one: when a founder objects to "one of
these", ask which before re-cutting around a guess.** One screenshot settled in
seconds what an hour of frame-reading got wrong.

The window is now source 81.1–87.5 — the radar's last stretch, four distinct men
with neither vetoed profile, closing on the **«Що зачепило?»** tags. That
closing beat is better than what it replaced and was found only because the veto
forced the search past where I had stopped looking: the earlier windows ended on
«Що не сподобалось?», so the film showed the AI being told what someone did NOT
like, while this one shows it being told what worked. The clip is re-extracted
(80.9–88.2 instead of 65.5–83.0); the other 14 reproduce byte-identically.

**Why the shot is worth this much argument at all:** it is the one place the
film claims the product has taste. A frame nobody would swipe right on is not a
neutral filler frame there — it argues against the claim being made over it.

**What it changes going forward:**
- **A handset dimension is checked against the device, not against how it looks
  alone on a black page.** That is how the first version passed my own review.
- **The Type Radar window is chosen face by face.** Every rejected stretch and
  its reason now lives in `extract-hero-footage.sh` and in the shot's `beat`,
  because the failure mode is that a longer window looks strictly better until
  someone watches it.
- The cascade is −12 frames from `radar-done` onward; the three dissolves are
  unchanged at 14 frames, and `place-map` keeps its 1.5–3.3 s window.

**Recorded in:** `apps/video/src/hero/ui/Iphone.tsx` (the measurements and why
each one matters), `timeline.ts` (the radar shot's `beat`),
`video-production-plan.md` §E/§F, `README.md`.

---

## 2026-08-17 — демо-партнёр предлагает вечер, а не 13:00 каждый раз

**Kind:** founder decision
**What:** `pickCounterSlots` (`apps/bot/src/demo/decide.ts`) выбирает встречное
время в вечернем окне (17:00–19:30 Киев) вместо первого свободного слота дня.
Целевой час чередуется по слотам: 18:00 / 19:00 / 17:00.
**Why:** фаундер заметил, что кукла в демо «постоянно предлагает 13:00». Так и
было, и это не совпадение: сетка приходит по дням и по возрастанию времени
(`generateProposalSlots`, 13:00→19:30), а функция брала **первый** свободный
слот каждого дня — то есть ровно 13:00, на каждом демо, всегда. Шаг существует
ровно для того, чтобы переговоры читались как человек со своим календарём, а
человек с работой не зовёт на первое свидание в середину рабочего дня.
**What it changes going forward:**
- **Чередование часов детерминированное (индекс, не `Math.random()`)** — то же
  правило, что уже записано для `preference-layout.ts` и осыпания иконок:
  паттерн, перекатываемый на каждый рендер, нельзя отревьюить дважды и нельзя
  закрепить тестом. `DEMO_COUNTER_TARGET_HOURS` заодно и есть то, что
  ограничивает встречное предложение тремя слотами.
- **Второй проход перестал складывать три встречных слота в один день.**
  Докстрока функции обещала «разные дни», а ветка «визитёр отметил что-то в
  каждом дне» это обещание нарушала. Теперь один слот на день в обеих ветках.
- **`decide.ts` получил первый импорт из `services/`** (`zonedParts`). Он чист
  (`Intl`, без БД и сети), и это осознанная граница: тянуть
  `handlers/matching/scheduler.ts` ради `CALENDAR_TIME_ZONE` нельзя — он
  притащит Prisma и сломает свойство «таблица решений тестируется без базы».
  Поэтому таймзона берётся из `DEFAULT_TIME_ZONE` в `@gennety/shared`, который
  зеркалит `CALENDAR_TIME_ZONE`; если продукт когда-нибудь начнёт назначать
  свидания вне Киева, эти две константы разъедутся и правило про вечер начнёт
  считаться не в том часовом поясе.
- Демо-only: `apps/bot/src/demo/**`, прод не затронут ни в одну сторону.
**Recorded in:** DEMO_MODE.md → таблица состояний драйвера + «the counter lands
in the EVENING», `apps/bot/src/demo/decide.ts`.

---

## 2026-08-16 — the film plays inside a drawn iPhone, and the phone stops moving

**Kind:** founder decision
**What:** four changes to `GennetyHero` after the founder watched the first cut —
the footage now plays inside a drawn iPhone, the handset is static and centred at
one size throughout, the crop is far lighter, and two content gaps are closed.
Result is 45.4 s (was 44.0 s).

**Why each, because three of the four reverse a call I made:**

- **The phone was sliding around, and it cost legibility.** I had offset it left
  and right and varied its width 566–886 px between beats, on the reasoning that
  fifteen shots of the same object needs compositional variety. The founder's
  read is the correct one: the eye re-finds the screen on every cut instead of
  reading what is on it. It is now centred, unrotated and 604 px in every shot,
  and `Shot` has **no `x` or `rotate` field** so it stays that way. Interest
  comes from the camera push and from what the product is doing.
- **The crop was far too aggressive.** Two profiles cut away the Mini App nav
  row, Telegram's header, the pinned bar and "Translate to English" — which made
  each shot read as a cropped screenshot. There is now **one** profile,
  `576×1196 @ y=84`: the whole phone screen minus the iOS status bar, and the
  status bar goes only because it carries the red screen-recording pill. A clean
  one is drawn back on. Everything a real user sees stays.
- **A screen recording in a bare rectangle reads as a screenshot.** Inside a
  handset it reads as somebody using the product, which is the claim the film is
  making. `ui/Iphone.tsx` draws it — titanium body, bezel, Dynamic Island, side
  buttons, a synthetic status bar — rather than compositing a stock mockup: no
  mockup asset exists here, a drawn one stays sharp at any size, and it uses the
  design system's own palette. **This does not breach the no-redrawing rule**:
  the status bar is OS chrome, not Gennety UI, and the aperture is sized from
  the clip's real geometry so footage is never stretched.
- **Two content gaps.** Type Radar showed two faces, which reads as a screenshot
  of a feature; it now runs 6.5 s from that clip's *fast* stretch (7.0–13.5 s)
  and five faces pass — the opening of the clip sits on one man for 3.5 s, which
  is why the first attempt looked thin. And the departure-point map, which I had
  cut as "a second pick-a-place beat", is restored: without it the venue simply
  appears, and the point is that the concierge picks somewhere both people can
  actually reach.

**What it changes going forward:**
- **The upscale problem is gone.** At 604 px the 576-wide source is shown at
  **1.05×** — effectively native. That is the real payoff of the handset: an
  earlier shot at 878 px was running 1.54×.
- **In a dissolve, only the incoming shot fades.** Sequences layer in array
  order, so an incoming fade over a fully-opaque outgoing is clean, while fading
  both at once dips the picture to ~60% mid-transition — measured, then fixed.
  All three dissolves are 14 frames.
- **`place-map` is trimmed to 1.5–3.3 s of its clip**, which is the only window
  carrying the pin, the "Точка на карті" label and the confirm button at once.
  Before that the Mini App is still loading; after it a browser geolocation
  prompt covers the screen.

**Recorded in:** `apps/video/src/hero/timeline.ts` (the no-horizontal-movement
rule is stated at the top), `ui/Iphone.tsx`, `video-production-plan.md` §C/§E/§F,
`README.md`.

---

## 2026-08-16 — `GennetyHero`: the product film, cut from the three supplied recordings

**Kind:** founder decision + change of mind (a correction to my own earlier entry)
**What:** a second Remotion composition (`apps/video/src/hero/`, **44.0 s**,
1080×1920) cut entirely from the three screen recordings the founder supplied —
`IMG_2588` (profile basics), `IMG_2590` (conversational profiling → Type Radar),
`IMG_2604` (match decision → calendar → venue → date card). `GennetyAd` is
untouched. Audit and recording map: `apps/video/video-production-plan.md`.

**Correcting the record first, because the earlier version of this entry was
built on the wrong material.** The brief said recordings had been supplied. A
filesystem sweep found nothing newer than July, and instead of asking, I guessed
which older files were meant and built a film from `IMG_1798` / `Gennety Ads.mp4`
/ `Gennety Ad video.mp4` — plus an unrelated competitor clip I decided was "the
reference". Commit `4d21ebf` described that as "real product captures". It was
not what was asked for. **The rule this leaves behind: when the premise of a
brief cannot be found, that is a blocking question, not a gap to fill by
inference.** I had even written "no recordings have been supplied" in my own
analysis and then proceeded anyway.

**What the real footage changed about the film.** The old cut was built around
the Mini App's visual intro (statistics, competitor cards, "So we built
Gennety"). **None of that is in these recordings.** What they carry instead is
the half the previous audit had recorded as *never captured*: the match
decision, the calendar landing on a shared slot, the venue, and the date card.
So the film inverted — it no longer argues the problem, it demonstrates the
product understanding someone and getting them to a real date, and it closes on
the product's own line, *Error 404: Chat not found. Try real life.* It is in
**Ukrainian**, matching the capture.

**What it changes going forward:**
- **No product UI is redrawn** and the camera never repaints a product pixel —
  it is a CSS transform on a wrapper. Fifteen shots, all footage; the only drawn
  element is the end card.
- **One scene component, not fifteen.** Every beat is the same object (a
  captured screen, framed), differing only in composition, camera and timing —
  all data in `timeline.ts`. Fifteen near-identical files would hide the cut;
  one readable page expresses it. To retime or reframe anything, edit `SHOTS`.
- **Two crop profiles are load-bearing, not styling.** The recordings carry an
  iOS status bar with a **red recording dot**, Telegram's chat header, a pinned
  bar and a "Translate to English" strip. `mini` (576×1100 @ y=160) and `chat`
  (576×860 @ y=320) remove them, and that crop is the entire reason
  `ui/Screen.tsx` exists. `trim` values are measured against those exact
  in-points.
- **Panel width per shot is the resolution decision.** Sources are 576 px wide
  against a 1080 delivery, so width sets the upscale: 1.03× on the quietest beat
  to 1.54× on the Type Radar hero. Nothing is full-bleed, which would be 1.88×.
- **`scripts/extract-hero-footage.sh` reproduces all 15 clips byte-identically**
  and is the only place the source windows live.

**Deliberately not done:**
- **No music.** Nothing licensed exists here and the recordings carry only
  incidental phone audio, so the film renders silent with the path wired
  (`musicVolume` defaults to 0) — the workspace's own stated convention. The one
  genuinely open deliverable.
- **No "problem" act and no real-world ending.** Neither the visual intro nor
  lifestyle footage is in these recordings, and neither was substituted from
  elsewhere — that substitution is exactly the mistake above. Both are named as
  open items in the plan §H, because a capture of the intro and any real footage
  of two people meeting would each add a genuine act.
- **The richest single frame is unused.** `IMG_2604` 0:00–0:02 shows the
  verification line, the question, the "Да" and the green button at once — but it
  holds for only ~2 s before the calendar slides over it, and this is the film's
  emotional turn. The cut takes the steady 7-second stretch at 0:13 instead:
  length beat framing.

**Recorded in:** `apps/video/video-production-plan.md`, `apps/video/README.md`
(§`GennetyHero`), `apps/video/src/hero/timeline.ts`.

---

## 2026-08-15 — промпт Hermes слит в один файл; в нём нашлось десять протухших утверждений

**Kind:** a document turned out to be wrong + change of mind
**What:** `HERMES_AGENT_PROMPT.md` переписан целиком: в него влит
`HERMES_MATCH_CONVERSION_ADDENDUM.md` (тот стал указателем — на него ссылается
запись ниже в этом же журнале), добавлены восемь эндпоинтов, о которых агент не
знал, и исправлены десять утверждений, разошедшихся с продом.
**Why:** запрос был «продублируй промт и расскажи про все эндпоинты». Сверка с
кодом и живым API показала, что дублировать нечего — половина файла описывала
продукт, которого больше нет:

- **каденс матчинга `weekly`** — прод на `daily` с 2026-08-10, и на четверговом
  батче было построено всё обоснование дня отчёта;
- **«верификация выключена, низкий pass rate игнорируй»** —
  `MANDATORY_VERIFICATION_ENABLED=true` с 2026-07-17, то есть агента прямо
  инструктировали не замечать настоящую проблему;
- **Persona** как провайдер liveness (заменён на AWS 2026-07-26);
- **шаг `ethnicity`** описан как живой и «нормально скипаемый» — удалён
  2026-08-01 вместе с колонкой;
- **`MIN_PHOTOS = 4`** (тройка с 2026-07-27);
- **`sources.timeline: false`, «ты не видишь исходящие»** — таблица раскатана
  2026-07-29, замер даёт `true`;
- не отражено, что **первые пять шагов собираются в Mini App** (2026-08-05), то
  есть их `dwellMs` — время на экране, а не раздумья над вопросом бота;
- не отражено, что **`ai_memory`/`context_dump` пропускаются у всех**
  (`AI_MEMORY_EXPORT_ENABLED=false`), то есть массовый `skipped` там —
  конфигурация, а не утечка воронки.

**Восемь недостающих эндпоинтов**, включая два, которые прямо отвечают на
вопросы из «рамки интерпретации»: `/admin/analytics/algorithm` (почему низкий
acceptance — компоненты скора, слова отказов, калибровка synergy) и
`/admin/reports/stats` (`unreviewedTier3` — репорты об угрозе безопасности,
ждущие человека). Плюс `venue-concentration`, `/admin/users` + `/:id`,
`/admin/media`, `audience/heatmap`.
**What it changes going forward:**
- **Промпт внешнего агента — это документ, который протухает молча.** Ни один
  тест и ни один деплой его не проверяет, а ошибка в нём выглядит как ошибка
  агента. Сверять при каждом изменении флага или шага онбординга; таблица
  «СОСТОЯНИЕ ПРОДА» в нём для этого и заведена, и она помечена как снимок.
- **Раздел «Ты только читаешь» — новый и несущий.** На admin-API есть два POST
  (`rerun-verification`, `reports/:id/review`), и прежний промпт о них молчал,
  хотя выдавал агенту ключ ко всему API.
- **Слияние отменяет прежний довод «два описания одного эндпоинта
  разъезжаются».** Он верен, но решается одним файлом лучше, чем двумя: между
  собой файлы как раз не разъехались — разъехался канонический с продуктом.
**Recorded in:** `HERMES_AGENT_PROMPT.md`, `HERMES_MATCH_CONVERSION_ADDENDUM.md`
(указатель).

---

## 2026-08-15 — финал демо ограничен часами, а не памятью процесса; остаточная дыра оставлена намеренно

**Kind:** deviation from plan + not done
**What:** закрывающее сообщение демо («Ось і весь продукт…») теперь предлагается
только если матч стал терминальным недавно (`DEMO_ENDING_OFFER_MAX_AGE_MS`, 10
мин), в дополнение к существующей защите `redoOffered`. Рассматривался и
отклонён durable-вариант через `chat_events`.
**Why:** `redoOffered` — обычный `Map` в памяти (демо-схема запрещена), а матч в
статусе `completed` остаётся таким **навсегда**, поэтому окно не закрывалось
ничем: сообщение уходило заново через ~12 с после каждого рестарта, бесконечно.
Замерено в `chat_events` самого демо, а не выведено: настоящий финал через 17 с
после завершения матча и второй, идентичный, через 27 с после рестарта четырьмя
часами позже — тот же визитёр, тот же матч, 24 рестарта всего.
**Почему временна́я граница, а не запрос в `chat_events`:** durable-проверка
точна, но привязывает демо к формату `summary` рекордера таймлайна (усечённый
текст сообщения), добавляет запрос на тик и всё равно «протухает» через 30 дней
на ретеншен-свипе — то есть тот же класс бага, только медленнее. Время — честный
ответ и ровно то, чем уже ограничен beat `intro`.
**What it changes going forward:**
- **Остаточная дыра оставлена сознательно:** рестарт ВНУТРИ окна, уже после
  отправки, всё ещё повторит сообщение. Это узкий случай, и цена его нулевая —
  кнопка на исходном сообщении переживает любые рестарты (её хендлер читает
  только БД), так что неполученное повторное предложение не отнимает у визитёра
  ничего. Не «чинить» это схемой.
- **Правило, которое стоит держать в голове при следующей карте в памяти:**
  спросить, что закрывает окно, когда карта потеряна. У всех остальных beat'ов
  это делает продвижение визитёра по флоу; у терминального матча — ничто.
- 10 минут против ~15 с нормального случая — намеренный запас: слишком узкое
  окно даёт худший отказ (демо заканчивается молча), чем слишком широкое.
**Recorded in:** DEMO_MODE.md → «What is held in memory» + «Recovery»,
`apps/bot/src/demo/decide.ts` (`DEMO_ENDING_OFFER_MAX_AGE_MS`, `offerableEnding`).

---

## 2026-08-15 — пустой ответ Places — это факт об ОТВЕТЕ, а не о площадке

**Kind:** a document turned out to be wrong
**What:** `lookupAndCachePhotos` кэшировал пустой массив ссылок на **сутки**,
наравне с настоящим ответом. Теперь сутки заслуживает только НЕпустой ответ;
пустой держится те же пять минут, что и сбой, и пишет строку в лог.
**Why:** пришло как «в демо опять нет фотографий на карточках смены места —
старый фикс не сработал». Фикс от 2026-08-08 работает и не при чём: он
укрепляет **доставку байтов**, а отказ на шаг раньше — в **резолве ссылок** — до
прокси вообще не доходит. Карточка без ссылок рисует глиф категории и не делает
запроса, поэтому ретраить нечего и в логе пусто. Причина в контракте
`fetchPlacePhotoNames`, чей комментарий прямо утверждал: пустой массив — это
Google, ответивший авторитетно, и «стоит помнить сутки». Неверно: «фотографий
нет» выражается **отсутствием поля `photos`**, и ровно так же выглядит неполный
200. Один такой ответ гасил площадку на сутки — молча.
**Замерено, а не выведено:** живой демо-процесс отдавал одной киевской площадке
0 ссылок, свежий процесс в ту же минуту — 6, Google на 20 запросов подряд
отвечал с фотографиями, а рестарт вернул доску к 12/12. Ноль строк
`[venue] photo lookup … failed` за всю историю демо — то есть запрос не падал,
он возвращал пустоту.
**What it changes going forward:**
- **Пустой набор фотографий нельзя трактовать как свойство площадки.** Это
  свойство одного ответа. Правило записано и в `venue.ts` (в контракте
  функции), и в `venue-change.ts` (на месте кэша), потому что ошибка родилась
  именно из расхождения между ними.
- **Молчаливых веток на этом пути больше нет.** Пустой резолв логируется по той
  же причине, по которой 2026-08-08 перестал молчать прокси: системная пустота
  (смена field mask, квота, протухший `placeId`) иначе неотличима от «у этого
  места просто нет фотографий».
- **Цена короткого окна названа**: один запрос Place Details на действительно
  безфотографийную площадку раз в пять минут, и только пока доска открыта —
  каталог тянется на открытии, а не на 4-секундном опросе состояния.
- **Чего доказать не удалось:** что именно этим объясняется «фотографий не было
  вовсе». В процессе, обслуживавшем разобранный прогон, отравлена была ровно
  одна карточка из двенадцати. Более ранние прогоны шли в процессе, который уже
  заменён, и его кэш не восстановить. Механизм доказан; масштаб — нет.
**Recorded in:** PRODUCT_SPEC.md §3.7a, `services/venue-change.ts`
(`lookupAndCachePhotos`), `services/venue.ts` (`fetchPlacePhotoNames`).

---

## 2026-08-15 — фаундер сказал «да» по обоим пунктам; и мой первый отчёт о флагах был неполон

**Kind:** founder decision + a document turned out to be wrong
**What:** оба открытых вопроса из записи ниже закрыты утвердительно.
(1) `VENUE_SEASON_WEATHER_ENABLED=true` в проде **и** в dev. (2) Пять мёртвых
слотов `CUSTOM_EMOJI_AI_*` удалены из `config.ts` (`75b2b46`), а прод-`.env`
лишился `CUSTOM_EMOJI_AI_SPARKLE_ID`.
**Why weather включён при нулевом наблюдаемом эффекте:** в проде
`venue_selection_logs` = 0 запусков за всё время, так что сегодня множитель не
двигает ничего. Включено заранее осознанно — риска нет (fail-open, клэмп
[0.8, 1.1], провайдер без ключа), а первая настоящая пара тогда сразу получит
корректный ранкинг вместо «включим потом». Dev флипнут тем же днём, потому что
`.env.local` держит эту переменную в паритете с продом **намеренно** — иначе
dev-ранкер выбирает не ту площадку, что прод.

**Отдельно — ошибка в моём первом отчёте этой сессии, которую стоит
зафиксировать, потому что она меняла картину прода.** Я сообщил, что
`SYNTHETIC_FILL_ENABLED`, `DROP_CADENCE` и `VENUE_CONCENTRATION_ALERT_ENABLED`
«отсутствуют с обеих сторон, что соответствует задокументированному weekly-
каденсу». Верно только про третью. Прод **и** dev держат `DROP_CADENCE=daily`
и `SYNTHETIC_FILL_ENABLED=true` — то есть дропы идут каждый вечер и
синтетические партнёры включены. Вывод самой первой команды пришёл
**обрезанным** ровно на эти две строки; повтор той же команды позже вернул 21
строку вместо 19. Подтверждено независимо стартовым логом прода:
`Drop matching scheduled: "0 18 * * *"` и `Synthetic test partner scheduled:
"* * * * *"`.
**What it changes going forward:** **не доверять одиночному выводу grep по
`.env` как полному списку** — сверять число строк или перечитывать. Это тот же
класс ошибки, что deploy.md уже ловил на «production has 2 matches ever»:
цифра, единожды прочитанная и потом повторяемая. Кстати о ней — в проде на
2026-08-15 **14 матчей** (3 proposed / 3 cancelled / 1 completed / 7 expired) и
54 аккаунта, а не 2 матча, как всё ещё написано в нескольких блоках deploy.md.
**Recorded in:** deploy.md (блок «Applied 2026-08-15»), `.env.local`,
`/opt/gennety/.env` (бэкап `.env.bak.20260815-053709`).

---

## 2026-08-14 — `RICH_THINKING_ENABLED` удалён; два соседних факта записаны, а не «починены»

**Kind:** change of mind + not done
**What:** `RICH_THINKING_ENABLED` вычищен из `.env.example` (переменная + её
комментарий) и из `.env.local`. Кода он не касался вообще — `config.ts` его
никогда не объявлял, ни один модуль не читал. Заодно исправлен комментарий у
`CUSTOM_EMOJI_THINKING_ID`, который врал: «Only used when
RICH_THINKING_ENABLED=true».
**Why:** это не «мёртвая настройка» в обычном смысле — она была **ловушкой**.
`.env.example` — шаблон, из которого собирают новое окружение, и он предлагал
флаг, который ничего не выключает. Кто-то выставил его в `.env.local` в `true`
и жил с уверенностью, что rich-шиммер включён именно им. Правило в deploy.md
(«не заводить глобальный тумблер: клиент читает rich-draft как сгенерированный
AI-ответ, и этот размен выбирается по месту, а не глобально») существовало, а
файл, который люди реально копируют, говорил обратное.
**What it changes going forward:**
- **deploy.md-строка «do not reintroduce» остаётся** — она и есть то, что не
  даёт завести флаг заново; удалять её нельзя.
- Комментарий в `.env.example` теперь несёт ту же причину, что и deploy.md, —
  чтобы следующий человек узнал её из файла, который держит в руках.
- Проверено, что дизайн-решение не тронуто: 23 вызова `rich: true` в 16
  файлах на месте, typecheck чист по 5 проектам, полный прогон 3648 тестов
  зелёный, конфиг грузится, `CUSTOM_EMOJI_THINKING_ID` жив (его читает
  `ai-stream.ts` как последний fallback глифа).
**Deliberately not done — пять слотов `CUSTOM_EMOJI_AI_*`.** *(Перекрыто на
следующий день: фаундер сказал «да», слоты удалены — см. запись 2026-08-15
наверху. Оставлено как запись о том, почему я не стал вычищать их молча.)*
Они объявлены в
`config.ts:143-147` и **не читаются нигде**: значения переехали в запечённый
`AI_EMOJI` (`services/ai-emoji.ts`), а env-слоты остались. В проде выставлен
`CUSTOM_EMOJI_AI_SPARKLE_ID=5573473356579078196` — ровно тот же id, что
`AI_EMOJI.spark`, то есть настройка задана и не делает ничего. Не удалено
намеренно: это правка `config.ts`, которую не просили, и фаундер может думать,
что она работает — сказать об этом важнее, чем молча вычистить.
**Recorded in:** `.env.example`, `.env.local` (gitignored).

---

## 2026-08-14 — `VENUE_SEASON_WEATHER_ENABLED`: не сломан, просто никогда не включался

**Kind:** a document turned out to be wrong
**What:** разбор «почему не работает». Фича исправна и проверена вживую;
причина выключенности — её **не было в `.env.example`**, поэтому при сборке
прод-окружения из шаблона переменная туда не попала. Три переменные
(`VENUE_SEASON_WEATHER_ENABLED`, `VENUE_WEATHER_TIMEOUT_MS`,
`VENUE_WEATHER_CACHE_TTL_MS`) добавлены в шаблон.
**Why:** дефолт — `false` (`config.ts`: `=== "true"`), а deploy.md описывает
переменные подробно. Но `.env.example` — единственный файл, который реально
копируют, и в нём их не было ни строкой. Это тот же класс дефекта, что запись
выше, только зеркальный: там шаблон предлагал несуществующий флаг, здесь —
умалчивал о существующем.
**Что измерено, а не выведено:**
- Open-Meteo с дроплета: **HTTP 200 за 0.08s**, ключ не нужен.
- `smoke-venue-engine.ts` с флагом: живой прогноз Киева (14.2 °C, 0 % осадков)
  → множитель **1.1** для outdoor-scenic; зима 0.9 / лето 1.05 / indoor 1.0.
- `venueContextMultiplier` читается **только** в `venue-intent-v2.ts`, то есть
  влияет на автоназначение и не трогает платную доску смены места (§3.7b) —
  как и задумано.
**Главное следствие, которое меняет срочность:** в проде
`venue_selection_logs` = **0 запусков за всё время**, а единственный матч со
статусом `completed` — засеянная синтетика (оба `telegramId` в бэнде
`-778000xxx`, `dispatchedAt: null`, `agreedTime` раньше `createdAt`, площадка
проставлена в строку руками). То есть **V2-селектор в проде не исполнялся ни
разу**, и включение флага сегодня не изменит ничего наблюдаемого. Это довод
включать осознанно, а не «на всякий случай».
**Заодно исправлено в этом журнале фактическое расхождение:** deploy.md в
нескольких блоках повторяет «production has 2 matches ever». На 2026-08-14 в
проде **14 матчей** (3 proposed / 3 cancelled / 1 completed / 7 expired) и 54
аккаунта. Цифру снова переписали вперёд, ровно как предупреждает запись от
2026-08-07.
**Recorded in:** `.env.example` (венью-блок).

---

## 2026-08-15 — метрика Match→Ticket: выводим из колонок, а не пишем события

**Kind:** founder decision + deviation from plan
**What:** ТЗ (1.1) просило добавить шесть событий (`MATCH_CONFIRMED`,
`TICKET_PURCHASED`, `DATE_COMPLETED`, `NO_SHOW`, `GHOST_DURING_SCHEDULING`,
`REFUNDED`) в модель матча или в таблицу событий. Не добавлено ни одного:
четыре выводятся из колонок, которые продукт уже пишет, пятое (`DATE_COMPLETED`)
двусмысленно, шестое (`NO_SHOW`) закрыто отдельной фичей выше.
**Why — три причины, и первая решающая:**
1. **Выведенная метрика работает на всей истории сразу.** Записанные события
   начались бы с нуля в день деплоя; при текущем темпе (3 реальных матча за всю
   историю) дашборд был бы пустым квартал.
2. **У денег уже есть единственный источник правды.** ARCHITECTURE → Purchase
   ownership прямо отказывается от параллельной таблицы платежей ровно потому,
   что возвратные рельсы читают и меняют оригиналы. `TICKET_PURCHASED` как
   событие — это она и есть.
3. **`MatchEventActionType` уже содержит `DATE_COMPLETED`, и его никто не
   пишет** (0 строк, как и `PROPOSAL_SHOWN`). Добавить туда ещё четыре значения
   — повторить ту же историю миграцией на живом проде.
**What it changes going forward — четыре правила, которые легко нарушить:**
- **Тестовые аккаунты определяются вердиктом `user-health.ts`, а не
  `telegramId < 0`.** Отрицательный id — признак МОБИЛЬНОЙ рельсы; такой фильтр
  выкинет каждого реального iOS-пользователя в день выхода приложения. Это была
  прямая инструкция в ТЗ, и она неверна.
- **Синтетические матчи вне знаменателя.** Партнёр-заглушка по построению всегда
  отказывает (§3.1c) и купить билет не может. Сегодня это 13 из 14 матчей: без
  фильтра конверсия — вечный 0% по конструкции, а не по факту. Дискриминатор уже
  есть — `Match.source`.
- **Вычеты — объединение, а не сумма.** Буквальная формула ТЗ
  `куплено − (no_show + ghosting + возвраты)` считает один испорченный матч
  дважды-трижды (no-show и гостинг как раз и порождают возврат) и может увести
  числитель в минус. И вычитать можно только из того, что было в числителе:
  матч без оплаченных билетов — не «минус продажа», а просто не продажа.
- **`null`, а не 0, на пустом знаменателе.** Везде: конверсия, качество
  планирования, CAC/LTV/ROAS. «Нет данных» и «измеренный ноль» — разные
  утверждения.
**Две поправки к вводным, на которых стояло ТЗ:**
- **`/admin/purchases` и `/admin/analytics/monetization` существуют** — в ТЗ
  сказано, что платёжных эндпоинтов нет. Инвентарь был неполный, и часть
  задания построена на этом.
- **`weeklyPaidDates` из `purchaseSummary.count > 0` не считается**: он
  пожизненный, а «за 7 дней» из него не достаётся. И плательщик ≠ оплаченное
  свидание: мужчина, оплативший за двоих, — одно свидание.
**Deliberately not done:**
- **«Install→Match Rate» не реализован под этим именем.** Установок продукт не
  трекает вовсе; метрика называется `registeredToMatchRate7dPct`, потому что
  измеряет регистрации. Имя одной метрики над числом другой хуже отсутствия
  метрики.
- **CAC/LTV/ROAS отдаются как `null`** до появления данных о расходах
  (`AD_SPEND_TRACKING_DESIGN.md`, реализация не начата).
**Recorded in:** `admin/utils/match-conversion.ts` (шапка держит рассуждение),
ARCHITECTURE.md → Admin API, HERMES_MATCH_CONVERSION_ADDENDUM.md.

---

## 2026-08-15 — «вы встретились?»: вопрос задаётся всегда, улики меняют формулировку

**Kind:** founder decision + change of mind
**What:** перед формой обратной связи на T+24h появился обычный вопрос от
агента — встретились ли. Ответ «да» ведёт в существующую форму, «нет» — в
короткий разговор о том, что произошло. Явка пишется в две новые колонки
(`dateAttendedA/B` + `attendanceOutcomeA/B`).
**Why — и главное здесь не фича, а развилка, которую я поставил неправильно.**
Я предложил три варианта: спросить явку в форме, оставить «нет данных», или
ручной флаг в админке. Фаундер отверг все три и описал четвёртый: обычное
сообщение от агента, но не задавать вопрос, если по контексту и так понятно, —
иначе агент выглядит как будто у него нет памяти.

Разбирая это, я пришёл к переформулировке, которая снимает саму развилку:
**вопрос задаётся ВСЕГДА, улики меняют формулировку, а не факт вопроса.**
Претензия «нет памяти» на самом деле не про то, что спросили, — она про то, что
спросили КАК БУДТО НИЧЕГО НЕ ЗНАЕМ. «Вчера ты написал, что она не пришла — всё
так?» и спрашивает, и помнит. Фаундер сам был в шаге от этого («лучше спросить
напрямую, но всё равно подгружать в память»); я это только назвал.

Цена ошибки несимметрична, и это решающий аргумент: спросить у того, кто уже
рассказал, — неприятно и поправимо; решить за того, кто молчал, — записать
выдуманный факт в метрику, ради которой всё делается, и написать «как прошло
свидание?» человеку, которого продинамили.
**What it changes going forward:**
- **Классификатор улик НИКОГДА не пишет `dateAttended*`.** Он выбирает одну из
  трёх формулировок. Ошибся — странное предложение, а не фальшивая метрика.
  Строгость выражена структурно (всё, кроме `high`-уверенного однозначного
  вердикта, схлопывается в нейтральный тон), а не просьбой в промпте: промпт
  может ошибиться, конструкция — нет. Тест подтверждён красным.
- **Модель не вызывается, если улик нет вовсе** — а это подавляющее
  большинство пар. Не оптимизация: это то, что делает фичу бесплатной по
  токенам и не даёт ей стать «ещё один LLM-вызов на каждое свидание».
- **Прокси-чат читается классификатором, но не попадает в промпт агента.**
  Продукт намеренно держит чужой текст вне таймлайна (`withRedactedSummary`),
  потому что рядом лежат инструменты, пишущие в профиль читателя. Процитировать
  «ты писал, что стоишь у входа» — это утечка одного пользователя другому, а не
  улучшение формулировки. Граница не обсуждается.
- **Ветка «нет» не ведёт в форму.** Химия 1–10 и второе свидание — вопросы ПРО
  свидание; человеку, которого не дождались, они бессмысленны. Четыре исхода
  различают «свидание не состоялось» и «кого-то оставили ждать» — разные факты и
  для метрики, и для возврата.
- **Закрывающее сообщение ничего не обещает.** Возврата билета и приоритетного
  буста на этом пути сегодня нет; поверхность не имеет права их выдумывать (то
  же правило, что у карточки истечения в §3.4). Держится тестом.
- **Явка — свойство ПАРЫ.** Одно достоверное «да» закрывает матч. Две колонки —
  не для того, чтобы считать явку по-разному, а потому что стороны могут
  разойтись, и это реальное `disputed`, а не ошибка. `unknown` никогда не
  рендерится как «не встретились».
**Схема здесь нужна, в отличие от дашборда** (запись выше): там данные уже
существуют и метрика выводится, здесь их нет нигде — `feedbackBy*` это
свободный текст, а `status='completed'` ставится по таймеру.
**Deliberately not done:**
- **Билет при no-show не возвращается** (решение фаундера: пока только
  фиксировать). §3.5b возвращает билет, когда матч умирает ДО свидания; no-show
  — это `scheduled`, чьё время прошло без отмены, так что сегодня билет сгорает
  у того, **кто пришёл**. Фича впервые делает такие случаи видимыми; решать про
  деньги на нулевых продажах рано.
- **Мобильная рельса не спрашивает явку.** Push продолжает слать прежнее
  приглашение в форму, так что регрессии нет, но нативный вопрос — отдельная
  задача с добавлением в `/v1/*`.
**Recorded in:** PRODUCT_SPEC.md §Phase 4 → «Did you actually meet?»,
ARCHITECTURE.md → `matches`, `services/attendance.ts` (шапка держит рассуждение).

---

## 2026-08-14 — зачёркивание иконок на экране метрик построено и отклонено

**Kind:** founder decision + not done
**What:** анимация «каждая метрика убивает своё приложение» (тряска с
нарастанием → покраснение → крест двумя штрихами) была реализована,
покадрово проверена и **откачена целиком** (`fb84c66` → revert). Фаундер
посмотрел на живом экране и решил оставить трей как был — инертным.
**Why:** решение по внешнему виду, а не по механике: всё работало и было
измерено. Записано именно потому, что построенное и отвергнутое иначе
выглядит как незамеченная дыра — трей из трёх иконок над барабаном метрик
по-прежнему декорация, и это **осознанное** состояние, а не забытая
возможность.
**What it changes going forward:**
- **Не строить это заново без явной просьбы.** Экран метрик остаётся
  «числа + статичный трей».
- **Два факта из этой попытки стоят того, чтобы их не переоткрывать.**
  Первый: у элемента с анимируемым `filter` Chromium заводит отдельный слой
  композитора, и элемент всплывает над позиционированным псевдоэлементом-
  соседом — то есть любой слой поверх такой иконки требует явного `z-index`.
  Найдено замером: две простаивающие иконки красились правильно, а та, у
  которой шла анимация, — нет. Второй: иконка, залитая сплошным красным, не
  может нести красные линии поверх — их не видно вообще; разводить надо по
  светлоте, а не по оттенку.
- **Осталась одна правка, которая НЕ откачена и не должна быть**: импорт
  `CSSProperties` в `onboarding.tsx`. Его завёл этот коммит, но параллельные
  сессии (падающие деньги, марка успеха) успели на него опереться, так что
  теперь он принадлежит их коду. Механический revert его снимал и ронял
  typecheck.
**Recorded in:** здесь; в коде и спеках следов не осталось (проверено grep'ом
по дереву). В прод не уезжало — задеплоенный бандл Mini App
(`onboarding-D9qKf9ws.css`) относится к сборке до этой работы.

---

## 2026-08-13 — два claim'а на чат, которые не истекали: фото-менеджер и окно ответа

**Kind:** founder decision + change of mind
**What:** закрыты оба дефекта, оставленных «на решение фаундера» 2026-08-12
(запись ниже). У `edit_photos` / `edit_video` появился дедлайн (2 ч,
перевзводится на каждом действии), а окно ответа Profiler'а перестало быть
жёсткой границей: за его пределами текст всё ещё принимается как ответ, если
он не выглядит вопросом к боту.
**Why — и по каждому это разные причины, что и стоит записать:**

- **Фото-менеджер бросили в стороне по неверному критерию.** Аргумент был
  «медиа, а не текст: случайная фотография ложится в галерею, которую видно и
  можно удалить». Про ФОТОГРАФИЮ это верно и сегодня — и это не то, что надо
  было ограничивать. Ограничивать надо было claim на ЧАТ: менеджер потребляет
  любое сообщение без callback data, поэтому обычный текст получал в ответ
  «пришли фото» вместо консьержа, а `menuState` — одно из четырёх полей, по
  которым Profiler решает, свободен ли чат. Состояние живёт в `bot_sessions`,
  так что «навсегда» тут буквально: **человек, один раз открывший «Мои фото» и
  ушедший, получал бота, который больше никогда ему не отвечает.**
- **Истечение делает ровно то же, что тап по другой кнопке меню.** Это не новое
  поведение: §2.1 уже описывает такой тап как закрытие менеджера, и дедлайн —
  это второй способ сказать «человек ушёл». Отсюда требование, которое легко
  сломать: истечение обязано ретайрить карточки, а не просто сбрасывать
  `menuState`, иначе на экране остаются живые на вид 🗑 и ➕/✅, указывающие в
  никуда — тот самый баг с осиротевшими кнопками, который §2.1 уже фиксировал.
- **2 часа, а не 30–60 минут, и перевзвод на каждом действии.** Цена ошибки
  здесь несимметрична текстовым claim'ам: слишком короткое окно у `edit_bio`
  перезаписывает профиль, а тут — закрывает менеджер, к которому не
  прикасались два часа, и открыть его заново это один тап. Верхняя граница
  жёсткая и не вкусовая: **48 ч** — предел, после которого Telegram не даёт
  боту редактировать своё сообщение, то есть карточки уже физически нельзя
  ретайрить. Тест держит константу под ним.
- **Окно ответа: 90 минут против 6 часов — два таймера на одном вопросе, и они
  расходились.** Сообщение с вопросом удаляется на 6-часовом stall-свипе, то
  есть 4.5 часа вопрос ВИДЕН, его Skip работает, а напечатанный ответ уходит
  консьержу; дальше вопрос умирает как implicit skip и ставит остаток батча на
  паузу. Escape-hatch «ответь реплаем» существует ровно для этого случая и им
  никто не пользуется. Новое правило проще предыдущего и его можно удержать в
  голове: **на вопрос можно ответить, пока он виден.**

**What it changes going forward:**
- **Различие «null против прошедшего времени» стало несущим.**
  `answerWindowUntil = null` значит «разговор ушёл дальше» (пользователь что-то
  сделал) и остаётся жёстким запретом; прошедшее, но непустое значение значит
  «просто прошло время, с момента вопроса не случилось ничего». Обнулять окно
  там, где раньше просто давали ему истечь, — значит вернуть баг.
- **Изменение аддитивно, и это проверяемое свойство:** ничего, что
  захватывалось раньше, захватываться не перестало. В частности проверка «это
  вопрос?» применяется ТОЛЬКО за пределами окна — внутри него короткий
  настоящий ответ с «?» на конце («не знаю, может кино?») обязан остаться
  ответом. Тест на это есть.
- **`isLikelyMetaQuestion` — детерминированный предикат, а не LLM-вызов**, по
  той же причине, по которой им сделан `isProfilerRefusal`: он на горячем пути
  маршрутизации текста, и деградация при ошибке должна быть предсказуемой.
- **Медиа-состояния теперь взводятся ТОЛЬКО через `armMediaClaim`.** Прямое
  присваивание `menuState = "edit_photos"` оставляет `menuClaimUntil` пустым, а
  пустой дедлайн читается как истёкший (fail closed) — менеджер закроется на
  первом же сообщении.
**Честно про доказательства:** ни один из двух дефектов не воспроизведён на
данных. По окну ответа замер прода прямой: из 13 отправленных вопросов все 11
отвеченных пришли за 0–53 минуты, поздних нет — то есть в проде это ещё ни разу
не стреляло. Оба фикса сделаны по разбору кода, оба гварда подтверждены красным.
**Recorded in:** PRODUCT_SPEC.md §2.1 + §Phase 1b,
`services/menu-text-claim.ts` (`MEDIA_CLAIM_TTL_MS`),
`services/profiler-schedule.ts` (`shouldCaptureProfilerAnswer`).

---

## 2026-08-13 — марка успеха: бабочка вместо галочки, и галочки нет вообще

**Kind:** founder decision + change of mind
**What:** марка успеха переделана в третий раз. Бабочка прилетает с пружиной и
остаётся; галочки нет ни в каком виде. Собрано три кандидата на общем dev-стенде,
фаундер выбрал **B** — тот, в котором меньше всего движения.
**Why:** две предыдущие версии (бабочка садится на галочку; бабочка чертит и
улетает) были отвергнуты одна за другой, и замер объяснил почему: **в полёте
бабочка рендерилась 29×29 px.** Логотип — абстрактная четырёхлепестковая форма
без тела, головы и усиков, на таком размере это розовое пятно. То есть вчерашний
аргумент «брендовый момент — это ДВИЖЕНИЕ, а не финальный кадр» провалился на
своих же условиях: движущийся объект не был узнаваем, и мы обменяли присутствие
логотипа в кадре, на который смотрят дольше всего, на момент, которого не было.

**Поправка к самому себе, и она была ключом ко всему.** На предыдущем шаге я
сказал, что убрать галочку нельзя, потому что на платеже и верификации
двусмысленность дорого стоит. Проверил — и это неверно: **все пять экранов и так
называют результат словами** (verification передаёт `label` в саму марку; Type
Radar, онбординг, venue-change и календарь рендерят свой заголовок прямо под
ней). Галочка нигде не несла смысл в одиночку, она дублировала соседнее
предложение. Как только это стало фактом, отпало и всё остальное: путь, по
которому надо лететь, рисование и уход из кадра.

**What it changes going forward:**
- **Марка говорит «Gennety», а не «получилось».** Это осознанный размен, а не
  недосмотр: смысл несут слова рядом. Шестая поверхность обязана иметь либо
  `label`, либо собственный заголовок, иначе марка превращается в украшение.
  Записано и в модуле, и в PRODUCT_SPEC.
- **Стенд сравнения удалён, а не спрятан за флаг** — вместе с двумя
  проигравшими вариантами и веткой `?preview=success`. То же правило, что у
  `?v=` на экране предпочтений (2026-08-07): принятое решение перестаёт быть
  конфигурацией, а отвергнутый вариант живёт в истории git.
- **Два самозакрывающихся экрана закрываются на ~0.5 с раньше**
  (`SUCCESS_TOTAL_MS` 1200 → 700). Это следствие более простой анимации.
  `SUCCESS_READ_MS` намеренно не тронут: он отвечает на другой вопрос («сколько
  человеку нужно, чтобы увидеть»), и укорочение анимации на него не влияет. Если
  verification начнёт казаться торопливым — поднимать надо именно его.
- **Порядок объявления двух анимаций на `transform` несущий.** Прилёт и дыхание
  живут на одном свойстве; дыхание объявлено вторым и отложено за длительность
  прилёта, потому что более позднее объявление выигрывает свойство. Поменять
  местами — марка замрёт на первом кейфрейме дыхания вместо того, чтобы
  прилететь.
**Recorded in:** PRODUCT_SPEC.md → Cross-Cutting Concerns («The success mark»),
`apps/webapp/src/butterfly-success.{ts,css}`.

---

## 2026-08-13 — радиус градиента крыла считался от стороны bbox, а не от диагонали

**Kind:** deviation from plan
**What:** `logoWingGradient` в `brand-butterfly.ts`: радиус 88.63 → **77.07**.
Заодно поправлена вручную вставленная копия в `verification.html`.
**Why:** канонический логотип объявляет `r="100%"` без `gradientUnits`, то есть
`objectBoundingBox`, где радиус — доля **нормированной диагонали**
`√(w²+h²)/√2`, а не стороны. Конвертация в user space была сделана по ширине
bbox, из-за чего растяжка шла на 15% шире логотипа: магента расползалась по
крыльям, тёмный внешний стоп почти не показывался, и марка выходила горячее и
площе бренда. `cx`/`cy` при этом верны — 30% и 100% того же бокса дают -17.72 и
32.51 — и это записано в модуле отдельно, чтобы их не «починили» заодно.
**Почему чиню именно сейчас, хотя это не то, о чём просили:** пока бабочка была
29px, разница не имела значения. С переходом на вариант B бабочка стала самой
маркой на 190px, и это крупнейший брендовый объект в продукте.
**What it changes going forward:** правка трогает **и лоадер**, который читает
тот же модуль. Там разница визуально незаметна (проверено скриншотом до и
после), но формально это изменение задеплоенной поверхности. Тест на
идентичность модуля и вручную вставленной копии в `verification.html` поймал
расхождение сразу — это ровно тот случай, ради которого он написан.
**Recorded in:** `apps/webapp/src/brand-butterfly.ts` (в докстринге функции),
PRODUCT_SPEC.md → «The success mark».


## 2026-08-13 — экран «кого ты хочешь видеть»: грузим заранее, а не ждём и не смягчаем

**Kind:** deviation from plan
**What:** фаундер предложил два варианта — пауза перед переключением, чем-то
заполненная, либо более плавное появление фотографий. Сделано ни то, ни другое
буквально: фотографии начинают качаться и **декодироваться** за три экрана до
нужного (`warmPreferencePhotos`), а гейт с затуханием оставлен только как
страховка на случай, когда форы не было.
**Why:** обе предложенные опции лечат симптом. Пауза — это добавленное ожидание
на экране, где его не было, ради того, чтобы спрятать другое ожидание; на
онбординговой воронке здесь и так следят за каждой добавленной секундой.
Плавное появление само по себе оставляет ту же сборку экрана по частям, просто
без резких краёв. Настоящая причина в том, что 530 кБ начинали качаться ровно в
тот момент, когда экран показывали, — и это единственное, что стоило поменять:
пользователь в это время печатает имя, крутит возраст и жмёт пол, то есть
несколько секунд, за которые всё успевает приехать. Замерено, а не выведено: на
экране имени в сетевом логе уже все двенадцать файлов.
**What it changes going forward — три вещи, которые легко сломать обратно:**
- **Гейт считает ВЕСЬ экран, а не колонку и не фотографию.** По фотографии — та
  же сборка по частям; по колонке — сначала заполняется одна половина экрана,
  потом вторая, то есть та же претензия на шаг мельче. Закреплено тестом,
  подтверждённым красным (правка «раскрывать по первому же фото» роняет 4 из 7).
- **Гейт слушает `decode()` через ref, а не `onLoad`.** Прогретая фотография
  успевает декодироваться до того, как React повесит слушатель, и `onLoad` тогда
  не сработает никогда — экран остался бы пустым до кэпа ровно в том случае,
  ради которого прогрев и делался. Это тот же приём и та же причина, что у
  `AppIcon` в интро; копировать `onLoad` сюда нельзя.
- **Тэлли кормится ОТРИСОВАННЫМИ фотографиями, а не папкой.** `placeScatter`
  обрезает по числу слотов, поэтому седьмое фото, положенное в папку, не имело бы
  элемента для декода и держало бы экран пустым до кэпа при каждом открытии.
  Тест держит, что сегодня папка и композиция сходятся.
**Что видно в худшем случае** (проверено скриншотом, а не рассуждением): две
градиентные колонки со своими подписями и кнопка «И тех, и других» — то есть
законченный экран, а не дырка. Поэтому «ничего пока не показывать» здесь дешевле,
чем показывать наполовину.
**Recorded in:** PRODUCT_SPEC.md §1.3, `apps/webapp/src/preference-reveal.ts`,
`preference-photos.ts` → `warmPreferencePhotos`.

---

## 2026-08-13 — деньги идут с экраном, а не с дописанной строкой

**Kind:** change of mind
**What:** падение купюр на сцене 2 больше не висит на reveal-механизме, который
ждёт, пока строка допечатается. Оно стартует вместе со сценой, а reveal-cue с
этой сцены удалён совсем: холд на дописанном вопросе — вся её тайминговая
логика.
**Why:** фаундер сообщил, что деньги появляются с задержкой. Так и было: ~1.4 с
набора + 0.3 с холда + 0.26 с паузы ≈ 2 с пустого экрана. Я выбрал reveal,
потому что им сделаны обе соседние сцены, и это была подгонка под существующий
механизм, а не решение про этот экран. **Разница в том, ЧТО показывает визуал.**
Иконки на сцене 0 и осыпание на сцене 1 — объекты, которые копия только что
заслужила, поэтому ждать предложение там и есть смысл. Деньги — погода: она уже
идёт, когда в неё выходишь, и ждать от неё разрешения не нужно.
**What it changes going forward:**
- **Правило, которое я вывел из этой ошибки:** reveal нужен, когда визуал —
  следствие сказанного; когда визуал это ОБСТАНОВКА, он идёт с экраном.
  Следующему такому экрану не надо копировать соседний по инерции.
- **Экран стал КОРОЧЕ**, а не длиннее: ~3.83 с против ~4.39 с, то есть +0.36 с
  к исходному, а не +0.9 с. Цифра в PRODUCT_SPEC и в блоке deploy.md исправлена;
  комментарий у `MONEY_VIEW_MS` теперь прямо говорит, что это НЕ время, которое
  деньги на экране (оно ~3.8 с) — эти два числа совпадали только пока падение
  было привязано к строке.
- **«Купюры стартуют из середины своего цикла» стало несущим.** Раньше это была
  защита от занавеса при наличии двух секунд набора; теперь набора в запасе нет,
  и кадр обязан быть полным на первом же кадре. Тест на отрицательную фазу — то,
  что это держит.
- **Падение теперь выключается через один кроссфейд после ухода со сцены**, и
  это отдельный дефект, который я внёс сам: старая версия только включала
  `is-falling` и никогда не выключала, поэтому 14 анимаций и три размытых слоя
  композились за каждым следующим экраном интро — в том числе за экраном метрик
  с его собственной анимацией. Обе границы намеренные: обрубать на смене фазы
  нельзя, иначе купюры пропадут, пока сцена ещё гаснет.
**Про «плавно» — замерено, а не починено «на всякий случай».** 150 кадров на
сцене 2 против текстовой сцены как контроля: p50 16.7 мс, кадров дольше 20 мс —
ноль, цифры совпадают с контролем. Поэтому я НЕ стал трогать то, что напрашивалось
(снять кувырок с размытого ближнего слоя, чтобы убрать три перерисовки blur под
3D-поворотом в кадр): менять картинку ради предполагаемого выигрыша, которого
измерение не показывает, — это не оптимизация. Замер десктопный, так что он
опровергает «анимация тяжёлая сама по себе», но не заменяет проверку на телефоне;
если жалоба повторится на устройстве — начинать надо именно с этого blur.
**Recorded in:** PRODUCT_SPEC.md §1.1, `apps/webapp/src/onboarding.tsx`
(`SCENE_CROSSFADE_MS` + эффект денег), `onboarding-money.ts`.

---

## 2026-08-13 — бабочка не садится на галочку, а улетает

**Kind:** change of mind
**What:** марка успеха переделана: бабочка чертит галочку и **уходит из кадра**, в
покое остаётся только жирная безрамочная бордовая галочка. Вчерашняя версия
сажала её на кончик с раскрытыми крыльями.
**Why:** founder: «логотип остается на самой галочке что очень странно. Анимация
выглядит некрасиво». Это верное чтение, и вчерашнее обоснование («финальный кадр
— силуэт логотипа, брендовое присутствие») было ошибкой ранжирования: финальный
кадр — единственный, на который смотрят целую секунду, и логотип, сидящий на
острие, читается как **наклейка**, приклеенная к галочке, а не как одна марка.
Брендовым является ДВИЖЕНИЕ — узнавание тратится за те 900 мс, пока бабочка
рисует; держать её потом неподвижно не покупает ничего. Плюс уход снимает
конфликт, который посадка имела сама с собой: чтобы встать ровно, полёт был обязан
раскручивать наклон на последних процентах, то есть замах останавливался и
выпрямлялся. Теперь наклон -45° (угол самого штриха) держится до конца.
**Заодно это ровно то, что founder предлагал вариантом Б** («превратится в ту же
самую галочку, только безрамочную, жирную и плавно появившуюся») — вчера я взял из
него всё, кроме исчезновения бабочки.

**What it changes going forward — три правки, каждая найдена глазами, не расчётом.**
Инструмент тот же, что и вчера: филмстрип из реальной разметки и реального CSS,
кадры заморожены отрицательным `animation-delay` + `paused`. Одиночный скриншот
живой анимации всегда попадает в случайную точку.

- **Бабочка летит ВПЕРЁД линии, а не по ней** (`BUTTERFLY_LEAD`, 7 единиц). Сидя
  ровно на ведущей кромке штриха, она перекрывала линию, которую рисует, в том же
  тоне — и читалась утолщением линии, а не тем, что её создаёт. Со выносом штрих
  выходит у неё из-под хвоста. Направление — «вперёд по пути и наружу изгиба», и
  поскольку оба плеча под 45°, это сводится к простому: чистый +x на пикЕ, чистый
  −y на подъёме.
- **Ярким может быть ровно одно, и это бабочка.** Диапазон градиента штриха сужен
  с `#C82356` до `#9C2B44` → `#8B253B` (акцент). На `#C82356` готовая марка
  читалась **розовой** галочкой вместо бордовой, и тот же яркий штрих съедал
  бабочку, у которой верхние лепестки темнее. Штрих — это чернила, чернила темнее.
  Тест сравнивает светимость двух градиентов, чтобы роли нельзя было поменять.
- **Кадр размерен под ПОКОЯЩУЮСЯ галочку** (138 × 118, галочка отцентрована с
  точностью до единицы). Было 132 × 104, и галочка стояла на 8 единиц левее
  центра — цена того, что кадр был размерен под крыло севшей бабочки.

**Правило про проверку габарита, которое я нарушил дважды:** нельзя проверять одну
константу против одной точки. Габарит повёрнутой бабочки много больше её
собственного бокса 88.6 × 63.4, и связывающая кромка здесь **верхняя**, а не
правая (бабочка летит над кончиком, который и сам стоит высоко). Масштаб 0.43
проходил по правой стене и вылезал за потолок. Тест теперь обходит КАЖДЫЙ
авторский кейфрейм с его собственным масштабом и поворотом.
**Recorded in:** PRODUCT_SPEC.md → Cross-Cutting Concerns («The success mark»),
`apps/webapp/src/butterfly-success.{ts,css}`.

---

## 2026-08-12 — единая марка успеха: бабочка чертит галочку

**Kind:** founder decision + deviation from plan
**What:** четыре разных галочки на экранах успеха заменены одной общей маркой
(`butterfly-success.ts`) — бабочка пролетает траекторию галочки, оставляя
утолщающийся бордовый штрих, садится на кончик и раскрывает крылья. Пятый экран
(онбординг `DoneScene`) показывал `loading-orb`, то есть **спиннер загрузки на
завершённом состоянии**, и тоже получил марку.
**Why the founder's own two ideas were not built, since both were offered:**
- **Бабочка с большим пальцем не строится.** Логотип это два крыла и больше
  ничего (`M 50 35 C 20 0, …`) — ни тела, ни головы, ни плеча. «Рука» означает
  разработку маскота с анатомией, то есть отдельный брендовый проект, а на 76–96px
  палец это 2–3 пикселя. Проверено, а не заявлено: рендер логотипа рядом с
  брендовым файлом подтвердил, что это абстрактная четырёхлепестковая форма.
- **Вращение → галочка** конфликтует с лоадером: там уже три машущие и дрейфующие
  бабочки, и «работаю» с «готово» стали бы одной картинкой.
**Why a tick at all, and not the butterfly alone:** галочка читается как «готово»
мгновенно и в любой локали, а два из этих экранов — **оплата** и **проверка
личности**, где двусмысленность стоит дорого. Бабочка зарабатывает своё место
тем, что галочку ЧЕРТИТ, а не стоит рядом.
**What it changes going forward — три вещи, которые легко «починить» обратно:**
- **Полёт и штрих делят один набор стопов кейфрейма**, оба `linear`, и ускорение
  живёт в РАССТАНОВКЕ стопов, а не в easing-кривой. Это две
  анимации на двух элементах, продающие одну иллюзию; разные стопы = кончик
  штриха отъезжает от бабочки посреди взмаха. Закреплено тестом, подтверждённым
  красным.
- **Градиент штриха идёт ЯРКИЙ → ТЁМНЫЙ**, то есть в контринтуитивную сторону.
  Обратное направление ставит самую яркую точку штриха ровно туда, куда садится
  бабочка, а у логотипа собственная магента на нижней кромке — они слились в одно
  пятно, и бабочка читалась как утолщение линии. Найдено просмотром рендера, не
  рассуждением.
- **Бабочка остаётся подписью (0.45), а не сюжетом.** Отревьюено на 0.40 / 0.58 /
  0.74 / 0.90: после ~0.5 галочка превращается в подчёркивание под бабочкой.
**Deliberately not converted** (каждое — со своей причиной, см. PRODUCT_SPEC):
экран `waiting` календаря (его галочка значит «выбор сохранён», а не «свидание
закреплено» — одинаковая марка сделала бы два состояния неразличимыми), медальон
`renderSuccess` в venue-change (четыре сменных глифа отвечают «что произошло»),
галочки выбора и прогресса, штамп «PAID» на карточке билета.
**Одна поправка к моей же инвентаризации:** я отчитался о четырёх экранах с
галочками, а их пять — в календаре их две (`agreed` и `waiting`). Пятую нашёл
только на финальной проверке висящих ссылок, и она осознанно оставлена как есть.
**Recorded in:** PRODUCT_SPEC.md → Cross-Cutting Concerns («The success mark»),
`apps/webapp/src/butterfly-success.{ts,css}`, `brand-butterfly.ts`.

---

## 2026-08-12 — экран «сколько это стоит»: деньги вместо жеста рукой

**Kind:** founder decision + not done
**What:** на сцене 2 интро падают купюры в трёх слоях глубины. Изначально
просили жест — клешню Красти Крабса или киношное потирание пальцами. Клешня
отклонена, руку я не смог нарисовать и сказал об этом вместо того, чтобы
дожимать вслепую.
**Why — три отдельных решения, и все три стоит записать:**

- **Клешня Красти Крабса отпала как чужая IP.** Узнаваемый персонаж
  Nickelodeon/Viacom на третьем экране приложения, которое проходит ревью
  Apple, — риск на ровном месте ради узнаваемости мема. Founder согласился с
  формулировкой сразу; предложенная замена («оригинальная мультяшная клешня»)
  тоже отклонена — без узнаваемости она теряет весь смысл.
- **Жест рукой не сошёлся за восемь итераций, и это метод, а не старание.**
  Я рисую анатомию вслепую: правлю числа в кривых Безье, рендерю PNG через
  resvg, смотрю. Каждая итерация чинила одно и ломала другое — щипок сходится,
  кулак становится плитой; кулак чинится, пальцы сливаются в петлю. На реальном
  размере (~130px) поза читалась либо как ☝️, либо как 👍. **Это хуже, чем
  «неидеально»: на экране про цену рука, читающаяся как 👍, — другой жест с
  другим смыслом.** Остановился и вынес выбор наверх, а не потратил ещё десять
  раундов молча.
- **Деньги как герой — не утешительный приз.** Физика падающей бумаги, слои
  глубины и детерминированная геометрия — ровно то, что в этом репозитории уже
  доказано (осыпание иконок на соседнем экране), поэтому этот вариант я делаю
  хорошо, а не «как получится». Смысл «цена» читается без жеста.

**What it changes going forward:**
- **Если жест руки когда-нибудь понадобится — нужен ассет, а не ещё итерации.**
  SVG с большим пальцем отдельной группой; моушен-часть поверх него дешёвая.
  Lottie-рантайма в бандле нет (`apps/webapp/package.json`), его добавление —
  отдельное решение. Слой денег от руки не зависит и переживёт её появление.
- **Композиция удерживается двумя правилами, которые легко сломать обратно.**
  Купюры **всегда позади текста** — вопрос это то, ради чего экран существует, а
  на 390px `.hook-main` (28rem) не оставляет полей, сквозь которые крупный слой
  мог бы пройти, не задев букв; ближний слой поэтому намеренно слабое боке
  (при 0.34/2.2px он смыл строку «найти отношения» — поймано на пошаговом
  кадре). И **фаза старта отрицательная**: без неё экран наполняется сверху
  занавесом и нижняя половина секунду пуста.
- **Приём проверки, который сработал:** заморозить `document.getAnimations()`
  и шагать `currentTime`. Оба дефекта выше видны только на кадре, а не в
  тестах, и не ловятся одним скриншотом — анимация успевает пройти мимо.
**Recorded in:** PRODUCT_SPEC.md §1.1, `apps/webapp/src/onboarding-money.ts`,
`apps/webapp/src/seeded-noise.ts`.

---

## 2026-08-12 — правка «на месте» безопасна только пока карточка последняя в чате

**Kind:** deviation from plan
**What:** после тикет-гейта календарь отправляется НОВЫМ сообщением (удалить +
переслать), а не редактированием отслеживаемой post-accept карточки. Выведено из
`afterTicketGate`, не заведено отдельным флагом.
**Why:** пришло как «демо зависает на гейте, синтетический партнёр не
подтверждает». Партнёр подтверждал. Проверено на живой демо-базе, а не выведено:
`ticketStatus = completed`, оба слота оплачены (её 20:57:47, кукла 20:58:03), 84
слота сетки записаны — и **ноль** событий чата после второй оплаты. Календарь
уехал `editMessageText` в сообщение 545 «Прийнято ✨ Чекаємо на іншу сторону»,
которое к тому моменту было третьим снизу: правка не даёт уведомления, и кнопка
появилась выше стандалон-карточки билета. То есть весь флоу на экране умирал на
фразе «ждём вторую сторону» ровно тогда, когда ждать было уже нечего.
**Почему это не баг демо:** код общий, `TICKET_FEATURE_ENABLED=true` в проде, и
для мужчины, оплатившего «за обоих», ломается так же. В проде не выстрелило
только потому, что до гейта там не дошла ещё ни одна пара — а в демо доходит
каждый прогон.
**What it changes going forward:**
- **Правило вместо частного случая: `sendOrEditPostAcceptMessage` правит на
  месте, только если отслеживаемая карточка всё ещё последняя в чате.** Два
  места, где это не так, теперь оба делают resend — контрпредложение по
  календарю (там это было с самого начала, с комментарием «иначе партнёр просто
  не увидит») и календарь после гейта. Третий вызывающий обязан ответить на тот
  же вопрос.
- **Комментарии в коде утверждали обратное, и это и есть причина, по которой
  никто не заметил.** `completeTicketGateAndUnlockScheduling` писал
  «`calendarMessageId*` starts null here» — неправда; `decision.ts` писал, что
  карточка «morphs in place into the ticket card» — карточка билета отдельная и
  отслеживаемую не трогает. Оба исправлены; PRODUCT_SPEC §3.5b/§3.6/§3.6b тоже
  описывал стадию, которой нет.
- **Тесты промахнулись, потому что фикстуры повторяли ложную посылку:** оба
  существующих теста `startScheduling` подавали `calendarMessageIdA: null`. Новый
  тест даёт непустой id и подтверждён красным до фикса.
**Recorded in:** PRODUCT_SPEC.md §3.5b + §3.6 + §3.6b, ARCHITECTURE.md →
`matches`, `handlers/matching/scheduler.ts`.

## 2026-08-12 — защита фото партнёра снимается в демо; это одна константа, а не шесть веток

**Kind:** founder decision + deviation from plan
**What:** `protect_content` на всех поверхностях, где видно лицо партнёра
(§3.7a), выключается в демо-режиме. Реализовано **одной экспортируемой
константой** `PROTECT_PARTNER_MEDIA` (`demo/config.ts`), которую читают все
шесть отправителей, а не шестью `if (DEMO_MODE_ENABLED)` по месту.
**Why:** founder попросил убрать это в демо, потому что клиенты Telegram
затирают защищённое медиа на скриншоте и при записи экрана — то есть прогон,
который снимают для инвестора, записывает чёрный прямоугольник ровно там, где
должен быть партнёр. В демо терять нечего: партнёр там — засеянная марионетка,
у которой нет фотографии, которую надо защищать.
**Почему константа, хотя AGENTS.md говорит «один закомментированный
`if (DEMO_MODE_ENABLED)`»:** это правило про то, чтобы демо-поведение не
расползалось, и здесь буквальное следование ему дало бы обратный эффект —
**шесть** копий одного правила в шести модулях. Отказ тут молчаливый: седьмая
поверхность с захардкоженным `protect_content: true` просто чернеет на записи,
ничего не падает и никто об этом не узнает. Одна точка, которую нельзя не
заметить, дешевле шести, которые надо помнить.
**What it changes going forward:**
- **Новый отправитель фото партнёра берёт `PROTECT_PARTNER_MEDIA`, а не `true`.**
  Тест в `demo/config.test.ts` держит саму константу (подтверждён красным при
  захардкоженном `true`), а тесты самих отправителей продолжают фиксировать
  `protect_content: true` в проде — это и есть защита от того, чтобы случайно
  снять её у реальных людей.
- **Замыленная share-копия дата-карточки сознательно НЕ ходит через константу**
  — она не защищена в обоих режимах, потому что безопасной её делает блюр, а не
  флаг. Роутить её сюда «для единообразия» нельзя.
- **`profile-media-dispatch.ts` остаётся общим** и по-прежнему принимает
  `protect: boolean` от вызывающего: он обслуживает и просмотр пользователем
  своего собственного профиля, где защиты нет и не должно быть.
**Заодно уточнено расхождение в PRODUCT_SPEC:** там было сказано, что скриншоты
«нельзя заблокировать в обычном чате бота». Это верно как утверждение о
**гарантии** (Bot API её не обещает) и неверно как описание наблюдаемого
поведения — клиенты их затирают, что и стало причиной этой правки. Формулировка
разведена на «гарантии нет» и «на практике затирают».
**Recorded in:** PRODUCT_SPEC.md §3.7a, DEMO_MODE.md (таблица отличий +
«guarded branches»), `apps/bot/src/demo/config.ts`.

---

## 2026-08-12 — этап онбординга выводится из состояния, а не из колонки `onboardingStep`

**Kind:** deviation from plan + not done
**What:** re-engagement перестал брать контекст для промпта из
`User.onboardingStep` и берёт его из нового `services/onboarding-stage.ts`,
который выводит реальный шаг из тех же полей, по которым маршрутизирует сам
мини-апп.
**Why:** founder сообщил, что письма-возвраты твердят «осталось выбрать язык»
кому угодно. Колонка на это ответить не может: у неё четыре значения, и **весь**
входной мини-апп схлопывается в одно из них — `/consent` и `/language` оба пишут
`language`, и до `/complete` она больше не двигается. То есть развилка
регистрации, почта/телефон, город, тема, пять экранов профиля и выбор AI-памяти
— половина регистрации — читались как «согласился с политикой, но ещё не выбрал
язык». Замерено на проде: аккаунт с `language = uk` и принятыми условиями
получил все пять касаний про выбор языка.
**Почему это не «поправить строчку в switch»:** правильный ответ существует
только в клиентском `postVisualPhaseFromRemote`, а `apps/webapp` сознательно не
зависит от `@gennety/shared`, так что код общим сделать нельзя. Отсюда серверный
двойник с явным требованием держать ТОТ ЖЕ порядок — разъедутся, и подсказка
назовёт экран, который человек уже прошёл.
**What it changes going forward:**
- **Конкретный НЕВЕРНЫЙ шаг хуже общей фразы.** Это записано правилом в самом
  промпте: модель либо называет то, что реально следующее, либо не называет
  ничего. Причина в том, что сообщение написано, чтобы звучать лично, — и именно
  поэтому ошибка в нём читается как «бот не понимает, кто я».
- **Два намеренных упрощения, и оба занижают, а не завышают остаток.** Визуальное
  интро серверу не видно (его позиция в DeviceStorage клиента), а экраны подарка
  не являются этапом вовсе — они ничего не спрашивают, и разрешить их можно
  только через флаги referral/promo плюс запрос кода. Тот, кто встал там,
  описывается как «на экранах профиля», то есть на шаг дальше.
- **Селект воркера теперь несущая часть фичи, а не оптимизация.** Урезать его —
  значит вернуть всех в первый этап, ровно в форму исходного бага; на состав
  полей стоит тест.
**Deliberately not done — два соседних дефекта, оба продуктовые решения:**
1. **10 из 15 брошенных аккаунтов в проде не получают вообще ничего.** Цепочку
   вооружает только первая запись мини-аппа (`onboardingActivityPatch`), а
   `/start` — нет. Значит человек, открывший бота и не нажавший внутри мини-аппа
   ни одной кнопки, невидим для воркера: `reEngagementNextAt` = null. Это не
   опечатка, а вопрос «пишем ли мы тем, кто не сделал ни одного действия» — то
   есть кому и сколько мы шлём, решение founder'а, а не рефакторинг.
2. **В самом нудже нет кнопки обратно в мини-апп.** Человек должен найти
   доскроллом старую карточку или послать `/start`. Добавление инлайн-кнопки к
   пяти касаниям — изменение поверхности, а не копии, и просилось бы отдельно.
**Recorded in:** PRODUCT_SPEC.md §1.5, `services/onboarding-stage.ts`.

---

## 2026-08-12 — иконки конкурентов рассыпаются: плитки, а не частицы, и не SVG

**Kind:** founder decision + deviation from plan
**What:** три иконки дейтинг-приложений теперь переживают переход с первого
интро-экрана на второй и по окончании набора текста осыпаются вниз, ряд за
рядом сверху донизу.
**Why the shape is what it is — три решения, каждое из которых стоит записать:**
- **Иконки оказались PNG, а не SVG**, как предполагалось в запросе. Это не
  ограничение, а причина выбранного подхода: растр можно нарезать плитками
  через `background-position`, и **нулевой кадр рассыпания попиксельно равен
  целой иконке**, поэтому подмена `<img>` на сетку невидима. У SVG пришлось бы
  резать по путям, у canvas-частиц — прятать шов кроссфейдом.
- **Иконки не переезжают между экранами ни на пиксель** (замерено: бокс ряда
  идентичен, x 152.1 / y 625.51, при смене текста). Неподвижность — это и есть
  то, что читается как «те же три объекта», а не как второй показ. Отсюда же
  выбор постоянного оверлея на уровне шелла: тот же приём, что у `pivot-logo`.
- **Геометрия детерминированная.** По уже записанному правилу
  `preference-layout.ts`: разброс, пересыпаемый на каждый рендер, нельзя
  отревьюить дважды и нельзя закрепить тестом.
**What it changes going forward — две вещи, которые легко сломать обратно:**
- **Флоат обязан жить на обёртке, которая не размонтируется.** Перенести его на
  `<img>` — значит перезапустить анимацию в момент подмены и дёрнуть иконку на
  амплитуду флоата ровно там, где подмена должна быть незаметна.
- **Плитки режутся в абсолютных px с перекрытием 1px, а не в процентах.** Первая
  версия использовала проценты от самой плитки — и по иконке пошла сетка
  волосяных швов ещё до начала падения (найдено скриншотом, не рассуждением).
  Две причины сразу: плитка шириной в дробное число пикселей округляется
  по-разному, и 30 антиалиасных боксов встык под наклоном ~13° дают видимый шов.
  Перекрытие безопасно **только** пока фон абсолютный: лишний пиксель тогда
  рисует ровно то, что рисует сосед. Вернуть проценты — значит вернуть швы.
**Deliberately not done:** оставлен `?preview=intro[:n]` — dev-only маршрут
(`import.meta.env.DEV`), потому что иначе этот эффект ревьюится только полной
регистрацией на dev-боте через HTTPS-туннель на каждой итерации. Тот же приём и
та же причина, что у `?preview=basics`.
**Recorded in:** PRODUCT_SPEC.md §1.1, `apps/webapp/src/onboarding-crumble.ts`.

---

## 2026-08-12 — уровень прерывания выводится из типа, но по ДРУГОЙ причине, чем категория

**Kind:** deviation from plan
**What:** `interruption-level: time-sensitive` ставится в `buildAlertPayload`
по списку `TIME_SENSITIVE_PUSH_TYPES` (`safety.brief`, `proxy.opened`), а не
полем в `AlertPushInput`.
**Why — и «как категория» здесь недостаточный ответ:** прецеденты 2026-08-11
(категория) и 2026-08-12 (`mutable-content`) держались в том числе на цене
поля — оба нужны ВСЕМ пушам, значит поле означало бы обход ~25 вызывающих.
Здесь это неверно: уровень нужен двум отправителям, и поле стоило бы двух
правок, а не двадцати пяти. Так что решение принято на другом основании.
**Настоящая причина — это привилегия, а не свойство.** Все прочие поля
описывают уведомление; это — право прервать человека, который явно попросил
его не прерывать. Поле раздаёт это право походя: любой будущий отправитель
берёт его сам, и нигде не остаётся места, где видно ВЕСЬ список. Именованный
набор делает захват права правкой одной константы, которую держит тест, а на
вопрос «что у нас пробивает Do Not Disturb?» отвечает чтением четырёх строк.
Вторым аргументом идёт всё та же молчаливость расхождения: уровень невидим,
пока у человека не включён Focus, поэтому пуш, потерявший его, выглядит ровно
как пуш, который его и не просил.
**Контрдовод и что с ним:** «насколько срочно» действительно не то же самое,
что «что это за уведомление» — но у ЭТИХ двух типов совпадает. Оба существуют
только внутри минут, которые делают их срочными: брифинг шлётся в T-1.5ч и
больше никогда, «чат открыт» — в T-30м и больше никогда. Правило на будущее:
**если срочность типа начнёт зависеть от контекста, тип надо разделить, а не
заводить поле.** Уведомление, которое иногда срочное, а иногда нет, — это два
разных уведомления для того, кто его получает; строка типа ничего не стоит, а
клиент и так заводит категории по ней же.
**What it changes going forward:** список закрыт и лежит в одном месте.
Добавление типа туда — продуктовое решение про чужой Do Not Disturb, и тест
держит состав набора целиком, а не по одному члену. Сознательно НЕ входят:
`match.proposed` (24-часовое окно — не срочность, а под ежедневным каденсом он
пробивал бы Focus каждый вечер), `proxy.message` (сообщение раз в пару минут,
пробивающее Focus, — это спам), `feedback.due` (вопрос про вчера).
**Recorded in:** `services/apns.ts` → `TIME_SENSITIVE_PUSH_TYPES`,
ARCHITECTURE.md → External Dependencies (APNs).

## 2026-08-12 — брифинга безопасности на мобильной рельсе не существовало, и дыр там было две

**Kind:** deviation from plan
**What:** iOS-задача 5.4 предполагала, что пуш брифинга есть и ему надо
добавить флаг срочности. Пуша не было: `pre-date-safety.ts` фильтровал
получателей по `telegramId > 0n` и не слал ничего больше. Сделан сам пуш.
**Why it matters more than «забыли»:** ровно в этом файле шесть недель стоял
комментарий «they get safety briefs via push, not Telegram DM» — та же ложь в
коде, что была в `pitch.ts` про дроп, девятый экземпляр одного класса дыр.
**Вторая дыра внутри того же фильтра хуже первой.** `telegramId > 0n` — это не
проверка достижимости с тех пор, как приехал вход через Telegram: он кладёт
НАСТОЯЩИЙ положительный id аккаунту, которому бот писать не может. То есть
женщина из приложения не получала брифинг вовсе, а женщина, вошедшая через
Telegram, не получала его на рельсе, которая при этом отчитывалась успехом.
Пол выбирает получателя, `platform` — рельсу; это два разных вопроса, и
схлопывание их в один фильтр и было дефектом.
**What it changes going forward:** копия пуша не называет ни партнёра (правило
§5.3), ни **место**. Второе — не перестраховка: брифинг существует ради
безопасности женщины, а объявление на публичном экране блокировки, где она
сегодня будет, работает против того, ради чего он отправлен. Сам чеклист
остаётся в DM/приложении; пуш только сообщает, что он пришёл.
**Recorded in:** PRODUCT_SPEC.md §Phase 4, `services/pre-date-safety.ts`.

---

## 2026-08-12 — claim освобождается до роутеров, а не внутри своего; два дефекта рядом оставлены

**Kind:** deviation from plan + not done
**What:** `releaseStaleMenuClaim` перенесён из menu-роутера в раннюю middleware
`bot.ts` — туда, где уже освобождается match-flow claim. Устаревший `menuState`
(например брошенный `edit_bio`) больше не виден Profiler-роутеру, который
смонтирован РАНЬШЕ menu-роутера.
**Why:** founder сообщил, что ответ на Profiler-вопрос не сохраняется, его
перехватывает агент, и серия из трёх вопросов обрывается. Этот порядок даёт
ровно такой симптом: Profiler читает `menuState` в своей проверке `idle`, видел
ещё не сброшенный протухший claim, отказывался ловить ответ **и закрывал answer
window** (после чего живой вопрос уже нельзя ответить обычным текстом), а
menu-роутер следом сбрасывал claim и отдавал текст консьержу. Вопрос висел до
6-часового stall-свипа → implicit skip → батч на паузу. Match-flow twin этого
бага не имел: обе его точки сброса (`bot.ts` для тапа/команды, matching+date
роутеры для протухшего текста) уже стоят до Profiler'а. Порядок закреплён
тестом, красным без фикса.
**Честность записи:** воспроизвести симптом на данных не удалось. Проверены все
три среды — прод (21 записанный ответ, полные батчи по 3, ни одного случая
«вопрос → текст → ответ агента» в `chat_events`), демо (6 строк, все
implicit-skip по таймауту; founder ни разу не печатал ответ), dev-база пуста с
08-05. Фикс сделан по разбору кода, а не по найденному следу.
**What it changes going forward:**
- **Любой claim на свободный текст освобождается в `bot.ts`, до роутеров.**
  Освобождать внутри роутера-владельца безопасно только если ни один более
  ранний роутер это поле не читает — для `menuState` это не так.
- Новое claimable-состояние меню добавляется в `CLAIMABLE`, а не отдельной
  проверкой внутри menu-роутера.
**Deliberately not done — два соседних дефекта, оба требуют продуктового
решения.** *(Оба закрыты 2026-08-13 по решению фаундера — см. запись наверху;
оставлено как есть, потому что рассуждение ниже объясняет, почему они были
отложены, и по второму пункту предложенный путь оказался тем, что и сделали.)*
1. **`edit_photos` / `edit_video` не истекают никогда** (осознанно вне
   `CLAIMABLE` — они потребляют медиа). Побочный эффект: открыл «Мои фото»,
   ушёл — и `menuState` не-idle бессрочно, ответ Profiler'у не ловится, а текст
   уходит в `handleEditPhotosUpload`. Симптом другой (не агент), и PRODUCT_SPEC
   §2.1 прямо описывает закрытие менеджера тапом по другой кнопке.
2. **`PROFILER_ANSWER_WINDOW_MS` (90 мин) < `PROFILER_STALL_TIMEOUT_MS` (6 ч).**
   4.5 часа вопрос выглядит живым и его Skip работает, но напечатанный ответ уже
   уходит агенту. §Phase 1b описывает это как дизайн с escape-hatch «ответь
   реплаем», которым никто не пользуется. Замер по проду: из 13 вопросов все 11
   отвеченных пришли за 0–53 мин, поздних нет — в проде ещё не стреляло. Если
   менять, предлагаемый путь: за пределами окна, но до stall, ловить текст как
   ответ, кроме question-shaped (`isLikelyMetaQuestion` — тот же предикат, что
   §1.3 уже применяет в фотостадии).
**Recorded in:** PRODUCT_SPEC.md §Phase 1b, `services/menu-text-claim.ts`
(`releaseStaleMenuClaim`), `bot.ts`, `handlers/profiler/router.test.ts`.

---

## 2026-08-12 — дроп-пуша на мобильной рельсе не существовало вовсе

**Kind:** deviation from plan
**What:** iOS-задача 5.3 («NSE блюр-пуш») предполагала, что уведомление о дропе
есть и к нему надо добавить картинку. Уведомления не было: ни одного
`sendPushToUser` на пути питча, восьмой раз подряд та же дыра, что у тикет-гейта,
календаря и прокси-чата. Сделан сам пуш (`services/match-drop-push.ts`), а не
довесок к нему.
**Why it matters more than «забыли»:** комментарий в `pitch.ts` шесть недель
утверждал обратное — «their pitch goes via the Expo push path» — то есть
документация в коде описывала рельс, которого никто не построил. Человек,
живущий в приложении, узнавал о главном событии недели только открыв приложение
сам; при этом ровно к этому пушу привязан пре-пермишн экран онбординга, который
обещает «узнаешь первым».
**What it changes going forward:** **копия пуша обязана совпадать с макетом на
пре-пермишн экране приложения** (`prenote.mock.title` / `prenote.mock.body`
в iOS-репо) — это одно предложение в двух местах, и разъехаться им нечем, кроме
внимания. Правка одной стороны без другой превращает обещание в обман. Второе:
пуш **не называет партнёра ничем** — ни именем, ни возрастом; единственный след
человека там замыленная фотография, и это тот же запрет, что у Live Activity
«Решение» (§4.1 iOS). Ключевой набор `data` закреплён тестом (`["image",
"matchId", "type"]`), так что новое поле придётся сначала обосновать там.
**Recorded in:** PRODUCT_SPEC.md §3.3, `services/match-drop-push.ts`.

## 2026-08-12 — `mutable-content` выводится из наличия картинки, а не заводится полем

**Kind:** deviation from plan
**What:** флаг, будящий Notification Service Extension, ставится в
`buildAlertPayload` тогда и только тогда, когда в `data` есть непустой `image`.
Отдельного поля нет.
**Why:** ровно та же причина, по которой 2026-08-11 категория выводится из
`data.type` — это один и тот же факт. Расширение существует ради одной работы:
замылить картинку. Пуш с картинкой её требует, пуш без картинки не даёт
расширению работы вовсе. Два поля могли бы разойтись молча и в обе стороны:
флаг без картинки — процесс, разбуженный впустую; картинка без флага —
уведомление, которое просто приходит без фотографии, и отличить это от
«у человека старый клиент» нельзя ничем.
**What it changes going forward:** отправитель, которому нужно вложение,
кладёт `image`; ничего больше не надо, и ничего больше не надо помнить.
Если когда-нибудь появится вторая работа для расширения (не картинка), вывод
перестанет быть верным — тогда это будет поле, и его придётся заводить
сознательно, а не дописывать сюда.
**Recorded in:** `services/apns.ts` → `buildAlertPayload`, ARCHITECTURE.md →
External Dependencies (APNs).

## 2026-08-12 — подписанная ссылка в пуше живёт сутки, а не десять минут

**Kind:** change of mind
**What:** `partnerPhotoUrls` получил TTL-параметр; дроп-пуш подписывает ссылку
на 24 часа (`PUSH_PHOTO_URL_TTL_MS`) вместо десяти минут, которыми живут ссылки
на экране питча.
**Why:** десять минут правильны для экрана, на который человек смотрит, и
неверны для уведомления. APNs хранит недоставленный алерт и отдаёт его, когда
телефон вернётся в сеть — то есть ровно в том случае, ради которого пуш и
существует. Ссылка, протухшая, пока телефон был выключен, теряет картинку
именно тогда, когда она нужна.
**Why it is not a weaker guarantee:** подпись никогда не была единственным
гейтом — маршрут байтов перепроверяет право на КАЖДЫЙ запрос, а сам матч
умирает на 24-часовом дедлайне решения. Так что ссылка перестаёт работать
вместе с матчем в обоих вариантах; меняется только то, переживёт ли она ночь
без сети.
**What it changes going forward:** десять минут остаются дефолтом; длинный TTL —
осознанное исключение для пуша, и любой третий вызывающий обязан назвать свою
причину, а не унаследовать эту.
**Recorded in:** `public/partner-photos.ts`.

## 2026-08-11 — якорь прода в deploy.md протух через два дня после того, как его чинили

**Kind:** a document turned out to be wrong + deviation from plan
**What:** секция «Prod anchor» утверждала, что прод стоит на `f66949a` +
`e04ffec` (2026-08-08), хотя после неё прошли релиз бэклога 2026-08-09 (32
коммита) и флип `DROP_CADENCE=daily` 2026-08-10. Реальный прод был на
`68757f7`. Пересчитан и перепривязан к `677e4e2`, md5-якоря заменены на файлы,
которые этот релиз действительно менял.
**Why it matters more than «кто-то забыл»:** запись от 2026-08-10 в этом же
журнале чинила **ровно этот файл** от **ровно этой болезни** — 15 PENDING-блоков
описывали уже выехавшую работу — и вывела правило «блок помечается в момент
верификации релиза, а не когда кто-то следующий заметит». Правило покрыло
блоки и **не покрыло якорь**, который живёт в другом конце файла. То есть
починили симптом в одном месте и оставили ту же ошибку в другом, в том же
документе, за два дня до того, как она снова понадобилась. Цена здесь ниже,
чем у PENDING-блоков (якорь не заставляет передеплоивать), но выше, чем
кажется: именно из него следующая сессия считает, что уже на сервере.
**What it changes going forward:** якорь пересчитывается как часть каждого
релиза, вместе с пометкой блока. Проверять его нужно свипом md5 по дереву, а не
по одному файлу — эта же секция уже носит контрпример, где один файл совпал по
обе стороны 84-коммитного диапазона и не доказал ничего. В этом релизе свип
765 файлов дал ноль расхождений, поэтому «прод == HEAD» здесь измерено, а не
заявлено.
**Отдельно — отступление от правила «не синкать одиночные файлы».** Пока шёл
деплой, параллельная сессия закоммитила `677e4e2` — правку описания в
`openapi/gennety-v1.yaml`. Файл донесён отдельным `rsync openapi/` без
рестарта. Предупреждение deploy.md («одиночный rsync из более нового дерева
уронит прод») — про **модули TypeScript с импортами**: механизм отказа там
`ERR_MODULE_NOT_FOUND` на отсутствующей зависимости. У YAML, который не читает
никто (ноль ссылок в `apps/bot/src` и `packages` — это контракт для генератора
iOS и для `openapi:lint`), такого механизма нет. Запись здесь для того, чтобы
предупреждение не читалось как абсолютное: критерий — «тянет ли файл за собой
импорты», а не «один файл или много».
**Recorded in:** deploy.md → блок 2026-08-11 и секция «Prod anchor».

---

## 2026-08-10 — nullable enum — тот же капкан генератора, что и nullable $ref

**Kind:** change of mind
**What:** `venueFit` в `POST /v1/me/feedback/post-date` был объявлен как
`type: [string, "null"]` с `enum: [yes, partly, no, null]`. Переведён в
обычный опциональный `enum: [yes, partly, no]`.
**Why:** вчерашняя запись про `oneOf: [$ref, "null"]` называла гейтом прогон
генератора — и он же нашёл следующего представителя того же семейства.
`null` внутри `enum` swift-openapi-generator превращает не в пропуск свойства,
а в **четвёртый кейс `_empty_ = ""`**: значение, которое сериализуется в
пустую строку и которое сервер отвергнет. Хуже пропуска тем, что кейс попадает
в `allCases` — то есть в любой клиентский `ForEach`, строящий чипы по enum'у,
въезжает пустая кнопка. Опущенное свойство говорит `normaliseFeedback` ровно
то же самое (всё нераспознанное коерсится в `null`), так что провод не менялся.
**What it changes going forward:** правило шире, чем звучало вчера: **любая
попытка выразить «ничего не выбрано» через `null` в схеме** — union, enum-член,
неважно — ломается в генераторе по-своему. Отсутствие значения выражается
отсутствием свойства. Прогон генератора остаётся гейтом: читать не только
строки `skipping`, но и появившиеся кейсы enum'ов.
**Recorded in:** `openapi/gennety-v1.yaml` → `submitPostDateFeedback.venueFit`.

## 2026-08-10 — «% платящих»: три знаменателя, и тестовые аккаунты вне дроби целиком

**Kind:** founder decision
**What:** новый раздел монетизации (`GET /admin/analytics/monetization` +
вкладка дашборда + блок в `founder-digest`). Головная цифра — платящие от всех
**реальных** регистраций; рядом, мельче, две другие конверсии (от
активированных и от дошедших до платного экрана). Все четыре разреза — канал,
пол, город, трек. Полный объём: выручка, ARPU/ARPPU, когорты, повторные
покупки, время до первой оплаты.
**Why the denominator is the decision, not the arithmetic:** на момент
реализации в проде **50 аккаунтов при 19 реальных** — 30 синтетических
профилей (§3.1c) плюс фаундерский. `0/50` и `0/19` — это разные метрики, и
первая занижает результат рекламы на 2.6×. Правило не новое: ровно так с
2026-08-03 считает `computeFunnel`, и вердикт «тестовый» берётся из той же
`user-health.ts`, а не выводится заново. Три знаменателя вместо одного —
потому что они отвечают на разные вопросы, и подменять их друг другом значит
искать проблему не там: низкая первая при высокой третьей — это сломанная
воронка, а не сломанная цена.
**What it changes going forward:**
- **Никогда не пересчитывать процент из `users.total`.** Дашборд, Hermes и
  founder-digest читают `registeredReal`; своя копия знаменателя разойдётся с
  воронкой в тот же день, когда кто-нибудь засеет ещё синтетиков.
- **Деньги тестовых аккаунтов не выручка, но и не невидимка.** Леджер
  `/admin/purchases` показывает всё (он леджер), конверсия — нет, и разрыв
  между двумя экранами объясняется полем `revenue.excludedTestUsdCents`. Без
  него расхождение читалось бы как баг.
- **«Дошёл до платного экрана» измеряется ТОЛЬКО по гейту Date Ticket** —
  единственному месту, где продукт блокирует шаг до оплаты. Магазин, Premium,
  Rematch и смена места опциональны: сколько человек их увидело, измерить
  нечем, и притворяться, что можно, хуже, чем не считать. Метка —
  `ticketExpiresAt IS NOT NULL OR ticketStatus <> 'pending'`, и оба условия
  нужны (дефолт `pending` стоит на каждой строке; завершение и истечение
  обнуляют `ticketExpiresAt`).
- **Сегодня раздел показывает нули, и это правильный результат.** 0 покупок и
  0 свиданий за всё время: до платного экрана не дошла ещё ни одна пара.
  `payingRatePct: 0` в этот период означает «платные экраны никто не видел», а
  не «люди не платят» — оговорка записана в HERMES_AGENT_PROMPT, чтобы агент
  не начал советовать «чинить монетизацию».
**Recorded in:** `admin/utils/monetization.ts` (правила + причины),
ARCHITECTURE.md → Purchase ownership, HERMES_AGENT_PROMPT.md §1c.

## 2026-08-10 — недельная выручка считается по окну, а не по последней оплате

**Kind:** change of mind
**What:** первая версия агрегатора брала пожизненный спенд тех, кто платил на
этой неделе. Переписано: окно приходит отдельным индексом
(`loadPayerIndex({since, until})`), отфильтрованным по датам в SQL.
**Why:** короткая дорога ломается на повторном покупателе — человек с $27
пожизненного спенда, купивший на этой неделе на $7, приносил в «выручку за
неделю» все $27. На нуле покупок это невидимо и стало бы видно ровно тогда,
когда появится второй платёж у первого же клиента, то есть в момент, когда на
цифру начнут смотреть. Цена решения — три вызова загрузчика вместо одного;
фильтр по датам уже проталкивается в SQL, так что это дёшево.
**What it changes going forward:** «новый платящий за неделю» намеренно
считается по **первой** оплате из пожизненного индекса, а не по недельному —
иначе повторная покупка старого клиента считалась бы новым платящим. Оба
правила закреплены тестами (`monetization.test.ts`).
**Recorded in:** `admin/utils/monetization.ts` (пункт 5 в шапке модуля).

## 2026-08-10 — `DROP_CADENCE=daily` in production, and the Thursday gate was replaced by a dry run

**Kind:** founder decision + deviation from plan
**What:** production flipped to the `daily` cadence profile (batch `0 18 * * *`),
with `pnpm cadence:normalize-standby --to=daily --apply` run first as its stated
precondition. The rollout plan had gated this on observing at least one real
Thursday drop with a working synthetic fill; the founder asked for the flip now,
and it was taken because that gate could be satisfied a better way.
**Why the gate was satisfiable without waiting:** `previewDropBatch` and
`previewSyntheticFill` are pure — they compute the allocation and write nothing —
so both were run against the production database directly. That is strictly more
informative than waiting: it names the exact pairs rather than confirming a count
after the fact, and it is repeatable. It produced three synthetic pairs covering
every eligible Kyiv user, with sensible age fits (32М×31Ж, 21М×24Ж, 22Ж×26М).
Waiting until Thursday would have observed the same thing three days later.
**What the dry run actually found, which the plan had wrong:** the plan sized
everything against "18 real men". Production has **4 match-eligible real users**,
not 18 — 16 of the 20 real accounts never finished onboarding. Of those 4, one
is in Kharkiv (an unlaunched market, so unmatchable by construction and correctly
receiving the city-switch offer instead of a famine tier), leaving **2 men and 1
woman in Kyiv**. And the real pass now yields **zero** pairs: the woman has
already been matched with both men (expired 07-30, cancelled 08-06), so the
lifetime pair ban (§3.2 filter 6) has exhausted the real pool completely. That is
not a degraded state — it is precisely the condition synthetic profiles exist
for, and it means the fill is load-bearing from the very first daily drop rather
than a rare fallback.
**What it changes going forward:**
- **The synthetic runway is ~6 days, not ~6 weeks.** Each Kyiv man consumes one
  synthetic woman per drop and the pair ban applies to synthetics too, so 12
  women ÷ 2 men = 6 daily drops of full coverage (the single woman has 18 men =
  18 drops). After that the men fall back to the ordinary famine path, which is
  documented, correct behaviour — but if continuous coverage is wanted, more
  synthetic **women** must be seeded before ~2026-08-16. Under weekly this was 6
  weeks and invisible; daily is what makes it a scheduling concern.
- **Every drop is now a rejection for these users.** Synthetics always decline —
  that is the safety mechanism, not a limitation (a mutual accept would open the
  §3.5b ticket gate and ask a real person for real Stars). Elo, `standbyCount`,
  `silentIgnoreCount` and the priority boost are all guarded, so nothing
  accumulates against them mechanically. But at daily cadence the *experience* is
  a decline every evening rather than weekly, and that is a product judgement the
  founder now owns explicitly rather than by accident.
- **The rollback is no longer one env var.** It is `--to=weekly --apply` and
  *then* the env change; reversing the order re-reads every counter at 7× and
  pins the base at the starvation cap. deploy.md's block states this inline.
**Recorded in:** deploy.md → the 2026-08-10 block at the top; PRODUCT_SPEC §3.1 /
§3.1c already describe both profiles.

---

## 2026-08-10 — deploy.md's PENDING backlog was 15 blocks of already-shipped work

**Kind:** a document turned out to be wrong
**What:** every one of the 15 remaining `**PENDING —` blocks in deploy.md
described work that shipped in the 2026-08-09 backlog release. Verified rather
than assumed: an md5 sweep of all 749 tracked `.ts`/`.tsx`/`.prisma` files under
`apps/` + `packages/` found **prod byte-identical to local HEAD** (the only
differences were four files under `apps/bot/tmp/`, which the deploy rsync
excludes by design). All 15 marked deployed.
**Why it matters more than tidiness:** this file is what a session reads to tell
a real backlog from a stale label, and the 2026-08-07 entry below records the
opposite failure — a block that read as shipped and was not. Both directions
make the file useless as a backlog, and this direction is the one that wastes a
deploy: the next session would have re-verified, re-sequenced and re-run schema
steps for sixteen changes that were already live.
**What it changes going forward:** the md5 tree sweep in deploy.md → "Prod
anchor" is the check that settles this in one command, and it should be run at
the END of a multi-block release, not only at the start of the next one. A block
is marked the moment its release is verified, not when someone next notices.
**Recorded in:** deploy.md (16 blocks re-headed `Deployed 2026-08-09 (was
PENDING)`).

---

## 2026-08-10 — I wrote the same trap into the feedback endpoints, hours after documenting it

**Kind:** change of mind
**What:** `GET /v1/me/feedback/pending` and its POST twin declared their one
payload property as `oneOf: [$ref PendingFeedback, "null"]` — the exact shape
the entry below is about. Both are now an optional bare `$ref`.
**Why it matters more than the mistake:** I introduced it **the day before**
writing that entry, and reviewing the spec did not catch it — regenerating the
Swift client did, on the very run meant to verify the other fix. That is the
whole lesson made concrete: this trap is not caught by reading, by review, or by
`openapi:lint`. The spec is valid, the server sends the field, and the property
silently does not exist in Swift. The generated client would have had no
`pending` at all, so the endpoint that exists specifically to make the form
reachable would have been unreadable.
**What it changes going forward:** **`./scripts/generate-api.sh` is the gate for
a contract change, not `openapi:lint`.** A clean generator run means zero
`Schema "null" is not supported … skipping` lines; there are now zero for the
first time. Adding a nullable object property means an optional bare `$ref`,
never a union — the server may still send an explicit `null`, which an optional
property decodes to absent, so the wire is unaffected either way.
**Recorded in:** `openapi/gennety-v1.yaml` → both feedback responses.

## 2026-08-10 — the generator trap was documented and never fixed at the source

**Kind:** a document turned out to be wrong
**What:** `SerializedUser.gender`, `preference` and `language` were declared
`oneOf: [$ref, "null"]`, the shape swift-openapi-generator drops silently. All
three are now nullable scalars. The orphaned `Gender` / `GenderPreference`
schemas are deleted with them.
**Why this is worth recording rather than filing as a bug fix:** the comment on
`SerializedMatch.partnerGender` has named `SerializedUser.language` as the
victim of this trap since 2026-08-06. It was written while fixing a DIFFERENT
property, cited the original as a cautionary tale, and nobody went back for it.
Then `VenueIntentState.market` hit the same trap on 2026-08-05 and was fixed in
isolation too. So the trap has now been discovered three times, documented
twice, and the first instance survived both.
**What it changes going forward:** a `$ref`-to-enum inside a nullable union is
the one shape that fails **silently** — the spec lints clean, the server sends
the field, and the property simply is not in the generated Swift. So a comment
warning about it is not enough; the enums it referenced are deleted so nothing
can `$ref` them back into that shape. **When a trap is found, grep the whole
spec for it before closing the task** — that is what neither of the two earlier
fixes did.
**What it cost:** iOS could not read its own user's gender, preference or
language for the entire life of the client. The first of those blocked the
safety brief in 4.6, which is how it finally surfaced.
**Recorded in:** `openapi/gennety-v1.yaml` → `SerializedUser`.

## 2026-08-09 — post-date feedback: the missing half was discovery, not the endpoint

**Kind:** deviation from plan
**What:** the native rail is TWO endpoints, not one. `POST
/v1/me/feedback/post-date` was the obvious half; `GET /v1/me/feedback/pending`
is the half that makes the feature exist at all. Plus a third fix in
`date-lifecycle.ts`: the T+24h invitation now follows each side's own rail.
**Why:** I expected the usual shape of this bug — a mechanic that works and a
Mini App route an app user cannot sign. It was worse. `/v1/matches/current`
filters on `ACTIVE_MATCH_STATUSES`, which excludes `completed`, so the moment
the date closes out the match vanishes from every surface the client polls.
Shipping only the POST would have delivered a form with no way to reach it.
**What it changes going forward:** **`/v1/matches/current` is not a complete
view of a user's matches, and a client-side feature that needs a terminal match
needs its own endpoint.** This is the first one; anything post-date (a second
date, a rating history) inherits the same constraint.
**Recorded in:** PRODUCT_SPEC §Phase 4 → Post-date Feedback UX; ARCHITECTURE →
Admin/Public API table; `services/post-date-feedback.ts`.

## 2026-08-09 — `telegramId > 0` was still guarding the feedback invitation

**Kind:** deviation from plan
**What:** the T+24h feedback prompt filtered on `telegramId > 0n` and had no
push leg at all. It now uses `telegramReachable` / `pushReachable`
(`services/telegram-reach.ts`, extracted from `coordination.ts` so there is one
definition rather than two).
**Why:** this is the third worker found with the same guard — the Profiler and
re-engagement sweeps were fixed 2026-08-02, coordination on 2026-08-07, and
this one was missed each time because the audits went looking for *workers* and
this lives inside the date-lifecycle tick. The cost here is not a missed
notification: the form is the only place the product learns whether a date
worked, so an uninvited participant is a permanently missing answer, and the
absence looks exactly like someone declining to reply.
**What it changes going forward:** the predicate now lives in its own module
with a test that states WHY (`telegramReachable` rejects a real positive id on
an app-only account). **Any remaining `telegramId > 0` in a fan-out is a bug
until proven otherwise** — grep for it before adding a fourth notification.
**Recorded in:** `services/telegram-reach.ts` (+ its test), PRODUCT_SPEC
§Phase 4 → Post-date Feedback UX.

## 2026-08-09 — the Mini App feedback route was rewritten, not left alone

**Kind:** deviation from plan
**What:** `public/routes/feedback.ts` lost its own copies of the validation
rules, the five-language header table and the venue-fit write; it now calls the
shared service. That is a change to a working production surface that nobody
asked for.
**Why:** the alternative was two implementations of "what counts as an answer"
to the same question, and this form is the only place the product learns
whether a date worked — two implementations would quietly produce two training
sets. It is the same split `emergency-cancel.ts` and `proxy-chat.ts` already
made, and both of those were made *because* the second surface arrived.
**What it changes going forward:** the Mini App route keeps exactly four things
of its own — initData auth, resolving the caller by Telegram id, the Mini App
action trail, and the thank-you DM. Anything else added there belongs in the
service, or the drift starts again.
**Recorded in:** `services/post-date-feedback.ts` (header comment).

## 2026-08-09 — the pinned banner push extends to every stage transition, not only the venue change

**Kind:** founder decision
**What:** `refreshStatusBanners` is now called from five more places, all
sharing the exact same `services/status-banner-refresh.ts` helper the venue-
change fix added: `services/scheduled-confirmation.ts` (a match's first venue
assignment — the moment it becomes `scheduled` and the banner shows its FIRST
countdown + venue name at all), `handlers/matching/decision.ts` (every
successfully claimed accept/decline — mutual accept, a first decider's own
mode flip, and both cancel branches), `services/match-expiry.ts` (the 24h
reply-deadline TTL), and `services/emergency-cancel.ts` (cancelling a
scheduled date, shared by both the Telegram and native rails).
**Why:** the founder asked, after the venue-change fix, whether there were
other places with "the same bug" — and there were. The mechanism is identical
everywhere: `resolveBannerStage` derives the banner's mode from `Match` columns
a handler just wrote, and until this change only the once-a-minute
`status-timer` tick ever re-read them. Two of the five spots were not in the
original inventory I gave and were found only while reading the code: a FIRST
decider's own accept/decline already changes THEIR OWN banner stage
(`decided === true` → "planning", `decided === false` → the drop fallback)
**even though the match row stays `proposed`** — `claimMatchDecision` writes
only `acceptedBy*`, never `status`, so this is invisible to anyone who only
watches for a status transition. Both are the identical staleness bug in
miniature and cost nothing extra to close (`refreshStatusBanners` is
idempotent — a stage that hasn't actually changed is a signature-cache hit,
not a wasted edit), so they're fixed alongside the three the founder named.
**What it changes going forward:**
- **Two of these five call sites (`match-expiry.ts`, `emergency-cancel.ts`)
  have no `ctx.api`** — they're transport-agnostic services invoked from a
  cron tick or from either surface (Telegram + the native `/v1/matches/{id}/
  cancel` rail). They read the process-wide handle via
  `getMainBotApi()` (`services/main-bot-api.ts`), the same idiom already used
  by `founder-notify.ts` / `proxy-chat.ts` / `account-deletion.ts` for exactly
  this shape of problem — not a new pattern. Both null-check it and no-op
  before the bot has finished booting, same as those callers.
- **The mixed-cancel branch in `handleAccept` (peer already declined, actor
  now accepts) is pushed AFTER the `cancelled` transition, not right after
  `claimMatchDecision`.** Pushing earlier would have briefly rendered
  "planning" (the actor's own bare accept) for a match whose true, imminent
  outcome is `cancelled` — a new wrong state, smaller than the one being
  fixed but still wrong. The rule going forward: push against whatever the
  row will actually settle as, not against an intermediate write that a later
  statement in the same function is about to override.
- Do not add a sixth call site casually. If a future change writes to
  `Match.status`, `acceptedByA/B`, `agreedTime`, or `venueName` and the write
  is visible to the user on the same screen as the pinned banner, check
  whether `resolveBannerStage` reads that field before assuming the once-a-
  minute tick is good enough — it usually isn't, on the screen the user is
  actually looking at.
**Recorded in:** PRODUCT_SPEC.md §2.1; ARCHITECTURE.md → Cron & Workers
(`status-timer` row) and → `main-bot-api.ts`; deploy.md → the 2026-08-09 block.

---

## 2026-08-09 — daily Rematch: availability is decoupled from the offer, and D8 is dead

**Kind:** founder decision
**What:** the founder approved block A of the reworked daily-matching plan and
it is implemented. Rematch limits now follow the cadence profile; the `daily`
profile allows 7 runs per 7 days with a 1h blackout; and two PULL entries were
added — the pinned banner (silent-drops mode) and the concierge's
`open_screen: rematch`.
**Why the shape is what it is:** the ask was "let a user take a rematch every
day, after a failed match or on a silent evening, without breaking anything".
The obstacle was never the limits — it was that availability and offer were the
same thing, because the DM was the only surface. So "daily rematch" implied a
daily sales DM, which contradicts *"match daily, apologise weekly"* and is worse
than what that decision forbade: a daily reminder of failure with a price on it.
Splitting the two makes the frequency question disappear.
**What it changes going forward:**
- **D8 is not adopted and should not be revived.** "Turn Rematch off for the
  daily pilot" existed because the knobs could not follow the cadence. They can
  now. `REMATCH_FEATURE_ENABLED` stays a master switch, not a migration step.
- **A pull surface lands on the offer card, never the invoice**, and carries no
  price. The price belongs one tap later, before payment — the rule §3.8
  already applies to the Premium hub. Do not "simplify" the banner button into
  `rematch:buy`.
- **`rematchGiftCapMs` is an invariant, not a knob.** Every other rematch limit
  describes what the buyer may do; that one protects the woman he is buying his
  way to, and it must not loosen when his cap does. Both profiles hold 7 days
  and a test pins it.
- **`open_screen: rematch` is gated in code, not in the playbook.** The
  asymmetry it protects (a woman never learns the feature exists) is the
  product, and its refusal string must keep naming no feature — the tool result
  is fed to the model verbatim.
- **D4's "no menu row" still stands.** What it accidentally also forbade was
  *asking*; that is what these entries restore. A permanent menu row (A3.3) was
  explicitly left unbuilt.
**Deliberately not done:** A3.3, the conditional menu row — gated on the banner
proving insufficient, and it would reverse D4 properly rather than amend it.
**Recorded in:** PRODUCT_SPEC.md §2.1 mode 5 + §3.11, REMATCH_PRODUCT_SPEC.md
(Surfaces + the rewritten cadence note), DAILY_MATCHING_IMPLEMENTATION_PLAN.md
§3.1 block A.

---

## 2026-08-09 — the cadence rollback was not reversible, and a dry run proved it twice

**Kind:** deviation from plan
**What:** `scripts/normalize-standby-count.mjs` now exists (block C1). The plan
had listed it as a precondition of rolling `DROP_CADENCE` back since 2026-07-30
and nobody had written it.
**Why it matters more than a missing utility:** the whole migration is sold as
"one env var, reversible". It is not. `standbyCount` counts CYCLES, and the two
profiles are calibrated by moving `alpha` rather than the counter, so the
counter means different things in each. Flipping back without rescaling re-reads
every accumulated count at 7× its weight and pins the entire base at the
starvation cap — which does not inflate priority, it **deletes** it, because a
bonus identical for every starved user can no longer order them.
**What the dry run found, which is the part worth recording:** running it
read-only against production immediately proposed zeroing three healthy weekly
counters. The rescale is unconditional arithmetic with no idea what scale the
data is on, so running it in the wrong direction — or twice — destroys exactly
what it exists to protect. It now refuses unless `DROP_CADENCE` disagrees with
`--to`, i.e. **it must run BEFORE the env flip**, and that ordering is now the
script's own guard rather than a line in a runbook nobody reads at 2am.
**What it changes going forward:** any future counter whose meaning depends on
the cadence profile needs the same treatment — the danger is not the flip, it is
that the data outlives it. Dry run is the default and `--apply` is opt-in.
**Recorded in:** `scripts/normalize-standby-count.mjs`,
DAILY_MATCHING_IMPLEMENTATION_PLAN.md §3.1 block C1 and §6, `package.json`
(`pnpm cadence:normalize-standby`).

---

## 2026-08-09 — the daily-matching plan described shipped work as pending, and four cadence fields are dead

**Kind:** a document turned out to be wrong + deviation from plan
**What:** `DAILY_MATCHING_IMPLEMENTATION_PLAN.md` presented phases 0–6 as future
work; they shipped 2026-08-02. Rewritten with a status pass (§3.0), a real
remaining-work list (§3.1), and the measured pool. Two findings inside it are
worth carrying separately.
**Why it matters more than a stale doc usually would:** that file is what a new
session reads before touching cadence, and it was pointing at ~85% already-done
work while the genuinely undone part — Rematch — sat under a recommendation
(D8) that was never executed and never recorded here. So the one thing needing
attention was the one thing the plan treated as settled.
**The two findings:**
- **Four of five `DropCadence` rematch fields are dead.** `rematchBlackoutMs`,
  `rematchMaxPerInterval`, `rematchCooldownMs` and `rematchGiftCapMs` are
  declared, pinned by `cadence.test.ts:72-76`, and **read by nothing**; only
  `rematchWindowMs` is live. The abstraction therefore *looks* complete for
  Rematch and is not — anyone flipping `DROP_CADENCE=daily` would reasonably
  assume the limits move with it. They do not, and the `daily` values are
  identical to `weekly` anyway, so wiring them without retuning changes
  nothing either.
- **The `standbyCount` normalization script that §6 calls a precondition of
  rollback does not exist.** Without it, rolling the cadence back reads a
  daily-inflated count as weeks and pins every user at the starvation cap —
  i.e. the rollback that this whole migration calls "one env var" is currently
  not reversible in the way the doc claims.
**What it changes going forward:** D8 ("turn Rematch off during the pilot") is
**not** adopted — §3.1 block A proposes decoupling *availability* from *offer*
instead, so daily rematch costs no daily DM. That is a **proposal awaiting the
founder**, not a decision; it is recorded here only so the next session does
not re-derive it or silently execute D8. The `gift cap` (7 days, the woman's
protection) is called out as an invariant that must NOT scale with purchase
frequency.
**Recorded in:** `DAILY_MATCHING_IMPLEMENTATION_PLAN.md` §3.0/§3.1/§4/§6/§7.

---

## 2026-08-09 — synthetic test profiles, and the three calls that shaped them

**Kind:** founder decision
**What:** a set of hand-seeded profiles (`User.syntheticAt`) that the drop
batch offers to a real friends-and-family tester when the real pool leaves them
unpaired, and that always decline. Built to make a production test possible at
6 men / 1 woman in Kyiv, ahead of a later flip to `DROP_CADENCE=daily`.
**Why the three decisions matter more than the feature:**

- **The lifetime pair ban (§3.2 filter 6) is kept for synthetics too.** Offered
  the alternative — an exemption scoped to synthetic pairs, which would make 4
  profiles per gender last forever — the founder chose to leave the invariant
  alone. The price is arithmetic and should be stated before anyone shoots
  photographs: one profile is one showing per person, so `N` synthetic women
  cover `N` drops for each man (precisely, `N ≥ max(M, D)` for `M` men and `D`
  drops). Fourteen days of daily coverage is fourteen profiles, not four. The
  manifest and seeder are append-only and idempotent specifically because
  topping up is now a recurring operator task rather than a one-off.
- **Synthetics are never sold.** `buildCandidateSql` excludes them, so the paid
  Rematch honestly reports "nobody found" and refunds instead of charging
  150⭐ for a partner scripted to decline. This is not belt-and-braces given
  the commits it lands on: under `daily`, `rematchMaxPerInterval` is 7 and the
  banner entry (048d578) renders precisely in that cadence, so the exposure
  would have been up to seven paid bot-pitches a week. The
  post-cancellation Rematch **DM** is suppressed on a synthetic pair as well —
  selling consolation for a rejection the product staged is a different thing
  from offering a way forward after a real one.
- **Synthetics first on weekly; the daily flip is its own step**, with
  `normalize-standby-count.mjs` still its stated precondition.

**What it changes going forward:** three rules that are easy to break later.
**A synthetic match must leave no trace on the real user** — Elo, `standbyCount`,
`silentIgnoreCount` and the priority boost are all skipped, because a partner
that declines 100% of the time by construction produces a systematically false
signal, not a noisy one. **Declining is the safety mechanism, not a limitation**:
a mutual accept would open the §3.5b ticket gate and ask a real person for real
Stars. And **it therefore cannot test anything past `proposed`** — the ticket
gate, calendar, venue, date card, coordination and feedback stay on
`dev-e2e-full-flow.mjs`, which is worth re-reading before anyone concludes from
a green test week that those flows work.
**Recorded in:** PRODUCT_SPEC.md §3.1c, ARCHITECTURE.md → `users` / `matches` /
cron table, DEMO_MODE.md, deploy.md → the PENDING block at the top.

## 2026-08-09 — deviation: the contact rail is `phoneVerifiedAt` with no number

**Kind:** deviation from plan
**What:** the plan said synthetic profiles would take the **student** rail — a
`@gennety.test` email on a reserved TLD. They ship on the **general** rail
instead: `registrationTrack: "general"` plus `phoneVerifiedAt`, with `phone`
and `email` both NULL.
**Why:** `TRACK_VERIFIED_CONTACT_SQL`'s general branch tests the timestamp, not
the number, so no credential has to be invented at all — which is strictly
better than inventing one on a TLD that merely cannot collide. It is also what
`apps/bot/src/demo/partners.ts` already does, so the two seeders now agree
rather than each having a different theory of how to satisfy the gate.
**What it changes going forward:** **never give a synthetic profile a phone
number.** `User.phone` is `@unique`, so a fake value permanently blocks the
real person who one day owns it from registering — a failure that would surface
months later as an unexplained refusal during someone's sign-up.
**Recorded in:** `apps/bot/src/services/synthetic-profiles.ts` (header),
PRODUCT_SPEC.md §3.1c.

## 2026-08-09 — the Kyiv catalog is imported into production, and a file edit is not a shipped change

**Kind:** founder decision
**What:** `seed-venues:import --apply` was run against **both** the demo and the
production databases, lifting prod from 127 unique active Kyiv venues to 269.
This lands the whole 141-venue expansion, the tier moves (Cafe Marko →
`premium`, Très Branché → `base`, Win Bar and Японський Привіт → `premium`,
Сімона → `base`) and the park hours marks in one go. It supersedes the
2026-08-07 entry that deliberately stopped at the file.
**Why:** the founder went looking for Cafe Marko in the premium block and did
not find it. That was not a tier bug — it was the gap this journal had already
recorded and left open: the promotion existed only in `curated-venues.kyiv.*`,
demo had been imported before it, and prod had never seen the venue at all. A
catalog edit that nobody imports is indistinguishable from no edit, and the
distance between the two had grown to 142 venues and three tier decisions.
**What it changes going forward:** the "prod carries the pre-expansion catalog"
caveat in the 2026-08-07 entry is **dead** — do not repeat it. A backup of the
972 pre-import rows is at
`~/Desktop/gennety-backups/curated-venues-prod-2026-08-09T14-54-49-313Z.json`
(outside the repo, per the one-off-tooling rule). Note what the import does NOT
do: `active` is never written on an update, so a venue the nightly revalidation
deactivated stays deactivated — reactivation remains the cron's call on live
evidence, and an import can no longer resurrect a closed venue.
**Recorded in:** deploy.md → the 2026-08-09 block; PRODUCT_SPEC §3.7.

## 2026-08-09 — the botanical garden stays unassignable, and says so on the row

**Kind:** founder decision
**What:** five hourless Kyiv public spaces (Воздвиженка, Андріївський узвіз,
Оболонська набережна, Маріїнський парк, Міст закоханих) are marked
`hoursConfidence: "always_open"` and become auto-assignable. Ботанічний сад ім.
Фоміна is deliberately left at `unknown`, i.e. permanently unassignable until
someone supplies real hours — offered as a choice and taken explicitly.
**Why:** the other five are a street, an embankment, a bridge and two open
parks — there is no gate and no closing time, so the mark is a true statement.
The garden is gated and ticketed and genuinely closes; the slot grid runs to
19:30, which it clears in summer and does not in winter. The founder chose
correctness over one more venue. Worth recording because the same decision was
independently reached on 2026-07-30 (`4d02b90`) and the reasoning existed only
in a commit message — a later reviewer seeing five marked parks and one
unmarked would read it as an omission.
**What it changes going forward:** **do not mark the botanical garden
`always_open`.** The reason now rides on the row itself (`reviewNote`) and in
the manifest, so it survives a re-sync. The way to unblock it is real hours
(`operator_confirmed` plus a schedule), not a blanket carve-out. Same rule for
any future gated or ticketed outdoor venue.
**Recorded in:** `scripts/curated-venues.kyiv.expansion.json`, PRODUCT_SPEC §3.7.

## 2026-08-09 — the parks fix is data, not code, and the rule got a name

**Kind:** change of mind
**What:** I planned a carve-out in the V2 selector letting any `park` through
with unknown hours. Shipped instead: nothing in the gate changed, the operator
marks each venue, and the inline condition was extracted to an exported
`hoursEvidenceAdmits` with a test.
**Why:** a category-wide carve-out cannot express the botanical garden, which
is the one case that actually needed judgment — and the mechanism already
existed (`always_open` / `operator_confirmed` were read by the code and written
by nothing, so the escape hatch was designed for exactly this and never used).
The extraction is the more interesting half: the rule was two unnamed
conditions inside a 200-line function, which is *why* six parks could sit dead
for weeks. The catalog playbook told operators to mark parks; nothing connected
that instruction to the code enforcing it, and nothing failed when the mark was
missing.
**What it changes going forward:** three guards now exist where there were
none — `hoursEvidenceAdmits` is unit-tested (confirmed to fail when the
`always_open` branch is removed), `sync-venues:kyiv --check` fails when a
manifest mark did not survive into the catalog, and it warns about any venue
left with neither hours nor a mark. That warning found a second dead row on its
first run (see below). A future selector gate that can silently delete
inventory should get the same treatment: name it, test it, and make the catalog
tooling able to see it.
**Recorded in:** `apps/bot/src/services/venue-intent-v2.ts`,
`scripts/sync-kyiv-venue-catalog.mjs`, PRODUCT_SPEC §3.7, ARCHITECTURE →
`curated_venues`.

## 2026-08-09 — two Kyiv venues are in the catalog and can never be picked

**Kind:** not done
**What:** `Міст закоханих` and `GARAGE` are left as they are, and are recorded
here rather than fixed.
**Why:** neither is a policy problem, and both need an operator decision I
should not make. `Міст закоханих` carries rating 3.8 with **4** reviews for a
landmark that really has thousands — almost certainly a misresolved `placeId` —
and it fails `meetsVenueQualityFloor` on both counts; its manifest entry has
`allowQualityOverride: true`, which relaxes only the *sync-time* check and is
not read at runtime, so the row survives review and is never assignable.
`GARAGE` resolves to a Google record whose `primaryType` is `grocery_store`,
with no hours and no price level, listed as a `cafe`.
**What it changes going forward:** re-resolve both `placeId`s before touching
anything else. And there is a real product question underneath the first one:
`allowQualityOverride` looks like an operator override and is not one — either
the runtime should honour it or the manifest should stop offering it, because a
flag that silently means nothing is worse than no flag.
**Recorded in:** here only; the rows are unchanged.

## 2026-08-09 — the pinned banner is pushed on a venue change, not only polled

**Kind:** founder decision + deviation from plan
**What:** both venue-change settle paths now re-render the pinned status banner
immediately (`services/status-banner-refresh.ts`) instead of leaving it to the
once-a-minute `status-timer` tick. Scope was explicitly held to the venue change.
**Why the report was NOT what it looked like:** it came in as "the banner doesn't
update when we change the venue — only when you tap it". The banner was never
broken: it prints the venue, its dedup `signature` is the whole render, and the
tick does edit. What was missing is that the tick was its ONLY writer, so the pin
named the old place for **up to 60 seconds** while every other surface was
already correct. "It updates when you tap it" is a coincidence — the tap opens
the My Date hub (correct instantly) and the tick fires while you are in there.
Verified before writing code, so the fix targets the real gap: the deployed
`status-timer.ts` / `status-banner-view.ts` are byte-identical to HEAD (md5), and
both prod and demo logs show the worker alive and editing.
**What it changes going forward:** three bounds on the push, and they are what
keep this from becoming a second banner mechanism. It **only edits an existing
banner** — creation, pinning and the DB-compensation path stay the worker's, or
there would be two ways to create a pin. It **never records failures or clears
pointers** — recovery is the worker's, and a push that healed state would race
the module that owns it. And it **shares the render cache**, moved to
`services/status-banner.ts`, so a pushed render satisfies the next tick rather
than being re-sent; a test pins that, and it fails if the cache is un-shared.
`resolveBannerStage`/`loadBannerStages` moved to `services/status-banner-stage.ts`
because a service must not import from a worker.
**Deliberately not done:** the same ≤60s lag exists on every other banner
transition (a date locking in, a decision landing). Founder chose venue-change
only; the helper takes a user-id list, so wiring another call site is one line.
Do not read the lag elsewhere as a separate bug — it is this decision.
**One thing the tests caught, worth keeping:** the "cannot throw" guarantee lived
inside the refresh module and the settle path simply trusted it. A test that
forced a rejection failed, because a settled, irreversible change was depending
on a remote module's internals staying polite. Both call sites now carry their
own `.catch`. **A cosmetic re-render attached to an irreversible step defends
itself at the call site**, not only at the definition.
**Recorded in:** PRODUCT_SPEC.md §2.1 + §3.7b; ARCHITECTURE.md → Cron & Workers
(`status-timer` row).

---

## 2026-08-09 — the venue board holds slots for walking spots, and it is parks only

**Kind:** founder decision
**What:** `capCatalog` reserves `VENUE_CHANGE_WALK_RESERVED` (3) of the venue
board's twelve slots for the nearest outdoor walking spots (`park`). The founder
reported that the change-venue board is almost always cafés and restaurants.
**Why the reservation and not a wider radius, which is what I would have guessed:**
measured against the live Kyiv catalog before writing anything — the median board
centre already has **ten** parks inside the existing 3 km radius, and 88% have at
least three. They were never out of reach. Proximity ordering is simply a race a
promenade cannot win: it is one venue along a kilometre of riverfront against
thirty café doors on one street. So the fix is which cards make the cut, and the
radius stays exactly where it is (5 km would rescue 3 of the 8 park-less centres
— a second knob for almost nothing). Effect: 62% → 93% of boards carry at least
one, 0.98 → 2.79 cards, board size unchanged.
**What the founder explicitly ruled OUT, which is the more useful half:** I had
offered unblocking `museum` on the board as the way to add "art locations", with
14 already sitting in the Kyiv base. **Rejected.** The want is places that need
no planning — no tickets, no opening slot, no booking — that work as a meeting
point and have somewhere to walk around them. A museum is a *plan*, not a
meeting spot. So `EXCLUDED_VENUE_CATEGORIES` stands for both surfaces, and the
2026-07-31 museum decision is reaffirmed rather than narrowed.
**What it changes going forward:** `isWalkingSpot` is the seam, and today it is
`category === "park"` and must stay that narrow — the curated base already files
embankments, descents and viewpoints as `park`, so widening the predicate is not
how you add more of them; **seeding more `park` rows is.** Two consequences worth
holding onto. The rule is a **floor, not a cap**, so a park-dense district still
shows more than three and nothing needs raising for that case. And the pending
Kyiv catalog expansion (267 venues in the file vs 127 in prod) adds **95
restaurants, 84 cafés and zero parks** — importing it as-is would dilute the
outdoor share from 19% to 8%, i.e. work directly against this decision. Do not
import it without seeding walking spots in the same pass.
**Recorded in:** PRODUCT_SPEC.md §3.7b → "The board is never a wall of tables";
`services/venue-change.ts` (`VENUE_CHANGE_WALK_RESERVED`, `isWalkingSpot`).

---

## 2026-08-09 — the venue can be changed twice, and a lapse reopens the board

**Kind:** founder decision
**What:** the §3.7b board stops closing for good on the first settled change.
Up to `VENUE_CHANGE_MAX_PER_DATE` (2) changes may settle per date, each a
separate purchase at the full price; a `lapsed` session restarts on the same
terms and spends no allowance.
**Why:** the founder asked why a second change was technically impossible.
"One settled change per date" was a real rule, but it made "we picked, then we
reconsidered" — an ordinary thing for a couple to do — unreachable. Two things
settled the shape. The product **already** had a second attempt on one path out
of three: the male's "not this time" sets `venueChangeStatus` back to null
outright, so the board reopens after his decline. Leaving `lapsed` terminal
next to that was an accident of where the reset happened to be written, not a
decision. And the cap has to exist because the price does not bound everyone:
a Premium pair settles free, and so does every demo visitor.
**What it changes going forward:**
- **A restart is a session RESET, never a reopened flag.** The `venueChange*`
  columns are one slot, not a history. The reset rides in the SAME CAS as the
  new round's first like, and it must clear **both** `venueLikes*` — clearing
  only the restarter's side lets round one's peer hearts "overlap" into an
  agreement nobody is currently making. That is the regression test in
  `venue-change.test.ts`, and it was confirmed red before being confirmed green.
  `venueChangePaidAt` is in the reset for a less obvious reason:
  `venueChangeSideWaiting` reads it as "settled, nothing to wait for", so
  leaving it would keep the §3.6b shimmer dead for the whole round.
- **Do not widen `evaluateVenueBoardEligibility` to allow this.** Eight call
  sites read it, and four of them (keep-original, offer-pay, confirm-overlap,
  pay-decline) would then run against a finished session's stale columns —
  keep-original would resurrect a `liking` state out of dead likes. The restart
  is a **second predicate** (`evaluateVenueChangeRestart`) asked only by the
  four entry points that perform the reset. A test pins keep-original still
  refusing a settled session.
- **The cap is `Match.venueChangeCount`, not a count of
  `venue_change_purchases`.** A free (Premium / demo) settle writes no purchase
  row, so deriving it would uncap exactly the cohorts money does not bound.
- **The offer is quiet and is not on the settle DM.** It is a tertiary text
  link on the success screen; the durable entry point is the My Date hub.
  Putting a "change again" button on the card that confirms the payment would
  be selling the next change seconds after taking money for this one.
**Recorded in:** PRODUCT_SPEC.md §3.7b, ARCHITECTURE.md → `matches`,
VENUE_CHANGE_PRODUCT_SPEC.md §§1/4.5/6, DEMO_MODE.md;
`services/venue-change.ts` (`evaluateVenueChangeRestart`,
`venueChangeSessionReset`).

---

## 2026-08-09 — a provider 400 was being served as an empty success, and no test built the payload

**Kind:** deviation from plan
**What:** the departure-point search in the Location Mini App returned nothing
for every user in a launched market, for four days. `/v1/location/search` sent
Places `locationRestriction: { circle }`, which `searchText` does not accept —
it takes a circle only for `locationBias`. Fixed by sending the market as a
rectangle and letting the existing per-result `checkDepartureOrigin` pass cut
the corners back to the circle.
**Why it is worth an entry rather than a commit message:** the mechanical bug is
one word; the two things that let it live are general.
- **A caught provider error was returned as a successful empty result.** The
  catch answers `200 {ok:true, results:[]}`, which is right for "Places found
  nothing" and wrong for "Places refused our request" — on screen they are the
  same blank dropdown. The one `console.warn` it does emit had **zero**
  occurrences in either log, which I first read as evidence the path was fine;
  it was evidence the path had never been executed, because production has had
  0 dates ever and nobody had reached the venue step. A failure that has never
  run looks exactly like a failure that does not exist.
- **The payload itself was untested.** All four existing `/search` tests exit
  before the request is built (401, short query, long query, no-API-key stub),
  so nothing in the suite had ever looked at what we send Google. The guard
  test added here was confirmed to FAIL against the old code before being
  confirmed green against the new.
**What it changes going forward:** when a call site translates a provider error
into a valid-looking empty result, the log line is the only signal, so treat an
*absent* log line as unknown rather than as healthy — check whether the path
has ever run. And a request body assembled for a third-party API needs a test
that asserts the body; mocking the transport and asserting only the response
leaves the exact shape that broke here uncovered. Two related notes:
`searchNearby` in `services/venue.ts` genuinely requires a circle and is
untouched — the two endpoints disagree, so neither is the model for the other.
And `checkDepartureOrigin` over the results is now load-bearing rather than
defensive: the rectangle over-includes at the corners by construction, and that
filter is what keeps search and the circular write gate from disagreeing.
**Recorded in:** PRODUCT_SPEC.md §3.7 → "Search cannot offer one either";
`apps/bot/src/public/routes/location.ts` (`marketBoundingBox`).

---

## 2026-08-08 — the calendar's time list opens at the evening, not the afternoon

**Kind:** founder decision
**What:** tapping a date in the Calendar Mini App now opens the slot sheet
scrolled to the LAST slot (19:30) instead of the first (13:00).
**Why:** the founder's reasoning, and it is worth recording because it is two
arguments rather than one. The obvious half is frequency — a first date is
planned for the evening far more often than for mid-afternoon, so the common
answer should need no scroll. The half that is easy to lose is the
*affordance*: opening at 13:00 puts a full row flush against the top edge,
which reads as the list simply starting there, and nothing else on that screen
says it scrolls; opening at the bottom leaves a row cut in half at the top
edge, which is the only thing telling the user an earlier time exists at all.
**What it changes going forward:** `openSheet()` is the single owner of the
opening scroll position — every path that makes the sheet visible funnels
through it. A poll-driven rebuild deliberately **preserves** the user's scroll
instead of re-anchoring, so do not "fix" that into consistency: the rule is
about where a fresh open lands, not about overriding where someone scrolled
to. If the slot grid ever gains a morning band, re-open this decision — the
argument is about the evening being the likely answer, not about the bottom of
a list being a good default in general.
**Recorded in:** PRODUCT_SPEC.md §3.6 → "The time list opens at the LATEST
slot"; `apps/webapp/src/main.ts` (`anchorSheetToLatest`).

---

## 2026-08-08 — a translucent button is not a scrim, and the fade was on the wrong side of it

**Kind:** deviation from plan
**What:** reported as "the Close button overlaps some other button" on the ticket
gate's waiting screen. There is no second button — the countdown line was being
read *through* Close. The floating action bar (shipped hours earlier) ran one
gradient across its whole box, solid at the bottom and fading over the top 72px,
while the buttons start 16px below that top; so the first button sat almost
entirely in the transparent end of its own scrim. `.btn-secondary` is `--fill`,
**6% white**. The bar's background is now plain `--bg` and the ramp is a
`::before` above it.
**Why it is worth an entry rather than a CSS tweak:** the bug is invisible on
every screen whose bottom content is a picture, and it is a *property of the
pattern*, not of this screen — anything that ever scrolls under the first button
is legible through it. The doc-comment claiming "the gradient only keeps the text
they sit over from showing through them" described an intent the geometry never
delivered.
**What it changes going forward:** the ramp must stay OUT of the bar's box.
`--bar-space` is `offsetHeight`, so folding the fade into padding would reserve
72px of dead strip at the end of every short list — which is the exact failure
`action-bar.ts` exists to prevent. Do not "simplify" the `::before` back into the
bar's own background. `.vc-bar` (venue board) is untouched and still uses a
percentage; the two are deliberately different and neither is the model for the
other.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The action bar floats";
`apps/webapp/src/ticket/ticket.css`.

## 2026-08-08 — the gate's countdown named nobody, in half-English units

**Kind:** deviation from plan
**What:** «Осталось 23h 59m». Two independent defects in one line, both found
from the founder asking what the timer was *for* and *for whom*. The English
string has always been "They have {time} left"; the four translations had been
cut to a bare "Осталось {time}" in the course of a 2026-07 change making them
gender-neutral — the subject was removed rather than de-gendered. And
`formatCountdown` baked `h`/`m` into the formatter, so every non-English locale
rendered English unit letters in the middle of its own sentence. Units are now
`{n}`-templates per locale; the line names the partner with the same role noun
`waitingSub` already uses.
**Why it survived:** the line reads fine in English, which is the locale anyone
reviewing the code reads. Nothing in the product renders a number inside a
translated sentence anywhere else, so there was no precedent to copy and no test
that could have caught it.
**What it changes going forward:** a `{time}` / `{n}` placeholder inside a
translated string needs its UNITS translated too, not just the frame. Two tests
hold it: `waitingTimer` must be longer than the placeholder plus a word (a bare
«Осталось {time}» fails), and every unit string must carry `{n}`.
**Recorded in:** PRODUCT_SPEC.md §3.5b; `apps/webapp/src/ticket/i18n.ts` (the
TRANSLATOR NOTE on `waitingTimer`), `ticket-state.ts` `CountdownUnits`.

## 2026-08-08 — "Close" is not an action, and it had the loud rung

**Kind:** founder decision
**What:** on the gate's waiting screen, **Закрыть** held the full-width glass
button and "Всё-таки оплатить за пару" — the only thing on the screen that does
anything — was a 14px grey text link beneath it. Swapped: the cover offer takes
the button, Close drops to text.
**Why:** the same inversion §3.5b already corrected once, on the cover screen
directly upstream of this one ("the only alternative was a 14px ghost text link
under a shimmering burgundy button"). It recurred here because the reconsider
link was written as *deliberately quiet* — "he already said no once, so this
reopens the door without pushing him through it" — which is right about tone and
wrong about rank. Close additionally duplicates Telegram's own ✕, sitting in the
chrome a few pixels above it.
**What it changes going forward:** "exactly one loud button per screen" is about
which ACTION is loudest, not about giving the loud shape to whatever is left. A
screen whose only offer is a way back still gives that way back the rung; Close
keeps it only when it is genuinely alone (a woman, or a man whose partner already
settled).
**Recorded in:** PRODUCT_SPEC.md §3.5b; `apps/webapp/src/ticket/App.tsx`.

## 2026-08-08 — the claim rule was fixed on one side of the router and not the other

**Kind:** deviation from plan
**What:** found by a full-codebase audit, not by a report. `services/match-flow-claim.ts`
(2026-08-03) bounded the three MATCH flows that read the next plain message as
their answer. The identical shape existed one router over and was left
unbounded: five `menuState` values consume plain text and nothing ever released
them except the user happening to tap a button. Fixed with the menu twin,
`services/menu-text-claim.ts`.
**Why it matters more than the other four:** `edit_bio` writes its message
verbatim into `Profile.psychologicalSummary` — the dominant embedding input
(`V_explicit`, 0.65). The state lives in `bot_sessions`, so a user who tapped
**About me** and walked away had their next message, on any topic and any number
of days later, replace their whole profile analysis with no snapshot to restore
from — and lose the answer to the question they actually asked. Reproduced as a
failing test before the fix: the router called `prisma.profile.update` on a
three-week-stale claim.
**What it changes going forward:** **a session field that captures free text is
not finished until it carries a deadline.** The rule now exists twice, once per
router, and a sixth text-capturing `menuState` must be added to `CLAIMABLE` or
it inherits the bug. Expiring is deliberately a soft failure — the message falls
to the concierge, which can hand the editor back — so when in doubt the window
goes shorter, not longer. Media states (`edit_photos`, `edit_video`) are
deliberately out of scope: a stray photo lands in a gallery the user can see and
delete.
**One thing I decided NOT to do, and it is the more interesting half:** the
obvious second fix was to copy the agent's collapse guard
(`SUBSTANTIAL_BIO_LENGTH` / `BIO_SHRINK_LIMIT`) into the menu editor, since the
same wipe is reachable there unguarded. That is wrong. The agent's guard exists
precisely to route the decision INTO the editor — its refusal text says the act
"belongs in the editor where the user can read what they are replacing first" —
so guarding the editor too would leave no way to shorten a bio anywhere in the
product, a dead end in place of a data-loss bug. What was actually broken is
that the editor never showed that text, so the guard's promise was false and its
escape hatch led somewhere blind. The editor shows it now; the asymmetry stays,
on purpose.
**Recorded in:** PRODUCT_SPEC.md §2.1, `services/menu-text-claim.ts`,
`SessionData.menuClaimUntil`.

## 2026-08-08 — "best-effort" is not "one attempt", and a silent 502 is a bug of its own

**Kind:** deviation from plan + a document turned out to be wrong
**What:** reported as a demo bug — no photos anywhere on the venue-change board.
It is not demo-specific: same code (md5-identical), same Places key
(md5-identical), same droplet. Fixed in shared code — the proxy now retries a
transient upstream failure inside its existing 10s budget, the client retries
once, and every failure is logged.
**Why it matters more than the symptom:** two separate defects, and the second
is the reason the first was so hard to see.
- **The retry.** Measured on the droplet: intermittent `ETIMEDOUT` on the TCP
  connect to Google's photo CDN, ~1 request in 10 under a parallel burst,
  reproduced in **production** with the prod bot token. The board opens ~13
  tiles at once and the client's `onerror` was terminal (`settled = true`, swap
  in the category glyph, never ask again), so one blip meant permanently blank
  tiles until the Mini App was closed and reopened. `PLACES_API_KEY`, the Place
  Details lookups, the catalog and the bundle were all verified healthy — 85/85
  and then 72/72 parallel requests returned real JPEGs while I was testing.
- **The silence.** `!upstream.ok` and a non-image content-type answered 502 with
  **no log line at all**; only the `catch` logged. So a systematic upstream
  problem — a quota, a revoked key, a 429 storm — was indistinguishable from
  "photos just don't work". PRODUCT_SPEC's "best-effort" was being read as
  license for that; it is not, and it now says so.
**What it changes going forward:** on this path, **best-effort means retried and
logged, never silent**. Retry classification is explicit and must stay that way:
transient = thrown fetch / 5xx / 429 / 408; permanent = 4xx, non-image body,
over-ceiling file. The body read is deliberately classified separately from the
network error rather than sharing one `catch` — before this, an oversized image
threw into the same place a connect timeout did, so a retry loop would have
re-downloaded it. On the client, the retry paints the URL that actually decoded,
not the one it started from; painting the original would re-request the bytes
that just failed and hand the tile one more chance to break.
**Deliberately not done:** `fetchPlacePhotoNames` (Place Details) got no retry.
Zero failures in either log since the feature shipped, the host measured healthy
(0.13s), and its failures are **already logged** — so unlike the proxy it has no
blind spot. Its blast radius is worse (a failed lookup is cached empty for 5
minutes, costing one venue all six photos for everyone), so if evidence ever
appears, that is the next place to look.
**Also worth recording:** I could not reproduce the total blackout the founder
saw — at test time every request succeeded. The fix addresses a measured,
reproducible defect on the same path; it is not confirmed to be the whole of
what they experienced.
**Recorded in:** PRODUCT_SPEC.md §3.7b, ARCHITECTURE.md → `/v1/venue-change/photo`,
`apps/bot/src/public/routes/venue-change.ts`, `apps/webapp/src/photo-retry.ts`.

## 2026-08-08 — the ticket's barcode is replaced by the field it never had

**Kind:** founder decision
**What:** the stub's barcode is deleted and the stub prints `БАЛАНС ▸ 🎟 × N`
instead — a field name on the left, the wallet count on the right.
**Why:** the founder's reasoning, and it is the right one to record rather than
the visual: the barcode "носит только визуальную функцию", while the number
beside it was never explained, so the swap makes the same space functional. It
is not a loss of ticket-ness either — a printed field is at least as much a
ticket idiom as a barcode, and the perforation and real notch cutouts carry
that job anyway.
**What it changes going forward:** the card's `seed` prop and its stripe
generator are gone; nothing on the card is derived from the match id any more,
so do not reintroduce "a pair's own stripes". The stub's `min-height` is
load-bearing rather than spacing — a blank stub (the gate past the offer
screen) must keep the tear line where a printed one puts it, or the fixed
268 × 392 silhouette starts drifting per screen again. And `balanceLabel` is
**one word**, capped and space-free by a test: it shares a 220px line with the
count at 0.16em tracking, and a wrapped field name reads as a rendering fault.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The barcode is gone";
`apps/webapp/src/ticket/{Ticket3D.tsx,ticket.css,i18n.ts}`.

## 2026-08-08 — a pinned action bar is an island, and its fade is a length

**Kind:** founder decision
**What:** both ticket screens' bottom buttons stop being a welded footer. The
bar floats over the scroll and content dissolves under it through a scrim,
copying the venue board's CTA — which the founder named as the reference and
explicitly ruled out of scope for changes.
**Why:** in the flex flow the scroll ended at the bar's top edge, so content was
cut against a hard horizontal line belonging to no object on screen — a panel
edge in a system whose stated rule is depth from fills, inset light and shadow,
never outlines. Worth an entry for the two choices that diverge from `.vc-bar`
rather than for the copy itself: the fade is a fixed **72px** instead of that
bar's percentage, because this bar's height varies with the number of buttons
and with label wrapping, and a percentage hands the *shortest* bar the harshest
edge; and the scroll reserves the bar's **measured** height rather than a
constant, because a constant is either too small (content hidden behind the
buttons) or too large (a dead strip at the end of a short list), and which one
depends on the locale.
**What it changes going forward:** adding a button to either bar needs no
padding change — that is the point of measuring. Do not "simplify"
`action-bar.ts` back into a constant, and do not convert the 72px into a
percentage for consistency with `.vc-bar`; the two bars differ in exactly the
property that makes a percentage safe there. The venue board itself stays as it
is (founder scope call).
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The action bar floats";
`apps/webapp/src/ticket/{action-bar.ts,ticket.css}`.

## 2026-08-08 — on the dark theme the store's ordinary rows carry no light at all

**Kind:** founder decision
**What:** the two glass bundle rows lose the inner-edge sheen on dark and are
lifted by tint instead (a step lighter than the near-black page, plus the
shadow underneath). The sheen survives on the recommended row, on the one-time
famine row, and on both of them plus the ordinary rows on the light theme.
**Why:** the founder's words were "сделать их чёрными… а чуть более светлыми…
за счёт этого оттенок выделит их" — and the reason it is worth an entry rather
than a commit message is what it does to the rule above it. Light was being
worn by every row, which makes it a finish; spent on two rows, it is a signal,
and it now says the same kind of thing colour already says under "colour =
meaning". On cream the sheen has to stay: there it is a shading inward, and a
white row on a white page has no edge without it.
**What it changes going forward:** the house sheen is no longer "every
interactive surface gets it". On a dark surface, ask what it is distinguishing;
if the answer is nothing, tint and elevation are the correct tools. The famine
row is deliberately exempt — its rose temperature IS its meaning — so a future
pass must not fold it in with the ordinary rows for tidiness.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "One light, everywhere";
`apps/webapp/src/tickets/store.css`.

## 2026-08-08 — the recommended row's edge light diverges from `.btn-hero`, on purpose

**Kind:** change of mind
**What:** the burgundy row drops the white 90° wash layer from its fill, cuts
the horizontal half of its inset sheen to a whisper on dark, and carries **no**
inner light at all on light. Hours earlier the same day I had written that it
was "exactly `.btn-hero`'s shadow list and nothing else", and treated that
identity as the thing to protect.
**Why:** the identity was protecting the wrong property. The hero button is
centred text on empty fill, so light hugging its sides lands on nothing. This
row has a 52px count emblem hard against the left inset — inside the first ~19%
of the width — so the same light lands on the one number the row is selling,
and the founder read it exactly that way ("засвечивает циферку шесть"). On
cream the rim had a second failure mode: white held just inside a burgundy
button does not read as light from the edge, it reads as a frame drawn around
the fill.
**What it changes going forward:** two components that look alike are not
automatically one component. Before copying a shadow list between surfaces,
check what sits under the light — an edge treatment is safe over fill and is
not safe over content. `.btn-hero` itself is unchanged and keeps the full
recipe; the two are never on screen together (store vs gate).
**Recorded in:** PRODUCT_SPEC.md §3.5b; `apps/webapp/src/tickets/store.css`.

## 2026-08-08 — the recommended bundle gets its burgundy fill back, in both themes

**Kind:** founder decision
**What:** `.store-bundle-best` becomes a filled burgundy button carrying white
inner-edge light — literally `.btn-hero`'s recipe — reversing the decision made
a few hours earlier the same day, which stripped the fill and left burgundy
light on glass.
**Why:** that earlier reasoning ("a colour plus a light temperature says 'this
one' twice") was derived on the dark theme, where it holds, and it failed on
cream: burgundy light shading inward on a white card is a smudge rather than an
emphasis, so the best offer on the screen rendered as the weakest row. The
founder described the fix precisely — burgundy button, white light, white
elements inside — which is the recipe that already exists as `--sheen-on-accent`.
**What it changes going forward:** the "exactly one loud button per screen" rule
is intact but now needs stating for this screen: the store HAS no hero button
(its action bar appears only after a purchase), so the recommended bundle is it.
Applied in **both** themes on purpose — a rung that is a filled button on one
theme and a glass row on the other is two components, and every later edit would
have to be checked twice. The row's shadow list must stay byte-identical to
`.btn-hero`'s: an outer burgundy glow was tried here for separation from the two
rows above and dropped, because it haloed the row and re-created the washed look
this change exists to remove.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "One light, everywhere";
`apps/webapp/src/tickets/store.css`.

## 2026-08-08 — the ticket's specular highlight is deleted, not tuned a third time

**Kind:** change of mind
**What:** `.ticket-glare` and the `--gp` rotation binding are removed outright.
Earlier the same day the highlight went from a soft radial blob to a narrow
raking band; the founder's verdict on the band was that it still reads wrong, so
the element is gone rather than retuned.
**Why:** worth an entry because the failure is structural, not parametric, and
the next person will otherwise try a fourth version. A highlight is a reflection
OF something. This card sits on a flat page with no light source, so whatever we
draw is a guess about a lamp that does not exist, and the eye reads a wrong
guess as paint on the surface. Two rounds of tuning (size, angle, alpha, rest
position) each produced a different wrong guess.
**What it changes going forward:** **do not reintroduce a drawn highlight on the
ticket.** The holographic film stays, at 0.22, because foil is a real property
of the stock and can shift with the angle honestly — that is the distinction to
apply to any future surface effect here. The drag / gyro / inertia interaction
is untouched; the card still turns.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The ticket card, and what it may
print"; `apps/webapp/src/ticket/ticket.css`, `Ticket3D.tsx`.

## 2026-08-08 — a decline reason blocked the next match, and ARCHITECTURE had been describing the fix for months

**Kind:** deviation from plan + a document turned out to be wrong
**What:** a demo bug report ("I pressed «show me the profile again» and nothing
came") was fixed in **production** code: `appendNegativeConstraint` now attempts
the immediate user-scoped embedding refresh that every other embedding-feeding
writer already did. Only two of the three fixes are demo-scoped.
**Why:** the demo was the messenger, not the defect. `embeddingDirty` is not a
scheduling hint — `findCandidatesFor` fail-closes on the **seeker's own** flag —
so recording a decline reason withheld that user from matching for up to five
minutes. And ARCHITECTURE.md had said *"embedding-feeding edits mark the profile
dirty and attempt a 30-second user-scoped refresh"* since M-2 shipped, which was
true of bio and partner-preferences and false of this one writer. The production
consequence is not theoretical: the paid Rematch offer (§3.11) is sent on the
decline path, so a man who explained his pass and bought a re-run inside the
window was told the engine found nobody — and refunded — when it had refused to
look. `REMATCH_FEATURE_ENABLED` has been on since 2026-07-27.
**What it changes going forward:** **marking `embeddingDirty` without attempting
a refresh is now a bug, not a style choice** — the flag removes a user from
matching, so whoever sets it owes the attempt. The one exception is explicit and
typed (`{ refreshEmbedding: false }`), for a caller appending several
constraints in a row; it must refresh once at the end. Also, per the 2026-08-07
entry: a demo-mode report is not automatically a demo-mode fix — check whether
the path is shared before scoping.
**Recorded in:** PRODUCT_SPEC.md → Embedding freshness (M-2); DEMO_MODE.md →
Recovery; `handlers/matching/negative-constraints.ts`.

## 2026-08-08 — a demo button keeps its button until it has something to show

**Kind:** change of mind
**What:** the redo tap no longer retires its own keyboard up front. It retires
it only once a profile has actually been dispatched; a refusal answers
immediately and leaves the button live.
**Why:** retiring first was deliberate — double-tap protection — and it is what
turned a recoverable refusal into a dead end: no button, no message, `/restart`
or nothing. The protection was worth keeping and belonged somewhere else, so it
moved to the driver's existing single-flight guard, which additionally fixes a
race the old code had (a tick can decide `pitch` the instant the tap clears the
finished row, and both would have run).
**What it changes going forward:** the general rule for a demo affordance is
that **the state a button describes is what may retire it, never the tap
itself** — the same reason production's ticket card is never edited. And a
handler that calls into the driver must consume the outcome: `performAction`
returns one precisely so a refusal cannot be dropped, and the button path was
the one caller still throwing it away.
**Recorded in:** DEMO_MODE.md → Recovery; `demo/commands.ts`, `demo/driver.ts`.

## 2026-08-08 — demo shared production's JWT secret, and nothing could have caught it

**Kind:** deviation from plan
**What:** `/opt/gennety-demo/.env` carried production's `JWT_SECRET` verbatim.
Both deployments therefore signed and accepted the same `/v1/*` access tokens —
same secret, same hardcoded `issuer`/`audience`, and `requireAuth`
(`auth-middleware.ts`) verifies a signature and never looks the user up. Rotated
to a demo-owned value; a divergence gate now runs in `deploy-demo.sh`.
**Why it happened, which is the reusable part:** the demo env is assembled by
hand as production's `.env` plus the overrides in `.env.demo`, so **every key
`.env.demo` forgets is silently inherited**. That same mechanism leaked
`SUPABASE_URL` on day one; it was caught and fixed, and the *class* was not.
`assertDemoIsolation()` cannot close it — from inside the demo process
production's values are unknowable, which is exactly why that function is
limited to settings wrong on their face (founder notifications, Stars, an admin
key).
**What it changes going forward:** the check belongs in `deploy-demo.sh`,
the only vantage point where both `.env` files are readable at once, and it runs
**before** the rsync so a violation costs nothing. Adding a secret to the demo
deployment now means adding it to `MUST_DIFFER`/`MUST_BE_ABSENT` there. Do not
try to move this into the process — it cannot work there.
**Recorded in:** `scripts/deploy-demo.sh` (isolation gate), DEMO_MODE.md → The
isolation invariant, deploy.md → the PENDING block at the top.

## 2026-08-08 — the demo could send real SMS on production's Twilio account

**Kind:** deviation from plan
**What:** `services/phone-verification.ts` had no dev/demo short-circuit at all,
while `/v1/auth/phone` is mounted unconditionally and `PHONE_AUTH_ENABLED` is on
in demo. A code requested against `demo-api.gennety.com` went to Twilio on
production's credentials. Fixed with a console rail gated on
`OTP_LOG_TO_CONSOLE`, mirroring `email.ts`.
**Why that gate and not `DEMO_MODE_ENABLED`:** the flag cannot be set in a
production-like runtime — `identityTrustConfigurationErrors` refuses to boot with
it on — so it already means "this is not production", and it covers **local dev
too**, which inherits the same `TWILIO_*` keys from `.env`. Gating on the demo
flag would have fixed one of the two deployments that had the problem.
**What it changes going forward:** the shared-third-party-credential decision in
DEMO_MODE.md ("stateless, spend is negligible") is sound for OpenAI/AWS/Places
but was never true of the two rails that **send things to strangers** — Twilio
and Resend. Resend was already handled. Any future outbound-messaging provider
needs the same short-circuit before it ships, not after an audit.
**Recorded in:** `phone-verification.ts` (console rail + its test),
ARCHITECTURE.md → `phone_otps`, DEMO_MODE.md → guarded branches.

## 2026-08-08 — giving up in the demo is a pause, not a retirement

**Kind:** change of mind
**What:** `failure-tracker.ts` abandoned an action permanently; it now releases
one probe after a cooldown. Plus a belt-and-braces guard: `ensureFreshEmbeddings`
rebuilds a stale vector before the demo pitches.
**Why:** the tracker shipped 2026-08-07 to stop a 1500-line refusal flood, and it
was right about that. What it could not distinguish is a *self-healing* refusal —
and it turned one into a dead demo, observed live: a ready visitor, zero matches,
`giving up on pitch`.
**Relationship to the decline-reason entry above, because they were found the
same day from the same symptom:** that one is the real fix and it is in
**production** code — `appendNegativeConstraint` now refreshes, so the specific
race is gone at the source. This entry is about what the *demo* did when a
refusal happened at all. The two are complementary rather than duplicated, and
that commit makes this one MORE necessary, not less: it routes the redo button's
refusals into the same ladder, so more things can now reach a ceiling that used
to be permanent.
**What it changes going forward:** the ceiling must never mean "never again". A
failed probe pushes the deadline out and cannot re-announce (the driver announces
only where the streak first equals the ceiling), so the flood stays shut without
the demo being able to die. `ensureFreshEmbeddings` is deliberately kept even
though the known writer now refreshes: it costs nothing when the vector is clean,
and not every path that dirties the flag refreshes it (a finalize whose initial
embedding failed leaves it dirty by design). It sits beside `releaseMatchCooldown`
because it is the same shape — a production precondition a fifteen-minute demo
must not be held by. It is a guard, **not** the fix for the decline race; do not
read it as one.
**Recorded in:** `demo/failure-tracker.ts`, `demo/partners.ts`
(`ensureFreshEmbeddings`), DEMO_MODE.md → A refused move is reported.

## 2026-08-08 — the referral cross-promo is a chip, and it never sits in an action bar

**Kind:** founder decision
**What:** the "invite a friend instead" link on all five paying surfaces becomes
one shared 30px chip (`apps/webapp/src/referral-hint.ts`) with one ≤31-character
statement per language — «Пригласи друга вместо оплаты» in RU — replacing five
hand-copied full-width rows of sentence-length text. On Premium it also moves
out of the pinned footer into the tail of the scroll.
**Why:** the founder reported it as "смещает кнопку сильно выше… визуально
нагромождённый". The audit found three separable causes rather than one taste
problem, and the measurements are what picked the fix: Premium was the only
surface where the hint sat in the action zone, which is `flex: none`, so it grew
that footer ~39px and moved the CTA; the copy ran 59 characters ≈ 415px against
~350px of usable width, i.e. two lines on every phone; and on the venue board
two equal full-width rows stacked and read as a list of options. Two alternatives
were offered and rejected — an inline link inside the price line (zero added
height, but the ticket gate and store have no such line at an empty wallet, so
it would have meant two patterns), and cutting the number of surfaces (a change
to REFERRAL_PRODUCT_SPEC, not to layout).
**What it changes going forward:** two rules, both encoded in that module's
doc-comment and one of them in a test. **This element never goes in an action
bar and is never full width** — it is a tail-of-content object. And **the copy
stays one line**: `referral-hint.test.ts` fails a translation over 31 characters,
because a chip that wraps is the block this replaced under a rounder corner. Add
a sixth surface by calling the shared module, not by copying a row.
**Recorded in:** PRODUCT_SPEC.md §3.9, `apps/webapp/src/referral-hint.ts`,
deploy.md → the PENDING block at the top.

---

## 2026-08-08 — the chat session is account state, and deleting an account must erase it

**Kind:** deviation from plan
**What:** `deleteUserAccount` now deletes the `bot_sessions` row, and the demo
`/restart` resets `ctx.session` in place. Found from a founder-reported dead end
in the demo — "Cannot finalize — missing required data: partner_preferences"
after uploading photos, with no way forward.
**Why:** the row is keyed by Telegram CHAT id and has no relation to `users`, so
it is the one store the Prisma cascade cannot reach. It had been treated as
transport state; it is account state. The reconstruction from `chat_events` is
what makes the class clear rather than the instance: a `/restart` left
`expectingPhoto: true` behind, the NEXT account inherited it, three uploads at
the `hobbies` question produced a Continue button, and Continue called finalize
directly — refused, changed nothing, stage still open, no path back to the
missing question.
**What it changes going forward:** three rules. **A store with no FK to `users`
is not automatically out of scope for deletion** — `bot_sessions` was the only
one, and it also held `pendingPhotos`, a buffered AI-memory paste and
`activeMatchId`, so this was a GDPR gap as much as a state one. **A Telegram
caller must reset `ctx.session` as well as the row**, because grammY writes the
live session back after the handler and would resurrect it. And **an
LLM-facing tool diagnostic must never be a user-facing reply**: it is English,
names internal field keys, and instructs a model — the two sites that printed
it now log it and answer with localized copy.
**Recorded in:** ARCHITECTURE.md → `bot_sessions`; PRODUCT_SPEC.md §1.3 and
§GDPR; DEMO_MODE.md → Recovery.

## 2026-08-08 — a demo-only deploy can ship a production fix to the demo and nowhere else

**Kind:** deviation from plan
**What:** `087e7e4` (free text that isn't an answer) ran in the demo from
2026-08-07 and in production only on 2026-08-08. Nothing was mis-scoped — it was
committed before two demo-only releases, and `deploy-demo.sh` syncs the whole
working tree, so it rode along to `/opt/gennety-demo` while `/opt/gennety` was
deliberately never restarted.
**Why it matters:** the signal we use to prove a demo deploy was safe — the
production restart count not moving — is the same thing that hides an unshipped
production fix. It also inverts the usual assumption: the demo was AHEAD of
production, so testing the demo bot would have shown a fix that real users did
not have. Found only because the founder asked directly whether production was
current.
**What it changes going forward:** a demo release is not a release. After
`pnpm demo:deploy`, recompute the production gap (`git log <prod-sha>..HEAD`) —
and when that range contains a commit under `apps/bot/src/demo/`, the commits
*around* it are the ones to check, because the demo one is the reason the range
exists at all. Verify by module presence on `/opt/gennety`, never by which
release a commit happened to precede.
**Recorded in:** deploy.md → the 2026-08-08 release block and the "Prod anchor"
section.

## 2026-08-08 — the current-venue card's badge moved so a photo could fit

**Kind:** deviation from plan
**What:** the ask was "show a photo on the current-venue card too". Adding the
68px thumbnail broke the card's text: the "Picked for you" badge wrapped into a
two-line pill and the venue's own name truncated. So the badge moved out of the
text column onto its own line at the top of the card, and the name now wraps
instead of ellipsizing. That is a visible layout change nobody asked for.
**Why:** the photo and the badge want the same width and the card cannot give
both. Measured rather than eyeballed: the photo costs 82px of a ~350px card,
leaving the badge 176px against 188px (ru) and 203px (pl). Shrinking the
thumbnail does not fix it — 12px back does not cover a 27px shortfall in Polish
— and a wide photo banner across the card top would have roughly doubled the
height of the one venue the user came to this screen to move away from.
**What it changes going forward:** the pinned card is now a two-row card
(badge, then picture/words/heart) while the twelve alternatives stay one row.
Do not "restore" the badge into the meta column without also removing the
photo. The name wraps only on this card; the alternatives keep their ellipsis
because an even row height is what makes that list scannable.
**Recorded in:** PRODUCT_SPEC.md §3.7b; `renderCurrentCard` +
`.vc-card.is-current` in `apps/webapp/src/venue-change.{ts,css}`.

## 2026-08-08 — the pinned venue shows its stored cover, not a fresh gallery

**Kind:** change of mind
**What:** I first planned to resolve the current venue's full photo set from
`venuePlaceId` on every board state, giving the pinned card the same 6-photo
gallery every alternative has. It ships the other way round: the cover stored at
assignment (`Match.venuePhotoName`) is used, and a Places lookup happens ONLY
when a row carries no cover.
**Why:** `/v1/venue-change/state` is polled every ~4 s, and the gallery is worth
a network call on that path only if it buys something. It does not: the stored
cover is already correct, free, and is the exact image the pair saw on their
date card, so the board and the card agree on what the place looks like. The
lookup survives as the fallback because a row with no cover would otherwise show
a grey tile forever.
**What it changes going forward:** the pinned card's preview shows one photo
where an alternative shows up to six — deliberate, not an oversight. If that
asymmetry ever needs closing, warm the cache in the background and let the NEXT
poll carry the gallery; do not make the first paint wait on Places.
**Recorded in:** `originalPhotoRefs` in `handlers/matching/venue-change.ts`,
`resolveVenuePhotoRefs` in `services/venue-change.ts`; ARCHITECTURE.md → the
`/v1/venue-change/state` row.

## 2026-08-08 — the ticket card keeps names on the gate only, and loses everything else

**Kind:** founder decision
**What:** the hero Date Ticket card drops "На двоих" (both places), the
"curated date ticket" label and the marketing tagline; gains the brand
butterfly as its centre and the wallet count on its stub. The **names stay on
the gate and go from the store** — the founder picked that over my
recommendation of dropping them everywhere.
**Why:** I argued for one composition with no names at all (the partner's name
is already on the gate three times: headline, sub, and the pay-for-both
avatar), because keeping them on one screen and not the other is how you end up
maintaining two designs. The founder wants the gate's ticket to be *theirs*.
Resolved without a second design: the names are one optional line under the
butterfly, so the store simply renders the same card minus that line.
**What it changes going forward:** the card is one component
(`Ticket3D`) on both screens, and it must stay that way — anything added for
one screen has to be expressible as an optional line, or the (б) choice quietly
becomes two layouts after all. The serial no longer seeds from the holders'
names (it could not, once one screen had none); it seeds from the match id on
the gate and a constant in the store.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The ticket card, and what it may
print"; `apps/webapp/src/ticket/Ticket3D.tsx`.

## 2026-08-08 — "На двоих" was a lie, not a style problem

**Kind:** founder decision
**What:** the card printed "На двоих" / "Admit two" in its header and "НА
ДВОИХ" on its stub. One ticket admits **one** person — a man paying $13.98 "for
us both" buys two of them (§3.5b) — so a user who chose "pay only mine" was
being told his partner was already covered. Deleted from `TicketStrings` and
all five locales.
**Why:** worth its own entry because it is the one deletion on that card that
was **mandatory** rather than aesthetic. The label, the tagline and the names
went because the card is better without them; these two had to go even if we
had decided to keep the card wordy.
**What it changes going forward:** the falsehood was confined to the Mini App —
`packages/shared/src/i18n.ts` has no ticket copy claiming two admissions — so
there is nothing else to chase. Do not reintroduce a "for two" line anywhere on
a single ticket.
**Recorded in:** PRODUCT_SPEC.md §3.5b; `apps/webapp/src/ticket/i18n.ts`.

## 2026-08-08 — the wallet count hides at zero, which is NOT the rule I was given

**Kind:** deviation from plan
**What:** I asked whether to keep the balance-visibility rule one-to-one when
moving the count from a pill under the card onto the card's stub; the founder
said keep it. I then made it hide at a **zero** balance, which the store's pill
did not do — it rendered "Твой кошелёк: 0 🎟️" unconditionally.
**Why:** the two are not the same element. "Твой кошелёк: 0" is a sentence and
reads fine; "🎟 × 0" printed on a ticket reads as a rendering fault. The
information is not lost — an empty wallet is precisely the state the bundles
below are for, and the referral cross-promo already fires at zero.
**What it changes going forward:** the gate's own rule (only on `offer` /
`cover-partner`) is untouched. If the store ever needs to state an empty wallet
explicitly, that is a line of copy on the page, not a zero on the ticket.
**Recorded in:** PRODUCT_SPEC.md §3.5b; `Ticket3D.tsx` (`balance` prop).

## 2026-08-08 — the hero button stops shimmering

**Kind:** change of mind
**What:** `.btn-hero`'s travelling white bar (`sheen`, 3.4s loop) is replaced by
the house inner-edge sheen. PRODUCT_SPEC had described that button as "the one
burgundy, **shimmering** rung", so this is a documented behaviour changing, not
a tidy-up.
**Why:** the founder asked for the perimeter glow on the store's bundle buttons
and, separately, complained that the ticket card's moving highlight looked
unnatural. Those are the same defect: a hard-edged rectangle sweeping across a
static surface on a loop, with no surface for it to be a reflection of. Fixing
one and leaving the other on the adjacent screen would have been incoherent.
**What it changes going forward:** **`venue-change.css` still has its own copy
of the `sheen` keyframes and uses it twice** — those two buttons now shimmer
while the ticket screens in the same flow do not. Deliberately left alone
(out of the scope the founder set), but it is the next thing to converge.
**Recorded in:** PRODUCT_SPEC.md §3.5b (both the pricing bullet and the new
"One light, everywhere" note); `apps/webapp/src/ticket/ticket.css`.

## 2026-08-08 — the ticket glyph ships as a vector, and is expected to be replaced

**Kind:** founder decision
**What:** the wallet count on the stub is drawn with a new `TicketMark()` in
`marks.tsx`. The founder will supply a PNG of the mark from an external tool
later.
**Why:** platform emoji are banned on these surfaces (`marks.tsx`) — the old
string used `🎟️`, which would have rendered as Apple's art on iOS and Google's
on Android and blurred at any scale.
**What it changes going forward:** whoever swaps in that PNG must know the mark
sits on the **always-dark** ticket stock in both themes and currently inherits
`currentColor` at 0.85 opacity. A PNG cannot inherit colour, so it has to ship
light-on-dark and be checked against the stub's burgundy-black ground, not
against the page.
**Recorded in:** `apps/webapp/src/ticket/marks.tsx`.

## 2026-08-07 — the rule behind three separate "what if the text isn't an answer" fixes

**Kind:** change of mind
**What:** the codebase held **four** unsynchronised strategies for a user
replying to a prompt with something that is not an answer. Decline → the agent
judges and the tool is guarded. Profiler → the router wrote it verbatim and the
agent was never told the feature exists. Onboarding photos below the minimum →
the agent answers while the gate holds. Onboarding photos above it → the agent
was not called at all. The rule that separates the two good ones from the two
bad ones is now explicit: **a gate is derived from state, never from the
conversation; and the conversation always reaches the agent.**
**Why:** the founder asked the same question three times about three different
screens, which is what surfaced it as one problem rather than three. The photo
stage below the minimum already satisfies both halves and is the model — it is
the only one of the four that was fully correct. Profiler satisfied neither
(verbatim capture means the conversation writes state directly, bypassing the
agent); photos above the minimum satisfied the first but not the second.
**What it changes going forward:** any new step that reads free text owes both
halves. If a new surface captures text in a router before the agent, it must
classify intent before writing — and whatever it refuses to write must still
reach the agent rather than vanish.
**Recorded in:** PRODUCT_SPEC.md §1.3 (media stage), §Phase 1b (refusal),
§3.4 (decline feedback).

## 2026-08-07 — preset decline reasons stay out of matching, and that is deliberate

**Kind:** change of mind
**What:** I first offered "route the four preset reasons into
`negativeConstraints`" as an equal alternative to fixing the copy. It is wrong,
and the copy fix is the whole change: the buttons remain analytics and the
message no longer promises otherwise.
**Why:** `V_penalty` is a literal word-match of each stored trait against the
candidate's `psychologicalSummary`. A preset is a category, not content — "не
мой тип" does not say which type — so feeding it in either writes a trait that
can never match any summary, or lets the LLM distiller invent a specific trait
out of a content-free label, and that invention then penalises real candidates.
The second is worse than doing nothing. Separately, production has had 2 matches
ever, both terminal, so a learning loop here would be calibrated on zero
examples.
**What it changes going forward:** **do not route presets into
`negativeConstraints`** — the mechanism is built for free text with content, and
the free-text path already does this correctly. If preset reasons should ever
influence matching, each button names a *different* axis with its own structured
home (appearance → `typePrefTags`/`appearanceTags`, vibe → the energy/orientation
quadrant, interests → `hobbies`/`anchorTags`), one decline is too weak a signal
to mutate any of them, and it starts with a query over accumulated declines
rather than a write. Note also that Type Radar is opt-in calibration while a
decline is not, so learning appearance preference from rejections is a consent
decision, not a technical one.
**Recorded in:** PRODUCT_SPEC.md §3.4.

## 2026-08-07 — a Profiler refusal pauses the batch; a permanent opt-out is not built

**Kind:** founder decision + not done
**What:** answering a Profiler question with "не хочу" records a skip and defers
the rest of the batch to the user's next local window. A permanent "stop asking
me these" was discussed and deliberately left out.
**Why:** the founder described wanting the bot to say "окей" and stop the batch,
which the pause delivers. Permanent is a different thing: it needs a Settings
surface, a way back, and a demo-mode branch, and a one-word "потом" must not be
able to retire a feature for an account. The pause self-heals, so the cost of
being wrong about the classification is one window rather than forever.
**What it changes going forward:** if a permanent opt-out is wanted later it is
a product decision with its own UI, not an extension of this classifier.
**Recorded in:** PRODUCT_SPEC.md §Phase 1b; `services/profiler-intent.ts`.

---

## 2026-08-08 — the demo shows all three coordination variants, and explains the two it cannot run

**Kind:** founder decision
**What:** in demo mode the pre-date fork (§Phase 4) is shown with **all three**
buttons. Tapping either contact-exchange variant — impossible against a puppet
with no Telegram account — answers with what that button would have done in
production, what it costs, and why it cannot run here, then hands the choice
straight back with the remaining buttons. Only the anonymous chat is performed.
**Why:** the founder wanted the *mechanic* demonstrated, not hidden. The two
rejected alternatives were worse in opposite directions: sending nothing (what
production does for an unreachable pair) means an investor never learns the
question exists, and giving the puppet a fake `@username` to make A and B "work"
would put a dead `t.me/` link on screen — a demo that lies is worse than one
that explains. Explaining costs one paragraph and demonstrates more of the
product than pressing a working button would.
**What it changes going forward:** the fork card is **demo-owned** — sent from
`apps/bot/src/demo/`, with `demo:coord:*` callback data, reusing production's
renderer, copy and labels. Do NOT "simplify" this by adding a ninth
`if (DEMO_MODE_ENABLED)` to `resolveCoordRecipients`: production's own handler
would still refuse the tap, its keyboard still could not show A/B without a
username, and variant A would *succeed* for a visitor who has one — writing
`coordMethod: "share_self"` and permanently blocking the anonymous chat. A and B
must keep writing **nothing**; that is what holds the fork open so both can be
read.
**Recorded in:** DEMO_MODE.md → "The coordination fork is the demo's own
screen"; `apps/bot/src/demo/script.ts` → `DEMO_COORD_PREFIX`.

## 2026-08-08 — the demo puppet answers in the anonymous chat, via an LLM

**Kind:** founder decision
**What:** the puppet writes in the pre-date relay — one small LLM call per turn,
prompted as a real person on the way to the date, carrying the venue, the time
in the pair's timezone and the transcript. It writes FIRST ("ten minutes out,
where are you?"), then arrives, then keeps to finding each other.
**Why:** the relay is the one place in the product where two users write to each
other, and in demo the other side cannot type at all (no chat, no push token).
A visitor writing into silence had been shown a broken feature. The founder's
framing was explicit: give it the date context and a situation, and let it
simulate the real thing.
**What it changes going forward:** the puppet must never start a conversation
about the date itself — the product deliberately has no pre-date chat beyond
logistics, and demoing one would be inventing a feature. The reply is capped
(8 messages), validated, and falls back to a scripted ladder, so the chat works
with no `OPENAI_API_KEY`. It goes through the production `relayProxyMessage`
with an injected clock, never a hand-written row plus DM — anything else would
drift from the real log and the real delivery path.
**Recorded in:** DEMO_MODE.md → "The puppet talks in the anonymous chat";
`apps/bot/src/demo/proxy-partner.ts`.

## 2026-08-08 — a demo step that is a real decision gets a real pause

**Kind:** change of mind
**What:** the pre-date replay was one run of four gates 4 seconds apart. It is
now three stretches, stopping at the coordination fork and again at the open
relay, resuming on the visitor's own tap or a floor timer.
**Why:** the single run closed the anonymous chat four seconds after opening it,
so the visitor got a live "Enter chat" button that was dead by the time they
reached it. The rule this establishes is more general than the bug: **the replay
compresses WAITING, not deciding.** A gate the visitor is meant to answer cannot
be replayed past.
**What it changes going forward:** a new gate added to the replay must be sorted
into one of the two kinds. If it produces something the visitor is meant to press,
it needs its own stretch, a floor timer and a button — the pattern the date-card
handover already established.
**Recorded in:** DEMO_MODE.md → the gate list; `apps/bot/src/demo/driver.ts`
(`PRE_DATE_GATES` / `COORD_GATES` / `AFTER_DATE_GATES`).

## 2026-08-08 — the first complete demo run, and what it found

**Kind:** deviation from plan + a document turned out to be wrong
**What:** the founder walked the demo end to end for the first time. It reached
`status: completed` with a real venue, a rendered date card and the feedback
prompt — and `venue_selection_logs` went from 0 to 1, i.e. the venue engine ran
in the demo for the first time ever. Three things did not fire; only one was a
bug.
**Why each:**
- **Pre-date coordination never ran (real bug).** `runCoordinationTick` is a
  SEPARATE sweep from `runDateLifecycleTick`, called on the real clock, so the
  demo's replay skipped the whole hour before the date — offer, anonymous chat
  and all five coordination cards — with the flag on the entire time. Fixed.
- **The safety brief did not fire (not a bug).** It addresses the female
  participant and the pair was male+male. It is a *coverage* limit: a male
  visitor can never see it, nor the hetero-only cover gesture, wish card or
  express venue change. A second run from the other side is the only way.
- **`DATE_COMPLETED` never appeared — because nothing writes it.** I had told
  the founder that event would be the proof the demo finished. It and
  `PROPOSAL_SHOWN` are declared in `MatchEventActionType` and have no write site
  anywhere. Completion is `Match.status`, dispatch is `Match.dispatchedAt`.
**What it changes going forward:** a new sweep on the date-lifecycle interval
must be added to the demo replay as well — the replay is not "the lifecycle", it
is "everything the interval does". And `match_events` is not a funnel: two of
its eight values are reserved, not data.
**Recorded in:** DEMO_MODE.md → "the pre-date replay … needs BOTH sweeps";
ARCHITECTURE.md → `match_events`; PRODUCT_SPEC.md §Phase 5.

## 2026-08-08 — deploy.md said coordination was off in production; it has been on

**Kind:** a document turned out to be wrong
**What:** two deploy.md blocks stated `COORDINATION_FEATURE_ENABLED` is **off**
in production and that the pre-date coordination routes were therefore inert. It
is `true` in `/opt/gennety/.env` (line 70) and the running process confirms it —
`GET /v1/app/config` answers `features.coordination: true`. A third block, from
2026-08-02, said the opposite and was right; the file had been contradicting
itself for six days. I repeated the wrong version to the founder before checking.
**Why it went unnoticed:** production has had **0 dates ever**, so nothing has
reached T-60m and the feature has never actually fired there. A flag being on
looks exactly like a flag being off when no data can exercise it.
**What it changes going forward:** read a flag off `/v1/app/config` (or the
running process), never off a sentence in deploy.md — that file carries per-release
snapshots that age, and a later block can silently contradict an earlier one. When
a block asserts "inert in production", the assertion needs a runtime check beside
it, not a claim.
**Recorded in:** deploy.md → both corrected blocks carry a ⚠️ note in place.

## 2026-08-07 — a broken demo says so out loud rather than going quiet

**Kind:** founder decision
**What:** when a puppet move is refused three times running, the demo tells the
visitor it is stuck and points at `/restart`, and stops retrying that move.
Before this every branch of the driver either ignored the result or logged a
warning and returned, so a refusal was re-derived and re-attempted every tick
forever.
**Why:** the founder asked for a full sweep of the demo specifically because the
ticket-gate stall was found by accident. Two measurements settled the shape of
the fix: `insufficient-balance` was logged **1500 times** across hours, and the
tick summary reported `acted=1 errors=0` throughout — so the only signal anyone
watches was actively asserting health while the demo was dead. The failure that
matters here is not an exception, it is **silence in front of an audience**. A
demo that admits a fault can be restarted in two minutes; one that quietly stops
cannot be rescued at all.
**What it changes going forward:** a new puppet move must return an outcome, not
`void` — `performAction`'s parameter is typed `Exclude<DemoAction, {kind:"none"}>`
so a new action kind fails the exhaustiveness check instead of silently counting
as a success. The visitor-facing message stays **vague about the cause** on
purpose (nobody can act on `insufficient-balance`); the reason belongs in the
log, written once per streak rather than once per tick.
**Recorded in:** DEMO_MODE.md → "A refused move is reported, not retried
forever"; `apps/bot/src/demo/failure-tracker.ts` (+ its test).

## 2026-08-07 — a demo bug report fixed in production code, and a symptom I could not reproduce

**Kind:** deviation from plan
**What:** the founder reported three demo-mode defects. Two were demo-only and
fixed there. The third — the two avatars on the Date Ticket "pay for us both"
button rendering as placeholders — was fixed in the **shared** ticket route
(`services/avatar-thumbnail.ts`, `public/routes/ticket.ts`) plus the shared
`Avatar` component, so it ships to production as well as to the demo.
**Why:** the cause is not demo-specific. The route streams participants' FULL
profile photos to fill two 44px circles — measured live at **517 KB + 355 KB**
for one button, ~850 KB inside a Telegram WebView against the client's 6-second
preload budget. A real user on mobile data hits the same thing; scoping the fix
to `apps/bot/src/demo/` would have meant knowingly leaving it in the paid flow.
**The part worth flagging for whoever reads this next:** I could not reproduce
the exact rendering. Both endpoints answer **200 image/jpeg** in 0.6–1.0s from a
laptop, so the "two question marks" were never observed by me directly. What
shipped is the measurable defect (bytes) plus a graceful failure path (`onError`
→ monogram, because `alt=""` makes a broken `<img>` render as nothing or as the
client's broken-image glyph). If the placeholders come back on a fast
connection, this was the wrong cause and the next step is a device-side network
trace, not another guess.
**What it changes going forward:** a demo-mode report is not automatically a
demo-mode fix — check whether the code path is shared before scoping. The
avatar ceiling (256px) is 2× the largest avatar the Mini App draws at 2× DPR;
raising the drawn size means raising it.
**Recorded in:** deploy.md → the PENDING block at the top; DEMO_MODE.md →
driver state table + Recovery.

## 2026-08-07 — the App Store price gap closed, and iOS Premium turned out not to be purchasable at all

**Kind:** founder decision + a document turned out to be wrong
**What:** `premium_monthly` was raised $9.99 → **$17.99/mo** in App Store Connect
(US base; Apple auto-generated 175 storefronts), closing the gap opened hours
earlier when the Telegram rail went to 750⭐/$17.99. Verified by reloading the
product page, not from the confirmation dialog: US at 17,99 $ with **0 upcoming
changes**, so it is the live price rather than a scheduled one. Ticket products
untouched. Supersedes the "left behind on purpose" entry below.
**Why the second half matters more than the price:** the same pass surfaced a
fact recorded **nowhere in this repo** — the subscription group sits in
*Preparing for Submission*, under Apple's rule that **the first subscription
group must ship with a new app version**. So `premium_monthly` cannot be bought
on any storefront until a build carrying it clears review. Everything written in
deploy.md about the $9.99/$17.99 mismatch described a real config divergence
that **no user could ever have encountered**, because the product was not
purchasable on either price.
**What it changes going forward:**
1. **`features.premium: true` in `/v1/app/config` does not mean iOS can sell
   Premium.** That flag mirrors `PREMIUM_FEATURE_ENABLED` on the server and
   knows nothing about App Store review state. A native paywall gated only on it
   renders a StoreKit product that cannot be purchased. The App Store rail goes
   live at first approved submission, not at a flag flip — and the same is true
   of the ticket products.
2. **Every future `PREMIUM_PRICE_USD_DISPLAY` change needs a manual App Store
   Connect edit in the same breath.** There is no server-side price for iOS to
   read, so no deploy can ever move it and nothing in this repo will show the
   drift. Treat the two as one edit with two halves.
3. Fixing the price *before* first submission was the cheapest possible moment:
   no price history, no subscriber cohort, so no "preserve price for existing
   subscribers" decision existed to get wrong. That is why the wizard offered
   neither that prompt nor a start-date picker — do not read their absence as a
   sign something was skipped.
**Recorded in:** deploy.md → the 2026-08-07 release block, the Premium price
block, and the StoreKit block (price table + the new submission-state warning).

## 2026-08-07 — the preference screen's photo scatter wins; the other design is deleted, not flagged off

**Kind:** founder decision
**What:** "Who do you want to meet?" ships the tilted-photograph scatter. The
group-cutout design built beside it, the dev `?v=` switch, the side-by-side
review page, the variant-2 CSS and the two cutout images are removed from the
tree — `preference-variant.ts` is gone, `PreferenceColumn` takes no `variant`.
**Why:** the founder compared the two on the live screens over two days and
settled ("я уже полностью определился"). Keeping the loser behind a constant
would leave a switch nobody is going to flip, plus ~335 KB of artwork in the
bundle and a second set of CSS overrides that every future edit to this screen
has to be checked against. A decision that is made stops being configuration.
**What it changes going forward:** this screen has ONE design. Do not
reintroduce a variant switch to try an alternative — branch instead. The
deleted design is recoverable from git (`git show
8190fea:apps/webapp/src/preference-variant.ts` and the paths beside it), which
is where a reverted design belongs. One trap: `onboarding.html` requests Inter
800 and must keep doing so — it arrived for the deleted design's heavy word,
but «Парней» / «Девушек» now depend on it, so the obvious post-removal tidy-up
would silently downgrade them to a synthesised bold.
**Recorded in:** PRODUCT_SPEC.md §1.3 (the preference screen), deploy.md → the
PENDING Mini App block at the top and the "So does the preference photo fork"
bullets.

## 2026-08-07 — what the two-design comparison taught, kept after the loser was deleted

**Kind:** founder decision
**What:** the reasoning that killed the group-cutout design is retained in
PRODUCT_SPEC as a constraint on anything that replaces this screen, rather than
deleted with the code: **a taller button does not draw people any bigger.**
**Why:** the finding is about the column, not about that design — group artwork
runs out of column WIDTH long before it runs out of height, so at half a phone
wide five people across are ~32px each and extra button height only becomes
headroom. Someone proposing "show a group photo here" in six months would
otherwise rediscover it by building the thing again. The scatter sidesteps it by
showing one person per frame.
**What it changes going forward:** a future group/multi-person treatment for
this screen has to answer that measurement before it is worth building.
**Recorded in:** PRODUCT_SPEC.md §1.3.

## 2026-08-07 — the proxy-chat window is derived from `agreedTime`, not read from the cron's stamps

**Kind:** deviation from plan
**What:** `proxyChatWindow()` computes T-30m…T+2h from `Match.agreedTime`.
`proxyOpenedAt` / `proxyClosesAt` are no longer the gate; they keep their real
job (the pair was TOLD) and `proxyClosedAt` remains a force-close that wins.
**Why:** those columns are written by the 2-minute coordination tick, so gating
on them opens a THIRTY-minute window up to two minutes late — on the one
surface whose entire value is the last half hour before a meeting. Deriving it
also makes both surfaces agree instantly instead of agreeing eventually.
**What it changes going forward:** the window is a pure function of the
schedule. A change to when the tick runs cannot move the edges, and any new
surface must call `proxyChatWindow` rather than read the columns.
**Recorded in:** `services/proxy-chat.ts`; pinned by `proxy-chat.test.ts`
("is open on time even though no cron has stamped anything").

## 2026-08-07 — the proxy-chat push carries the message text (4.4's rule does not apply here)

**Kind:** change of mind
**What:** a relayed message is pushed to a mobile partner with the body in it.
In §4.4 the emergency-cancellation push deliberately withholds the canceller's
reason.
**Why:** the two are not the same case. A cancellation reason arrives unbidden
and is emotionally loaded, so it belongs where the recipient chose to look. A
coordination message is a chat the user opted into, in the last half hour
before meeting, where "you have a new message" is precisely the notification
that makes someone open the app and read "I'm by the door" thirty seconds too
late.
**What it changes going forward:** "never put another user's free text in a
push" is NOT a general rule of this product — it is a rule about unbidden text.
Anyone applying it to a future surface should check which of the two this is.
**Recorded in:** `deliverToPartner` in `services/proxy-chat.ts`.

## 2026-08-07 — a pair the Telegram fork cannot reach gets the proxy chat automatically

**Kind:** deviation from plan
**What:** when `resolveCoordRecipients` comes back empty — either side is not
reachable in a bot chat — the T-60m sweep now writes `coordMethod: "proxy"`
itself instead of only stamping the marker and moving on.
**Why:** the coordination method was selected by tapping an inline keyboard, so
a pair with an app participant never had one, and `openProxies` (which requires
`coordMethod: "proxy"`) never opened a window for them. The whole feature was
structurally unreachable from the app — not missing an endpoint, missing an
initiation. Auto-selecting is right rather than building a second menu: the
fork's other two variants exchange Telegram handles, meaningless to someone who
has none, and ROADMAP/PRODUCT_SPEC already put contact exchange in stage 2 and
keep only variant C in the MVP. So on the app there is nothing to choose
between. Flagged to the founder before implementing; no objection.
**What it changes going forward:** reversible by deleting one branch in
`sendOffers` if the app is ever given its own choice screen. Until then, "the
pair has no coordination method" no longer implies "the pair chose not to
coordinate".
**Recorded in:** `sendOffers` in `services/coordination.ts`.

## 2026-08-07 — `telegramId > 0` was still being used as a reachability test

**Kind:** deviation from plan
**What:** `resolveCoordRecipients` filtered on `telegramId > 0n` alone; it now
also requires `platform in (telegram, both)`.
**Why:** ARCHITECTURE has stated since Telegram login shipped that a positive
`telegramId` no longer implies the bot can message someone — that rail stores a
REAL id on an app-only account, and a bot cannot open a chat with a user who
never pressed Start. Two workers were already fixed for this; the coordination
sweep was not, so it would have offered an inline keyboard to someone who could
never see it, and then read the silence as a choice.
**What it changes going forward:** the same audit is worth running on any other
`telegramId > 0` filter. A row predating the `platform` column falls back to
the id, so no existing Telegram user loses the offer.
**Recorded in:** `telegramReachable` in `services/coordination.ts`.

## 2026-08-07 — Premium moves to 750⭐/$17.99 with the App Store left behind on purpose

> **Superseded the same day** — the App Store price was raised to $17.99 hours
> later and the two rails now agree. See "the App Store price gap closed, and
> iOS Premium turned out not to be purchasable at all" above. The reasoning
> below still stands as the record of why the bot rail moved first.

**Kind:** founder decision
**What:** `PREMIUM_STARS` 500 → 750 and `PREMIUM_PRICE_USD_DISPLAY` $11.99 →
$17.99 applied to `/opt/gennety/.env` during the 2026-08-07 release, while App
Store Connect still prices `premium_monthly` at **$9.99**. The founder chose to
raise the Telegram rail now rather than wait for the two surfaces to line up.
**Why:** the deploy.md block had been blocked on an operator step nobody was
going to do first, and the code defaults were already 750/$17.99 — only the
`.env` override was holding the old price, so the block would have stayed
PENDING indefinitely. 0 purchases ever, so no existing subscriber is
grandfathered onto the old amount and the cohort the block warns about is empty.
**What it changes going forward:** the same subscription costs **$17.99 in the
bot and $9.99 in the app** until the price tier is raised in App Store Connect.
Nothing in this repo can close that gap — iOS renders StoreKit's own
`displayPrice` and `/v1/app/config` exposes only a boolean — so it is an
operator task, not a code one. Do not "fix" it by editing constants.
**Recorded in:** deploy.md → the 2026-08-07 release block and the Premium price
block; `/opt/gennety/.env` (rollback snapshot `.env.bak.*` taken same deploy).

## 2026-08-07 — a deploy.md block below the catch-up marker was still pending

**Kind:** a document turned out to be wrong
**What:** the 2026-08-02 marker claims "every block below that was marked PENDING
shipped in one deploy". The account-health block sits below it but its commit
`44f9e41` is dated 2026-08-03 — it was inserted in the wrong place and had never
been deployed. Caught only because `admin/utils/user-health.ts` was absent from
the droplet.
**Why:** it matters more than a filing error. That marker is the single thing a
new session uses to tell a real backlog from a stale label, and the failure is
silent in the worst direction — a block that reads as shipped and is not. The
paired symptom: the admin dashboard repo had already been pushed and
auto-deployed, so its new tabs had been calling `/admin/users/:id/health` and
`/admin/purchases` against a server that did not serve them, with nothing
surfacing the breakage.
**What it changes going forward:** verify a block by whether its module is on the
droplet, never by which side of the marker it is on. New blocks go at the TOP of
deploy.md. When a block names a dashboard redeploy, check whether it already
happened — a pushed dashboard against an undeployed server is a broken tab, not
an error anyone sees. Marker annotated; all 34 stale PENDING labels retired, so
deploy.md now has **zero** PENDING blocks.
**Recorded in:** deploy.md → the ⚠️ warning on the 2026-08-02 marker and the
account-health block.

## 2026-08-07 — "production has 0 matches ever" was copied forward until it was false

**Kind:** a document turned out to be wrong
**What:** a dozen deploy.md blocks assert production has had 0 matches ever and
base their post-deploy advice on it. Production has had **2**, both from the real
Thursday drop: `2026-07-30 15:00Z` (expired) and `2026-08-06 15:00Z` (cancelled),
both `source = weekly`.
**Why:** the claim was true when first written and was then pasted into each new
block as boilerplate rather than re-measured. It is load-bearing — it is the
justification for "nothing exercises this, verify on @gennetytestbot", and it
had quietly stopped being a statement about production and become a statement
about the last time someone checked.
**What it changes going forward:** the drop IS pairing real users weekly, and
both pairs died before a date (one ghosted to expiry, one cancelled) — that is a
product signal, not just a doc error. Re-measure the claim rather than copying
it. The narrower facts remain true and are what the blocks actually needed:
**0 dates ever**, `venue_selection_logs` 0 rows, `live_activity_tokens` empty —
so the venue geo-ladder, the Live Activity and the date-card path are still
genuinely unexercised in production.
**Recorded in:** deploy.md → the 2026-08-07 release block; corrected in every
block above the 2026-08-02 marker (older blocks left as historical record).

## 2026-08-07 — three dependency overrides had rotted below their advisories

**Kind:** deviation from plan
**What:** `pnpm security:audit` — a mandatory preflight gate — failed with 7
advisories during the 2026-08-07 release. Three existing `pnpm.overrides` entries
(`postcss` 8.5.18, `fast-uri` 3.1.4, `brace-expansion` 5.0.8) each sat exactly
one patch below a newly published advisory. I raised those three and added
`js-yaml` 4.3.1 and `ip-address` 10.3.1, which was not part of the requested
scope.
**Why:** the alternative was shipping past a gate this runbook calls mandatory.
The advisories were already live in prod (the lockfile had not changed since
2026-08-02), so the release did not introduce them — but skipping the fix would
have carried them another release and left the gate red for whoever ran it next.
Only the `ip-address` chain (`apps/bot > express-rate-limit`) reaches the droplet
runtime; the rest are `apps/video` build-time or `eslint` dev tooling.
**What it changes going forward:** an override is not a one-time fix. Re-check
the pinned versions against `pnpm audit` on every deploy — each of these three
was correct when written and looked deliberate right up to the moment it wasn't.
**Recorded in:** deploy.md → Preflight ("an override rots") and the 2026-08-07
release block; root `package.json` `pnpm.overrides`.

## 2026-08-07 — Type Radar shipped as a two-file hotfix ahead of the release

**Kind:** deviation from plan
**What:** the Type Radar gate fix (`e0079df`) went to production as a targeted
two-file patch about an hour before the 84-commit release that also contained it,
rather than waiting for the full preflight.
**Why:** it was the only backlog item actively blocking work — iOS onboarding was
impassable in production, which blocked the founder's live photo/verification
runs. deploy.md warns that a single-file rsync from a newer tree crash-loops prod
(the 2026-08-01 incident), and that warning is right in general. It did not apply
here for a checkable reason: **both files it touches are changed by exactly one
commit in the whole `7f19a72..c25adbc` range**, so prod's version plus `e0079df`
IS the target version and the patch pulls in no module prod lacked.
**What it changes going forward:** that ancestry check — `git log --oneline
<prod-sha>..<target> -- <path>` returning a single commit per file — is the
precondition for ever repeating this. A file touched by two commits does not
satisfy it. Also: stage the patch under a **`.hotfix.ts`** name, not `.ts.new`;
tsx refuses an unknown extension, so the mandated in-place import test cannot run
against a `.new` file.
**Recorded in:** deploy.md → the Type Radar block's "shipped ahead of the rest"
note.

## 2026-08-07 — deploying from an isolated worktree, and two backups rsync would have eaten

**Kind:** deviation from plan
**What:** the 2026-08-07 release was deployed from `git worktree add
/tmp/gennety-deploy c25adbc` rather than from the working tree, and preflight was
run there. Separately, the documented rsync flag set was found to destroy **two**
droplet-only database backups, not the one deploy.md mentions.
**Why:** a parallel session was writing the `/v1/*` proxy-chat server half in the
same checkout, and rsync copies the working tree — so deploying from it would
have shipped someone's unfinished module, and running preflight there would have
produced test numbers describing code that was not being deployed. The backup
hazard: `--exclude '*-backup-*.json'` appears only in a 2026-08-02 release note,
names only `ethnicity-backup-*.json`, and was **absent from the flag set itself**
— following the runbook literally also destroys the 3.3 MB
`prod-backup-2026-07-27T14-08-06-066Z.json`.
**What it changes going forward:** deploy from a clean worktree whenever the tree
is not yours alone. The exclude is now in the documented flag set in both the
dry-run and the real sync. A clean worktree also means `--delete` removes
accumulated junk — 176 of this release's 189 deletions were gitignored
`apps/video/{build,out}` artifacts that earlier deploys had shipped because the
exclude list covers `dist/` but not `build/` or `out/`. Read every deletion line
anyway; that is what separates junk from the `keys/` directory an earlier deploy
destroyed.
**Recorded in:** deploy.md → Deploy Full Server Code (flag set + the two backup
paths) and the 2026-08-07 release block.

## 2026-08-07 — both photo shimmers count, and "which flow did they ask about" was the wrong axis

**Kind:** founder decision + change of mind
**What:** both photo-upload shimmers — the onboarding media stage (§1.3) and the
§2.1 photo manager — now carry a singular script for a burst that is still one
photo. Shipped in two commits hours apart: I scoped the first to onboarding and
recorded the manager as a deliberate exclusion; the founder came back with the
manager, and the exclusion was wrong.
**Why the first cut was wrong, since that is the reusable part:** I drew the
boundary around the *flow the founder named* ("при регистрации") rather than
around the *defect*, and reasoned that the manager's copy is about uploading
rather than looking, so it was a separate decision. Two things were missing. The
manager is REACHED from registration — the §1.4 verification gate's "📷 upload
different photos" is the only photo surface a not-yet-verified account has, and
that is exactly where the founder was standing (`menuState=edit_photos`,
`onboarding_step=completed`) when they reported it a second time. And a lone
upload is the *usual* case there, not an edge one: you open the manager to
replace one bad photo. So the surface I called out-of-scope had the worse
version of the same false statement.
**What it changes going forward:** when a founder reports a copy or UX defect
against a named flow, check where else the SAME code path or the same sentence
is user-visible before scoping to what they named — particularly across the
onboarding/menu boundary, which users do not perceive as a boundary at all.
Mechanically: the two scripts per surface must stay the same LENGTH, because a
growing burst is revised in place beat for beat (`reviseStatusScript`, shared by
both). A count-neutral beat (the manager's "almost there") is one i18n key used
by both scripts, not two identical ones.
**Recorded in:** PRODUCT_SPEC.md §1.3 + §2.1, `services/analysis-status.ts`,
`services/ai-stream.ts`, `handlers/onboarding/conversational.ts`,
`handlers/menu/edit-profile.ts`.

## 2026-08-07 — ten Kyiv venues promoted to premium; the catalog file is not the prod DB

**Kind:** founder decision
**What:** Cafe Marko, Porto Maltese, Elevato, Кафе Fandom, SHO and Vicini
Italiani go into the Kyiv `premium` tier (Кувшин, Good Girl and La Veranda were
already there). Fandom and Elevato are an explicit reversal of the demotion
made on the same day in `e7d10d8`.
**Why:** that demotion argued they "read weaker than venues sitting free in
base, so paywalling them argues against the upsell". The founder now wants the
premium board to carry them regardless. No new evidence was produced against
the earlier reasoning — this is a preference change, not a correction, and the
next person reading `e7d10d8` should not treat it as still standing.
**What it changes going forward:** premium is now 46 unique Kyiv venues (230
rows). A future premium review must start from this list, not from the
2026-08-07 morning one.
**Recorded in:** commits `a117535`, `d205bbf`;
`scripts/curated-venues.kyiv.{additions,expansion,approved}.json`.

## 2026-08-07 — NIKA (Taryan Towers) deliberately not added

**Kind:** not done
**What:** the sixth venue in the second request was left out of the catalog.
**Why:** Google Places has no such venue. A nearby sweep of Taryan Towers
(вул. Іоанна Павла II 12) returns Дублер, Balcony and others but no NIKA, and
the only "Nika" restaurant text search offers sits in Tashkent. Guessing a
place id is the one failure this catalog cannot absorb: the row is a real
address a real couple is sent to, which is why `resolve-venues:kyiv` refuses
low-confidence name matches by design.
**What it changes going forward:** it needs the exact Google Maps link or the
venue's registered listing name before it can be added. Do not re-resolve it
from the name alone.
**Recorded in:** commit `d205bbf`.

## 2026-08-07 — venue catalog changes stop at the file; prod import is its own decision

**Kind:** founder decision
**What:** both premium batches changed only
`scripts/curated-venues.kyiv.*.json`. No `seed-venues:import` was run against
production.
**Why:** following the precedent set in `a204acf` ("catalog file only —
production DB import pending explicit approval"). It matters more than usual
right now: **prod still carries the pre-expansion catalog (127 venues / 538
rows) while the file holds 247 venues / 1238 rows**, because the 141-venue
expansion in `000bc16` was only ever imported into the demo DB. So an import
would land the whole expansion, plus five deliberate demotions, at the same
time as these ten promotions.
**What it changes going forward:** anyone running `seed-venues:import` against
prod is making that larger decision, whether or not they mean to. Check the
row-count gap first.
**Recorded in:** commits `a117535`, `d205bbf`; deploy.md has no PENDING block
for this — there is nothing to deploy.

## 2026-08-07 — tier drift between the catalog files is a real failure mode

**Kind:** deviation from plan
**What:** while promoting the requested venues I also back-propagated five
demotions (PAUL ×2, Волконський, The Burger, Дуже по-французьки) from
`approved.json` into `expansion.json`, and set the missing `tier` on Кувшин /
Good Girl in `additions.json`. None of that was asked for.
**Why:** `sync-venues:kyiv --check` was RED before this work, on exactly those
rows. The manifest is what a re-sync replays, so the next `--apply` would have
silently re-promoted all five demoted venues; and `additions.json` is what
`resolve`+`merge` replays, so a re-run would have sent Кувшин and Good Girl
back to base. Both are silent regressions that only surface as a wrong tier on
a live board.
**What it changes going forward:** a tier lives in three files and they drift.
Treat `sync-venues:kyiv --check` as the gate — it is green now (215 places ×
5 domains) and should be run after any tier edit.
**Recorded in:** commits `a117535`, `d205bbf`.

## 2026-08-07 — decision journal introduced

**Kind:** founder decision
**What:** every product decision voiced in conversation, plus any change of mind
or deviation from the plan during a task, is recorded in this file — in every
session, whatever the task.
**Why:** only files cross session boundaries. Several decisions during the iOS
stage-3/4 work existed solely as chat messages (what was deliberately skipped and
why, which alternatives were rejected), and a fresh session had no way to see
them.
**What it changes going forward:** writing the entry is part of the same turn and
the same commit as the work itself. Mirrored in the iOS repo; the file loads
automatically via `CLAUDE.md`.
**Recorded in:** `AGENTS.md` → "Documentation Impact Check", `CLAUDE.md`.
