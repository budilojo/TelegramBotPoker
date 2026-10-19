'use strict';
/**
 * Аудит, фаза 3 (D): честность случайности — кубики нард и тасовки колод.
 *
 * Хи-квадрат на настоящем генераторе (crypto.randomInt), без подмен. Порог —
 * уровень значимости 10⁻⁶: тест не краснеет случайно, а грубый перекос
 * (кубик, который чаще даёт шесть хоть на процент) ловит уверенно.
 *
 *   AUDIT_ROLLS=3000000 node --test bot/audit.dice.test.js   — подольше
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { realDice } from './games/nardy/rules.js';
import { shuffled } from './deck.js';
import { shuffled36 } from './games/durak/cards.js';
import { shuffled as colorsShuffled, freshDeck as colorsFresh } from './games/colors/cards.js';

const ROLLS = Number(process.env.AUDIT_ROLLS || 360_000);
const SHUFFLES = Math.round(ROLLS / 6);

/** Критические значения хи-квадрат при p = 10⁻⁶ (Уилсон–Хилферти, точности хватает). */
function critical(df) {
  const z = 4.7534; // квантиль 1 − 10⁻⁶ нормального
  return df * (1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df))) ** 3;
}
function chi2(counts, expected) {
  return counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
}

test(`АУДИТ D: кубики нард — ${ROLLS} бросков, все 36 пар равновероятны, кубики независимы`, () => {
  const pairs = new Array(36).fill(0);
  const one = new Array(6).fill(0);
  for (let i = 0; i < ROLLS; i++) {
    const [a, b] = realDice();
    assert.ok(Number.isInteger(a) && a >= 1 && a <= 6 && Number.isInteger(b) && b >= 1 && b <= 6);
    pairs[(a - 1) * 6 + (b - 1)] += 1;
    one[a - 1] += 1;
  }
  const x2 = chi2(pairs, ROLLS / 36);
  assert.ok(x2 < critical(35), `пары: хи-квадрат ${x2.toFixed(1)} ≥ ${critical(35).toFixed(1)}`);
  const x1 = chi2(one, ROLLS / 6);
  assert.ok(x1 < critical(5), `один кубик: хи-квадрат ${x1.toFixed(1)}`);
});

for (const [name, make, size] of [
  ['покер', () => shuffled(), 52],
  ['дурак', () => shuffled36(), 36],
  ['UNOQ', () => colorsShuffled(), colorsFresh().length],
]) {
  test(`АУДИТ D: тасовка ${name} — первая карта колоды равновероятна (${SHUFFLES} тасовок)`, () => {
    const firstKinds = new Map();
    const fresh = name === 'UNOQ' ? colorsFresh() : null;
    for (let i = 0; i < SHUFFLES; i++) {
      const d = make();
      assert.equal(d.length, size);
      firstKinds.set(d[0], (firstKinds.get(d[0]) || 0) + 1);
    }
    if (fresh) {
      // В UNOQ карты повторяются: ожидание — доля экземпляров.
      const share = new Map();
      for (const c of fresh) share.set(c, (share.get(c) || 0) + 1);
      let x2 = 0;
      for (const [c, k] of share) {
        const e = (SHUFFLES * k) / fresh.length;
        x2 += ((firstKinds.get(c) || 0) - e) ** 2 / e;
      }
      assert.ok(x2 < critical(share.size - 1), `хи-квадрат ${x2.toFixed(1)}`);
      return;
    }
    const counts = [...firstKinds.values()];
    assert.equal(counts.length, size, 'каждая карта бывает первой');
    const x2 = chi2(counts, SHUFFLES / size);
    assert.ok(x2 < critical(size - 1), `хи-квадрат ${x2.toFixed(1)} ≥ ${critical(size - 1).toFixed(1)}`);
  });
}
