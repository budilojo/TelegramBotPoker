'use strict';
/**
 * Шахматы: сама доска — позиция, ходы, нотация. Без людей, часов и сокетов.
 *
 * Это единственное место, где живут правила FIDE (статья 3 — ходы фигур,
 * статья 5 — конец партии). Всё остальное в модуле — комната, места, часы —
 * только вызывает отсюда. Поэтому правильность этого файла проверяется не
 * примерами «вроде работает», а perft: сколько всего позиций достижимо за N
 * полуходов, сверенное с общеизвестными числами (board.test.js). Одна
 * ошибка в рокировке или взятии на проходе меняет эти числа сразу.
 *
 * Позиция — обычный объект, ход её не меняет, а возвращает новую:
 *   b   64 клетки, 0 = a1, 7 = h1, 56 = a8; '' — пусто, иначе буква фигуры
 *       (заглавная — белая, строчная — чёрная): P N B R Q K
 *   t   чей ход: 'w' | 'b'
 *   c   права на рокировку: подстрока 'KQkq' (может быть пустой)
 *   ep  клетка, «через» которую прошла пешка двойным ходом, или -1
 *   hm  полуходы без взятия и хода пешки (правило 50 ходов)
 *   fm  номер хода (с единицы)
 */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FILES = 'abcdefgh';

export const sqName = (i) => FILES[i & 7] + ((i >> 3) + 1);
export const sqIndex = (name) => {
  const m = /^([a-h])([1-8])$/.exec(String(name));
  return m ? (Number(m[2]) - 1) * 8 + FILES.indexOf(m[1]) : -1;
};
export const colorOf = (p) => (p === p.toLowerCase() ? 'b' : 'w');
export const other = (c) => (c === 'w' ? 'b' : 'w');

/* ------------------------------------------------------------------- FEN */

export function fromFen(fen) {
  const [placement, t = 'w', c = '-', ep = '-', hm = '0', fm = '1'] = String(fen).trim().split(/\s+/);
  const b = Array(64).fill('');
  const rows = placement.split('/');
  if (rows.length !== 8) throw new Error('FEN: нужно 8 рядов');
  rows.forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) f += Number(ch);
      else b[(7 - i) * 8 + f++] = ch;
    }
    if (f !== 8) throw new Error('FEN: в ряду должно быть 8 клеток');
  });
  return {
    b, t: t === 'b' ? 'b' : 'w', c: c === '-' ? '' : c,
    ep: ep === '-' ? -1 : sqIndex(ep), hm: Number(hm) || 0, fm: Number(fm) || 1,
  };
}

export function toFen(pos) {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let gap = 0;
    for (let f = 0; f < 8; f++) {
      const p = pos.b[r * 8 + f];
      if (!p) { gap++; continue; }
      if (gap) { row += gap; gap = 0; }
      row += p;
    }
    rows.push(row + (gap || ''));
  }
  return `${rows.join('/')} ${pos.t} ${pos.c || '-'} ${pos.ep < 0 ? '-' : sqName(pos.ep)} ${pos.hm} ${pos.fm}`;
}

export const startPosition = () => fromFen(START_FEN);

/* ------------------------------------------------------------- attacks */

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Клетка `(f + df, r + dr)` или -1, если она за краем доски. */
const step = (s, df, dr) => {
  const f = (s & 7) + df;
  const r = (s >> 3) + dr;
  return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 8 + f;
};

/** Бьёт ли фигура цвета `by` клетку `s`. */
export function attacked(b, s, by) {
  const up = by === 'w' ? -1 : 1; // пешка цвета `by` стоит на ряд «позади» клетки, которую бьёт
  const pawn = by === 'w' ? 'P' : 'p';
  for (const df of [-1, 1]) {
    const q = step(s, df, up);
    if (q >= 0 && b[q] === pawn) return true;
  }
  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of KNIGHT) {
    const q = step(s, df, dr);
    if (q >= 0 && b[q] === knight) return true;
  }
  const king = by === 'w' ? 'K' : 'k';
  for (const [df, dr] of KING) {
    const q = step(s, df, dr);
    if (q >= 0 && b[q] === king) return true;
  }
  const slide = (dirs, a, c) => {
    for (const [df, dr] of dirs) {
      for (let q = step(s, df, dr); q >= 0; q = step(q, df, dr)) {
        if (!b[q]) continue;
        if (b[q] === a || b[q] === c) return true;
        break;
      }
    }
    return false;
  };
  return by === 'w' ? slide(DIAG, 'B', 'Q') || slide(ORTH, 'R', 'Q') : slide(DIAG, 'b', 'q') || slide(ORTH, 'r', 'q');
}

export const kingSquare = (b, c) => b.indexOf(c === 'w' ? 'K' : 'k');
export const inCheck = (pos, c = pos.t) => {
  const k = kingSquare(pos.b, c);
  return k >= 0 && attacked(pos.b, k, other(c));
};

/* ---------------------------------------------------------------- moves */

/**
 * Ход: { from, to, piece, cap, promo, ep, castle }
 *   cap     съеденная фигура ('' если нет; при взятии на проходе — пешка)
 *   promo   в кого превратилась пешка ('q' 'r' 'b' 'n') или ''
 *   ep      это взятие на проходе
 *   castle  'K' | 'Q' — короткая / длинная рокировка, иначе ''
 */
function pseudoMoves(pos) {
  const { b, t } = pos;
  const out = [];
  const add = (from, to, extra = {}) => out.push({ from, to, piece: b[from], cap: b[to] || '', promo: '', ep: false, castle: '', ...extra });

  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!p || colorOf(p) !== t) continue;
    const kind = p.toUpperCase();

    if (kind === 'P') {
      const dir = t === 'w' ? 1 : -1;
      const startRank = t === 'w' ? 1 : 6;
      const lastRank = t === 'w' ? 7 : 0;
      const push = (to, extra = {}) => {
        if ((to >> 3) === lastRank) for (const promo of ['q', 'r', 'b', 'n']) add(from, to, { ...extra, promo });
        else add(from, to, extra);
      };
      const one = step(from, 0, dir);
      if (one >= 0 && !b[one]) {
        push(one);
        const two = step(from, 0, 2 * dir);
        if ((from >> 3) === startRank && !b[two]) add(from, two);
      }
      for (const df of [-1, 1]) {
        const to = step(from, df, dir);
        if (to < 0) continue;
        if (b[to] && colorOf(b[to]) !== t) push(to);
        else if (to === pos.ep && !b[to]) add(from, to, { cap: t === 'w' ? 'p' : 'P', ep: true });
      }
      continue;
    }

    if (kind === 'N' || kind === 'K') {
      for (const [df, dr] of kind === 'N' ? KNIGHT : KING) {
        const to = step(from, df, dr);
        if (to >= 0 && (!b[to] || colorOf(b[to]) !== t)) add(from, to);
      }
      if (kind === 'K') castleMoves(pos, from, add);
      continue;
    }

    const dirs = kind === 'B' ? DIAG : kind === 'R' ? ORTH : [...DIAG, ...ORTH];
    for (const [df, dr] of dirs) {
      for (let to = step(from, df, dr); to >= 0; to = step(to, df, dr)) {
        if (!b[to]) { add(from, to); continue; }
        if (colorOf(b[to]) !== t) add(from, to);
        break;
      }
    }
  }
  return out;
}

/** Рокировка: король и ладья не ходили, между ними пусто, король не под боем и не проходит под боем. */
function castleMoves(pos, from, add) {
  const { b, t, c } = pos;
  const home = t === 'w' ? 4 : 60;
  if (from !== home) return;
  const foe = other(t);
  const rook = t === 'w' ? 'R' : 'r';
  const K = t === 'w' ? 'K' : 'k';
  const Q = t === 'w' ? 'Q' : 'q';
  const safe = (...sqs) => sqs.every((s) => !attacked(b, s, foe));
  if (c.includes(K) && b[home + 3] === rook && !b[home + 1] && !b[home + 2]
      && !attacked(b, home, foe) && safe(home + 1, home + 2)) add(from, home + 2, { castle: 'K' });
  if (c.includes(Q) && b[home - 4] === rook && !b[home - 1] && !b[home - 2] && !b[home - 3]
      && !attacked(b, home, foe) && safe(home - 1, home - 2)) add(from, home - 2, { castle: 'Q' });
}

/** Сыграть ход (законность не проверяется). Возвращает новую позицию. */
export function make(pos, m) {
  const b = pos.b.slice();
  const t = pos.t;
  b[m.to] = m.promo ? (t === 'w' ? m.promo.toUpperCase() : m.promo) : m.piece;
  b[m.from] = '';
  if (m.ep) b[m.to + (t === 'w' ? -8 : 8)] = '';
  if (m.castle === 'K') { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = ''; }
  if (m.castle === 'Q') { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = ''; }

  let c = pos.c;
  const strip = (s) => { c = c.replace(s, ''); };
  if (m.piece === 'K') { strip('K'); strip('Q'); }
  if (m.piece === 'k') { strip('k'); strip('q'); }
  for (const s of [m.from, m.to]) {
    if (s === 0) strip('Q');
    if (s === 7) strip('K');
    if (s === 56) strip('q');
    if (s === 63) strip('k');
  }
  const double = m.piece.toUpperCase() === 'P' && Math.abs(m.to - m.from) === 16;
  return {
    b, t: other(t), c,
    ep: double ? (m.from + m.to) / 2 : -1,
    hm: m.cap || m.piece.toUpperCase() === 'P' ? 0 : pos.hm + 1,
    fm: pos.fm + (t === 'b' ? 1 : 0),
  };
}

/** Все законные ходы того, чей ход: после них свой король не под боем. */
export function legalMoves(pos) {
  const t = pos.t;
  return pseudoMoves(pos).filter((m) => !inCheck(make(pos, m), t));
}

/** Число позиций через `depth` полуходов — для сверки с эталоном. */
export function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(make(pos, m), depth - 1);
  return n;
}

/** Ход по клеткам из приложения: 'e2' 'e4' и, для пешки на последнем ряду, 'q'. */
export function findMove(pos, from, to, promo = '') {
  const f = sqIndex(from);
  const t = sqIndex(to);
  if (f < 0 || t < 0) return null;
  const hits = legalMoves(pos).filter((m) => m.from === f && m.to === t);
  if (!hits.length) return null;
  if (hits[0].promo) {
    const want = String(promo || '').toLowerCase();
    return hits.find((m) => m.promo === want) || null; // превращение нужно назвать
  }
  return hits[0];
}

export const needsPromotion = (pos, from, to) => {
  const f = sqIndex(from);
  const t = sqIndex(to);
  return legalMoves(pos).some((m) => m.from === f && m.to === t && m.promo);
};

/* ------------------------------------------------------------- notation */

const LETTER = { N: 'N', B: 'B', R: 'R', Q: 'Q', K: 'K' };

/** Стандартная алгебраическая запись: e4, Nbd7, exd5, O-O, e8=Q+, Qh4#. */
export function san(pos, m) {
  const after = make(pos, m);
  const mark = inCheck(after) ? (legalMoves(after).length ? '+' : '#') : '';
  if (m.castle) return (m.castle === 'K' ? 'O-O' : 'O-O-O') + mark;
  const kind = m.piece.toUpperCase();
  const to = sqName(m.to);
  let s = '';
  if (kind === 'P') {
    if (m.cap) s += FILES[m.from & 7] + 'x';
    s += to;
    if (m.promo) s += '=' + m.promo.toUpperCase();
  } else {
    s += LETTER[kind];
    const rivals = legalMoves(pos).filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
    if (rivals.length) {
      const sameFile = rivals.some((o) => (o.from & 7) === (m.from & 7));
      const sameRank = rivals.some((o) => (o.from >> 3) === (m.from >> 3));
      if (!sameFile) s += FILES[m.from & 7];
      else if (!sameRank) s += (m.from >> 3) + 1;
      else s += sqName(m.from);
    }
    if (m.cap) s += 'x';
    s += to;
  }
  return s + mark;
}

/* --------------------------------------------------------- end of a game */

/**
 * Ключ позиции для троекратного повторения: расстановка, чей ход, рокировки
 * и взятие на проходе — но последнее только если оно вообще возможно (иначе
 * одинаковые позиции считались бы разными из-за пешки, которую никто не бьёт).
 */
export function key(pos) {
  const epLive = pos.ep >= 0 && pseudoMoves(pos).some((m) => m.ep);
  return `${pos.b.map((p) => p || '.').join('')} ${pos.t} ${pos.c} ${epLive ? pos.ep : '-'}`;
}

const squareColor = (s) => ((s >> 3) + (s & 7)) & 1;

/** Нельзя ли поставить мат ни при каком развитии (статья 5.2.2)? */
export function insufficient(b) {
  const rest = [];
  for (let s = 0; s < 64; s++) if (b[s] && b[s].toUpperCase() !== 'K') rest.push([b[s].toUpperCase(), s]);
  if (rest.some(([k]) => k === 'P' || k === 'R' || k === 'Q')) return false;
  if (rest.length <= 1) return true; // король против короля, или с одной лёгкой фигурой
  // Только слоны, и все на клетках одного цвета.
  return rest.every(([k, s]) => k === 'B' && squareColor(s) === squareColor(rest[0][1]));
}

/**
 * Хватит ли у `c` фигур, чтобы поставить мат вообще — для «время вышло»: тот,
 * у кого время осталось, выигрывает, если мат ему ещё возможен (статья 6.9).
 *
 * Голый король не ставит мат никогда. Одна лёгкая фигура (или слоны одного
 * цвета) ставит его только «с помощью» — если у соперника есть чем закрыть
 * собственного короля, то есть что-то кроме короля. Пешка, ладья, ферзь или
 * две разные лёгкие фигуры могут и сами.
 */
export function canMate(b, c) {
  const mine = [];
  let foeHasMore = false;
  for (let s = 0; s < 64; s++) {
    const p = b[s];
    if (!p || p.toUpperCase() === 'K') continue;
    if (colorOf(p) === c) mine.push([p.toUpperCase(), s]);
    else foeHasMore = true;
  }
  if (!mine.length) return false;
  if (mine.some(([k]) => k === 'P' || k === 'R' || k === 'Q')) return true;
  if (mine.length >= 2 && !mine.every(([k, s]) => k === 'B' && squareColor(s) === squareColor(mine[0][1]))) return true;
  return foeHasMore;
}

/**
 * Чем кончилась партия после последнего хода — или null, если идёт дальше.
 * `seen` — сколько раз встречалась каждая позиция (по `key`), включая эту.
 */
export function outcome(pos, seen = {}) {
  if (!legalMoves(pos).length) {
    return inCheck(pos) ? { kind: 'mate', winner: other(pos.t) } : { kind: 'stalemate', winner: null };
  }
  if (insufficient(pos.b)) return { kind: 'insufficient', winner: null };
  if (pos.hm >= 100) return { kind: 'fifty', winner: null };
  if ((seen[key(pos)] || 0) >= 3) return { kind: 'repetition', winner: null };
  return null;
}
