'use strict';
/**
 * Бот длинных нард: выбор хода по тому, что видно на доске, и по выпавшим
 * кубикам. Будущих кубиков бот не знает — как человек.
 *
 * Ходы — только из `sequences` (board.js, те же правила, что у сервера):
 * бот не может сыграть меньше чисел, чем можно, взять с головы лишнюю или
 * запереть шестью подряд — таких последовательностей просто нет.
 *
 * Сила — в ТОЧНОСТИ: лучший ход по оценке позиции, а уровни ниже иногда
 * играют небрежно (любой допустимый ход). Глубже бот не думает: замеры
 * показали, что взгляд на ход вперёд по всем 21 броску соперника и
 * розыгрыши партии с этой оценкой силы не прибавляют (docs/nardy.md).
 *
 * Оценка позиции (для того, чей ход был):
 *   путь — сколько осталось пройти сопернику минус себе;
 *   свои пункты впереди задней шашки соперника — мешают ему;
 *   снятые шашки; голова (засидевшиеся — минус); стопки больше трёх — минус.
 */
import { sequences, apply, pips, idx, abs, mine, other, key } from './board.js';

/** Уровни: имя и доля небрежных ходов (любой допустимый вместо лучшего). */
export const LEVELS = [
  { name: 'Новичок', random: 0.6 },
  { name: 'Любитель', random: 0.32 },
  { name: 'Клубный', random: 0.16 },
  { name: 'Сильный', random: 0.07 },
  { name: 'Мастер', random: 0 },
];

/** Веса оценки. Подбор партиями прибавки не дал (docs/nardy.md); «забор подряд» — только мешал, его нет. */
export const W = { point: 1.2, off: 2, head: 1.5, stack: 0.6 };

/** Оценка позиции для цвета `c`: чем больше, тем лучше ему. */
export function evaluate(pos, c, w = W) {
  const o = other(c);
  let score = (pips(pos, o) - pips(pos, c)) * 1.0;
  score += (pos.off[c] - pos.off[o]) * w.off;
  // Свои пункты впереди задней шашки соперника — ему мешают.
  let rear = 24;
  for (let p = 0; p < 24; p++) if (mine(pos.b, p, o)) rear = Math.min(rear, idx(o, p));
  for (let j = rear + 1; j < 24; j++) if (mine(pos.b, abs(o, j), c)) score += w.point;
  // Голова: после первых ходов шашки должны уходить.
  const head = mine(pos.b, abs(c, 0), c);
  if (head < 15) score -= Math.max(0, head - 10) * w.head;
  for (let p = 0; p < 24; p++) {
    const n = mine(pos.b, p, c);
    if (n > 3) score -= (n - 3) * w.stack;
  }
  return score;
}

export function rngFrom(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Последний расчёт: бот зовётся на каждый шаг одного и того же хода. */
let lastSeqs = { k: null, seqs: null };
function allSeqs(start, dice, headLimit) {
  const k = `${key(start)}|${dice.join()}|${headLimit}`;
  if (lastSeqs.k !== k) lastSeqs = { k, seqs: sequences(start, dice, { headLimit }).seqs };
  return lastSeqs.seqs;
}

/**
 * Последовательность хода: из позиции начала хода `start`, броска `dice`,
 * уже сыгранных шагов `played`. Возвращает выбранную последовательность
 * целиком (её начало — `played`), или null — ходить нечем.
 */
export function chooseSequence(start, dice, played, level, { headLimit = 1, seed = 1 } = {}) {
  const L = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, level))];
  const rng = rngFrom(seed);
  const c = start.t;
  const same = (a, b) => a.from === b.from && a.to === b.to && a.die === b.die;
  const seqs = allSeqs(start, dice, headLimit).filter((s) => s.length >= played.length && played.every((x, i) => same(x, s[i])));
  if (!seqs.length || !seqs[0].length) return null;
  // Одна позиция — один кандидат: порядок шагов, ведущих туда же, не важен.
  const byFinal = new Map();
  for (const s of seqs) {
    const q = s.reduce((x, st) => apply(x, st), start);
    const k = key(q);
    if (!byFinal.has(k)) byFinal.set(k, { s, q });
  }
  const cands = [...byFinal.values()];
  if (L.random && rng() < L.random) {
    // Новичок: что-нибудь, но шашку снять — не упустит.
    const top = Math.max(...cands.map((x) => x.q.off[c]));
    const pool = cands.filter((x) => x.q.off[c] === top);
    return pool[Math.floor(rng() * pool.length)].s;
  }
  for (const x of cands) x.score = evaluate(x.q, c);
  cands.sort((a, b) => b.score - a.score);
  return cands[0].s;
}
