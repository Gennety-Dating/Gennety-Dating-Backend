import { prisma } from "@gennety/db";

/**
 * Приём клиентской воронки нативного приложения (iOS 6.2).
 *
 * Правило, из которого следует всё остальное: клиент шлёт СЮДА только то, чего
 * сервер не видит в принципе. Регистрация, верификация, матч, решение и
 * свидание — это вызовы API, они уже наблюдаются, и дублирующее событие
 * создало бы второй источник правды, при расхождении с которым никто не знает,
 * какому верить.
 *
 * Контракт тела заморожен на стороне клиента раньше, чем написан сервер, — в
 * этом репозитории порядок обычно обратный (`AGENTS.md` → «Two Clients, One
 * Backend»), и причина отклонения записана в DECISIONS.md.
 */

/**
 * Закрытый перечень. Совпадает дословно с `AnalyticsEvent.type` в
 * `Gennety-iOS/App/Analytics/AnalyticsEvent.swift`.
 *
 * Неизвестный тип **не роняет батч** — он отбрасывается и считается в
 * `dropped`. Клиент и сервер обновляются независимо: старое приложение живёт в
 * App Store месяцами, а новое может прийти раньше деплоя. Любая другая
 * трактовка означала бы, что одна из двух сторон ломается о вторую.
 */
export const CLIENT_EVENT_TYPES = [
  "onboarding_step_left",
  "permission_prompted",
  "permission_denied",
  "liveness_finished",
  "paywall_shown",
  "paywall_dismissed",
  "ticket_gate_shown",
  "ticket_gate_dismissed",
  "fatal_client_error",
] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

const TYPES = new Set<string>(CLIENT_EVENT_TYPES);

/**
 * Разрешённый ключ `props` у каждого типа. Ключ ровно один — так устроен
 * клиентский перечень, и лишний ключ означает либо ошибку, либо чужие данные.
 */
const PROP_KEY: Record<ClientEventType, string> = {
  onboarding_step_left: "step",
  permission_prompted: "permission",
  permission_denied: "permission",
  liveness_finished: "outcome",
  paywall_shown: "surface",
  paywall_dismissed: "surface",
  ticket_gate_shown: "surface",
  ticket_gate_dismissed: "surface",
  fatal_client_error: "domain",
};

/**
 * Значения `props` проверяются по ФОРМЕ, а не по списку.
 *
 * Список значений (`venue_lock`, `camera_denied`, …) живёт в клиентских
 * перечнях и будет расти; сверять его здесь значило бы отбрасывать события
 * нового приложения до ближайшего деплоя сервера. Форма же гарантирует ровно
 * тот инвариант, ради которого проверка существует: короткий `snake_case` не
 * вмещает ни свободного текста, ни имени, ни телефона, ни координаты.
 */
const PROP_VALUE = /^[a-z0-9_]{1,32}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Потолок на батч. Клиент шлёт по 50; запас на случай слияния очередей. */
export const CLIENT_EVENTS_MAX_BATCH = 200;

/** Короткие строки описания сборки. Длиннее — это не версия, а что-то другое. */
const SHORT_MAX = 32;
const INSTALL_ID_MAX = 64;

/**
 * Событие в том виде, в каком его шлёт клиент. Всё, кроме перечисленного,
 * игнорируется: лишние поля в теле — не ошибка, но и не данные.
 */
type IncomingEvent = {
  id?: unknown;
  type?: unknown;
  at?: unknown;
  props?: unknown;
};

export type ClientEventBatch = {
  installId?: unknown;
  app?: unknown;
  events?: unknown;
};

export type IngestResult =
  | { status: "ok"; accepted: number; dropped: number }
  | { status: "invalid"; reason: "malformed" | "too_many_events" };

type AppInfo = {
  version: string | null;
  build: string | null;
  os: string | null;
  locale: string | null;
};

function shortString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function readAppInfo(raw: unknown): AppInfo {
  const app = (raw ?? {}) as Record<string, unknown>;
  return {
    version: shortString(app.version, SHORT_MAX),
    build: shortString(app.build, SHORT_MAX),
    os: shortString(app.os, SHORT_MAX),
    locale: shortString(app.locale, SHORT_MAX),
  };
}

/**
 * Проверка одного события. Возвращает `null`, если событие отбрасывается —
 * неизвестный тип, битый идентификатор, время, которого не бывает, или `props`
 * не той формы.
 *
 * Отбрасывается ОДНО событие, а не батч: клиент уже сложил его в очередь и
 * отчитается о доставке по коду ответа, так что 400 на весь батч стоил бы
 * остальных событий в нём.
 */
function normalise(
  raw: IncomingEvent,
): { id: string; type: ClientEventType; occurredAt: Date; props: Record<string, string> } | null {
  const id = typeof raw.id === "string" && UUID.test(raw.id) ? raw.id : null;
  if (!id) return null;

  const type = typeof raw.type === "string" && TYPES.has(raw.type) ? (raw.type as ClientEventType) : null;
  if (!type) return null;

  if (typeof raw.at !== "string") return null;
  const occurredAt = new Date(raw.at);
  if (Number.isNaN(occurredAt.getTime())) return null;

  const key = PROP_KEY[type];
  const incoming = (raw.props ?? {}) as Record<string, unknown>;
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) return null;
  // Ключей больше одного быть не может: у каждого типа он ровно один.
  const keys = Object.keys(incoming);
  if (keys.length > 1) return null;
  if (keys.length === 1 && keys[0] !== key) return null;

  const props: Record<string, string> = {};
  const value = incoming[key];
  if (value !== undefined) {
    if (typeof value !== "string" || !PROP_VALUE.test(value)) return null;
    props[key] = value;
  }

  return { id, type, occurredAt, props };
}

/**
 * Записать батч. `userId` — из JWT, если он был; до авторизации человек
 * опознаётся только `installId`.
 *
 * `accepted` считает события, которые у нас ЕСТЬ по итогу вызова, включая уже
 * записанные ранее: для клиента «принято» означает «можно выбросить из
 * очереди», и повторная доставка обязана давать тот же ответ, что первая.
 */
export async function ingestClientEvents(
  batch: ClientEventBatch,
  userId: string | null,
): Promise<IngestResult> {
  const installId = shortString(batch.installId, INSTALL_ID_MAX);
  if (!installId || !Array.isArray(batch.events)) {
    return { status: "invalid", reason: "malformed" };
  }
  if (batch.events.length > CLIENT_EVENTS_MAX_BATCH) {
    return { status: "invalid", reason: "too_many_events" };
  }

  const app = readAppInfo(batch.app);
  const rows = [];
  let dropped = 0;
  const seen = new Set<string>();

  for (const raw of batch.events as IncomingEvent[]) {
    const event = raw && typeof raw === "object" ? normalise(raw) : null;
    if (!event) {
      dropped += 1;
      continue;
    }
    // Дубль ВНУТРИ одного батча `createMany` не переживёт даже со
    // `skipDuplicates`: тот снимает конфликт со строками в таблице, а не с
    // соседней строкой в том же запросе.
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    rows.push({
      id: event.id,
      userId,
      installId,
      type: event.type,
      props: event.props,
      occurredAt: event.occurredAt,
      appVersion: app.version,
      appBuild: app.build,
      osVersion: app.os,
      locale: app.locale,
    });
  }

  if (rows.length > 0) {
    await prisma.clientEvent.createMany({ data: rows, skipDuplicates: true });
  }

  return { status: "ok", accepted: rows.length, dropped };
}
