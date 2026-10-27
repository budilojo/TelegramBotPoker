'use strict';
/**
 * Аудит E-02: одна испорченная строка базы не роняет бота и чужие столы.
 *
 * Строка с правильным JSON, но без нужных полей (так выглядит и запись
 * старой версии после обновления), раньше проходила загрузку — и потом
 * роняла `resume()` на запуске и `syncClocks()` на каждом ходу: таймеры
 * вставали у ВСЕХ столов. Теперь такой стол не поднимается (строка остаётся
 * в базе), а ошибка в часах одного стола не трогает остальные.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './store.js';
import { App } from './app.js';
import { Hub } from './hub.js';
import { TelegramStub } from './tg-stub.js';
import { FakeClock, TEST_TOKEN, user, initDataFor } from './harness.js';

const BROKEN = [{}, { status: 'playing', players: null }, { status: 'playing', players: [], hand: null },
  { status: 'playing', players: [{ id: '1' }], deal: { phase: 'play' } }, { status: 'playing', players: [], match: { pos: null } }, 42, 'x', []];

for (const game of ['poker', 'durak', 'colors', 'chess', 'checkers', 'nardy', 'battleship', 'неизвестная']) {
  test(`АУДИТ E-02: испорченные строки «${game}» в базе — бот поднимается, здоровый стол живёт`, async () => {
    const store = new Store(':memory:');
    const clock = new FakeClock();
    const tg = new TelegramStub();
    const before = new App({ api: tg, store, clock, botUsername: 'B', minIntervalMs: 0 });
    const good = before.createGame('durak', { chatId: '-1', host: { id: 1, tgId: 1, name: 'А' } });
    before.save(good);
    BROKEN.forEach((data, i) => {
      store.db.prepare('INSERT INTO rooms (chat_id, code, game, data, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(`-9${i}`, `bad${i}`, game, JSON.stringify(data), 1);
    });
    const errors = [];
    const app = new App({ api: tg, store, clock, botUsername: 'B', minIntervalMs: 0, onError: (e) => errors.push(e) });
    const hub = new Hub(app, { botToken: TEST_TOKEN });
    app.attachHub(hub);
    assert.equal(app.load(), 1, 'поднят только здоровый стол');
    await app.resume();
    app.syncClocks();
    assert.ok([...app.handles.keys()].some((k) => k.endsWith(good.code)), 'у здорового стола заведены часы');
    assert.ok(hub.open({ initData: initDataFor(user(1, 'А'), { startParam: good.code, clock }) }, () => {}).session, 'и он открывается');
    assert.ok(errors.length >= BROKEN.length - 1, 'про каждую испорченную строку — запись в лог');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE code GLOB 'bad[0-9]'").get().n, BROKEN.length, 'испорченные строки не стёрты');
  });
}

test('АУДИТ E-02: стол, сломавшийся на ходу, не снимает часы остальным', async () => {
  const clock = new FakeClock();
  const errors = [];
  const app = new App({ api: new TelegramStub(), clock, botUsername: 'B', minIntervalMs: 0, onError: (e) => errors.push(e) });
  const a = app.createGame('durak', { chatId: '-1', host: { id: 1, tgId: 1, name: 'А' } });
  const b = app.createGame('poker', { chatId: '-2', host: { id: 2, tgId: 2, name: 'Б' } });
  b.settings = undefined; // часы покера читают settings — теперь падают
  b.status = 'playing';
  app.syncClocks();
  assert.ok([...app.handles.keys()].some((k) => k.endsWith(a.code)), 'часы целого стола заведены');
  assert.ok(errors.length >= 1, 'ошибка сломанного записана');
  app.stop();
});
