'use strict';
/**
 * Шахматный движок для игры против бота. Свой, маленький, без зависимостей:
 * перебор с отсечением (alpha-beta), продление по взятиям, оценка — материал
 * и «где фигуре хорошо стоять» (таблицы полей). Ходы берёт из board.js —
 * тех же правил, что проверены perft, поэтому бот физически не может сходить
 * незаконно: он выбирает только из `legalMoves`.
 *
 * Сила задаётся уровнем: глубиной перебора, временем на ход и тем, насколько
 * бот готов выбрать не лучший ход. Слабый бот не «тупит нарочно» случайными
 * зевками — он выбирает среди хороших ходов с разбросом, как живой новичок,
 * который видит на ход вперёд.
 *
 * Перебор занимает до полутора секунд. В боевом боте он идёт в отдельном
 * потоке (engine-worker.js), чтобы не останавливать остальные столы.
 */
import { fromFen, legalMoves, make, inCheck } from './board.js';

export const MATE = 100_000;

/** Уровни: имя для человека, глубина, время, разброс выбора (в сантипешках). */
export const LEVELS = [
  { name: 'Новичок', depth: 1, quiet: false, timeMs: 150, temperature: 140, random: 0.2 },
  { name: 'Любитель', depth: 2, quiet: true, timeMs: 300, temperature: 60, random: 0.05 },
  { name: 'Клубный', depth: 3, quiet: true, timeMs: 600, temperature: 18, random: 0 },
  { name: 'Сильный', depth: 4, quiet: true, timeMs: 1000, temperature: 0, random: 0 },
  { name: 'Мастер', depth: 6, quiet: true, timeMs: 1600, temperature: 0, random: 0 },
];

const VALUE = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

/*
 * Таблицы полей — «упрощённая функция оценки» Томаша Михневского, общеизвестная
 * и выверенная за годы. Записаны как принято: первая строка — восьмая
 * горизонталь, со стороны белых.
 */
const PST = {
  P: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  N: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  B: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  R: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  Q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  K: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
  /** Король в эндшпиле: в центр, а не в угол. */
  KE: [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
  ],
};

/** Индекс в таблице: для белых — зеркально по вертикали (таблица записана с восьмой горизонтали). */
const pstAt = (kind, s, white) => PST[kind][white ? (7 - (s >> 3)) * 8 + (s & 7) : (s >> 3) * 8 + (s & 7)];

/** Оценка с точки зрения того, чей ход: плюс — хорошо ходящему. */
export function evaluate(pos) {
  const b = pos.b;
  let score = 0;
  let heavy = 0; // ферзи и лёгкие фигуры: мало — значит эндшпиль
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p) continue;
    const k = p.toUpperCase();
    if (k === 'Q') heavy += 2;
    else if (k === 'N' || k === 'B' || k === 'R') heavy += 1;
  }
  const endgame = heavy <= 4;
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p) continue;
    const white = p !== p.toLowerCase();
    const k = p.toUpperCase();
    const v = VALUE[k] + pstAt(k === 'K' && endgame ? 'KE' : k, s, white);
    score += white ? v : -v;
  }
  return pos.t === 'w' ? score : -score;
}

/** Порядок ходов: сначала взятия «дешёвым дорогого», превращения, потом остальное. */
function ordered(moves) {
  return moves
    .map((m) => ({ m, k: (m.cap ? 10 * VALUE[m.cap.toUpperCase()] - VALUE[m.piece.toUpperCase()] + 1000 : 0) + (m.promo ? 800 : 0) }))
    .sort((a, b) => b.k - a.k)
    .map((x) => x.m);
}

class Timeout extends Error {}

function makeSearch(deadline, now) {
  let nodes = 0;
  const tick = () => {
    if ((++nodes & 1023) === 0 && now() > deadline) throw new Timeout();
  };

  /** Только взятия — чтобы не оценивать позицию посреди размена. */
  function quiesce(pos, alpha, beta, depth) {
    tick();
    const stand = evaluate(pos);
    if (stand >= beta) return beta;
    if (alpha < stand) alpha = stand;
    if (depth <= 0) return alpha;
    const caps = ordered(legalMoves(pos).filter((m) => m.cap || m.promo));
    for (const m of caps) {
      const score = -quiesce(make(pos, m), -beta, -alpha, depth - 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function negamax(pos, depth, alpha, beta, ply, quiet) {
    tick();
    const moves = legalMoves(pos);
    if (!moves.length) return inCheck(pos) ? -MATE + ply : 0;
    if (pos.hm >= 100) return 0;
    if (depth <= 0) return quiet ? quiesce(pos, alpha, beta, 4) : evaluate(pos);
    let best = -Infinity;
    for (const m of ordered(moves)) {
      const score = -negamax(make(pos, m), depth - 1, -beta, -alpha, ply + 1, quiet);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  return { negamax, nodes: () => nodes };
}

/** Детерминированный генератор случайных чисел — чтобы игру бота можно было повторить в тесте. */
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
 * @returns {{ from: number, to: number, promo: string, score: number, depth: number } | null}
 */
export function bestMove(fen, level = 2, { seed = 1, now = () => Date.now(), timeMs = null } = {}) {
  const L = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, level))];
  const pos = fromFen(fen);
  const moves = legalMoves(pos);
  if (!moves.length) return null;
  const rng = rngFrom(seed);
  if (moves.length === 1) return { ...pick(moves[0]), score: 0, depth: 0 };
  // Новичок иногда просто двигает что-нибудь, как живой.
  if (L.random && rng() < L.random) return { ...pick(moves[Math.floor(rng() * moves.length)]), score: 0, depth: 0 };

  const deadline = now() + (timeMs ?? L.timeMs);
  const { negamax } = makeSearch(deadline, now);
  let scored = null;
  let reached = 0;
  // Углубляемся, пока есть время: каждый законченный слой — честный ответ.
  for (let d = 1; d <= L.depth; d++) {
    try {
      const layer = [];
      let alpha = -Infinity;
      const list = scored ? scored.map((x) => x.m) : ordered(moves);
      for (const m of list) {
        // Для выбора с разбросом нужны оценки всех ходов, поэтому окно полное.
        const full = L.temperature > 0;
        const score = -negamax(make(pos, m), d - 1, -Infinity, full ? Infinity : -alpha, 1, L.quiet);
        layer.push({ m, score });
        if (score > alpha) alpha = score;
      }
      layer.sort((a, b) => b.score - a.score);
      scored = layer;
      reached = d;
      if (layer[0].score >= MATE - 100) break; // мат найден — глубже не нужно
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
      break;
    }
  }
  if (!scored) scored = ordered(moves).map((m) => ({ m, score: 0 }));
  const chosen = L.temperature > 0 ? soften(scored, L.temperature, rng) : scored[0];
  return { ...pick(chosen.m), score: chosen.score, depth: reached };
}

/** Выбор с разбросом: ход тем вероятнее, чем он лучше; «температура» — насколько разброс широк. */
function soften(scored, temperature, rng) {
  const top = scored[0].score;
  // Мат и защиту от мата не размываем: это не вкус, а факт.
  if (Math.abs(top) >= MATE - 100) return scored[0];
  const weights = scored.map((x) => Math.exp((x.score - top) / temperature));
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = rng() * sum;
  for (let i = 0; i < scored.length; i++) {
    r -= weights[i];
    if (r <= 0) return scored[i];
  }
  return scored[0];
}

const pick = (m) => ({ from: m.from, to: m.to, promo: m.promo || '' });
