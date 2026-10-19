'use strict';
/**
 * Морской бой: поле и флот — чистые функции, без стола и людей.
 *
 * Поле 10×10. Клетка — число 0…99: `y * 10 + x`, где `x` — столбец (буквы
 * А…К слева направо), `y` — строка (числа 1…10 сверху вниз). «Б7» — x = 1,
 * y = 6, клетка 61.
 *
 * Корабль — `{ x, y, len, dir }`: верхняя левая клетка, длина и направление
 * ('h' — вправо, 'v' — вниз). Флот — русская классика: 4, 3, 3, 2, 2, 2,
 * 1, 1, 1, 1; корабли не касаются друг друга даже углами.
 */

export const SIZE = 10;
export const CELLS = SIZE * SIZE;
/** Длины кораблей флота. */
export const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
/** Буквы столбцов — как на бумаге: без Ё и Й. */
export const LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К'];
/** Всего клеток с кораблями. */
export const DECKS = FLEET.reduce((s, n) => s + n, 0);

export const cellOf = (x, y) => y * SIZE + x;
export const xOf = (c) => c % SIZE;
export const yOf = (c) => Math.floor(c / SIZE);
export const isCell = (c) => Number.isInteger(c) && c >= 0 && c < CELLS;

/** «Б7» — адрес клетки, как его говорят вслух. */
export const addr = (c) => `${LETTERS[xOf(c)]}${yOf(c) + 1}`;

/** Клетки корабля. */
export function shipCells(s) {
  const out = [];
  for (let i = 0; i < s.len; i++) out.push(s.dir === 'h' ? cellOf(s.x + i, s.y) : cellOf(s.x, s.y + i));
  return out;
}

/** Соседи клетки — восемь вокруг, в пределах поля. */
export function neighbors(c) {
  const x = xOf(c);
  const y = yOf(c);
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) out.push(cellOf(nx, ny));
    }
  }
  return out;
}

/** Клетки вокруг корабля (без него самого): там кораблей быть не может. */
export function halo(s) {
  const own = new Set(shipCells(s));
  const out = new Set();
  for (const c of own) for (const n of neighbors(c)) if (!own.has(n)) out.add(n);
  return [...out].sort((a, b) => a - b);
}

/** Корабль из чего угодно — или null. Лишние поля отбрасываются. */
export function normShip(s) {
  if (!s || typeof s !== 'object') return null;
  // Только целые числа: «null», «0» строкой, «1.5» — не координаты.
  const { x, y, len } = s;
  const dir = len === 1 ? 'h' : s.dir;
  if (![x, y, len].every(Number.isInteger) || !['h', 'v'].includes(dir)) return null;
  if (len < 1 || len > 4 || x < 0 || y < 0) return null;
  if (dir === 'h' ? x + len > SIZE || y >= SIZE : y + len > SIZE || x >= SIZE) return null;
  return { x, y, len, dir };
}

/**
 * Проверка расстановки. Флот — ровно набор FLEET, все в поле, без наложений
 * и касаний (в том числе углами).
 *
 * @returns {{ ok: true, ships } | { error: 'BAD_FLEET'|'BAD_SHIP'|'SHIPS_TOUCH' }}
 */
export function checkFleet(raw) {
  if (!Array.isArray(raw) || raw.length !== FLEET.length) return { error: 'BAD_FLEET' };
  const ships = raw.map(normShip);
  if (ships.some((s) => !s)) return { error: 'BAD_SHIP' };
  const lens = ships.map((s) => s.len).sort((a, b) => b - a);
  if (lens.join() !== FLEET.join()) return { error: 'BAD_FLEET' };
  // Каждая клетка — чья; касание — сосед с другим кораблём.
  const owner = new Array(CELLS).fill(-1);
  for (let i = 0; i < ships.length; i++) {
    for (const c of shipCells(ships[i])) {
      if (owner[c] !== -1) return { error: 'SHIPS_TOUCH' };
      owner[c] = i;
    }
  }
  for (let i = 0; i < ships.length; i++) {
    for (const c of shipCells(ships[i])) {
      for (const n of neighbors(c)) if (owner[n] !== -1 && owner[n] !== i) return { error: 'SHIPS_TOUCH' };
    }
  }
  return { ok: true, ships: sortShips(ships) };
}

/** Один порядок кораблей: длинные первыми, потом по клетке. */
export function sortShips(ships) {
  return ships.slice().sort((a, b) => b.len - a.len || cellOf(a.x, a.y) - cellOf(b.x, b.y) || (a.dir < b.dir ? -1 : 1));
}

/** Все места, куда корабль длины `len` встаёт, не касаясь занятого (`busy` — клетки кораблей и их ореолов). */
export function placements(len, busy = new Set()) {
  const out = [];
  for (const dir of len === 1 ? ['h'] : ['h', 'v']) {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const s = normShip({ x, y, len, dir });
        if (s && shipCells(s).every((c) => !busy.has(c))) out.push(s);
      }
    }
  }
  return out;
}

/**
 * Случайная расстановка по правилам. `rng` — дробь 0…1, как Math.random;
 * в тестах подменяется. Длинные ставятся первыми, каждый — в случайное из
 * всех оставшихся мест; тупик (редко) — заново.
 */
export function randomFleet(rng = Math.random) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const busy = new Set();
    const ships = [];
    let stuck = false;
    for (const len of FLEET) {
      const opts = placements(len, busy);
      if (!opts.length) {
        stuck = true;
        break;
      }
      const s = opts[Math.min(opts.length - 1, Math.floor(rng() * opts.length))];
      ships.push(s);
      for (const c of shipCells(s)) busy.add(c);
      for (const c of halo(s)) busy.add(c);
    }
    if (!stuck) return sortShips(ships);
  }
  throw new Error('морской бой: не вышло расставить флот');
}

/**
 * Выстрел по флоту `ships`, если уже стреляли в клетки `shots` (Set).
 *
 * @returns {{ r: 'miss' } | { r: 'hit', ship } | { r: 'sunk', ship }}
 *   `ship` — номер корабля во флоте.
 */
export function shoot(ships, shots, cell) {
  for (let i = 0; i < ships.length; i++) {
    const cells = shipCells(ships[i]);
    if (!cells.includes(cell)) continue;
    const sunk = cells.every((c) => c === cell || shots.has(c));
    return { r: sunk ? 'sunk' : 'hit', ship: i };
  }
  return { r: 'miss' };
}

/** Какие корабли флота потоплены, если стреляли в `shots` (Set). */
export function sunkShips(ships, shots) {
  return ships.filter((s) => shipCells(s).every((c) => shots.has(c)));
}

/** Все корабли потоплены — флот погиб. */
export const allSunk = (ships, shots) => sunkShips(ships, shots).length === ships.length;
