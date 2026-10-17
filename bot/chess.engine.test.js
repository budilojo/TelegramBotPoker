'use strict';
/**
 * Шахматный бот (games/chess/engine.js): ходит законно, видит простое и
 * различается по силе. Это не турнир движков — проверяется то, что увидит
 * человек: бот не зевает ферзя «за так» на средних уровнях, ставит мат в
 * один ход, когда может, и никогда не делает невозможного хода.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestMove, LEVELS } from './games/chess/engine.js';
import { fromFen, legalMoves, make, sqName, START_FEN, toFen } from './games/chess/board.js';
import { seededRng } from './deck.js';

const uci = (r) => sqName(r.from) + sqName(r.to) + (r.promo || '');

test('мат в один ход видят все уровни, кроме «новичка», — всегда', () => {
  const fen = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 0 4';
  for (let l = 1; l < LEVELS.length; l++) {
    for (let seed = 1; seed <= 5; seed++) assert.equal(uci(bestMove(fen, l, { seed })), 'h5f7', `${LEVELS[l].name}, seed ${seed}`);
  }
});

test('ферзь под конём: с «клубного» уровня бот берёт его всегда, «новичок» — чаще всего', () => {
  const fen = 'rnb1kbnr/pppp1ppp/8/4p3/3qP3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 4';
  let novice = 0;
  for (let seed = 1; seed <= 20; seed++) {
    if (uci(bestMove(fen, 0, { seed })) === 'f3d4') novice++;
    assert.equal(uci(bestMove(fen, 2, { seed })), 'f3d4');
  }
  assert.ok(novice >= 10, `новичок берёт подарок хотя бы в половине партий (взял ${novice} из 20)`);
});

test('свой ферзь под боем слона, слон незащищён: «любитель» и сильнее просто забирают слона', () => {
  // Белый ферзь d1 под слоном b3; слона можно взять — Qxb3, и угрозы нет.
  const fen = '4k3/8/8/8/8/1b6/8/3QK3 w - - 0 1';
  for (let l = 1; l < LEVELS.length; l++) {
    for (let seed = 1; seed <= 3; seed++) assert.equal(uci(bestMove(fen, l, { seed })), 'd1b3', `${LEVELS[l].name}, seed ${seed}`);
  }
});

test('бот никогда не делает незаконного хода: 40 случайных позиций, все уровни', () => {
  const rnd = seededRng(11);
  for (let game = 0; game < 40; game++) {
    let pos = fromFen(START_FEN);
    const plies = 4 + Math.floor(rnd() * 40);
    for (let i = 0; i < plies; i++) {
      const moves = legalMoves(pos);
      if (!moves.length) break;
      pos = make(pos, moves[Math.floor(rnd() * moves.length)]);
    }
    if (!legalMoves(pos).length) continue;
    const level = game % LEVELS.length;
    const r = bestMove(toFen(pos), level, { seed: game + 1, timeMs: 120 });
    assert.ok(legalMoves(pos).some((m) => m.from === r.from && m.to === r.to && (m.promo || '') === r.promo), `позиция ${toFen(pos)}`);
  }
});

test('нет ходов — нет ответа: мат и пат бот не «ходит»', () => {
  assert.equal(bestMove('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', 3), null);
  assert.equal(bestMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 3), null);
});

test('время на ход ограничено: даже «мастер» укладывается в срок с запасом', () => {
  const t = Date.now();
  bestMove('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 4, { timeMs: 300 });
  assert.ok(Date.now() - t < 1500, `уложился за ${Date.now() - t} мс при лимите 300`);
});
