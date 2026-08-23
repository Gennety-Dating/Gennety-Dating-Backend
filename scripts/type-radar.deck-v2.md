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

Побочно это **улучшило** изоляцию: все три общие локации теперь совпадают и по
цвету волос (fp3/fa3 рыжие, fs3/fc3 брюнетки, fc1/fa2 блонд), так что внутри
пары различается ровно архетип. Мужской набор не тронут — там цвет волос
тёмные/светлые, рыжих нет вовсе.

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
| Регистр съёмки | «приподнятая реальность»: очень удачный настоящий кадр, не журнальная постановка |

**Правило отбраковки:** кадр, который выделяется красотой **как фотография** —
светом, композицией, постановкой — бракуется. Иначе дека меряет вкус к
фотографии, а не к человеку.

**Отдельно про генератор:** Higgsfield устойчиво дорисовывает интерфейс сторис
Instagram (аватарка, «⋯», «✕», случайный ник) вопреки негативам. Такие кадры
не чинить ретушью — перегенерировать.

## Общий хвост промпта (добавлять к каждому)

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
| fs3 | спортивная | брюнетка | каре | нет | сквер |
| fc1 | городская | блонд | длинные | нет | вечерняя улица |
| fc2 | городская | блонд | каре | нет | книжный-кофейня |
| fc3 | городская | брюнетка | длинные | **да** | сквер |
| fa1 | творческая | брюнетка | длинные | нет | винный бар |
| fa2 | творческая | блонд | каре | **да** | вечерняя улица |
| fa3 | творческая | рыжая | каре | нет | светлое кафе |

### fp1 — полированная · блонд · длинные · без тату · гольф-клуб

**Вайб.** Собранность и «дорого-просто». Не нарядность и не статус напоказ —
качество ткани и посадка вещей. Человек, который так выглядит в обычный вторник.

**Промпт.** `a 24-year-old Eastern European woman with long blonde hair below
the shoulders, wearing a cream cashmere sweater and tailored camel trousers,
delicate thin gold jewellery, muted palette, standing on the terrace of a golf
club with a manicured green blurred behind her,` + общий хвост.

**Проверить.** Палитра приглушённая, без ярких цветов и принтов. Блонд
однозначный, не русый. Предплечья чистые. Не читается как «вышла в свет» —
читается как «одета хорошо».

### fp2 — полированная · брюнетка · каре · без тату · лобби отеля

**Вайб.** Тот же регистр, холоднее и современнее — ближе к минимализму. Внутри
архетипа это вариант исполнения, а не отдельная ячейка.

**Промпт.** `a 24-year-old Eastern European woman with a dark chin-length bob,
wearing a simple well-cut midi dress in a muted tone with a small structured
handbag, standing in a quiet classic hotel lobby with warm lamps blurred
behind her,` + общий хвост.

**Проверить.** Каре аккуратное и тёмное. Платье простое, без декора и блеска.
Лобби читается тёплым и тихим, а не парадным.

### fp3 — полированная · рыжая · длинные · ТАТУ · светлое кафе

**Вайб.** Ключевой кадр деки: полированный образ с явной татуировкой. Он
расцепляет «собранность» и «тату» — в v1 они были склеены, и это была
методологическая ошибка.

**Промпт.** `a 24-year-old Eastern European woman with long natural copper-red
hair, wearing a crisp white shirt tucked into tailored trousers and a thin
gold chain, a visible dark tattoo sleeve on her forearm, standing in a bright
modern café with wood and concrete blurred behind her,` + общий хвост.

**Проверить.** **Тату — самый заметный элемент предплечья**, не тонкая
линия у плеча. Одежда при этом строго полированная: белая рубашка, брюки,
ничего «дерзкого». Рыжий натуральный медный, не крашеный морковный.

### fs1 — спортивная · брюнетка · длинные · без тату · корт

**Вайб.** Функциональная спортивная одежда, а не «спорт-шик». Человек реально
пришёл играть.

**Промпт.** `a 24-year-old Eastern European woman with long dark hair in a
ponytail, wearing a white tennis dress and clean white sneakers, holding a
racket, standing on a clay tennis court with the net blurred behind her,` +
общий хвост.

**Проверить.** Одежда рабочая, без логотипов и принтов. Хвост, а не укладка.
Корт читается однозначно.

### fs2 — спортивная · блонд · каре · ТАТУ · набережная

**Вайб.** Утро, движение, минимум усилий во внешности. Тату здесь — вторичный
признак, не часть образа.

**Промпт.** `a 24-year-old Eastern European woman with a blonde chin-length
bob, wearing fitted athleisure leggings and a cropped training top with a
light windbreaker tied at the waist, a visible tattoo sleeve on her forearm,
standing on a river embankment in the morning with water blurred behind her,` +
общий хвост.

**Проверить.** Тату видно отчётливо. Образ остаётся спортивным — ничего
кожаного, ничего чёрно-дерзкого, иначе кадр съедет в творческий архетип.

### fs3 — спортивная · брюнетка · каре · без тату · сквер

**Вайб.** Спорт на воздухе, тёплый свет. Локация общая с городским архетипом
(fc3) — намеренно.

**Промпт.** `a 24-year-old Eastern European woman with a dark brown chin-length
bob, wearing a simple sports top and shorts with running shoes, standing in a
European city park at golden hour with trees blurred behind her,` + общий хвост.

**Проверить.** Предплечья чистые. Одежда спортивная функциональная.
Золотой час не должен превратить кадр в постановочный. **Цвет волос тот же,
что у fc3** — пара по скверу изолирует архетип, а не масть.

### fc1 — городская · блонд · длинные · без тату · вечерняя улица

**Вайб.** Самый «обычный» архетип и, вероятно, самый населённый в реальном
пуле: расслабленно, современно, без усилия.

**Промпт.** `a 24-year-old Eastern European woman with long natural blonde hair,
wearing an oversized denim jacket over a plain tee with straight jeans and
white sneakers, minimal makeup, standing on an old-town street in the evening
with warm shop lights blurred behind her,` + общий хвост.

**Проверить.** Ничего спортивного и ничего дерзкого — ровно посередине.
Вечерний свет тёплый, не синий. **Цвет волос тот же, что у fa2** — пара по
вечерней улице изолирует архетип.

### fc2 — городская · блонд · каре · без тату · книжный-кофейня

**Вайб.** Тот же расслабленный регистр в помещении. Мягче, чем fc1.

**Промпт.** `a 24-year-old Eastern European woman with a blonde chin-length
bob, wearing a knit cardigan over a simple top with wide jeans and a canvas
bag, standing in a bookshop café with shelves blurred behind her,` + общий хвост.

**Проверить.** Кардиган и джинсы читаются как повседневное, а не как
«полированное». Полки размыты, текст на корешках нечитаем.

### fc3 — городская · брюнетка · длинные · ТАТУ · сквер

**Вайб.** Повседневный образ с татуировкой. Второй кадр, расцепляющий тату и
«альтернативность».

**Промпт.** `a 24-year-old Eastern European woman with long dark hair, wearing
an oversized blazer over a plain tee with jeans and loafers, a visible tattoo
sleeve on her forearm, standing in a European city park at golden hour with
trees blurred behind her,` + общий хвост.

**Проверить.** Тату отчётливое. Пиджак-оверсайз читается как городской
casual, а не как офис. Локация та же, что у fs3 — это проверяемо и должно
совпадать по типу сквера.

### fa1 — творческая · брюнетка · длинные · без тату · винный бар

**Вайб.** Альтернативность **без** татуировки: её создаёт исключительно
одежда и украшения. Прямая противоположность ошибке v1, где «edgy» был
чёрной футболкой, то есть отсутствием, а не образом.

**Промпт.** `a 24-year-old Eastern European woman with long dark brown hair,
wearing a black leather biker jacket over a plain top with silver rings and
layered necklaces and ankle boots, standing in a wine bar in the evening with
warm low light behind her,` + общий хвост.

**Проверить.** Предплечья **абсолютно чистые** — это принципиально.
Дерзость даёт косуха, серебро и ботинки. Плоская чёрная футболка = кадр
не работает.

### fa2 — творческая · блонд · каре · ТАТУ · вечерняя улица

**Вайб.** Полный альтернативный образ: и одежда, и тату. Локация общая с fc1.

**Промпт.** `a 24-year-old Eastern European woman with a blonde chin-length
bob, wearing a vintage patterned shirt layered over a tee with silver
jewellery, a visible tattoo sleeve on her forearm, standing on an old-town
street in the evening with warm shop lights blurred behind her,` + общий хвост.

**Проверить.** Слои читаются, не сливаются в одно пятно. Тату видно.

### fa3 — творческая · рыжая · каре · без тату · светлое кафе

**Вайб.** Альтернативный образ в дневном свете и в «полированной» локации
(та же, что у fp3). Это самая полезная пара деки: одно место, противоположный
архетип, противоположное тату — **и один и тот же цвет волос**, так что
различается ровно то, что мы меряем.

**Промпт.** `a 24-year-old Eastern European woman with a natural copper-red
chin-length bob, wearing a dark oversized overshirt with layered chains and
chunky boots, standing in a bright modern café with wood and concrete blurred
behind her,` + общий хвост.

**Проверить.** Предплечья чистые. Кафе — то же самое, что на fp3. Рыжий
натуральный медный, не крашеный морковный — **это один из двух рыжих кадров на
весь набор**, второй промах перегенерировать некому.

---

# МУЖСКОЙ НАБОР — 12 кадров

| id | архетип | волосы | борода | тату | локация |
|---|---|---|---|---|---|
| mp1 | полированный | тёмные | бритый | нет | терраса гольф-клуба |
| mp2 | полированный | светлые | борода | нет | лобби / яхт-клуб |
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

### mp1 — полированный · тёмные · бритый · без тату · гольф-клуб

**Вайб.** Old money как регистр: лён, кожа, ткань. Не костюм и не «успешный
успех».

**Промпт.** `a 25-year-old Eastern European man with short dark hair, clean
shaven, wearing a navy polo and tailored trousers with a leather-strap watch
and loafers, standing on the terrace of a golf club with a manicured green
blurred behind him,` + общий хвост.

**Проверить.** Ноль логотипов. Часы на кожаном ремешке, не спортивные.
Предплечья чистые.

### mp2 — полированный · светлые · борода · без тату · лобби / яхт-клуб

**Вайб.** Тот же регистр с бородой — борода не должна тянуть кадр в
«творческий» или «outdoors».

**Промпт.** `a 26-year-old Eastern European man with light brown hair and a
short neat beard, wearing a linen shirt with sleeves rolled up and chinos with
a leather belt, standing in a quiet yacht club lounge with warm lamps blurred
behind him,` + общий хвост.

**Проверить.** Борода короткая и ухоженная. Рубашка льняная, подвёрнутые
рукава открывают чистые предплечья.

### mp3 — полированный · тёмные · борода · ТАТУ · светлое кафе

**Вайб.** Полированный образ с татуировкой — мужской близнец fp3.

**Промпт.** `a 25-year-old Eastern European man with short dark hair and a
short neat beard, wearing a fine-knit sweater over a collared shirt with
tailored trousers, a visible tattoo sleeve on his forearm, standing in a
bright modern café with wood and concrete blurred behind him,` + общий хвост.

**Проверить.** Тату отчётливое и на предплечье. Образ строго полированный —
никакой кожи, никаких цепей.

### ms1 — спортивный · тёмные · борода · без тату · корт

**Вайб.** Пришёл играть, а не фотографироваться.

**Промпт.** `a 25-year-old Eastern European man with short dark hair and a
short beard, wearing a tennis polo and shorts with clean sneakers, holding a
racket, standing on a clay tennis court with the net blurred behind him,` +
общий хвост.

**Проверить.** Одежда функциональная, без логотипов. Предплечья чистые.

### ms2 — спортивный · светлые · бритый · ТАТУ · зал

**Вайб.** Зал, но **не зеркальное селфи** — стоит в стороне от снарядов,
снимает друг. В v1 два кадра ушли в зеркало ванной, это брак.

**Промпт.** `a 25-year-old Eastern European man with short light brown hair,
clean shaven, wearing a fitted training tee and joggers, a visible tattoo
sleeve on his forearm, standing in a modern gym away from the equipment with
machines blurred behind him,` + общий хвост.

**Проверить.** **Не зеркало, не телефон в кадре.** Тату видно. Тело не
преувеличено — обычный тренирующийся человек.

### ms3 — спортивный · тёмные · бритый · без тату · набережная

**Вайб.** Бег утром. Локация общая с городским архетипом (mc3).

**Промпт.** `a 25-year-old Eastern European man with short dark hair, clean
shaven, wearing a technical running jacket and shorts, standing on a river
embankment in the morning with water blurred behind him,` + общий хвост.

**Проверить.** Предплечья чистые. Куртка спортивная техническая, не городская.

### mc1 — городской · тёмные · бритый · без тату · вечерняя улица

**Вайб.** Самый обычный и, вероятно, самый населённый класс реального пула.

**Промпт.** `a 25-year-old Eastern European man with short dark hair, clean
shaven, wearing a bomber jacket over a plain tee with straight jeans and
sneakers, standing on an old-town street in the evening with warm shop lights
blurred behind him,` + общий хвост.

**Проверить.** Ни спорта, ни дерзости. Бомбер простой, однотонный.

### mc2 — городской · светлые · борода · ТАТУ · книжный-кофейня

**Вайб.** Повседневный образ с татуировкой — расцепляет тату и творческий
архетип.

**Промпт.** `a 26-year-old Eastern European man with light brown hair and a
short beard, wearing a hoodie under an unstructured coat with jeans, a visible
tattoo sleeve on his forearm, standing in a bookshop café with shelves blurred
behind him,` + общий хвост.

**Проверить.** Тату видно (рукава подвёрнуты). Образ остаётся повседневным,
без серебра и ботинок.

### mc3 — городской · тёмные · бритый · без тату · набережная

**Вайб.** Дневной город. Та же локация, что у ms3, — проверяемая пара
«спортивный против повседневного при одинаковом фоне».

**Промпт.** `a 25-year-old Eastern European man with short dark hair, clean
shaven, wearing a denim jacket over a tee with chinos and sneakers, standing
on a river embankment with water blurred behind him,` + общий хвост.

**Проверить.** Набережная того же типа, что на ms3. Предплечья чистые.

### ma1 — творческий · тёмные · бритый · ТАТУ · винный бар

**Вайб.** Полный альтернативный образ. Единственный бритый в архетипе —
намеренно, чтобы борода не склеилась с «творческим».

**Промпт.** `a 26-year-old Eastern European man with dark hair, clean shaven,
wearing a black leather jacket over a plain tee with silver rings, a visible
tattoo sleeve on his forearm, standing in a wine bar in the evening with warm
low light behind him,` + общий хвост.

**Проверить.** Тату видно. Кольца читаются. Бритый — это существенно.

### ma2 — творческий · светлые · борода · без тату · вечерняя улица

**Вайб.** Альтернативность **без** татуировки: только одежда и слои.

**Промпт.** `a 26-year-old Eastern European man with light brown hair and a
beard, wearing an oversized overshirt over a tee with layered chains and
boots, standing on an old-town street in the evening with warm shop lights
blurred behind him,` + общий хвост.

**Проверить.** Предплечья **абсолютно чистые**. Дерзость даёт оверширт,
цепи и ботинки, а не чёрная футболка.

### ma3 — творческий · тёмные · борода · без тату · светлое кафе

**Вайб.** Альтернативный образ днём, в «полированной» локации (та же, что
mp3). Мужской близнец пары fp3/fa3.

**Промпт.** `a 25-year-old Eastern European man with dark hair and a beard,
wearing a dark patterned shirt worn open over a tee with silver rings,
standing in a bright modern café with wood and concrete blurred behind him,` +
общий хвост.

**Проверить.** Предплечья чистые. Кафе — то же, что на mp3.

---

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
   В женских парах ещё и **цвет волос совпадает** — рыжие, брюнетки, блонд
   соответственно; несовпадение возвращает ту самую путаницу «архетип или
   масть».
5. **Ни одного зеркального селфи, ни одного интерфейса сторис, ни одного
   постороннего человека.**
6. **Все 24 в 9:16.**
7. **Рыжих ровно две** — fp3 и fa3; блонд и брюнеток по пять. Не «выравнивать»
   обратно в 4/4/4: почему — в разделе «Что мы вообще измеряем».
