import { parentPort } from "node:worker_threads";
import { runJobInline, type RenderJob } from "./jobs.js";

/**
 * Рабочий поток растеризации.
 *
 * Единственная его задача — снять синхронную нативную работу с главного
 * потока. Ничего своего он не решает: получает задание, зовёт ту же
 * `runJobInline`, что и запасной путь, и возвращает байты.
 */

const port = parentPort;
if (port) {
  port.on("message", (message: { id: number; job: RenderJob }) => {
    void (async () => {
      try {
        const value = await runJobInline(message.job);
        // `Uint8Array` уходит копией: `transferList` здесь не применить —
        // буфер может быть частью пула Node, и передать его владение значит
        // оторвать память у отправителя.
        port.postMessage({ id: message.id, ok: true, value });
      } catch (error) {
        port.postMessage({ id: message.id, ok: false, error: String(error) });
      }
    })();
  });
  // Рукопожатие: пул ждёт его, чтобы отличить «поток поднялся» от «модуль не
  // загрузился». Без него первый же провал загрузки выглядел бы как зависание.
  port.postMessage({ ready: true });
}
