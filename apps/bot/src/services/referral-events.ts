import { createHash } from "node:crypto";
import { prisma } from "@gennety/db";
import { parseReferrer, referralSourceFromParam } from "./referral.js";
import { isUniqueViolation } from "./ticket-wallet.js";

/**
 * Запись виральной воронки шеринга (`referral_events`).
 *
 * Зачем она нужна поверх уже существующей реферальной связки: `referralSource`
 * + `referralCountedAt` дают ЧИСЛИТЕЛЬ K-фактора (сколько приглашённых дошло до
 * активации) и ничего не говорят о знаменателе. Без «сколько раз вообще
 * поделились» и «сколько по этим ссылкам перешло» K не раскладывается на
 * `i × c`, и «делится мало кто» неотличимо от «делятся, но не приходят». Это
 * два разных продуктовых действия, поэтому мерить их одним числом бессмысленно.
 *
 * **Ни одна функция здесь не бросает в вызывающий код.** Это аналитика на
 * горячем пути: `/start`, шеринг из Mini App. Упавшая запись события не имеет
 * права уронить регистрацию или шеринг, поэтому всё завёрнуто и логируется
 * предупреждением. Единственный тип ошибки, который вообще ожидается, —
 * дубликат по `dedupeKey`, и он не ошибка, а работающая идемпотентность.
 */

/**
 * Закрытый перечень шагов. Хранится в БД строкой (см. комментарий модели), но
 * проверяется здесь: единственная запись в таблицу проходит через этот файл.
 */
export const REFERRAL_EVENT_KINDS = [
  /** Пользователь открыл шеринг (сервер подготовил инвайт-сообщение). */
  "share_sheet_opened",
  /** Telegram подтвердил, что подготовленное сообщение реально отправлено. */
  "invite_sent",
  /** Кто-то перешёл по инвайт-ссылке (`?start=referral_<id>`). */
  "invite_link_clicked",
] as const;

export type ReferralEventKind = (typeof REFERRAL_EVENT_KINDS)[number];

export const REFERRAL_EVENT_SURFACES = ["tg", "tg-mini", "ios", "web"] as const;
export type ReferralEventSurface = (typeof REFERRAL_EVENT_SURFACES)[number];

/** UTC-день в виде `YYYY-MM-DD` — бакет дедупликации кликов. */
function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Короткий необратимый отпечаток идентификатора кликнувшего.
 *
 * Ключ дедупликации нужен только для сравнения «тот же человек или другой», и
 * ничего кроме равенства из него не требуется. Поэтому в аналитическую таблицу
 * кладётся хэш, а не сам `telegramId`: строка остаётся ровно так же пригодной
 * для дедупликации и перестаёт быть идентификатором, который можно откуда-то
 * извлечь. Соли нет намеренно — она обязана была бы пережить рестарт процесса,
 * иначе один и тот же человек стал бы двумя, а хранимая рядом соль защищает
 * ровно ни от чего.
 */
function fingerprint(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

interface RecordInput {
  kind: ReferralEventKind;
  dedupeKey: string;
  surface: ReferralEventSurface;
  referrerId?: string | null;
  inviteeId?: string | null;
  occurredAt?: Date;
}

/**
 * Записать одно событие воронки. Возвращает `true`, если строка действительно
 * появилась, и `false`, если такое событие уже было учтено (или запись не
 * удалась — оба случая одинаково означают «счётчик не изменился»).
 */
async function record(input: RecordInput): Promise<boolean> {
  try {
    await prisma.referralEvent.create({
      data: {
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        surface: input.surface,
        referrerId: input.referrerId ?? null,
        inviteeId: input.inviteeId ?? null,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false; // уже учтено — штатный путь
    // Нарушение внешнего ключа (реферер удалён между чтением и записью) и любая
    // другая ошибка: событие теряется, запрос — нет.
    console.warn(`[referral-events] failed to record ${input.kind}:`, err);
    return false;
  }
}

/**
 * Пользователь открыл шеринг: сервер подготовил инвайт-сообщение.
 *
 * Ключуется по id подготовленного Telegram-сообщения — это ровно один акт
 * шеринга, и повторный вызов с тем же id не удваивает знаменатель.
 */
export async function recordShareSheetOpened(params: {
  referrerId: string;
  preparedMessageId: string;
  surface: ReferralEventSurface;
}): Promise<boolean> {
  return record({
    kind: "share_sheet_opened",
    dedupeKey: `share:${params.referrerId}:${params.preparedMessageId}`,
    surface: params.surface,
    referrerId: params.referrerId,
  });
}

/**
 * Приглашение реально ушло: клиент сообщил, что Telegram отчитался об
 * отправке подготовленного сообщения.
 *
 * Это единственный честный источник для `invite_sent`. Сервер не видит момент
 * отправки: `savePreparedInlineMessage` только готовит сообщение, а выбрал ли
 * человек чат или закрыл шторку — знает лишь колбэк `shareMessage` на клиенте.
 * Считать отправкой сам факт подготовки значило бы завышать `i` на все
 * передумавшие шеринги.
 */
export async function recordInviteSent(params: {
  referrerId: string;
  preparedMessageId: string;
  surface: ReferralEventSurface;
}): Promise<boolean> {
  return record({
    kind: "invite_sent",
    dedupeKey: `sent:${params.referrerId}:${params.preparedMessageId}`,
    surface: params.surface,
    referrerId: params.referrerId,
  });
}

/**
 * Переход по инвайт-ссылке.
 *
 * Дедупликация — «реферер + перешедший + UTC-день»: человек, десять раз
 * нажавший `/start`, обязан дать одну единицу в знаменатель конверсии, а не
 * десять, иначе `clickRate` измеряет нетерпеливость, а не воронку. Сутки —
 * потому что переход, повторённый через неделю, это уже другое событие
 * (вернулся подумав), и склеивать их значило бы терять реальные возвраты.
 *
 * `clickerKey` — любой стабильный идентификатор перешедшего (`telegramId`,
 * `installId`): наружу он не выходит, в БД кладётся его отпечаток.
 *
 * Записывается ДО того, как известно, зарегистрируется ли человек: клик — это
 * факт сам по себе, и терять его из-за того, что аккаунт ещё не создан, значит
 * терять весь знаменатель конверсии перехода.
 */
export async function recordInviteLinkClicked(params: {
  referrerId: string | null;
  clickerKey: string;
  surface: ReferralEventSurface;
  inviteeId?: string | null;
  at?: Date;
}): Promise<boolean> {
  const at = params.at ?? new Date();
  const who = fingerprint(params.clickerKey);
  return record({
    kind: "invite_link_clicked",
    dedupeKey: `click:${params.referrerId ?? "unknown"}:${who}:${utcDayKey(at)}`,
    surface: params.surface,
    referrerId: params.referrerId,
    inviteeId: params.inviteeId ?? null,
    occurredAt: at,
  });
}

/**
 * Разобрать `start`/`startapp`-payload и, если это инвайт-ссылка, записать
 * переход. Возвращает id реферера, когда он разобрался, иначе null.
 *
 * Существует, чтобы обе точки входа (бот `/start` и Mini App `startapp`)
 * делали это одинаково: две копии одного разбора рано или поздно разойдутся, и
 * тогда половина кликов перестанет считаться без единой ошибки в логах.
 */
export async function recordInviteClickFromStartPayload(params: {
  payload: string;
  channelPrefix: "tg" | "tg-mini";
  clickerKey: string;
  surface: ReferralEventSurface;
  inviteeId?: string | null;
}): Promise<string | null> {
  const payload = params.payload.trim();
  if (payload.length === 0 || payload.length > 64) return null;
  const referrerId = parseReferrer(referralSourceFromParam(payload, params.channelPrefix));
  if (!referrerId) return null;

  // Существует ли реферер — проверяется здесь, а не в `record`: внешний ключ
  // отверг бы строку целиком, а клик по ссылке удалённого аккаунта всё равно
  // должен быть учтён (с `referrerId = null`), иначе органика молча съест то,
  // что на самом деле было виральным переходом.
  const referrer = await prisma.user
    .findUnique({ where: { id: referrerId }, select: { id: true } })
    .catch(() => null);

  await recordInviteLinkClicked({
    referrerId: referrer?.id ?? null,
    clickerKey: params.clickerKey,
    surface: params.surface,
    inviteeId: params.inviteeId ?? null,
  });

  return referrer?.id ?? null;
}
