'use strict';
/**
 * Аудит, фаза 5 (G): рассылка и админка.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { TelegramError } from './tg-stub.js';
import { checkCast, bannedWord } from './broadcast.js';

async function liveDurak(t) {
  const a = user(101, 'А');
  const b = user(102, 'Б');
  await t.cmd(a, '/game');
  await t.cmd(a, '/durak');
  const room = t.durak;
  t.openRoom(b, room);
  await t.send(b, { t: 'sit' });
  t.openRoom(a, room);
  await t.send(a, { t: 'start' });
  return room;
}

for (const refusal of ['Bad Request: have no rights to send a message', 'Bad Request: not enough rights to send text messages to the chat']) {
  test(`АУДИТ G-01: рассылка «во все группы» в группу, где боту временно нельзя писать («${refusal.slice(13, 40)}…»), не сносит её игры`, async () => {
    const t = new Table({ admins: ['999'] });
    const room = await liveDurak(t);
    const code = t.group.code;
    const post = t.tg.sendMessage.bind(t.tg);
    t.tg.sendMessage = async (chatId, text, opts) => {
      if (String(chatId) === String(t.chatId) && /Новости/.test(text)) throw new TelegramError(refusal, 400);
      return post(chatId, text, opts);
    };
    const r = t.app.casts.plan({ text: 'Новости проекта', audience: 'groups' });
    assert.ok(!r.error, r.error);
    await t.advance(60_000);
    assert.ok(t.app.rooms.has(room.code), 'идущая партия на месте');
    assert.equal(room.status, 'playing');
    assert.equal(t.group?.code, code, 'группа и её код на месте');
    const row = t.app.casts.list(1)[0];
    assert.equal(row.status, 'done');
    assert.equal(row.failed, 1, 'в отчёте — «не дошло»');
  });
}

test('АУДИТ G-01: бота правда удалили из группы — её игры убираются, как и раньше', async () => {
  const t = new Table({ admins: ['999'] });
  await liveDurak(t);
  const post = t.tg.sendMessage.bind(t.tg);
  t.tg.sendMessage = async (chatId, text, opts) => {
    if (String(chatId) === String(t.chatId) && /Новости/.test(text)) throw new TelegramError('Forbidden: bot was kicked from the supergroup chat', 403);
    return post(chatId, text, opts);
  };
  t.app.casts.plan({ text: 'Новости проекта', audience: 'groups' });
  await t.advance(60_000);
  assert.equal(t.app.roomsOf(t.chatId).length, 0);
});

test('АУДИТ G-2: кнопка рассылки — только https:// без пробелов', () => {
  for (const url of ['http://x.ru', 'javascript:alert(1)', 'tg://resolve?domain=x', 'https://', 'https://a b', ' https://x', 'HTTPS://ok.ru', 'https://' + 'a'.repeat(5000)]) {
    const r = checkCast({ text: 'x', btnText: 'Жми', btnUrl: url, now: 1 });
    const ok = /^https:\/\/\S+$/i.test(url.trim());
    assert.equal(!r.error, ok, `${url.slice(0, 40)} → ${r.error || 'принят'}`);
  }
});

test('АУДИТ G-1 (замечание): запрет слов обходится раскладкой и пробелами — админ доверен, это защита от случайности', () => {
  assert.ok(bannedWord('Казино!'));
  assert.equal(bannedWord('к а з и н о'), null, 'с пробелами не ловится');
  assert.equal(bannedWord('кaзинo'), null, 'латинские а и о не ловятся');
});

test('АУДИТ G-02: кривая разметка в рассылке — отказ до отправки, словами; правильная проходит', () => {
  for (const text of ['<b>Скидки', 'Tom & Jerry', '<script>x</script>', '<b><i>x</b></i>', 'a < b', '&nbsp;']) {
    const r = checkCast({ text, now: 1 });
    assert.equal(r.error, 'BAD_HTML', `${text}: ${r.error || 'принят'}`);
    assert.match(r.text, /Telegram не примет разметку/);
  }
  for (const text of ['<b>Новое</b> в боте &amp; играх', 'Просто текст', '<a href="https://t.me/x">ссылка</a>', '5 > 3', '<tg-spoiler>секрет</tg-spoiler>']) {
    assert.equal(checkCast({ text, now: 1 }).error, undefined, text);
  }
});
