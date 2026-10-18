'use strict';
/**
 * Нарды за столом (games/nardy/rules.js): жребий первого хода, бросок,
 * шаги, «Готово», отмена шага, пропуск хода, конец партии, часы, сохранение.
 * Главное — честность кубиков: числа даёт только сервер (`opts.dice`),
 * бросить можно раз за ход, бросок переживает сохранение и загрузку.
 *
 * Играют: Иван (id 1, хост, белые) и Макс (id 2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as N from './games/nardy/rules.js';
import { abs, idx, startPosition } from './games/nardy/board.js';

const IVAN = { id: 1, name: 'Иван' };
const MAX = { id: 2, name: 'Макс' };
const T0 = 1_000_000;

/** Кубики по списку: [[5,3],[6,6],…] — по паре на бросок. */
const queue = (pairs) => {
  const q = pairs.slice();
  return () => {
    if (!q.length) throw new Error('кубики в тесте кончились');
    return q.shift();
  };
};

function table({ base = 600, start = [[5, 3]], side = 'white' } = {}) {
  const room = N.createRoom({ chatId: -1, host: IVAN, base, side });
  N.addPlayer(room, MAX);
  assert.ok(N.startGame(room, '1', { dice: queue(start) }).ok);
  return room;
}
const idOf = (room, c) => (c === 'w' ? room.match.white : room.match.black);
const moverId = (room) => idOf(room, room.match.turn.c);
const head = (c) => abs(c, 0);

/** Сыграть шаги по индексам пути (с какого индекса, на какое число). */
function play(room, list, now = T0) {
  for (const [i, die] of list) {
    const c = room.match.turn.c;
    const r = N.move(room, moverId(room), { from: abs(c, i), die }, now);
    assert.ok(r.ok, `${c} ${i}+${die}: ${r.error}`);
  }
}

test('жребий первого хода: по кости каждому, равные — заново; больший ходит этими двумя числами', () => {
  const room = table({ start: [[4, 4], [2, 2], [3, 6]] });
  const m = room.match;
  assert.equal(m.first, 'b', 'у чёрных 6 против 3');
  assert.equal(m.turn.c, 'b');
  assert.deepEqual(m.turn.dice, [3, 6], 'первый ход — числами жребия, бросать не нужно');
  assert.equal(N.turnState(m).phase, 'move');
  assert.deepEqual(m.rolls, [{ c: null, start: { w: 3, b: 6 } }], 'в истории — жребий');
  assert.match(room.notice, /Жребий: белые 3, чёрные 6 — первым ходит Макс/);
});

test('ходит только тот, чей ход; зритель и соперник — отказ; бросить до своего хода нельзя', () => {
  const room = table();
  assert.equal(N.move(room, '2', { from: head('b'), die: 5 }, T0).error, 'NOT_YOUR_TURN');
  assert.equal(N.move(room, '3', { from: head('w'), die: 5 }, T0).error, 'NOT_IN_GAME');
  assert.equal(N.roll(room, '2', T0, { dice: () => [6, 6] }).error, 'NOT_YOUR_TURN');
  assert.equal(room.match.turn.dice.join(), '5,3', 'кубики те же');
});

test('шаг: число, которого нет, — отказ; с головы вторая — отказ; потом «Готово»', () => {
  const room = table();
  assert.equal(N.move(room, '1', { from: head('w'), die: 6 }, T0).error, 'NO_SUCH_DIE');
  play(room, [[0, 5]]);
  assert.equal(N.move(room, '1', { from: head('w'), die: 3 }, T0).error, 'HEAD_ONCE');
  assert.equal(N.endTurn(room, '1', T0).error, 'MOVES_LEFT', 'не всё сыграно');
  play(room, [[5, 3]]);
  assert.equal(N.turnState(room.match).phase, 'done');
  assert.equal(N.move(room, '1', { from: abs('w', 8), die: 1 }, T0).error, 'TURN_DONE');
  assert.ok(N.endTurn(room, '1', T0).ok);
  assert.equal(room.match.turn.c, 'b');
  assert.equal(room.match.turn.dice, null, 'чёрным — бросать');
  assert.deepEqual(room.match.log[0].notation, ['24/19', '19/16']);
});

test('отмена шага до «Готово»: позиция как в начале хода; после «Готово» — нельзя', () => {
  const room = table();
  play(room, [[0, 5]]);
  assert.ok(N.undo(room, '1', T0).ok);
  assert.deepEqual(room.match.pos.b, startPosition().b);
  assert.equal(N.undo(room, '1', T0).error, 'NOTHING_TO_UNDO');
  play(room, [[0, 3], [3, 5]]);
  N.endTurn(room, '1', T0);
  assert.equal(N.undo(room, '1', T0).error, 'NOT_YOUR_TURN');
});

test('бросок — только сервер и один раз за ход', () => {
  const room = table();
  play(room, [[0, 5], [5, 3]]);
  N.endTurn(room, '1', T0);
  assert.equal(N.move(room, '2', { from: head('b'), die: 4 }, T0).error, 'ROLL_FIRST');
  const r = N.roll(room, '2', T0, { dice: () => [4, 2] });
  assert.deepEqual(r.dice, [4, 2]);
  assert.equal(N.roll(room, '2', T0, { dice: () => [6, 6] }).error, 'ALREADY_ROLLED', 'перебросить нельзя');
  assert.deepEqual(room.match.turn.dice, [4, 2]);
  assert.deepEqual(room.match.rolls.at(-1), { c: 'b', dice: [4, 2] }, 'бросок в истории');
});

test('кубики только 1…6: испорченная подмена не проходит', () => {
  const room = table();
  play(room, [[0, 5], [5, 3]]);
  N.endTurn(room, '1', T0);
  for (const bad of [[0, 3], [7, 1], [2.5, 3], ['6', 6], [6]]) {
    assert.throws(() => N.roll(room, '2', T0, { dice: () => bad }), /кубики/);
  }
  assert.equal(room.match.turn.dice, null);
});

test('первый ход второго игрока: 6-6 — с головы две шашки (п. 20.3); у первого игрока — одна', () => {
  const room = table(); // белые первыми (5 против 3)
  play(room, [[0, 5], [5, 3]]);
  N.endTurn(room, '1', T0);
  N.roll(room, '2', T0, { dice: () => [6, 6] });
  assert.equal(room.match.turn.headLimit, 2);
  play(room, [[0, 6], [0, 6]]);
  assert.equal(N.turnState(room.match).phase, 'done', 'дальше 6 не сыграть: 12-й — голова белых');
  N.endTurn(room, '2', T0);
  // Следующий дубль 6-6 у чёрных — уже не первый ход: одна с головы.
  N.roll(room, '1', T0, { dice: () => [2, 1] });
  play(room, [[8, 2], [0, 1]]);
  N.endTurn(room, '1', T0);
  N.roll(room, '2', T0, { dice: () => [6, 6] });
  assert.equal(room.match.turn.headLimit, 1);
});

test('нет ни одного хода — ход переходит сам, бросок записан', () => {
  const room = table();
  play(room, [[0, 5], [5, 3]]);
  N.endTurn(room, '1', T0);
  // Чёрным 6-6 не на первом ходу… здесь первый — сделаем его невозможным: голова белых на 12-м.
  room.match.turns.b = 1; // не первый ход чёрных — исключения нет
  const r = N.roll(room, '2', T0, { dice: () => [6, 6] });
  assert.equal(r.passed, undefined, 'одну шашку 6 сыграть можно — это ход');
  // Позиция, где чёрным ходить некуда: все пункты впереди заняты белыми.
  const room2 = table();
  play(room2, [[0, 5], [5, 3]]);
  N.endTurn(room2, '1', T0);
  const b = Array(24).fill(0);
  b[head('b')] = -15;
  for (let i = 1; i <= 6; i++) b[abs('b', i)] = 2; // белые на шести пунктах сразу за головой чёрных
  b[head('w')] = 3;
  room2.match.pos.b = b;
  room2.match.turn.start = { ...room2.match.pos };
  const r2 = N.roll(room2, '2', T0, { dice: () => [3, 2] });
  assert.ok(r2.passed);
  assert.equal(room2.match.turn.c, 'w', 'ход перешёл');
  assert.equal(room2.match.log.at(-1).auto, true);
  assert.match(room2.notice, /ходов нет/);
});

test('конец: снял последнюю — победа; соперник не снял ни одной — марс (просто победа)', () => {
  const room = table();
  const b = Array(24).fill(0);
  b[abs('w', 23)] = 1;
  b[head('b')] = -15;
  room.match.pos = { b, off: { w: 14, b: 0 }, t: 'w' };
  room.match.turn.start = { ...room.match.pos };
  room.match.turn.dice = [1, 2];
  room.match.log.push({}, {}); // не первые ходы
  // Снять можно и 1, и 2, но сыграть только одно — значит, большее (п. 26.6.3).
  assert.equal(N.move(room, '1', { from: abs('w', 23), die: 1 }, T0).error, 'BAD_STEP');
  play(room, [[23, 2]]);
  assert.deepEqual(room.match.over, { winner: 'w', kind: 'mars', mars: true });
  assert.equal(room.history.at(-1).winner, '1');
  assert.match(room.notice, /Иван выиграл: марс/);
});

test('часы: флажок упал — проиграл тот, чей ход; первый ход не сделан — партия отменена', () => {
  const room = table({ base: 180 });
  play(room, [[0, 5], [5, 3]]);
  N.endTurn(room, '1', T0);
  N.roll(room, '2', T0, { dice: () => [4, 2] });
  play(room, [[0, 4], [4, 2]]);
  N.endTurn(room, '2', T0);
  const t = N.syncTurn(room, T0);
  assert.equal(N.timeoutMove(room, t.key, T0 + 179_000).error, 'EARLY');
  assert.ok(N.timeoutMove(room, t.key, T0 + 180_000).ok);
  assert.deepEqual(room.match.over, { winner: 'b', kind: 'time', mars: false });
  const early = table();
  const t2 = N.syncTurn(early, T0);
  assert.ok(N.timeoutMove(early, t2.key, T0 + N.FIRST_MS).ok);
  assert.equal(early.match.over.kind, 'aborted');
});

test('ключ часов — на ход целиком: шаги внутри хода часы не перезаводят', () => {
  const room = table({ base: 180 });
  const k = N.syncTurn(room, T0).key;
  play(room, [[0, 5]]);
  assert.equal(N.syncTurn(room, T0).key, k);
  play(room, [[5, 3]]);
  N.endTurn(room, '1', T0);
  assert.notEqual(N.syncTurn(room, T0).key, k);
});

test('сдаться можно после первых ходов; ничьей нет — победа сопернику', () => {
  const room = table();
  assert.equal(N.resign(room, '1', T0).error, 'TOO_EARLY');
  play(room, [[0, 5], [5, 3]]);
  N.endTurn(room, '1', T0);
  N.roll(room, '2', T0, { dice: () => [4, 2] });
  play(room, [[0, 4], [4, 2]]);
  N.endTurn(room, '2', T0);
  assert.ok(N.resign(room, '1', T0).ok);
  assert.equal(room.match.over.winner, 'b');
});

test('сохранение и загрузка: выпавшие кубики и сыгранные шаги на месте — перебросить нельзя', () => {
  const room = table({ base: 300 });
  play(room, [[0, 5], [5, 3]]);
  N.endTurn(room, '1', T0);
  N.roll(room, '2', T0, { dice: () => [6, 1] });
  play(room, [[0, 6]]);
  N.syncTurn(room, T0);
  const back = N.deserialize(JSON.parse(JSON.stringify(N.serialize(room, T0 + 5_000))));
  assert.deepEqual(back.match.turn.dice, [6, 1]);
  assert.equal(back.match.turn.played.length, 1);
  assert.equal(N.roll(back, '2', T0, { dice: () => [6, 6] }).error, 'ALREADY_ROLLED');
  assert.equal(back.turn.deadline, null);
  // И доиграть ход после загрузки можно — тем же числом, что осталось.
  assert.ok(N.move(back, '2', { from: abs('b', 6), die: 1 }, T0).ok);
  assert.equal(idx('b', back.match.turn.played[1].to), 7);
});

test('следующая партия: цвета меняются, жребий заново', () => {
  const room = table();
  room.match.log.push({}, {});
  N.resign(room, '2', T0);
  assert.ok(N.nextGame(room, '1', { dice: queue([[2, 5]]) }).ok);
  assert.equal(room.match.white, '2');
  assert.equal(room.match.first, 'b');
  assert.equal(N.score(room).find((s) => s.id === '1').wins, 1);
});

test('настоящие кубики: 60.000 бросков — все 21 сочетание с ожидаемой частотой (хи-квадрат с запасом)', () => {
  const N_ROLLS = 60_000;
  const seen = new Map();
  const faces = Array(7).fill(0);
  for (let i = 0; i < N_ROLLS; i++) {
    const [a, b] = N.realDice();
    faces[a] += 1;
    faces[b] += 1;
    const k = a <= b ? `${a}${b}` : `${b}${a}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  assert.equal(seen.size, 21, 'выпали все 21 сочетание');
  let chi = 0;
  for (const [k, n] of seen) {
    const expected = N_ROLLS * (k[0] === k[1] ? 1 : 2) / 36;
    chi += (n - expected) ** 2 / expected;
  }
  // 20 степеней свободы: 45,3 — порог для p = 0,001. С запасом — 60: честные
  // кубики за него не выходят практически никогда, кривые (одна грань чуть
  // чаще) — выходят сразу.
  assert.ok(chi < 60, `хи-квадрат по сочетаниям ${chi.toFixed(1)}`);
  let chiF = 0;
  for (let f = 1; f <= 6; f++) chiF += (faces[f] - N_ROLLS / 3) ** 2 / (N_ROLLS / 3);
  assert.ok(chiF < 30, `хи-квадрат по граням ${chiF.toFixed(1)} (5 степеней свободы, порог p = 0,001 — 20,5)`);
});
