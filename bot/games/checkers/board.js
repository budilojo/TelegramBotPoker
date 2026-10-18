'use strict';
/**
 * Русские шашки: сама доска — позиция, ходы, нотация, конец партии. Без
 * людей, часов и сокетов.
 *
 * Правила — по Федерации шашек России (shashki.ru, «Русские шашки»);
 * разбор спорных мест — docs/checkers.md. Правильность проверяется perft:
 * числом позиций, достижимых за N полуходов, сверенным с опубликованными
 * числами и с независимым генератором (checkers.board.test.js).
 *
 * Позиция — обычный объект, ход её не меняет, а возвращает новую:
 *   b   64 клетки, 0 = a1, 7 = h1, 56 = a8; '' — пусто, 'w' / 'b' — простая
 *       белая / чёрная, 'W' / 'B' — дамка. Играют только тёмные поля
 *       (a1 тёмное: сумма вертикали и горизонтали чётная).
 *   t   чей ход: 'w' | 'b' (первыми ходят белые)
 *
 * Ход — { from, to, path, caps, promo }: `path` — все поля, на которые
 * становится шашка (от `from` до `to`), `caps` — побитые шашки (поля), `promo`
 * — простая стала дамкой. Ходы с одинаковыми from, to и набором побитых
 * считаются одним ходом: позиция после них одна и та же.
 */

const FILES = 'abcdefgh';
export const sqName = (i) => FILES[i & 7] + ((i >> 3) + 1);
export const sqIndex = (name) => {
  const m = /^([a-h])([1-8])$/.exec(String(name));
  return m ? (Number(m[2]) - 1) * 8 + FILES.indexOf(m[1]) : -1;
};
export const isDark = (i) => i >= 0 && i < 64 && (((i & 7) + (i >> 3)) & 1) === 0;
export const other = (c) => (c === 'w' ? 'b' : 'w');
export const colorOf = (p) => (p ? p.toLowerCase() : null);
export const isKing = (p) => p === 'W' || p === 'B';
const kingOf = (c) => (c === 'w' ? 'W' : 'B');
const lastRank = (c) => (c === 'w' ? 7 : 0);

/** Шаг по диагонали: [вертикаль, горизонталь]. */
const DIRS = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
const step = (s, [df, dr]) => {
  const f = (s & 7) + df;
  const r = (s >> 3) + dr;
  return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 8 + f;
};

/* ------------------------------------------------------------- позиции */

/**
 * Запись позиции как в PDN/pydraughts: `W:Wa1,c3,Kd4:Bb6,Kh8` — чей ход, потом
 * белые и чёрные поля; `K` — дамка.
 */
export function fromFen(fen) {
  const parts = String(fen).trim().split(':');
  if (parts.length !== 3) throw new Error('FEN: нужно «ход:белые:чёрные»');
  const b = Array(64).fill('');
  for (const part of parts.slice(1)) {
    const c = part[0]?.toLowerCase();
    if (c !== 'w' && c !== 'b') throw new Error('FEN: поле без цвета');
    for (const item of part.slice(1).split(',').filter(Boolean)) {
      const king = item[0] === 'K';
      const s = sqIndex(king ? item.slice(1) : item);
      if (!isDark(s)) throw new Error(`FEN: ${item} — не тёмное поле`);
      b[s] = king ? kingOf(c) : c;
    }
  }
  return { b, t: parts[0].toLowerCase() === 'b' ? 'b' : 'w' };
}

export function toFen(pos) {
  const side = (c) => pos.b.map((p, i) => (colorOf(p) === c ? (isKing(p) ? 'K' : '') + sqName(i) : null)).filter(Boolean).join(',');
  return `${pos.t.toUpperCase()}:W${side('w')}:B${side('b')}`;
}

/** Начало: по 12 шашек на тёмных полях трёх ближних рядов. */
export function startPosition() {
  const b = Array(64).fill('');
  for (let i = 0; i < 64; i++) {
    if (!isDark(i)) continue;
    if (i >> 3 <= 2) b[i] = 'w';
    else if (i >> 3 >= 5) b[i] = 'b';
  }
  return { b, t: 'w' };
}

/* ---------------------------------------------------------------- взятия */

/**
 * Все серии взятий шашкой с поля `from`. Побитые остаются на доске до конца
 * хода («турецкий удар»): их нельзя перепрыгнуть второй раз, и они загораживают
 * дорогу. Серию нужно довести до конца; простая, дошедшая до последнего ряда,
 * продолжает бить уже дамкой.
 */
function capturesFrom(b, from, c) {
  const out = [];
  const piece = b[from];
  const work = b.slice();
  work[from] = ''; // поле, с которого ушли, свободно — через него можно пройти
  const taken = new Set();

  const enemy = (s) => s >= 0 && work[s] && colorOf(work[s]) !== c && !taken.has(s);

  /** Куда можно встать, побив одну шашку с поля `s`: [{ over, land }]. */
  function jumps(s, king) {
    const res = [];
    for (const d of DIRS) {
      if (king) {
        let x = step(s, d);
        while (x >= 0 && !work[x]) x = step(x, d);
        if (!enemy(x)) continue;
        for (let land = step(x, d); land >= 0 && !work[land]; land = step(land, d)) res.push({ over: x, land, d });
      } else {
        const x = step(s, d);
        const land = x >= 0 ? step(x, d) : -1;
        if (enemy(x) && land >= 0 && !work[land]) res.push({ over: x, land, d });
      }
    }
    return res;
  }

  function walk(s, king, path, caps) {
    let options = jumps(s, king);
    if (king) {
      // Дамка становится на любое свободное поле за побитой — но если с
      // какого-то из них можно бить дальше, то только на такое: бой
      // продолжается обязательно.
      const byLine = new Map();
      for (const o of options) {
        const k = `${o.over}`;
        if (!byLine.has(k)) byLine.set(k, []);
        byLine.get(k).push(o);
      }
      options = [];
      for (const group of byLine.values()) {
        const goOn = group.filter((o) => {
          taken.add(o.over);
          const more = jumps(o.land, true).length > 0;
          taken.delete(o.over);
          return more;
        });
        options.push(...(goOn.length ? goOn : group));
      }
    }
    if (!options.length) {
      if (caps.length) out.push({ from, to: s, path: path.slice(), caps: caps.slice(), promo: !isKing(piece) && king });
      return;
    }
    for (const o of options) {
      taken.add(o.over);
      path.push(o.land);
      caps.push(o.over);
      walk(o.land, king || (o.land >> 3) === lastRank(c), path, caps);
      caps.pop();
      path.pop();
      taken.delete(o.over);
    }
  }

  walk(from, isKing(piece), [from], []);
  return out;
}

/** Ходы без взятия: простая — на поле вперёд, дамка — на любое по диагонали. */
function quietFrom(b, from, c) {
  const out = [];
  const king = isKing(b[from]);
  for (const d of DIRS) {
    if (!king && d[1] !== (c === 'w' ? 1 : -1)) continue;
    for (let x = step(from, d); x >= 0 && !b[x]; x = step(x, d)) {
      out.push({ from, to: x, path: [from, x], caps: [], promo: !king && (x >> 3) === lastRank(c) });
      if (!king) break;
    }
  }
  return out;
}

/** Все законные ходы: если можно бить — только взятия. */
export function legalMoves(pos) {
  const c = pos.t;
  const caps = [];
  for (let s = 0; s < 64; s++) if (colorOf(pos.b[s]) === c) caps.push(...capturesFrom(pos.b, s, c));
  if (caps.length) {
    // Разные порядки одних и тех же взятий с тем же концом — один ход.
    const seen = new Set();
    return caps.filter((m) => {
      const k = `${m.from}>${m.to}:${m.caps.slice().sort((x, y) => x - y).join(',')}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  const out = [];
  for (let s = 0; s < 64; s++) if (colorOf(pos.b[s]) === c) out.push(...quietFrom(pos.b, s, c));
  return out;
}

/** Поля шашек, которым сейчас надо бить (пусто — бить нечем). */
export function mustCapture(pos) {
  const from = new Set();
  for (const m of legalMoves(pos)) if (m.caps.length) from.add(m.from);
  return [...from];
}

export function make(pos, m) {
  const b = pos.b.slice();
  const piece = b[m.from];
  b[m.from] = '';
  for (const s of m.caps) b[s] = '';
  b[m.to] = m.promo ? kingOf(colorOf(piece)) : piece;
  return { b, t: other(pos.t) };
}

export function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(make(pos, m), depth - 1);
  return n;
}

/** Запись хода: `c3-d4` — тихий, `c3:e5:c7` — взятие, через все поля, где становилась шашка. */
export const notation = (m) => m.path.map(sqName).join(m.caps.length ? ':' : '-');

/**
 * Найти законный ход по тому, что прислала страница: поле «откуда», «куда» и,
 * если таких ходов несколько (разные серии с одним концом), путь — поля, на
 * которые становилась шашка. Путь не обязан совпасть с нашим порядком взятий:
 * сравнивается, какие шашки он бьёт. Возвращает ход, `null` (так нельзя) или
 * `{ ambiguous: true }` — нужен путь.
 */
export function findMove(pos, from, to, path = null) {
  const f = sqIndex(from);
  const t = sqIndex(to);
  const cands = legalMoves(pos).filter((m) => m.from === f && m.to === t);
  if (!cands.length) return null;
  if (!path || !path.length) return cands.length === 1 ? cands[0] : { ambiguous: true };
  const squares = path.map(sqIndex);
  if (squares.some((s) => s < 0)) return null;
  if (squares[0] !== f) squares.unshift(f);
  if (squares.at(-1) !== t) return null;
  const caps = capsOnPath(pos.b, squares);
  if (!caps) return null;
  const want = caps.sort((x, y) => x - y).join(',');
  return cands.find((m) => m.caps.slice().sort((x, y) => x - y).join(',') === want) || null;
}

/** Какие шашки бьёт путь: на каждом отрезке по диагонали — ровно одна чужая. */
function capsOnPath(b, squares) {
  const c = colorOf(b[squares[0]]);
  const caps = [];
  for (let i = 1; i < squares.length; i++) {
    const a = squares[i - 1];
    const z = squares[i];
    const df = (z & 7) - (a & 7);
    const dr = (z >> 3) - (a >> 3);
    if (!df || Math.abs(df) !== Math.abs(dr)) return null;
    const d = [Math.sign(df), Math.sign(dr)];
    const met = [];
    for (let x = step(a, d); x !== z; x = step(x, d)) if (b[x] && x !== squares[0]) met.push(x);
    if (met.length !== 1 || colorOf(b[met[0]]) === c) return null;
    caps.push(met[0]);
  }
  return caps;
}

/** Ключ позиции для троекратного повторения: расстановка и чей ход. */
export const key = (pos) => `${pos.b.map((p) => p || '.').join('')}${pos.t}`;

/* ---------------------------------------------------------- конец партии */

/**
 * Счётчики для ничьих после хода `m` из позиции `pos`:
 *   q — полуходов подряд без взятия и без превращения (соотношение сил то же);
 *   k — полуходов подряд только дамками и без взятий.
 */
export function counters(prev, pos, m) {
  const man = !isKing(pos.b[m.from]);
  const changed = m.caps.length > 0 || m.promo;
  return {
    q: changed ? 0 : (prev?.q || 0) + 1,
    k: m.caps.length || man ? 0 : (prev?.k || 0) + 1,
  };
}

/** Большая дорога — диагональ a1–h8. */
const BIG_ROAD = new Set([0, 9, 18, 27, 36, 45, 54, 63]);

/** Сколько полуходов (по счётчикам) до ничьей — правила ФШР; разбор в docs/checkers.md. */
export const DRAW = {
  KINGS_ONLY: 30, // 15 ходов каждого только дамками, без взятий и ходов простыми
  BALANCE: { 3: 10, 5: 60, 7: 120 }, // у обоих дамки: до 3 фигур — 5 ходов, до 5 — 30, до 7 — 60
  LONE_ROAD: 5, // три фигуры против одинокой дамки на большой дороге — своим 5-м ходом
  LONE_KINGS: 15, // три дамки (и больше) против одинокой дамки — своим 15-м ходом
};

function count(b) {
  const n = { w: 0, b: 0, W: 0, B: 0 };
  for (const p of b) if (p) n[p] += 1;
  return { w: n.w + n.W, b: n.b + n.B, kw: n.W, kb: n.B };
}

/** Ничья по правилам (а не по согласию), или null. `seen` — сколько раз была каждая позиция. */
export function drawKind(pos, { q = 0, k = 0 } = {}, seen = {}) {
  if ((seen[key(pos)] || 0) >= 3) return 'repetition';
  if (k >= DRAW.KINGS_ONLY) return 'kings';
  const n = count(pos.b);
  // Одинокая дамка против трёх и больше: сильная сторона ловит её N своих ходов.
  for (const [strong, weak] of [['w', 'b'], ['b', 'w']]) {
    const lone = n[weak] === 1 && n[`k${weak}`] === 1;
    if (!lone) continue;
    // Последний полуход сделала сторона, которой сейчас не ходить.
    const strongMoves = pos.t === weak ? Math.ceil(q / 2) : Math.floor(q / 2);
    const at = pos.b.findIndex((p) => p === kingOf(weak));
    if (n[strong] === 3 && BIG_ROAD.has(at) && strongMoves >= DRAW.LONE_ROAD) return 'lone';
    if (n[`k${strong}`] >= 3 && strongMoves >= DRAW.LONE_KINGS) return 'lone';
  }
  // У обоих дамки, соотношение сил не меняется.
  if (n.kw && n.kb) {
    const total = n.w + n.b;
    const limit = total <= 3 ? DRAW.BALANCE[3] : total <= 5 ? DRAW.BALANCE[5] : total <= 7 ? DRAW.BALANCE[7] : Infinity;
    if (q >= limit) return 'balance';
  }
  return null;
}

/**
 * Чем кончилась партия после хода: { winner, kind } или null. Нет шашек или
 * нет ходов у того, чей ход, — проигрыш. Иначе — ничьи по правилам.
 */
export function outcome(pos, st = {}, seen = {}) {
  if (!legalMoves(pos).length) return { winner: other(pos.t), kind: pos.b.some((p) => colorOf(p) === pos.t) ? 'blocked' : 'nopieces' };
  const d = drawKind(pos, st, seen);
  return d ? { winner: null, kind: d } : null;
}
