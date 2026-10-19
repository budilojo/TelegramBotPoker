'use strict';
/**
 * Аудит E-05: гонки между await — сообщения, которые обрабатываются
 * одновременно (две страницы одного человека, страница и таймер).
 *
 * Сервер выполняет сообщения ОДНОЙ страницы по очереди, но разные страницы
 * идут параллельно. Здесь — несколько сообщений сразу, без ожидания первого.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, initDataFor } from './harness.js';
import { Store } from './store.js';

test('АУДИТ E-05: две страницы одного человека начинают партию с ботами разом — живая партия одна, и обе страницы в ней', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  const u = user(101, 'Аня');
  const open = () => t.hub.open({ initData: initDataFor(u, { startParam: 'solo', clock: t.clock }) }, () => {}).session;
  const pages = [open(), open(), open()];
  await Promise.all([
    t.hub.handle(pages[0], { t: 'play', game: 'durak', settings: {} }),
    t.hub.handle(pages[1], { t: 'play', game: 'colors', settings: {} }),
    t.hub.handle(pages[2], { t: 'play', game: 'chess', settings: {} }),
  ]);
  await t.app.settle();
  const live = [...t.app.rooms.values()].filter((r) => r.solo?.owner === '101' && r.status !== 'finished');
  assert.equal(live.length, 1, `живых партий с ботами: ${live.map((r) => r.game)}`);
  for (const p of pages) assert.equal(p.code, live[0].code, 'страница — в живой партии');
  assert.equal([...t.hub.byRoom.keys()].filter((k) => !t.app.rooms.has(k)).length, 0, 'нет подписок на удалённые столы');
  // И в базе — тоже одна: удалённые не воскресли последним сохранением.
  const inDb = store.loadAll().filter((r) => r.chatId === 'solo:101' && r.data.status !== 'finished');
  assert.equal(inDb.length, 1, `в базе живых партий: ${inDb.length}`);
  assert.deepEqual(t.errors.map(String), []);
  t.app.stop();
});

test('АУДИТ E-05: «Сыграть ещё» пятью тапами разом — одна партия, без висящих таймеров', async () => {
  const t = new Table();
  const u = user(101, 'Аня');
  const page = t.hub.open({ initData: initDataFor(u, { startParam: 'solo', clock: t.clock }) }, () => {}).session;
  await t.hub.handle(page, { t: 'play', game: 'chess', settings: { side: 'black' } });
  await Promise.all(Array.from({ length: 5 }, () => t.hub.handle(page, { t: 'again' })));
  await t.app.settle();
  const live = [...t.app.rooms.values()].filter((r) => r.solo?.owner === '101' && r.status !== 'finished');
  assert.equal(live.length, 1);
  for (const id of t.app.handles.keys()) assert.ok(t.app.rooms.has(id.split(':').at(-1)), `таймер ${id} от удалённого стола`);
  t.app.stop();
});
