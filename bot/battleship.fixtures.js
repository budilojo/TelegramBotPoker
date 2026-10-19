'use strict';
/**
 * Флоты для тестов морского боя — нарисованы клетками, чтобы их было видно
 * глазами. `X` — корабль, `.` — вода; строки сверху вниз (1…10), столбцы
 * слева направо (А…К).
 */
import { SIZE, cellOf, sortShips } from './games/battleship/board.js';

/** Рисунок → корабли. Корабль — непрерывная линия X по горизонтали или вертикали. */
export function fleet(picture) {
  const rows = picture.trim().split('\n').map((r) => r.replace(/\s+/g, ''));
  if (rows.length !== SIZE || rows.some((r) => r.length !== SIZE)) throw new Error('рисунок флота: нужно 10×10');
  const on = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && rows[y][x] === 'X';
  const seen = new Set();
  const ships = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (!on(x, y) || seen.has(cellOf(x, y))) continue;
      let len = 1;
      const dir = on(x + 1, y) ? 'h' : 'v';
      while (dir === 'h' ? on(x + len, y) : on(x, y + len)) len++;
      for (let i = 0; i < len; i++) seen.add(dir === 'h' ? cellOf(x + i, y) : cellOf(x, y + i));
      ships.push({ x, y, len, dir: len === 1 ? 'h' : dir });
    }
  }
  return sortShips(ships);
}

/** Флот «по строкам»: всё у верхнего края. */
export const ROWS = fleet(`
  X X X X . X X X . X
  . . . . . . . . . .
  X X X . X X . X X .
  . . . . . . . . . .
  X X . X . X . X . .
  . . . . . . . . . .
  . . . . . . . . . .
  . . . . . . . . . .
  . . . . . . . . . .
  . . . . . . . . . .
`);

/** Тот же флот, повёрнутый набок: всё у левого края. */
export const COLS = fleet(`
  X . X . X . . . . .
  X . X . X . . . . .
  X . X . . . . . . .
  X . . . X . . . . .
  . . X . . . . . . .
  X . X . X . . . . .
  X . . . . . . . . .
  X . X . X . . . . .
  . . X . . . . . . .
  X . . . . . . . . .
`);

/** Флот у нижнего и правого краёв — по углам и краям поля. */
export const EDGES = fleet(`
  . . X . X . . . . X
  . . . . . . . . . .
  X . . . . . . . . X
  . . . . . . . . . X
  . . . . . . . . . X
  X . . . . . . . . .
  X . . . . . . . . X
  X . . . . . . . . X
  . . . . . . . . . .
  X X X X . X X . X X
`);
