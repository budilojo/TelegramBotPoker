'use strict';
/**
 * Движок русских шашек для игры против бота. Свой, маленький, без
 * зависимостей: перебор с отсечением (alpha-beta), продление по взятиям,
 * оценка — материал (дамка ≈ 3 простых), продвижение, центр, заднее поле.
 *
 * Ходы — только из `legalMoves` (board.js, сверено perft и pydraughts):
 * бот физически не может сходить незаконно, в том числе пропустить
 * обязательное взятие или бросить серию на середине — таких ходов в списке
 * просто нет. Слабость новичка — в выборе между законными ходами.
 *
 * Сила задаётся уровнем: глубиной, временем на ход и разбросом выбора. В
 * боевом боте перебор идёт в отдельном потоке (engine-worker.js).
 */
import { fromFen, legalMoves, make, isKing, colorOf } from './board.js';

export const WIN = 100_000;

/** Уровни: имя, глубина (полуходы), время, разброс выбора (в сотых простой), доля случайных ходов. */
export const LEVELS = [
  { name: 'Новичок', depth: 1, timeMs: 120, temperature: 90, random: 0.25 },
  { name: 'Любитель', depth: 3, timeMs: 250, temperature: 35, random: 0.05 },
  { name: 'Клубный', depth: 5, timeMs: 500, temperature: 10, random: 0 },
  { name: 'Сильный', depth: 7, timeMs: 900, temperature: 0, random: 0 },
  { name: 'Мастер', depth: 12, timeMs: 1500, temperature: 0, random: 0 },
];

const MAN = 100;
const KING = 300;
/** Центр доски — c3…f6: шашка там держит больше полей. */
const CENTER = new Set([18, 20, 27, 29, 34, 36, 43, 45]);

/** Оценка с точки зрения того, чей ход: плюс — хорошо ходящему. */
export function evaluate(pos) {
  const b = pos.b;
  let score = 0;
  let men = 0;
  for (let s = 0; s < 64; s++) if (b[s] && !isKing(b[s])) men += 1;
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p) continue;
    const white = colorOf(p) === 'w';
    const row = white ? s >> 3 : 7 - (s >> 3); // сколько рядов прошла от своего края
    let v;
    if (isKing(p)) v = KING;
    else {
      v = MAN + row * 4; // ближе к дамкам — дороже
      if (row === 0 && men > 10) v += 8; // заднее поле держит, пока на доске много простых
    }
    if (CENTER.has(s)) v += 6;
    score += white ? v : -v;
  }
  return pos.t === 'w' ? score : -score;
}

/** Сначала серии подлиннее и превращения: отсечение срабатывает раньше. */
function ordered(moves) {
  return moves
    .map((m) => ({ m, k: m.caps.length * 100 + (m.promo ? 50 : 0) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.m);
}

class Timeout extends Error {}

function makeSearch(deadline, now) {
  let nodes = 0;
  const tick = () => {
    if ((++nodes & 1023) === 0 && now() > deadline) throw new Timeout();
  };

  function negamax(pos, depth, alpha, beta, ply, ext) {
    tick();
    const moves = legalMoves(pos);
    if (!moves.length) return -WIN + ply; // нет ходов или шашек — проигрыш
    // Продление по взятиям: посреди размена позицию не оцениваем.
    const forced = moves[0].caps.length > 0;
    if (depth <= 0 && !(forced && ext > 0)) return evaluate(pos);
    const next = depth <= 0 ? 0 : depth - 1;
    const nextExt = depth <= 0 ? ext - 1 : ext;
    let best = -Infinity;
    for (const m of ordered(moves)) {
      const score = -negamax(make(pos, m), next, -beta, -alpha, ply + 1, nextExt);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  return { negamax };
}

/** Детерминированный генератор — чтобы игру бота можно было повторить в тесте. */
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

/**
 * Лучший ход позиции для уровня `level` (0…4).
 *
 * @returns {{ from: number, to: number, path: number[], caps: number[], score: number, depth: number } | null}
 */
export function bestMove(fen, level = 2, { seed = 1, now = () => Date.now(), timeMs = null } = {}) {
  const L = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, level))];
  const pos = fromFen(fen);
  const moves = legalMoves(pos);
  if (!moves.length) return null;
  const rng = rngFrom(seed);
  if (moves.length === 1) return { ...pick(moves[0]), score: 0, depth: 0 };
  if (L.random && rng() < L.random) return { ...pick(moves[Math.floor(rng() * moves.length)]), score: 0, depth: 0 };

  const deadline = now() + (timeMs ?? L.timeMs);
  const { negamax } = makeSearch(deadline, now);
  let scored = null;
  let reached = 0;
  for (let d = 1; d <= L.depth; d++) {
    try {
      const layer = [];
      let alpha = -Infinity;
      const list = scored ? scored.map((x) => x.m) : ordered(moves);
      for (const m of list) {
        const full = L.temperature > 0; // для выбора с разбросом нужны оценки всех ходов
        const score = -negamax(make(pos, m), d - 1, -Infinity, full ? Infinity : -alpha, 1, 8);
        layer.push({ m, score });
        if (score > alpha) alpha = score;
      }
      layer.sort((a, b) => b.score - a.score);
      scored = layer;
      reached = d;
      if (Math.abs(layer[0].score) >= WIN - 200) break; // исход виден — глубже не нужно
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
      break;
    }
  }
  if (!scored) scored = ordered(moves).map((m) => ({ m, score: 0 }));
  const chosen = L.temperature > 0 ? soften(scored, L.temperature, rng) : scored[0];
  return { ...pick(chosen.m), score: chosen.score, depth: reached };
}

/** Выбор с разбросом: ход тем вероятнее, чем он лучше. */
function soften(scored, temperature, rng) {
  const top = scored[0].score;
  if (Math.abs(top) >= WIN - 200) return scored[0]; // выигрыш и защиту от проигрыша не размываем
  const weights = scored.map((x) => Math.exp((x.score - top) / temperature));
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = rng() * sum;
  for (let i = 0; i < scored.length; i++) {
    r -= weights[i];
    if (r <= 0) return scored[i];
  }
  return scored[0];
}

const pick = (m) => ({ from: m.from, to: m.to, path: m.path.slice(), caps: m.caps.slice() });
