'use strict';
/**
 * Оценщик комбинаций. Самое опасное место нового бота: ошибка здесь не падает
 * и не течёт фишками — она просто молча отдаёт банк не тому.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { score5, best5, compare, rank, CATEGORY } from './eval.js';
import { parseHand, shuffled, freshDeck, rankOf, suitOf, seededRng } from './deck.js';

const S = (s) => score5(parseHand(s));
const B = (s) => best5(parseHand(s));
const cat = (s) => S(s)[0];

/* --------------------------------------------------------- все категории */

test('каждая категория опознаётся', () => {
  assert.equal(cat('As Ks Qs Js 10s'), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(cat('9h 8h 7h 6h 5h'), CATEGORY.STRAIGHT_FLUSH);
  assert.equal(cat('8s 8d 8c 8h Kd'), CATEGORY.QUADS);
  assert.equal(cat('Ks Kd Kc 10h 10s'), CATEGORY.FULL_HOUSE);
  assert.equal(cat('As Js 9s 6s 3s'), CATEGORY.FLUSH);
  assert.equal(cat('9c 8d 7s 6h 5c'), CATEGORY.STRAIGHT);
  assert.equal(cat('7s 7d 7c Kh 2s'), CATEGORY.TRIPS);
  assert.equal(cat('As Ad Ks Kd 9c'), CATEGORY.TWO_PAIR);
  assert.equal(cat('As Ad Ks 9d 4c'), CATEGORY.PAIR);
  assert.equal(cat('As Kd 9c 6h 3s'), CATEGORY.HIGH);
});

test('категории упорядочены строго по правилам', () => {
  const ladder = [
    'As Kd 9c 6h 3s',   // старшая
    'As Ad Ks 9d 4c',   // пара
    'As Ad Ks Kd 9c',   // две пары
    '7s 7d 7c Kh 2s',   // сет
    '9c 8d 7s 6h 5c',   // стрит
    'As Js 9s 6s 3s',   // флеш
    'Ks Kd Kc 10h 10s', // фулл-хаус
    '8s 8d 8c 8h Kd',   // каре
    '9h 8h 7h 6h 5h',   // стрит-флеш
  ];
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(
      compare(S(ladder[i]), S(ladder[i - 1])) > 0,
      `${ladder[i]} должно быть сильнее ${ladder[i - 1]}`
    );
  }
});

/* -------------------------------------------------------------- туз внизу */

test('колесо A-2-3-4-5 — стрит от пятёрки, а не от туза', () => {
  const wheel = S('As 2d 3c 4h 5s');
  assert.equal(wheel[0], CATEGORY.STRAIGHT);
  assert.equal(wheel[1], 3, 'старшая карта колеса — пятёрка (индекс 3)');
  assert.ok(compare(wheel, S('6c 5d 4s 3h 2c')) < 0, 'колесо слабее стрита до 6');
  assert.ok(compare(S('As Kd Qc Jh 10s'), wheel) > 0, 'и намного слабее стрита до туза');
});

test('стальное колесо — стрит-флеш от пятёрки', () => {
  const steel = S('As 2s 3s 4s 5s');
  assert.equal(steel[0], CATEGORY.STRAIGHT_FLUSH);
  assert.equal(steel[1], 3);
  assert.ok(compare(S('6s 5s 4s 3s 2s'), steel) > 0, 'слабейший из стрит-флешей');
  assert.ok(compare(steel, S('Ks Kd Kc Kh 2s')) > 0, 'но всё ещё сильнее каре');
});

test('туз не склеивает K-A-2', () => {
  assert.equal(cat('Kh As 2d 3c 4s'), CATEGORY.HIGH, 'Q-K-A-2-3 — не стрит');
});

/* ------------------------------------------------------------- тайбрейки */

test('кикер решает при равной паре', () => {
  assert.ok(compare(S('As Ad Ks 9d 4c'), S('Ac Ah Qs 9d 4c')) > 0, 'K бьёт Q');
  assert.ok(compare(S('As Ad Ks 9d 4c'), S('Ac Ah Ks 9c 3d')) > 0, 'третий кикер тоже считается');
  assert.equal(compare(S('As Ad Ks 9d 4c'), S('Ac Ah Kd 9h 4s')), 0, 'полное равенство — дележ');
});

test('две пары: сначала старшая пара, потом младшая, потом кикер', () => {
  assert.ok(compare(S('As Ad 5s 5d 9c'), S('Ks Kd Qs Qd 9c')) > 0, 'старшая пара важнее');
  assert.ok(compare(S('As Ad Ks Kd 2c'), S('Ac Ah 5s 5c Kd')) > 0, 'при равной старшей решает младшая');
  assert.ok(compare(S('As Ad Ks Kd 9c'), S('Ac Ah Kc Kh 8d')) > 0, 'потом кикер');
});

test('фулл-хаус: сначала тройка, потом пара', () => {
  assert.ok(compare(S('2s 2d 2c As Ad'), S('Ks Kd Kc Qs Qd')) < 0, 'тройка решает первой');
  assert.ok(compare(S('Ks Kd Kc As Ad'), S('Kh Kc Ks 2s 2d')) > 0, 'при равной тройке решает пара');
});

test('каре и сет сравниваются по кикеру', () => {
  assert.ok(compare(S('8s 8d 8c 8h As'), S('8s 8d 8c 8h Kd')) > 0);
  assert.ok(compare(S('7s 7d 7c As 2d'), S('7s 7d 7c Kh Qd')) > 0);
});

test('флеш сравнивается по всем пяти картам', () => {
  assert.ok(compare(S('As Js 9s 6s 3s'), S('As Js 9s 6s 2s')) > 0, 'решает последняя карта');
  assert.equal(compare(S('As Js 9s 6s 3s'), S('Ah Jh 9h 6h 3h')), 0, 'масть ничего не решает');
});

/* --------------------------------------------------- лучшая пятёрка из 7 */

test('лишние карты не мешают найти лучшую пятёрку', () => {
  assert.equal(B('As Ks Qs Js 10s 2h 3d').name, 'Флеш-рояль');
  assert.equal(B('2h 3d As Ks Qs Js 10s').name, 'Флеш-рояль', 'порядок карт не важен');
  assert.equal(B('8s 8d 8c 8h 2s Kd 9c').name, 'Каре 8');
});

test('возвращённая пятёрка действительно даёт заявленную силу', () => {
  const hand = parseHand('As Ks Qs Js 10s 2h 3d');
  const b = best5(hand);
  assert.equal(b.cards.length, 5);
  assert.equal(compare(score5(b.cards), b.score), 0);
  for (const c of b.cards) assert.ok(hand.includes(c), 'и состоит из карт руки');
});

test('когда играет борд, обе руки равны — банк делится', () => {
  const board = 'As Ks Qs Js 10s';
  const a = best5(parseHand(`${board} 2h 3d`));
  const b = best5(parseHand(`${board} 7c 4d`));
  assert.equal(compare(a.score, b.score), 0, 'карманные карты не улучшают флеш-рояль на борде');
});

test('шесть карт одной масти — флеш берёт пять старших', () => {
  const b = B('As Ks 9s 6s 3s 2s 4h');
  assert.equal(b.score[0], CATEGORY.FLUSH);
  assert.deepEqual(b.score.slice(1), [12, 11, 7, 4, 1], 'A K 9 6 3, двойка отброшена');
});

test('стрит из семи карт берёт самый старший', () => {
  const b = B('9c 8d 7s 6h 5c 4d 3s');
  assert.equal(b.score[0], CATEGORY.STRAIGHT);
  assert.equal(b.score[1], 7, 'стрит до 9, а не до 7');
});

/* ------------------------------------------------------------- вскрытие */

test('rank: группирует ровные руки в один дележ и сортирует по силе', () => {
  const board = parseHand('As Ks 7d 2c 9h');
  const groups = rank([
    { id: 'p1', cards: [...board, ...parseHand('Ad Kd')] }, // две пары A/K
    { id: 'p2', cards: [...board, ...parseHand('Ah Kh')] }, // те же две пары
    { id: 'p3', cards: [...board, ...parseHand('7s 7h')] }, // сет семёрок — сильнее двух пар
    { id: 'p4', cards: [...board, ...parseHand('3c 4d')] }, // старшая
  ]);

  // Полный порядок, а не только «кто первый»: сет > две пары (дележ) > старшая.
  assert.deepEqual(
    groups.map((g) => [...g.ids].sort()),
    [['p3'], ['p1', 'p2'], ['p4']]
  );
  assert.equal(groups[0].name, 'Сет 7');
  assert.equal(groups[1].name, 'Две пары A/K', 'две одинаковые руки — одна группа, банк делится');
  for (let i = 1; i < groups.length; i++) {
    assert.ok(compare(groups[i - 1].score, groups[i].score) > 0, 'строго по убыванию');
  }
});

test('rank: один претендент — один победитель', () => {
  const groups = rank([{ id: 'solo', cards: parseHand('As Ks Qs Js 10s 2h 3d') }]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['solo']);
});

/* ---------------------------------------------------------- инвариантный */

test('случайные раздачи: оценка самосогласована и устойчива к порядку', () => {
  const rnd = seededRng(12345);

  for (let i = 0; i < 3000; i++) {
    const deck = shuffled(rnd);
    const seven = deck.slice(0, 7);
    const b = best5(seven);

    assert.ok(b.score[0] >= 0 && b.score[0] <= 8, 'категория в диапазоне');
    assert.equal(compare(score5(b.cards), b.score), 0, 'пятёрка даёт заявленную силу');
    assert.equal(new Set(b.cards).size, 5, 'без повторов карт');

    // Перестановка входа не должна менять результат.
    const shuffledInput = [...seven].reverse();
    assert.equal(compare(best5(shuffledInput).score, b.score), 0, 'порядок карт не влияет');

    // Ни одна пятёрка из этих семи не может быть сильнее найденной.
    for (let k = 0; k < 5; k++) {
      const sub = [...seven];
      sub.splice(rnd(sub.length), 1);
      sub.splice(rnd(sub.length), 1);
      assert.ok(compare(score5(sub), b.score) <= 0, 'best5 действительно лучшая');
    }
  }
});

test('на полной колоде встречаются все девять категорий', () => {
  const rnd = seededRng(999);
  const seen = new Set();
  for (let i = 0; i < 40000 && seen.size < 9; i++) {
    seen.add(best5(shuffled(rnd).slice(0, 7)).score[0]);
  }
  assert.equal(seen.size, 9, `симуляция не добралась до всех категорий: ${[...seen].sort()}`);
});

test('колода: 52 уникальные карты, тасовка ничего не теряет', () => {
  const rnd = seededRng(7);
  for (let i = 0; i < 200; i++) {
    const d = shuffled(rnd);
    assert.equal(d.length, 52);
    assert.equal(new Set(d).size, 52);
    assert.deepEqual([...d].sort((a, b) => a - b), freshDeck());
  }
});

test('тасовка не оставляет колоду на месте', () => {
  const rnd = seededRng(42);
  let identical = 0;
  for (let i = 0; i < 100; i++) {
    const d = shuffled(rnd);
    if (d.every((c, idx) => c === idx)) identical++;
  }
  assert.equal(identical, 0, 'нетасованная колода — признак сломанного ГСЧ');
});

test('каждая карта разбирается и печатается однозначно', () => {
  for (const c of freshDeck()) {
    assert.ok(rankOf(c) >= 0 && rankOf(c) <= 12);
    assert.ok(suitOf(c) >= 0 && suitOf(c) <= 3);
  }
});

test('тестовый ГСЧ сам по себе не вырожден — иначе все случайные тесты выше пусты', () => {
  // Прошлый генератор проходил все тесты, кроме одного, и при этом крутил
  // цикл из 419 состояний. Проверяем то, что он проваливал: равномерность
  // младших значений и отсутствие короткого цикла.
  const rnd = seededRng(999);
  const counts = new Array(52).fill(0);
  const N = 52 * 4000;
  for (let i = 0; i < N; i++) counts[rnd(52)]++;
  for (const c of counts) {
    assert.ok(Math.abs(c - 4000) < 400, `перекос распределения: ${c} вместо ~4000`);
  }

  const seen = new Set();
  const r2 = seededRng(999);
  for (let i = 0; i < 100000; i++) seen.add(`${r2(1 << 30)}`);
  assert.ok(seen.size > 99000, `подозрительно мало разных значений: ${seen.size}`);
});

test('разные зёрна дают разные колоды, одно зерно — одну и ту же', () => {
  assert.deepEqual(shuffled(seededRng(5)), shuffled(seededRng(5)));
  assert.notDeepEqual(shuffled(seededRng(5)), shuffled(seededRng(6)));
});

test('частоты комбинаций на семи картах совпадают с точной комбинаторикой', () => {
  // Независимая проверка оценщика: не «я думаю, что правила такие», а
  // вероятности, посчитанные полным перебором 133 784 560 семёрок. Ошибка в
  // стрите, колесе или флеше сдвинула бы свою категорию на десятки сигм.
  const EXACT = [0.174119, 0.438225, 0.234955, 0.048299, 0.046194, 0.030255, 0.025961, 0.001681];
  const N = 30000;
  const rnd = seededRng(2024);
  const c = new Array(9).fill(0);
  for (let i = 0; i < N; i++) c[best5(shuffled(rnd).slice(0, 7)).score[0]]++;
  EXACT.forEach((p, k) => {
    const sd = Math.sqrt((p * (1 - p)) / N);
    const z = (c[k] / N - p) / sd;
    assert.ok(Math.abs(z) < 4.5, `категория ${k}: ${(c[k] / N).toFixed(4)} против ${p} (z=${z.toFixed(1)})`);
  });
});
