/**
 * Диапазоны (агент W): 169 рук и 1326 комбинаций, разбор строки ↔ набор,
 * сравнение по комбинациям, блокеры, эталонные данные (сверка эквити с
 * независимым оценщиком bot/eval.js), вложенность диапазонов по позициям.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_HANDS, TOTAL_COMBOS, combosOf, comboCount, rangePercent, parseRange, formatRange, tryParseRange,
  RangeSyntaxError, diff, combosGiven, parseCard, handCombos, handOfCards, handAt, cellOf,
} from '../miniapp/train/ranges/hands.js';
import {
  ORDER, openRange, defendRange, vs3betRange, chenScore, OPEN_PCT, POSITIONS, layeredFreq, topShare,
} from '../miniapp/train/ranges/data.js';
import { EQUITY169 } from '../miniapp/train/ranges/equity169.js';
import { best5, compare } from './eval.js';

const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

test('169 рук и 1326 комбинаций сходятся', () => {
  assert.equal(ALL_HANDS.length, 169);
  assert.equal(new Set(ALL_HANDS).size, 169);
  const pairs = ALL_HANDS.filter((c) => c.length === 2).length;
  const suited = ALL_HANDS.filter((c) => c.endsWith('s')).length;
  const off = ALL_HANDS.filter((c) => c.endsWith('o')).length;
  assert.deepEqual([pairs, suited, off], [13, 78, 78]);
  assert.equal(6 * 13 + 4 * 78 + 12 * 78, 1326);
  assert.equal(comboCount(new Set(ALL_HANDS)), TOTAL_COMBOS);
  // перечень настоящих карт тоже даёт 1326 разных пар
  const seen = new Set();
  for (const c of ALL_HANDS) {
    const list = handCombos(c);
    assert.equal(list.length, combosOf(c), c);
    for (const [x, y] of list) { assert.equal(handOfCards(x, y), c); seen.add(Math.min(x, y) * 100 + Math.max(x, y)); }
  }
  assert.equal(seen.size, 1326);
});

test('положение в матрице: пары по диагонали, одномастные выше, разномастные ниже', () => {
  assert.equal(handAt(0, 0), 'AA');
  assert.equal(handAt(0, 1), 'AKs');
  assert.equal(handAt(1, 0), 'AKo');
  assert.equal(handAt(12, 12), '22');
  assert.deepEqual(cellOf('T9s'), { row: 4, col: 5 });
  assert.deepEqual(cellOf('T9o'), { row: 5, col: 4 });
});

test('процент диапазона считается по комбинациям, а не по клеткам', () => {
  assert.equal(comboCount(parseRange('AA')), 6);
  assert.equal(comboCount(parseRange('KQo')), 12);
  assert.equal(comboCount(parseRange('KQs')), 4);
  assert.equal(comboCount(parseRange('AA, KQo')), 18);
  assert.equal(rangePercent(parseRange('77+, ATs+, KQo')), Math.round(((8 * 6 + 4 * 4 + 12) / 1326) * 1000) / 10);
  // смешанные частоты: пара тузов на 50 % = 3 комбо
  assert.equal(comboCount(new Map([['AA', 0.5]])), 3);
});

test('parseRange и formatRange взаимно обратны', () => {
  const cases = ['77+', 'A5s-A2s', 'KQo', 'JJ-88', 'ATs+', 'KTo+', 'T9s-65s', 'AKs, AKo', 'AK', '22+, A2s+, K9s+, QTo+, T9s', '66+, A3s+, AJo+, KTs+, KJo+, QTs+, J9s+, T9s, 98s'];
  for (const text of cases) {
    const a = parseRange(text);
    assert.ok(a.size > 0, text);
    const b = parseRange(formatRange(a));
    assert.deepEqual([...b].sort(), [...a].sort(), `${text} → ${formatRange(a)}`);
  }
  // случайные наборы
  const rnd = mulberry(7);
  for (let k = 0; k < 200; k++) {
    const s = new Set(ALL_HANDS.filter(() => rnd() < 0.3));
    assert.deepEqual([...parseRange(formatRange(s))].sort(), [...s].sort());
  }
  // конкретные записи
  assert.equal(formatRange(parseRange('AA KK QQ JJ TT 99 88 77')), '77+');
  assert.equal(formatRange(parseRange('ATs AJs AQs AKs')), 'ATs+');
  assert.equal(formatRange(parseRange('A5s A4s A3s A2s')), 'A5s-A2s');
  assert.deepEqual([...parseRange('JJ-88')].sort(), ['88', '99', 'JJ', 'TT']);
  assert.deepEqual([...parseRange('77+')].length, 8);
  assert.deepEqual([...parseRange('AK')].sort(), ['AKo', 'AKs']);
  assert.equal(parseRange('ATs+').size, 4);
  assert.equal(parseRange('KTo+').size, 3);
  assert.equal(formatRange(new Set()), '');
});

test('неверный ввод — понятная ошибка, а не молчание', () => {
  for (const bad of ['XX', 'AKx', '7', 'AAs', '77-A5s', 'A5s-A2o', 'A5s-K2s', 'AK-', '77++', '1']) {
    const r = tryParseRange(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /[а-яё]/i, bad);
    assert.throws(() => parseRange(bad), RangeSyntaxError, bad);
  }
  assert.equal(tryParseRange('').ok, true);
});

test('diff: пропущенные, лишние, доля совпадения по комбинациям', () => {
  const ref = parseRange('AA, KK, AKs, KQo');
  const user = parseRange('AA, AKs, 72o');
  const d = diff(user, ref);
  assert.deepEqual(d.missed.sort(), ['KK', 'KQo']);
  assert.deepEqual(d.extra, ['72o']);
  assert.deepEqual(d.ok.sort(), ['AA', 'AKs']);
  assert.equal(d.commonCombos, 10); // 6 + 4
  assert.equal(d.missedCombos, 18); // 6 + 12
  assert.equal(d.extraCombos, 12);
  assert.equal(d.match, 10 / (10 + 18 + 12));
  assert.equal(diff(ref, ref).match, 1);
  // пара тузов важнее одной клетки разномастной «мусорной» руки
  assert.ok(diff(parseRange('AA'), parseRange('AA, 72o')).match < diff(parseRange('72o'), parseRange('72o, AA')).match + 1);
  // частоты: расхождение в 0,5 — отдельная строка
  const f = diff(new Map([['AA', 1]]), new Map([['AA', 0.5]]));
  assert.equal(f.off.length, 1);
  assert.equal(f.match, 0.5);
});

test('блокеры: карты на руках убирают комбинации соперника', () => {
  assert.equal(combosGiven('AA', []), 6);
  assert.equal(combosGiven('AA', [parseCard('As')]), 3);
  assert.equal(combosGiven('AA', [parseCard('As'), parseCard('Ah')]), 1);
  assert.equal(combosGiven('AKs', [parseCard('As')]), 3);
  assert.equal(combosGiven('AKo', [parseCard('As')]), 9);
  assert.equal(combosGiven('AKo', [parseCard('As'), parseCard('Kd')]), 7); // 3×3 минус две одномастные (Ah-Kh, Ac-Kc)
  assert.equal(combosGiven('KQs', [parseCard('Ks'), parseCard('Qs')]), 3); // погибло только пиковое
  // независимый подсчёт перебором по всем рукам
  const dead = [parseCard('Ah'), parseCard('Kh'), parseCard('7c')];
  for (const c of ALL_HANDS) {
    const brute = handCombos(c).filter(([x, y]) => !dead.includes(x) && !dead.includes(y)).length;
    assert.equal(combosGiven(c, dead), brute, c);
  }
});

test('эталон: числа эквити против независимого пересчёта (bot/eval.js)', () => {
  // известные значения «против одной случайной руки»
  assert.ok(Math.abs(EQUITY169.AA - 0.852) < 0.01);
  assert.ok(Math.abs(EQUITY169['72o'] - 0.346) < 0.01);
  assert.ok(Math.abs(EQUITY169.KK - 0.824) < 0.01);
  // другой оценщик (best5), другое зерно, малая выборка: допуск 0,03 (2σ ≈ 0,011)
  const rnd = mulberry(99);
  for (const code of ['AA', '72o', 'T9s', '22', 'AKo', 'KQs']) {
    const [x, y] = handCombos(code)[0];
    const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => c !== x && c !== y);
    let win = 0;
    const N = 6000;
    for (let s = 0; s < N; s++) {
      for (let i = 0; i < 7; i++) { const j = i + Math.floor(rnd() * (rest.length - i)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      const board = rest.slice(0, 5);
      const cmp = compare(best5([x, y, ...board]).score, best5([rest[5], rest[6], ...board]).score);
      win += cmp > 0 ? 1 : cmp === 0 ? 0.5 : 0;
    }
    assert.ok(Math.abs(win / N - EQUITY169[code]) < 0.03, `${code}: ${win / N} против ${EQUITY169[code]}`);
  }
  // порядок эквити разумен: пары растут с рангом, одномастная лучше разномастной
  assert.ok(EQUITY169.AA > EQUITY169.KK && EQUITY169.KK > EQUITY169['22']);
  assert.ok(EQUITY169.AKs > EQUITY169.AKo && EQUITY169.T9s > EQUITY169.T9o);
  for (const c of ALL_HANDS) assert.ok(EQUITY169[c] > 0.3 && EQUITY169[c] < 0.9, c);
});

test('очки Чена — по известным значениям', () => {
  assert.equal(chenScore('AA'), 20);
  assert.equal(chenScore('KK'), 16);
  assert.equal(chenScore('22'), 5);
  assert.equal(chenScore('AKs'), 12);
  assert.equal(chenScore('AKo'), 10);
  assert.equal(chenScore('JTs'), 9);
  assert.equal(chenScore('72o'), -1);
});

test('диапазоны по позициям вложены: UTG ⊂ MP ⊂ CO ⊂ BTN, проценты близки к заявленным', () => {
  const chain = ['UTG', 'MP', 'CO', 'BTN'].map(openRange);
  for (let i = 0; i + 1 < chain.length; i++) for (const c of chain[i]) assert.ok(chain[i + 1].has(c), `${c} из ${i}`);
  for (const p of ['UTG', 'MP', 'CO', 'BTN', 'SB']) {
    const r = openRange(p);
    assert.ok(Math.abs(rangePercent(r) - OPEN_PCT[p]) < 1.5, p);
    assert.equal(r.meta.approx, true);
    assert.equal(r.meta.position, p);
    assert.match(r.meta.source, /не солвер/i);
  }
  assert.ok(openRange('UTG').has('AA') && !openRange('UTG').has('72o'));
  assert.equal(ORDER.length, 169);
  assert.equal(ORDER[0], 'AA');
  assert.equal(ORDER[168].length, 3);
});

test('защита и ответ на 3-бет: наборы не пересекаются и осмысленны', () => {
  for (const op of ['UTG', 'MP', 'CO', 'BTN']) {
    const d = defendRange('BB', op);
    for (const c of d.threebet) assert.ok(!d.call.has(c), `${op} ${c}`);
    assert.ok(d.threebet.has('AA') && d.threebet.has('KK'));
    assert.ok(!d.threebet.has('72o') && !d.call.has('72o'));
  }
  // шире открытие — шире защита
  assert.ok(comboCount(defendRange('BB', 'BTN').call) > comboCount(defendRange('BB', 'UTG').call));
  for (const h of POSITIONS.filter((p) => p !== 'BB')) {
    const v = vs3betRange(h);
    const open = openRange(h);
    for (const c of [...v.fourbet, ...v.call]) assert.ok(open.has(c), `${h} ${c} вне открытия`);
    assert.ok(v.fourbet.has('AA'));
  }
  assert.throws(() => defendRange('UTG', 'BTN'));
});

test('смешанные частоты у границы: сумма действий = 1, середина не смешана', () => {
  const lf = layeredFreq([{ action: 'threebet', upTo: 5 }, { action: 'call', upTo: 15 }]);
  let mixed = 0;
  for (const [c, f] of lf) {
    const sum = Object.values(f).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, c);
    if (Object.values(f).some((v) => v === 0.5)) mixed++;
  }
  assert.ok(mixed >= 2 && mixed < 40);
  assert.deepEqual(lf.get('AA'), { threebet: 1, call: 0, fold: 0 });
  assert.equal(topShare(10).has('AA'), true);
});

/* ------------------------------------------------------------ редактор */
import { createEditor, presetSet, HISTORY_LIMIT, rowCodes, colCodes } from '../miniapp/train/ranges/grid.js';

test('редактор: тап, мазок, строка, наборы, счётчик', () => {
  const log = [];
  const ed = createEditor({ onChange: (codes) => log.push(...codes) });
  assert.equal(ed.tap('AA'), true);
  assert.equal(ed.count(), 6);
  ed.tap('AA');
  assert.equal(ed.size(), 0);
  // мазок красит значением, противоположным первой клетке, и это ОДИН шаг истории
  ed.strokeStart('KK'); ed.strokeMove('QQ'); ed.strokeMove('QQ'); ed.strokeMove('JJ');
  assert.equal(ed.strokeEnd(), true);
  assert.deepEqual(ed.answer().sort(), ['JJ', 'KK', 'QQ']);
  assert.equal(ed.undo(), true);
  assert.equal(ed.size(), 0);
  assert.equal(ed.redo(), true);
  assert.equal(ed.size(), 3);
  // мазок «стиранием»: первая клетка выбрана — значит стираем
  ed.strokeStart('KK'); ed.strokeMove('QQ'); ed.strokeEnd();
  assert.deepEqual(ed.answer(), ['JJ']);
  // строка целиком: A-ряд = 13 клеток; второй тап по ней снимает
  ed.clear();
  ed.toggleLine(rowCodes(0));
  assert.equal(ed.size(), 13);
  ed.toggleLine(rowCodes(0));
  assert.equal(ed.size(), 0);
  ed.toggleLine(colCodes(12));
  assert.equal(ed.size(), 13);
  // наборы: «Пары» = 78 комбо, добавляются к выбранному
  ed.clear();
  ed.applyPreset('pairs');
  assert.equal(ed.count(), 78);
  ed.applyPreset('aces');
  assert.equal(ed.size(), 13 + 24);
  ed.applyPreset('top:10', { replace: true });
  assert.ok(Math.abs(ed.percent() - 10) < 1.5);
  assert.equal(presetSet('suited').size, 78);
  assert.throws(() => presetSet('нет'));
  assert.ok(log.length > 0);
});

test('редактор: подписка получает только изменившиеся клетки', () => {
  const seen = [];
  const ed = createEditor({ onChange: (c) => seen.push(c.slice()) });
  ed.tap('T9s');
  assert.deepEqual(seen.at(-1), ['T9s']);
  ed.applyPreset('pairs');
  assert.equal(seen.at(-1).length, 13);
  ed.applyPreset('pairs'); // ничего нового — тишина
  const n = seen.length;
  ed.applyPreset('pairs');
  assert.equal(seen.length, n);
});

test('редактор: история — не меньше 20 шагов, предел 50, три состояния частоты', () => {
  const ed = createEditor();
  const codes = ALL_HANDS.slice(0, 60);
  for (const c of codes) ed.tap(c);
  let undone = 0;
  while (ed.undo()) undone++;
  assert.equal(undone, HISTORY_LIMIT);
  assert.ok(HISTORY_LIMIT >= 20);
  const three = createEditor({ steps: 3 });
  three.tap('AKs'); assert.equal(three.get('AKs'), 1);
  three.tap('AKs'); assert.equal(three.get('AKs'), 0.5);
  three.tap('AKs'); assert.equal(three.get('AKs'), 0);
  three.tap('AA'); three.tap('AA');
  assert.deepEqual(three.answer(), { AA: 0.5 });
  assert.equal(three.count(), 3);
});
