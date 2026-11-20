/**
 * «Пригласить» на пустых местах: кто видит кнопку, кто нет, что в карточке и
 * в ссылке, нет ли спама. Через стенд — как у «Поделиться итогом».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { GAME_LIST } from './games/index.js';

const IVAN = user(101, 'Иван');
const MAX = user(202, 'Макс');
const DIMA = user(303, 'Дима');
const OPTS = { botUsername: 'ChipTableBot', miniAppName: 'table' };
const errors = (t, u) => t.page(u).inbox.filter((m) => m.t === 'error');
const shares = (t, u) => t.page(u).inbox.filter((m) => m.t === 'share');

async function lobby(t, game, host = IVAN) {
  await t.start(host);
  await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game, settings: {}, reqId: `r-${game}` });
  return [...t.app.rooms.values()].find((r) => r.game === game);
}

for (const g of GAME_LIST) {
  test(`пригласить (${g.id}): хост получает карточку со ссылкой на стол — только код стола, без секретов`, async () => {
    const t = new Table(OPTS);
    const room = await lobby(t, g.id);
    assert.equal(t.state(IVAN).canInvite, true, 'кнопка «Пригласить» есть');
    await t.send(IVAN, { t: 'invite' });
    const msg = shares(t, IVAN).at(-1);
    assert.ok(msg, 'страница получила заготовку');
    assert.equal(msg.link, `https://t.me/ChipTableBot/table?startapp=${room.code}`);
    assert.match(msg.text, new RegExp(`Иван зовёт в ${g.title} — заходи`));
    const sent = t.tg.prepared.at(-1);
    assert.equal(sent.userId, '101', 'отправит сам человек, от своего имени');
    assert.equal(sent.result.reply_markup.inline_keyboard[0][0].url, msg.link);
    assert.ok(!/https?:\/\/(?!t\.me\/)/.test(JSON.stringify(sent.result)), 'ничего с внешних доменов');
  });
}

test('пригласить: повторное нажатие подряд не плодит заготовки', async () => {
  const t = new Table(OPTS);
  await lobby(t, 'durak');
  await t.send(IVAN, { t: 'invite' });
  await t.send(IVAN, { t: 'invite' });
  assert.equal(errors(t, IVAN).at(-1).code, 'TOO_FAST');
  assert.equal(t.tg.prepared.length, 1);
});

test('пригласить: зритель и посторонний не зовут от имени стола', async () => {
  const t = new Table(OPTS);
  const room = await lobby(t, 'durak');
  await t.start(DIMA);
  t.openRoom(DIMA, room);
  await t.send(DIMA, { t: 'invite' });
  assert.equal(errors(t, DIMA).at(-1).code, 'NOT_IN_GAME');
  assert.equal(t.state(DIMA).canInvite, false);
  assert.equal(t.tg.prepared ?? undefined, undefined);
});

test('пригласить: стол полон — кнопки нет, просьба отклонена', async () => {
  const t = new Table(OPTS);
  const room = await lobby(t, 'chess');
  await t.start(MAX);
  t.openRoom(MAX, room);
  await t.send(MAX, { t: 'sit' });
  assert.equal(t.state(IVAN).canInvite, false);
  await t.send(IVAN, { t: 'invite' });
  assert.equal(errors(t, IVAN).at(-1).code, 'NO_FREE_SEATS');
  assert.equal(t.tg.prepared ?? undefined, undefined);
});

test('пригласить: партия идёт — кнопки нет, просьба отклонена', async () => {
  const t = new Table(OPTS);
  const room = await lobby(t, 'chess');
  await t.start(MAX);
  t.openRoom(MAX, room);
  await t.send(MAX, { t: 'sit' });
  await t.send(IVAN, { t: 'start' });
  await t.send(IVAN, { t: 'invite' });
  assert.ok(['NO_FREE_SEATS', 'NOT_INVITABLE'].includes(errors(t, IVAN).at(-1).code));
  assert.equal(t.state(IVAN).canInvite, false);
});

test('пригласить: Telegram не принял заготовку — страница получает текст и ссылку для запасного пути', async () => {
  const t = new Table(OPTS);
  await lobby(t, 'durak');
  t.tg.failNext = { method: 'savePreparedInlineMessage', error: new Error('Bad Request: method not found') };
  await t.send(IVAN, { t: 'invite' });
  const msg = shares(t, IVAN).at(-1);
  assert.equal(msg.id, null);
  assert.match(msg.link, /startapp=/);
  assert.match(msg.text, /зовёт в Дурак/);
});

test('пригласить: имя с разметкой не ломает HTML сообщения', async () => {
  const t = new Table(OPTS);
  const room = await lobby(t, 'durak');
  room.players.find((p) => p.id === '101').name = '<b>Иван</b> & Ко';
  await t.send(IVAN, { t: 'invite' });
  const html = t.tg.prepared.at(-1).result.input_message_content.message_text;
  assert.match(html, /&lt;b&gt;Иван&lt;\/b&gt; &amp; Ко/);
  assert.ok(!html.includes('<b>'));
});

test('пригласить: у бота нет адреса — понятный отказ', async () => {
  const t = new Table({ botUsername: '' });
  await lobby(t, 'durak');
  await t.send(IVAN, { t: 'invite' });
  assert.equal(errors(t, IVAN).at(-1).code, 'SHARE_UNAVAILABLE');
});

test('пригласить в покере: между раздачами можно, во время раздачи нет', async () => {
  const t = new Table(OPTS);
  const room = await lobby(t, 'poker');
  // Состояние «идёт игра» задаём прямо: нужна только фаза раздачи, ход игры здесь не проверяется.
  room.status = 'playing';
  room.hand = { phase: 'flop' };
  assert.equal(t.app.inviteBlock(room, '101'), 'NOT_INVITABLE', 'во время раздачи стол не загромождаем');
});

test('пригласить: партии с ботами и турнирные столы не приглашают', async () => {
  const t = new Table(OPTS);
  const room = await lobby(t, 'durak');
  room.solo = { raw: {} };
  assert.equal(t.app.inviteBlock(room, '101'), 'NOT_INVITABLE');
  delete room.solo;
  room.tournament = {};
  assert.equal(t.app.inviteBlock(room, '101'), 'NOT_INVITABLE');
});

test('пригласить в покере (настоящая раздача): между раздачами кнопка есть, пока раздача идёт — нет', async () => {
  const t = new Table(OPTS);
  const room = await lobby(t, 'poker');
  await t.start(MAX);
  t.openRoom(MAX, room);
  await t.send(MAX, { t: 'sit' });
  await t.send(IVAN, { t: 'start' });
  assert.equal(room.status, 'playing');
  assert.equal(t.state(IVAN).canInvite, false, 'раздача идёт — стол не загромождаем');
  const actor = t.state(IVAN).legal ? IVAN : MAX;
  await t.send(actor, { t: 'act', action: 'fold' });
  assert.equal(room.hand.phase, 'complete');
  await t.advance(10_000); // показ итога закончился
  const shown = t.state(IVAN);
  assert.equal(shown.hand?.phase, 'complete');
  assert.equal(shown.canInvite, true, 'между раздачами — есть');
  await t.send(IVAN, { t: 'invite' });
  assert.ok(shares(t, IVAN).at(-1), 'и карточка готова');
});
