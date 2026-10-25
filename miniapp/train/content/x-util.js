/**
 * Общие помощники для упражнений агента X (outs, potodds, postflop, hands,
 * advanced): генераторы раздач с seed и сборщики заданий. Чистый модуль, без DOM.
 *
 * ЧЕСТНОСТЬ (контракт 9): правильные ответы здесь СЧИТАЮТСЯ кодом (`poker-math.js`):
 * ауты, вероятности, pot odds, EV, MDF, комбо. Где задание опирается на «правило
 * порядка» (размер ставки по текстуре, SPR и линия), в разборе стоит пометка
 * «ориентир, не точный расчёт» (см. `GUIDE_NOTE`).
 */
import * as M from '../poker-math.js';

export const { fmtNum, fmtPct, fmtDec } = M;
export const GUIDE_NOTE = 'Это ориентир, не точный расчёт и не решение солвера.';

/** n разных карт не из `dead`, по rng. */
export function rndCards(rng, n, dead = []) {
  return rng.shuffle(M.remaining(dead)).slice(0, n);
}
const byRank = (a, b) => (b >> 2) - (a >> 2) || a - b;
export const sortCards = (cs) => [...cs].sort(byRank);

const types = (hero, board) => M.drawsOf(hero, board).map((d) => d.type).sort().join(',');

/**
 * Рука и борд (3 или 4 карты) с ОДНИМ чистым дро заданного типа
 * ('flush' | 'oesd' | 'gutshot'), без пары и готовой комбинации.
 */
export function genDraw(rng, type, boardLen = 3) {
  for (let tries = 0; tries < 400; tries++) {
    let hero, board;
    const suit = () => rng.int(0, 3);
    if (type === 'flush') {
      const s = suit();
      const ranks = rng.shuffle([...Array(13).keys()]);
      hero = [M.mk(ranks[0], s), M.mk(ranks[1], s)];
      board = [M.mk(ranks[2], s), M.mk(ranks[3], s), M.mk(ranks[4], (s + rng.int(1, 3)) % 4)];
    } else {
      const four = type === 'oesd'
        ? (() => { const r = rng.int(1, 8); return [r, r + 1, r + 2, r + 3]; })()
        : (() => { const r = rng.int(0, 8); return [r, r + 1, r + 3, r + 4]; })();
      const mix = rng.shuffle(four);
      const used = new Set(four);
      let extra;
      do { extra = rng.int(0, 12); } while (used.has(extra));
      const rs = [mix[0], mix[1], mix[2], mix[3], extra];
      const heroRanks = rs.slice(0, 2);
      const boardRanks = rs.slice(2);
      hero = heroRanks.map((r) => M.mk(r, suit()));
      board = boardRanks.map((r) => M.mk(r, suit()));
    }
    if (new Set([...hero, ...board]).size !== 5) continue;
    if (M.evaluate([...hero, ...board])[0] !== M.CAT.HIGH) continue;
    if (types(hero, board) !== type) continue;
    if (boardLen === 4) {
      const turn = rng.shuffle(M.remaining(hero, board))
        .find((c) => M.evaluate([...hero, ...board, c])[0] === M.CAT.HIGH && types(hero, [...board, c]) === type);
      if (turn == null) continue;
      board = [...board, turn];
    }
    return { hero: sortCards(hero), board };
  }
  throw new Error(`genDraw: не получилось собрать ${type}`);
}

export const DRAW_RU = {
  flush: 'флеш-дро',
  oesd: 'открытое стрит-дро',
  gutshot: 'стрит-дро с пропуском в середине (гатшот)',
};
export const STREET_RU = ['', '', '', 'Флоп', 'Тёрн', 'Ривер'];
export const unseenCount = (boardLen) => 52 - 2 - boardLen;

/** Позиции для сцены. */
export const POS_NAMES = { BTN: 'Кнопка', SB: 'Малый блайнд', BB: 'Большой блайнд', CO: 'Катофф', UTG: 'UTG' };

/** Два места «вы и соперник» для сцены. */
export function seatsHU({ heroPos = 'BTN', villainPos = 'BB', heroStack, villainStack, heroBet = 0, villainBet = 0 }) {
  return [
    { pos: heroPos, name: 'Вы', stack: heroStack, bet: heroBet || undefined, hero: true, dealer: heroPos === 'BTN' },
    { pos: villainPos, name: 'Соперник', stack: villainStack, bet: villainBet || undefined, dealer: villainPos === 'BTN' },
  ];
}

// ───────────────────────── сборщики заданий ─────────────────────────

/** Оценка числового ответа: в допуске — 1, в двойном допуске — 0,5, иначе 0. */
function numScore(a, answer, tol) {
  const n = Number(a);
  if (a == null || a === '' || !Number.isFinite(n)) return { n: null, score: 0 };
  const err = Math.abs(n - answer);
  return { n, score: err <= tol + 1e-9 ? 1 : err <= 2 * tol + 1e-9 ? 0.5 : 0 };
}

/**
 * Числовое задание (kind 'slider' или 'bet').
 *   range:{min,max,step,unit,label}; answer; tol — допуск; fmtAns — как печатать число в тексте;
 *   topic/code — для ошибок; why — текст разбора (числа уже посчитаны кодом);
 *   steps — расчёт по шагам (строки) в конце `why`; alternatives — [{label,verdict,text}].
 */
export function numberTask({ prompt, scene = {}, range, answer, tol, fmtAns = (x) => fmtNum(x), topic, code, why, steps = [], alternatives = [] }) {
  const ans = Math.round(answer * 100) / 100;
  return {
    prompt,
    setup: { ...scene, ...range },
    solution: ans,
    isComplete: (a) => typeof a === 'number' && Number.isFinite(a),
    check(a) {
      const { n, score } = numScore(a, ans, tol);
      const ok = score === 1;
      return {
        ok,
        score,
        mistakes: ok ? [] : [{
          code,
          topic,
          text: n == null ? 'Ответ не введён.' : `Вы ответили ${fmtAns(n)}${range.unit ? ' ' + range.unit : ''}, верно ${fmtAns(ans)}${range.unit ? ' ' + range.unit : ''} (допуск ±${fmtAns(tol)}).`,
        }],
        why: [why, ...steps].filter(Boolean).join(' '),
        alternatives,
        solution: ans,
      };
    },
  };
}

/**
 * Задание «выбери действие» (kind 'table'), допускает несколько приемлемых ответов.
 *   options:[{id,label,why}]; good:[id…] (первый — основной); verdicts подписывает сам.
 */
export function choiceTask({ prompt, scene = {}, options, good, why, topic, code, rng, shuffle = true }) {
  if (!good.every((g) => options.some((o) => o.id === g))) throw new Error('choiceTask: верного id нет в options');
  const shown = shuffle ? rng.shuffle(options) : options;
  const okSet = new Set(good);
  return {
    prompt,
    setup: { ...scene, options: shown.map(({ id, label }) => ({ id, label })) },
    solution: good[0],
    isComplete: (a) => typeof a === 'string',
    check(a) {
      const ok = okSet.has(a);
      const chosen = options.find((o) => o.id === a);
      return {
        ok,
        score: ok ? 1 : 0,
        mistakes: ok ? [] : [{ code, topic, text: `Выбрано «${chosen?.label ?? '—'}» — здесь это не лучший ход.` }],
        why,
        alternatives: options.map((o) => ({ label: o.label, verdict: okSet.has(o.id) ? (good.length > 1 ? 'допустимо' : 'верно') : 'хуже', text: o.why || '' })),
        solution: good,
      };
    },
  };
}

/** Задание «коснитесь карт» (kind 'cards'). Верно только полное совпадение; score — доля. */
export function cardsTask({ prompt, scene = {}, pool, solutionCards, hint, why, topic, code, alternatives = [] }) {
  const want = [...solutionCards].sort((a, b) => a - b);
  const wantSet = new Set(want);
  const names = (cs) => cs.map(M.cardName).join(' ');
  return {
    prompt,
    setup: { ...scene, pool: sortCards(pool), hint },
    solution: want,
    isComplete: (a) => Array.isArray(a) && a.length > 0,
    check(a) {
      const got = new Set(Array.isArray(a) ? a.filter((c) => Number.isInteger(c)) : []);
      const hit = want.filter((c) => got.has(c));
      const missed = want.filter((c) => !got.has(c));
      const extra = [...got].filter((c) => !wantSet.has(c));
      const ok = !missed.length && !extra.length;
      const score = Math.max(0, (hit.length - extra.length) / want.length);
      const mistakes = [];
      if (missed.length) mistakes.push({ code: `${code}-missed`, topic, text: `Пропущены: ${names(missed)}.` });
      if (extra.length) mistakes.push({ code: `${code}-extra`, topic, text: `Лишние: ${names(extra)}.` });
      return { ok, score: ok ? 1 : Math.min(score, 0.69), mistakes, why, alternatives, solution: want };
    },
  };
}

/** Простая упаковка уровней: `byLevel(level, [файл-упражнения…])` проставляет `level`. */
export const ex = (id, topic, level, kind, make) => ({ id, topic, level, kind, make });

/** Выбор элемента с весом (для генераторов). */
export const roundTo = (x, step) => Math.round(x / step) * step;

// ───────────────────────── текстура борда ─────────────────────────

/**
 * Текстура флопа по ПРОСТОМУ правилу (оно показывается в заданиях):
 *   баллы масти: три одной масти = 2, две = 1, радуга = 0;
 *   баллы связности: все три карты в пределах пяти номиналов (разброс ≤ 4) = 2,
 *   в пределах семи (≤ 6) = 1, иначе 0;
 *   сумма ≤ 1 — «сухая», 2 — «средняя», ≥ 3 — «мокрая».
 * Это учебное определение, а не солверная классификация.
 */
export function boardTexture(board) {
  const suits = [0, 0, 0, 0];
  board.forEach((c) => suits[M.suitOf(c)]++);
  const ms = Math.max(...suits);
  const rs = board.map(M.rankOf).sort((a, b) => a - b);
  const span = rs[rs.length - 1] - rs[0];
  const pts = (ms >= 3 ? 2 : ms === 2 ? 1 : 0) + (span <= 4 ? 2 : span <= 6 ? 1 : 0);
  return { kind: pts <= 1 ? 'dry' : pts === 2 ? 'medium' : 'wet', pts, flushPts: ms >= 3 ? 2 : ms === 2 ? 1 : 0, span, paired: new Set(rs).size < rs.length };
}
export const TEXTURE_RU = { dry: 'сухая', medium: 'средняя', wet: 'мокрая' };
export const TEXTURE_RULE = 'Баллы: масти (три одной = 2, две = 1, радуга = 0) + связность (три карты в пределах пяти номиналов = 2, семи = 1, иначе 0). 0–1 балл — сухая, 2 — средняя, 3–4 — мокрая.';

/** Флоп заданной текстуры без пар. */
export function genFlop(rng, kind, dead = []) {
  for (let t = 0; t < 400; t++) {
    const b = rndCards(rng, 3, dead);
    const tx = boardTexture(b);
    if (tx.kind === kind && !tx.paired) return b;
  }
  throw new Error(`genFlop ${kind}`);
}

/** Класс готовой руки героя: strong (две пары и выше), top (топ-пара), weak (младшая пара), draw, air. */
export function handClass(hero, board) {
  const all = [...hero, ...board];
  const cat = M.evaluate(all)[0];
  if (cat >= M.CAT.TWO_PAIR) return 'strong';
  const bmax = Math.max(...board.map(M.rankOf));
  if (cat === M.CAT.PAIR) {
    const pairRank = M.evaluate(all)[1];
    const usesHole = hero.some((c) => M.rankOf(c) === pairRank);
    if (usesHole) return pairRank >= bmax ? 'top' : 'weak';
    return 'air';
  }
  if (M.drawsOf(hero, board).some((d) => d.type === 'flush' || d.type === 'oesd')) return 'draw';
  return 'air';
}
export const CLASS_RU = { strong: 'сильная рука', top: 'топ-пара', weak: 'слабая пара', draw: 'сильное дро', air: 'ничего' };

/** Все 169 меток стартовых рук — «случайная рука соперника». */
export const ALL_LABELS = (() => {
  const L = [];
  for (let i = 12; i >= 0; i--) for (let j = i; j >= 0; j--) {
    if (i === j) L.push(M.RANKS[i] + M.RANKS[j]);
    else { L.push(M.RANKS[i] + M.RANKS[j] + 's'); L.push(M.RANKS[i] + M.RANKS[j] + 'o'); }
  }
  return L;
})();

/** Эквити против случайной руки (Монте-Карло с seed: воспроизводимо, ±1 п. п.). */
export function equityVsRandom(hero, board, seed = 11) {
  return M.equity(hero, board, new Set(ALL_LABELS), { samples: 3000, seed }).equity;
}
