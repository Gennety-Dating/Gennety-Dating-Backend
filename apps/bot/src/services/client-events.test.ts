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
  props: Record<string, string>;
  occurredAt: Date;
  appVersion: string | null;
  appBuild: string | null;
  osVersion: string | null;
  locale: string | null;
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
    };
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
