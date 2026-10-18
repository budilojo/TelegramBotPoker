'use strict';
/**
 * Шашки за столом (games/checkers/rules.js): места, цвета, ход, часы, сдача
 * и ничья, откат, серия партий. Сами ходы — checkers.board.test.js; здесь то,
 * что делает доску игрой двух людей.
 *
 * Играют: Иван (id 1, хост) и Макс (id 2). По умолчанию жребий отдаёт хосту
 * белых.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from './games/checkers/rules.js';
import { fromFen, toFen, key } from './games/checkers/board.js';

const IVAN = { id: 1, name: 'Иван' };
const MAX = { id: 2, name: 'Макс' };
const T0 = 1_000_000;

function table({ base = 600, inc = 0, side = 'random', rand = () => 0.1, start = true } = {}) {
  const room = C.createRoom({ chatId: -1, host: IVAN, base, inc, side });
  C.addPlayer(room, MAX);
  if (start) assert.ok(C.startGame(room, '1', { rand }).ok);
  return room;
}

const moverId = (room) => (C.mover(C.live(room)) === 'w' ? room.match.white : room.match.black);

/** Сыграть ходы подряд, каждый — от того, чей он. */
function play(room, moves, now = T0) {
  for (const mv of moves) {
    const squares = mv.split(/[-:]/);
    const [from, to, path] = [squares[0], squares.at(-1), mv.includes(':') ? squares : null];
    const r = C.move(room, moverId(room), { from, to, path }, now);
    assert.ok(r.ok, `${from}-${to}: ${r.error}`);
    C.syncTurn(room, now);
  }
}

/** Поставить на доску позицию посреди партии (как будто до неё доиграли). */
function setPosition(room, fen, plies = 10) {
  const m = room.match;
  m.pos = fromFen(fen);
  m.seen = { [key(m.pos)]: 1 };
  m.moves = Array.from({ length: plies }, () => ({ n: '…', from: 'a1', to: 'a1', path: [], caps: [], promo: false }));
  m.hist = Array(plies).fill(fen);
  m.clk = Array(plies).fill({ ...m.clock });
  m.sts = Array(plies).fill({ q: 0, k: 0 });
  m.st = { q: 0, k: 0 };
  room.turn = null;
}

test('стол на двоих: третий не садится; начать может только хост', () => {
  const room = table({ start: false });
  assert.equal(C.addPlayer(room, { id: 3, name: 'Дима' }).error, 'TABLE_FULL');
  assert.equal(C.startGame(room, '2').error, 'NOT_HOST');
  assert.ok(C.startGame(room, '1').ok);
  assert.equal(room.game, 'checkers');
  assert.equal(C.startGame(room, '1').error, 'ALREADY_STARTED');
});

test('цвета: по настройке хоста, «случайно» — жребий; первыми ходят белые', () => {
  assert.equal(table({ side: 'white' }).match.white, '1');
  assert.equal(table({ side: 'black' }).match.black, '1');
  assert.equal(table({ rand: () => 0.9 }).match.white, '2');
  assert.equal(C.mover(table().match), 'w');
});

test('ход: только тот, чей он; чужой, зритель и второй ход подряд — отказ', () => {
  const room = table();
  assert.equal(C.move(room, '2', { from: 'b6', to: 'a5' }, T0).error, 'NOT_YOUR_TURN');
  assert.equal(C.move(room, '3', { from: 'c3', to: 'd4' }, T0).error, 'NOT_IN_GAME');
  assert.equal(room.match.moves.length, 0);
  assert.ok(C.move(room, '1', { from: 'c3', to: 'd4' }, T0).ok);
  assert.equal(C.move(room, '1', { from: 'e3', to: 'f4' }, T0).error, 'NOT_YOUR_TURN');
  assert.equal(room.match.moves[0].n, 'c3-d4');
});

test('ход: незаконный — отказ, позиция не меняется', () => {
  const room = table();
  const fen = toFen(room.match.pos);
  for (const [from, to] of [['c3', 'c4'], ['c3', 'e5'], ['a1', 'b2'], ['b6', 'a5'], ['z9', 'd4'], ['d4', 'e5'], ['c3', 'b2']]) {
    assert.equal(C.move(room, '1', { from, to }, T0).error, 'ILLEGAL', `${from}-${to}`);
  }
  assert.equal(toFen(room.match.pos), fen);
});

test('бить обязательно: тихий ход, когда можно бить, — отказ «надо бить»', () => {
  const room = table();
  play(room, ['c3-d4', 'f6-e5']);
  // Белые d4 обязаны бить e5.
  const r = C.move(room, '1', { from: 'a3', to: 'b4' }, T0);
  assert.equal(r.error, 'MUST_CAPTURE');
  assert.ok(C.move(room, '1', { from: 'd4', to: 'f6' }, T0).ok);
  assert.equal(room.match.moves.at(-1).n, 'd4:f6');
  assert.deepEqual(room.match.moves.at(-1).caps, ['e5']);
});

test('две серии на одно поле: без пути — просьба выбрать путь, с путём — ход', () => {
  const room = table();
  setPosition(room, 'W:WKh4,Kd8:Bg1,e3,a5,e5,c7,e7');
  assert.equal(C.move(room, '1', { from: 'd8', to: 'f2' }, T0).error, 'NEED_PATH');
  assert.ok(C.move(room, '1', { from: 'd8', to: 'f2', path: ['d8', 'b6', 'f2'] }, T0).ok);
  assert.deepEqual(room.match.moves.at(-1).caps.sort(), ['c7', 'e3']);
});

test('запоздавший ход по старой позиции (ply) не ложится на новую', () => {
  const room = table();
  play(room, ['c3-d4']);
  assert.equal(C.move(room, '2', { from: 'b6', to: 'a5' }, T0, 0).error, 'STALE');
  assert.ok(C.move(room, '2', { from: 'b6', to: 'a5' }, T0, 1).ok);
});

test('конец: побил последнюю шашку — победа, партия закрыта и записана', () => {
  const room = table();
  setPosition(room, 'W:Wc3:Bd4');
  play(room, ['c3:e5']);
  assert.deepEqual(room.match.over, { winner: 'w', kind: 'nopieces' });
  assert.equal(room.history.at(-1).winner, '1');
  assert.match(room.notice, /Иван выиграл: шашек не осталось/);
  assert.equal(C.live(room), null);
});

test('конец: у соперника нет ходов — победа', () => {
  const room = table();
  setPosition(room, 'W:Wg7,e5,a1:Bh8');
  play(room, ['e5-f6']);
  assert.deepEqual(room.match.over, { winner: 'w', kind: 'blocked' });
});

test('ничья сама: троекратное повторение', () => {
  const room = table();
  setPosition(room, 'W:WKa1:BKa7');
  play(room, ['a1-b2', 'a7-b8', 'b2-a1', 'b8-a7', 'a1-b2', 'a7-b8', 'b2-a1']);
  assert.ok(C.live(room), 'дважды — ещё не ничья');
  play(room, ['b8-a7']);
  assert.deepEqual(room.match.over, { winner: null, kind: 'repetition' });
  assert.match(room.notice, /Ничья: троекратное повторение/);
});

test('ничья сама: 15 ходов дамками — счётчик в партии, ход простой его сбрасывает', () => {
  const room = table();
  setPosition(room, 'W:WKa1,g1:BKa7,h8');
  play(room, ['a1-b2', 'a7-b8']);
  assert.deepEqual(room.match.st, { q: 2, k: 2 });
  play(room, ['g1-h2']);
  assert.equal(room.match.st.k, 0, 'ход простой');
  assert.equal(room.match.st.q, 3, 'соотношение сил то же');
  room.match.st.k = 29;
  play(room, ['b8-a7']);
  assert.deepEqual(room.match.over, { winner: null, kind: 'kings' });
});

test('ничья по согласию: предложить, принять — только вторым человеком', () => {
  const room = table();
  play(room, ['c3-d4', 'b6-a5']);
  assert.ok(C.offerDraw(room, '1', T0).offered);
  assert.equal(C.offerDraw(room, '1', T0).noop, true, 'своё же — не принятие');
  assert.ok(C.offerDraw(room, '2', T0).accepted);
  assert.deepEqual(room.match.over, { winner: null, kind: 'agreed' });
});

test('сдаться можно, когда оба сходили; раньше — только отменить', () => {
  const room = table();
  assert.equal(C.resign(room, '1', T0).error, 'TOO_EARLY');
  play(room, ['c3-d4', 'b6-a5']);
  assert.ok(C.resign(room, '2', T0).ok);
  assert.deepEqual(room.match.over, { winner: 'w', kind: 'resign' });
});

test('часы: упал флажок — проиграл тот, у кого он упал', () => {
  const room = table({ base: 60 });
  play(room, ['c3-d4', 'b6-a5']);
  const t = C.syncTurn(room, T0);
  assert.equal(C.timeoutMove(room, t.key, T0 + 59_000).error, 'EARLY');
  assert.ok(C.timeoutMove(room, t.key, T0 + 60_000).ok);
  assert.deepEqual(room.match.over, { winner: 'b', kind: 'time' });
});

test('часы: флажок упал раньше таймера — ход не принят, партия кончена', () => {
  const room = table({ base: 60 });
  play(room, ['c3-d4', 'b6-a5']);
  C.syncTurn(room, T0);
  const r = C.move(room, '1', { from: 'd4', to: 'c5' }, T0 + 61_000);
  assert.equal(r.error, 'TIME_UP');
  assert.equal(room.match.over.kind, 'time');
});

test('первый ход: соперник не пришёл — партия отменяется, а не засчитывается', () => {
  const room = table();
  play(room, ['c3-d4']);
  const t = C.syncTurn(room, T0);
  assert.ok(C.timeoutMove(room, t.key, T0 + C.FIRST_MS).ok);
  assert.equal(room.match.over.kind, 'aborted');
  assert.ok(room.history.at(-1).aborted);
});

test('откат: вернуть свой ход — позиция, запись и счётчики ничьих как были', () => {
  const room = table();
  setPosition(room, 'W:WKa1,g1:BKa7,h8', 0);
  play(room, ['a1-b2', 'a7-b8']);
  const before = { fen: toFen(room.match.pos), st: { ...room.match.st } };
  play(room, ['b2-c3']);
  assert.equal(room.match.st.k, 3);
  assert.ok(C.requestTakeback(room, '1', T0 + 30_000).offered);
  assert.ok(C.requestTakeback(room, '2', T0 + 30_000).accepted);
  assert.equal(room.match.moves.length, 2);
  assert.deepEqual(room.match.st, before.st, 'счётчики вернулись');
  // Позиция после отката — та, что была после двух ходов (по записанной истории).
  assert.equal(toFen(room.match.pos), before.fen);
});

test('следующая партия: цвета меняются, счёт копится', () => {
  const room = table();
  play(room, ['c3-d4', 'b6-a5']);
  C.resign(room, '2', T0);
  assert.ok(C.nextGame(room, '2').ok);
  assert.equal(room.match.white, '2');
  assert.equal(C.score(room).find((s) => s.id === '1').wins, 1);
});

test('сохранение и загрузка: позиция, счётчики и часы переживают перезапуск', () => {
  const room = table({ base: 300 });
  play(room, ['c3-d4', 'f6-e5']);
  C.syncTurn(room, T0);
  const back = C.deserialize(JSON.parse(JSON.stringify(C.serialize(room, T0 + 5_000))));
  assert.equal(back.game, 'checkers');
  assert.equal(toFen(back.match.pos), toFen(room.match.pos));
  assert.deepEqual(back.match.st, room.match.st);
  assert.equal(back.turn.deadline, null, 'срок не хранится — только остаток');
  assert.equal(back.turn.remaining, room.turn.deadline - (T0 + 5_000));
  // И после загрузки бить по-прежнему обязательно.
  assert.equal(C.move(back, '1', { from: 'a3', to: 'b4' }, T0).error, 'MUST_CAPTURE');
});
