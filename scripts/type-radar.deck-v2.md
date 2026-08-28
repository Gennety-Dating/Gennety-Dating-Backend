# Type Radar v2 — дека архетипов: матрица, промпты, приёмка

> Заменяет признаковую деку v1 (`type-radar.filemap.txt`). Решения и доводы —
> DECISIONS.md, запись 2026-08-22 «Type Radar: архетипы вместо атрибутов».
>
> **Пока НИЧЕГО не трогаем в коде.** `TYPE_RADAR_ENABLED=true` в проде, старые
> 24 кадра живые. Новый набор генерируется и принимается отдельно; подмена
> модуля, ассетов и подписей — одним ходом, после приёмки.

## Куда складывать

```
~/Desktop/gennety-radar-v2/<id>.jpg      # ВНЕ репозитория
```

Имя файла — единственная связь кадра с его строкой. Ошибка в имени молча
портит обучение, и это ровно то, на чём v1 уже обожглась.

**Формат: 9:16, 1080×1920, все 24 одинаково.** Карточка рисует
`background-size: cover` на высокой флекс-области; сейчас набор смешанный
(750×1000 и 562×1000), поэтому кадры режутся по-разному и часть композиции
теряется незаметно.

## Что мы вообще измеряем

Одна ось — **архетип** (4 значения, по 3 кадра). Вторичные оси — цвет волос,
длина/борода, тату — декоррелированы с архетипом по построению: ровно один
тату-кадр в каждом архетипе, длина и борода не постоянны ни в одном.

**Цвет волос в женском наборе — 5 блонд / 5 брюнеток / 2 рыжих, и это решение,
а не перекос** (фаундер, 2026-08-23 — DECISIONS.md). Первая версия деки была
4/4/4, по одному цвету в каждом архетипе: идеально для измерения и
неправдоподобно для пула — рыжих в реальных анкетах единицы, а треть деки
уходила на них. Арифметика делает размен почти бесплатным:
`confidence = min(1, shown/CONF_FULL)`, `CONF_FULL = 4`, поэтому блонд и
брюнетка при пяти кадрах имеют ту же полную уверенность, что при четырёх —
потолок уже достигнут, — а рыжий при двух падает до 0.5. Мы вдвое ослабляем
ячейку, которая и так применяется к нескольким процентам кандидатов.

**Рыжие — это fp3 и fs3, и это уже снято.** Первые шесть кадров (fp1…fs3)
сгенерированы по исходной версии брифа, где рыжих было четыре; из них две
рыжие как раз fp3 и fs3, и они и есть весь лимит. Остальные шесть — только
блонд и брюнетка, ровно 3 и 3, что и даёт итоговые 5/5/2.

Одно следствие стоит назвать прямо: обе рыжие попали в полированный и
спортивный архетипы, поэтому из трёх общих локаций по цвету волос совпадает
**одна** — вечерняя улица (fc1/fa2, обе блонд). Пары «светлое кафе» (fp3/fa3)
и «сквер» (fs3/fc3) различаются и архетипом, и мастью, как и было в исходном
плане. Изоляция там держится на самой локации, а не на цвете.

Мужской набор не тронут — там цвет волос тёмные/светлые, рыжих нет вовсе.

Три локации на архетип, и три локации **общие** между архетипами (светлое
кафе, сквер/набережная, вечерняя улица) — чтобы архетип нельзя было опознать
по одному только фону. Это и есть страховка от «выучили предпочтение места и
назвали его типажом».

## Константы — одинаковы во всех 24 кадрах

Нарушение любой из них = кадр бракуется, даже если он красивый.

| Константа | Значение |
|---|---|
| Возраст | 22–28 (полоса A) |
| Внешность | восточноевропейская — держим постоянной, это не измеряемый признак |
| Кадрирование | три четверти, от середины бедра вверх, стоя или опираясь |
| Взгляд и лицо | прямо в камеру, одинаковая лёгкая искренняя улыбка |
| Руки | предплечья открыты — тату видно или его достоверно нет |
| Фон | мягко размыт, **посторонних людей в кадре нет** |
| Уровень привлекательности | одинаковый: «самый симпатичный человек за обычным столиком», не модель |
| Стрижка | названа конкретно — «короткая стрижка» без уточнения генератор отдаёт устаревшим вариантом, и на бородатом лице это читается дёшево |
| Регистр съёмки | «приподнятая реальность»: очень удачный настоящий кадр, не журнальная постановка |

**Правило отбраковки:** кадр, который выделяется красотой **как фотография** —
светом, композицией, постановкой — бракуется. Иначе дека меряет вкус к
фотографии, а не к человеку.

**Правило по тату-кадрам.** На кадре с татуировкой предплечье открыто **по
построению** — короткий рукав, футболка, подвёрнутый оверширт, — а не «рукава
подвёрнуты» поверх свитера или худи под пальто. Два слоя длинного рукава
генератор сводит к неловкой позе, и тату, ради которого кадр вообще
существует, теряется.

**Правило по композиции (найдено на первой партии мужских кадров).** При кропе
от середины бедра заправленная рубашка с ремнём кладёт **пряжку ровно в центр
кадра**, и глаз идёт на неё, а не на человека — кадр читается как каталог. Верх
обязан перекрывать пояс: пиджак, свитер, незаправленная рубашка, поло навыпуск.

**Отдельно про генератор:** Higgsfield устойчиво дорисовывает интерфейс сторис
Instagram (аватарка, «⋯», «✕», случайный ник) вопреки негативам. Такие кадры
не чинить ретушью — перегенерировать.

## Регистр съёмки: почему у наборов разные хвосты (переписано 2026-08-24)

Первый хвост говорил `standing, facing camera` — это **и есть каталожная поза**.
Человек, который просто стоит лицом в камеру внутри локации, ничего в ней не
делает, и кадр читается съёмкой для посредственного бренда одежды. Отсюда и
«не соответствует контексту»: локация оказывалась декорацией, а не местом, где
он находится по делу.

Три причины «ИИшности», все три были в хвосте:

- **поза.** Нет действия — нет контекста. Заменено на «пойман в движении и
  только что повернулся к камере»: он занят тем, что это место подразумевает,
  и отвлёкся на снимающего.
- **`softly blurred background`.** Фон замыливался в кашу, то есть тот самый
  контекст стирался. Теперь «мягко, но читаемо».
- **`warm natural light` на каждом кадре.** Одинаковое золотистое свечение
  везде — главный признак бренд-съёмки. Свет теперь называется по локации
  честно: жёсткое дневное солнце на корте, холодный верхний в зале, вывески и
  фонари на вечерней улице.

Плюс из хвоста ушли `elevated` и `photorealistic` (первое тянет в editorial,
второе даёт пластиковую кожу) и добавлены зерно, обычная текстура кожи и
лёгкое движение.

**Женский набор остаётся на СТАРОМ хвосте.** Шесть из двенадцати женских кадров
(fp1…fs3) уже сняты по нему, а внутри набора важна одна фотографическая манера:
пользователь всегда видит только свой набор целиком, так что разница между
наборами не видна никому, а разрыв внутри набора виден сразу. Если новая манера
понравится на мужских — переснимаем женский набор целиком, а не половину.

### Хвост v3 — ПОЗИРОВАНИЕ (пересъём 2026-08-26)

Единый для обоих наборов. Им снимаются девять пересъёмных кадров; пятнадцать
принятых остаются на своих старых хвостах ниже.

```
a photo they would post on their own feed — posing for the camera on purpose,
relaxed and self-aware, a warm genuinely good-looking face with real bone
structure, body angled with the weight on one leg, turned to the camera and
looking into the lens with a relaxed half-smile, shot from a few steps back so
their whole upper body and hips sit in the frame with room around them, both
forearms bare and in frame, alone in frame, a beautiful place behind them kept
soft and out of focus, real available light, faint natural grain, ordinary skin
texture, vertical 9:16
--no profile, no looking away, no face turned from the camera, close-up,
headshot, portrait crop, tight crop, forced grin, wide toothy smile, full body,
feet in frame, posed catalogue stance, lookbook, product photography, model casting,
studio lighting, fashion editorial, retouched plastic skin, androgynous,
feminine features, soft jawline, other people, passers-by in the background,
readable text, signage lettering, logos, watermark, instagram ui, story
interface, username, phone screen overlay, mirror selfie, sunglasses, hat,
heavy filter, exaggerated body proportions
```

**Слово `tattoo` НИКОГДА не пишется в позитиве — ни с «no», ни с чем угодно.**
Это моя ошибка первого захода, и она стоила двух браков: в промптах карточек
«без тату» стояло `with no tattoos`, а в негативах слова `tattoo` не было
вообще — то есть модель видела токен «tattoos» **только** как то, что надо
нарисовать. Диффузия не отрицает: «no X» в позитиве работает как «X». Прямое
доказательство — ms1, чей промпт просил `bare forearms with no tattoos` и
вернулся с татуировкой на плече.

Поэтому: **у карточки «без тату» слово из позитива убирается совсем**
(предплечья описываются нейтрально — «sleeves rolled up his bare forearms»), а
в конец негатива добавляется

```
tattoo, tattoos, tattoo sleeve, inked arms, ink on skin
```

**У тату-карточки этой строки в негативе быть не должно** — там тату описывается
в позитиве подробно и отдельным предложением, как на ms2.

**Кадр задаётся расстоянием, а не долей тела.** `from mid-thigh up` ничего не
ограничивает у **сидящего** героя: середина бедра у него на уровне столешницы,
и кадр честно схлопывается в поясной. Так вышли ma3, fa1 и ma1 — все трое
сидят. Работает `shot from a few steps back … with room around them`, потому что
это инструкция камере, а не анатомии.

**Улыбка — половинчатая, а не «до глаз».** `a smile that reaches the eyes`
тянет в широкую улыбку с зубами, и на статике она читается натянутой. Просить
надо `relaxed half-smile`, а `forced grin, wide toothy smile` держать в негативе.

**Привлекательность впервые доехала до генератора.** Константа «самый
симпатичный человек за обычным столиком» была записана в разделе констант и **ни
разу не попадала ни в один промпт** — модель её не видела. Теперь она в хвосте
одной фразой.

**Почему `caught mid-action` выброшено.** Хвост 2026-08-24 просил одновременно
«поймали за делом» и «смотрит в объектив», и генератор разрешал конфликт в
пользу действия: сохранял занятие и выбрасывал взгляд. Из двенадцати мужских
кадров семь вышли в профиль, с опущенными глазами или с лицом за чашкой — то
есть карточка, чья единственная работа показать лицо, лица не показывала.
Позирование снимает конфликт в корне: человек, который позирует, смотрит в
камеру по определению.

**Это НЕ возврат к каталожной позе** (решение фаундера 2026-08-26). Каталожная
поза — стойка анфас, руки по швам, нейтральное лицо, продаётся одежда. Здесь
человек **сознательно снимается для своей ленты**: корпус вполоборота, вес на
одной ноге, рука в кармане / на ремне сумки / на перилах, тёплая улыбка. Все
каталожные негативы остались на месте.

**Локация обязана быть красивой и узнаваемой** — «инстаграмное место», а не
просто функционально верное. Индустриальный канал с сухой травой, серая улица
и угол зала с лампами дневного света формально подходили под ячейку и убивали
кадр. И фон больше не размывается в кашу: он **мягкий, но читаемый**, иначе
локация перестаёт быть локацией.

**Кадрирование зажато с двух сторон** — `from mid-thigh up` в позитиве и
`full body, feet in frame` в негативе. В первом наборе кадр гулял втрое (от
полного роста до крупного бюста), а лицо втрое крупнее на одних карточках, чем
на других, — это смещение оценки, а не эстетика.

### Хвост для МУЖСКОГО набора (историч. — им сняты mp1, mp2, ms3, mc2, ma2)

```
candid lifestyle photo taken by a friend on a phone, caught mid-action and just
turned to the camera, real eye contact, an unforced smile that reaches the eyes,
framed from the waist or mid-thigh up with both forearms in frame, alone in
frame, the place behind him soft but still readable, real available light, faint
natural grain, ordinary skin texture, a little motion in the hands or clothes,
vertical 9:16
--no posed catalogue stance, lookbook, product photography, model casting,
studio lighting, fashion editorial, retouched plastic skin, other people, text,
logos, watermark, instagram ui, story interface, username, phone screen overlay,
mirror selfie, sunglasses, hat, heavy filter, exaggerated body proportions,
androgynous, feminine features, soft jawline
```

**Правило действия (мужской набор).** У каждого кадра названо конкретное
занятие, которое эта локация подразумевает, и он от него отвлёкся. Не «стоит в
кафе», а «повернулся от стойки со стаканом». Занятие обязано быть правдоподобным
для архетипа: полированный в кафе — гость, а не бариста.

**Что действие НЕ имеет права делать.** Оно может нести архетип (это нормально,
архетип и должен читаться) и не может коррелировать со вторичным признаком —
цветом волос, бородой, тату. Иначе «выучили занятие и назвали его типажом».

### Хвост для ЖЕНСКОГО набора (историч. — им сняты десять принятых женских кадров)

```
candid smartphone-style portrait, three-quarter view from mid-thigh up,
standing, facing camera, direct eye contact, light genuine warm smile,
natural everyday makeup, forearms clearly visible, softly blurred background,
no other people in frame, warm natural light, shallow depth of field,
photorealistic, elevated but believable — a very good photo taken by a friend,
not a magazine shoot, vertical 9:16
--no text, logos, watermark, instagram ui, story interface, username,
phone screen overlay, mirror selfie, sunglasses, hat, heavy filter,
studio lighting, fashion editorial, exaggerated body proportions
```

---

# ЖЕНСКИЙ НАБОР — 12 кадров

| id | архетип | волосы | длина | тату | локация |
|---|---|---|---|---|---|
| fp1 | полированная | блонд | длинные | нет | терраса гольф-клуба |
| fp2 | полированная | брюнетка | каре | нет | лобби отеля |
| fp3 | полированная | рыжая | длинные | **да** | светлое кафе |
| fs1 | спортивная | брюнетка | длинные | нет | теннисный корт |
| fs2 | спортивная | блонд | каре | **да** | набережная утром |
| fs3 | спортивная | рыжая | каре | нет | сквер |
| fc1 | городская | блонд | длинные | нет | вечерняя улица |
| fc2 | городская | блонд | каре | нет | книжный-кофейня |
| fc3 | городская | брюнетка | длинные | **да** | сквер |
| fa1 | творческая | брюнетка | каре | нет | винный бар |
| fa2 | творческая | блонд | каре | **да** | вечерняя улица |
| fa3 | творческая | брюнетка | длинные | нет | светлое кафе |

### fp1 — полированная · блонд · длинные · без тату · гольф-клуб

**Вайб.** Собранность и «дорого-просто». Не нарядность и не статус напоказ —
качество ткани и посадка вещей. Человек, который так выглядит в обычный вторник.

**Промпт.** `a 24-year-old Eastern European woman with long blonde hair below
the shoulders, wearing a cream cashmere sweater and tailored camel trousers,
delicate thin gold jewellery, muted palette, standing on the terrace of a golf
club with a manicured green blurred behind her,` + женский хвост.

**Проверить.** Палитра приглушённая, без ярких цветов и принтов. Блонд
однозначный, не русый. Предплечья чистые. Не читается как «вышла в свет» —
читается как «одета хорошо».

### fp2 — полированная · брюнетка · каре · без тату · лобби отеля

**Вайб.** Тот же регистр, холоднее и современнее — ближе к минимализму. Внутри
архетипа это вариант исполнения, а не отдельная ячейка.

**Промпт.** `a 24-year-old Eastern European woman with a dark chin-length bob,
wearing a simple well-cut midi dress in a muted tone with a small structured
handbag, standing in a quiet classic hotel lobby with warm lamps blurred
behind her,` + женский хвост.

**Проверить.** Каре аккуратное и тёмное. Платье простое, без декора и блеска.
Лобби читается тёплым и тихим, а не парадным.

### fp3 — полированная · рыжая · длинные · ТАТУ · светлое кафе

**Вайб.** Ключевой кадр деки: полированный образ с явной татуировкой. Он
расцепляет «собранность» и «тату» — в v1 они были склеены, и это была
методологическая ошибка.

**Промпт.** `a 24-year-old Eastern European woman with long natural copper-red
hair, wearing a crisp white shirt tucked into tailored trousers and a thin
gold chain, a visible dark tattoo sleeve on her forearm, standing in a bright
modern café with wood and concrete blurred behind her,` + женский хвост.

**Проверить.** **Тату — самый заметный элемент предплечья**, не тонкая
линия у плеча. Одежда при этом строго полированная: белая рубашка, брюки,
ничего «дерзкого». Рыжий натуральный медный, не крашеный морковный.

### fs1 — спортивная · брюнетка · длинные · без тату · корт

**Вайб.** Функциональная спортивная одежда, а не «спорт-шик». Человек реально
пришёл играть.

**Промпт.** `a 24-year-old Eastern European woman with long dark hair in a
ponytail, wearing a white tennis dress and clean white sneakers, holding a
racket, standing on a clay tennis court with the net blurred behind her,` +
женский хвост.

**Проверить.** Одежда рабочая, без логотипов и принтов. Хвост, а не укладка.
Корт читается однозначно.

### fs2 — спортивная · блонд · каре · ТАТУ · набережная

**Вайб.** Утро, движение, минимум усилий во внешности. Тату здесь — вторичный
признак, не часть образа.

**Промпт.** `a 24-year-old Eastern European woman with a blonde chin-length
bob, wearing fitted athleisure leggings and a cropped training top with a
light windbreaker tied at the waist, a visible tattoo sleeve on her forearm,
standing on a river embankment in the morning with water blurred behind her,` +
женский хвост.

**Проверить.** Тату видно отчётливо. Образ остаётся спортивным — ничего
кожаного, ничего чёрно-дерзкого, иначе кадр съедет в творческий архетип.

### fs3 — спортивная · рыжая · каре · без тату · сквер

**Вайб.** Спорт на воздухе, тёплый свет. Локация общая с городским архетипом
(fc3) — намеренно. Второй и последний рыжий кадр набора.

**Промпт.** `a 24-year-old Eastern European woman with a copper-red chin-length
bob, wearing a simple sports top and shorts with running shoes, standing in a
European city park at golden hour with trees blurred behind her,` + женский хвост.

**Проверить.** Предплечья чистые. Одежда спортивная функциональная.
Золотой час не должен превратить кадр в постановочный.

### fc1 — городская · блонд · длинные · без тату · вечерняя улица

**Пересъём 2026-08-26.** Первый кадр — ровно та «модельная съёмка», за которую был
забракован мужской набор: пустой холодный взгляд без улыбки, руки утоплены в
оверсайз-джинсовку (ячейка «без тату» не наблюдаема), полный рост до кроссовок,
логотип Nike и прохожий в кадре. Улица переписана под **уже снятый fa2** — тот же
вечерний старый город.

**Промпт.** `a 24-year-old Eastern European woman, long blonde hair in loose waves,
natural everyday makeup, in a cream knit under an open denim jacket with the
sleeves pushed up her bare forearms and no tattoos, standing on a narrow old-town
street in the evening with one hand on the strap of her shoulder bag and her weight
on one hip, face fully to the lens with a warm genuine smile, warm lit shopfronts
and painted facades behind her kept soft and out of focus, warm evening light,`
+ хвост v3.

**Проверить.** **Улыбка есть** — это главная причина пересъёма. Предплечья открыты
из-под рукавов. От середины бедра, без обуви в кадре. Фон и свет **те же, что на
fa2**.

### fc2 — городская · блонд · каре · без тату · книжный-кофейня

**Вайб.** Тот же расслабленный регистр в помещении. Мягче, чем fc1.

**Промпт.** `a 24-year-old Eastern European woman with a blonde chin-length
bob, wearing a knit cardigan over a simple top with wide jeans and a canvas
bag, standing in a bookshop café with shelves blurred behind her,` + женский хвост.

**Проверить.** Кардиган и джинсы читаются как повседневное, а не как
«полированное». Полки размыты, текст на корешках нечитаем.

### fc3 — городская · брюнетка · длинные · ТАТУ · сквер

**Вайб.** Повседневный образ с татуировкой. Второй кадр, расцепляющий тату и
«альтернативность».

**Промпт.** `a 24-year-old Eastern European woman with long dark hair, wearing
an oversized blazer over a plain tee with jeans and loafers, a visible tattoo
sleeve on her forearm, standing in a European city park at golden hour with
trees blurred behind her,` + женский хвост.

**Проверить.** Тату отчётливое. Пиджак-оверсайз читается как городской
casual, а не как офис. Локация та же, что у fs3 — это проверяемо и должно
совпадать по типу сквера.

### fa1 — творческая · брюнетка · каре · без тату · винный бар

**Пересъём 2026-08-26.** Та же болезнь, что у fc1: ноль улыбки, тяжёлая
стилизация «всё чёрное», рукава косухи до костяшек — предплечий нет, ячейка «без
тату» не наблюдаема. Бар оставлен, поза переписана на инстаграмную — за стойкой,
корпус к камере.

**Промпт.** `a 26-year-old Eastern European woman, dark hair in a sharp
chin-length bob, natural everyday makeup, in a black silk shirt with the sleeves
rolled to the elbow, bare forearms with no tattoos, sitting at the counter of a
small candlelit wine bar with one forearm on the bar and a glass of red beside her,
leaning slightly toward the camera, face fully to the lens with a warm genuine
smile, wine bottles and hanging glasses behind her, warm low lamplight,`
+ хвост v3.

**Проверить.** Улыбка есть, взгляд в объектив. Предплечья открыты и чистые.
Уровень привлекательности — «самая симпатичная за обычным столиком», не модель.

### fa2 — творческая · блонд · каре · ТАТУ · вечерняя улица

**Вайб.** Полный альтернативный образ: и одежда, и тату. Локация общая с fc1.

**Промпт.** `a 24-year-old Eastern European woman with a blonde chin-length
bob, wearing a vintage patterned shirt layered over a tee with silver
jewellery, a visible tattoo sleeve on her forearm, standing on an old-town
street in the evening with warm shop lights blurred behind her,` + женский хвост.

**Проверить.** Слои читаются, не сливаются в одно пятно. Тату видно.

### fa3 — творческая · брюнетка · длинные · без тату · светлое кафе

**Вайб.** Альтернативный образ в дневном свете и в «полированной» локации
(та же, что у fp3). Это самая полезная пара деки: одно место, противоположный
архетип, противоположное тату.

**Промпт.** `a 24-year-old Eastern European woman with long dark hair,
wearing a dark oversized overshirt with layered chains and chunky boots,
standing in a bright modern café with wood and concrete blurred behind her,`
+ женский хвост.

**Проверить.** Предплечья чистые. Кафе — то же самое, что на fp3.

---

# МУЖСКОЙ НАБОР — 12 кадров

| id | архетип | волосы | борода | тату | локация |
|---|---|---|---|---|---|
| mp1 | полированный | тёмные | бритый | нет | терраса гольф-клуба |
| mp2 | полированный | светлые | борода | нет | фойе театра |
| mp3 | полированный | тёмные | борода | **да** | светлое кафе |
| ms1 | спортивный | тёмные | борода | нет | теннисный корт |
| ms2 | спортивный | светлые | бритый | **да** | зал |
| ms3 | спортивный | тёмные | бритый | нет | набережная |
| mc1 | городской | тёмные | бритый | нет | вечерняя улица |
| mc2 | городской | светлые | борода | **да** | книжный-кофейня |
| mc3 | городской | тёмные | бритый | нет | набережная |
| ma1 | творческий | тёмные | бритый | **да** | винный бар |
| ma2 | творческий | светлые | борода | нет | вечерняя улица |
| ma3 | творческий | тёмные | борода | нет | светлое кафе |

**mp1 и mp2 сняты по СТАРОМУ хвосту** и остаются как есть — фаундер их принял.
Цена названа прямо: остальные десять будут в заметно более живой манере, так что
внутри набора получится два регистра. Если новые кадры читаются лучше, эти два
переснимаются по мужскому хвосту последними — это два кадра, а не двенадцать.

### mp1 — полированный · тёмные · бритый · без тату · гольф-клуб

**Вайб.** Old money как регистр: лён, кожа, ткань. Не костюм и не «успешный
успех».

**Промпт.** `a 25-year-old Eastern European man with short dark hair, clean
shaven, wearing a navy polo and tailored trousers with a leather-strap watch
and loafers, standing on the terrace of a golf club with a manicured green
blurred behind him,` + старый общий хвост (кадр снят, не перегенерировать без нужды).

**Проверить.** Ноль логотипов. Часы на кожаном ремешке, не спортивные.
Предплечья чистые.

### mp2 — полированный · светлые · борода · без тату · фойе театра

**Вайб.** Тот же регистр с бородой, вечером и в единственной архитектурной
локации набора. Человек **куда-то собрался**, а не отдыхает — это и отличает
его от mp1 (дневная терраса) и mp3 (дневное кафе), у которых иначе получается
три одинаковых тёплых интерьера подряд.

Предыдущая версия (лён + чиносы + лаунж яхт-клуба) забракована фаундером:
бежевое на бежевом без единого контраста, анонимный коричневый фон без
архитектуры, пряжка ремня в центре кадра — и генератор устойчиво старил лицо
до 32–38, потому что лаунж яхт-клуба это комната сорокалетнего.

**Промпт.** `a 24-year-old Eastern European man with light brown hair swept
back and short at the sides, and a short neat beard, wearing an unstructured
navy blazer over a plain white shirt
with an open collar and no tie, dark trousers, standing in the foyer of an old
theatre before the performance with a marble staircase and warm wall lamps
blurred behind him,` + старый общий хвост (кадр снят, не перегенерировать без нужды).

**Проверить.** **Ни галстука, ни платка в кармане** — с ними кадр читается как
свадьба, а не как вечер. Пиджак мягкий, не костюмный. Тёмный верх на светлой
рубашке — единственный контраст в кадре, без него полированный архетип
сливается в бежевое поле. Борода короткая и ухоженная. Рядом с mp1 и mp3 он не
должен выглядеть старше.

### mp3 — полированный · тёмные · борода · ТАТУ · светлое кафе

**Пересъём 2026-08-26.** Первый кадр снят в профиль — лицо не читается вовсе.
Кафе было уличной кофейной стойкой; теперь это то же светлое кафе, что у ma3,
**дословно тем же предложением**, чтобы пара снова изолировала архетип.

**Промпт.** `a 25-year-old Eastern European man, dark hair in a short textured
crop, short neat beard, in a dark green fine-knit short-sleeve polo worn untucked
over tailored trousers, a tattoo sleeve down his bare forearm, standing with one
hand in his pocket and a paper cup in the other, weight on one leg, body angled
and face fully to the lens with an easy smile, in a bright modern speciality café with a marble counter, hanging plants and big daylight windows behind him, soft daylight from the window,` + хвост v3.

**Проверить.** Лицо анфас. Тату на открытом предплечье. Фон и свет **дословно те
же, что на ma3**.

### ms1 — спортивный · тёмные · борода · без тату · корт

**Пересъём 2026-08-26.** На первом кадре глаза опущены, лица и выражения нет, плюс
логотип Adidas во всю грудь. Корт переписан в клубный — кипарисы, белый забор,
позднее солнце: то же «инстаграмное место», просто спортивное.

**Промпт.** `a 24-year-old Eastern European man, dark hair in a short textured crop
damp at the temples, short beard, in a plain white tennis tee and shorts, bare
forearms with no tattoos, standing at the net of a clay tennis club court with the
racket resting on his shoulder, weight on one leg, face fully to the lens with an
easy smile, cypress trees and a white fence behind him kept soft and out of focus,
warm late afternoon sun,` + хвост v3.

**Проверить.** Взгляд в объектив, а не под ноги. Форма без логотипов. Предплечья
открыты и чистые.

### ms2 — спортивный · светлые · бритый · ТАТУ · зал

**Пересъём 2026-08-26.** Первый кадр — **брак по измеряемой ячейке**: тату нет
вообще, предплечья чистые, а карточка объявлена тату-карточкой. Плюс снят со
спины через плечо. Тату здесь описано отдельным, подробным предложением, потому
что это единственная ячейка, ради которой карточка существует; зал переписан из
угла с лампами дневного света в бутиковую студию — это и есть «инстаграмное
место» для спортивного архетипа.

**Промпт.** `a 26-year-old Eastern European man, light brown hair in a short
textured crop, clean shaven, in a plain black training tee, a dense black-and-grey
tattoo sleeve covering his whole right forearm from wrist to elbow, standing in a
warm boutique gym with wooden floors, plants and big daylight windows, one forearm
resting on a dumbbell rack and a towel over his shoulder, weight on one leg, body
angled to the camera, face fully to the lens with an easy smile, soft daylight,`
+ хвост v3.

**Проверить.** **Тату видно, и оно занимает всё предплечье** — если его нет или
оно на кисти, кадр бракуется без обсуждения. Лицо в объектив. Зал тёплый, а не
подвальный.

### ms3 — спортивный · тёмные · бритый · без тату · набережная

**Вайб.** Бег утром. Локация общая с городским архетипом (mc3). Занятие:
только закончил пробежку, вынимает наушник.

**Переписан 2026-08-25.** Первая версия читалась женственно, и причина была не в
одной детали, а в том, что ВСЕ мягкие оси сошлись на одном кадре: `loose waves`
(модель тянет это в женскую укладку) + бритое лицо + мягкая поза с двумя
предплечьями на перилах + смех + низкое тёплое солнце. Ячейки трогать нельзя
(тёмные / бритый / без тату / набережная), поэтому переписаны стрижка, поза и
выражение; свет остаётся прежним, потому что он общий с mc3.

**Промпт.** `a 25-year-old Eastern European man, dark hair cut short at the sides
and pushed back off his forehead, damp with sweat, clean shaven with a squared
jaw, in a plain navy running tee damp at the chest and across the shoulders,
wired earphones hanging around his neck, standing upright with one hand on the
embankment railing and the other just pulling an earphone out of his ear, still
breathing hard from the run and just turned to the camera, the river and the far
bank behind him, low early sun off the water,` + мужской хвост.

**Запасной образ**, если первый всё ещё мягкий: `a 25-year-old Eastern European
man, dark hair cut short at the sides and pushed back off his forehead, damp with
sweat, clean shaven, in a plain navy running tee stuck to his chest, standing at
the embankment railing with both hands on his hips and his elbows out, chest
still heaving after a hard run, head just turned to the camera, the river and the
far bank behind him, low early sun off the water,` + мужской хвост.

**Проверить.** Стоит прямо, не облокотившись — вес на ногах, а не на перилах.
Волосы влажные и функциональные, не уложенные. Предплечья чистые и оба в кадре
(одно на перилах, второе поднято к уху). Свет и фон **дословно те же, что на
mc3**.

**Следствие для разброса стрижек.** `loose waves` остаётся только у mc2 и ma2,
то есть у двух архетипов из четырёх. Стрижка не входит в измеряемое
пространство признаков (там цвет волос, борода, тату), так что на подсчёт
предпочтений это не влияет — но если захочется вернуть разброс, дешевле всего
перевести mp3 с `short textured crop` на `loose waves`: он бородатый, так что
женственно не прочитается.

### mc1 — городской · тёмные · бритый · без тату · вечерняя улица

**Пересъём 2026-08-26.** На первом кадре мёртвое выражение, щетина при ячейке
«бритый», серый дневной свет вместо вечера и кракозябры вместо вывески. Улица
переписана под **уже снятый ma2** — ночь, тёплые витрины, мокрая мостовая.

**Промпт.** `a 24-year-old Eastern European man, dark hair in a short textured
crop, completely clean shaven with no stubble, in a dark bomber jacket open over a
plain white tee with the sleeves pushed up his bare forearms and no tattoos,
standing on a narrow old-town street at night with one shoulder against a doorway
and his hands loose at his sides, face fully to the lens with an easy smile, warm lit shopfronts and wet cobbles behind him kept soft and out of focus, shop light and streetlight,`
+ хвост v3.

**Проверить.** **Ни щетины** — на первом кадре она и сломала ячейку. Вечер, а не
день. Вывески мягкие и нечитаемые. Фон и свет **те же, что на ma2**.

### mc2 — городской · светлые · борода · ТАТУ · книжный-кофейня

**Вайб.** Повседневный образ с татуировкой — расцепляет тату и творческий
архетип. Занятие: стоит у полки с раскрытой книгой, поднял глаза.

**Промпт.** `a 26-year-old Eastern European man, light brown hair grown out into
loose waves, short beard, in an open overshirt with the sleeves rolled to the
elbow over a plain tee, a tattoo sleeve down his bare forearm, standing at a
shelf in a bookshop café with an open book in one hand, just looked up from the
page, shelves and the coffee counter behind him, warm lamps and daylight from
the window,` + мужской хвост.

**Проверить.** Книга **раскрыта** и он от неё отвлёкся — закрытая книга в руке
читается реквизитом. Предплечье открыто, тату видно целиком: худи под пальто
здесь было ошибкой того же класса, что свитер на mp3. Текст на корешках
нечитаем.

### mc3 — городской · тёмные · бритый · без тату · набережная

**Пересъём 2026-08-26.** Первый кадр — полный профиль на индустриальном канале с
сухой травой: и лица нет, и локация не та, что у ms3, так что пара разъехалась.
Фон переписан под **уже снятый ms3** — каменная набережная, река, тёплое низкое
солнце.

**Промпт.** `a 25-year-old Eastern European man, dark hair swept back and short at
the sides, clean shaven, in a charcoal overshirt open over a fine knit with the
sleeves pushed up his bare forearms and no tattoos, standing with his back against
a stone embankment railing, both forearms resting back on it, one ankle crossed
over the other, face fully to the lens with an easy smile, the stone river embankment and the far bank behind him, low warm sun off the water,` + хвост v3.

**Проверить.** Лицо анфас. Вода и дальний берег позади — **та же набережная и тот
же тёплый низкий свет, что на ms3**, а не канал.

### ma1 — творческий · тёмные · БРИТЫЙ · ТАТУ · винный бар

**Пересъём 2026-08-26, и только из-за бороды.** Первый кадр — лучший во всём
наборе (живой смех, настоящий контакт глазами, тату на обоих предплечьях, тёплый
свет), но он бородатый при ячейке «бритый». Менять ячейку нельзя: у творческого
тогда все трое бородатые, и борода начинает коррелировать с архетипом — ровно та
спутанность, ради устранения которой затевалась v2. Локация, свет, поза и одежда
сохранены дословно; меняется одно лицо.

**Промпт.** `a 27-year-old Eastern European man, dark hair grown out into loose
waves off his forehead, completely clean shaven with no stubble at all, a smooth
jaw and chin, in a black overshirt open over a white tee with a couple of silver
rings and the sleeves rolled to the elbow, tattoo sleeves down both bare forearms,
sitting at the counter of a small candlelit wine bar with wine bottles and hanging
glasses behind him and a glass of red beside him, one forearm on the bar, leaning
slightly toward the camera, face fully to the lens, laughing, warm low lamplight,`
+ хвост v3.

**Проверить.** **Ни бороды, ни щетины** — это единственная причина пересъёма.
Тату на обоих предплечьях. Смех настоящий, как на первом кадре.

### ma2 — творческий · светлые · борода · без тату · вечерняя улица

**Вайб.** Альтернативность **без** татуировки: только одежда и слои. Занятие:
выходит из бара, смеётся.

**Промпт.** `a 26-year-old Eastern European man, light brown hair grown out into
loose waves, short beard, in a worn leather jacket open over a striped tee with
the sleeves pushed up his bare forearms and a couple of silver rings, stepping
out of a bar doorway onto the street mid-laugh and just turned to the camera,
lit shopfronts and wet pavement behind him, shop signs and streetlight,` +
мужской хвост.

**Проверить.** Предплечья **абсолютно чистые** — и при этом видны, иначе кадр
молчит о тату. Дерзость даёт потёртая кожа, полоска и серебро, а не чёрная
футболка. Фон и свет дословно те же, что на mc1.

### ma3 — творческий · тёмные · борода · без тату · светлое кафе

**Пересъём 2026-08-28, второй заход.** Первый заход (лицо за чашкой) и второй
(татуировки на половине генераций, поясной кадр, натянутая улыбка) провалились по
трём разным причинам, и все три — мои:

1. **`no tattoos` в позитиве рисовало тату.** Слово убрано из позитива совсем,
   тату уехало в негатив. См. правило в хвосте v3.
2. **Сидящая поза не поддаётся `from mid-thigh up`.** Герой поставлен к стойке —
   как на mp3, который из всей пересъёмки вышел лучшим и снят в этом же кафе.
   Это заодно усиливает изолирующую пару: одинаковая композиция при разных
   архетипах — ровно то, ради чего пара существует.
3. **Лицо было никакое, потому что генератор о привлекательности не просили.**
   Теперь просят — фразой в хвосте.

**Промпт.** `a 25-year-old Eastern European man with a warm genuinely handsome
face, dark hair grown out into loose waves, a short beard, in a soft corduroy
overshirt open over a white tee with the sleeves rolled up his bare forearms,
standing and leaning back against the marble counter with a flat white in one
hand and the other hand in his pocket, weight on one leg, turned to the camera
with a relaxed half-smile, in a bright modern speciality café with a marble
counter, hanging plants and big daylight windows behind him, soft daylight from
the window,` + хвост v3 **+ в негатив** `tattoo, tattoos, tattoo sleeve, inked
arms, ink on skin`.

**Проверить.** Предплечья открыты и **чистые** — это одна из немногих оставшихся
наблюдаемых карточек «без тату» в мужском наборе, после mc1 запаса нет. Кадр от
пояса и шире, не поясной портрет. Улыбка спокойная, не оскал. Фон и свет **те
же, что на mp3**.

## Приёмка: что проверяем на всём наборе, а не покадрово

1. **Архетипы различимы.** Взять по одному кадру каждого архетипа и спросить
   человека со стороны, к какой из четырёх групп он относится. Если путает —
   ячейки схлопнутся, и вся дека бессмысленна.
2. **Уровень привлекательности ровный.** Разложить 12 кадров набора рядом.
   Если один заметно красивее — перегенерировать: иначе меряем красоту, а не
   направление вкуса.
3. **Тату ровно на 4 кадрах каждого набора**, и на каждом из них оно
   **заметнее всего остального на предплечье**. Слабое тату у плеча = брак
   (в v1 так вышло с f11).
4. **Локация не выдаёт архетип.** Три общие локации обязаны быть узнаваемо
   одинаковыми в парах: fp3/fa3, fs3/fc3, fc1/fa2, mp3/ma3, ms3/mc3, mc1/ma2.
   В мужском наборе фон И свет в паре описаны **дословно одинаково** — сверить
   построчно; разный свет на одной локации превращает пару в замер погоды.
   В женском наборе по цвету волос совпадает только пара fc1/fa2 (обе блонд) —
   остальные две различаются и мастью, потому что обе рыжие уже сняты в
   полированном и спортивном архетипах.
5. **Ни одного зеркального селфи, ни одного интерфейса сторис, ни одного
   постороннего человека.**
6. **Все 24 в 9:16.**
7. **Рыжих ровно две** — fp3 и fs3 (обе уже сняты); блонд и брюнеток по пять.
   Не «выравнивать» обратно в 4/4/4: почему — в разделе «Что мы вообще
   измеряем».
8. **Каждый мужской кадр отвечает на вопрос «что он делает».** Если ответ
   «стоит и смотрит в камеру» — брак, даже если кадр красивый: это ровно то, из-за
   чего первый заход читался съёмкой для бренда одежды.
9. **Занятие не коррелирует со вторичным признаком.** Пробежаться глазами по
   четырём тату-кадрам (mp3, ms2, mc2, ma1) и убедиться, что их занятия ничем
   не похожи друг на друга больше, чем на остальные восемь.
