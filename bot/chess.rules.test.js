'use strict';
/**
 * Шахматы за столом (games/chess/rules.js): места, цвета, часы, сдача и
 * ничья, серия партий. Сами ходы фигур — chess.board.test.js (perft); здесь
 * то, что делает доску игрой двух людей.
 *
 * Играют: Иван (id 1, хост) и Макс (id 2). По умолчанию жребий отдаёт хосту
 * белых.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from './games/chess/rules.js';
import { fromFen, toFen, key } from './games/chess/board.js';
import chess from './games/chess/index.js';

const IVAN = { id: 1, name: 'Иван' };
const MAX = { id: 2, name: 'Макс' };
const T0 = 1_000_000;

function table({ base = 600, inc = 0, side = 'random', rand = () => 0.1, start = true } = {}) {
  const room = C.createRoom({ chatId: -1, host: IVAN, base, inc, side });
  C.addPlayer(room, MAX);
  if (start) assert.ok(C.startGame(room, '1', { rand }).ok);
  return room;
}

/** Сыграть ходы подряд, каждый — от того, чей он; часы стоят на `now`. */
function play(room, moves, now = T0) {
  for (const [from, to, promo] of moves) {
    const m = C.live(room);
    const id = C.mover(m) === 'w' ? m.white : m.black;
    const r = C.move(room, id, { from, to, promo }, now);
    assert.ok(r.ok, `${from}${to}: ${r.error}`);
    C.syncTurn(room, now);
  }
}

const FOOLS = [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']];

test('стол на двоих: третий не садится, хост — тоже место', () => {
  const room = table({ start: false });
  assert.equal(C.addPlayer(room, { id: 3, name: 'Дима' }).error, 'TABLE_FULL');
  assert.equal(C.seatedPlayers(room).length, 2);
  assert.equal(C.startBlocker(room), null);
  const lone = C.createRoom({ chatId: -1, host: IVAN });
  assert.equal(C.startGame(lone, '1').error, 'NOT_ENOUGH_PLAYERS');
});

test('начать может только хост; сидеть можно один раз', () => {
  const room = table({ start: false });
  assert.equal(C.startGame(room, '2').error, 'NOT_HOST');
  assert.equal(C.addPlayer(room, MAX).id, '2', 'второй тап — тот же стул');
  assert.equal(C.seatedPlayers(room).length, 2);
  C.startGame(room, '1');
  assert.equal(C.startGame(room, '1').error, 'ALREADY_STARTED');
});

test('цвета: белые/чёрные по настройке хоста, а «случайно» решает жребий', () => {
  assert.equal(table({ side: 'white' }).match.white, '1');
  assert.equal(table({ side: 'black' }).match.black, '1');
  assert.equal(table({ rand: () => 0.1 }).match.white, '1', 'жребий < 0,5 — хост белыми');
  assert.equal(table({ rand: () => 0.9 }).match.white, '2', 'жребий ≥ 0,5 — белыми гость');
});

test('ход: только тот, чей он; чужой и зритель получают отказ', () => {
  const room = table();
  assert.equal(C.move(room, '2', { from: 'e7', to: 'e5' }, T0).error, 'NOT_YOUR_TURN');
  assert.equal(C.move(room, '3', { from: 'e2', to: 'e4' }, T0).error, 'NOT_IN_GAME');
  assert.equal(room.match.moves.length, 0, 'ничего не сыграно');
  assert.ok(C.move(room, '1', { from: 'e2', to: 'e4' }, T0).ok);
  assert.equal(C.move(room, '1', { from: 'd2', to: 'd4' }, T0).error, 'NOT_YOUR_TURN', 'второй ход подряд нельзя');
});

test('ход: незаконный отказ, позиция не меняется', () => {
  const room = table();
  const fen = toFen(room.match.pos);
  for (const bad of [['e2', 'e5'], ['e1', 'e2'], ['a1', 'a3'], ['e7', 'e5'], ['z9', 'e4'], ['e4', 'e5']]) {
    assert.equal(C.move(room, '1', { from: bad[0], to: bad[1] }, T0).error, 'ILLEGAL', bad.join(''));
  }
  assert.equal(toFen(room.match.pos), fen);
});

test('запоздавший ход по старой позиции (ply) не ложится на новую', () => {
  const room = table();
  play(room, [['e2', 'e4']]);
  assert.equal(C.move(room, '2', { from: 'e7', to: 'e5' }, T0, 0).error, 'STALE', 'страница думала, что ходов ещё нет');
  assert.ok(C.move(room, '2', { from: 'e7', to: 'e5' }, T0, 1).ok);
});

test('превращение: без выбранной фигуры — просьба выбрать, а не тихий ферзь', () => {
  const room = table();
  room.match.pos = fromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  assert.equal(C.move(room, '1', { from: 'a7', to: 'a8' }, T0).error, 'NEED_PROMO');
  assert.ok(C.move(room, '1', { from: 'a7', to: 'a8', promo: 'n' }, T0).ok);
  assert.equal(room.match.pos.b[56], 'N');
});

test('детский мат: победа чёрных, партия закрыта, записана в историю', () => {
  const room = table();
  play(room, FOOLS);
  assert.deepEqual(room.match.over, { winner: 'b', kind: 'mate' });
  assert.equal(room.history.length, 1);
  assert.deepEqual({ w: room.history[0].winner, k: room.history[0].kind }, { w: '2', k: 'mate' });
  assert.equal(room.turn, null, 'часы остановлены');
  assert.equal(C.move(room, '1', { from: 'e2', to: 'e4' }, T0).error, 'NOT_PLAYING');
  assert.match(room.notice, /Макс выиграл: мат/);
});

test('пат — ничья без победителя', () => {
  const room = table();
  room.match.pos = fromFen('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1');
  play(room, [['f1', 'f7']]);
  assert.deepEqual(room.match.over, { winner: null, kind: 'stalemate' });
});

test('троекратное повторение — ничья сама', () => {
  const room = table();
  const shuffle = [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']];
  play(room, [...shuffle, ...shuffle]);
  assert.deepEqual(room.match.over, { winner: null, kind: 'repetition' }, 'начальная позиция в третий раз');
});

test('сдаться можно, когда оба сходили; раньше — отмена партии', () => {
  const room = table();
  assert.equal(C.resign(room, '1').error, 'TOO_EARLY');
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  assert.equal(C.abortMatch(room, '1').error, 'TOO_LATE');
  assert.equal(C.resign(room, '3').error, 'NOT_IN_GAME');
  assert.ok(C.resign(room, '2').ok, 'сдаться может и тот, чей сейчас не ход');
  assert.deepEqual(room.match.over, { winner: 'w', kind: 'resign' });
});

test('отмена до начала игры — без результата, и в счёт не идёт', () => {
  const room = table();
  assert.equal(C.abortMatch(room, '3').error, 'NOT_IN_GAME');
  assert.ok(C.abortMatch(room, '2').ok);
  assert.equal(room.match.over.kind, 'aborted');
  assert.equal(room.history[0].aborted, true);
  assert.equal(C.score(room).every((r) => r.games === 0), true);
  assert.match(room.notice, /Макс отменил/);
});

test('ничья по согласию: предложить, принять — и только вторым человеком', () => {
  const room = table();
  assert.equal(C.offerDraw(room, '1').error, 'TOO_EARLY');
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  assert.ok(C.offerDraw(room, '1').offered);
  assert.ok(C.offerDraw(room, '1').noop, 'своё же предложение «принять» нельзя');
  assert.equal(room.match.over, null);
  assert.equal(C.offerDraw(room, '3').error, 'NOT_IN_GAME');
  assert.ok(C.offerDraw(room, '2').accepted);
  assert.deepEqual(room.match.over, { winner: null, kind: 'agreed' });
});

test('ничья: отказ, ход гасит предложение, а повторять сразу нельзя', () => {
  const room = table();
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  C.offerDraw(room, '1', T0);
  assert.equal(C.declineDraw(room, '1').error, 'NO_OFFER', 'свою ничью не «отклонить»');
  assert.ok(C.declineDraw(room, '2').ok);
  assert.equal(C.offerDraw(room, '1', T0 + 30_000).error, 'OFFER_COOLDOWN');
  play(room, [['g1', 'f3'], ['b8', 'c6']]);
  assert.ok(C.offerDraw(room, '1', T0 + 30_000).offered, 'через два хода (и больше 20 секунд) — снова можно');
  play(room, [['f1', 'c4']]);
  assert.equal(room.match.drawOffer, null, 'после хода предложение снято');
});

/* ------------------------------------------------------------------ часы */

test('часы: ход отправляет остаток в партию, прибавка идёт сверху', () => {
  const room = table({ base: 300, inc: 5 });
  play(room, [['e2', 'e4'], ['e7', 'e5']], T0); // первые два хода — без часов партии
  assert.equal(room.match.clock.w, 300_000, 'до сих пор часы не тратились');
  C.syncTurn(room, T0);
  assert.equal(room.turn.deadline, T0 + 300_000, 'у белых идут их 5 минут');
  assert.equal(C.move(room, '1', { from: 'g1', to: 'f3' }, T0 + 40_000).ok, true);
  assert.equal(room.match.clock.w, 300_000 - 40_000 + 5_000, 'потратил 40 с, получил 5 с');
  assert.equal(room.turn, null, 'следующие часы заводит ядро');
  C.syncTurn(room, T0 + 40_000);
  assert.equal(room.turn.remaining, 300_000, 'у чёрных — свои полные 5 минут');
  assert.equal(room.turn.deadline, T0 + 340_000);
});

test('часы: упал флажок — выигрывает соперник, ничего не нужно ждать вечно', () => {
  const room = table({ base: 60 });
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  const turn = C.syncTurn(room, T0);
  assert.equal(C.timeoutMove(room, turn.key, T0 + 59_999).error, 'EARLY');
  assert.ok(C.timeoutMove(room, turn.key, T0 + 60_000).ok);
  assert.deepEqual(room.match.over, { winner: 'b', kind: 'time' });
  assert.equal(room.history[0].winner, '2');
});

test('часы: флажок упал, а таймер ещё не сработал — ход не принимается, время вышло', () => {
  const room = table({ base: 60 });
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  C.syncTurn(room, T0);
  const r = C.move(room, '1', { from: 'g1', to: 'f3' }, T0 + 61_000);
  assert.equal(r.error, 'TIME_UP');
  assert.deepEqual(room.match.over, { winner: 'b', kind: 'time' });
  assert.equal(room.match.moves.length, 2, 'опоздавший ход не сыгран');
});

test('часы: время вышло, но у соперника нечем ставить мат — ничья', () => {
  const room = table({ base: 60 });
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  room.match.pos = fromFen('4k3/8/8/8/8/8/8/3NK3 w - - 0 1'); // у чёрных только король
  const turn = C.syncTurn(room, T0);
  C.timeoutMove(room, turn.key, T0 + 60_000);
  assert.deepEqual(room.match.over, { winner: null, kind: 'time' }, 'у чёрных остался голый король — выиграть на мат он не может, значит ничья');
});

test('первый ход: соперник не пришёл — партия отменяется, а не засчитывается', () => {
  const room = table({ base: 0 }); // без часов партии, но срок на первый ход есть всегда
  const turn = C.syncTurn(room, T0);
  assert.equal(turn.deadline, T0 + C.FIRST_MS);
  assert.ok(C.timeoutMove(room, turn.key, T0 + C.FIRST_MS).ok);
  assert.equal(room.match.over.kind, 'aborted');
  assert.equal(room.history[0].aborted, true);
});

test('без часов: после первых ходов таймера нет вовсе', () => {
  const room = table({ base: 0 });
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  assert.equal(C.syncTurn(room, T0), null);
  assert.equal(room.turn, null);
});

test('часы: ключ меняется с каждым ходом — старый таймер ничего не сломает', () => {
  const room = table({ base: 60 });
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  const old = C.syncTurn(room, T0).key;
  play(room, [['g1', 'f3']], T0 + 1000);
  assert.equal(C.timeoutMove(room, old, T0 + 999_999).error, 'STALE');
  assert.equal(room.match.over, null);
});

test('часы переживают сон бота: сохраняется остаток, а не срок', () => {
  const room = table({ base: 300 });
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  C.syncTurn(room, T0);
  const saved = C.serialize(room, T0 + 100_000);
  assert.equal(saved.turn.deadline, null);
  assert.equal(saved.turn.remaining, 200_000);
  assert.equal(room.turn.deadline, T0 + 300_000, 'живая комната не тронута');
  const back = C.deserialize(JSON.parse(JSON.stringify(saved)));
  C.syncTurn(back, T0 + 9_000_000);
  assert.equal(back.turn.deadline, T0 + 9_200_000, 'после подъёма у него те же 200 секунд');
});

/* -------------------------------------------------------- серия и рейтинг */

test('следующая партия: цвета меняются, счёт копится', () => {
  const room = table();
  play(room, FOOLS);
  assert.equal(C.nextGame(room, '3').error, 'NOT_SEATED');
  assert.ok(C.nextGame(room, '2').ok);
  assert.deepEqual([room.match.white, room.match.black], ['2', '1'], 'теперь Макс белыми');
  assert.equal(room.match.no, 2);
  assert.equal(C.nextGame(room, '1').error, 'GAME_IN_PROGRESS');
  play(room, FOOLS); // теперь мат ставит Иван — чёрными
  assert.deepEqual(C.score(room).map((r) => [r.name, r.wins, r.losses]).sort(), [['Иван', 1, 1], ['Макс', 1, 1]]);
});

test('rounds(): победа — места 1 и 2, ничья и отмена — без проигравшего', () => {
  const room = table();
  play(room, FOOLS);
  C.nextGame(room, '1');
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  C.offerDraw(room, '1');
  C.offerDraw(room, '2');
  C.nextGame(room, '1');
  C.abortMatch(room, '1');
  const [won, drew, aborted] = chess.rounds(room);
  assert.deepEqual(won.places.map((p) => p.id), ['2', '1']);
  assert.equal(won.loserId, '1');
  assert.equal(won.draw, false);
  assert.equal(drew.draw, true);
  assert.equal(drew.loserId, null, 'у ничьей проигравшего нет — иначе рейтинг заплатит за сговор');
  assert.equal(aborted.aborted, true);
  assert.equal(new Set([won.id, drew.id, aborted.id]).size, 3, 'у каждой партии свой id для рейтинга');
});

test('вышел из чата посреди партии — партия отменена, хост передан', () => {
  const room = table();
  C.markLeft(room, '1');
  assert.equal(room.match.over.kind, 'aborted');
  assert.equal(room.hostId, '2');
  assert.match(room.notice, /Иван вышел из чата/);
});

test('хост удаляет гостя: в лобби — просто место, в партии — отмена', () => {
  const lobby = table({ start: false });
  assert.ok(C.kickPlayer(lobby, '1', '2').ok);
  assert.equal(C.seatedPlayers(lobby).length, 1);
  const game = table();
  assert.equal(C.kickPlayer(game, '2', '1').error, 'NOT_HOST');
  assert.equal(C.kickPlayer(game, '1', '1').error, 'CANNOT_KICK_HOST');
  C.kickPlayer(game, '1', '2');
  assert.equal(game.match.over.kind, 'aborted');
  assert.equal(C.addPlayer(game, MAX).error, 'KICKED');
});

test('встать из-за стола посреди партии нельзя — сдаются', () => {
  const room = table();
  assert.equal(C.leave(room, '2').error, 'IN_GAME');
  play(room, FOOLS);
  assert.ok(C.leave(room, '2').ok, 'после партии — можно');
});

test('настройки: хост, не в партии, значения только из списка', () => {
  const room = table({ start: false });
  assert.equal(C.updateSettings(room, '2', { base: 60 }).error, 'NOT_HOST');
  assert.ok(C.updateSettings(room, '1', { base: 180, inc: 2, side: 'black' }).ok);
  assert.deepEqual(room.settings, { base: 180, inc: 2, side: 'black' });
  C.updateSettings(room, '1', { base: 7777, inc: 99, side: 'purple' });
  assert.deepEqual(room.settings, { base: 180, inc: 2, side: 'black' }, 'чужие значения не принимаются');
  C.updateSettings(room, '1', { base: 0 });
  assert.equal(room.settings.inc, 0, 'без часов прибавки нет');
  C.startGame(room, '1');
  assert.equal(C.updateSettings(room, '1', { base: 60 }).error, 'GAME_IN_PROGRESS');
});

test('серию закрывает хост; между партиями — любой из двоих; идущая партия не в счёт', () => {
  const room = table();
  assert.equal(C.endGame(room, '2').error, 'NOT_HOST', 'посреди партии гость серию не закроет');
  play(room, FOOLS);
  assert.ok(C.endGame(room, '2').ok, 'после партии — может');
  assert.equal(room.status, 'finished');
  const live = table();
  C.endGame(live, '1');
  assert.equal(live.history[0].aborted, true);
});

/* ------------------------------------------------------------------ откат */

test('откат: просящий только что сходил — возвращается один полуход, позиция и запись как были', () => {
  const room = table();
  play(room, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']]);
  const before = toFen(room.match.pos);
  play(room, [['b8', 'c6']]);
  C.move(room, '1', { from: 'f1', to: 'c4' }, T0);
  assert.equal(room.match.moves.length, 5);
  assert.ok(C.requestTakeback(room, '1').offered, 'Иван просит вернуть Bc4');
  assert.equal(room.match.moves.length, 5, 'пока соперник не ответил — ничего не меняется');
  assert.ok(C.requestTakeback(room, '2').accepted, 'Макс разрешил');
  assert.equal(room.match.moves.length, 4);
  assert.deepEqual(room.match.moves.map((x) => x.san), ['e4', 'e5', 'Nf3', 'Nc6']);
  assert.notEqual(toFen(room.match.pos), before, 'до Nc6 мы не вернулись — вернули только Bc4');
  assert.equal(room.match.pos.t, 'w', 'ход снова у Ивана');
  assert.equal(room.match.takeback, null);
  assert.ok(C.move(room, '1', { from: 'f1', to: 'b5' }, T0).ok, 'и он может сходить иначе');
});

test('откат: соперник уже ответил — возвращаются оба хода (свой и его)', () => {
  const room = table();
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  const fen = toFen(room.match.pos);
  play(room, [['d2', 'd4'], ['e5', 'd4']]);
  assert.ok(C.requestTakeback(room, '1').offered, 'Иван просит вернуть d4, хотя Макс уже взял');
  assert.ok(C.requestTakeback(room, '2').accepted);
  assert.equal(room.match.moves.length, 2);
  assert.equal(toFen(room.match.pos), fen, 'позиция — ровно до d4');
});

test('откат: просить нельзя, пока не сходил; нельзя второй раз, пока висит; нельзя поверх ничьей', () => {
  const room = table();
  assert.equal(C.requestTakeback(room, '2').error, 'NOTHING_TO_TAKE', 'чёрные ещё не ходили');
  assert.equal(C.requestTakeback(room, '1').error, 'NOTHING_TO_TAKE', 'и белые');
  play(room, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6']]);
  assert.equal(C.requestTakeback(room, '3').error, 'NOT_IN_GAME');
  assert.ok(C.requestTakeback(room, '1').offered);
  assert.ok(C.requestTakeback(room, '1').noop, 'своя же просьба — ничего нового');
  assert.equal(C.offerDraw(room, '1').error, 'OFFER_PENDING', 'ничью поверх просьбы об откате не предложить');
  C.declineTakeback(room, '2');
  C.offerDraw(room, '2');
  assert.equal(C.requestTakeback(room, '1').error, 'OFFER_PENDING', 'и откат — поверх ничьей');
});

test('откат: отказ, ход и конец партии гасят просьбу; повторять сразу нельзя', () => {
  const room = table();
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  C.requestTakeback(room, '1', T0);
  assert.equal(C.declineTakeback(room, '1').error, 'NO_TAKEBACK', 'свою просьбу «отклонить» нельзя');
  assert.ok(C.declineTakeback(room, '2').ok);
  assert.equal(C.requestTakeback(room, '1', T0 + 30_000).error, 'TAKEBACK_COOLDOWN');
  play(room, [['g1', 'f3'], ['b8', 'c6']]);
  assert.ok(C.requestTakeback(room, '1', T0 + 30_000).offered, 'через два хода (и больше 20 секунд) — снова можно');
  C.move(room, '1', { from: 'f1', to: 'c4' }, T0);
  assert.equal(room.match.takeback, null, 'ход гасит просьбу');
  C.requestTakeback(room, '1', T0 + 60_000);
  C.resign(room, '1');
  assert.equal(room.match.takeback, null, 'конец партии — тоже');
  assert.equal(C.requestTakeback(room, '1').error, 'NOT_PLAYING');
});

test('откат: повторения считаются заново — отменённая позиция не остаётся «призраком»', () => {
  const room = table();
  const shuffle = [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']];
  play(room, [...shuffle, ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1']]); // начальная позиция уже дважды
  const ghost = key(room.match.pos);
  assert.equal(room.match.seen[ghost], 2, 'такая позиция была и после третьего полухода');
  C.requestTakeback(room, '1');
  C.requestTakeback(room, '2');
  assert.equal(room.match.moves.length, 6);
  assert.equal(room.match.seen[ghost], 1, 'отменённый ход из счёта убран: осталась только старая встреча');
  play(room, [['f3', 'g1']]); // тот же ход заново
  assert.equal(room.match.seen[ghost], 2, 'снова две встречи, а не три: отмена не оставила следа');
  play(room, [['f6', 'g8']]);
  assert.deepEqual(room.match.over, { winner: null, kind: 'repetition' }, 'а настоящее третье повторение по-прежнему ловится');
});

test('откат: часы возвращаются к моменту до отменённого хода, а время не сгорает', () => {
  const room = table({ base: 300, inc: 5 });
  play(room, [['e2', 'e4'], ['e7', 'e5']], T0);
  C.syncTurn(room, T0);
  assert.equal(C.move(room, '1', { from: 'g1', to: 'f3' }, T0 + 40_000).ok, true);
  assert.equal(room.match.clock.w, 265_000);
  C.requestTakeback(room, '1');
  C.requestTakeback(room, '2');
  assert.equal(room.match.clock.w, 300_000, 'белые снова при своих 5 минутах — Nf3 как будто не было');
  assert.equal(room.match.moves.length, 2);
  C.syncTurn(room, T0 + 50_000);
  assert.equal(room.turn.remaining, 300_000);
});

test('откат: до первого хода белых — стол как в начале, цвета и счёт те же', () => {
  const room = table();
  play(room, [['e2', 'e4']]);
  C.requestTakeback(room, '1');
  C.requestTakeback(room, '2');
  assert.equal(room.match.moves.length, 0);
  assert.equal(toFen(room.match.pos), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(C.syncTurn(room, T0).remaining, C.FIRST_MS, 'снова идёт срок на первый ход');
});

test('откат: стол, сохранённый до появления отката, переживает перезапуск — историю восстановим', () => {
  const room = table();
  play(room, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']]);
  const saved = JSON.parse(JSON.stringify(C.serialize(room, T0)));
  delete saved.match.hist;
  delete saved.match.clk;
  delete saved.match.takeback;
  delete saved.match.noTake;
  const back = C.deserialize(saved);
  assert.equal(back.match.hist.length, 3);
  assert.equal(back.match.hist.at(-1), toFen(room.match.pos));
  C.requestTakeback(back, '1');
  assert.ok(C.requestTakeback(back, '2').accepted);
  assert.deepEqual(back.match.moves.map((x) => x.san), ['e4', 'e5']);
});

/* ------------------------------------------------------------------- КД */

test('КД: откат можно просить не чаще раза в 20 секунд — даже если отказ и два хода уже прошли', () => {
  const room = table();
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  assert.ok(C.requestTakeback(room, '1', T0).offered);
  C.declineTakeback(room, '2');
  play(room, [['g1', 'f3'], ['b8', 'c6']]); // два хода прошли — правило отказа отпустило
  const r = C.requestTakeback(room, '1', T0 + 5_000);
  assert.equal(r.error, 'ASK_TOO_FAST');
  assert.match(r.text, /раз в 20 секунд — подождите ещё 15 с/, 'сказано, сколько ждать');
  assert.equal(room.match.takeback, null, 'просьба не создана и соперник не потревожен');
  assert.equal(C.requestTakeback(room, '1', T0 + 19_999).error, 'ASK_TOO_FAST');
  assert.ok(C.requestTakeback(room, '1', T0 + 20_000).offered, 'ровно через 20 секунд — можно');
});

test('КД: ничью тоже не чаще раза в 20 секунд, а у соперника он свой', () => {
  const room = table();
  play(room, [['e2', 'e4'], ['e7', 'e5']]);
  assert.ok(C.offerDraw(room, '1', T0).offered);
  C.declineDraw(room, '2');
  play(room, [['g1', 'f3'], ['b8', 'c6']]);
  assert.equal(C.offerDraw(room, '1', T0 + 1_000).error, 'ASK_TOO_FAST');
  assert.ok(C.offerDraw(room, '2', T0 + 1_000).offered, 'Макс не ждёт: его КД начинается с его первой просьбы');
  assert.ok(C.offerDraw(room, '1', T0 + 1_000).accepted, 'а принять предложение соперника можно когда угодно — это не просьба');
});

test('КД: откат и ничья считаются раздельно; принять откат КД не мешает', () => {
  const room = table();
  play(room, [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6']]);
  assert.ok(C.offerDraw(room, '1', T0).offered);
  C.declineDraw(room, '2');
  C.requestTakeback(room, '1', T0 + 1_000); // ничья отклонена и ждёт два хода; откат — другая просьба со своим КД
  assert.equal(room.match.takeback?.by, '1', 'просьба об откате создана, хотя ничью просили секунду назад');
  assert.ok(C.requestTakeback(room, '2', T0 + 1_000).accepted, 'Макс разрешил — его КД не нужен');
});
