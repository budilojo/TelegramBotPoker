'use strict';
/**
 * Поток движка для ботов шахмат и шашек — с очередью на стороне бота.
 *
 * Поток один на игру, и думает он по одной позиции за раз (до 1,6 с на
 * «Мастере»). Раньше каждый запрос сразу уходил в поток, а очередь копилась
 * внутри него: человек, который жмёт «Сыграть ещё» раз в секунду, ставил
 * поиск за поиском для партий, которых уже нет, — и бот у всех остальных
 * отвечал через десятки секунд (аудит, E-01).
 *
 * Теперь очередь здесь: в поток уходит следующее задание, только когда
 * закончилось предыдущее, и перед отправкой задание спрашивают, нужно ли оно
 * ещё (`alive`). Партию заменили, удалили, ход уже сделан — задание снимается,
 * не начавшись, и бот получает `null` (ядро и так перепроверяет, ждут ли его).
 */
import { Worker } from 'node:worker_threads';

/**
 * @param url       адрес файла потока (engine-worker.js игры)
 * @param inline    тот же поиск в основном потоке — если поток не поднялся
 * @returns engine(fen, level, seed, alive?) → Promise<ход|null>
 */
export function engineQueue(url, inline) {
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  const queue = [];
  let busy = false;

  function spawn() {
    if (worker) return worker;
    try {
      worker = new Worker(url);
      worker.on('message', ({ id, result, error }) => {
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (!pending.size) worker?.unref(); // ответов не ждём — поток не держит процесс
        if (error) p.reject(new Error(error));
        else p.resolve(result);
      });
      worker.on('error', (err) => {
        for (const p of pending.values()) p.reject(err);
        pending.clear();
        worker = null;
      });
      // Поток держит процесс, только пока бот думает (ref на время запроса):
      // иначе остановка бота ждала бы его вечно.
      worker.unref();
    } catch {
      worker = null;
    }
    return worker;
  }

  function run({ fen, level, seed }) {
    const w = spawn();
    if (!w) return Promise.resolve(inline(fen, level, seed));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.ref();
      w.postMessage({ id, fen, level, seed });
    }).catch(() => inline(fen, level, seed));
  }

  function pump() {
    if (busy) return;
    // Задания для партий, которых уже нет (или где ход уже сделан), — снять.
    while (queue.length && !queue[0].alive()) queue.shift().resolve(null);
    const job = queue.shift();
    if (!job) return;
    busy = true;
    run(job)
      .then(job.resolve, () => job.resolve(null))
      .finally(() => {
        busy = false;
        pump();
      });
  }

  return function engine(fen, level, seed, alive = () => true) {
    return new Promise((resolve) => {
      queue.push({ fen, level, seed, alive, resolve });
      pump();
    });
  };
}
