/** L: строгая проверка освобождения регистров, без HTTP/Telegram/.env.
 * node --expose-gc --disable-warning=ExperimentalWarning tools/perf-lifecycle.mjs
 * 30 циклов × 7 игр × 3 страницы; виртуальные часы, не замер CPU/FPS.
 */
import assert from 'node:assert/strict';
import { Table, user, initDataFor } from '../bot/harness.js';
import { Store } from '../bot/store.js';
import { GAME_LIST } from '../bot/games/index.js';

const store = new Store(':memory:');
const t = new Table({ store });
const counts = () => ({
  pages: t.hub.pages.size, sessions: t.hub.sessions,
  roomSets: t.hub.byRoom.size, groupSets: t.hub.byGroup.size,
  adminPages: t.hub.adminPages.size, rooms: t.app.rooms.size,
  timers: t.app.handles.size, savedRooms: store.loadAll().length,
});
const zero = { pages: 0, sessions: 0, roomSets: 0, groupSets: 0, adminPages: 0, rooms: 0, timers: 0, savedRooms: 0 };
const checkpoints = [];
let pageCount = 0;
try {
  for (let cycle = 1; cycle <= 30; cycle++) {
    const pages = [];
    for (const [i, g] of GAME_LIST.entries()) {
      const u = user(860000 + i, 'Замер');
      const room = t.app.createGame(g.id, { chatId: String(-860000 - i), title: 'Цикл', host: { id: String(u.id), tgId: u.id, name: u.first_name } });
      assert.ok(!room.error);
      for (let n = 0; n < 3; n++) {
        const opened = t.hub.open({ initData: initDataFor(u, { startParam: room.code, clock: t.clock }) }, () => {});
        assert.ok(opened.session, g.id);
        pages.push(opened.session); pageCount++;
      }
    }
    t.app.syncClocks();
    assert.equal(t.hub.pages.size, GAME_LIST.length * 3);
    assert.equal(t.hub.sessions, GAME_LIST.length * 3);
    assert.equal(t.app.rooms.size, GAME_LIST.length);
    assert.ok(t.app.handles.size >= GAME_LIST.length);
    for (const p of pages) t.hub.close(p);
    assert.equal(t.hub.pages.size, 0, 'закрытые страницы удалены из общего регистра pages');
    assert.equal(t.hub.byRoom.size, 0, 'закрытые страницы удалены из подписок стола');
    for (const room of [...t.app.rooms.values()]) await t.app.dropGame(room);
    await t.app.settle();
    assert.deepEqual(counts(), zero, 'после каждого цикла все временные регистры пусты');
    assert.deepEqual(t.errors, []);
    if (cycle % 10 === 0) checkpoints.push({ cycle, ...counts() });
  }
  console.log(JSON.stringify({ cycles: 30, games: GAME_LIST.map((g) => g.id), roomsCreated: GAME_LIST.length * 30, pagesOpened: pageCount, checkpoints, note: 'TelegramStub, SQLite :memory:, FakeClock; сохранённые пользователи/группы/профили не удаляются, память процесса не обязана стать нулевой' }, null, 2));
} finally { t.app.stop(); store.close(); }
