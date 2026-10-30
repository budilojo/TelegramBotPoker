'use strict';
/**
 * Настройки стола посреди партии (баг владельца «при изменении настроек стола во время игры»).
 * Сервер обеспечивает границы: что применяется сразу, что — со следующей раздачи, что — только в лобби.
 * Раздача, банк, очередь хода и часы при этом целы.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from './room.js';
import { totalPot } from '../server/game.js';

function table({ timer = 30 } = {}) {
  const room = R.createRoom({ chatId: -9, host: { id: 1, name: 'Иван' }, startingStack: 10000, smallBlind: 25, bigBlind: 50 });
  for (const [id, name] of [[2, 'Макс'], [3, 'Дима']]) R.addPlayer(room, { id, name });
  if (timer) R.updateSettings(room, '1', { turnSeconds: timer });
  assert.equal(R.startGame(room, '1').ok, true);
  R.syncTurn(room, 1_000);
  return room;
}
const snap = (room) => JSON.stringify({ no: room.hand.no, actor: room.hand.actorId, pot: totalPot(room), log: room.hand.log.length, sb: room.settings.smallBlind, bb: room.settings.bigBlind, stack: room.settings.startingStack });

test('блайнды посреди раздачи — со следующей, раздача и банк целы', () => {
  const room = table();
  const before = snap(room);
  assert.equal(R.updateSettings(room, '1', { smallBlind: 100, bigBlind: 200 }).ok, true);
  assert.equal(snap(room), before, 'текущая раздача и действующие блайнды не изменились');
  assert.deepEqual(room.pendingBlinds, { sb: 100, bb: 200 });
});

test('стартовый стек после старта не меняется, но остальное из того же набора применяется', () => {
  const room = table();
  const stacks = room.players.map((p) => p.stack);
  assert.equal(R.updateSettings(room, '1', { startingStack: 99999, smallBlind: 50, bigBlind: 100 }).ok, true);
  assert.equal(room.settings.startingStack, 10000);
  assert.deepEqual(room.players.map((p) => p.stack), stacks, 'фишки игроков не тронуты');
  assert.deepEqual(room.pendingBlinds, { sb: 50, bb: 100 });
});

test('смена режима карт посреди раздачи отклоняется целиком и ничего не портит', () => {
  const room = table();
  const before = snap(room);
  const r = R.updateSettings(room, '1', { cards: 'live', smallBlind: 100, bigBlind: 200 });
  assert.equal(r.error, 'HAND_IN_PROGRESS');
  assert.equal(snap(room), before);
  assert.equal(room.pendingBlinds, null, 'половина набора не применилась');
  assert.equal(room.settings.cards || 'virtual', 'virtual');
});

test('чужой (не хост) настройки менять не может', () => {
  const room = table();
  const before = snap(room);
  assert.equal(R.updateSettings(room, '2', { smallBlind: 1, bigBlind: 2, turnSeconds: 0 }).error, 'NOT_HOST');
  assert.equal(snap(room), before);
  assert.equal(room.settings.turnSeconds, 30);
});

test('смена блайндов не сбрасывает часы текущего хода', () => {
  const room = table();
  const t = room.turn;
  assert.ok(t && t.deadline, 'часы идут');
  const { key, deadline } = t;
  R.updateSettings(room, '1', { smallBlind: 100, bigBlind: 200 });
  R.syncTurn(room, 5_000);
  assert.equal(room.turn.key, key);
  assert.equal(room.turn.deadline, deadline, 'срок хода тот же');
});

test('таймер посреди хода: выключили — часов нет, включили — свежий отсчёт у того же игрока', () => {
  const room = table();
  const actor = room.hand.actorId;
  R.updateSettings(room, '1', { turnSeconds: 0 });
  assert.equal(R.syncTurn(room, 2_000), null);
  assert.equal(room.hand.actorId, actor, 'очередь хода та же');
  R.updateSettings(room, '1', { turnSeconds: 60 });
  const t = R.syncTurn(room, 3_000);
  assert.equal(t.actorId, actor);
  assert.equal(t.deadline, 3_000 + 60_000);
});

test('пределы: нулевые и отрицательные блайнды не проходят в ноль, большой не ниже малого', () => {
  const room = table();
  R.updateSettings(room, '1', { smallBlind: 0, bigBlind: -5 });
  assert.ok(!room.pendingBlinds || (room.pendingBlinds.sb >= 1 && room.pendingBlinds.bb >= room.pendingBlinds.sb));
  R.updateSettings(room, '1', { smallBlind: 300, bigBlind: 100 });
  assert.ok(room.pendingBlinds.bb >= room.pendingBlinds.sb);
});

test('повторное сохранение того же набора ничего не меняет и не копит отмены', () => {
  const room = table();
  R.updateSettings(room, '1', { smallBlind: 100, bigBlind: 200 });
  const undo = room.undo.length;
  const r = R.updateSettings(room, '1', { smallBlind: 100, bigBlind: 200 });
  assert.equal(r.ok, true);
  assert.equal(room.undo.length, undo, "повтор не добавил отмену");
  assert.deepEqual(room.pendingBlinds, { sb: 100, bb: 200 });
});

test('завершённый стол настроек не принимает', () => {
  const room = table();
  room.status = 'finished';
  assert.equal(R.updateSettings(room, '1', { turnSeconds: 0 }).error, 'GAME_FINISHED');
});
