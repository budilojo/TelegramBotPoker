'use strict';
/**
 * «+ Новое лобби» на экране итогов: любой, кто сидел за законченным столом,
 * может открыть такой же — и со страницы из хаба, и со страницы, открытой по
 * карточке в чате. Чужой, зритель и незаконченный стол — отказ словами.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, stack } from './harness.js';

const host = user(101, 'Иван');
const guest = user(102, 'Мария');
const stranger = user(555, 'Чужой');
const live = (t) => t.app.liveRooms(String(t.chatId));

async function finishedTable(t, game, settings) {
  await t.start(host);
  await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game, settings });
  const room = live(t)[0];
  await t.start(guest);
  t.openRoom(guest, room);
  await t.send(guest, { t: 'sit' });
  room.status = 'finished'; // как после итогов
  return room;
}

for (const [game, settings] of [['poker', { sb: 50, bb: 100 }], ['durak', {}], ['colors', { stacking: false, turnSeconds: 60 }]]) {
  test(`${game}: игрок законченного стола открывает такой же со страницы по карточке`, async () => {
    const t = new Table();
    const first = await finishedTable(t, game, settings);
    const before = JSON.parse(JSON.stringify(first.settings));
    t.openRoom(guest, first); // страница по карточке, не из хаба
    t.hub.push(t.page(guest).session, first);
    assert.equal(t.state(guest).canRematch, true, 'кнопка предложена');
    assert.equal(live(t).length, 0, 'законченный стол уже не считается живым');
    await t.send(guest, { t: 'again', reqId: `r-${game}` });
    assert.equal(live(t).length, 1, 'новый стол создан: ' + JSON.stringify(t.page(guest).inbox.filter((m) => m.t === 'error')));
    const second = live(t)[0];
    assert.notEqual(second.code, first.code);
    assert.equal(second.game, game);
    assert.deepEqual(second.settings, before, 'те же настройки');
    assert.equal(second.hostId, '102', 'хост — тот, кто нажал');
    assert.equal(second.chatId, first.chatId, 'та же группа');
  });
}

test('кнопки нет и стол не создаётся: чужой, зритель, незаконченный стол', async () => {
  const t = new Table();
  const first = await finishedTable(t, 'durak', {});
  await t.start(stranger);
  t.openRoom(stranger, first);
  assert.notEqual(t.state(stranger).canRematch, true, 'зрителю кнопки нет');
  const n = t.app.rooms.size;
  await t.send(stranger, { t: 'again', reqId: 'x' });
  assert.equal(t.page(stranger).inbox.filter((m) => m.t === 'error').at(-1).code, 'NOT_FROM_HUB');
  assert.equal(t.app.rooms.size, n, 'ничего не создано');

  first.status = 'playing';
  t.openRoom(guest, first);
  t.hub.push(t.page(guest).session, first);
  assert.notEqual(t.state(guest).canRematch, true, 'пока идёт партия кнопки нет');
  await t.send(guest, { t: 'again', reqId: 'y' });
  assert.equal(t.app.rooms.size, n, 'во время партии не создаётся');
});

test('покер: пока открывается борд олл-ина, «Новое лобби» не выдаёт исход — ни кнопкой, ни отказом', async () => {
  // Хедз-ап, олл-ин префлоп: у Макса сет королей на ривере — Иван выбывает, игра кончилась,
  // но телефон узнаёт об этом только после ривера (аудит C-01).
  const ivan = user(101, 'Иван'), max = user(202, 'Макс');
  const t = new Table({ runoutStepMs: 1500 });
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc' }, 'Qs 9h 4d 3c Kh'));
  await t.seat({ ivan, max }, { blinds: [25, 50] });
  const p = t.room.players.find((x) => x.id === '101');
  p.stack = 2000;
  p.stats.buyIn = 2000;
  await t.send(ivan, { t: 'start' });
  for (let i = 0; i < 4 && t.room.hand.phase === 'betting'; i++) {
    const who = t.actorOf({ ivan, max });
    const l = t.state(who).legal;
    await t.act(who, l.canBet || l.canRaise ? 'allin' : 'call');
  }
  assert.equal(t.room.status, 'finished', 'в памяти сервера игра уже кончилась');
  t.openRoom(ivan, t.room); // страница по карточке
  t.hub.push(t.page(ivan).session, t.room);
  assert.equal(t.state(ivan).room.status, 'playing', 'телефону ещё не сказали');
  assert.notEqual(t.state(ivan).canRematch, true, 'кнопка не выдаёт исход');
  const before = t.app.rooms.size;
  await t.send(ivan, { t: 'again', reqId: 'peek' });
  assert.equal(t.page(ivan).inbox.filter((m) => m.t === 'error').at(-1).code, 'NOT_FROM_HUB', 'отказ — тот же, что и в любой партии, без намёка');
  assert.equal(t.app.rooms.size, before, 'стол не создан');
});
