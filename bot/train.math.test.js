// Тесты покерной математики тренировки (агент X): miniapp/train/poker-math.js.
// Оценщик сверяется с bot/eval.js (написан независимо), вероятности — с перебором руками.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../miniapp/train/poker-math.js';
import { best5, compare as cmpBot } from './eval.js';

const C = M.parseCards;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('оценщик == bot/eval.js на 60 000 случайных рук (5, 6 и 7 карт)', () => {
  const rng = M.makeRng(2026);
  for (let i = 0; i < 60000; i++) {
    const n = 5 + (i % 3);
    const cards = M.shuffleWith(rng, M.DECK).slice(0, n);
    const mine = M.evaluate(cards);
    const bot = best5(cards).score;
    assert.deepEqual(mine, bot, `расхождение на ${cards.map(M.cardName)}`);
  }
});

test('сравнение рук: знак совпадает с bot/eval.js, в т.ч. на «спаренных» бордах', () => {
  const rng = M.makeRng(7);
  for (let i = 0; i < 20000; i++) {
    const d = M.shuffleWith(rng, M.DECK);
    // борд с малым разнообразием рангов: чаще пары, фулл-хаусы, каре
    const board = d.slice(0, 5);
    const a = [...d.slice(5, 7), ...board], b = [...d.slice(7, 9), ...board];
    assert.equal(M.compareHands(M.evaluate(a), M.evaluate(b)), cmpBot(best5(a).score, best5(b).score));
  }
  // колесо слабее стрита от шестёрки
  assert.equal(M.compareHands(M.evaluate(C('As 2d 3c 4h 5s')), M.evaluate(C('2d 3c 4h 5s 6s'))), -1);
  // два фулл-хауса на борде: старшая тройка побеждает
  assert.equal(M.compareHands(M.evaluate(C('Ks Kd Kc 2s 2d 9h 3c')), M.evaluate(C('Qs Qd Qc 2s 2d 9h 3c'))), 1);
});

test('разбор и печать карт', () => {
  assert.equal(M.cardCode(M.parseCard('10h')), '10H');
  assert.equal(M.cardCode(M.parseCard('As')), 'AS');
  assert.equal(M.cardName(M.parseCard('Kd')), 'K♦');
  assert.equal(M.parseCard('Zz'), -1);
  assert.equal(M.fmtNum(1234567), '1.234.567');
  assert.equal(M.fmtPct(0.35), '35,0 %');
});

test('вероятность дро: точные значения совпадают с полным перебором', () => {
  // флеш-дро (9 аутов) на флопе: перебираем все пары тёрн+ривер руками
  const hero = C('Ah Kh'), board = C('7h 2h 9c');
  const outs = M.drawOuts(hero, board, ['flush']);
  assert.equal(outs.length, 9);
  const left = M.remaining(hero, board);
  let hit = 0, tot = 0;
  for (let i = 0; i < left.length; i++) for (let j = i + 1; j < left.length; j++) {
    tot++;
    if (outs.includes(left[i]) || outs.includes(left[j])) hit++;
  }
  assert.equal(tot, 1081);
  close(hit / tot, M.hitProbability(9, 47, 2));
  close(hit / tot, 1 - (38 * 37) / (47 * 46)); // независимая формула
  assert.ok(Math.abs(hit / tot - 0.3497) < 0.0001); // ≈ 35 %
  // 8 аутов (открытый стрит) ≈ 31,5 %
  close(M.hitProbability(8, 47, 2), 1 - (39 * 38) / (47 * 46));
  assert.ok(Math.abs(M.hitProbability(8, 47, 2) - 0.3145) < 0.0001);
  // следующая карта: 9 из 47 и 9 из 46
  close(M.hitByStreet(9, 3).next, 9 / 47);
  close(M.hitByStreet(9, 4).toRiver, 9 / 46);
});

test('классификация дро: флеш, открытый стрит, гатшот, оверкарты', () => {
  const kinds = (h, b) => M.drawsOf(C(h), C(b)).map((d) => `${d.type}:${d.outs.length}`).sort();
  assert.deepEqual(kinds('Ah Kh', '7h 2h 9c'), ['flush:9', 'overcards:6']);
  assert.deepEqual(kinds('8s 7d', '6c 5h Kd'), ['oesd:8']);
  assert.deepEqual(kinds('8s 6d', '9c 5h Kd'), ['gutshot:4']);
  assert.deepEqual(kinds('As Kd', '9c 5h 2d'), ['overcards:6']);
  // комбо-дро: флеш + стрит, ауты без повторов
  const combo = M.drawOuts(C('9h 8h'), C('7h 6c 2h'), ['flush', 'oesd']);
  assert.equal(combo.length, 15); // 9 червей + 8 карт стрита − 2 общих (10♥ и 5♥) = 15
  // готовый стрит — это уже не дро
  assert.deepEqual(kinds('8s 7d', '6c 5h 4d'), []);
  // стрит целиком на борде без участия карт героя — не дро героя
  assert.deepEqual(kinds('2s 2d', '6c 7h 8d'), []);
});

test('нечистые ауты: флеш-карта, дающая сопернику фулл-хаус/старший флеш', () => {
  // у героя флеш-дро, у соперника сет троек на спаренном борде: бубна ставит пару на борд — но тут проверяем лидерство
  const hero = C('Ah 5h'), vil = C('Kh Kd');
  const board = C('Kc 9h 2h');
  const { clean, dirty } = M.cleanOuts(hero, board, vil);
  // 9 червей: флеш героя (A-high) vs. сет королей/ фулл — сет королей сильнее без пары на борде, значит все ауты «нечистые» кроме пар-комбинаций
  assert.equal(clean.length + dirty.length, M.drawOuts(hero, board).length - 1); // K♥ у соперника — не аут
  // флеш бьёт сет: все 8 оставшихся червей чистые
  assert.equal(clean.length, 8);
  assert.equal(dirty.length, 0);
  // против А-высокого флеша: карта-бубна/любая масть K♥ у соперника
  const h2 = C('Qh Jh'), v2 = C('Ah 3h');
  const r2 = M.cleanOuts(h2, C('Kh 9h 2c'), v2);
  // героя флеш старше Q против A: все черви с A у соперника → его флеш старше
  // чистые — четыре десятки (стрит, а 10♥ ещё и стрит-флеш); черви 2…8 дают флеш, но ниже флеша A
  assert.deepEqual(r2.clean.map(M.cardName).sort(), ['10♠', '10♥', '10♦', '10♣'].sort());
  assert.equal(r2.dirty.length, 6); // 2♥ 4♥ 5♥ 6♥ 7♥ 8♥; A♥ и 3♥ — у соперника, аутами быть не могут
});

test('эквити: известные значения (перебор)', () => {
  // AA против KK префлоп ≈ 81–82 % — Монте-Карло с seed
  const aa = M.equity(C('As Ah'), [], C('Ks Kh'), { samples: 40000, seed: 1 });
  assert.equal(aa.exact, false);
  assert.ok(aa.equity > 0.8 && aa.equity < 0.83, `AA vs KK = ${aa.equity}`);
  // воспроизводимо
  assert.equal(M.equity(C('As Ah'), [], C('Ks Kh'), { samples: 5000, seed: 3 }).equity,
    M.equity(C('As Ah'), [], C('Ks Kh'), { samples: 5000, seed: 3 }).equity);
  // флоп, точный перебор: флеш-дро против пары — своя ручная сверка
  const hero = C('Ah 5h'), vil = C('Kd Ks'), board = C('Kh 9h 2c');
  const ex = M.equity(hero, board, vil);
  assert.equal(ex.exact, true);
  assert.equal(ex.n, 990);
  let w = 0, t = 0;
  const left = M.remaining(hero, board, vil);
  for (let i = 0; i < left.length; i++) for (let j = i + 1; j < left.length; j++) {
    const b = [...board, left[i], left[j]];
    const c = cmpBot(best5([...hero, ...b]).score, best5([...vil, ...b]).score);
    if (c > 0) w++; else if (c === 0) t++;
  }
  close(ex.equity, (w + t / 2) / 990);
  // ривер: исход однозначен
  assert.equal(M.equity(C('As Ad'), C('Ah Kc Kd 2c 2d'), C('Ks 3s')).equity, 1);
  // против диапазона: «любая пара тузов-королей» — комбо считаются с блокерами
  const vr = M.equity(C('Qs Qd'), C('2c 7h 9d'), new Set(['AA', 'KK']));
  assert.ok(vr.exact && vr.equity < 0.3);
});

test('комбо: блокеры', () => {
  assert.equal(M.combosOf('AA'), 6);
  assert.equal(M.combosOf('AKs'), 4);
  assert.equal(M.combosOf('AKo'), 12);
  assert.equal(M.combosOf('AA', C('As')), 3);
  assert.equal(M.combosOf('AKs', C('As')), 3);
  assert.equal(M.combosOf('AKo', C('As Kd')), 12 - 3 - 3 + 1 - 0);
  assert.equal(M.rangeCombos(['AA', 'AKs'], C('Ah')), 3 + 3);
  assert.equal(M.labelOf(C('As')[0], C('Kd')[0]), 'AKo');
  assert.equal(M.labelOf(C('7s')[0], C('7d')[0]), '77');
});

test('pot odds, EV, MDF, SPR — ручные примеры', () => {
  // банк 100, ставка 50: нужно 50 / 200 = 25 %
  close(M.requiredEquity(100, 50), 0.25);
  close(M.potOddsRatio(100, 50), 3);
  // банк 100, ставка 100: нужно 100 / 300 = 33,3 %
  close(M.requiredEquity(100, 100), 1 / 3);
  // EV колла с ровно нужным эквити = 0
  close(M.evCall(0.25, 100, 50), 0);
  // эквити 35 % при банке 100, ставке 50: 0.35·150 − 0.65·50 = 20
  close(M.evCall(0.35, 100, 50), 20);
  // ставка 50 в банк 100: блеф окупается при сбросе ≥ 33,3 %
  close(M.breakEvenFold(100, 50), 1 / 3);
  close(M.evBet(100, 50, 1 / 3, 0), 0);
  // полу-блеф: fold 40 %, эквити при колле 30 % → 0.4·100 + 0.6·(0.3·150 − 0.7·50) = 40 + 6 = 46
  close(M.evBet(100, 50, 0.4, 0.3), 46);
  close(M.mdf(100, 50), 2 / 3);
  close(M.spr(300, 60), 5);
  // скрытые шансы: нужно 25 %, есть 20 % → доплата X: 50·0.8/0.2 − 100 − 50 = 50
  close(M.impliedNeeded(0.2, 100, 50), 50);
  close(M.requiredEquityImplied(100, 50, 50), 0.2);
  assert.equal(M.impliedNeeded(0.4, 100, 50), 0);
  // блеф-вэлью: ставка в банк, 6 вэлью-комбо → 6·50/150 = 2 блефа; доля блефов = 20 % от 10? 2/(2+6)=25 %
  close(M.bluffsForValue(6, 100, 50), 2);
  close(M.bluffShare(100, 50), 0.25);
  close(2 / (2 + 6), M.bluffShare(100, 50));
});

test('правило 2 и 4: приближение и ошибка', () => {
  const f9 = M.rule24(9, 3);
  close(f9.approx, 0.36);
  assert.ok(Math.abs(f9.errorPp - (36 - 34.968)) < 0.01);
  const t9 = M.rule24(9, 4);
  close(t9.approx, 0.18);
  close(t9.exact, 9 / 46);
  // ошибка правила не больше ~6 п.п. при 15 аутах на флопе: 60 против 54,1
  assert.ok(M.rule24(15, 3).errorPp > 5.5 && M.rule24(15, 3).errorPp < 6.5);
  // при ≤ 12 аутах ошибка по модулю ≤ 3,1 п.п. (мало аутов — чуть занижает, много — завышает)
  for (let o = 1; o <= 12; o++) assert.ok(Math.abs(M.rule24(o, 3).errorPp) < 3.1);
  assert.ok(M.rule24(2, 3).errorPp < 0 && M.rule24(12, 3).errorPp > 0);
});

test('«на зубы»: проверки ловят подмену формул', () => {
  // если бы requiredEquity считалась как bet/(pot+bet) — это число отличалось бы
  assert.notEqual(M.requiredEquity(100, 50).toFixed(4), (50 / 150).toFixed(4));
  assert.notEqual(M.hitProbability(9, 47, 2).toFixed(3), (9 * 2 / 47).toFixed(3));
});
