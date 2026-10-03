/**
 * Нагрузка и утечки — измерением, а не рассуждением.
 *
 *   node --expose-gc tools/load-check.mjs
 *
 * Нас не ждут миллионы, но важно другое: не копится ли то, что должно
 * убираться само. Таймер, оставшийся от закрытого стола, и подписка,
 * оставшаяся от закрытой страницы, не болят в первый день — они болят на
 * третьей неделе аптайма, когда их уже тысячи.
 */
import { Table, user, durakDecks } from '../bot/harness.js';
import { Hub } from '../bot/hub.js';
import { App } from '../bot/app.js';
import { TelegramStub } from '../bot/tg-stub.js';
import { FakeClock, initDataFor, TEST_TOKEN } from '../bot/harness.js';

const ms = (f) => { const t = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t) / 1e6; };
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed / 1048576; };
const row = (what, got, note = '') => console.log(`${what.padEnd(46)} ${String(got).padStart(10)}  ${note}`);

/* ---------------------------------------------- 1. сто столов и часы */

function tables(n) {
  const tg = new TelegramStub();
  const clock = new FakeClock();
  const app = new App({ api: tg, botUsername: 'B', minIntervalMs: 0, clock, durakDeck: durakDecks(1) });
  const hub = new Hub(app, { botToken: TEST_TOKEN });
  app.attachHub(hub);
  for (let i = 0; i < n; i++) {
    const chatId = `-${100000 + i}`;
    const room = app.createGame('durak', { chatId, title: `Г${i}`, host: { id: 1000 + i, tgId: 1000 + i, name: `Х${i}` } });
    for (let k = 1; k < 4; k++) {
      const g = app.games?.durak;
      void g;
      room.players.push({ id: String(2000 + i * 10 + k), tgId: 2000 + i * 10 + k, name: `И${k}`, dm: 'ok', joinedAt: Date.now(), seated: true, left: false, kicked: false, stats: { games: 0, fool: 0 } });
    }
  }
  return { app, hub, tg, clock };
}

console.log('\n=== 1. Сто столов: сколько стоят часы ===');
for (const n of [10, 50, 100, 200]) {
  const { app } = tables(n);
  app.syncClocks();
  const t = ms(() => { for (let i = 0; i < 100; i++) app.syncClocks(); }) / 100;
  row(`syncClocks при ${n} столах`, t.toFixed(3) + ' мс', t * n > 50 ? '← дорого' : '');
  app.stop();
}

console.log('\n=== 2. Таймеры не копятся ===');
{
  const { app } = tables(100);
  app.syncClocks();
  row('таймеров при 100 живых столах', app.handles.size);
  for (const room of [...app.rooms.values()]) await app.dropGame(room);
  row('таймеров после закрытия всех столов', app.handles.size, app.handles.size === 0 ? '' : '← УТЕЧКА');
  row('столов в памяти', app.rooms.size, app.rooms.size === 0 ? '' : '← УТЕЧКА');
  app.stop();
}

console.log('\n=== 3. Подписки закрытых страниц не копятся ===');
{
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'durak' });
  const code = t.durak.code;
  const sessions = [];
  for (let i = 0; i < 300; i++) {
    const u = user(5000 + i, `Гость${i}`);
    const r = t.hub.open({ initData: initDataFor(u, { startParam: code, clock: t.clock }) }, () => {});
    sessions.push(r.session);
  }
  const live = [...t.hub.byRoom.values()].reduce((s, x) => s + x.size, 0);
  row('подписок при 300 открытых страницах', live);
  for (const s of sessions) t.hub.close(s);
  const after = [...t.hub.byRoom.values()].reduce((s, x) => s + x.size, 0);
  row('подписок после закрытия всех', after, after <= 1 ? '' : '← УТЕЧКА');
  row('пустых множеств осталось', [...t.hub.byRoom.values()].filter((x) => !x.size).length, '');
  // Страница, потерянная без close (вкладку убили): уходит ли она при forget.
  for (let i = 0; i < 100; i++) {
    const u = user(7000 + i, `Призрак${i}`);
    t.hub.open({ initData: initDataFor(u, { startParam: code, clock: t.clock }) }, () => {});
  }
  const before = [...t.hub.byRoom.values()].reduce((s, x) => s + x.size, 0);
  t.hub.forget(code);
  const ghosts = [...t.hub.byRoom.values()].reduce((s, x) => s + x.size, 0);
  row('подписок до удаления стола', before);
  row('подписок после удаления стола', ghosts, ghosts === 0 ? '' : '← УТЕЧКА');
  t.app.stop();
}

console.log('\n=== 4. Очередь отправки ===');
{
  const t = new Table({ minIntervalMs: 0 });
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) t.app.outbox.post(String(-900000 - (i % 50)), `сообщение ${i}`);
  await t.app.settle();
  const sent = t.tg.calls.filter((c) => c.method === 'sendMessage').length;
  row('1000 сообщений в 50 чатов: ушло', sent, sent >= 1000 ? '' : '← ПОТЕРЯНЫ');
  row('заняло', (Date.now() - t0) + ' мс');
  row('чатов в памяти очереди', t.app.outbox.chats.size);
  t.app.stop();
}

console.log('\n=== 5. Память за долгую работу ===');
{
  const before = heap();
  const { app } = tables(100);
  app.syncClocks();
  const peak = heap();
  for (const room of [...app.rooms.values()]) await app.dropGame(room);
  app.stop();
  const after = heap();
  row('до 100 столов', before.toFixed(1) + ' МБ');
  row('со 100 столами', peak.toFixed(1) + ' МБ', `+${(peak - before).toFixed(1)}`);
  row('после закрытия всех', after.toFixed(1) + ' МБ', `не отыграно ${(after - before).toFixed(1)} МБ`);
}

console.log('\n=== 6. Размер строки в базе ===');
{
  const t = new Table({ durakDeck: durakDecks(2) });
  const ivan = user(101, 'Иван');
  const max = user(202, 'Макс');
  for (const u of [ivan, max]) await t.start(u);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'durak' });
  t.openRoom(max, t.durak);
  await t.send(max, { t: 'sit' });
  await t.send(ivan, { t: 'start' });
  const room = t.durak;
  const size = () => JSON.stringify(t.app.serializeFor?.(room) ?? room).length;
  row('комната после первой сдачи', size() + ' байт');
  for (let i = 0; i < 200; i++) room.history.push({ no: i, fool: '101', draw: false, out: ['202'] });
  row('после 200 партий в истории', size() + ' байт', size() > 200000 ? '← растёт без границ' : '');
  t.app.stop();
}
console.log('');
