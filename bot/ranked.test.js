'use strict';
/**
 * Путь «рейтинговые игры»: выбор игры → рейтинговые столы → присоединиться.
 *
 * Пока рейтинг закрыт, пути нет: сервер не собирает список и отвечает словами.
 * Когда открыт — в списке только столы, объявленные рейтинговыми; обычный стол
 * группы туда не попадает, как бы он ни выглядел.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { RATING_SOON_TEXT } from './app.js';

const gotTables = (t, u) => JSON.parse(t.received(u)).filter((m) => m.t === 'rtables');

test('пока рейтинг закрыт, список рейтинговых столов не отдаётся — отказ словами', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/game');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'durak' }); // обычный стол есть
  t.close(ivan);
  t.openHub(ivan);
  await t.send(ivan, { t: 'rtables', game: 'durak' });
  assert.equal(t.lastError(ivan).code, 'RATING_SOON');
  assert.equal(t.lastError(ivan).text, RATING_SOON_TEXT);
  assert.equal(gotTables(t, ivan).length, 0, 'ни списка, ни его части страница не получила');
});

test('рейтинг открыт: обычный стол группы не попадает в рейтинговые', async () => {
  const t = new Table({ ratingSoon: false });
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/game');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'durak' });
  t.close(ivan);
  t.openHub(ivan);
  assert.equal(t.app.liveRooms(t.chatId).length, 1, 'обычный стол открыт');

  await t.send(ivan, { t: 'rtables', game: 'durak' });
  const [r] = gotTables(t, ivan);
  assert.deepEqual(r.tables, [], 'обычный стол — не рейтинговый');
  assert.equal(r.game, 'durak');

  // Стол, который сам объявлен рейтинговым, появляется — и только он.
  t.app.liveRooms(t.chatId)[0].ranked = true;
  await t.send(ivan, { t: 'rtables', game: 'durak' });
  const last = gotTables(t, ivan).at(-1);
  assert.equal(last.tables.length, 1);
  assert.equal(last.tables[0].host, 'Иван');
  await t.send(ivan, { t: 'rtables', game: 'poker' });
  assert.deepEqual(gotTables(t, ivan).at(-1).tables, [], 'чужая игра не подмешивается');
});

test('рейтинговые столы чужой группы не видны', async () => {
  const t = new Table({ ratingSoon: false });
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/game');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'durak' });
  t.app.liveRooms(t.chatId)[0].ranked = true;

  const stranger = user(777, 'Прохожий');
  await t.app.handleUpdate({
    message: { message_id: t.tg.nextId++, date: t.date, chat: { id: -9, type: 'supergroup', title: 'Чужая' }, from: { id: 777, first_name: 'Прохожий' }, text: '/game' },
  });
  await t.app.settle();
  t.openSolo(stranger);
  await t.send(stranger, { t: 'rtables', game: 'durak' });
  assert.deepEqual(gotTables(t, stranger).at(-1).tables, []);
});

test('несуществующая игра в запросе столов — отказ', async () => {
  const t = new Table({ ratingSoon: false });
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/game');
  t.openHub(ivan);
  await t.send(ivan, { t: 'rtables', game: 'nope' });
  assert.equal(t.lastError(ivan).code, 'NO_RANKED_GAME');
  assert.equal(gotTables(t, ivan).length, 0);
});

test('экраны хаба сообщают список игр для рейтинга и причину «скоро»', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/game');
  t.openHub(ivan);
  assert.equal(t.state(ivan).rankGames.length, 7);
  assert.equal(t.state(ivan).ratingSoon, RATING_SOON_TEXT);
  t.close(ivan);
  t.openSolo(ivan);
  assert.equal(t.state(ivan).kind, 'solo');
  assert.equal(t.state(ivan).rankGames.length, 7);
  assert.equal(t.state(ivan).ratingSoon, RATING_SOON_TEXT);
});

test('рейтинг из «Игр с ботами»: пока закрыт — отказ, открыт — экран и возврат назад', async () => {
  const closed = new Table();
  const a = user(101, 'Иван');
  closed.openSolo(a);
  await closed.send(a, { t: 'rating' });
  assert.equal(closed.lastError(a).code, 'RATING_SOON');
  assert.equal(closed.state(a).kind, 'solo');

  const open = new Table({ ratingSoon: false });
  open.openSolo(a);
  await open.send(a, { t: 'rating' });
  assert.equal(open.state(a).kind, 'rating');
  await open.send(a, { t: 'back' });
  assert.equal(open.state(a).kind, 'solo', 'и назад — туда, откуда пришли');
});

test('«Присоединиться»: закрыт рейтинг — отказ; открыт — только к рейтинговому столу из списка', async () => {
  const closed = new Table();
  const ivan = user(101, 'Иван');
  await closed.cmd(ivan, '/game');
  closed.openHub(ivan);
  await closed.send(ivan, { t: 'create', game: 'durak' });
  const code = closed.app.liveRooms(closed.chatId)[0].code;
  closed.app.liveRooms(closed.chatId)[0].ranked = true; // даже будь он рейтинговым
  closed.close(ivan);
  closed.openHub(ivan);
  await closed.send(ivan, { t: 'rjoin', code });
  assert.equal(closed.lastError(ivan).code, 'RATING_SOON');
  assert.equal(closed.state(ivan).kind, 'hub', 'никуда не пустили');

  const t = new Table({ ratingSoon: false });
  await t.cmd(ivan, '/game');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'durak' });
  const room = t.app.liveRooms(t.chatId)[0];
  t.close(ivan);
  t.openHub(ivan);
  await t.send(ivan, { t: 'rjoin', code: room.code });
  assert.equal(t.lastError(ivan).code, 'NO_ROOM', 'обычный стол по коду не открыть этим путём');
  assert.equal(t.state(ivan).kind, 'hub');
  room.ranked = true;
  await t.send(ivan, { t: 'rjoin', code: room.code });
  assert.equal(t.state(ivan).room.code, room.code, 'рейтинговый — пустили');
});
