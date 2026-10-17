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
  // Tempo Sync funnel (decision journal 2026-09-25): which step of connecting
  // Apple Health a person reached — `row_shown`, `row_tapped`,
  // `sheet_continued`, `uploaded`, `insufficient`, `disconnected`. The funnel
  // only: never an activity level, a chronotype or a step count.
  "tempo_sync",
  // Pulse, contract v2 (docs/product/domains/pulse-analytics.md §3): screens,
  // foreground time on them, taps on key screens, card visibility. None of it
  // is observable on the server, so the 2026-08-20 rule holds.
  "screen_view",
  "screen_left",
  "tap",
  "dead_tap",
  "seen",
] as const;

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

const TYPES = new Set<string>(CLIENT_EVENT_TYPES);

/**
 * Форма `props` каждого типа: какие строковые и какие числовые ключи
 * допустимы и какие из них обязательны. Лишний ключ отбрасывает событие —
 * он означает либо ошибку, либо чужие данные.
 *
 * У десяти исходных типов ключ ровно один и необязательный — так устроен
 * клиентский перечень с 2026-08-21. Типы Pulse несут несколько ключей, и
 * часть из них числовая: время на экране и координаты касания.
 */
type PropSpec = {
  strings: Record<string, "required" | "optional">;
  numbers?: Record<string, { min: number; max: number; round: "int" | "coord"; required: boolean }>;
};

const DWELL = { min: 0, max: 86_400_000, round: "int", required: true } as const;
const COORD = { min: 0, max: 1, round: "coord", required: true } as const;

function single(key: string): PropSpec {
  return { strings: { [key]: "optional" } };
}

const PROP_SPEC: Record<ClientEventType, PropSpec> = {
  onboarding_step_left: single("step"),
  permission_prompted: single("permission"),
  permission_denied: single("permission"),
  liveness_finished: single("outcome"),
  paywall_shown: single("surface"),
  paywall_dismissed: single("surface"),
  ticket_gate_shown: single("surface"),
  ticket_gate_dismissed: single("surface"),
  fatal_client_error: single("domain"),
  tempo_sync: single("step"),
  screen_view: { strings: { screen: "required", from: "optional" } },
  screen_left: {
    strings: { screen: "required", exit: "required" },
    numbers: { dwell_ms: DWELL, first_action_ms: { ...DWELL, required: false } },
  },
  tap: { strings: { screen: "required", element: "required" }, numbers: { x: COORD, y: COORD } },
  dead_tap: { strings: { screen: "required" }, numbers: { x: COORD, y: COORD } },
  seen: { strings: { screen: "required", item: "required" }, numbers: { visible_ms: DWELL } },
};

/** `screen_left.exit` — закрытый перечень, в отличие от остальных строк. */
const EXITS = new Set(["next", "back", "background", "dismiss"]);

/**
 * Строковые значения `props` проверяются по ФОРМЕ, а не по списку.
 *
 * Список значений (`venue_lock`, `camera_denied`, ключи экранов…) живёт в
 * клиентских перечнях и будет расти; сверять его здесь значило бы отбрасывать
 * события нового приложения до ближайшего деплоя сервера. Форма же гарантирует
 * ровно тот инвариант, ради которого проверка существует: короткий
 * `snake_case` не вмещает ни свободного текста, ни имени, ни телефона.
 * Числа допускаются только там, где их объявляет `PROP_SPEC`, и только в его
 * границах — координата касания нормирована к экрану, а не к миру.
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
  session?: unknown;
};

export type ClientEventBatch = {
  installId?: unknown;
  platform?: unknown;
  app?: unknown;
  events?: unknown;
};

export type ClientPlatform = "ios" | "miniapp";

/**
 * Платформа батча. Под `tma`-авторизацией вызывающий передаёт `miniapp`
 * принудительно — подписанный Telegram initData не бывает у нативного
 * приложения, и заявление тела тут ничего не решает.
 */
function readPlatform(raw: unknown, forced: ClientPlatform | undefined): ClientPlatform {
  if (forced) return forced;
  return raw === "miniapp" ? "miniapp" : "ios";
}

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
function normalise(raw: IncomingEvent): {
  id: string;
  type: ClientEventType;
  occurredAt: Date;
  sessionId: string | null;
  props: Record<string, string | number>;
} | null {
  const id = typeof raw.id === "string" && UUID.test(raw.id) ? raw.id : null;
  if (!id) return null;

  const type = typeof raw.type === "string" && TYPES.has(raw.type) ? (raw.type as ClientEventType) : null;
  if (!type) return null;

  if (typeof raw.at !== "string") return null;
  const occurredAt = new Date(raw.at);
  if (Number.isNaN(occurredAt.getTime())) return null;

  // Битая сессия не стоит события: это служебная склейка, не данные.
  const sessionId = typeof raw.session === "string" && UUID.test(raw.session) ? raw.session : null;

  const incoming = (raw.props ?? {}) as Record<string, unknown>;
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) return null;

  const spec = PROP_SPEC[type];
  const numbers = spec.numbers ?? {};
  for (const key of Object.keys(incoming)) {
    if (!(key in spec.strings) && !(key in numbers)) return null;
  }

  const props: Record<string, string | number> = {};
  for (const [key, need] of Object.entries(spec.strings)) {
    const value = incoming[key];
    if (value === undefined) {
      if (need === "required") return null;
      continue;
    }
    if (typeof value !== "string" || !PROP_VALUE.test(value)) return null;
    props[key] = value;
  }
  for (const [key, rule] of Object.entries(numbers)) {
    const value = incoming[key];
    if (value === undefined) {
      if (rule.required) return null;
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if (value < rule.min || value > rule.max) return null;
    props[key] = rule.round === "int" ? Math.round(value) : Math.round(value * 1000) / 1000;
  }
  if (type === "screen_left" && !EXITS.has(props.exit as string)) return null;

  return { id, type, occurredAt, sessionId, props };
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
  options: { platform?: ClientPlatform } = {},
): Promise<IngestResult> {
  const installId = shortString(batch.installId, INSTALL_ID_MAX);
  if (!installId || !Array.isArray(batch.events)) {
    return { status: "invalid", reason: "malformed" };
  }
  if (batch.events.length > CLIENT_EVENTS_MAX_BATCH) {
    return { status: "invalid", reason: "too_many_events" };
  }

  const app = readAppInfo(batch.app);
  const platform = readPlatform(batch.platform, options.platform);
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
      platform,
      sessionId: event.sessionId,
      screen: typeof event.props.screen === "string" ? event.props.screen : null,
    });
  }

  if (rows.length > 0) {
    await prisma.clientEvent.createMany({ data: rows, skipDuplicates: true });
  }

  return { status: "ok", accepted: rows.length, dropped };
}
