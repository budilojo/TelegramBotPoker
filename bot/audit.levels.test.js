'use strict';
/**
 * Аудит E-04: обслуживание не тратит время уровня блайндов.
 *
 * Часы хода на обслуживании стоят (`freezeClocks`), а часы уровней покера
 * считались по системному времени и шли дальше: после получаса обслуживания
 * блайнды росли в первой же раздаче — хотя игра всё это время стояла.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { Store } from './store.js';

const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };

test('АУДИТ E-04: покер — полчаса обслуживания не поднимают уровень блайндов', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 19, 12) });
  try {
    const t = new Table();
    await t.seat(cast, { blinds: [25, 50] });
    await t.send(cast.ivan, { t: 'settings', blindMode: 'levels', levelMinutes: 15 });
    await t.send(cast.ivan, { t: 'start' });
    const room = t.room;
    mock.timers.tick(2 * 60_000); // две минуты игры
    t.app.setMaintenance(true, 'обновляемся');
    mock.timers.tick(30 * 60_000); // полчаса обслуживания
    t.app.setMaintenance(false);
    // Раздача кончается — следующая сдаётся.
    await t.act(t.actorOf(cast), 'fold');
    await t.send(cast.ivan, { t: 'next' });
    assert.equal(room.level.index, 0, 'уровень тот же: за обслуживание время уровня не шло');
    assert.equal(room.settings.bigBlind, 50);
    // А игра — идёт: ещё 14 минут, и уровень растёт.
    mock.timers.tick(14 * 60_000);
    await t.act(t.actorOf(cast), 'fold');
    await t.send(cast.ivan, { t: 'next' });
    assert.equal(room.level.index, 1, 'после 16 минут игры — второй уровень');
  } finally {
    mock.timers.reset();
  }
});

test('АУДИТ E-04: покер — перезапуск посреди обслуживания: уровень тоже стоит', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 19, 12) });
  try {
    const store = new Store(':memory:');
    const t = new Table({ store });
    await t.seat(cast, { blinds: [25, 50] });
    await t.send(cast.ivan, { t: 'settings', blindMode: 'levels', levelMinutes: 15 });
    await t.send(cast.ivan, { t: 'start' });
    mock.timers.tick(2 * 60_000);
    t.app.setMaintenance(true, 'обновляемся');
    t.app.save(t.room);
    // Перезапуск во время обслуживания (так и выкатывают обновления).
    const t2 = new Table({ store, clock: t.clock });
    t2.app.load();
    assert.equal(t2.app.down, true);
    mock.timers.tick(30 * 60_000);
    t2.app.setMaintenance(false);
    const room = t2.app.roomByCode(t.room.code);
    t2.openRoom(cast.ivan, room);
    t2.openRoom(cast.max, room);
    const who = room.hand.actorId === '101' ? cast.ivan : cast.max;
    await t2.act(who, 'fold');
    await t2.send(cast.ivan, { t: 'next' });
    assert.equal(room.level.index, 0, 'уровень тот же');
  } finally {
    mock.timers.reset();
  }
});
