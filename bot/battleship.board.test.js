'use strict';
/**
 * Морской бой: поле и флот — без стола и людей.
 *
 * Расстановка проверяется сервером: набор кораблей, границы, наложения и
 * касания — в том числе углами и у краёв поля. Случайная расстановка —
 * тысячи раз по правилам. Выстрел: «мимо», «ранил», «убил»; клетки вокруг
 * убитого.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkFleet, randomFleet, shoot, sunkShips, allSunk, halo, shipCells, neighbors, addr, cellOf, placements,
  FLEET, DECKS, CELLS, LETTERS,
} from './games/battleship/board.js';
import { botRandom } from './harness.js';
import { fleet, ROWS, COLS, EDGES } from './battleship.fixtures.js';

const cells = (ships) => new Set(ships.flatMap(shipCells));
const withShip = (ships, i, s) => ships.map((x, k) => (k === i ? s : x));

test('адреса клеток — как на бумаге: А…К без Й, числа 1…10', () => {
  assert.equal(LETTERS.join(''), 'АБВГДЕЖЗИК');
  assert.equal(addr(cellOf(0, 0)), 'А1');
  assert.equal(addr(cellOf(1, 6)), 'Б7');
  assert.equal(addr(cellOf(9, 9)), 'К10');
  assert.equal(addr(cellOf(8, 0)), 'И1');
  assert.equal(new Set(Array.from({ length: CELLS }, (_, c) => addr(c))).size, 100, 'у каждой клетки свой адрес');
});

test('флот — 4, 3, 3, 2, 2, 2, 1, 1, 1, 1: двадцать клеток', () => {
  assert.deepEqual(FLEET, [4, 3, 3, 2, 2, 2, 1, 1, 1, 1]);
  assert.equal(DECKS, 20);
});

test('правильные расстановки принимаются: у верхнего края, у левого, по углам и краям', () => {
  for (const [name, f] of [['ROWS', ROWS], ['COLS', COLS], ['EDGES', EDGES]]) {
    const r = checkFleet(f);
    assert.ok(r.ok, `${name}: ${r.error}`);
    assert.equal(cells(r.ships).size, 20);
  }
  // Порядок кораблей, лишние поля — не важны: сервер хранит свой нормальный вид.
  const shuffled = ROWS.slice().reverse().map((s) => ({ ...s, owner: '101', hidden: true }));
  assert.deepEqual(checkFleet(shuffled).ships, checkFleet(ROWS).ships);
  assert.ok(!('owner' in checkFleet(shuffled).ships[0]));
});

test('не тот набор кораблей — отказ', () => {
  assert.equal(checkFleet(ROWS.slice(0, 9)).error, 'BAD_FLEET', 'девять кораблей');
  assert.equal(checkFleet([...ROWS, { x: 9, y: 9, len: 1, dir: 'h' }]).error, 'BAD_FLEET', 'одиннадцать');
  // Два четырёхпалубных вместо четырёхпалубного и трёхпалубного.
  const i3 = ROWS.findIndex((s) => s.len === 3);
  assert.equal(checkFleet(withShip(ROWS, i3, { x: 0, y: 8, len: 4, dir: 'h' })).error, 'BAD_FLEET', 'два четырёхпалубных');
  assert.equal(checkFleet(withShip(ROWS, 0, { x: 0, y: 8, len: 5, dir: 'h' })).error, 'BAD_SHIP', 'пятипалубных не бывает');
  assert.equal(checkFleet(null).error, 'BAD_FLEET');
  assert.equal(checkFleet('X X X').error, 'BAD_FLEET');
  assert.equal(checkFleet({ length: 10 }).error, 'BAD_FLEET');
});

test('корабль за краем поля, кривой или не числами — отказ', () => {
  const i4 = 0;
  assert.equal(ROWS[i4].len, 4);
  const bad = [
    { x: 7, y: 9, len: 4, dir: 'h' }, // 7…10 — за правым краем
    { x: 9, y: 7, len: 4, dir: 'v' }, // 7…10 — за нижним
    { x: -1, y: 9, len: 4, dir: 'h' },
    { x: 0, y: 10, len: 4, dir: 'h' },
    { x: 10, y: 0, len: 4, dir: 'v' },
    { x: 0.5, y: 9, len: 4, dir: 'h' },
    { x: 0, y: 9, len: 4, dir: 'd' }, // направление только h/v
    { x: '0', y: 9, len: 4, dir: 'h' }, // числа строкой — нет
    { x: null, y: 9, len: 4, dir: 'h' }, // «null» — не ноль
    { x: 0, y: 9, len: 4 },
    { x: 0, y: 9, len: 'четыре', dir: 'h' },
    null,
  ];
  for (const s of bad) assert.equal(checkFleet(withShip(ROWS, i4, s)).error, 'BAD_SHIP', JSON.stringify(s));
  // А на самом краю — можно.
  assert.ok(checkFleet(withShip(ROWS, i4, { x: 6, y: 9, len: 4, dir: 'h' })).ok, 'Ж10…К10');
  assert.ok(checkFleet(withShip(ROWS, i4, { x: 9, y: 6, len: 4, dir: 'v' })).ok, 'К7…К10');
  // Однопалубному направление не важно.
  const i1 = ROWS.findIndex((s) => s.len === 1);
  assert.ok(checkFleet(withShip(ROWS, i1, { x: 9, y: 9, len: 1, dir: 'v' })).ok);
  assert.ok(checkFleet(withShip(ROWS, i1, { x: 9, y: 9, len: 1, dir: 'хоть что' })).ok);
});

test('корабли не касаются: ни наложением, ни боком, ни углом — и у края тоже', () => {
  const base = fleet(`
    X X X X . . . . . .
    . . . . . . . . . .
    X X X . X X X . . .
    . . . . . . . . . .
    X X . X X . X X . .
    . . . . . . . . . .
    X . X . X . X . . .
    . . . . . . . . . .
    . . . . . . . . . .
    . . . . . . . . . .
  `);
  assert.ok(checkFleet(base).ok);
  const one = base.findIndex((s) => s.len === 1 && s.x === 6 && s.y === 6);
  const cases = [
    [{ x: 2, y: 0, len: 1 }, 'наложение'],
    [{ x: 4, y: 0, len: 1 }, 'боком — справа от четырёхпалубного'],
    [{ x: 4, y: 1, len: 1 }, 'углом — по диагонали от конца четырёхпалубного'],
    [{ x: 7, y: 3, len: 1 }, 'углом — между двумя кораблями'],
    [{ x: 0, y: 1, len: 1 }, 'у левого края, между двумя кораблями'],
    [{ x: 3, y: 1, len: 1 }, 'углом к трёхпалубному снизу и к четырёхпалубному сверху'],
  ];
  for (const [s, why] of cases) assert.equal(checkFleet(withShip(base, one, { ...s, dir: 'h' })).error, 'SHIPS_TOUCH', why);
  assert.ok(checkFleet(withShip(base, one, { x: 9, y: 9, len: 1, dir: 'h' })).ok, 'вдали — можно');
  // Через одну клетку — можно.
  assert.ok(checkFleet(withShip(base, one, { x: 9, y: 0, len: 1, dir: 'h' })).ok);
  // Угол поля: корабль в углу и сосед по диагонали.
  const corner = fleet(`
    . . . . . . . . . .
    . . . . . . . . . .
    X X X X . X X X . .
    . . . . . . . . . .
    X X X . X X . X X .
    . . . . . . . . . .
    X X . X . X . . . .
    . . . . . . . . . .
    . . . . . . . . X .
    . . . . . . . . . X
  `);
  assert.equal(checkFleet(corner).error, 'SHIPS_TOUCH', 'К10 и И9 касаются углом');
});

test('клетки вокруг корабля: в середине поля, у края и в углу', () => {
  assert.equal(halo({ x: 4, y: 4, len: 1, dir: 'h' }).length, 8);
  assert.equal(halo({ x: 0, y: 0, len: 1, dir: 'h' }).length, 3, 'угол');
  assert.deepEqual(halo({ x: 0, y: 0, len: 1, dir: 'h' }), [1, 10, 11]);
  assert.equal(halo({ x: 0, y: 0, len: 4, dir: 'h' }).length, 6, 'у верхнего края: 4 снизу + 1 справа + 1 по диагонали');
  assert.equal(halo({ x: 3, y: 3, len: 3, dir: 'v' }).length, 12);
  assert.equal(neighbors(cellOf(9, 9)).length, 3);
  assert.equal(neighbors(cellOf(5, 0)).length, 5);
});

test('случайная расстановка: 5000 флотов — все по правилам; флоты разные, клетки покрыты все', () => {
  const rng = botRandom(42);
  const seen = new Set();
  const hits = new Array(CELLS).fill(0);
  for (let i = 0; i < 5000; i++) {
    const f = randomFleet(rng);
    const r = checkFleet(f);
    assert.ok(r.ok, `флот №${i}: ${r.error}`);
    seen.add(JSON.stringify(f));
    for (const c of cells(f)) hits[c] += 1;
  }
  assert.ok(seen.size > 4990, `разных флотов: ${seen.size}`);
  assert.ok(hits.every((n) => n > 0), 'каждая клетка хоть раз занята');
  // Случайность — подменяемая: одно зерно — один флот.
  assert.deepEqual(randomFleet(botRandom(7)), randomFleet(botRandom(7)));
  assert.notDeepEqual(randomFleet(botRandom(7)), randomFleet(botRandom(8)));
  // И с настоящей случайностью — тоже по правилам.
  for (let i = 0; i < 200; i++) assert.ok(checkFleet(randomFleet()).ok);
  // Даже «кривой» генератор (всегда 0 или почти 1) даёт правильный флот.
  assert.ok(checkFleet(randomFleet(() => 0)).ok);
  assert.ok(checkFleet(randomFleet(() => 0.999999)).ok);
});

test('места для корабля: не налезают на занятое', () => {
  assert.equal(placements(4).length, 2 * 10 * 7);
  assert.equal(placements(1).length, 100);
  const busy = new Set(Array.from({ length: 90 }, (_, i) => i));
  assert.equal(placements(4, busy).length, 7, 'только нижняя строка, вдоль');
});

test('выстрел: мимо, ранил, убил; флот погиб, когда убиты все', () => {
  const f = ROWS;
  const shots = new Set();
  assert.equal(shoot(f, shots, cellOf(4, 0)).r, 'miss');
  assert.equal(shoot(f, shots, cellOf(0, 0)).r, 'hit');
  shots.add(cellOf(0, 0));
  shots.add(cellOf(1, 0));
  shots.add(cellOf(2, 0));
  assert.equal(shoot(f, shots, cellOf(3, 0)).r, 'sunk', 'четвёртая клетка четырёхпалубного');
  assert.equal(shoot(f, new Set(), cellOf(9, 0)).r, 'sunk', 'однопалубный — сразу «убил»');
  shots.add(cellOf(3, 0));
  assert.deepEqual(sunkShips(f, shots), [f[0]]);
  assert.equal(allSunk(f, shots), false);
  assert.equal(allSunk(f, cells(f)), true);
});
