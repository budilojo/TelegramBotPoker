'use strict';
/**
 * Поток для перебора: бот шашек думает здесь, а не в основном потоке, —
 * иначе полторы секунды его раздумий остановили бы все остальные столы.
 */
import { parentPort } from 'node:worker_threads';
import { bestMove } from './engine.js';

parentPort.on('message', ({ id, fen, level, seed }) => {
  try {
    parentPort.postMessage({ id, result: bestMove(fen, level, { seed }) });
  } catch (err) {
    parentPort.postMessage({ id, error: String(err?.message || err) });
  }
});
