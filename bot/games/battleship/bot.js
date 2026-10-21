'use strict';
/**
 * Бот морского боя: соперник для партии из «Игр с ботами».
 *
 * Тайна флота действует и для бота. Он решает ТОЛЬКО по своему виду стола
 * (`view` — ровно то, что увидел бы человек на его месте): свои выстрелы и
 * их результаты, потопленные корабли и пустые клетки вокруг них, сколько
 * кораблей каждой длины ещё на плаву. Комнату (`room`, где лежат оба флота)
 * `decide` не читает вовсе — тест подсовывает вместо неё ловушку, которая
 * падает от любого обращения.
 *
 * Ходит через тот же `handle`, что и человек: расстановку проверяет сервер,
 * выстрел — тоже («не ваш ход», «уже стреляли», «рядом с потопленным»).
 *
 * Пять уровней:
 *   0 — наугад по клеткам, о которых ничего не известно;
 *   1 — охота и добивание: попал — бьёт по соседним, находит линию корабля;
 *   2 — то же, но ищет по шахматной сетке (корабль от двух палуб не проскочит);
 *   3 — карта вероятностей: в скольких расстановках оставшихся кораблей лежит
 *       каждая клетка — туда и стреляет;
 *   4 — то же с учётом «корабли не касаются»: клетки наискосок от попадания
 *       пусты, корабль не может стоять вплотную к чужому попаданию.
 */
import { SIZE, CELLS, xOf, yOf, cellOf, randomFleet, shipCells, neighbors, placements } from './board.js';
import { addPlayer, live, sideOf } from './rules.js';

/** Уровни словами — для формы и для имени бота за столом. */
export const LEVELS = [
  { name: 'Юнга' },
  { name: 'Матрос' },
  { name: 'Боцман' },
  { name: 'Капитан' },
  { name: 'Адмирал' },
];

const clampLevel = (v) => Math.max(0, Math.min(LEVELS.length - 1, Math.round(Number(v)) || 0));

/* Что известно о клетке поля соперника. */
const FREE = 0; // ничего не известно — сюда можно стрелять
const MISS = 1;
const HIT = 2; // ранен, ещё на плаву
const SUNK = 3;
const AROUND = 4; // рядом с потопленным — пусто

/**
 * Что бот знает о поле соперника — только из своего вида.
 * @returns {null | { state: number[], left: number[], shot: number, code: string }}
 */
export function knowledge(view) {
  const m = view?.match;
  if (!m || m.mySide == null || m.mySide === undefined) return null;
  const b = m.boards?.[1 - m.mySide];
  if (!b) return null;
  const state = new Array(CELLS).fill(FREE);
  for (const s of b.shots || []) state[s.c] = s.r === 'miss' ? MISS : s.r === 'hit' ? HIT : SUNK;
  for (const c of b.around || []) if (state[c] === FREE) state[c] = AROUND;
  const left = [];
  for (const [len, n] of Object.entries(b.left || {})) for (let i = 0; i < n; i++) left.push(Number(len));
  return { state, left, shot: m.shots, code: String(view.room?.code || '') };
}

const pickOne = (list, rng) => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
const ortho = (c) => {
  const x = xOf(c);
  const y = yOf(c);
  const out = [];
  if (x > 0) out.push(c - 1);
  if (x < SIZE - 1) out.push(c + 1);
  if (y > 0) out.push(c - SIZE);
  if (y < SIZE - 1) out.push(c + SIZE);
  return out;
};

/** Раненые корабли: группы попаданий, соединённые по стороне. */
function woundGroups(state) {
  const seen = new Set();
  const out = [];
  for (let c = 0; c < CELLS; c++) {
    if (state[c] !== HIT || seen.has(c)) continue;
    const group = [];
    const stack = [c];
    seen.add(c);
    while (stack.length) {
      const v = stack.pop();
      group.push(v);
      for (const n of ortho(v)) if (state[n] === HIT && !seen.has(n)) { seen.add(n); stack.push(n); }
    }
    out.push(group.sort((a, b) => a - b));
  }
  return out;
}

/** Добивание: куда бить, чтобы дотопить раненый корабль (уровни 1 и 2). */
function finishOff(state) {
  for (const g of woundGroups(state)) {
    let cand = [];
    if (g.length >= 2) {
      const horiz = yOf(g[0]) === yOf(g[g.length - 1]);
      const step = horiz ? 1 : SIZE;
      const a = g[0] - step;
      const b = g[g.length - 1] + step;
      if (horiz ? xOf(g[0]) > 0 : yOf(g[0]) > 0) cand.push(a);
      if (horiz ? xOf(g[g.length - 1]) < SIZE - 1 : yOf(g[g.length - 1]) < SIZE - 1) cand.push(b);
      cand = cand.filter((c) => state[c] === FREE);
    }
    if (!cand.length) cand = [...new Set(g.flatMap(ortho))].filter((c) => state[c] === FREE);
    if (cand.length) return cand;
  }
  return null;
}

/**
 * Карта вероятностей: для каждой ещё не известной клетки — сколько мест для
 * оставшихся кораблей её накрывают. Есть раненый — считаются только места,
 * которые его накрывают (и чем больше попаданий накрыто, тем весомее).
 * `strict` — уровень 4: корабли не касаются, наискосок от попадания пусто.
 */
function heat(k, strict) {
  const { state } = k;
  const hits = [];
  for (let c = 0; c < CELLS; c++) if (state[c] === HIT) hits.push(c);
  const hitSet = new Set(hits);
  // Знаем точно, что там пусто: промах, потопленный, и (для строгого) — около потопленного и наискосок от попадания.
  const water = new Set();
  for (let c = 0; c < CELLS; c++) {
    if (state[c] === MISS || state[c] === SUNK) water.add(c);
    if (strict && state[c] === AROUND) water.add(c);
  }
  if (strict) {
    for (const h of hits) for (const n of neighbors(h)) if (xOf(n) !== xOf(h) && yOf(n) !== yOf(h)) water.add(n);
  }
  const count = {};
  for (const len of k.left) count[len] = (count[len] || 0) + 1;
  const w = new Float64Array(CELLS);
  let any = false;
  for (const len of Object.keys(count).map(Number)) {
    for (const s of placements(len)) {
      const cells = shipCells(s);
      if (cells.some((c) => water.has(c))) continue;
      let covered = 0;
      for (const c of cells) if (hitSet.has(c)) covered++;
      if (hits.length && !covered) continue;
      if (strict) {
        // Корабль не стоит вплотную к попаданию, которое не его.
        const own = new Set(cells);
        if (cells.some((c) => neighbors(c).some((n) => hitSet.has(n) && !own.has(n)))) continue;
      }
      const weight = count[len] * (covered ? covered * covered * 50 : 1);
      for (const c of cells) {
        if (state[c] !== FREE) continue;
        w[c] += weight;
        any = true;
      }
    }
  }
  return any ? w : null;
}

/** Самая «горячая» свободная клетка; равные — наугад. */
function hottest(w, state, rng) {
  let best = -1;
  let list = [];
  for (let c = 0; c < CELLS; c++) {
    if (state[c] !== FREE) continue;
    if (w[c] > best + 1e-9) { best = w[c]; list = [c]; }
    else if (Math.abs(w[c] - best) <= 1e-9) list.push(c);
  }
  return list.length ? pickOne(list, rng) : null;
}

/** Шахматная сетка своя у каждого стола — чтобы не ходить всегда по одной. */
function parityOf(code) {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 2;
}

/**
 * Куда стрелять. Чистая функция вида: `view` — вид бота, `level` 0…4,
 * `rng` — дробь 0…1. Возвращает клетку 0…99 или null (стрелять некуда).
 */
export function chooseShot(view, level, rng = Math.random) {
  const k = knowledge(view);
  if (!k) return null;
  const { state } = k;
  const free = [];
  for (let c = 0; c < CELLS; c++) if (state[c] === FREE) free.push(c);
  if (!free.length) return null;
  const lv = clampLevel(level);
  if (lv === 0) return pickOne(free, rng);
  if (lv <= 2) {
    const hit = finishOff(state);
    if (hit) return pickOne(hit, rng);
    if (lv === 2 && k.left.some((n) => n >= 2)) {
      const p = parityOf(k.code);
      const grid = free.filter((c) => (xOf(c) + yOf(c)) % 2 === p);
      if (grid.length) return pickOne(grid, rng);
    }
    return pickOne(free, rng);
  }
  const w = heat(k, lv === 4);
  if (!w) {
    const hit = finishOff(state);
    return pickOne(hit || free, rng);
  }
  return hottest(w, state, rng) ?? pickOne(free, rng);
}

/** Свой флот на поле — из своего вида. */
const ownShips = (view) => view?.match?.boards?.[view.match.mySide]?.ships || [];

/** Ход бота из одного лишь вида: расстановка, «готов» или выстрел. */
export function decideFromView(view, wait, level, rng = Math.random) {
  const m = view?.match;
  if (!m || m.over || m.mySide == null) return null;
  if (wait?.kind === 'place') {
    if (!view.canPlace) return null;
    if (view.canReady && ownShips(view).length) return { t: 'ready' };
    return { t: 'place', ships: randomFleet(rng) };
  }
  if (!view.legal?.canFire) return null;
  const cell = chooseShot(view, level, rng);
  return cell == null ? null : { t: 'fire', cell, shot: m.shots };
}

export default {
  /** Что показать в форме перед партией: уровни словами. */
  catalog: () => ({
    levels: LEVELS.map((l) => l.name),
    defaultLevel: 1,
    levelHints: [
      'Стреляет наугад и не добивает раненых — для первой партии.',
      'Попал — добивает: бьёт рядом и находит, куда идёт корабль.',
      'Ищет по шахматной сетке — так корабль от двух палуб не проскочит.',
      'Считает, где корабли вероятнее всего, — стреляет туда.',
      'Самый сильный: ещё и помнит, что корабли не касаются друг друга.',
    ],
  }),

  /** Часы — из формы; кто первый — из формы, через prepare (только здесь, не в группе). */
  settings(raw = {}) {
    return { base: raw.base ?? 0, inc: raw.inc ?? 0 };
  },
  /**
   * «Кто стреляет первым» из формы. Форма дуэлей шлёт side: 'white' — первым
   * стреляет человек (он хост стола), 'black' — бот, иначе — жребий.
   */
  prepare(room, raw = {}) {
    const first = raw.side === 'white' ? 'host' : raw.side === 'black' ? 'guest' : null;
    if (first) room.settings.first = first;
    else delete room.settings.first;
  },
  lineup(raw = {}) {
    return [{ type: 'engine', level: clampLevel(raw.level ?? 1) }];
  },
  seat(room, spec, i) {
    const p = addPlayer(room, { id: `bot${i + 1}`, tgId: 0, name: `🤖 ${LEVELS[spec.level].name}`, dm: null });
    if (!p.error) p.bot = { ...spec };
    return p;
  },
  /** «Человеческая» пауза: расстановка — пара секунд, выстрел — меньше секунды-полторы. */
  delay: (room, p, w, rng) => (w.kind === 'place' ? 1500 + Math.floor(rng() * 1500) : 700 + Math.floor(rng() * 800)),

  /**
   * Решение бота. Читается ТОЛЬКО `view` (и уровень из своей записи `me.bot`):
   * `room` с обоими флотами сюда передаёт ядро, но бот его не трогает.
   */
  decide({ view, me, wait, rng }) {
    return decideFromView(view, wait, me?.bot?.level ?? 1, rng || Math.random);
  },

  /** Запасной ход, если решение не прошло: расставить случайно / «готов» / первая свободная клетка. */
  fallback(view, wait) {
    const m = view?.match;
    if (!m || m.over || m.mySide == null) return null;
    if (wait?.kind === 'place') {
      if (!view.canPlace) return null;
      return view.canReady && ownShips(view).length ? { t: 'ready' } : { t: 'random' };
    }
    if (!view.legal?.canFire) return null;
    const k = knowledge(view);
    const c = k?.state.findIndex((x) => x === FREE);
    return c == null || c < 0 ? null : { t: 'fire', cell: c, shot: m.shots };
  },
};

// Для тестов: чем бот считает (без комнаты и без флотов).
export const _internal = { heat, finishOff, woundGroups, FREE, HIT, cellOf, live, sideOf };
