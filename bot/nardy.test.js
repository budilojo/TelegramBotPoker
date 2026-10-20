'use strict';
/**
 * Нарды через мини-приложение — с настоящими страницами через хаб.
 *
 *   НИКТО НЕ ХОДИТ ЗА ДРУГОГО — личность только из initData; бросить, сходить,
 *   отменить и нажать «Готово» может только тот, чей ход.
 *
 *   КУБИКИ НЕ ПОДДЕЛАТЬ — числа со страницы сервер не читает; бросить можно
 *   раз за ход; перезапуск, обновление страницы и переподключение кубики не
 *   меняют; оба видят одни и те же кубики и всю историю бросков.
 *
 *   НИКТО НЕ ПОЛУЧАЕТ ЧУЖИХ ХОДОВ — допустимые шаги приходят только тому,
 *   чей ход; проверяется всё, что получил каждый телефон.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { PLACE } from './rating.js';
import { abs } from './games/nardy/board.js';

const IVAN = user(101, 'Иван');
const MAX = user(202, 'Макс');
const DIMA = user(303, 'Дима');

const errors = (t, u) => t.page(u).inbox.filter((m) => m.t === 'error');
const states = (t, u) => t.page(u).inbox.filter((m) => m.t === 'state' && m.state.game === 'nardy').map((m) => m.state);

/** Кубики по списку; кончились — дальше 2-1 (ход всегда есть). */
function dice(list) {
  const q = list.slice();
  const fn = () => (q.length ? q.shift() : [2, 1]);
  fn.push = (...pairs) => q.push(...pairs);
  return fn;
}

async function duel(t, settings = { base: 0 }) {
  await t.start(IVAN);
  if (!t.group) await t.cmd(IVAN, '/play');
  t.openHub(IVAN);
  await t.send(IVAN, { t: 'create', game: 'nardy', settings, reqId: 'n1' });
  const room = t.nardy;
  await t.start(MAX);
  t.openRoom(MAX, room);
  await t.send(MAX, { t: 'sit' });
  await t.send(IVAN, { t: 'start' });
  return room;
}
const userOf = (room, c) => ((c === 'w') === (room.match.white === '101') ? IVAN : MAX);
const moverU = (room) => userOf(room, room.match.turn.c);

/** Сыграть ход целиком с телефона того, чей он: [индекс пути, число]… и «Готово». */
async function turn(t, room, steps, { roll = true } = {}) {
  const u = moverU(room);
  const c = room.match.turn.c;
  if (roll && !room.match.turn.dice) await t.send(u, { t: 'roll' });
  for (const [i, die] of steps) {
    await t.send(u, { t: 'move', from: abs(c, i), die, turn: room.match.log.length });
    assert.equal(t.lastError(u)?.code ?? null, null, `${c} ${i}+${die}`);
  }
  await t.send(u, { t: 'end' });
  assert.equal(t.lastError(u)?.code ?? null, null, `${c}: «Готово»`);
}

test('жребий, бросок, шаги, «Готово»: партия с двух телефонов, кубики одинаковые у обоих', async () => {
  const t = new Table({ nardyDice: dice([[5, 3], [4, 2]]) });
  const room = await duel(t);
  assert.equal(room.game, 'nardy');
  const si = t.state(IVAN);
  assert.equal(si.me.color, 'w');
  assert.equal(si.match.first, 'w', 'белым 5 против 3');
  assert.deepEqual(si.match.dice, [5, 3], 'первый ход — числами жребия');
  assert.deepEqual(t.state(MAX).match.dice, [5, 3], 'у соперника те же кубики');
  await turn(t, room, [[0, 5], [5, 3]], { roll: false });
  await t.send(MAX, { t: 'roll' });
  const sm = t.state(MAX);
  assert.deepEqual(sm.match.dice, [4, 2]);
  assert.deepEqual(t.state(IVAN).match.dice, [4, 2], 'Иван видит бросок Макса');
  assert.deepEqual(t.state(IVAN).match.rolls, sm.match.rolls, 'история бросков одна на всех');
  assert.deepEqual(sm.match.rolls.map((r) => r.dice || r.start), [{ w: 5, b: 3 }, [4, 2]]);
  assert.deepEqual(t.state(IVAN).match.log[0].notation, ['1/6', '6/9']);
});

test('кубики не подделать: числа в сообщении «бросить» сервер не читает; бросить второй раз нельзя', async () => {
  const t = new Table({ nardyDice: dice([[5, 3], [1, 2]]) });
  const room = await duel(t);
  await turn(t, room, [[0, 5], [5, 3]], { roll: false });
  await t.send(MAX, { t: 'roll', dice: [6, 6], d1: 6, d2: 6, values: [6, 6] });
  assert.deepEqual(room.match.turn.dice, [1, 2], 'выпало то, что бросил сервер');
  await t.send(MAX, { t: 'roll', dice: [6, 6] });
  assert.equal(t.lastError(MAX).code, 'ALREADY_ROLLED');
  assert.match(t.lastError(MAX).text, /уже брошены/);
  assert.deepEqual(room.match.turn.dice, [1, 2]);
  // Сходить числом, которого не выпало, — нельзя.
  await t.send(MAX, { t: 'move', from: abs('b', 0), die: 6 });
  assert.equal(t.lastError(MAX).code, 'NO_SUCH_DIE');
});

test('перезапуск бота и обновление страницы не дают перебросить: кубики и сыгранное — те же', async () => {
  const store = new Store(':memory:');
  const d = dice([[5, 3], [6, 1]]);
  const t = new Table({ store, nardyDice: d });
  const room = await duel(t, { base: 300 });
  await turn(t, room, [[0, 5], [5, 3]], { roll: false });
  await t.send(MAX, { t: 'roll' });
  await t.send(MAX, { t: 'move', from: abs('b', 0), die: 6, turn: 1 });
  t.app.save(room);

  d.push([6, 6], [6, 6]); // если бы бросали заново — выпало бы другое
  const t2 = new Table({ store, clock: t.clock, nardyDice: d });
  t2.app.load();
  const back = t2.app.roomByCode(room.code);
  assert.deepEqual(back.match.turn.dice, [6, 1]);
  await t2.start(MAX);
  t2.openRoom(MAX, back);
  const s = t2.state(MAX);
  assert.deepEqual(s.match.dice, [6, 1], 'после перезапуска на странице те же кубики');
  assert.deepEqual(s.match.diceLeft, [1], 'шестёрка уже сыграна');
  await t2.send(MAX, { t: 'roll' });
  assert.equal(t2.lastError(MAX).code, 'ALREADY_ROLLED');
  // «Обновить страницу» — открыть заново: то же самое.
  t2.openRoom(MAX, back);
  assert.deepEqual(t2.state(MAX).match.dice, [6, 1]);
  await t2.send(MAX, { t: 'move', from: abs('b', 6), die: 1, turn: 1 });
  await t2.send(MAX, { t: 'end' });
  assert.equal(back.match.turn.c, 'w');
  store.close();
});

test('никто не ходит за другого: чужой бросок, шаг, отмена, «Готово»; зритель; подделка id в теле', async () => {
  const t = new Table({ nardyDice: dice([[5, 3]]) });
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  for (const msg of [{ t: 'roll' }, { t: 'move', from: abs('w', 0), die: 5, uid: '101', color: 'w' }, { t: 'undo' }, { t: 'end' }]) {
    await t.send(MAX, msg);
    assert.equal(t.lastError(MAX).code, 'NOT_YOUR_TURN', msg.t);
    await t.send(DIMA, msg);
    assert.equal(t.lastError(DIMA).code, 'NOT_IN_GAME', msg.t);
  }
  assert.equal(room.match.turn.played.length, 0);
  await t.send(DIMA, { t: 'resign' });
  await t.send(DIMA, { t: 'abort' });
  assert.equal(room.match.over, null);
  await t.send(IVAN, { t: 'draw' });
  assert.equal(t.lastError(IVAN).code, 'BAD_REQUEST', 'ничьей в нардах нет');
});

test('шаги, «Бросить», «Готово» приходят только тому, чей ход — во всём, что получил каждый телефон', async () => {
  const t = new Table({ nardyDice: dice([[5, 3], [4, 2], [6, 5], [3, 3]]) });
  const room = await duel(t);
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  await turn(t, room, [[0, 5], [5, 3]], { roll: false });
  await turn(t, room, [[0, 4], [4, 2]]);
  await turn(t, room, [[0, 6], [6, 5]]);
  for (const [u, color] of [[IVAN, 'w'], [MAX, 'b'], [DIMA, null]]) {
    const all = states(t, u);
    assert.ok(all.length > 5);
    for (const s of all) {
      if (s.legal.myTurn) assert.equal(s.match.turn, color, `${u.first_name} получил шаги не в свой ход`);
      else assert.deepEqual(Object.keys(s.legal), ['myTurn']);
    }
  }
});

test('нет ходов — ход переходит сам, всем видно, что выпало', async () => {
  const t = new Table({ nardyDice: dice([[5, 3], [3, 2]]) });
  const room = await duel(t);
  await turn(t, room, [[0, 5], [5, 3]], { roll: false });
  // Чёрным некуда: шесть пунктов за их головой заняты белыми.
  const b = Array(24).fill(0);
  b[abs('b', 0)] = -15;
  for (let i = 1; i <= 6; i++) b[abs('b', i)] = 2;
  b[abs('w', 0)] = 3;
  room.match.pos.b = b;
  room.match.turn.start = { ...room.match.pos, b: b.slice() };
  await t.send(MAX, { t: 'roll' });
  assert.equal(room.match.turn.c, 'w');
  assert.equal(room.match.log.at(-1).auto, true);
  assert.match(t.state(IVAN).room.notice, /3-2 — ходов нет/);
});

test('отмена шага и «Готово» раньше времени — словами', async () => {
  const t = new Table({ nardyDice: dice([[5, 3]]) });
  const room = await duel(t);
  await t.send(IVAN, { t: 'move', from: abs('w', 0), die: 5, turn: 0 });
  assert.equal(t.state(IVAN).legal.canUndo, true);
  await t.send(IVAN, { t: 'end' });
  assert.equal(t.lastError(IVAN).code, 'MOVES_LEFT');
  assert.match(t.lastError(IVAN).text, /сыграть обязательно/);
  await t.send(IVAN, { t: 'undo' });
  assert.equal(room.match.turn.played.length, 0);
  await t.send(IVAN, { t: 'move', from: abs('w', 0), die: 3, turn: 0 });
  await t.send(IVAN, { t: 'move', from: abs('w', 0), die: 5, turn: 0 });
  assert.equal(t.lastError(IVAN).code, 'HEAD_ONCE');
  assert.match(t.lastError(IVAN).text, /С головы за ход — только одна/);
});

test('часы: время вышло — выигрывает соперник, в рейтинге +20', async () => {
  const t = new Table({ store: new Store(':memory:'), nardyDice: dice([[5, 3]]) });
  const room = await duel(t, { base: 180 });
  await playAny(t, room, 22);
  assert.equal(room.match.over, null, 'партия идёт');
  const loser = room.match.turn.c;
  await t.advance(179_000);
  assert.equal(room.match.over, null);
  await t.advance(1_000);
  assert.equal(room.match.over.kind, 'time');
  assert.equal(room.match.over.winner, loser === 'w' ? 'b' : 'w', 'проиграл тот, чей был ход');
  const winner = room.match.over.winner === 'w' ? room.match.white : room.match.black;
  assert.equal(t.app.store.ratingOf(Number(winner), 'nardy').points, PLACE[0]);
  t.app.store.close();
});

/** Доиграть `n` ходов первыми допустимыми шагами — с телефонов тех, чей ход. */
async function playAny(t, room, n) {
  for (let k = 0; k < n && !room.match.over; k++) {
    const u = moverU(room);
    const turns = room.match.log.length;
    if (!room.match.turn.dice) await t.send(u, { t: 'roll' });
    if (room.match.log.length !== turns) continue; // ходов не было — ход перешёл сам
    for (let guard = 0; guard < 4; guard++) {
      const next = t.state(u).legal.next;
      if (!next?.length) break;
      await t.send(u, { t: 'move', from: next[0].from, die: next[0].die, turn: turns });
      assert.equal(t.lastError(u)?.code ?? null, null, 'шаг, предложенный сервером, принят');
    }
    if (room.match.over) break;
    await t.send(u, { t: 'end' });
    assert.equal(room.match.log.length, turns + 1, '«Готово» передало ход');
  }
}

test('рейтинг: короткая сдача очков не даёт; ничьей нет', async () => {
  const t = new Table({ store: new Store(':memory:'), nardyDice: dice([[5, 3]]) });
  const room = await duel(t);
  await playAny(t, room, 4);
  await t.send(MAX, { t: 'resign' });
  assert.equal(room.match.over.kind, 'resign');
  assert.equal(t.app.store.ratingOf(101, 'nardy'), null, 'сдался на втором ходу — очков нет');
  assert.match(room.rated[`${room.code}#1`].why, /короче 10 ходов/);
  t.app.store.close();
});

test('«ваш ход» в личку: что выбросил и сыграл соперник', async () => {
  const t = new Table({ nardyDice: dice([[5, 3]]) });
  const room = await duel(t);
  await t.start(MAX);
  await t.send(MAX, { t: 'visible', visible: false });
  await turn(t, room, [[0, 5], [5, 3]], { roll: false });
  const ping = [...t.tg.messages.values()].filter((m) => m.chatId === '202' && /Ваш ход/.test(m.text)).at(-1);
  assert.ok(ping, 'Максу напомнили');
  assert.match(ping.text, /Нарды/);
  assert.match(ping.text, /Соперник: 5-3 · 1\/6 6\/9/);
});

test('/nardy в группе: лобби одной командой, повторно — ещё одно (дуэль)', async () => {
  const t = new Table();
  await t.start(IVAN);
  await t.cmd(IVAN, '/nardy');
  await t.cmd(IVAN, '/nardy');
  const lobbies = t.app.liveRooms(String(t.chatId)).filter((r) => r.game === 'nardy' && r.status === 'lobby');
  assert.equal(lobbies.length, 2);
  assert.equal(t.tg.message(lobbies[0].ui.tableMessageId).markup.inline_keyboard[0][0].text, '🎲 Присоединиться');
});
