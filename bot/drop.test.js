'use strict';
/** «Удалить игру» кнопкой (раньше — только команда /cancel): только хост, чужое в теле не читается, все уходят в хаб. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';

const ivan = user(101, 'Иван');
const max = user(202, 'Макс');

async function lobby() {
  const t = new Table();
  await t.cmd(ivan, '/play');
  await t.cmd(ivan, '/newgame');
  const room = t.room;
  assert.ok(room, 'стол создан');
  t.openRoom(ivan, room);
  t.openRoom(max, room);
  return { t, room };
}

test('хост удаляет игру кнопкой: стол исчез, у другого игрока — «Игру удалили»', async () => {
  const { t, room } = await lobby();
  await t.send(ivan, { t: 'drop' });
  assert.ok(!t.app.roomByCode(room.code), 'стол удалён');
  assert.ok(t.page(max).inbox.some((m) => m.t === 'gone'), 'Макс получил «Игру удалили»');
});

test('не хост удалить не может — стол на месте, отказ словами', async () => {
  const { t, room } = await lobby();
  await t.send(max, { t: 'drop' });
  assert.ok(t.app.roomByCode(room.code), 'стол цел');
  const err = t.lastError(max);
  assert.equal(err.code, 'NOT_HOST');
  assert.match(err.text, /хост/i);
});

test('подмена хоста и кода в теле сообщения ничего не меняет', async () => {
  const { t, room } = await lobby();
  await t.send(max, { t: 'drop', code: room.code, host: '101', hostId: '101', userId: '101' });
  assert.ok(t.app.roomByCode(room.code));
});

test('во время обслуживания удалить нельзя', async () => {
  const { t, room } = await lobby();
  t.app.maintenance = { on: true, text: 'работы', since: 1 };
  await t.send(ivan, { t: 'drop' });
  assert.ok(t.app.roomByCode(room.code), 'стол цел');
});
