import { existsSync } from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { runJobInline, type RenderJob, type RenderResult } from "./jobs.js";

/**
 * Пул рабочих потоков для растеризации карточек.
 *
 * **Зачем.** `satori`, `Resvg.render()` и попиксельные циклы — синхронная
 * нативная работа. Комментарий в `services/date-card/index.ts` фиксирует
 * замер на живом матче: **одна карточка растеризуется ~45 секунд**, и всё
 * это время event loop заблокирован. А процесс на проде один: тот же loop
 * держит long-polling бота, публичный API, админку и все 25+ кронов. Тап по
 * «поделиться карточкой» останавливал продукт целиком — включая анимацию
 * «идёт работа», которую показывают, чтобы человек не тапал повторно, и
 * включая все `AbortSignal.timeout`, которые продолжают тикать по стенным
 * часам и срабатывают ложно.
 *
 * **Почему с откатом.** Поднять поток может не получиться: загрузчик TypeScript
 * в рабочем потоке — вещь хрупкая, а цена ошибки — карточки перестают
 * рендериться вовсе. Поэтому пул сначала ждёт рукопожатия, и если его нет —
 * навсегда переключается на inline. Худший случай тогда РАВЕН сегодняшнему
 * поведению, а не хуже него.
 */

/** Сколько ждать рукопожатия, прежде чем признать поток непригодным. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Потолок — два потока, но на проде их будет ОДИН.
 *
 * Проверено на дроплете 2026-09-07: `nproc` = 1, памяти 2 ГБ, и на этом же
 * ядре живут ДВА процесса PM2 (`gennety-bot` и `gennety-demo`). Значит
 * `cpus().length - 1` даёт ноль, и остаётся единственный поток.
 *
 * И это правильный ответ, а не досадное совпадение. Смысл выноса — не
 * параллелизм, которого на одном ядре быть не может, а отзывчивость: с
 * потоком планировщик ОС нарезает время между ним и главным циклом, и цикл
 * успевает отвечать на запросы и таймеры вместо того, чтобы замереть на
 * 45 секунд целиком. Второй поток при одном ядре только отбирал бы
 * процессор у того самого цикла, ради которого всё затевалось, и добавил бы
 * свою копию нативных модулей к и без того тесной памяти.
 */
const MAX_WORKERS = 2;

/**
 * Потолок одного задания в потоке. Самая тяжёлая карточка считается ~45 с на
 * одном ядре; задание, которое идёт втрое дольше, считаем зависшим. Поток
 * тогда убивается: на проде он один, и занятый навсегда слот означал бы, что
 * все последующие карточки ждут вечно.
 */
const JOB_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Сколько раз за жизнь процесса поднимать пул заново после гибели всех
 * потоков (OOM на большой карточке, убитое зависшее задание). Дальше — inline
 * навсегда, чтобы падающий на каждом задании поток не крутился по кругу.
 */
const MAX_POOL_RESPAWNS = 3;

type Pending = {
  resolve: (value: RenderResult) => void;
  reject: (error: Error) => void;
};

type Slot = {
  worker: Worker;
  busy: boolean;
  /** Задание в полёте — его надо отклонить, если поток умрёт. */
  jobId: number | null;
  jobTimer: NodeJS.Timeout | null;
  dead: boolean;
};

/** Задание убито по `JOB_TIMEOUT_MS`: повторять его inline нельзя — оно повесит loop. */
class RenderJobTimeoutError extends Error {}

let pool: Slot[] | null = null;
let initialising: Promise<Slot[] | null> | null = null;
/** Однажды признав потоки непригодными, больше не пробуем — и не шумим в лог. */
let disabled = false;
let respawns = 0;

const pending = new Map<number, Pending>();
let nextId = 1;
const queue: Array<() => void> = [];

function workerEntry(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // `.js` первым: если проект однажды начнут собирать, скомпилированный файл
  // не потребует загрузчика вовсе. Сегодня прод запускается через `tsx`
  // прямо из исходников, поэтому находится `.ts`.
  for (const name of ["worker.js", "worker.ts"]) {
    const candidate = path.join(here, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function spawn(entry: string): Promise<Slot | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (slot: Slot | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(slot);
    };

    const timer = setTimeout(() => {
      finish(null);
    }, HANDSHAKE_TIMEOUT_MS);

    let worker: Worker;
    try {
      worker = new Worker(entry, {
        // Рабочему потоку нужен собственный загрузчик TypeScript: хуки
        // главного потока на него не распространяются.
        ...(entry.endsWith(".ts") ? { execArgv: ["--import", "tsx"] } : {}),
      });
    } catch (error) {
      console.warn("[render] worker spawn failed, falling back inline:", error);
      finish(null);
      return;
    }

    const slot: Slot = { worker, busy: false, jobId: null, jobTimer: null, dead: false };

    worker.on("message", (message: Record<string, unknown>) => {
      if (message.ready === true) {
        finish(slot);
        return;
      }
      const id = message.id as number | undefined;
      if (id === undefined) return;
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (slot.jobTimer) clearTimeout(slot.jobTimer);
      slot.jobTimer = null;
      slot.jobId = null;
      slot.busy = false;
      // Простаивающий поток не обязан удерживать процесс живым. Держим его
      // ref'нутым РОВНО пока задание в полёте — иначе скрипт с одним
      // рендером завершался бы, не дождавшись ответа («unsettled top-level
      // await»), а долгоживущий процесс не смог бы выйти по своей воле.
      slot.worker.unref();
      if (message.ok === true) {
        const value = message.value as Uint8Array | null;
        waiter.resolve(value === null ? null : Buffer.from(value));
      } else {
        waiter.reject(new Error(String(message.error ?? "render worker failed")));
      }
      queue.shift()?.();
    });

    worker.on("error", (error) => {
      console.warn("[render] worker error:", error);
      finish(null);
      retire(slot);
    });
    worker.on("exit", () => {
      retire(slot);
    });

    // Свежий поток простаивает — пусть не мешает процессу завершиться.
    worker.unref();
  });
}

/**
 * Убрать умерший поток и отпустить всех, кто ждал именно его.
 *
 * До 2026-10-13 здесь только вычёркивали поток из пула: задание, которое он
 * считал, оставалось в `pending` навсегда, его вызывающий не получал ни
 * ответа, ни ошибки, а очередь ждущих свободного слота больше никто не
 * будил. На проде поток один — после первого OOM все карточки висели.
 */
function retire(slot: Slot, reason: Error = new Error("render worker exited")): void {
  if (slot.dead) return;
  slot.dead = true;
  slot.busy = true; // мёртвый слот больше никогда не выдаётся
  if (slot.jobTimer) clearTimeout(slot.jobTimer);
  slot.jobTimer = null;
  if (slot.jobId !== null) {
    const waiter = pending.get(slot.jobId);
    pending.delete(slot.jobId);
    slot.jobId = null;
    waiter?.reject(reason);
  }
  if (pool) {
    pool = pool.filter((s) => s !== slot);
    if (pool.length === 0) {
      pool = null;
      if (respawns < MAX_POOL_RESPAWNS) {
        respawns += 1;
        console.warn(`[render] all workers gone — respawning on next job (${respawns}/${MAX_POOL_RESPAWNS})`);
      } else {
        console.warn("[render] workers keep dying — rendering inline from now on");
        disabled = true;
      }
    }
  }
  // Ждущие получат живой слот или `undefined` → inline. Но не повиснут.
  for (const wake of queue.splice(0)) wake();
}

async function ensurePool(): Promise<Slot[] | null> {
  if (disabled) return null;
  if (pool) return pool;
  initialising ??= (async () => {
    const entry = workerEntry();
    if (!entry) {
      console.warn("[render] worker entry not found, rendering inline");
      disabled = true;
      return null;
    }
    const size = Math.min(MAX_WORKERS, Math.max(1, cpus().length - 1));
    const slots = (await Promise.all(Array.from({ length: size }, () => spawn(entry)))).filter(
      (s): s is Slot => s !== null,
    );
    if (slots.length === 0) {
      console.warn("[render] no render worker came up, rendering inline from now on");
      disabled = true;
      return null;
    }
    pool = slots;
    return slots;
  })();
  const result = await initialising;
  initialising = null;
  return result;
}

function freeSlot(slots: Slot[]): Slot | undefined {
  return slots.find((s) => !s.busy);
}

/**
 * Выполнить задание растеризации вне главного потока.
 *
 * Если пул недоступен — считает здесь же. Вызывающему разницы не видно, и
 * это намеренно: единственное, что он должен знать, — что результат придёт.
 */
export async function runRenderJob(job: RenderJob): Promise<RenderResult> {
  const slots = await ensurePool();
  if (!slots) return runJobInline(job);

  const slot = freeSlot(slots) ?? (await waitForFreeSlot());
  // Пул умер, пока ждали: respawn или inline решит `ensurePool` (число
  // перезапусков ограничено, так что рекурсия конечна).
  if (!slot) return runRenderJob(job);

  slot.busy = true;
  const id = nextId++;
  return new Promise<RenderResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    slot.jobId = id;
    try {
      // На время задания поток удерживает процесс: ответ обязан быть дождан.
      slot.worker.ref();
      slot.worker.postMessage({ id, job });
    } catch (error) {
      pending.delete(id);
      slot.jobId = null;
      slot.busy = false;
      slot.worker.unref();
      queue.shift()?.();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    slot.jobTimer = setTimeout(() => {
      console.error(`[render] job ${job.kind} exceeded ${JOB_TIMEOUT_MS}ms — terminating its worker`);
      retire(slot, new RenderJobTimeoutError(`render job ${job.kind} timed out`));
      void slot.worker.terminate().catch(() => undefined);
    }, JOB_TIMEOUT_MS);
    slot.jobTimer.unref();
  }).catch(async (error: unknown) => {
    // Зависшее задание inline повесило бы уже главный поток — отдаём ошибку.
    if (error instanceof RenderJobTimeoutError) throw error;
    // Поток не справился — не терять карточку из-за этого. Считаем на месте,
    // приняв разовую блокировку loop'а как меньшее зло.
    console.warn("[render] job failed in worker, retrying inline:", error);
    return runJobInline(job);
  });
}

/**
 * Дождаться свободного слота. `undefined` — пула больше нет (все потоки
 * умерли): вызывающий заново проходит через `ensurePool`.
 */
function waitForFreeSlot(): Promise<Slot | undefined> {
  return new Promise((resolve) => {
    const wake = (): void => {
      // Текущий пул, а не снимок: слот, ради которого ждали, мог умереть.
      if (!pool) return resolve(undefined);
      const slot = freeSlot(pool);
      if (slot) resolve(slot);
      else queue.push(wake);
    };
    queue.push(wake);
  });
}

/**
 * Куда сейчас уходит растеризация.
 *
 * Нужна не тестам, а эксплуатации: молчаливый откат на inline означает, что
 * блокировка loop'а вернулась, и это ровно тот случай, который снаружи
 * выглядит как «бот иногда подтормаживает».
 */
export function renderPoolStatus(): "worker" | "inline" | "cold" {
  if (pool && pool.length > 0) return "worker";
  if (disabled) return "inline";
  return "cold";
}

/** Для тестов и корректного завершения процесса. */
export async function shutdownRenderPool(): Promise<void> {
  const slots = pool;
  pool = null;
  disabled = false;
  respawns = 0;
  if (!slots) return;
  await Promise.all(slots.map((s) => s.worker.terminate()));
}
