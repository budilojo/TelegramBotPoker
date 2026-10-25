'use strict';
/**
 * Числа курса «Обучение» — пересчёт НЕЗАВИСИМЫМ путём. `miniapp/learn/facts.js` считает
 * формулами (`poker-math.js`); здесь каждый факт получается перебором колод через
 * `bot/eval.js` или решением определения «с нуля». Расхождение — тест падает, и по
 * умолчанию неправ факт, а не тест.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCard, rankOf, suitOf } from './deck.js';
import { best5, score5, compare, CATEGORY } from './eval.js';
import { fact, FACT_IDS, FORMATS, fillFacts, factRefs } from '../miniapp/learn/facts.js';
import { ALL_HANDS, comboSum, combosLeft, chen, boardTexture, cellHand, handsAtLeast } from '../miniapp/learn/hands.js';

const P = (s) => s.split(' ').map(parseCard);
const near = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} ≠ ${b}`);
const ALL = Array.from({ length: 52 }, (_, i) => i);
const without = (...groups) => { const dead = new Set(groups.flat()); return ALL.filter((c) => !dead.has(c)); };

/** Все пары из массива. */
function* pairs(arr) { for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) yield [arr[i], arr[j]]; }

const CHECKED = new Set();
const check = (id, v, eps = 1e-9) => { CHECKED.add(id); near(fact(id), v, id, eps); };

test('комбо: пересчёт перебором пар карт', () => {
  let all = 0; let pair = 0; let suited = 0; let aa = 0;
  const same = (a, b) => rankOf(a) === rankOf(b);
  for (const [a, b] of pairs(ALL)) {
    all++;
    if (same(a, b)) pair++;
    if (suitOf(a) === suitOf(b)) suited++;
    if (same(a, b) && rankOf(a) === 12) aa++;
  }
  check('startHandCombos', all);
  check('pocketPairChance', pair / all);
  check('acesChance', aa / all);
  check('suitedChance', suited / all);
  const ace = 12; const king = 11;
  const count = (f) => [...pairs(ALL)].filter(([a, b]) => f(a, b)).length;
  check('pairCombos', count((a, b) => rankOf(a) === ace && rankOf(b) === ace));
  check('suitedCombos', count((a, b) => [rankOf(a), rankOf(b)].sort().join() === `${king},${ace}` && suitOf(a) === suitOf(b)));
  check('offsuitCombos', count((a, b) => [rankOf(a), rankOf(b)].sort().join() === `${king},${ace}` && suitOf(a) !== suitOf(b)));
  check('anyTwoRanksCombos', count((a, b) => [rankOf(a), rankOf(b)].sort().join() === `${king},${ace}`));
});

test('блокеры: у соперника при тузе пик в нашей руке', () => {
  const asp = parseCard('As');
  const rest = without([asp]);
  const vill = [...pairs(rest)];
  check('aaCombosBlocked', vill.filter(([a, b]) => rankOf(a) === 12 && rankOf(b) === 12).length);
  check('akCombosBlocked', vill.filter(([a, b]) => [rankOf(a), rankOf(b)].sort().join() === '11,12').length);
});

test('пять карт: стрит и флеш — перебор всех 2.598.960 рук через eval.js', () => {
  let n = 0; let straight = 0; let flush = 0;
  for (let a = 0; a < 48; a++) for (let b = a + 1; b < 49; b++) for (let c = b + 1; c < 50; c++) for (let d = c + 1; d < 51; d++) for (let e = d + 1; e < 52; e++) {
    n++;
    const cat = score5([a, b, c, d, e])[0];
    if (cat === CATEGORY.STRAIGHT) straight++;
    else if (cat === CATEGORY.FLUSH) flush++;
  }
  assert.equal(n, 2598960);
  check('straightFiveCard', straight / n);
  check('flushFiveCard', flush / n);
});

/** Доля раскладок (докладываем `need` карт), в которых рука героя достигает `ok`. */
function hitRate(hero, board, need, ok) {
  const rest = without(hero, board);
  let hit = 0; let n = 0;
  const run = (extra) => { n++; if (ok(hero, [...board, ...extra])) hit++; };
  if (need === 1) for (const c of rest) run([c]);
  else if (need === 2) for (const [a, b] of pairs(rest)) run([a, b]);
  else for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) for (let k = j + 1; k < rest.length; k++) run([rest[i], rest[j], rest[k]]);
  return hit / n;
}
const atLeast = (cat) => (hero, board) => best5([...hero, ...board]).score[0] >= cat;

test('ауты и дро — перебор раскладок через eval.js', () => {
  const fdHero = P('Ah Kh'); const fdBoard = P('7h 2h Qs');
  check('flushDrawNext', hitRate(fdHero, fdBoard, 1, atLeast(CATEGORY.FLUSH)));
  check('flushDrawByRiver', hitRate(fdHero, fdBoard, 2, atLeast(CATEGORY.FLUSH)));
  check('flushDrawTurnToRiver', hitRate(fdHero, [...fdBoard, parseCard('3s')], 1, atLeast(CATEGORY.FLUSH)));
  check('oesdByRiver', hitRate(P('9s 8d'), P('7c 6h 2d'), 2, atLeast(CATEGORY.STRAIGHT)));
  check('gutshotByRiver', hitRate(P('9s 8d'), P('6c 5h Kd'), 2, atLeast(CATEGORY.STRAIGHT)));
  check('comboDrawByRiver', hitRate(P('9h 8h'), P('7h 6d 2h'), 2, atLeast(CATEGORY.STRAIGHT)));
  // две старшие карты: категория руки стала выше категории борда, т.е. нашлась пара с A или K
  const better = (hero, board) => best5([...hero, ...board]).score[0] > best5(board).score[0];
  check('overcardsByRiver', hitRate(P('As Kd'), P('9c 8h 2d'), 2, better));
});

test('set на флопе: карманная пара находит третью карту ранга за три карты флопа', () => {
  const hero = P('8s 8h');
  const rest = without(hero);
  let hit = 0; let n = 0;
  for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) for (let k = j + 1; k < rest.length; k++) {
    n++;
    const flop = [rest[i], rest[j], rest[k]];
    if (flop.some((c) => rankOf(c) === rankOf(hero[0]))) {
      hit++;
      assert.ok(best5([...hero, ...flop]).score[0] >= CATEGORY.TRIPS); // у героя действительно тройка или лучше
    }
  }
  check('setOnFlop', hit / n);
});

test('правило 2 и 4 и его ошибка — из определения', () => {
  check('flushDrawRule4', 9 * 4 / 100);
  check('flushDrawRule2', 9 * 2 / 100);
  check('bigDrawRule4', 15 * 4 / 100);
  const exact = hitRate(P('Ah Kh'), P('7h 2h Qs'), 2, atLeast(CATEGORY.FLUSH));
  check('flushDrawRule4Error', Math.abs(0.36 - exact));
});

/** Определение безубыточности «с нуля»: найти эквити, при котором EV колла равен нулю, делением пополам. */
function solveBreakEven(f) {
  let lo = 0; let hi = 1;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (f(m) < 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

test('шансы банка и EV — из определения (без формул факта)', () => {
  // колл `call` ради банка `pot` (в нём уже ставка соперника): выиграем pot, проиграем call
  const need = (pot, call) => solveBreakEven((q) => q * pot - (1 - q) * call);
  check('potOddsHalf', need(150, 50), 1e-9);
  check('potOddsPot', need(200, 100), 1e-9);
  check('potOddsQuarter', need(125, 25), 1e-9);
  check('bbCallNeed', need(4.5, 2), 1e-9);
  check('impliedNeed', solveBreakEven((q) => q * (150 + 100) - (1 - q) * 50), 1e-9);
  const evCallBy = (eq) => eq * 150 - (1 - eq) * 50;
  check('evCallGood', evCallBy(0.35));
  check('evCallBad', evCallBy(0.2));
  // ставка 100 в банк 100: сброс 40% — банк, иначе колл
  const evBetBy = (fold, eq) => fold * 100 + (1 - fold) * (eq * 200 - (1 - eq) * 100);
  check('pureBluffEv', evBetBy(0.4, 0));
  check('semiBluffEv', evBetBy(0.4, 0.35));
});

test('блеф, MDF и баланс — из условий безразличия', () => {
  const bluffFold = (pot, bet) => solveBreakEven((f) => f * pot - (1 - f) * bet); // чистый блеф
  check('bluffBreakevenPot', bluffFold(100, 100), 1e-9);
  check('bluffBreakevenHalf', bluffFold(100, 50), 1e-9);
  // MDF: доля защиты, при которой блеф соперника ровно в ноль, т.е. 1 − безубыточный сброс
  check('mdfHalf', 1 - bluffFold(100, 50), 1e-9);
  check('mdfPot', 1 - bluffFold(100, 100), 1e-9);
  check('mdfDouble', 1 - bluffFold(100, 200), 1e-9);
  // баланс: колл безразличен, когда на каждую ценность приходится b блефов: b·(pot+bet) = v·bet
  const share = (pot, bet) => { const ratio = bet / (pot + bet); return ratio / (1 + ratio); };
  check('bluffShareHalf', share(100, 50), 1e-9);
  check('bluffSharePot', share(100, 100), 1e-9);
  // камень-ножницы-бумага: у равномерной смеси лучший ответ соперника даёт ровно ноль, у любой другой — плюс
  const exploit = ([r, p, s]) => Math.max(s - p, r - s, p - r);
  assert.equal(Math.abs(exploit([1 / 3, 1 / 3, 1 / 3])) < 1e-12, true);
  assert.ok(exploit([0.4, 0.3, 0.3]) > 0);
  check('rpsEven', 1 / 3);
});

test('эквити «рука против руки» на флопе — перебор 990 раскладок через eval.js', () => {
  const duel = (h, v, f) => {
    const hero = P(h); const vill = P(v); const flop = P(f);
    let w = 0; let n = 0;
    for (const [a, b] of pairs(without(hero, vill, flop))) {
      const c = compare(best5([...hero, ...flop, a, b]).score, best5([...vill, ...flop, a, b]).score);
      w += c > 0 ? 1 : c === 0 ? 0.5 : 0; n++;
    }
    assert.equal(n, 990);
    return w / n;
  };
  check('flushDrawVsTopPair', duel('9h 8h', 'Ac Kd', 'Ah 4h 2c'));
  check('pairVsFlushDraw', duel('Ks Kd', '9h 8h', 'Ah 4h 2c'));
});

test('форматы чисел: русская запись', () => {
  assert.equal(FORMATS.percent(0.35), '35%');
  assert.equal(FORMATS.percent1(0.3497), '35,0%');
  assert.equal(FORMATS.percent2(0.0045), '0,45%');
  assert.equal(FORMATS.int(1326), '1.326');
  assert.equal(FORMATS.signed(-10), '−10');
  assert.equal(FORMATS.signed(20), '+20');
  assert.equal(fillFacts('шанс {{fact:potOddsHalf|percent}} при {{in:35%}}'), 'шанс 25% при 35%');
  assert.deepEqual(factRefs('{{fact:ev|int}}'), [{ id: 'ev', format: 'int' }]);
});

test('матрица 13×13 и комбо', () => {
  assert.equal(ALL_HANDS.length, 169);
  assert.equal(comboSum(ALL_HANDS), 1326);
  // combosLeft сверяем с прямым перебором мастей
  for (const [hi, lo, kind, n] of [['A', 'A', 'p', 6], ['A', 'K', 's', 4], ['A', 'K', 'o', 12]]) assert.equal(combosLeft(hi, lo, kind), n);
  assert.equal(combosLeft('A', 'A', 'p', ['AS']), 3);
  assert.equal(combosLeft('A', 'K', 's', ['AS']) + combosLeft('A', 'K', 'o', ['AS']), 12);
  assert.equal(cellHand(0, 1).name, 'AKs'); assert.equal(cellHand(1, 0).name, 'AKo'); assert.equal(cellHand(2, 2).name, 'QQ');
  const by = (n) => ALL_HANDS.find((x) => x.name === n);
  // известные очки формулы Чена
  for (const [n, pts] of [['AA', 20], ['AKs', 12], ['AKo', 10], ['KQo', 8], ['T9s', 8], ['J9o', 6], ['22', 5], ['72o', -1]]) assert.equal(chen(by(n)), pts, n);
  // шире порог — больше комбо
  assert.ok(comboSum(handsAtLeast(6)) > comboSum(handsAtLeast(10)));
});

test('текстура флопа', () => {
  assert.equal(boardTexture(['KS', '7D', '2C']).label, 'сухой');
  assert.equal(boardTexture(['JH', '10H', '8C']).label, 'мокрый');
  assert.equal(boardTexture(['9S', '9D', '4C']).label, 'парный');
  assert.equal(boardTexture(['AH', 'KH', 'QH']).suits, 'mono');
});

test('у каждого факта есть значение и тест', () => {
  for (const id of FACT_IDS) assert.ok(Number.isFinite(fact(id)), id);
  // каждый факт обязан быть проверен ниже: список id в этом файле сверяется с реестром
  assert.deepEqual([...CHECKED].sort(), [...FACT_IDS].sort(), 'есть непроверенные факты или лишние проверки');
});
