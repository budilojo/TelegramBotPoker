'use strict';
/**
 * Аудит E-01: поток движка шахмат/шашек не копит поиски для брошенных партий.
 *
 * Один человек, жмущий «Сыграть ещё» против «Мастера», раньше ставил в поток
 * поиск за поиском (по 1,6 с), и бот у всех остальных отвечал через десятки
 * секунд. Теперь задание, которое больше не нужно, снимается, не начавшись.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { engineQueue } from './games/engine-queue.js';
import { bestMove as chessBest } from './games/chess/engine.js';
import { bestMove as checkersBest } from './games/checkers/engine.js';
import { START_FEN } from './games/chess/board.js';
import { toFen as checkersFen, startPosition as checkersStart } from './games/checkers/board.js';

for (const [name, url, best, fen, level] of [
  ['шахматы', new URL('./games/chess/engine-worker.js', import.meta.url), chessBest, START_FEN, 3],
  ['шашки', new URL('./games/checkers/engine-worker.js', import.meta.url), checkersBest, checkersFen(checkersStart()), 3],
]) {
  test(`АУДИТ E-01: ${name} — 20 брошенных поисков не задерживают нужный`, async () => {
    const engine = engineQueue(url, (f, l, s) => best(f, l, { seed: s }));
    const t0 = Date.now();
    const one = await engine(fen, level, 1);
    const single = Date.now() - t0;
    assert.ok(one, 'поиск даёт ход');

    let stale = 0;
    const jobs = [];
    // Первый уйдёт в поток сразу (его уже не снять), остальные девятнадцать — брошены.
    for (let i = 0; i < 20; i++) jobs.push(engine(fen, level, i, () => i === 0).then((r) => (r === null ? stale++ : 0, r)));
    const t1 = Date.now();
    const wanted = await engine(fen, level, 99);
    const waited = Date.now() - t1;
    await Promise.all(jobs);
    assert.ok(wanted, 'нужный поиск дал ход');
    assert.equal(stale, 19, 'брошенные сняты, не начавшись');
    assert.ok(waited < single * 4 + 500, `нужный ждал ${waited} мс при одном поиске ${single} мс`);
  });
}
