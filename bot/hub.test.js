'use strict';
/**
 * The game hub: `/play` in a group → the Mini App for THAT group → pick a
 * game → a lobby with its own card in the group. Several games in one group
 * at once, poker exactly as before, and a page may only ever step into the
 * rooms of the group it was opened for.
 *
 * End-to-end over the stubbed Telegram and the real hub, as app.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Table, user, initDataFor, TEST_TOKEN, FakeClock } from './harness.js';
import { App } from './app.js';
import { Hub } from './hub.js';
import { Store } from './store.js';
import { createRoom, addPlayer, serialize } from './room.js';

const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });

/** New messages the bot posted into the group (not edits). */
const groupPosts = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId));

/* ------------------------------------------------------------ /play */

test('/play posts «Во что играем?» with a button that opens the Mini App for this group', async () => {
  const t = new Table({ botUsername: 'All_InPoker_bot', miniAppName: 'table' });
  await t.cmd(user(101, 'Иван'), '/play');
  const card = t.tg.live(t.chatId);
  assert.match(card.text, /Во что играем\?/);
  assert.match(card.text, /Покер/);
  assert.match(card.text, /Дурак/);
  const [btn] = card.markup.inline_keyboard.flat();
  assert.equal(btn.url, `https://t.me/All_InPoker_bot/table?startapp=g_${t.group.code}`);
  assert.match(t.group.code, /^[a-z0-9]{10}$/, 'a random code…');
  assert.ok(!btn.url.includes(String(t.chatId).replace('-', '')), '…that is not the chat id');
  assert.ok(btn.url.split('startapp=')[1].length <= 64, 'startapp fits Telegram\'s 64 characters');
  assert.equal(t.app.rooms.size, 0, 'no game is created by /play itself');
});

test('a second /play posts a fresh card; the old one loses its button, the group keeps its code', async () => {
  const t = new Table();
  await t.cmd(user(101, 'Иван'), '/play');
  const code = t.group.code;
  const first = t.group.ui.hubMessageId;
  await t.cmd(user(202, 'Макс'), '/play');
  assert.notEqual(t.group.ui.hubMessageId, first);
  assert.equal(t.tg.message(first).markup, null);
  assert.equal(t.group.code, code, 'links posted earlier keep working');
});

test('without a registered Mini App, /play goes through the private chat, which answers with a web_app button', async () => {
  const t = new Table({ botUsername: 'All_InPoker_bot', miniAppName: '', webappUrl: 'https://poker.example' });
  await t.cmd(user(101, 'Иван'), '/play');
  const [btn] = t.tg.live(t.chatId).markup.inline_keyboard.flat();
  assert.equal(btn.url, `https://t.me/All_InPoker_bot?start=g_${t.group.code}`);
  const max = user(202, 'Макс');
  await t.start(max, `g_${t.group.code}`);
  const dm = t.tg.messages.get([...t.tg.messages.keys()].at(-1));
  assert.deepEqual(dm.markup.inline_keyboard[0][0].web_app, { url: `https://poker.example/?room=g_${t.group.code}` });
});

test('/play in the private chat creates nothing', async () => {
  const t = new Table();
  const u = user(101, 'Иван');
  await t.start(u);
  await t.dm(u, '/play');
  assert.equal(t.app.groups.size, 0);
  assert.match(t.lastDm(u), /в группе/);
});

/* ------------------------------------------------------------ the hub */

test('the hub shows the games — poker and durak, with how many can play — and what is open in the group', async () => {
  const t = new Table();
  await t.cmd(user(101, 'Иван'), '/play');
  const ivan = user(101, 'Иван');
  const r = t.openHub(ivan);
  assert.ok(r.session);
  const s = t.state(ivan);
  assert.equal(s.kind, 'hub');
  assert.deepEqual(s.games.map((g) => [g.id, g.title, g.min, g.max]), [['poker', 'Покер', 2, 8], ['durak', 'Дурак', 2, 6]]);
  assert.equal(s.group.title, 'Покер по пятницам');
  assert.deepEqual(s.lobbies, []);
});

test('create a durak lobby from the hub: a card of its own in the group, and the page steps into it', async () => {
  const cast = THREE();
  const t = new Table();
  await t.cmd(cast.ivan, '/play');
  t.openHub(cast.ivan);
  const before = groupPosts(t).length;
  await t.send(cast.ivan, { t: 'create', game: 'durak', settings: { variant: 'perevodnoy' } });

  const room = t.durak;
  assert.ok(room, 'a durak game exists');
  assert.equal(room.hostId, '101', 'the creator is the host');
  assert.equal(room.settings.variant, 'perevodnoy');
  assert.equal(groupPosts(t).length, before + 1, 'exactly one new message in the group: its card');
  const card = t.tg.message(room.ui.tableMessageId);
  assert.match(card.text, /Дурак<\/b> · переводной/);
  assert.match(card.text, /Игроков: <b>1\/6<\/b>/);
  assert.equal(card.markup.inline_keyboard[0][0].text, '🃏 Присоединиться');
  assert.equal(card.markup.inline_keyboard[0][0].url, `https://t.me/ChipTableBot/table?startapp=${room.code}`);

  const s = t.state(cast.ivan);
  assert.equal(s.game, 'durak');
  assert.equal(s.room.code, room.code);
  assert.equal(s.hub, true, 'came from the hub: the page offers the way back');
});

test('friends see the lobby in the hub and join it from there — or by the card', async () => {
  const cast = THREE();
  const t = new Table();
  await t.cmd(cast.ivan, '/play');
  t.openHub(cast.ivan);
  t.openHub(cast.max);
  await t.send(cast.ivan, { t: 'create', game: 'durak' });
  const room = t.durak;

  const hub = t.state(cast.max);
  assert.equal(hub.kind, 'hub', 'the list refreshed on its own');
  assert.deepEqual(hub.lobbies.map((l) => [l.game, l.code, l.seated, l.max, l.host]), [['durak', room.code, 1, 6, 'Иван']]);

  await t.send(cast.max, { t: 'join', code: room.code });
  assert.equal(t.state(cast.max).game, 'durak');
  assert.equal(room.players.length, 1, 'stepping in is not sitting down');
  await t.send(cast.max, { t: 'sit' });
  assert.equal(room.players.length, 2);

  // Дима comes by the card in the group, not through the hub.
  t.openRoom(cast.dima, room);
  await t.send(cast.dima, { t: 'sit' });
  assert.match(t.tg.message(room.ui.tableMessageId).text, /Игроков: <b>3\/6<\/b> — Иван, Макс, Дима/);
  assert.equal(t.state(cast.dima).hub, undefined, 'a page opened on the lobby itself has no hub to go back to');
});

test('a page opened for one group cannot step into a game of another', async () => {
  const cast = THREE();
  const t = new Table({ chatId: -100111 });
  await t.cmd(cast.ivan, '/play');
  const groupA = t.group;
  t.chatId = -100222; // the same bot, another group
  await t.cmd(cast.max, '/newgame');
  const otherRoom = t.room;
  t.chatId = -100111;

  t.openHub(cast.dima, { group: groupA });
  await t.send(cast.dima, { t: 'join', code: otherRoom.code });
  assert.equal(t.lastError(cast.dima).code, 'NO_ROOM');
  assert.equal(t.state(cast.dima).kind, 'hub', 'still on the hub of his own group');

  // Nor by asking for it on (re)connect.
  t.close(cast.dima);
  t.openHub(cast.dima, { group: groupA, room: otherRoom.code });
  assert.equal(t.state(cast.dima).kind, 'hub');
});

test('a hub page that reconnects comes back to the lobby it had stepped into', async () => {
  const cast = THREE();
  const t = new Table();
  await t.cmd(cast.ivan, '/play');
  t.openHub(cast.ivan);
  await t.send(cast.ivan, { t: 'create', game: 'durak' });
  const code = t.durak.code;
  t.close(cast.ivan);
  t.openHub(cast.ivan, { room: code });
  assert.equal(t.state(cast.ivan).game, 'durak');
  assert.equal(t.state(cast.ivan).room.code, code);
  await t.send(cast.ivan, { t: 'hub' });
  assert.equal(t.state(cast.ivan).kind, 'hub', 'and back to the list');
});

test('the way back to the hub is only for a page that came from it', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/newgame');
  await t.cmd(ivan, '/play');
  t.openRoom(ivan, t.room);
  await t.send(ivan, { t: 'hub' });
  assert.equal(t.lastError(ivan).code, 'NOT_FROM_HUB');
  assert.equal(t.state(ivan).game, 'poker');
});

test('a double tap on «Создать лобби» makes one lobby, not two cards', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'durak' });
  await t.send(ivan, { t: 'hub' });
  await t.send(ivan, { t: 'create', game: 'durak' });
  assert.equal(t.app.roomsOf(t.chatId).length, 1);
  assert.ok(t.page(ivan).inbox.some((m) => m.t === 'notice'), 'told it is the same one');
  assert.equal(t.state(ivan).game, 'durak');
});

test('a poker table from the hub takes its settings from the create screen, and is the same poker', async () => {
  const cast = THREE();
  const t = new Table();
  await t.cmd(cast.ivan, '/play');
  t.openHub(cast.ivan);
  await t.send(cast.ivan, { t: 'create', game: 'poker', settings: { startingStack: 5000, smallBlind: 50, bigBlind: 100, turnSeconds: 60 } });
  const room = t.room;
  assert.equal(room.game, 'poker');
  assert.deepEqual([room.settings.startingStack, room.settings.smallBlind, room.settings.bigBlind, room.settings.turnSeconds], [5000, 50, 100, 60]);
  assert.equal(room.players[0].stack, 5000);
  assert.deepEqual(room.undo, [], 'nothing for the host to "undo" on a fresh table');
  assert.match(t.text(), /Покерная комната/);
  assert.equal(t.cardButtons()[0].text, '🃏 Открыть стол', 'the poker card is the poker card');
  t.openRoom(cast.max, room);
  await t.send(cast.max, { t: 'sit' });
  await t.send(cast.ivan, { t: 'start' });
  assert.equal(t.state(cast.ivan).hand.no, 1);
});

test('an unknown game or a strange message on the hub is refused, with words', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'chess' });
  assert.equal(t.lastError(ivan).code, 'BAD_GAME');
  await t.send(ivan, { t: 'act', action: 'fold' });
  assert.equal(t.lastError(ivan).code, 'BAD_REQUEST');
  assert.equal(t.app.rooms.size, 0);
});

/* ------------------------------------------------- several games at once */

test('one group, several games: each has its own card, and one moving does not touch the other', async () => {
  const cast = THREE();
  const t = new Table();
  await t.cmd(cast.ivan, '/newgame'); // poker, as before
  const poker = t.room;
  await t.send(cast.max, { t: 'sit' });
  await t.cmd(cast.dima, '/play');
  t.openHub(cast.dima);
  await t.send(cast.dima, { t: 'create', game: 'durak' });
  const durak = t.durak;
  assert.notEqual(poker.ui.tableMessageId, durak.ui.tableMessageId);

  const durakText = t.tg.message(durak.ui.tableMessageId).text;
  t.openRoom(cast.ivan, poker); // the newest game is the durak one: open the poker table by its card
  await t.send(cast.ivan, { t: 'start' }); // a poker hand is dealt
  assert.match(t.tg.message(poker.ui.tableMessageId).text, /Идёт игра · раздача #1/);
  assert.equal(t.tg.message(durak.ui.tableMessageId).text, durakText, 'the durak card did not move');

  t.close(cast.ivan);
  const hub = t.openHub(cast.ivan);
  assert.ok(hub.session);
  const s = t.state(cast.ivan);
  assert.deepEqual(s.lobbies.map((l) => l.game).sort(), ['durak', 'poker'], 'the hub lists both');
  assert.equal(s.lobbies.find((l) => l.game === 'poker').status, 'playing');
});

test('/newgame still makes poker — refused only while a poker table is live, with /play for more', async () => {
  const cast = THREE();
  const t = new Table();
  await t.cmd(cast.ivan, '/play');
  t.openHub(cast.ivan);
  await t.send(cast.ivan, { t: 'create', game: 'durak' });
  await t.cmd(cast.max, '/newgame');
  assert.equal(t.room.game, 'poker', 'a durak lobby does not block poker');
  await t.cmd(cast.dima, '/newgame');
  assert.match(t.lastPost(), /Стол уже есть.*\/play/s);
  assert.equal(t.app.roomsOf(t.chatId).length, 2);
});

test('/table brings every live game\'s card down; /finish and /cancel touch only the caller\'s own game', async () => {
  const cast = THREE();
  const t = new Table();
  await t.cmd(cast.ivan, '/newgame');
  const poker = t.room;
  await t.cmd(cast.max, '/play');
  t.openHub(cast.max);
  await t.send(cast.max, { t: 'create', game: 'durak' });
  const durak = t.durak;
  const ids = [poker.ui.tableMessageId, durak.ui.tableMessageId];

  await t.cmd(cast.dima, '/table');
  assert.notEqual(poker.ui.tableMessageId, ids[0]);
  assert.notEqual(durak.ui.tableMessageId, ids[1]);
  assert.equal(t.tg.message(ids[0]).markup, null);
  assert.equal(t.tg.message(ids[1]).markup, null);

  await t.cmd(cast.max, '/cancel'); // Макс hosts the durak game only
  assert.equal(t.app.roomByCode(durak.code), null);
  assert.ok(t.app.roomByCode(poker.code), 'the poker table is not his to delete');
  await t.cmd(cast.max, '/finish');
  assert.match(t.lastPost(), /Это может только хост — Иван/);
  assert.equal(poker.status, 'lobby');
});

test('a player leaving the group leaves every game of it', async () => {
  const cast = THREE();
  const t = new Table();
  await t.cmd(cast.ivan, '/newgame');
  const poker = t.room;
  await t.send(cast.max, { t: 'sit' });
  await t.cmd(cast.ivan, '/play');
  t.openHub(cast.ivan);
  await t.send(cast.ivan, { t: 'create', game: 'durak' });
  t.openRoom(cast.max, t.durak);
  await t.send(cast.max, { t: 'sit' });
  await t.raw({
    update_id: 71,
    message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'supergroup' }, from: cast.max,
      left_chat_member: { id: 202, is_bot: false, first_name: 'Макс' } },
  });
  assert.equal(poker.players.find((p) => p.id === '202').left, true);
  assert.equal(t.durak.players.find((p) => p.id === '202').left, true);
});

test('the bot removed from the group takes all its games and its hub with it', async () => {
  const cast = THREE();
  const t = new Table();
  await t.cmd(cast.ivan, '/newgame');
  await t.cmd(cast.ivan, '/play');
  t.openHub(cast.max);
  await t.send(cast.max, { t: 'create', game: 'durak' });
  await t.raw({
    update_id: 72,
    my_chat_member: { chat: { id: t.chatId, type: 'supergroup' }, from: cast.ivan, new_chat_member: { status: 'kicked', user: { id: 1, is_bot: true } } },
  });
  assert.equal(t.app.rooms.size, 0);
  assert.equal(t.group, null);
  assert.ok(t.page(cast.max).inbox.some((m) => m.t === 'gone'));
});

test('a group promoted to a supergroup keeps all its games and its hub code', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = new Table({ store });
  await t.cmd(cast.ivan, '/newgame');
  await t.cmd(cast.ivan, '/play');
  t.openHub(cast.max);
  await t.send(cast.max, { t: 'create', game: 'durak' });
  const codes = t.app.roomsOf(t.chatId).map((r) => r.code).sort();
  const hubCode = t.group.code;
  const NEW = -1005555;
  await t.raw({ update_id: 73, message: { message_id: t.tg.nextId++, chat: { id: t.chatId, type: 'group' }, from: cast.ivan, migrate_to_chat_id: NEW } });
  assert.deepEqual(t.app.roomsOf(NEW).map((r) => r.code).sort(), codes);
  assert.equal(t.app.groups.get(String(NEW)).code, hubCode);
  assert.deepEqual(store.loadAll().map((r) => r.chatId), [String(NEW), String(NEW)]);
  assert.equal(store.loadGroups()[0].chatId, String(NEW));
  store.close();
});

/* ------------------------------------------------------------ old links */

test('an old poker link (startapp=<code>) opens the table exactly as before', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/newgame');
  const max = user(202, 'Макс');
  const r = t.open(max, { initData: initDataFor(max, { startParam: t.room.code, clock: t.clock }) });
  assert.ok(r.session);
  const s = t.state(max);
  assert.equal(s.game, 'poker');
  assert.equal(s.room.code, t.room.code);
  assert.ok('hand' in s && 'legal' in s && 'players' in s, 'the poker state, as the table expects it');
});

test('a hub code nobody knows says what to do', () => {
  const t = new Table();
  const r = t.open(user(101, 'Иван'), { initData: initDataFor(user(101, 'Иван'), { startParam: 'g_nosuchgroup' }) });
  assert.equal(r.error, 'NO_ROOM');
  assert.match(r.text, /\/play/);
});

/* ---------------------------------------------------------- the database */

test('a database from before the hub is carried over: the table comes back, as poker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-v1-'));
  const file = path.join(dir, 'bot.db');
  // The first schema: rooms keyed by chat — one table per group.
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE rooms (chat_id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT, updated_at INTEGER NOT NULL);
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE users (user_id TEXT PRIMARY KEY, dm TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
  const room = createRoom({ chatId: -1001, host: { id: 1, name: 'Иван' } });
  addPlayer(room, { id: 2, name: 'Макс' });
  old.prepare('INSERT INTO rooms VALUES (?, ?, ?, ?)').run('-1001', JSON.stringify(serialize(room)), 'lobby', 1);
  old.prepare('INSERT INTO rooms VALUES (?, ?, ?, ?)').run('-1002', '{broken', 'lobby', 2);
  old.prepare('INSERT INTO users VALUES (?, ?, ?)').run('2', 'ok', 1);
  old.close();

  const store = new Store(file);
  const rows = store.loadAll();
  assert.equal(rows.length, 1, 'the good table is back; the broken row is kept but not loaded');
  assert.equal(rows[0].code, room.code, 'keyed by its own code now');
  assert.equal(rows[0].chatId, '-1001');
  assert.equal(rows[0].game, 'poker');
  assert.equal(store.getDm('2'), 'ok', 'who pressed Start is kept');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n, 2, 'nothing thrown away');

  const app = new App({ api: {}, store, botUsername: 'ChipTableBot', clock: new FakeClock() });
  assert.equal(app.load(), 1);
  assert.equal(app.room('-1001').players.length, 2);
  store.close();
  new Store(file).close(); // opening it again is a no-op
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a restart brings back the hub of every group and every game in it', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = new Table({ store });
  await t.cmd(cast.ivan, '/play');
  t.openHub(cast.ivan);
  await t.send(cast.ivan, { t: 'create', game: 'durak' });
  await t.cmd(cast.max, '/newgame');
  const hubCode = t.group.code;

  const clock = new FakeClock();
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock, runoutStepMs: 0, miniAppName: 'table' });
  const hub2 = new Hub(app2, { botToken: TEST_TOKEN });
  app2.attachHub(hub2);
  assert.equal(app2.load(), 2);
  await app2.resume();
  const inbox = [];
  const r = hub2.open({ initData: initDataFor(cast.dima, { startParam: `g_${hubCode}`, clock }) }, (m) => inbox.push(m));
  assert.ok(r.session, 'the hub card posted before the restart still opens');
  const s = inbox.at(-1).state;
  assert.deepEqual(s.lobbies.map((l) => l.game).sort(), ['durak', 'poker']);
  store.close();
});
