import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Строка в том виде, в каком её ждёт `createMany`. Тип здесь не украшение: без
 * него у мока нулевая арность, `mock.calls` вырождается в пустые кортежи, и
 * каждое обращение к записанной строке пришлось бы приводить через `as` — то
 * есть проверять не то, что записано, а то, что мы про это заявили.
 */
type WrittenRow = {
  id: string;
  userId: string | null;
  installId: string;
  type: string;
  props: Record<string, string | number>;
  occurredAt: Date;
  appVersion: string | null;
  appBuild: string | null;
  osVersion: string | null;
  locale: string | null;
  platform: string;
  sessionId: string | null;
  screen: string | null;
};

const createMany = vi.fn(async (_args: { data: WrittenRow[]; skipDuplicates?: boolean }) => ({
  count: 0,
}));
vi.mock("@gennety/db", () => ({
  prisma: { clientEvent: { createMany } },
}));

const { ingestClientEvents, CLIENT_EVENTS_MAX_BATCH, CLIENT_EVENT_TYPES } = await import(
  "./client-events.js"
);

const INSTALL = "8b1f0c21-0000-4000-8000-000000000001";

function uuid(n: number): string {
  return `8b1f0c21-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(1),
    type: "paywall_shown",
    at: "2026-08-20T09:12:33.000Z",
    props: { surface: "settings" },
    ...over,
  };
}

function batch(events: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installId: INSTALL,
    app: { version: "0.1.0", build: "1", os: "26.0", locale: "ru" },
    events,
    ...over,
  };
}

beforeEach(() => {
  createMany.mockClear();
});

describe("ingestClientEvents — что записывается", () => {
  it("пишет валидное событие вместе с обеими отметками времени и блоком сборки", async () => {
    const out = await ingestClientEvents(batch([event()]), "user-1");

    expect(out).toEqual({ status: "ok", accepted: 1, dropped: 0 });
    const [{ data }] = createMany.mock.calls[0];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: uuid(1),
      userId: "user-1",
      installId: INSTALL,
      type: "paywall_shown",
      props: { surface: "settings" },
      appVersion: "0.1.0",
      appBuild: "1",
      osVersion: "26.0",
      locale: "ru",
    });
    // `occurredAt` — часы устройства; `receivedAt` ставит база (@default(now())),
    // поэтому здесь его нет и быть не должно.
    expect(data[0].occurredAt.toISOString()).toBe("2026-08-20T09:12:33.000Z");
    expect(data[0]).not.toHaveProperty("receivedAt");
  });

  it("принимает батч без токена — половина воронки случается до логина", async () => {
    const out = await ingestClientEvents(batch([event()]), null);

    expect(out.status).toBe("ok");
    const [{ data }] = createMany.mock.calls[0];
    expect(data[0].userId).toBeNull();
    expect(data[0].installId).toBe(INSTALL);
  });

  it("идемпотентен: повтор батча идёт со skipDuplicates по клиентскому id", async () => {
    await ingestClientEvents(batch([event()]), "user-1");
    await ingestClientEvents(batch([event()]), "user-1");

    for (const call of createMany.mock.calls) {
      expect(call[0].skipDuplicates).toBe(true);
    }
  });

  it("схлопывает дубль ВНУТРИ одного батча — skipDuplicates от него не спасает", async () => {
    // `skipDuplicates` снимает конфликт со строками в таблице, а не с соседней
    // строкой того же запроса: без своей дедупликации Postgres отверг бы весь
    // `createMany`, то есть один повтор унёс бы весь батч.
    const out = await ingestClientEvents(batch([event(), event()]), "user-1");

    expect(out).toMatchObject({ status: "ok", accepted: 1 });
    const [{ data }] = createMany.mock.calls[0];
    expect(data).toHaveLength(1);
  });
});

describe("ingestClientEvents — что отбрасывается, не роняя батч", () => {
  it("неизвестный тип считается в dropped, а соседнее событие записывается", async () => {
    // Клиент и сервер выкатываются независимо, и сборка из App Store живёт
    // месяцами: батч, отвергнутый целиком из-за одного незнакомого типа,
    // означал бы, что одна сторона ломается о вторую.
    const out = await ingestClientEvents(
      batch([event({ id: uuid(1), type: "some_future_event" }), event({ id: uuid(2) })]),
      "user-1",
    );

    expect(out).toEqual({ status: "ok", accepted: 1, dropped: 1 });
    const [{ data }] = createMany.mock.calls[0];
    expect(data.map((r) => r.id)).toEqual([uuid(2)]);
  });

  it.each([
    ["свободный текст", { surface: "user typed this" }],
    ["телефон", { surface: "+380671234567" }],
    ["слишком длинное значение", { surface: "a".repeat(33) }],
    ["не строку", { surface: 42 }],
    ["чужой ключ", { note: "settings" }],
    ["лишний ключ рядом с нужным", { surface: "settings", note: "x" }],
  ])("отбрасывает props, если там %s", async (_name, props) => {
    const out = await ingestClientEvents(batch([event({ props })]), "user-1");

    expect(out).toEqual({ status: "ok", accepted: 0, dropped: 1 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("принимает событие без props вовсе", async () => {
    const out = await ingestClientEvents(batch([event({ props: undefined })]), "user-1");

    expect(out).toMatchObject({ status: "ok", accepted: 1 });
    const [{ data }] = createMany.mock.calls[0];
    expect(data[0].props).toEqual({});
  });

  it.each([
    ["id не UUID", { id: "42" }],
    ["времени, которого не бывает", { at: "не дата" }],
    ["времени не строкой", { at: 1_700_000_000 }],
  ])("отбрасывает событие с %s", async (_name, over) => {
    const out = await ingestClientEvents(batch([event(over)]), "user-1");

    expect(out).toEqual({ status: "ok", accepted: 0, dropped: 1 });
  });

  it("у каждого типа из перечня есть свой ключ props, и он принимается", async () => {
    const byType: Record<string, Record<string, string>> = {
      onboarding_step_left: { step: "photos" },
      permission_prompted: { permission: "notifications" },
      permission_denied: { permission: "camera" },
      liveness_finished: { outcome: "camera_denied" },
      paywall_shown: { surface: "settings" },
      paywall_dismissed: { surface: "settings" },
      ticket_gate_shown: { surface: "match_ticket_gate" },
      ticket_gate_dismissed: { surface: "tickets_tab" },
      fatal_client_error: { domain: "store_kit" },
      tempo_sync: { step: "row_tapped" },
      screen_view: { screen: "today_pitch" },
      screen_left: { screen: "today_pitch", exit: "next", dwell_ms: 4200 },
      tap: { screen: "today_pitch", element: "accept", x: 0.5, y: 0.8 },
      dead_tap: { screen: "today_pitch", x: 0.1, y: 0.2 },
      seen: { screen: "today", item: "vibe_questions", visible_ms: 1500 },
    } as unknown as Record<string, Record<string, string>>;
    // Перечень закрыт с обеих сторон: новый тип на клиенте без записи здесь
    // будет молча отброшен, поэтому список проверяется целиком.
    expect(Object.keys(byType).sort()).toEqual([...CLIENT_EVENT_TYPES].sort());

    const events = CLIENT_EVENT_TYPES.map((type, i) =>
      event({ id: uuid(i + 1), type, props: byType[type] }),
    );
    const out = await ingestClientEvents(batch(events), "user-1");

    expect(out).toEqual({ status: "ok", accepted: CLIENT_EVENT_TYPES.length, dropped: 0 });
  });
});

describe("ingestClientEvents — когда виноват батч целиком", () => {
  it.each([
    ["нет installId", batch([event()], { installId: undefined })],
    ["installId пустой", batch([event()], { installId: "  " })],
    ["installId длиннее потолка", batch([event()], { installId: "a".repeat(65) })],
    ["events не массив", batch([], { events: { id: 1 } })],
  ])("отвечает malformed, если %s", async (_name, body) => {
    const out = await ingestClientEvents(body, "user-1");

    expect(out).toEqual({ status: "invalid", reason: "malformed" });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("отвергает батч длиннее потолка целиком, а не режет его молча", async () => {
    const events = Array.from({ length: CLIENT_EVENTS_MAX_BATCH + 1 }, (_, i) =>
      event({ id: uuid(i + 1) }),
    );

    const out = await ingestClientEvents(batch(events), "user-1");

    expect(out).toEqual({ status: "invalid", reason: "too_many_events" });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("пустой батч — не ошибка и записи не порождает", async () => {
    const out = await ingestClientEvents(batch([]), "user-1");

    expect(out).toEqual({ status: "ok", accepted: 0, dropped: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it("битый блок app не мешает записи — версия сборки это не данные события", async () => {
    const out = await ingestClientEvents(
      batch([event()], { app: { version: 1, build: null, os: "a".repeat(40) } }),
      "user-1",
    );

    expect(out).toMatchObject({ status: "ok", accepted: 1 });
    const [{ data }] = createMany.mock.calls[0];
    expect(data[0]).toMatchObject({ appVersion: null, appBuild: null, osVersion: null });
  });
});

describe("ingestClientEvents — контракт v2 (Pulse)", () => {
  it("пишет платформу, сессию и копию экрана для индекса", async () => {
    const out = await ingestClientEvents(
      batch(
        [
          event({
            type: "screen_left",
            session: uuid(9),
            props: { screen: "photos", exit: "back", dwell_ms: 1234.6, first_action_ms: 800 },
          }),
        ],
        { platform: "miniapp" },
      ),
      "user-1",
    );

    expect(out).toEqual({ status: "ok", accepted: 1, dropped: 0 });
    const [{ data }] = createMany.mock.calls[0];
    expect(data[0]).toMatchObject({
      platform: "miniapp",
      sessionId: uuid(9),
      screen: "photos",
      props: { screen: "photos", exit: "back", dwell_ms: 1235, first_action_ms: 800 },
    });
  });

  it("платформа из опций сильнее тела — под tma она всегда miniapp", async () => {
    await ingestClientEvents(batch([event()], { platform: "ios" }), "user-1", { platform: "miniapp" });
    expect(createMany.mock.calls[0][0].data[0].platform).toBe("miniapp");
  });

  it("неизвестная платформа и её отсутствие — ios, старые события без экрана", async () => {
    await ingestClientEvents(batch([event()], { platform: "android" }), "user-1");
    const row = createMany.mock.calls[0][0].data[0];
    expect(row.platform).toBe("ios");
    expect(row.screen).toBeNull();
    expect(row.sessionId).toBeNull();
  });

  it("координаты касания округляются до тысячных", async () => {
    await ingestClientEvents(
      batch([event({ type: "tap", props: { screen: "paywall", element: "buy", x: 0.123456, y: 1 } })]),
      "user-1",
    );
    expect(createMany.mock.calls[0][0].data[0].props).toEqual({
      screen: "paywall",
      element: "buy",
      x: 0.123,
      y: 1,
    });
  });

  it.each([
    ["нет обязательного экрана", "screen_view", {}],
    ["выход не из перечня", "screen_left", { screen: "a", exit: "swipe", dwell_ms: 1 }],
    ["нет времени на экране", "screen_left", { screen: "a", exit: "next" }],
    ["время отрицательное", "screen_left", { screen: "a", exit: "next", dwell_ms: -1 }],
    ["время больше суток", "screen_left", { screen: "a", exit: "next", dwell_ms: 86_400_001 }],
    ["координата за экраном", "tap", { screen: "a", element: "b", x: 1.2, y: 0.5 }],
    ["координата строкой", "tap", { screen: "a", element: "b", x: "0.5", y: 0.5 }],
    ["координата NaN", "dead_tap", { screen: "a", x: Number.NaN, y: 0.5 }],
    ["текст вместо ключа элемента", "tap", { screen: "a", element: "Купить билет", x: 0.5, y: 0.5 }],
    ["число там, где строка", "seen", { screen: 5, item: "b", visible_ms: 1 }],
    ["лишний ключ", "seen", { screen: "a", item: "b", visible_ms: 1, name: "olya" }],
  ])("отбрасывает событие Pulse, если %s", async (_name, type, props) => {
    const out = await ingestClientEvents(batch([event({ type, props })]), "user-1");
    expect(out).toEqual({ status: "ok", accepted: 0, dropped: 1 });
  });

  it("битая сессия не стоит события — пишется без неё", async () => {
    await ingestClientEvents(batch([event({ session: "nope" })]), "user-1");
    expect(createMany.mock.calls[0][0].data[0].sessionId).toBeNull();
  });
});
