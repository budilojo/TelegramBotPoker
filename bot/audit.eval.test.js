'use strict';
/**
 * Аудит, фаза 3 (D, покер): дифференциальная проверка оценки рук.
 *
 * `eval.js` перебирает все 21 пятёрку из семи карт. Эталон здесь устроен
 * иначе — оценивает семь карт сразу (флеш по масти, стрит по рангам, группы
 * по счёту), и написан с нуля. Для случайных раздач холдема (две карты
 * каждому + общий борд) оба обязаны назвать одного и того же победителя,
 * одинаково поделить банк при равенстве и одинаково назвать категорию.
 *
 *   AUDIT_EVAL=1000000 node --test bot/audit.eval.test.js   — подольше
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { best5, compare, rank } from './eval.js';
import { seededRng, shuffled, rankOf, suitOf, parseHand } from './deck.js';

const N = Number(process.env.AUDIT_EVAL || 8_000);

/** Сила семи карт: [категория, ...решающие ранги]. Категории — как в eval.js (0..8). */
export function slowScore(cards) {
  const byRank = new Map();
  const bySuit = new Map();
  for (const c of cards) {
    byRank.set(rankOf(c), (byRank.get(rankOf(c)) || 0) + 1);
    if (!bySuit.has(suitOf(c))) bySuit.set(suitOf(c), []);
    bySuit.get(suitOf(c)).push(rankOf(c));
  }
  const straightTop = (ranks) => {
    const has = new Set(ranks);
    for (let top = 12; top >= 4; top--) {
      let ok = true;
      for (let k = 0; k < 5; k++) if (!has.has(top - k)) ok = false;
      if (ok) return top;
    }
    if ([12, 0, 1, 2, 3].every((r) => has.has(r))) return 3; // A-2-3-4-5
    return -1;
  };
  const flushSuit = [...bySuit.values()].find((r) => r.length >= 5);
  if (flushSuit) {
    const sf = straightTop(flushSuit);
    if (sf >= 0) return [8, sf];
  }
  const desc = (a) => [...a].sort((x, y) => y - x);
  const ranksWith = (n) => desc([...byRank].filter(([, k]) => k === n).map(([r]) => r));
  const quads = ranksWith(4);
  const trips = ranksWith(3);
  const pairs = ranksWith(2);
  const all = desc([...byRank.keys()]);
  const kick = (exclude, n) => all.filter((r) => !exclude.includes(r)).slice(0, n);
  if (quads.length) return [7, quads[0], ...kick([quads[0]], 1)];
  if (trips.length && (trips.length > 1 || pairs.length)) {
    const second = desc([...trips.slice(1), ...pairs])[0];
    return [6, trips[0], second];
  }
  if (flushSuit) return [5, ...desc(flushSuit).slice(0, 5)];
  const st = straightTop(all);
  if (st >= 0) return [4, st];
  if (trips.length) return [3, trips[0], ...kick([trips[0]], 2)];
  if (pairs.length >= 2) return [2, pairs[0], pairs[1], ...kick([pairs[0], pairs[1]], 1)];
  if (pairs.length) return [1, pairs[0], ...kick([pairs[0]], 3)];
  return [0, ...all.slice(0, 5)];
}

const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

test(`АУДИТ D: оценка рук совпадает с независимым эталоном на ${N} раздачах`, () => {
  const rnd = seededRng(20261019);
  for (let i = 0; i < N; i++) {
    const deck = shuffled(rnd);
    const board = deck.slice(0, 5);
    const n = 2 + rnd(5);
    const hands = Array.from({ length: n }, (_, k) => ({ id: String(k), cards: [deck[5 + 2 * k], deck[6 + 2 * k], ...board] }));
    // Каждую руку: та же категория и те же решающие ранги.
    for (const h of hands) {
      const fast = best5(h.cards).score;
      const slow = slowScore(h.cards);
      assert.deepEqual(fast, slow, `раздача ${i}: ${h.cards} — eval ${fast}, эталон ${slow}`);
    }
    // Победители и дележ банка.
    const groups = rank(hands);
    const top = hands.filter((h) => compare(slowScore(h.cards), slowScore(groups[0].ids.map((id) => hands[+id])[0].cards)) === 0).map((h) => h.id);
    assert.deepEqual([...groups[0].ids].sort(), top.sort(), `раздача ${i}: победители`);
    for (let k = 1; k < hands.length; k++) {
      assert.equal(sgn(compare(best5(hands[0].cards).score, best5(hands[k].cards).score)), sgn(compare(slowScore(hands[0].cards), slowScore(hands[k].cards))));
    }
  }
});

test('АУДИТ D: каверзные доски — колесо, два сета, три пары, флеш и стрит сразу, борд играет', () => {
  const cases = [
    ['Ah 2c', '3d 4s 5h Kc Qd', [4, 3]], // колесо: стрит до пятёрки
    ['Ah Kh', '2h 3h 4h 5h 9c', [8, 3]], // стрит-флеш колесом, а не флеш до туза
    ['9c 9d', '9h Kc Kd Ks 2s', [6, 11, 7]], // два сета: фулл K/9
    ['Ac Ad', 'Kc Kd Qc Qd 2s', [2, 12, 11, 10]], // три пары: старшие две + кикер
    ['2c 3d', 'Ah Kh Qh Jh 10h', [8, 12]], // флеш-рояль на борде — играет у всех
    ['6h 7h', '8h 9h 10c 2h 3s', [5, 7, 6, 5, 4, 0]], // флеш и стрит сразу — флеш
    ['Kc Kd', 'Ks Kh 2c 2d 2h', [7, 11, 0]], // каре + тройка на борде
  ];
  for (const [hole, board, want] of cases) {
    const cards = [...parseHand(hole), ...parseHand(board)];
    const slow = slowScore(cards);
    const fast = best5(cards).score;
    assert.deepEqual(slow, want, `${hole} | ${board}: эталон ошибся`);
    assert.deepEqual(fast, want, `${hole} | ${board}: eval.js ошибся`);
  }
});
