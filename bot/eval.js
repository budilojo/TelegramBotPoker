'use strict';
/**
 * Оценка покерных комбинаций. Чистые функции, никакого ввода-вывода.
 *
 * Сила руки — массив чисел, сравниваемый лексикографически:
 * `[категория, тайбрейк, тайбрейк, ...]`. Массив, а не упакованное в одно
 * число значение: кикеры читаются глазами при отладке, и нет риска
 * переполнения или потери разряда при упаковке.
 *
 * Лучшая пятёрка из семи ищется перебором всех 21 комбинации. Это не самый
 * быстрый способ в мире, но при девяти игроках это 189 оценок на вскрытие —
 * микросекунды. Зато он очевидно правильный, а хитрые табличные оценщики
 * ошибаются молча.
 */
import { rankOf, suitOf, RANKS, cardName } from './deck.js';

export const CATEGORY = {
  HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4,
  FLUSH: 5, FULL_HOUSE: 6, QUADS: 7, STRAIGHT_FLUSH: 8,
};

/**
 * Старшая карта стрита, или -1. Колесо (A-2-3-4-5) — стрит от пятёрки:
 * туз в нём младший, и это единственное место, где он не старший.
 */
function straightHigh(uniqDesc) {
  for (let i = 0; i + 4 < uniqDesc.length; i++) {
    if (uniqDesc[i] - uniqDesc[i + 4] === 4) return uniqDesc[i];
  }
  const has = (r) => uniqDesc.includes(r);
  if (has(12) && has(3) && has(2) && has(1) && has(0)) return 3; // колесо: старшая — 5
  return -1;
}

/** Сила ровно пяти карт. */
export function score5(cards) {
  if (cards.length !== 5) throw new Error('score5 ждёт ровно 5 карт');
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const flush = suits.every((s) => s === suits[0]);

  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  // Сначала по количеству, потом по рангу: так группы сразу лежат в том
  // порядке, в котором их сравнивают правила.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const uniqDesc = [...counts.keys()].sort((a, b) => b - a);
  const kickers = groups.slice(1).map((g) => g[0]);
  const sHigh = uniqDesc.length === 5 ? straightHigh(uniqDesc) : -1;

  if (flush && sHigh >= 0) return [CATEGORY.STRAIGHT_FLUSH, sHigh];
  if (groups[0][1] === 4) return [CATEGORY.QUADS, groups[0][0], kickers[0]];
  if (groups[0][1] === 3 && groups[1][1] === 2)
    return [CATEGORY.FULL_HOUSE, groups[0][0], groups[1][0]];
  if (flush) return [CATEGORY.FLUSH, ...ranks];
  if (sHigh >= 0) return [CATEGORY.STRAIGHT, sHigh];
  if (groups[0][1] === 3) return [CATEGORY.TRIPS, groups[0][0], ...kickers];
  if (groups[0][1] === 2 && groups[1][1] === 2)
    return [CATEGORY.TWO_PAIR, groups[0][0], groups[1][0], kickers[1]];
  if (groups[0][1] === 2) return [CATEGORY.PAIR, groups[0][0], ...kickers];
  return [CATEGORY.HIGH, ...ranks];
}

/** Лексикографическое сравнение сил. >0 — первая сильнее. */
export function compare(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Все сочетания по k из массива. */
function combinations(arr, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) return void out.push([...acc]);
    for (let i = start; i < arr.length; i++) {
      acc.push(arr[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/** Лучшая пятёрка из семи (или из любого количества >= 5). */
export function best5(cards) {
  if (cards.length < 5) throw new Error('нужно минимум 5 карт');
  let best = null;
  for (const combo of combinations(cards, 5)) {
    const s = score5(combo);
    if (!best || compare(s, best.score) > 0) best = { score: s, cards: combo };
  }
  return { ...best, name: describe(best.score) };
}

const CATEGORY_RU = [
  'Старшая карта', 'Пара', 'Две пары', 'Тройка', 'Стрит',
  'Флеш', 'Фулл-хаус', 'Каре', 'Стрит-флеш',
];

/** Короткое имя для чата: «Фулл-хаус K/10», «Пара A». */
export function describe(score) {
  const [cat, ...rest] = score;
  const R = (i) => RANKS[i];
  switch (cat) {
    case CATEGORY.STRAIGHT_FLUSH:
      return rest[0] === 12 ? 'Флеш-рояль' : `Стрит-флеш до ${R(rest[0])}`;
    case CATEGORY.QUADS: return `Каре ${R(rest[0])}`;
    case CATEGORY.FULL_HOUSE: return `Фулл-хаус ${R(rest[0])}/${R(rest[1])}`;
    case CATEGORY.FLUSH: return `Флеш до ${R(rest[0])}`;
    case CATEGORY.STRAIGHT: return `Стрит до ${R(rest[0])}`;
    // Three of a kind. «Сет» is only the pocket-pair kind; the ranking calls them all a тройка.
    case CATEGORY.TRIPS: return `Тройка ${R(rest[0])}`;
    case CATEGORY.TWO_PAIR: return `Две пары ${R(rest[0])}/${R(rest[1])}`;
    case CATEGORY.PAIR: return `Пара ${R(rest[0])}`;
    default: return `Старшая ${R(rest[0])}`;
  }
}

/**
 * Кто выиграл среди претендентов на банк.
 *
 * @param entries [{ id, cards }] — по семь карт на каждого (две свои + борд)
 * @returns [{ ids:[...], score, name, cards }] — по убыванию силы;
 *          несколько id в одной группе означают ровный дележ.
 */
export function rank(entries) {
  const scored = entries.map((e) => ({ id: e.id, ...best5(e.cards) }));
  scored.sort((a, b) => compare(b.score, a.score));

  const groups = [];
  for (const s of scored) {
    const last = groups[groups.length - 1];
    if (last && compare(last.score, s.score) === 0) last.ids.push(s.id);
    else groups.push({ ids: [s.id], score: s.score, name: s.name, cards: s.cards });
  }
  return groups;
}

export const showHand = (cards) => cards.map(cardName).join(' ');
