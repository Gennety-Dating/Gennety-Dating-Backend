import { Composer } from "grammy";
import { prisma } from "@gennety/db";
import { MAX_PHOTOS, t, type Language } from "@gennety/shared";
import type { BotContext } from "../session.js";
import { AGENT_DENIAL_COPY, evaluateAgentAccess } from "../services/agent-access.js";
import {
  attachChatProfilePhoto,
  type ChatPhotoRejection,
  type ChatToolResult,
} from "../services/chat-profile-tools.js";
import { downloadTelegramFile, uploadChatImage } from "../services/storage.js";
import { sniffImageMime } from "../utils/image-sniff.js";
import { photoValidationMessage } from "./menu/edit-profile.js";

/**
 * Потолок на снимок — тот же, что у мобильной загрузки
 * (`CHAT_IMAGE_MAX_BYTES`, `public/routes/chat.ts`), чтобы обе двери в один и
 * тот же конвейер отказывали одному и тому же файлу. Практически это
 * страховка, а не продуктовое правило: Telegram отдаёт сюда уже сжатую
 * копию, и до восьми мегабайт она не дорастает.
 */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

/**
 * Фотография, присланная в чат после онбординга → в профиль.
 *
 * До этого хендлера бот был на снимки слеп: пост-онбординговый роутер
 * начинается с `ctx.message?.text`, а у фотографии текста нет, поэтому любой
 * присланный портрет открывал главное меню — тот же ответ, что на пустое
 * сообщение. При этом распознавание портретов в проекте уже написано и уже
 * работает: `attach_profile_photo` мобильного `chat-agent` (см.
 * `services/chat-profile-tools.ts`). Здесь оно переносится в Telegram, а не
 * пишется заново.
 *
 * Форма взята у `handlers/voice.ts`: перехват до FSM-роутера, свои границы,
 * и — главное — ранние возвраты для чужих стадий. Голос отдаёт запись шагу
 * voice-prompt, фотография отдаёт снимок каждому, кто уже владеет чатом:
 *
 *   - **онбординг** (`onboardingStep !== "completed"`) — там своя стадия
 *     фотографий со своим редактором и своим минимумом;
 *   - **`menuState !== "idle"`** — менеджер фотографий (`edit_photos`)
 *     потребляет сырые снимки, менеджер видео и текстовые под-потоки едят
 *     любое сообщение без callback-данных. Проверка идёт по «не idle», а не по
 *     перечислению: список состояний растёт, а забытое здесь состояние
 *     проявилось бы как молча съеденный ответ пользователя;
 *   - **`matchFlow !== "idle"`** — прокси-чат перед свиданием (`coordination_chat`)
 *     обязан ответить на медиа «только текст»: пересылка снимка партнёру — это
 *     утечка лица и метаданных, и отказ там продуманный. Остальные состояния
 *     ждут ответ на конкретный вопрос.
 *
 * Ошибки не пробрасываются: каждая ветка отвечает человеку локализованной
 * фразой. Причину отказа приносит сам инструмент отдельным машинным полем
 * (`ChatPhotoRejection`) — его `detail` написан для модели и по-английски.
 *
 * Событие в ленту чата не пишется намеренно: входящую фотографию уже записал
 * `interaction-recorder`, а ответ бота запишет `outbound-recorder`, так что
 * меню-агент видит весь обмен и без дублирующей записи отсюда.
 */
export const photoHandler = new Composer<BotContext>();

photoHandler.on("message:photo", async (ctx, next) => {
  const lang = ctx.session.language;

  if (
    ctx.session.onboardingStep !== "completed" ||
    ctx.session.menuState !== "idle" ||
    ctx.session.matchFlow !== "idle"
  ) {
    await next();
    return;
  }

  const telegramId = ctx.from?.id;
  if (telegramId === undefined) {
    await next();
    return;
  }

  const account = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, status: true, onboardingStep: true, suspendedUntil: true },
  });
  // Сессия говорит «completed», а строки нет — рассинхрон, а не отказ. Роутер
  // всё равно перечитывает шаг из базы на каждом апдейте, ему и разбирать.
  if (!account) {
    await next();
    return;
  }

  // Кто вообще вправе тратить наши проверки. Тот же вопрос, что задаёт
  // `handlers/menu/router.ts` перед ходом агента, и задан он тем же
  // `evaluateAgentAccess`: иначе забаненный аккаунт получал бы распознавание
  // лиц и запись в профиль, сменив текст на фотографию.
  const access = evaluateAgentAccess(account);
  if (!access.allowed) {
    if (access.reason === "verification_required" || access.reason === "not_onboarded") {
      // Чужие двери. У гейта верификации есть своя карточка с кнопкой «пройти
      // проверку» (`router.ts`), у незаконченного онбординга — своя реплика;
      // ответить тут голой строкой значило бы подменить их обе на худшее.
      await next();
      return;
    }
    // А вот модерация останавливает апдейт прямо здесь: против этого аккаунта
    // меры уже приняты, и до хранилища с распознаванием он доходить не должен.
    await ctx.reply(t(lang, AGENT_DENIAL_COPY[access.reason]));
    return;
  }

  const photo = ctx.message.photo.at(-1);
  if (!photo) {
    await next();
    return;
  }
  if (photo.file_size !== undefined && photo.file_size > MAX_PHOTO_BYTES) {
    await ctx.reply(t(lang, "photoVisionError"));
    return;
  }

  try {
    await ctx.replyWithChatAction("typing");
  } catch {
    // Индикатор — вежливость, а не часть хода.
  }

  const buffer = await downloadTelegramFile(ctx.api, photo.file_id);
  // Размер проверяется второй раз уже по факту: `file_size` присылает Telegram,
  // а верить чужому числу вместо собственного — то же самое, что не проверять.
  if (!buffer || buffer.byteLength > MAX_PHOTO_BYTES) {
    await ctx.reply(t(lang, "photoVisionError"));
    return;
  }
  // Расширение и заголовки тут не при чём: тип берётся из первых байтов, как и
  // на мобильной загрузке (audit M2).
  const mime = sniffImageMime(buffer);
  if (!mime) {
    await ctx.reply(t(lang, "photoInvalidMedia"));
    return;
  }

  const userId = account.id;
  let result: ChatToolResult;
  try {
    const uploaded = await uploadChatImage(userId, buffer, mime);
    // Строка в `Message` — не журнал, а условие входа: `attachChatProfilePhoto`
    // требует, чтобы картинка уже была ходом ЭТОГО человека в чате, и проверяет
    // это по таблице. Мобильный `/v1/chat/message` пишет её ровно так же.
    await prisma.message.create({
      data: {
        userId,
        role: "user",
        content: ctx.message.caption?.trim() ?? "",
        imageUrl: uploaded.path,
      },
    });
    result = await attachChatProfilePhoto(userId, { imageUrl: uploaded.path });
  } catch (err) {
    console.warn("[photo] profile attach failed:", err);
    await ctx.reply(t(lang, "photoVisionError"));
    return;
  }

  const reply = attachOutcomeMessage(lang, result);
  await ctx.reply(reply);
  // Ответная строка дописывается в ту же историю, и не ради красоты: последним
  // ходом там осталась бы картинка от пользователя, а `chat-agent` отправляет
  // модели ПОСЛЕДНЕЕ изображение — мобильный чат при следующем открытии
  // попытался бы приложить этот же снимок ещё раз.
  await prisma.message
    .create({ data: { userId, role: "assistant", content: reply } })
    .catch((err: unknown) => {
      console.warn("[photo] chat history write failed:", err);
    });
});

/** Что сказать человеку про его снимок. */
function attachOutcomeMessage(lang: Language, result: ChatToolResult): string {
  if (!result.ok) return rejectionMessage(lang, result.reason);

  // `pending` и `capped` — проверки пройдены, но в альбом фотография ещё не
  // попала: личность не закреплена вторым снимком. «Добавил» тут было бы
  // неправдой, и человек не понял бы, почему в профиле пусто.
  const consensus = result.photo?.consensus ?? "accepted";
  if (consensus === "pending") return t(lang, "photoConsensusPending");
  if (consensus === "capped") return t(lang, "photoConsensusNoPairCap");

  const added = t(lang, "photoBatchAdded", {
    n: 1,
    total: result.photo?.total ?? 1,
    max: MAX_PHOTOS,
  });
  return consensus === "confirmed"
    ? `${added}\n\n${t(lang, "photoConsensusConfirmed")}`
    : added;
}

function rejectionMessage(lang: Language, reason: ChatPhotoRejection | undefined): string {
  switch (reason) {
    case undefined:
    case "bad_payload":
    case "not_owned":
    case "image_unavailable":
      // Эти отказы — про наш конвейер, а не про снимок. Человеку в фотографии
      // исправлять нечего, поэтому и фраза общая, без ложного совета.
      return t(lang, "photoVisionError");
    case "max_photos":
      return t(lang, "photoBatchAtMax", { max: MAX_PHOTOS });
    default:
      return photoValidationMessage(lang, reason);
  }
}
