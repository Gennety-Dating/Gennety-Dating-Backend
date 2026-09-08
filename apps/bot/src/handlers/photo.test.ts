import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@gennety/db", () => ({
  Prisma: {},
  prisma: {
    user: { findUnique: vi.fn() },
    message: { create: vi.fn() },
  },
}));
vi.mock("../services/chat-profile-tools.js", () => ({
  attachChatProfilePhoto: vi.fn(),
}));
vi.mock("../services/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/storage.js")>();
  return { ...actual, downloadTelegramFile: vi.fn(), uploadChatImage: vi.fn() };
});

import { Api, Context } from "grammy";
import { prisma } from "@gennety/db";
import { DEFAULT_SESSION, MAX_PHOTOS, t } from "@gennety/shared";
import type { BotContext } from "../session.js";
import { attachChatProfilePhoto } from "../services/chat-profile-tools.js";
import { downloadTelegramFile, uploadChatImage } from "../services/storage.js";
import { photoHandler } from "./photo.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUser = (prisma.user as unknown as { findUnique: MockFn }).findUnique;
const mMessage = (prisma.message as unknown as { create: MockFn }).create;
const mAttach = attachChatProfilePhoto as unknown as MockFn;
const mDownload = downloadTelegramFile as unknown as MockFn;
const mUpload = uploadChatImage as unknown as MockFn;

/** Двенадцать байт с сигнатурой JPEG — ровно то, что нюхает `sniffImageMime`. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);

interface Harness {
  ctx: BotContext;
  /** Тексты, которые бот отправил в чат, по порядку. */
  texts: () => string[];
  /** Прошёл ли апдейт дальше по цепочке (то есть уступил ли хендлер дорогу). */
  run: () => Promise<boolean>;
}

function harness(session: Partial<BotContext["session"]> = {}): Harness {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = new Api("123:test");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === "sendMessage" ? { message_id: 99 } : true;
    return { ok: true, result } as never;
  });

  const ctx = new Context(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 555, type: "private" },
        from: { id: 777, is_bot: false, first_name: "T" },
        photo: [
          { file_id: "thumb", file_unique_id: "u0", width: 90, height: 90, file_size: 900 },
          { file_id: "full", file_unique_id: "u1", width: 1280, height: 1280, file_size: 240_000 },
        ],
      },
    } as never,
    api,
    { id: 1, is_bot: true, first_name: "bot", username: "bot" } as never,
  ) as BotContext;
  (ctx as { session: BotContext["session"] }).session = {
    ...DEFAULT_SESSION,
    language: "ru",
    onboardingStep: "completed",
    ...session,
  };

  return {
    ctx,
    texts: () =>
      calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string),
    run: async () => {
      let continued = false;
      await photoHandler.middleware()(ctx, async () => {
        continued = true;
      });
      return continued;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mUser.mockResolvedValue({
    id: "user-1",
    status: "active",
    onboardingStep: "completed",
    suspendedUntil: null,
  });
  mMessage.mockResolvedValue({ id: "msg-1" });
  mDownload.mockResolvedValue(JPEG);
  mUpload.mockResolvedValue({ path: "user-1/1700000000000.jpg" });
  mAttach.mockResolvedValue({ ok: true, photo: { consensus: "accepted", total: 3 } });
});

/**
 * Хендлер стоит выше всех роутеров, поэтому вопрос «кому принадлежит этот
 * снимок» решает он один. Проверяется не то, что он умеет прикладывать фото, а
 * то, о чём он спрашивает ПЕРЕД этим: каждый владелец чата должен получить
 * сообщение раньше — и ни один байт не должен уехать в хранилище, пока ответ
 * на этот вопрос не получен.
 */
describe("photoHandler — чужие стадии получают снимок первыми", () => {
  const cases: Array<[string, Partial<BotContext["session"]>]> = [
    ["открытый менеджер фотографий", { menuState: "edit_photos" }],
    ["менеджер видео", { menuState: "edit_video" }],
    ["прокси-чат перед свиданием", { matchFlow: "coordination_chat" }],
    ["незаконченный онбординг", { onboardingStep: "conversational" }],
  ];

  for (const [name, session] of cases) {
    it(`уступает дорогу: ${name}`, async () => {
      const h = harness(session);

      expect(await h.run()).toBe(true);
      expect(mUpload).not.toHaveBeenCalled();
      expect(mAttach).not.toHaveBeenCalled();
      expect(h.texts()).toEqual([]);
    });
  }
});

/**
 * Гейт доступа — тот же `evaluateAgentAccess`, что стоит перед ходом
 * меню-агента. Без него забаненный аккаунт получал бы распознавание лиц и
 * запись в профиль, просто прислав картинку вместо текста.
 */
describe("photoHandler — доступ", () => {
  it("модерируемый аккаунт не доходит ни до хранилища, ни до распознавания", async () => {
    mUser.mockResolvedValue({
      id: "user-1",
      status: "banned",
      onboardingStep: "completed",
      suspendedUntil: null,
    });
    const h = harness();

    expect(await h.run()).toBe(false);
    expect(mUpload).not.toHaveBeenCalled();
    expect(mAttach).not.toHaveBeenCalled();
    expect(h.texts()).toEqual([t("ru", "agentBlockedBanned")]);
  });

  it("гейт верификации остаётся чужой дверью — у него своя карточка с кнопкой", async () => {
    mUser.mockResolvedValue({
      id: "user-1",
      status: "onboarding",
      onboardingStep: "completed",
      suspendedUntil: null,
    });
    const h = harness();

    expect(await h.run()).toBe(true);
    expect(mAttach).not.toHaveBeenCalled();
    expect(h.texts()).toEqual([]);
  });
});

describe("photoHandler — что человек получает в ответ", () => {
  it("прикладывает снимок к профилю и подтверждает это на языке аккаунта", async () => {
    const h = harness();

    expect(await h.run()).toBe(false);
    expect(mAttach).toHaveBeenCalledWith("user-1", {
      imageUrl: "user-1/1700000000000.jpg",
    });
    // Строка в `Message` — условие входа инструмента, а не журнал: он проверяет
    // по ней, что картинка действительно ход этого человека.
    expect(mMessage).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        role: "user",
        imageUrl: "user-1/1700000000000.jpg",
      }),
    });
    expect(h.texts()).toEqual([
      t("ru", "photoBatchAdded", { n: 1, total: 3, max: MAX_PHOTOS }),
    ]);
  });

  it("объясняет отказ словами про эту причину, а не общей неудачей", async () => {
    mAttach.mockResolvedValue({
      ok: false,
      detail: "Face is covered by a mask or scarf — ask for a photo where it isn't hidden",
      reason: "face_obscured",
    });
    const h = harness();

    await h.run();

    expect(h.texts()).toEqual([t("ru", "photoFaceObscured")]);
    // Английский текст инструмента написан для модели и в третьем лице —
    // человеку он не показывается ни при каких обстоятельствах.
    expect(h.texts()[0]).not.toContain("ask for a photo");
  });

  it("не называет «добавил» фотографию, которая ещё не в альбоме", async () => {
    mAttach.mockResolvedValue({
      ok: true,
      detail: "Photo passed checks, but identity is not fixed yet.",
      photo: { consensus: "pending", total: 0 },
    });
    const h = harness();

    await h.run();

    expect(h.texts()).toEqual([t("ru", "photoConsensusPending")]);
  });

  it("честно говорит о неудаче, а не роняет ход, когда хранилище недоступно", async () => {
    mUpload.mockRejectedValue(new Error("Supabase upload failed: 500"));
    const h = harness();

    await expect(h.run()).resolves.toBe(false);
    expect(mAttach).not.toHaveBeenCalled();
    expect(h.texts()).toEqual([t("ru", "photoVisionError")]);
  });
});
