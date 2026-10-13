'use strict';
/**
 * Шахматная доска (games/chess/board.js): ходы и конец партии.
 *
 * Главный тест здесь — perft: число позиций, достижимых за N полуходов,
 * сверено с общеизвестными эталонами (chessprogramming.org/Perft_Results).
 * Рокировка под шахом, взятие на проходе, при котором открывается собственный
 * король, превращение со взятием — всё это даёт неверное число сразу, и
 * поэтому именно эти позиции и взяты.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startPosition, fromFen, toFen, legalMoves, make, findMove, san, perft, outcome, key, inCheck,
  insufficient, canMate, needsPromotion, sqName, sqIndex, START_FEN,
} from './games/chess/board.js';

const PERFT = [
  ['начальная позиция', START_FEN, [20, 400, 8902, 197281]],
  ['Kiwipete (рокировки, взятия, превращения)', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['позиция 3 (взятие на проходе вдоль ряда)', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['позиция 4 (рокировка под боем, превращение со взятием)', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['позиция 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['позиция 6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
];

for (const [name, fen, counts] of PERFT) {
  test(`perft: ${name}`, () => {
    const pos = fromFen(fen);
    counts.forEach((want, i) => assert.equal(perft(pos, i + 1), want, `глубина ${i + 1}`));
  });
}

test('FEN: разобрали и собрали обратно — то же самое', () => {
  for (const [, fen] of PERFT) assert.equal(toFen(fromFen(fen)), fen);
});

test('имена клеток: a1 = 0, h8 = 63', () => {
  assert.equal(sqIndex('a1'), 0);
  assert.equal(sqIndex('h8'), 63);
  assert.equal(sqName(28), 'e4');
  assert.equal(sqIndex('i9'), -1);
});

/** Сыграть партию записью ходов, проверяя каждый. */
function play(moves, pos = startPosition()) {
  const out = [];
  for (const [from, to, promo] of moves) {
    const m = findMove(pos, from, to, promo);
    assert.ok(m, `ход ${from}${to} должен быть законным в ${toFen(pos)}`);
    out.push(san(pos, m));
    pos = make(pos, m);
  }
  return { pos, san: out };
}

test('нотация: детский мат — 1.f3 e5 2.g4 Qh4#', () => {
  const { pos, san: s } = play([['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]);
  assert.deepEqual(s, ['f3', 'e5', 'g4', 'Qh4#']);
  assert.deepEqual(outcome(pos), { kind: 'mate', winner: 'b' });
});

test('нотация: взятие пешкой и шах', () => {
  const { san: s } = play([['e2', 'e4'], ['d7', 'd5'], ['e4', 'd5'], ['d8', 'd5'], ['b1', 'c3'], ['d5', 'e5']]);
  assert.deepEqual(s, ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qe5+']);
});

test('нотация: короткая и длинная рокировка', () => {
  const { pos, san: s } = play([
    ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['e1', 'g1'],
  ]);
  assert.equal(s.at(-1), 'O-O');
  assert.equal(pos.b[sqIndex('f1')], 'R');
  assert.equal(pos.b[sqIndex('g1')], 'K');
  const longer = fromFen('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
  assert.equal(san(longer, findMove(longer, 'e8', 'c8')), 'O-O-O');
});

test('нотация: два коня на одну клетку различаются буквой', () => {
  const pos = fromFen('4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1');
  assert.equal(san(pos, findMove(pos, 'b1', 'd2')), 'Nbd2');
  assert.equal(san(pos, findMove(pos, 'f1', 'd2')), 'Nfd2');
});

test('нотация: если не хватает буквы файла — берём номер ряда, если не хватает обоих — клетку', () => {
  const rows = fromFen('4k3/8/8/R7/8/8/8/R3K3 w - - 0 1');
  assert.equal(san(rows, findMove(rows, 'a1', 'a3')), 'R1a3');
  assert.equal(san(rows, findMove(rows, 'a5', 'a3')), 'R5a3');
});

test('превращение: надо назвать фигуру, без этого хода нет', () => {
  const pos = fromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  assert.ok(needsPromotion(pos, 'a7', 'a8'));
  assert.equal(findMove(pos, 'a7', 'a8'), null);
  assert.equal(findMove(pos, 'a7', 'a8', 'k'), null);
  const m = findMove(pos, 'a7', 'a8', 'q');
  assert.equal(san(pos, m), 'a8=Q+');
  assert.equal(make(pos, m).b[sqIndex('a8')], 'Q');
  assert.equal(make(pos, findMove(pos, 'a7', 'a8', 'n')).b[sqIndex('a8')], 'N');
});

test('взятие на проходе: только сразу, и снимает пешку', () => {
  const a = play([['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']]).pos;
  const m = findMove(a, 'e5', 'd6');
  assert.ok(m?.ep);
  assert.equal(san(a, m), 'exd6');
  const after = make(a, m);
  assert.equal(after.b[sqIndex('d5')], '');
  // ход позже — права на проход уже нет
  const later = make(make(a, findMove(a, 'h2', 'h3')), findMove(make(a, findMove(a, 'h2', 'h3')), 'h7', 'h6'));
  assert.equal(findMove(later, 'e5', 'd6'), null);
});

test('рокировка: нельзя из-под шаха, через битое поле и после хода ладьи', () => {
  const free = fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.ok(findMove(free, 'e1', 'g1') && findMove(free, 'e1', 'c1'));
  const checked = fromFen('r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1');
  assert.equal(findMove(checked, 'e1', 'g1'), null, 'король под шахом');
  const passes = fromFen('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1');
  assert.equal(findMove(passes, 'e1', 'g1'), null, 'король проходит через битое f1');
  assert.ok(findMove(passes, 'e1', 'c1'), 'длинная при этом можно');
  // ладья ушла и вернулась: права на эту сторону нет
  let pos = free;
  for (const [f, t] of [['h1', 'h2'], ['a8', 'a7'], ['h2', 'h1'], ['a7', 'a8']]) pos = make(pos, findMove(pos, f, t));
  assert.equal(findMove(pos, 'e1', 'g1'), null);
  assert.ok(findMove(pos, 'e1', 'c1'));
});

test('связанная фигура не ходит, шах нужно отразить', () => {
  const pinned = fromFen('4k3/8/8/8/8/8/4r3/4KN2 w - - 0 1');
  assert.equal(legalMoves(pinned).filter((m) => m.piece === 'N').length, 0);
  const check = fromFen('4k3/8/8/8/8/8/3r4/4K3 w - - 0 1');
  assert.ok(legalMoves(check).every((m) => m.piece === 'K'));
});

test('пат — ничья, мат — победа', () => {
  assert.deepEqual(outcome(fromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')), { kind: 'stalemate', winner: null });
  assert.deepEqual(outcome(fromFen('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1')), { kind: 'mate', winner: 'w' });
});

test('недостаточно материала: король, король+лёгкая, слоны одного цвета', () => {
  assert.ok(insufficient(fromFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1').b));
  assert.ok(insufficient(fromFen('4k3/8/8/8/8/8/8/3NK3 w - - 0 1').b));
  assert.ok(insufficient(fromFen('4k3/8/8/8/8/8/8/2B1K3 w - - 0 1').b));
  assert.ok(insufficient(fromFen('3bk3/8/8/8/8/8/8/2B1K3 w - - 0 1').b), 'слоны c1 и d8 — оба на тёмных клетках');
  assert.ok(!insufficient(fromFen('2b1k3/8/8/8/8/8/8/2B1K3 w - - 0 1').b), 'слоны c1 (тёмная) и c8 (светлая) — разных цветов');
  assert.ok(!insufficient(fromFen('4k3/8/8/8/8/8/P7/4K3 w - - 0 1').b), 'пешка может стать ферзём');
  assert.ok(!insufficient(fromFen('4k3/8/8/8/8/8/8/2NNK3 w - - 0 1').b));
});

test('время вышло: выигрыш, только если мат вообще возможен', () => {
  const lone = fromFen('4k3/8/8/8/8/8/8/3NK3 w - - 0 1').b;
  assert.equal(canMate(lone, 'w'), false, 'король+конь против голого короля — ничья');
  const pawn = fromFen('4k3/8/8/8/8/8/P7/4K3 w - - 0 1').b;
  assert.equal(canMate(pawn, 'w'), true);
  const help = fromFen('4k3/p7/8/8/8/8/8/3NK3 w - - 0 1').b;
  assert.equal(canMate(help, 'w'), true, 'у соперника есть пешка — мат «с помощью» возможен');
  const naked = fromFen('4k3/8/8/8/8/8/8/3NK3 w - - 0 1').b;
  assert.equal(canMate(naked, 'b'), false, 'голый король не ставит мат, даже против коня');
});

test('правило 50 ходов и троекратное повторение', () => {
  const quiet = fromFen('4k3/8/8/8/8/8/8/R3K3 w - - 100 80');
  assert.deepEqual(outcome(quiet), { kind: 'fifty', winner: null });
  assert.equal(outcome(fromFen('4k3/8/8/8/8/8/8/R3K3 w - - 99 80')), null);
  const pos = startPosition();
  assert.equal(outcome(pos, { [key(pos)]: 2 }), null);
  assert.deepEqual(outcome(pos, { [key(pos)]: 3 }), { kind: 'repetition', winner: null });
});

test('ключ позиции не различает «проход, которого не будет»', () => {
  const a = play([['e2', 'e4']]).pos;
  const b = fromFen(toFen(a).replace(/ e3 /, ' - '));
  assert.equal(key(a), key(b), 'на e3 никто не может бить на проходе');
});

test('шах определяется после хода', () => {
  const { pos } = play([['e2', 'e4'], ['f7', 'f5'], ['d1', 'h5']]);
  assert.ok(inCheck(pos));
  assert.equal(legalMoves(pos).length, 1, 'единственный ответ — g6');
});
