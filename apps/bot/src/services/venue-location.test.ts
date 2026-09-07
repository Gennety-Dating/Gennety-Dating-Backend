import { describe, expect, it } from "vitest";
import { venueCoordinatesOf } from "./venue-location.js";

/**
 * Регрессия на дефект аудита 2026-09-06 («Архитектура №1»).
 *
 * `Match.venueLat/venueLng` означала то координаты заведения (финализатор
 * Venue Intent V2), то середину маршрута между отправными точками пары
 * (legacy-финализаторы). Различить было нечем: оба дискриминатора
 * (`venueMidpointLat/Lng` и `venueSelectionVersion`) записывались и не
 * читались НИКЕМ. Потребители трактовали колонку как место встречи без
 * ветвления, при том что радиус поиска от середины — 0,5–5 км, а радиус
 * Date Bump — 100 метров.
 */
describe("venueCoordinatesOf", () => {
  it("отдаёт точку, когда середина записана отдельно", () => {
    // Середина в своей колонке ⇒ строку писал автор, различающий эти два
    // понятия ⇒ `venueLat/Lng` — это заведение.
    expect(
      venueCoordinatesOf({
        venueLat: 50.45,
        venueLng: 30.52,
        venueMidpointLat: 50.44,
      }),
    ).toEqual({ lat: 50.45, lng: 30.52 });
  });

  it("молчит на legacy-строке, где колонка держит середину", () => {
    // Ни одна старая строка не писала середину отдельно. Значит `venueLat`
    // здесь — сама середина, и выдавать её за место встречи нельзя: пара
    // стоит за столиком, а Date Bump со своими 100 метрами отвечает
    // «слишком далеко».
    expect(
      venueCoordinatesOf({
        venueLat: 50.44,
        venueLng: 30.51,
        venueMidpointLat: null,
      }),
    ).toBeNull();
  });

  it("молчит, когда координат заведения нет вовсе", () => {
    // Курируемая площадка без координат: название и адрес есть, точки нет.
    // «Не знаем» — честный ответ, и все потребители его уже умеют.
    expect(
      venueCoordinatesOf({ venueLat: null, venueLng: null, venueMidpointLat: 50.44 }),
    ).toBeNull();
    expect(
      venueCoordinatesOf({ venueLat: 50.45, venueLng: null, venueMidpointLat: 50.44 }),
    ).toBeNull();
  });
});
