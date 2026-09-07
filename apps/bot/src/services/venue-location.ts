/**
 * Одна колонка — один смысл: где НАХОДИТСЯ заведение.
 *
 * `Match.venueLat/venueLng` исторически означала две разные вещи. Финализатор
 * Venue Intent V2 (`venue-intent-v2.ts`) писал туда координаты САМОГО
 * заведения, а legacy-финализаторы (`venue-negotiation.ts`,
 * `public/matches-service.ts`) — СЕРЕДИНУ МАРШРУТА между отправными точками
 * пары. Схема это фиксировала текстом, но различить одно от другого в рантайме
 * было нечем: `venueMidpointLat/Lng` и `venueSelectionVersion` записывались и
 * не читались НИКЕМ — ни ботом, ни `/v1/*`, ни OpenAPI, ни iOS.
 *
 * Цена расхождения не косметическая. Радиус поиска заведения от середины —
 * от 500 до 5000 метров (`services/geo.ts`), а радиус Date Bump — 100
 * (`BUMP_VENUE_RADIUS_M`). На legacy-строке пара стоит за столиком, трясёт
 * телефоны и получает «слишком далеко»: явка не засчитывается, `+50`
 * reliability, бесплатный билет и тайл Scratch Map не выдаются никогда, а
 * радар и пин на карте в iOS показывают перекрёсток.
 *
 * Дискриминатором выбран `venueMidpointLat`, а не `venueSelectionVersion`:
 * версия — это про ранкер V2, и вешать на неё смысл колонки значило бы
 * сложить два разных факта в одно поле. Правило простое и не требует
 * миграции схемы: **если середина записана отдельно, значит писал тот, кто
 * различает эти два понятия, и `venueLat/Lng` — это заведение.** Старые
 * строки середины отдельно не писали, поэтому у них колонка по-прежнему
 * означает середину, и координат заведения мы про них просто не знаем.
 */

export interface VenueCoordinateSource {
  venueLat: number | null;
  venueLng: number | null;
  venueMidpointLat: number | null;
}

export interface VenuePoint {
  lat: number;
  lng: number;
}

/**
 * Координаты заведения, если они известны достоверно.
 *
 * `null` означает «не знаем», а не «нет заведения»: у legacy-строки название
 * и адрес есть, а точки нет. Все потребители уже умеют отказывать при пустых
 * координатах — это честнее, чем принять середину маршрута за место встречи.
 */
export function venueCoordinatesOf(match: VenueCoordinateSource): VenuePoint | null {
  // Середина не записана отдельно → строка старая, и `venueLat/Lng` держит
  // именно её. Отдавать это как «где заведение» нельзя.
  if (match.venueMidpointLat === null) return null;
  if (match.venueLat === null || match.venueLng === null) return null;
  return { lat: match.venueLat, lng: match.venueLng };
}
