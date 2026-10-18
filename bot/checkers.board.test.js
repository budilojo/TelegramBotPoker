'use strict';
/**
 * Доска русских шашек (games/checkers/board.js): ходы и конец партии.
 *
 * Сверка — с трёх сторон:
 *   1. perft от начальной позиции — с опубликованными числами (глубины 1–6
 *      совпадают в двух независимых источниках и у pydraughts; 7 и 8 —
 *      посчитаны pydraughts 0.6.7, см. docs/checkers.md);
 *   2. 400 позиций из случайных партий (большей частью с дамками и сериями) —
 *      с pydraughts: числа и отпечатки списков позиций после хода лежат в
 *      checkers.oracle.json (как его пересобрать — tools/checkers-oracle.py);
 *   3. с медленным генератором, написанным здесь заново и иначе: координаты,
 *      копии досок, итог хода — готовая доска. Ошибка, повторённая в обоих
 *      генераторах одинаково, маловероятна.
 * Плюс каждое правило из docs/checkers.md — отдельным примером.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  startPosition, fromFen, toFen, legalMoves, make, perft, findMove, notation, outcome, drawKind, counters,
  mustCapture, key, sqName, sqIndex, isDark, DRAW,
} from './games/checkers/board.js';

const PERFT = [7, 49, 302, 1469, 7482, 37986, 190146];

test('perft от начальной позиции: 7, 49, 302, 1469, 7482, 37986, 190146', () => {
  const pos = startPosition();
  PERFT.forEach((want, i) => assert.equal(perft(pos, i + 1), want, `глубина ${i + 1}`));
});

/* --------------------------------------------- медленный генератор для сверки */

/** Позиция как сетка g[y][x] ('.', w, b, W, B) и чей ход. */
function grid(fen) {
  const p = fromFen(fen);
  const g = Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (__, x) => p.b[y * 8 + x] || '.'));
  return { g, t: p.t };
}
const gridKey = (g, t) => g.map((r) => r.join('')).join('/') + t;
const mineP = (ch, t) => ch !== '.' && ch.toLowerCase() === t;
const theirs = (ch, t) => ch !== '.' && ch.toLowerCase() !== t;

/** Все позиции после одного хода — множество ключей. Правила записаны заново, без board.js. */
function slowKids(g, t) {
  const ds = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
  const finalRow = t === 'w' ? 7 : 0;
  const results = new Set();
  let anyCapture = false;

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (!mineP(g[y][x], t)) continue;
      const startKing = g[y][x] === g[y][x].toUpperCase();
      // Поиск в глубину: на каждом шаге — копия доски, побитые помечены 'x' (стоят до конца хода).
      const stack = [{ b: g.map((r) => r.slice()), x, y, king: startKing, n: 0 }];
      stack[0].b[y][x] = '.';
      while (stack.length) {
        const s = stack.pop();
        const nexts = [];
        for (const [dx, dy] of ds) {
          if (s.king) {
            let cx = s.x + dx;
            let cy = s.y + dy;
            while (inside(cx, cy) && s.b[cy][cx] === '.') { cx += dx; cy += dy; }
            if (!inside(cx, cy) || !theirs(s.b[cy][cx], t) || s.b[cy][cx] === 'x') continue;
            const lands = [];
            for (let lx = cx + dx, ly = cy + dy; inside(lx, ly) && s.b[ly][lx] === '.'; lx += dx, ly += dy) lands.push([lx, ly]);
            const made = lands.map(([lx, ly]) => {
              const b = s.b.map((r) => r.slice());
              b[cy][cx] = 'x';
              return { b, x: lx, y: ly, king: true, n: s.n + 1 };
            });
            const cont = made.filter((m) => canJump(m));
            nexts.push(...(cont.length ? cont : made));
          } else {
            const cx = s.x + dx;
            const cy = s.y + dy;
            const lx = cx + dx;
            const ly = cy + dy;
            if (!inside(lx, ly) || !theirs(s.b[cy][cx], t) || s.b[cy][cx] === 'x' || s.b[ly][lx] !== '.') continue;
            const b = s.b.map((r) => r.slice());
            b[cy][cx] = 'x';
            nexts.push({ b, x: lx, y: ly, king: ly === finalRow, n: s.n + 1 });
          }
        }
        if (nexts.length) stack.push(...nexts);
        else if (s.n > 0) {
          anyCapture = true;
          const b = s.b.map((r) => r.map((ch) => (ch === 'x' ? '.' : ch)));
          b[s.y][s.x] = s.king ? t.toUpperCase() : t;
          results.add(gridKey(b, t === 'w' ? 'b' : 'w'));
        }
      }
    }
  }

  function canJump(s) {
    for (const [dx, dy] of ds) {
      let cx = s.x + dx;
      let cy = s.y + dy;
      while (inside(cx, cy) && s.b[cy][cx] === '.') { cx += dx; cy += dy; }
      if (inside(cx, cy) && theirs(s.b[cy][cx], t) && s.b[cy][cx] !== 'x' && inside(cx + dx, cy + dy) && s.b[cy + dy][cx + dx] === '.') return true;
    }
    return false;
  }

  if (anyCapture) return results;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (!mineP(g[y][x], t)) continue;
      const king = g[y][x] === g[y][x].toUpperCase();
      for (const [dx, dy] of ds) {
        if (!king && dy !== (t === 'w' ? 1 : -1)) continue;
        for (let nx = x + dx, ny = y + dy; inside(nx, ny) && g[ny][nx] === '.'; nx += dx, ny += dy) {
          const b = g.map((r) => r.slice());
          b[y][x] = '.';
          b[ny][nx] = king || ny === finalRow ? t.toUpperCase() : t;
          results.add(gridKey(b, t === 'w' ? 'b' : 'w'));
          if (!king) break;
        }
      }
    }
  }
  return results;
}

const fastKids = (fen) => {
  const p = fromFen(fen);
  return legalMoves(p).map((m) => {
    const q = make(p, m);
    return gridKey(Array.from({ length: 8 }, (_, y) => Array.from({ length: 8 }, (__, x) => q.b[y * 8 + x] || '.')), q.t);
  });
};

function slowPerft(g, t, d) {
  if (d === 0) return 1;
  let n = 0;
  for (const k of slowKids(g, t)) {
    const [rows, tt] = [k.slice(0, -1).split('/'), k.at(-1)];
    n += d === 1 ? 1 : slowPerft(rows.map((r) => r.split('')), tt, d - 1);
  }
  return n;
}

test('perft 8 = 929899: у pydraughts 929905 — те же позиции, но шесть серий-двойников он считает двумя ходами', () => {
  // Сверено при разработке: без склейки двойников (одни побитые, один конец)
  // наш генератор даёт ровно 929905, как pydraughts. См. docs/checkers.md.
  assert.equal(perft(startPosition(), 8), 929899);
});

test('медленный генератор, написанный заново, даёт те же perft от начала (глубины 1–5)', () => {
  const { g, t } = grid(toFen(startPosition()));
  PERFT.slice(0, 5).forEach((want, i) => assert.equal(slowPerft(g, t, i + 1), want, `глубина ${i + 1}`));
});

const ORACLE = JSON.parse(fs.readFileSync(new URL('./checkers.oracle.json', import.meta.url), 'utf8'));

/** Отпечаток списка позиций после хода — так же, как в tools/checkers-oracle.py. */
function digest(fen) {
  const p = fromFen(fen);
  const norm = (q) => {
    const f = toFen(q).split(':');
    const side = (s) => s.slice(1).split(',').filter(Boolean).sort().join(',');
    return `${f[0]}:W${side(f[1])}:B${side(f[2])}`;
  };
  const kids = [...new Set(legalMoves(p).map((m) => norm(make(p, m))))].sort();
  return crypto.createHash('sha1').update(kids.join('|')).digest('hex').slice(0, 16);
}

test('400 позиций из случайных партий — ходы как у pydraughts (другая реализация правил)', () => {
  assert.equal(ORACLE.positions.length, 400);
  assert.ok(ORACLE.positions.filter((r) => r.fen.includes('K')).length > 200, 'большая часть — с дамками');
  for (const r of ORACLE.positions) {
    const p = fromFen(r.fen);
    assert.equal(legalMoves(p).length, r.moves, `${r.fen}: число ходов`);
    assert.equal(perft(p, 2), r.p2, `${r.fen}: perft 2`);
    assert.equal(digest(r.fen), r.kids, `${r.fen}: позиции после хода`);
  }
});

test('те же 400 позиций — ходы как у медленного генератора', () => {
  for (const r of ORACLE.positions) {
    const { g, t } = grid(r.fen);
    const slow = slowKids(g, t);
    const fast = fastKids(r.fen);
    assert.equal(fast.length, slow.size, `${r.fen}: ходов столько же, сколько разных позиций`);
    assert.deepEqual(new Set(fast), slow, r.fen);
  }
});

/* ------------------------------------------------------------- правила */

const moves = (fen) => legalMoves(fromFen(fen)).map(notation).sort();

test('начало: по 12 шашек на тёмных полях трёх ближних рядов, a1 тёмное, первыми ходят белые', () => {
  const p = startPosition();
  assert.ok(isDark(sqIndex('a1')));
  assert.ok(!isDark(sqIndex('b1')));
  assert.equal(p.t, 'w');
  assert.equal(p.b.filter((x) => x === 'w').length, 12);
  assert.equal(p.b.filter((x) => x === 'b').length, 12);
  p.b.forEach((x, i) => x && assert.ok(isDark(i), `${sqName(i)} — светлое поле`));
  assert.equal(toFen(p), 'W:Wa1,c1,e1,g1,b2,d2,f2,h2,a3,c3,e3,g3:Bb6,d6,f6,h6,a7,c7,e7,g7,b8,d8,f8,h8');
  assert.deepEqual(moves(toFen(p)), ['a3-b4', 'c3-b4', 'c3-d4', 'e3-d4', 'e3-f4', 'g3-f4', 'g3-h4']);
});

test('простая ходит на одно поле вперёд по диагонали — и только вперёд', () => {
  assert.deepEqual(moves('W:Wd4:Bh8'), ['d4-c5', 'd4-e5']);
  assert.deepEqual(moves('B:Wa1:Bd4'), ['d4-c3', 'd4-e3']);
});

test('простая бьёт и вперёд, и назад', () => {
  assert.deepEqual(moves('W:Wd4:Bc3,h8'), ['d4:b2']);
  assert.deepEqual(moves('W:Wd4:Be5,h8'), ['d4:f6']);
});

test('бить обязательно: пока можно бить, тихих ходов нет', () => {
  const ms = moves('W:Wa1,d4:Be5,h8');
  assert.deepEqual(ms, ['d4:f6']);
  assert.deepEqual(mustCapture(fromFen('W:Wa1,d4:Be5,h8')).map(sqName), ['d4']);
  assert.equal(findMove(fromFen('W:Wa1,d4:Be5,h8'), 'a1', 'b2'), null, 'тихий ход при обязательном взятии не находится');
});

test('бить наибольшее число не обязательно: можно выбрать любую серию', () => {
  // c3 бьёт одну (d4) или две (b4, b6 … нет): белая c3, чёрные d4 и b4, b6 пусто → c3:e5 или c3:a5:c7.
  const ms = moves('W:Wc3:Bd4,b4,b6,h8');
  assert.ok(ms.includes('c3:e5'), 'одна шашка');
  assert.ok(ms.includes('c3:a5:c7'), 'две шашки');
});

test('серию нужно довести до конца: остановиться посередине нельзя', () => {
  // c3:e5 и дальше e5:g7 — значит, «c3:e5» отдельным ходом нет.
  const ms = moves('W:Wc3:Bd4,f6,a7');
  assert.deepEqual(ms, ['c3:e5:g7']);
  assert.equal(findMove(fromFen('W:Wc3:Bd4,f6,a7'), 'c3', 'e5'), null);
});

test('дамка ходит на любое поле по диагонали, через свои не прыгает', () => {
  assert.equal(moves('W:WKa1:Ba7').length, 7, 'вся большая дорога, b2…h8');
  assert.deepEqual(moves('W:WKa1,d4:Ba7').filter((m) => m.startsWith('a1')), ['a1-b2', 'a1-c3']);
});

test('дамка бьёт издалека и встаёт на любое свободное поле за побитой', () => {
  assert.deepEqual(moves('W:WKa1:Bd4,a7'), ['a1:e5', 'a1:f6', 'a1:g7', 'a1:h8']);
});

test('дамка встаёт только туда, откуда может бить дальше, — если такое поле есть', () => {
  // За d4 — e5, f6, g7, h8; бить дальше можно только с f6 (по g5).
  assert.deepEqual(moves('W:WKa1:Bd4,g5,a7'), ['a1:f6:h4']);
});

test('турецкий удар: побитая стоит до конца хода — второй раз через неё нельзя, и она загораживает', () => {
  // a1 бьёт c3, e3, g3, g5, e5; путь …f6:d4 (через e5) должен встать на d4: дальше по
  // той же диагонали — уже побитая c3. Без турецкого удара он ушёл бы на c3, b2, a1.
  const p = fromFen('W:WKa1:Bc3,e3,g3,g5,e5,h8');
  const all = legalMoves(p);
  const five = all.filter((m) => m.caps.length === 5);
  assert.ok(five.some((m) => sqName(m.to) === 'd4'), five.map(notation).join(' '));
  for (const m of all) {
    assert.equal(new Set(m.caps).size, m.caps.length, 'ни одну не бьют дважды');
    if (m.caps.includes(sqIndex('c3')) && m.caps.includes(sqIndex('e5'))) {
      assert.ok(!['c3', 'b2', 'a1'].includes(sqName(m.to)), `${notation(m)}: прошла сквозь побитую c3`);
    }
  }
  // Побитые снимаются в конце хода — разом.
  const after = make(p, five[0]);
  for (const s of ['c3', 'e3', 'g3', 'g5', 'e5']) assert.equal(after.b[sqIndex(s)], '', s);
});

test('простая, дошедшая до края в середине серии, бьёт дальше уже дамкой', () => {
  // b6:d8 — край; с d8 простая f6 не достаёт, дамка — достаёт.
  const ms = legalMoves(fromFen('W:Wb6:Bc7,f6,a1'));
  assert.deepEqual(ms.map(notation).sort(), ['b6:d8:g5', 'b6:d8:h4']);
  assert.ok(ms.every((m) => m.promo));
  assert.equal(make(fromFen('W:Wb6:Bc7,f6,a1'), ms[0]).b[ms[0].to], 'W');
});

test('простая, дошедшая до края взятием, а бить дальше нечем, — встаёт дамкой', () => {
  const ms = legalMoves(fromFen('W:Wb6:Bc7,a1'));
  assert.deepEqual(ms.map(notation), ['b6:d8']);
  assert.ok(ms[0].promo);
});

test('тихий ход на последний ряд — дамка; бить сможет только следующим ходом', () => {
  const ms = legalMoves(fromFen('W:Wc7:Ba1,g7'));
  const up = ms.find((m) => notation(m) === 'c7-d8');
  assert.ok(up?.promo);
  assert.equal(make(fromFen('W:Wc7:Ba1,g7'), up).b[sqIndex('d8')], 'W');
});

test('нотация: тихий через дефис, взятие через двоеточие по всем полям', () => {
  assert.equal(notation(legalMoves(fromFen('W:Wd4:Bh8')).find((m) => sqName(m.to) === 'c5')), 'd4-c5');
  assert.equal(notation(legalMoves(fromFen('W:Wc3:Bd4,f6,a7'))[0]), 'c3:e5:g7');
});

test('ход по пути: разные серии с одним концом различаются тем, кого бьют', () => {
  // Дамка d8 → f2 двумя дорогами: через f6 и d4 (бьёт e7, e5, e3) или через b6 (c7, e3).
  // pydraughts на этой позиции даёт те же четыре хода.
  const p = fromFen('W:WKh4,Kd8:Bg1,e3,a5,e5,c7,e7');
  assert.deepEqual(legalMoves(p).map(notation).sort(), ['d8:b6:f2', 'd8:f6:d4:f2', 'd8:g5:c1', 'd8:g5:d2']);
  assert.deepEqual(findMove(p, 'd8', 'f2'), { ambiguous: true }, 'без пути — неоднозначно');
  assert.equal(notation(findMove(p, 'd8', 'f2', ['d8', 'b6', 'f2'])), 'd8:b6:f2');
  assert.equal(notation(findMove(p, 'd8', 'f2', ['b6', 'f2'])), 'd8:b6:f2', 'поле «откуда» в пути можно не повторять');
  assert.equal(notation(findMove(p, 'd8', 'f2', ['d8', 'f6', 'd4', 'f2'])), 'd8:f6:d4:f2');
  assert.equal(findMove(p, 'd8', 'f2', ['d8', 'f6', 'c5', 'f2']), null, 'f6 → c5 — не диагональ');
  assert.equal(findMove(p, 'd8', 'g5'), null, 'на g5 серия не кончается');
  assert.equal(notation(findMove(p, 'd8', 'd2')), 'd8:g5:d2', 'один ход — путь не нужен');
  // Чужой или кривой путь — не ход.
  assert.equal(findMove(p, 'd8', 'f2', ['d8', 'f2']), null, 'отрезок с двумя шашками');
  assert.equal(findMove(p, 'd8', 'f2', ['d8', 'a5', 'f2']), null, 'бьёт свою дорогу не так');
  assert.equal(findMove(p, 'd8', 'f2', ['d8', 'b6', 'g1']), null, 'кончается не там');
  assert.equal(findMove(p, 'd8', 'f2', ['zz']), null);
  // Тихий ход с путём «откуда, куда» — тот же ход (так шлёт бот); путь подлиннее — нет.
  const quiet = fromFen('W:Wd4:Bh8');
  assert.equal(notation(findMove(quiet, 'd4', 'c5', ['d4', 'c5'])), 'd4-c5');
  assert.equal(findMove(quiet, 'd4', 'c5', ['d4', 'e5', 'c5']), null);
});

test('один ход или два: серии с теми же побитыми и тем же концом — один ход', () => {
  // Дамка b8 бьёт d6 и g3: встать после d6 можно на e5 или f4 — с обоих полей
  // бьёт g3 и кончает на h2. Позиция после хода одна; pydraughts считает это
  // двумя ходами, мы — одним (docs/checkers.md, «Один ход или два»).
  const p = fromFen('W:Wa3,e3,b4,Kb8:Bg3,d6');
  const ms = legalMoves(p);
  assert.equal(ms.length, 1, ms.map(notation).join(' '));
  assert.equal(sqName(ms[0].to), 'h2');
  assert.deepEqual(ms[0].caps.map(sqName).sort(), ['d6', 'g3']);
});

test('конец: нет шашек или нет ходов — проиграл тот, чей ход', () => {
  assert.deepEqual(outcome(fromFen('B:Wd4:B')), { winner: 'w', kind: 'nopieces' });
  // Чёрная a1? нет — чёрная h8 заперта: g7 занято белой, бить её некуда (f6 занято).
  assert.deepEqual(outcome(fromFen('B:Wg7,f6,e5:Bh8')), { winner: 'w', kind: 'blocked' });
  assert.equal(outcome(startPosition()), null);
});

/* ---------------------------------------------------------- ничьи по правилам */

test('троекратное повторение позиции (с тем же ходом) — ничья', () => {
  const p = fromFen('W:WKa1:BKh8');
  assert.equal(drawKind(p, {}, { [key(p)]: 2 }), null);
  assert.equal(drawKind(p, {}, { [key(p)]: 3 }), 'repetition');
  assert.notEqual(key(p), key({ ...p, t: 'b' }), 'очередь хода — часть позиции');
});

test('15 ходов подряд только дамками, без взятий и без ходов простыми — ничья', () => {
  const p = fromFen('W:WKa1,c1:BKh8,h6');
  assert.equal(drawKind(p, { q: 0, k: 29 }), null);
  assert.equal(drawKind(p, { q: 0, k: 30 }), 'kings');
  // Счётчик: ход дамкой +1, ход простой и взятие — с нуля.
  const kingMove = legalMoves(p).find((m) => sqName(m.from) === 'a1');
  const manMove = legalMoves(p).find((m) => sqName(m.from) === 'c1');
  assert.equal(counters({ q: 4, k: 4 }, p, kingMove).k, 5);
  assert.equal(counters({ q: 4, k: 4 }, p, manMove).k, 0);
  const cap = legalMoves(fromFen('W:WKa1:Bd4,h8'))[0];
  assert.deepEqual(counters({ q: 9, k: 9 }, fromFen('W:WKa1:Bd4,h8'), cap), { q: 0, k: 0 });
});

test('у обоих дамки, соотношение сил не меняется: 2–3 фигуры — 5 ходов, 4–5 — 30, 6–7 — 60', () => {
  const three = fromFen('W:WKa1,Kc1:BKh8');
  assert.equal(drawKind(three, { q: 9 }), null);
  assert.equal(drawKind(three, { q: 10 }), 'balance');
  const five = fromFen('W:WKa1,c1,e1:BKh8,h6');
  assert.equal(drawKind(five, { q: 59 }), null);
  assert.equal(drawKind(five, { q: 60 }), 'balance');
  const seven = fromFen('W:WKa1,c1,e1,g1:BKh8,h6,f8');
  assert.equal(drawKind(seven, { q: 119 }), null);
  assert.equal(drawKind(seven, { q: 120 }), 'balance');
  assert.equal(drawKind(fromFen('W:WKa1,c1,e1,g1:BKh8,h6,f8,d8'), { q: 999 }), null, 'восемь фигур — без счёта');
  assert.equal(drawKind(fromFen('W:Wa3,c1:BKh8'), { q: 999 }), null, 'дамка только у одного — правило не действует');
  // Превращение меняет соотношение сил: счётчик с нуля.
  const promo = legalMoves(fromFen('W:Wc7:BKh2')).find((m) => m.promo);
  assert.equal(counters({ q: 7, k: 0 }, fromFen('W:Wc7:BKh2'), promo).q, 0);
});

test('три фигуры против одинокой дамки на большой дороге: не поймал своим 5-м ходом — ничья', () => {
  // Сейчас ход чёрных: последний полуход сделали белые (сильные).
  const p = fromFen('B:WKb2,c1,e1:BKd4');
  assert.equal(drawKind(p, { q: 8 }), null, 'четыре хода белых');
  assert.equal(drawKind(p, { q: 9 }), 'lone', 'пятый ход белых');
  assert.equal(drawKind(fromFen('B:WKb2,c1,e1:BKd2'), { q: 9 }), null, 'дамка не на большой дороге — этот счёт не действует');
});

test('три дамки и больше против одинокой дамки: не поймал своим 15-м ходом — ничья', () => {
  const p = fromFen('B:WKb2,Kc1,Ke1:BKd2');
  assert.equal(drawKind(p, { q: 28 }), null);
  assert.equal(drawKind(p, { q: 29 }), 'lone');
  assert.equal(drawKind(fromFen('B:WKb2,Kc1,Ke1,g1:BKd2'), { q: 29 }), 'lone', 'и с простыми');
  assert.equal(drawKind(fromFen('B:WKb2,Kc1,e1,g1:BKd2'), { q: 29 }), null, 'дамок только две');
  assert.equal(DRAW.LONE_KINGS, 15);
});

test('FEN туда и обратно; имена полей', () => {
  for (const r of ORACLE.positions.slice(0, 50)) {
    const back = toFen(fromFen(r.fen));
    assert.deepEqual(fromFen(back), fromFen(r.fen));
  }
  assert.equal(sqIndex('a1'), 0);
  assert.equal(sqName(63), 'h8');
  assert.throws(() => fromFen('W:Wb1:B'), /не тёмное/);
});
