import { afterAll, describe, expect, it } from "vitest";
import { runJobInline } from "./jobs.js";
import { runRenderJob, shutdownRenderPool } from "./pool.js";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">' +
  '<rect width="200" height="120" fill="#7B1E3A"/></svg>';

function isPng(bytes: Uint8Array | null): boolean {
  return (
    bytes !== null &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

/**
 * Разгрузка главного потока (аудит 2026-09-06, «Производительность №2»).
 *
 * Комментарий в `services/date-card/index.ts` фиксирует замер на живом
 * матче: одна карточка растеризуется ~45 секунд, и всё это время event loop
 * заблокирован — а процесс на проде один на бота, оба API и все кроны.
 *
 * Тест проверяет КОНТРАКТ, а не маршрут: вызывающему всё равно, посчитали
 * задание в рабочем потоке или на месте, и обе ветки обязаны дать
 * одинаковый ответ. Что поток реально поднимается под `tsx` — проверено
 * отдельно, живым запуском (`renderPoolStatus()` вернул `worker`).
 */
describe("render pool", () => {
  afterAll(async () => {
    await shutdownRenderPool();
  });

  it("растеризует SVG в настоящий PNG", async () => {
    const png = await runRenderJob({ kind: "svg-to-png", svg: SVG, fitToWidth: 200 });
    expect(isPng(png)).toBe(true);
  });

  it("даёт тот же ответ, что и запасной inline-путь", async () => {
    // Если пул однажды не поднимется, продукт обязан продолжить работать
    // ровно как раньше — просто медленнее. Это и есть смысл отката.
    const viaPool = await runRenderJob({ kind: "svg-to-png", svg: SVG, fitToWidth: 200 });
    const inline = await runJobInline({ kind: "svg-to-png", svg: SVG, fitToWidth: 200 });
    expect(isPng(inline)).toBe(true);
    expect(Buffer.from(viaPool!).equals(Buffer.from(inline!))).toBe(true);
  });

  it("возвращает null на недекодируемых байтах, а не бросает", async () => {
    // Вызывающие рисуют запасной фон именно по `null`; исключение здесь
    // уронило бы отправку карточки целиком.
    const out = await runRenderJob({
      kind: "to-png",
      bytes: Buffer.from("это не картинка"),
    });
    expect(out).toBeNull();
  });
});
