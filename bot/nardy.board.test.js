'use strict';
/**
 * Доска длинных нард (games/nardy/board.js): ходы и последовательности хода.
 *
 * Опубликованных чисел перебора для длинных нард нет (как perft у шахмат и
 * шашек), поэтому сверка — с медленным генератором, написанным здесь заново и
 * иначе: путь у каждого свой массив, соперник — своим массивом, итог хода —
 * готовая позиция. На тысячах случайных позиций (и из партий, и
 * синтетических — со снятием и блоками) оба дают одно и то же множество
 * позиций после хода и одно и то же «сколько чисел можно сыграть».
 * Плюс каждое правило — отдельным примером.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startPosition, steps, apply, sequences, nextSteps, locksAll, allHome, idx, abs, pointNo, winner, key, pips, stepText, clone,
} from './games/nardy/board.js';
import { seededRng } from './deck.js';

/** Позиция из описания: { w: { индекс пути: шашек }, b: {...}, off, t }. */
function pos({ w = {}, b = {}, off = { w: 0, b: 0 }, t = 'w' }) {
  const arr = Array(24).fill(0);
  for (const [i, n] of Object.entries(w)) arr[abs('w', Number(i))] += n;
  for (const [i, n] of Object.entries(b)) arr[abs('b', Number(i))] -= n;
  return { b: arr, off: { ...off }, t };
}
const finals = (p, dice, o) => new Set(sequences(p, dice, o).seqs.map((s) => key(s.reduce((q, x) => apply(q, x), p))));

/* ------------------------------------------------ медленный генератор */

function slowFinals(p, dice, headLimit = 1) {
  const c = p.t;
  const o = c === 'w' ? 'b' : 'w';
  // Свой путь и путь соперника — каждый своим массивом по своим индексам.
  const me = Array(24).fill(0);
  const op = Array(24).fill(0);
  for (let a = 0; a < 24; a++) {
    if (p.b[a] * (c === 'w' ? 1 : -1) > 0) me[c === 'w' ? a : (a + 12) % 24] = Math.abs(p.b[a]);
    if (p.b[a] * (c === 'w' ? 1 : -1) < 0) op[o === 'w' ? a : (a + 12) % 24] = Math.abs(p.b[a]);
  }
  const theirOff = p.off[o];
  // Мой индекс i — это индекс соперника (i + 12) % 24, и наоборот.
  const blocked = (i) => op[(i + 12) % 24] > 0;
  const locks = (m) => {
    if (theirOff > 0) return false;
    for (let j = 0; j + 5 < 24; j++) {
      let all = true;
      for (let k = j; k < j + 6; k++) if (!m[(k + 12) % 24]) all = false;
      if (!all) continue;
      let passed = false;
      for (let k = j + 6; k < 24; k++) if (op[k]) passed = true;
      if (!passed) return true;
    }
    return false;
  };
  /** Все концы хода при этих числах: ключ позиции → сколько чисел сыграно. */
  const explore = (list) => {
    const results = new Map();
    const go = (m, off, left, head) => {
      let any = false;
      const seen = new Set();
      for (let n = 0; n < left.length; n++) {
        if (seen.has(left[n])) continue;
        seen.add(left[n]);
        const die = left[n];
        const home = m.every((x, i) => !x || i >= 18);
        const far = m.findIndex((x) => x > 0);
        for (let i = 0; i < 24; i++) {
          if (!m[i]) continue;
          if (i === 0 && head >= headLimit) continue;
          const j = i + die;
          let to = null;
          if (j < 24) { if (!blocked(j)) to = j; } else if (home && (j === 24 || i === far)) to = 24;
          if (to === null) continue;
          const m2 = m.slice();
          m2[i] -= 1;
          if (to < 24) m2[to] += 1;
          if (locks(m2)) continue;
          any = true;
          go(m2, off + (to === 24 ? 1 : 0), left.slice(0, n).concat(left.slice(n + 1)), head + (i === 0 ? 1 : 0));
        }
      }
      if (!any) {
        const b = Array(24).fill(0);
        for (let i = 0; i < 24; i++) {
          b[c === 'w' ? i : (i + 12) % 24] += m[i] * (c === 'w' ? 1 : -1);
          b[o === 'w' ? i : (i + 12) % 24] += op[i] * (o === 'w' ? 1 : -1);
        }
        const k = key({ b, off: { ...p.off, [c]: off }, t: c });
        results.set(k, Math.max(results.get(k) ?? 0, list.length - left.length));
      }
    };
    go(me, p.off[c], list, 0);
    return results;
  };
  const all = explore(dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : [dice[0], dice[1]]);
  const max = Math.max(...all.values());
  let keep = [...all].filter(([, u]) => u === max).map(([k]) => k);
  if (max === 1 && dice[0] !== dice[1]) {
    // Только одно число — большее, если его вообще можно сыграть само по себе.
    const big = [...explore([Math.max(...dice)])].filter(([, u]) => u === 1).map(([k]) => k);
    if (big.length) keep = big;
  }
  return { finals: new Set(keep), max };
}

/** Случайная позиция: синтетика — по 15 шашек, не на чужих пунктах, иногда все дома и часть снята. */
function randomPosition(rnd) {
  const b = Array(24).fill(0);
  const off = { w: 0, b: 0 };
  for (const c of ['w', 'b']) {
    const homeOnly = rnd() < 0.3;
    off[c] = homeOnly ? Math.floor(rnd() * 10) : 0;
    for (let n = 0; n < 15 - off[c]; n++) {
      for (let tries = 0; tries < 50; tries++) {
        const i = homeOnly ? 18 + Math.floor(rnd() * 6) : Math.floor(rnd() * 24);
        const a = abs(c, i);
        if (b[a] * (c === 'w' ? 1 : -1) < 0) continue;
        b[a] += c === 'w' ? 1 : -1;
        break;
      }
    }
  }
  off.w = 15 - b.reduce((s, x) => s + Math.max(0, x), 0);
  off.b = 15 - b.reduce((s, x) => s + Math.max(0, -x), 0);
  return { b, off, t: rnd() < 0.5 ? 'w' : 'b' };
}

test('медленный генератор и board.js: одни и те же позиции после хода на 3000 позиций из партий и синтетики', () => {
  const int = seededRng(2026);
  const rnd = () => int(1_000_000) / 1_000_000;
  let checked = 0;
  let doubles = 0;
  let bearing = 0;
  let partial = 0;
  // Позиции из случайных партий.
  for (let g = 0; g < 60; g++) {
    let p = startPosition();
    for (let turn = 0; turn < 120 && !winner(p); turn++) {
      const dice = [1 + Math.floor(rnd() * 6), 1 + Math.floor(rnd() * 6)];
      const fast = sequences(p, dice);
      const slow = slowFinals(p, dice);
      assert.equal(fast.max, slow.max, `max ${key(p)} ${dice}`);
      assert.deepEqual(finals(p, dice), slow.finals, `позиции ${key(p)} ${dice}`);
      checked += 1;
      if (dice[0] === dice[1]) doubles += 1;
      if (allHome(p, p.t)) bearing += 1;
      if (fast.max < (dice[0] === dice[1] ? 4 : 2)) partial += 1;
      const seq = fast.seqs[Math.floor(rnd() * fast.seqs.length)];
      p = seq.reduce((q, s) => apply(q, s), p);
      p = { ...p, t: p.t === 'w' ? 'b' : 'w' };
    }
  }
  // Синтетика: снятие, блоки, перегруженные пункты.
  while (checked < 3000) {
    const p = randomPosition(rnd);
    const dice = [1 + Math.floor(rnd() * 6), 1 + Math.floor(rnd() * 6)];
    const slow = slowFinals(p, dice);
    assert.equal(sequences(p, dice).max, slow.max, `max ${key(p)} ${dice}`);
    assert.deepEqual(finals(p, dice), slow.finals, `позиции ${key(p)} ${dice}`);
    checked += 1;
    if (allHome(p, p.t)) bearing += 1;
  }
  assert.ok(doubles > 100 && bearing > 300 && partial > 20, `разнообразие: дублей ${doubles}, снятие ${bearing}, неполных ходов ${partial}`);
});

/* ------------------------------------------------------------- правила */

test('начало: по 15 шашек на голове, головы друг напротив друга; номера общие — голова белых 1, голова чёрных 13', () => {
  const p = startPosition();
  assert.equal(p.b[abs('w', 0)], 15);
  assert.equal(p.b[abs('b', 0)], -15);
  assert.equal(abs('b', 0), 12, 'голова чёрных — напротив головы белых');
  assert.equal(pointNo('w', abs('w', 0)), 1, 'голова белых — 1');
  assert.equal(pointNo('b', abs('b', 0)), 13, 'голова чёрных — 13');
  assert.equal(pointNo('w', abs('w', 23)), 24, 'последний пункт дома белых — 24');
  assert.equal(pointNo('b', abs('b', 23)), 12, 'последний пункт дома чёрных — 12');
  assert.equal(pointNo('w', 5), pointNo('b', 5), 'номер не зависит от того, кто смотрит');
  assert.equal(pips(p, 'w'), 15 * 24);
});

test('с головы за ход — одна шашка: 6-5 играется одной шашкой (6 и ещё 5)', () => {
  const p = startPosition();
  const { seqs, max } = sequences(p, [6, 5]);
  assert.equal(max, 2);
  for (const s of seqs) assert.equal(s.filter((x) => idx('w', x.from) === 0).length, 1, 'с головы одна');
  assert.deepEqual([...finals(p, [6, 5])].length, 1, 'единственный ход: с головы 1/12 одной шашкой');
});

test('дубль — четыре хода; с головы всё равно одна: 2-2 с начала — одна шашка идёт 2+2+2+2', () => {
  const p = startPosition();
  const { max } = sequences(p, [2, 2]);
  assert.equal(max, 4);
  const f = [...finals(p, [2, 2])];
  assert.equal(f.length, 1);
});

test('первый ход второго игрока: 6-6, 4-4, 3-3 — с головы две шашки (п. 20.3); 5-5 и 2-2 — одна', () => {
  const p = { ...startPosition(), t: 'b' };
  // 6-6: одна шашка с головы 6, вторая 6 — дальше 12-й пункт занят головой соперника.
  assert.equal(sequences(p, [6, 6]).max, 1, 'без исключения сыграть можно только одно число');
  assert.equal(sequences(p, [6, 6], { headLimit: 2 }).max, 2, 'с исключением — две шашки по 6');
  assert.equal(sequences(p, [4, 4], { headLimit: 2 }).max, 4);
  assert.equal(sequences(p, [3, 3], { headLimit: 2 }).max, 4);
  for (const s of sequences(p, [4, 4], { headLimit: 2 }).seqs) assert.ok(s.filter((x) => idx('b', x.from) === 0).length <= 2);
});

test('шашка ходит только на свободный или свой пункт: на пункт соперника — нельзя', () => {
  const p = pos({ w: { 0: 14, 3: 1 }, b: { 0: 14, 4: 1 } }); // чёрная на индексе 4 у себя = 16 у белых
  const blocked = abs('w', 16);
  assert.equal(p.b[blocked] < 0, true);
  const s = steps(p, 13);
  assert.ok(!s.some((x) => x.to === blocked), 'с пункта 3 на 16 — занят чёрной');
});

test('надо играть оба числа, если можно; если только одно — то большее', () => {
  // Белая шашка на 16; чёрные стоят на 17 и 22 (индексы белых): 1 не сыграть, 6 — можно, 6+1 — нельзя.
  const p = pos({ w: { 16: 1 }, b: {}, off: { w: 14, b: 0 }, t: 'w' });
  p.b[abs('w', 17)] = -1;
  p.b[abs('w', 23)] = -1;
  p.off.b = 13;
  const r = sequences(p, [6, 1]);
  assert.equal(r.max, 1);
  assert.ok(r.seqs.every((s) => s[0].die === 6), 'только большее');
  // Обычная позиция: два числа — играются оба.
  assert.equal(sequences(startPosition(), [3, 1]).max, 2);
});

test('если сыграть можно только одно из двух, но не большее — играется меньшее', () => {
  // Белая на 20 дома, ещё одна на 10 — не дома: 6 с 10 на 16 занято чёрной, 6 с 20 — снимать нельзя (не все дома).
  const p = pos({ w: { 20: 1, 10: 1 }, off: { w: 13, b: 0 } });
  p.b[abs('w', 16)] = -2;
  p.b[abs('w', 11)] = -2;
  p.b[abs('w', 21)] = -2;
  p.b[abs('b', 0)] = -9;
  const r = sequences(p, [6, 2]);
  assert.equal(r.max, 1);
  assert.ok(r.seqs.every((s) => s[0].die === 2), JSON.stringify(r.seqs));
});

test('шесть подряд, запирающих все 15 шашек соперника, — нельзя, даже посреди хода; если кто-то прошёл — можно', () => {
  // Белые на индексах 2…6 (пять подряд), шашка с 1 идёт на 7 — шестой подряд.
  // По пути чёрных это их пункты 14…19, а все 15 чёрных ещё на голове — позади.
  const before = pos({ w: { 0: 9, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 }, b: { 0: 15 } });
  const six = steps(before, 6).find((s) => idx('w', s.from) === 1 && idx('w', s.to) === 7);
  assert.ok(six, 'шаг сам по себе законный');
  assert.equal(locksAll(apply(before, six), 'w'), true, 'шесть подряд, все чёрные позади');
  const { seqs } = sequences(before, [6, 1]);
  assert.ok(!nextSteps(seqs, []).some((x) => x.from === six.from && x.to === six.to), 'первым шагом его не предлагают');
  // И ни в одной последовательности ни на одном шаге блок не запирает всех («даже в течение одного хода»).
  for (const seq of seqs) {
    let q = before;
    for (const x of seq) {
      q = apply(q, x);
      assert.equal(locksAll(q, 'w'), false, seq.map((y) => stepText('w', y)).join(' '));
    }
  }
  // Сначала 1 (разбить ряд), потом тот же шаг 6 — уже не шесть подряд: так можно.
  assert.ok(seqs.some((sq) => sq[1] && sq[1].from === six.from && sq[1].to === six.to));
  // Одна чёрная шашка уже прошла блок (её пункт 21 — дальше 19) — тот же шаг можно.
  const passed = clone(before);
  passed.b[abs('b', 0)] += 1;
  passed.b[abs('b', 21)] = -1;
  assert.equal(locksAll(apply(passed, six), 'w'), false);
  // Шашка соперника уже снята — тоже можно.
  const gone = clone(before);
  gone.b[abs('b', 0)] += 1;
  gone.off.b = 1;
  assert.equal(locksAll(apply(gone, six), 'w'), false);
});

test('снимать — только когда все 15 дома; точно по числу или большим числом с самого дальнего пункта', () => {
  const notHome = pos({ w: { 22: 14, 10: 1 }, off: { w: 0, b: 0 } });
  assert.ok(!steps(notHome, 2).some((s) => s.to < 0), 'не все дома — не снимают');
  const home = pos({ w: { 22: 3, 20: 2 }, off: { w: 10, b: 0 } });
  // 2 с индекса 22 (2-й пункт) — снять точно; 6 — с самого дальнего (20, 4-й пункт).
  assert.ok(steps(home, 2).some((s) => idx('w', s.from) === 22 && s.to < 0));
  const six = steps(home, 6).filter((s) => s.to < 0);
  assert.deepEqual(six.map((s) => idx('w', s.from)), [20], 'большим числом — только с самого дальнего');
  // Можно и не снимать, а ходить внутри дома (п. 27.3).
  assert.ok(steps(home, 1).some((s) => s.to >= 0));
});

test('в середине хода последняя шашка пришла домой — этим же ходом можно снимать', () => {
  const p = pos({ w: { 22: 14, 15: 1 }, off: { w: 0, b: 0 } });
  const r = sequences(p, [3, 2]);
  // 15 → 18 (дома), потом 2 снимает с 22.
  assert.ok(r.seqs.some((s) => s[1]?.to < 0), 'после прихода домой — снятие');
});

test('конец: снял все 15 — победа; запись шагов — общими номерами пунктов', () => {
  const p = pos({ w: { 23: 1 }, off: { w: 14, b: 0 } });
  const s = steps(p, 1)[0];
  assert.equal(winner(apply(p, s)), 'w');
  assert.equal(stepText('w', s), '24/⤓');
  assert.equal(stepText('w', { from: abs('w', 0), to: abs('w', 6), die: 6 }), '1/7');
  assert.equal(stepText('b', { from: abs('b', 0), to: abs('b', 6), die: 6 }), '13/19', 'у чёрных голова — 13');
});

test('шаги продолжения: после сыгранного — только то, что ведёт к полному ходу', () => {
  const p = startPosition();
  const { seqs } = sequences(p, [6, 5]);
  const first = nextSteps(seqs, []);
  assert.equal(first.length, 2, 'голова: 6 или 5');
  const after = nextSteps(seqs, [first[0]]);
  assert.equal(after.length, 1, 'дальше — тем же, с головы нельзя');
  assert.equal(after[0].from, first[0].to);
});
