'use strict';
/**
 * «+ Ещё один стол в эту группу» — хаб создаёт второй стол той же игры и с
 * теми же настройками, в той же группе, не трогая уже открытые столы.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { MAX_LIVE_PER_GROUP } from './app.js';

const groupPosts = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId));
const live = (t) => t.app.liveRooms(String(t.chatId));
const host = user(101, 'Иван');

/** Группа с хостом и один открытый стол UNOQ с нестандартными настройками. */
async function withColors(t, settings = { stacking: false, turnSeconds: 60 }) {
  await t.start(host);
  await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game: 'colors', settings });
  return live(t)[0];
}

test('ещё один стол: та же игра и настройки, тот же хост, своя карточка, старый стол не тронут', async () => {
  const t = new Table();
  const first = await withColors(t);
  const firstCard = first.ui.tableMessageId;
  const posts = groupPosts(t).length;

  t.openHub(host);
  assert.equal(t.state(host).again.from, first.code, 'хаб знает, с какого стола брать игру и настройки');
  await t.send(host, { t: 'again', from: first.code, reqId: 'r1' });

  const rooms = live(t);
  assert.equal(rooms.length, 2, 'второй стол создан');
  const second = rooms[1];
  assert.notEqual(second.code, first.code, 'уникальный код');
  assert.equal(second.game, 'colors', 'та же игра');
  assert.deepEqual(second.settings, first.settings, 'те же настройки');
  assert.equal(second.hostId, first.hostId, 'хост — тот, кто нажал');
  assert.equal(second.chatId, first.chatId, 'та же группа');
  assert.equal(first.ui.tableMessageId, firstCard, 'карточка первого стола не тронута');
  assert.equal(groupPosts(t).length, posts + 1, 'в группе появилась ровно одна новая карточка');
  assert.equal(t.state(host).room.code, second.code, 'хост сразу за новым столом');
});

test('повторный тап с тем же reqId не плодит второй стол', async () => {
  const t = new Table();
  const first = await withColors(t);
  t.openHub(host);
  await t.send(host, { t: 'again', from: first.code, reqId: 'same' });
  t.openHub(host);
  await t.send(host, { t: 'again', from: first.code, reqId: 'same' });
  assert.equal(live(t).length, 2, 'двойной тап — один новый стол, а не два');
});

test('лимит 10 живых столов: кнопка выключена, одиннадцатый не создаётся', async () => {
  const t = new Table();
  const first = await withColors(t);
  for (let i = 1; i < MAX_LIVE_PER_GROUP; i++) {
    t.openHub(host);
    await t.send(host, { t: 'again', from: first.code, reqId: `n${i}` });
  }
  assert.equal(live(t).length, MAX_LIVE_PER_GROUP);
  t.openHub(host);
  const s = t.state(host);
  assert.equal(s.full, true, 'хаб сообщает, что лимит достигнут — кнопка выключена');
  assert.equal(s.maxLive, MAX_LIVE_PER_GROUP);

  await t.send(host, { t: 'again', from: first.code, reqId: 'over' });
  assert.equal(live(t).length, MAX_LIVE_PER_GROUP, 'сервер не пустил одиннадцатый стол');
  const refusal = t.page(host).inbox.filter((m) => m.t === 'error').at(-1);
  assert.match(refusal.text, /незаконченных игр/, 'отказ объяснён словами');
});

test('чужой стол из другой группы не подставить: NO_ROOM, ничего не создано', async () => {
  const t = new Table();
  const first = await withColors(t);
  // стол другой группы — прямо в приложении, как если бы его подсунули с чужой страницы
  const foreign = t.app.createGame('colors', { chatId: '-999', title: 'Чужая', host: user(555, 'Чужой') });
  t.openHub(host);
  await t.send(host, { t: 'again', from: foreign.code, reqId: 'steal' });
  assert.equal(live(t).length, 1, 'в нашей группе ничего не появилось');
  assert.equal(live(t)[0].code, first.code);
  const refusal = t.page(host).inbox.filter((m) => m.t === 'error').at(-1);
  assert.equal(refusal.code, 'NO_ROOM');
});

test('без открытого стола кнопки нет: хаб не предлагает копировать несуществующее', async () => {
  const t = new Table();
  await t.start(host);
  await t.cmd(host, '/play');
  t.openHub(host);
  assert.equal(t.state(host).again, null);
});
