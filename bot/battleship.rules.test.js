'use strict';
/**
 * Морской бой за столом — правила без хаба: расстановка, готовность, жребий,
 * «попал — стреляешь ещё», конец партии, часы, сдача, отмена, серия.
 * Приватность и «никто за другого» — через хаб (battleship.test.js).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from './games/battleship/rules.js';
import { shipCells, cellOf, randomFleet, checkFleet } from './games/battleship/board.js';
import { botRandom } from './harness.js';
import { ROWS, COLS } from './battleship.fixtures.js';

const IVAN = { id: 101, name: 'Иван' };
const MAX = { id: 202, name: 'Макс' };
const T0 = 1_000_000;

/** Стол на двоих, партия начата. `first` — кто стреляет первым (0 — хост). */
function table({ base = 0, inc = 0, first = 0 } = {}) {
  const room = B.createRoom({ chatId: -1, host: IVAN, base, inc });
  B.addPlayer(room, MAX);
  assert.ok(B.startGame(room, '101', { rand: () => (first === 0 ? 0.1 : 0.9) }).ok);
  return room;
}

/** Оба расставили и готовы: у Ивана ROWS, у Макса COLS. */
function battle(opts = {}, now = T0) {
  const room = table(opts);
  assert.ok(B.place(room, '101', ROWS, now).ok);
  assert.ok(B.place(room, '202', COLS, now).ok);
  assert.ok(B.ready(room, '101', now).ok);
  assert.ok(B.ready(room, '202', now).battle);
  return room;
}

const colsCells = COLS.flatMap(shipCells);
const rowsCells = ROWS.flatMap(shipCells);
/** Клетка, где у флота пусто и которая не рядом ни с чем важным для теста. */
const water = (cellsOfFleet, skip = []) => {
  for (let c = 99; c >= 0; c--) if (!cellsOfFleet.includes(c) && !skip.includes(c)) return c;
  throw new Error('нет воды');
};

test('начало: расстановка, флотов нет ни у кого; кто стреляет первым — жребий, объявят в бою', () => {
  const room = table({ first: 1 });
  const m = room.match;
  assert.equal(m.phase, 'place');
  assert.deepEqual(m.fleets, [null, null]);
  assert.deepEqual(m.ready, [false, false]);
  assert.deepEqual(m.ids, ['101', '202']);
  assert.equal(m.first, 1, 'жребий: rand ≥ 0,5 — второй');
  assert.equal(m.turn, null, 'пока расставляют — ничей ход');
  assert.equal(B.fire(room, '101', 0, T0).error, 'PLACING');
});

test('расстановка: сервер проверяет флот; кривой — отказ, черновик не портится', () => {
  const room = table();
  assert.equal(B.place(room, '101', ROWS.slice(0, 9), T0).error, 'BAD_FLEET');
  assert.equal(room.match.fleets[0], null);
  assert.ok(B.place(room, '101', ROWS, T0).ok);
  const touching = ROWS.map((s, i) => (i === 9 ? { x: 4, y: 1, len: 1, dir: 'h' } : s));
  assert.equal(B.place(room, '101', touching, T0).error, 'SHIPS_TOUCH');
  assert.deepEqual(room.match.fleets[0], checkFleet(ROWS).ships, 'отказ не стёр прежнюю расстановку');
  // Переставить до «Я готов» — можно.
  assert.ok(B.place(room, '101', COLS, T0).ok);
  assert.deepEqual(room.match.fleets[0], checkFleet(COLS).ships);
  // Зритель расставить не может.
  assert.equal(B.place(room, '303', ROWS, T0).error, 'NOT_IN_GAME');
});

test('«Расставить случайно» — расставляет сервер своей случайностью, по правилам', () => {
  const room = table();
  assert.ok(B.placeRandom(room, '202', T0, { fleetRand: botRandom(3) }).ok);
  assert.deepEqual(room.match.fleets[1], randomFleet(botRandom(3)));
  assert.ok(checkFleet(room.match.fleets[1]).ok);
  assert.ok(B.placeRandom(room, '202', T0).ok, 'без подмены — настоящая случайность');
  assert.ok(checkFleet(room.match.fleets[1]).ok);
});

test('«Я готов»: без флота нельзя; после — флот заперт; готовы оба — бой, первым стреляет тот, кому выпал жребий', () => {
  const room = table({ first: 1 });
  assert.equal(B.ready(room, '101', T0).error, 'NO_FLEET');
  B.place(room, '101', ROWS, T0);
  assert.ok(B.ready(room, '101', T0).ok);
  assert.equal(room.match.phase, 'place', 'второй ещё расставляет');
  assert.equal(B.place(room, '101', COLS, T0).error, 'ALREADY_READY');
  assert.equal(B.placeRandom(room, '101', T0).error, 'ALREADY_READY');
  assert.equal(B.ready(room, '101', T0).error, 'ALREADY_READY');
  assert.deepEqual(room.match.fleets[0], checkFleet(ROWS).ships, 'после «готов» расстановка не меняется');
  B.place(room, '202', COLS, T0);
  assert.ok(B.ready(room, '202', T0).battle);
  assert.equal(room.match.phase, 'battle');
  assert.equal(room.match.turn, 1);
  assert.match(room.notice, /первым стреляет Макс/);
  assert.equal(B.place(room, '202', ROWS, T0).error, 'BATTLE_ON');
});

test('выстрел: мимо — ход соперника; попал — стреляешь ещё; не в свой ход и зрителю — нельзя', () => {
  const room = battle();
  assert.equal(B.fire(room, '202', 0, T0).error, 'NOT_YOUR_TURN');
  assert.equal(B.fire(room, '303', 0, T0).error, 'NOT_IN_GAME');
  const hit = colsCells[0];
  assert.equal(B.fire(room, '101', hit, T0).r, 'hit');
  assert.equal(room.match.turn, 0, 'попал — ещё');
  const miss = water(colsCells, [cellOf(1, 0), cellOf(1, 1)]);
  assert.equal(B.fire(room, '101', miss, T0).r, 'miss');
  assert.equal(room.match.turn, 1, 'мимо — ход Макса');
  assert.equal(B.fire(room, '101', 5, T0).error, 'NOT_YOUR_TURN');
  assert.deepEqual(room.match.log, [{ by: 0, c: hit, r: 'hit' }, { by: 0, c: miss, r: 'miss' }]);
});

test('в клетку, куда уже стрелял, — отказ одним и тем же кодом: и где попал, и где мимо', () => {
  const room = battle();
  const hit = colsCells[0];
  B.fire(room, '101', hit, T0);
  assert.equal(B.fire(room, '101', hit, T0).error, 'ALREADY_SHOT');
  const miss = water(colsCells);
  B.fire(room, '101', miss, T0);
  B.fire(room, '202', water(rowsCells), T0);
  assert.equal(B.fire(room, '101', miss, T0).error, 'ALREADY_SHOT');
  for (const bad of [-1, 100, 1.5, 'Б7', null, undefined]) assert.equal(B.fire(room, '101', bad, T0).error, 'BAD_CELL', String(bad));
});

test('убил: корабль открыт; вокруг него стрелять нельзя — там кораблей не бывает', () => {
  const room = battle();
  // У Макса (COLS) однопалубный в А10.
  const single = COLS.find((s) => s.len === 1 && s.x === 0 && s.y === 9);
  assert.ok(single);
  const c = cellOf(0, 9);
  assert.equal(B.fire(room, '101', c, T0).r, 'sunk');
  assert.equal(room.match.turn, 0, 'убил — тоже стреляешь ещё');
  assert.equal(B.fire(room, '101', cellOf(1, 9), T0).error, 'NEAR_SUNK');
  assert.equal(B.fire(room, '101', cellOf(1, 8), T0).error, 'NEAR_SUNK');
  assert.match(room.notice, /Иван: А10 — убил/);
});

test('весь флот потоплен — победа; в истории и в рейтинге — место 1 и 2; ничьей нет', () => {
  const room = battle();
  for (const c of colsCells) {
    const r = B.fire(room, '101', c, T0);
    assert.ok(r.ok, `выстрел ${c}: ${r.error}`);
  }
  assert.deepEqual(room.match.over, { winner: 0, kind: 'fleet' });
  assert.equal(room.match.turn, null);
  assert.equal(B.fire(room, '101', 99, T0).error, 'NOT_PLAYING');
  assert.deepEqual(room.history.at(-1), { no: 1, ids: ['101', '202'], winner: '101', kind: 'fleet', aborted: false, shots: 20 });
  assert.match(room.notice, /Иван выиграл: весь флот соперника потоплен/);
  assert.deepEqual(B.score(room).map((r) => [r.name, r.wins, r.losses]), [['Иван', 1, 0], ['Макс', 0, 1]]);
});

test('сдача — только когда каждый выстрелил; до того — отмена, не засчитывается', () => {
  const room = table();
  assert.equal(B.resign(room, '101', T0).error, 'TOO_EARLY', 'на расстановке не сдаются');
  B.place(room, '101', ROWS, T0);
  B.place(room, '202', COLS, T0);
  B.ready(room, '101', T0);
  B.ready(room, '202', T0);
  B.fire(room, '101', water(colsCells), T0);
  assert.equal(B.resign(room, '202', T0).error, 'TOO_EARLY', 'Макс ещё не стрелял');
  B.fire(room, '202', water(rowsCells), T0);
  assert.equal(B.abortMatch(room, '101', T0).error, 'TOO_LATE');
  assert.ok(B.resign(room, '202', T0).ok);
  assert.deepEqual(room.match.over, { winner: 0, kind: 'resign' });

  const r2 = table();
  assert.equal(B.abortMatch(r2, '303', T0).error, 'NOT_IN_GAME');
  assert.ok(B.abortMatch(r2, '202', T0).ok, 'на расстановке — отменить можно');
  assert.equal(r2.match.over.kind, 'aborted');
  assert.equal(r2.history.at(-1).aborted, true);
});

test('срок расстановки — 2 минуты; не успел — флот расставит сервер (черновик или случайно), и начнётся бой', () => {
  const room = table({ base: 300 });
  B.place(room, '101', ROWS, T0); // черновик, «готов» не нажат
  const t = B.syncTurn(room, T0);
  assert.equal(t.key, '1:place');
  assert.equal(t.deadline, T0 + B.PLACE_MS);
  assert.equal(B.timeoutMove(room, '1:place', T0 + B.PLACE_MS - 1).error, 'EARLY');
  assert.ok(B.timeoutMove(room, '1:place', T0 + B.PLACE_MS, { fleetRand: botRandom(5) }).ok);
  assert.equal(room.match.phase, 'battle');
  assert.deepEqual(room.match.fleets[0], checkFleet(ROWS).ships, 'черновик Ивана — его флот');
  assert.deepEqual(room.match.fleets[1], randomFleet(botRandom(5)), 'Максу — случайный');
  assert.match(room.notice, /Срок расстановки вышел/);
});

test('часы: первый выстрел — минута, не сделан — отмена; дальше банк, прибавка — когда ход переходит', () => {
  const room = battle({ base: 300, inc: 5 });
  let t = B.syncTurn(room, T0);
  assert.equal(t.remaining, B.FIRST_MS);
  assert.ok(B.timeoutMove(room, t.key, T0 + B.FIRST_MS).ok);
  assert.equal(room.match.over.kind, 'aborted');

  const r2 = battle({ base: 300, inc: 5 });
  B.syncTurn(r2, T0);
  B.fire(r2, '101', water(colsCells), T0 + 1000);
  B.syncTurn(r2, T0 + 1000);
  B.fire(r2, '202', rowsCells[0], T0 + 2000); // попал — ещё
  assert.equal(r2.match.clock[1], 300_000, 'первый выстрел каждого — не из банка');
  t = B.syncTurn(r2, T0 + 2000);
  assert.equal(t.remaining, 300_000);
  B.fire(r2, '202', rowsCells[1], T0 + 12_000); // попал — ещё; прибавки нет
  assert.equal(r2.match.clock[1], 290_000);
  B.syncTurn(r2, T0 + 12_000);
  B.fire(r2, '202', water(rowsCells), T0 + 22_000); // мимо — прибавка 5 с
  assert.equal(r2.match.clock[1], 285_000);
  t = B.syncTurn(r2, T0 + 22_000);
  assert.equal(t.remaining, 300_000, 'у Ивана банк цел');
  assert.ok(B.timeoutMove(r2, t.key, T0 + 22_000 + 300_000).ok);
  assert.deepEqual(r2.match.over, { winner: 1, kind: 'time' });
});

test('без часов: после первых выстрелов таймера нет', () => {
  const room = battle({ base: 0 });
  B.fire(room, '101', water(colsCells), T0);
  B.syncTurn(room, T0);
  B.fire(room, '202', water(rowsCells), T0);
  assert.equal(B.syncTurn(room, T0), null);
});

test('следующая партия: флоты прежней не переходят, расставляют заново; стороны меняются', () => {
  const room = battle();
  for (const c of colsCells) B.fire(room, '101', c, T0);
  assert.ok(B.nextGame(room, '202', { rand: () => 0.1 }).ok);
  const m = room.match;
  assert.equal(m.no, 2);
  assert.equal(m.phase, 'place');
  assert.deepEqual(m.fleets, [null, null]);
  assert.deepEqual(m.ready, [false, false]);
  assert.deepEqual(m.ids, ['202', '101']);
  assert.ok(!JSON.stringify(room.history).includes('"len"'), 'в истории партий флотов нет');
});

test('сохранение: обе расстановки и выстрелы на месте, часы — остатком', () => {
  const room = battle({ base: 300 });
  B.fire(room, '101', colsCells[0], T0);
  B.syncTurn(room, T0);
  const back = B.deserialize(B.serialize(room, T0 + 10_000));
  assert.deepEqual(back.match.fleets, room.match.fleets);
  assert.deepEqual(back.match.shots, room.match.shots);
  assert.equal(back.turn.remaining, B.FIRST_MS - 10_000);
  assert.equal(back.turn.deadline, null);
});
