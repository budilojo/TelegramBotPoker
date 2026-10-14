import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from './games/chess/rules.js';
import chess from './games/chess/index.js';
import { fromFen, toFen } from './games/chess/board.js';
import { Table, user, FakeClock } from './harness.js';
import { Store } from './store.js';

const NOW = 1_000_000;
const A = user(101, 'Иван'), B = user(202, 'Макс');
const opening = [['e2', 'e4'], ['e7', 'e5']];
const longGame = [...opening, ['g1', 'f3'], ['b8', 'c6'], ['f1', 'c4'], ['f8', 'c5'], ['c2', 'c3'], ['g8', 'f6'],
  ['d2', 'd3'], ['d7', 'd6'], ['e1', 'g1'], ['e8', 'g8'], ['b1', 'd2'], ['a7', 'a6'], ['d2', 'b3'], ['c5', 'b6'],
  ['c1', 'g5'], ['h7', 'h6'], ['g5', 'h4'], ['c8', 'g4']];

function roomAt(plies = 2, base = 60) {
  const room = C.createRoom({ chatId: -1, host: { id: 101, name: 'Иван' }, base, side: 'white' });
  C.addPlayer(room, { id: 202, name: 'Макс' });
  C.startGame(room, '101');
  C.syncTurn(room, NOW);
  for (const [i, [from, to]] of opening.slice(0, plies).entries()) {
    assert.ok(C.move(room, i ? '202' : '101', { from, to }, NOW).ok);
    C.syncTurn(room, NOW);
  }
  return room;
}

for (const base of [0, 60]) for (const plies of [0, 1]) for (const delta of [-1, 0, 1]) {
  test(`срок первого хода: base=${base}, полуходов=${plies}, граница ${delta} мс`, () => {
    const room = roomAt(plies, base);
    const [from, to] = opening[plies];
    const r = C.move(room, plies ? '202' : '101', { from, to }, room.turn.deadline + delta);
    if (delta < 0) {
      assert.ok(r.ok);
      assert.equal(room.match.over, null);
    } else {
      assert.deepEqual(r, { error: 'TIME_UP', ended: true });
      assert.deepEqual(room.match.over, { winner: null, kind: 'aborted' });
      assert.equal(room.match.moves.length, plies);
      assert.equal(room.history.length, 1);
    }
  });
}

for (const action of ['move', 'takeback', 'draw', 'resign', 'kick', 'left', 'finish']) {
  test(`истёкший срок имеет приоритет: ${action}`, () => {
    const room = roomAt();
    if (action === 'takeback') C.requestTakeback(room, '202', NOW);
    if (action === 'draw') C.offerDraw(room, '101', NOW);
    const fen = toFen(room.match.pos), deadline = room.turn.deadline, key = room.turn.key;
    const apply = () => ({
      move: () => C.move(room, '101', { from: 'g1', to: 'f3' }, deadline),
      takeback: () => C.requestTakeback(room, '101', deadline),
      draw: () => C.offerDraw(room, '202', deadline),
      resign: () => C.resign(room, '202', deadline), // иначе победит уже просрочивший белый
      kick: () => C.kickPlayer(room, '101', '202', deadline),
      left: () => C.markLeft(room, '101', deadline),
      finish: () => C.endGame(room, '101', deadline),
    })[action]();
    apply();
    assert.deepEqual(room.match.over, { winner: 'b', kind: 'time' });
    assert.equal(toFen(room.match.pos), fen);
    assert.equal(room.match.moves.length, 2);
    assert.equal(room.match.clock.w, 0);
    assert.equal(room.turn, null);
    assert.equal(C.timeoutMove(room, key, deadline).error, 'STALE');
    apply();
    assert.equal(room.history.length, 1, 'повтор действия и callback не дублируют исход');
  });
}

test('своевременный откат возвращает позицию и часы, старый callback безопасен', () => {
  const room = roomAt();
  C.requestTakeback(room, '202', NOW);
  const { key, deadline } = room.turn;
  assert.ok(C.requestTakeback(room, '101', deadline - 1).accepted);
  assert.equal(room.match.moves.length, 1);
  assert.equal(room.match.over, null);
  C.syncTurn(room, deadline - 1);
  assert.equal(room.turn.remaining, C.FIRST_MS);
  assert.equal(C.timeoutMove(room, key, deadline).error, 'STALE');
});

test('истёкший срок при принятии ничьей: голый король даёт ничью по времени', () => {
  const room = roomAt();
  room.match.pos = fromFen('4k3/8/8/8/8/8/8/3NK3 w - - 0 1');
  C.offerDraw(room, '101', NOW);
  assert.equal(C.offerDraw(room, '202', room.turn.deadline).ended, true);
  assert.deepEqual(room.match.over, { winner: null, kind: 'time' });
});

test('без часов после первых ходов можно принять откат и спустя час', () => {
  const room = roomAt(2, 0);
  C.requestTakeback(room, '202', NOW);
  assert.ok(C.requestTakeback(room, '101', NOW + 3_600_000).accepted);
  assert.equal(room.match.over, null);
});

test('посторонний не завершает партию запросом отката после срока', () => {
  const room = roomAt();
  C.requestTakeback(room, '202', NOW);
  assert.equal(C.requestTakeback(room, '303', room.turn.deadline).error, 'NOT_IN_GAME');
  assert.equal(room.match.over, null);
});

async function duel(ctx, { base = 60 } = {}) {
  const store = new Store(':memory:');
  const t = new Table({ store });
  ctx.after(() => { t.app.stop(); store.close(); });
  await t.cmd(A, '/game');
  t.openHub(A);
  await t.send(A, { t: 'create', game: 'chess', settings: { base, side: 'white' }, reqId: 'deadline' });
  const room = t.chess;
  t.openRoom(B, room);
  await t.send(B, { t: 'sit' });
  await t.send(A, { t: 'start' });
  return { t, room, store };
}

async function play(t, moves) {
  for (const [i, [from, to]] of moves.entries()) {
    await t.send(i % 2 ? B : A, { t: 'move', from, to, ply: i });
    assert.equal(t.lastError(i % 2 ? B : A), null);
  }
}

for (const action of ['move', 'takeback', 'draw', 'resign']) for (const timerFirst of [false, true]) {
  test(`хаб: ${action}, callback ${timerFirst ? 'раньше' : 'позже'} действия — один исход`, async ctx => {
    const { t, room, store } = await duel(ctx);
    await play(t, longGame);
    if (action === 'takeback') await t.send(B, { t: 'takeback' });
    if (action === 'draw') await t.send(A, { t: 'draw' });
    const fire = chess.clocks(t.app, room, t.clock.now())[0].fire;
    // Не advance(): имитируем срок, уже истёкший до доставки callback.
    t.clock.t = room.turn.deadline;
    const msg = action === 'move' ? { t: 'move', from: 'h4', to: 'g3', ply: 20 } : { t: action };
    const actor = ['draw', 'resign'].includes(action) ? B : A;
    let endings = 0;
    const original = t.app.afterAction.bind(t.app);
    t.app.afterAction = (...args) => { endings++; return original(...args); };
    await Promise.all(timerFirst ? [fire(), t.send(actor, msg)] : [t.send(actor, msg), fire()]);
    await t.app.settle();
    const messages = t.tg.calls.filter(c => ['sendMessage', 'editMessageText'].includes(c.method));
    await t.send(actor, msg);
    await fire();
    await t.app.settle();
    assert.equal(endings, 1);
    assert.deepEqual(t.tg.calls.filter(c => ['sendMessage', 'editMessageText'].includes(c.method)), messages,
      'повтор действия и callback не дублируют уведомления');
    assert.deepEqual(room.match.over, { winner: 'b', kind: 'time' });
    assert.equal(room.history.length, 1);
    assert.equal(room.match.moves.length, 20);
    assert.equal(store.ratingOf(202, 'chess').points, 20);
    assert.equal(store.ratingOf(202, 'chess').played, 1);
    assert.equal(store.ratingOf(101, 'chess').played, 1);
    for (const u of [A, B]) {
      assert.deepEqual(t.state(u).match.over, { winner: 'b', kind: 'time', why: 'время вышло' });
      assert.match(t.state(u).room.notice, /Макс выиграл: время вышло/);
    }
    const back = new Table({ store, clock: t.clock });
    ctx.after(() => back.app.stop());
    back.app.load();
    assert.deepEqual(back.app.roomByCode(room.code).history, room.history, 'исход сохранён');
    assert.equal(t.errors.length, 0);
  });
}

test('хаб: поздний первый ход отменён без рейтинга и показан обоим игрокам', async ctx => {
  const { t, room, store } = await duel(ctx, { base: 0 });
  t.clock.t = room.turn.deadline + 1;
  await t.send(A, { t: 'move', from: 'e2', to: 'e4', ply: 0 });
  assert.equal(t.lastError(A).code, 'TIME_UP');
  for (const u of [A, B]) {
    assert.equal(t.state(u).match.over.kind, 'aborted');
    assert.match(t.state(u).room.notice, /не сделал первый ход/);
  }
  assert.equal(store.ratingOf(101, 'chess'), null);
  assert.equal(room.history.length, 1);
});

for (const remaining of [0, 5000]) test(`рестарт с остатком ${remaining}: простой не восстанавливает истёкший срок`, async ctx => {
  const { t, room, store } = await duel(ctx);
  await play(t, opening);
  await t.send(B, { t: 'takeback' });
  t.clock.t = room.turn.deadline - remaining;
  t.app.save(room);
  t.app.stop();
  const back = new Table({ store, clock: new FakeClock(t.clock.now() + 600_000) });
  ctx.after(() => back.app.stop());
  back.app.load();
  await back.app.resume();
  const restored = back.app.roomByCode(room.code);
  back.openRoom(A, restored);
  assert.equal(restored.turn.deadline - back.clock.now(), remaining);
  await back.send(A, { t: 'takeback' });
  assert.equal(restored.match.moves.length, remaining ? 1 : 2);
  assert.equal(restored.match.over?.kind ?? null, remaining ? null : 'time');
});

test('обслуживание: просроченный старый callback не завершает замороженную партию', async ctx => {
  const { t, room } = await duel(ctx);
  await play(t, opening);
  await t.send(B, { t: 'takeback' });
  const fire = chess.clocks(t.app, room, t.clock.now())[0].fire;
  t.clock.t += 10_000;
  t.app.setMaintenance(true);
  t.clock.t += 600_000;
  await fire();
  await t.send(A, { t: 'takeback' });
  assert.equal(room.match.moves.length, 2);
  assert.equal(room.match.over, null);
  assert.equal(room.turn.deadline, null);
  t.app.setMaintenance(false);
  assert.equal(room.turn.deadline - t.clock.now(), 50_000);
  await t.send(A, { t: 'takeback' });
  assert.equal(room.match.moves.length, 1);
  assert.equal(room.match.over, null);
});

for (const action of ['kick', 'finish', '/finish', 'left', 'admin-stop', 'stopAll', 'admin-bot']) {
  test(`хаб и команды: ${action} сохраняет исход по сроку, используя часы приложения`, async ctx => {
    const { t, room, store } = await duel(ctx);
    await play(t, longGame);
    t.clock.t = room.turn.deadline;
    if (action === 'kick') await t.send(A, { t: 'kick', seat: 1 });
    if (action === 'finish') await t.send(A, { t: 'finish' });
    if (action === '/finish') await t.cmd(A, '/finish');
    if (action === 'left') await t.app.onLeft(t.chatId, A);
    if (action === 'stopAll') await t.app.stopAll();
    if (action === 'admin-stop') {
      t.app.admins.add('101');
      t.openAdmin(A);
      await t.send(A, { t: 'stop', code: room.code });
    }
    if (action === 'admin-bot') await t.adminBot.stop({ tgId: 101 }, room.code);
    await t.app.settle();
    assert.deepEqual(room.match.over, { winner: 'b', kind: 'time' });
    assert.equal(room.history.length, 1);
    assert.equal(store.ratingOf(202, 'chess').points, 20);
    assert.equal(store.ratingOf(202, 'chess').played, 1);
    assert.equal(t.errors.length, 0);
  });
}

test('обычный ход за миллисекунду до срока получает только положенную прибавку', () => {
  const room = roomAt();
  room.settings.inc = 2;
  assert.ok(C.move(room, '101', { from: 'g1', to: 'f3' }, room.turn.deadline - 1).ok);
  assert.equal(room.match.clock.w, 2001);
  assert.equal(room.match.over, null);
});

test('просьба об откате после срока и отмена после первого срока не обходят timeoutMove', () => {
  const room = roomAt();
  assert.equal(C.requestTakeback(room, '202', room.turn.deadline).ended, true);
  assert.deepEqual(room.match.over, { winner: 'b', kind: 'time' });
  const first = roomAt(0);
  assert.equal(C.abortMatch(first, '202', first.turn.deadline).ended, true);
  assert.match(first.notice, /не сделал первый ход/);
});
