'use strict';
/**
 * Игры с ботами: вход из лички бота, без группы.
 *
 * Здесь — ядро: одиночный стол, драйвер ботов и их границы. Боты отдельных
 * игр — в тестах этих игр (chess.bot.test.js и др.).
 *
 *   ОДИН ИГРОК, НОЛЬ ГРУПП. Ни карточки в чате, ни лички «ваш ход», ни
 *   рейтинга: партия с ботами — тренировка и не должна кормить таблицу людей.
 *
 *   СВОЯ ПАРТИЯ ТОЛЬКО У СЕБЯ. Чужой стол с ботами по коду не открыть.
 *
 *   БОТ — ТАКОЙ ЖЕ ИГРОК. Ходит через тот же handle с теми же проверками;
 *   человек не может сходить за бота, а бот — за человека.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, initDataFor } from './harness.js';
import { Store } from './store.js';
import { seededRng } from './deck.js';
import { SOLO_IDLE_MS } from './app.js';

const IVAN = user(101, 'Иван');
const MAX = user(202, 'Макс');

const errors = (t, u) => t.page(u).inbox.filter((m) => m.t === 'error');
const solo = (t, u = IVAN) => t.app.soloOf(String(u.id));

/** Дождаться, пока бот сходит: часы тикают, а движок думает в своём потоке. */
async function botMoves(t, room, plies, tries = 40) {
  for (let i = 0; i < tries && room.match.moves.length < plies; i++) {
    await t.advance(1_000);
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(room.match.moves.length, plies, 'бот сходил');
}

async function chessVsBot(t, settings = { level: 0, side: 'white' }) {
  await t.start(IVAN);
  t.openSolo(IVAN);
  await t.send(IVAN, { t: 'play', game: 'chess', settings });
  return solo(t);
}

test('экран игр с ботами: список игр, без групп и без столов', async () => {
  const t = new Table();
  t.openSolo(IVAN);
  const s = t.state(IVAN);
  assert.equal(s.kind, 'solo');
  assert.ok(s.games.some((g) => g.id === 'chess'), 'шахматы есть');
  assert.equal(s.resume, null, 'продолжать нечего');
  assert.equal(t.app.rooms.size, 0, 'ничего не создано, пока не нажали');
});

test('шахматы против бота: партия сразу идёт, человек белыми, бот отвечает сам', async () => {
  const t = new Table({ botRng: seededRng(3) });
  const room = await chessVsBot(t);
  assert.ok(room.solo, 'одиночный стол');
  assert.equal(room.players.length, 2);
  assert.ok(room.players[1].bot, 'второй — бот');
  assert.equal(room.status, 'playing', 'начинать не нужно — партия сразу идёт');
  assert.equal(room.match.white, '101');
  const s = t.state(IVAN);
  assert.equal(s.game, 'chess');
  assert.equal(s.solo, true);
  assert.equal(s.hubLabel, '← Игры с ботами');
  await t.send(IVAN, { t: 'move', from: 'e2', to: 'e4', ply: 0 });
  await botMoves(t, room, 2);
  assert.equal(t.state(IVAN).legal.myTurn, true, 'снова ход человека');
});

test('партия с ботами не трогает групп: ни карточки, ни лички, ни рейтинга', async () => {
  const t = new Table({ store: new Store(':memory:'), botRng: seededRng(5) });
  const room = await chessVsBot(t, { level: 0, side: 'white' });
  await t.send(IVAN, { t: 'move', from: 'f2', to: 'f3', ply: 0 });
  await botMoves(t, room, 2);
  await t.send(IVAN, { t: 'move', from: 'g2', to: 'g4', ply: 2 });
  await botMoves(t, room, 4);
  await t.send(IVAN, { t: 'resign' });
  assert.ok(room.match.over);
  const posts = t.tg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  assert.ok(posts.every((c) => c.chatId === String(IVAN.id)), 'ни одного сообщения в чатах, кроме лички «Старт»');
  assert.equal(posts.filter((c) => /Шахматы|Ваш ход|ИТОГИ/.test(c.text)).length, 0, 'ни карточки, ни «ваш ход», ни итогов');
  assert.equal(t.app.store.ratingOf(101, 'chess'), null, 'в рейтинг не пошло');
  assert.equal(t.app.groupsOf('101').length, 0, 'партия с ботами не делает из лички «группу»');
  t.app.store.close();
});

test('чужую партию с ботами по коду не открыть, а свою — можно после обрыва связи', async () => {
  const t = new Table();
  const room = await chessVsBot(t);
  const r = t.open(MAX, { initData: initDataFor(MAX, { startParam: room.code, clock: t.clock }) });
  assert.equal(r.error, 'NO_ROOM');
  t.close(IVAN);
  t.open(IVAN, { initData: initDataFor(IVAN, { startParam: 'solo', clock: t.clock }), room: room.code });
  assert.equal(t.state(IVAN).room.code, room.code, 'переподключение возвращает за свой стол');
});

test('за бота не сходить: человек получает отказ, бот ходит сам', async () => {
  const t = new Table({ botRng: seededRng(2) });
  const room = await chessVsBot(t);
  await t.send(IVAN, { t: 'move', from: 'e2', to: 'e4', ply: 0 });
  // Сейчас ход бота (чёрные). Иван пытается сходить за него.
  await t.send(IVAN, { t: 'move', from: 'e7', to: 'e5', ply: 1, uid: 'bot1' });
  assert.equal(errors(t, IVAN).at(-1).code, 'NOT_YOUR_TURN');
  assert.equal(room.match.moves.length, 1);
  await botMoves(t, room, 2);
});

test('бот отвечает на просьбы: слабый разрешает откат', async () => {
  const t = new Table({ botRng: seededRng(4) });
  const room = await chessVsBot(t, { level: 0, side: 'white' });
  await t.send(IVAN, { t: 'move', from: 'e2', to: 'e4', ply: 0 });
  await botMoves(t, room, 2);
  await t.send(IVAN, { t: 'move', from: 'd2', to: 'd4', ply: 2 });
  await botMoves(t, room, 4);
  await t.send(IVAN, { t: 'takeback' });
  for (let i = 0; i < 10 && room.match.moves.length === 4; i++) await t.advance(1_000);
  assert.equal(room.match.moves.length, 2, 'бот-новичок разрешил вернуть ход (и свой ответ тоже)');
});

test('новая партия с ботами заменяет прежнюю; «Продолжить» ведёт в живую', async () => {
  const t = new Table();
  const first = await chessVsBot(t);
  await t.send(IVAN, { t: 'hub' });
  assert.equal(t.state(IVAN).kind, 'solo');
  assert.equal(t.state(IVAN).resume.code, first.code, 'есть что продолжить');
  await t.send(IVAN, { t: 'resume' });
  assert.equal(t.state(IVAN).room.code, first.code);
  await t.send(IVAN, { t: 'hub' });
  await t.send(IVAN, { t: 'play', game: 'chess', settings: { level: 1 } });
  assert.equal(t.app.rooms.has(first.code), false, 'старая партия закрыта');
  assert.equal(t.app.liveRooms('solo:101').length, 1);
});

test('брошенная партия с ботами исчезает сама через три часа — без единого сообщения', async () => {
  const t = new Table();
  const room = await chessVsBot(t);
  const before = t.tg.calls.length;
  await t.advance(SOLO_IDLE_MS - 60_000);
  assert.ok(t.app.rooms.has(room.code), 'ещё жива');
  await t.advance(60_000);
  assert.equal(t.app.rooms.has(room.code), false, 'убрана');
  assert.equal(t.tg.calls.filter((c) => c.method === 'sendMessage').length, t.tg.calls.slice(0, before).filter((c) => c.method === 'sendMessage').length, 'никому ничего не написано');
});

test('из лички: /bot присылает кнопку «Играть с ботом», /start — её же рядом с группами', async () => {
  const t = new Table({ webappUrl: 'https://poker.example' });
  await t.start(IVAN);
  const start = t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === '101').at(-1);
  assert.ok(start, 'ответ на /start');
  const startMsg = [...t.tg.messages.values()].filter((m) => m.chatId === '101').at(-1);
  assert.ok(startMsg.markup.inline_keyboard.flat().some((b) => b.web_app?.url === 'https://poker.example/?room=solo'));
  await t.dm(IVAN, '/bot');
  const botMsg = [...t.tg.messages.values()].filter((m) => m.chatId === '101').at(-1);
  assert.match(botMsg.text, /Партия с ботами/);
  assert.equal(botMsg.markup.inline_keyboard[0][0].web_app.url, 'https://poker.example/?room=solo');
});

test('обслуживание: бот не ходит, пока всё стоит, и доигрывает после', async () => {
  const t = new Table({ admins: ['101'], botRng: seededRng(8) });
  const room = await chessVsBot(t);
  await t.send(IVAN, { t: 'move', from: 'e2', to: 'e4', ply: 0 });
  t.app.setMaintenance(true, 'Пять минут');
  await t.advance(30_000);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(room.match.moves.length, 1, 'бот ждёт вместе со всеми');
  t.app.setMaintenance(false);
  await botMoves(t, room, 2);
});

test('рейтинг: даже законченная «победа» над ботом не пишется в таблицу людей', async () => {
  const t = new Table({ store: new Store(':memory:') });
  const room = await chessVsBot(t);
  // Партия, которую рейтинг принял бы у людей: мат на 30-м полуходе.
  room.history.push({ no: 1, white: '101', black: 'bot1', winner: '101', kind: 'mate', aborted: false, plies: 30 });
  assert.deepEqual(t.app.rate(room), [], 'ничего не засчитано');
  assert.equal(t.app.store.ratingOf(101, 'chess'), null);
  t.app.store.close();
});
