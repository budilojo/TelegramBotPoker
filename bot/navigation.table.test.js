'use strict';
/**
 * «Стол → раздел → тот же стол»: просмотр другого раздела — не выход из партии.
 * Место не освобождается, раздача и часы идут своим чередом, вернуться можно в тот же стол;
 * удалённый за это время стол — не тупик; чужой стол этим путём не открыть.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';

const ivan = user(101, 'Иван');
const max = user(202, 'Макс');

async function playing({ timer = 30 } = {}) {
  const t = new Table();
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'poker', settings: { turnSeconds: timer } });
  const room = t.room;
  t.openHub(max);
  await t.send(max, { t: 'join', code: room.code });
  await t.send(max, { t: 'sit' });
  await t.send(ivan, { t: 'start' });
  assert.equal(t.room.status, 'playing');
  return { t, room: t.room };
}

test('уход в хаб не освобождает место, не сбрасывает раздачу и не замораживает часы', async () => {
  const { t, room } = await playing();
  const actor0 = room.hand.actorId;
  const deadline0 = room.turn?.deadline;
  assert.ok(deadline0, 'таймер хода идёт');
  const hand0 = room.hand.no;

  await t.send(ivan, { t: 'hub' });
  assert.equal(t.state(ivan).kind, 'hub');
  const me = room.players.find((p) => p.id === '101');
  assert.ok(!me.left && !me.sittingOut, 'место за ним');
  assert.equal(room.hand.no, hand0);
  assert.equal(room.turn.deadline, deadline0, 'часы хода не сдвинулись и не остановились');
  // В списке хаба стол отмечен «inside» — отсюда клиент рисует «Вернуться к столу».
  const row = t.state(ivan).lobbies.find((l) => l.code === room.code);
  assert.equal(row.inside, true);
  assert.equal(row.status, 'playing');

  // Часы идут: пока человек смотрит раздел, время хода истекает как обычно.
  await t.advance(31_000);
  assert.notEqual(room.hand.log.length, 0, 'за время просмотра ход был сделан по таймеру');
  assert.notEqual(`${actor0}:${room.hand.log.length}`, `${actor0}:0`);
});

test('вернуться — в тот же стол с теми же своими картами', async () => {
  const { t, room } = await playing({ timer: 0 });
  const holes = JSON.stringify(t.state(ivan).me?.hole ?? t.state(ivan).hero ?? null);
  await t.send(ivan, { t: 'hub' });
  await t.send(ivan, { t: 'join', code: room.code });
  const s = t.state(ivan);
  assert.equal(s.room.code, room.code);
  assert.equal(JSON.stringify(s.me?.hole ?? s.hero ?? null), holes, 'те же карты');
});

test('стол удалили, пока человек смотрел раздел: хаб без этого стола, вход по старому коду — отказ словами', async () => {
  const { t, room } = await playing({ timer: 0 });
  await t.send(ivan, { t: 'hub' });
  await t.app.dropGame(room);
  assert.ok(!t.state(ivan).lobbies.some((l) => l.code === room.code), 'в списке стола нет');
  await t.send(ivan, { t: 'join', code: room.code });
  assert.equal(t.lastError(ivan).code, 'NO_ROOM');
  assert.ok(t.lastError(ivan).text);
});

test('чужой стол из другой группы по коду не открывается из хаба', async () => {
  const { t, room } = await playing({ timer: 0 });
  const t2 = new Table({ chatId: -555 });
  const stranger = user(909, 'Чужой');
  await t2.cmd(stranger, '/play');
  t2.openHub(stranger);
  await t2.send(stranger, { t: 'join', code: room.code });
  assert.equal(t2.lastError(stranger)?.code, 'NO_ROOM');
});
