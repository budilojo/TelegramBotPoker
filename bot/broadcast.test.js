'use strict';
/**
 * Рассылка.
 *
 * Три обещания, которые тут проверяются построчно:
 *   — письмо уходит только тем, кто открыл личку сам, и не уходит тем, кто
 *     отписался (отписка сильнее любой аудитории и любого перезапуска);
 *   — под каждым письмом кнопка «не присылать такое», и она работает с
 *     первого тапа;
 *   — темп ниже лимита Telegram, иначе из-за рассылки встанет игра.
 *
 * Плюс то, без чего отложенная отправка была бы обманом: в назначенное время,
 * а не раньше; отменённая не уходит; пропущенная из-за простоя — только пока
 * свежая.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { SEND_GAP_MS, STALE_MS, checkCast, bannedWord } from './broadcast.js';
import { ADS_OFF } from './app.js';
import { pressUpdate } from './tg-stub.js';

const withStats = (opts = {}) => new Table({ store: new Store(':memory:'), admins: ['101'], ...opts });
const IVAN = () => user(101, 'Иван');

/** Нажали Start у игрового бота — только таким бот и может написать. */
async function started(t, ...users) {
  for (const u of users) await t.start(u);
  return t;
}

/** Прогнать рассылку до конца: 8 писем в секунду на игровых часах. */
const flush = (t, n = 50) => t.advance((n + 2) * SEND_GAP_MS);

/** Что получил человек, кроме приветствия после Start. */
const letters = (t, u) => t.tg.dms(u.id).filter((x) => !x.includes('Готово'));

/* ------------------------------------------------------------- проверки */

test('пустое, слишком длинное и казино — не отправляются', () => {
  assert.equal(checkCast({ text: '   ' }).error, 'EMPTY');
  assert.equal(checkCast({ text: 'a'.repeat(5000) }).error, 'LONG');
  const casino = checkCast({ text: 'Лучшее казино для наших игроков' });
  assert.equal(casino.error, 'BANNED');
  assert.match(casino.text, /казино/, 'отказ говорит, какое слово мешает');
  assert.equal(bannedWord('ставки на спорт с бонусом'), 'ставки на спорт');
  assert.equal(bannedWord('турнир по покеру в субботу'), null, 'сам покер под запрет не попадает');
});

test('кнопка без ссылки и ссылка не по https — тоже отказ', () => {
  assert.equal(checkCast({ text: 'привет', btnText: 'Тут' }).error, 'BAD_BUTTON');
  assert.equal(checkCast({ text: 'привет', btnText: 'Тут', btnUrl: 'http://example.com' }).error, 'BAD_URL');
  assert.ok(checkCast({ text: 'привет', btnText: 'Тут', btnUrl: 'https://example.com' }).ok);
});

/* ------------------------------------------------------------ кому уходит */

test('письмо уходит только тем, кто нажимал Start', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  const dima = user(303, 'Дима'); // Start не нажимал
  await started(t, ivan, max);

  t.openAdmin(ivan);
  await t.send(ivan, { t: 'cast', text: 'Завели дурака — заходите', audience: 'all' });
  await flush(t);

  assert.equal(letters(t, ivan).length, 1);
  assert.equal(letters(t, max).length, 1);
  assert.equal(letters(t, dima).length, 0, 'ему бот написать не может и не пытается');
  assert.match(letters(t, max)[0], /Завели дурака/);
  t.app.store.close();
});

test('под каждым письмом кнопка «не присылать», и она работает с первого тапа', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  await started(t, ivan, max);
  t.openAdmin(ivan);

  await t.send(ivan, { t: 'cast', text: 'Первое письмо', audience: 'all' });
  await flush(t);
  const msg = [...t.tg.messages.values()].filter((m) => m.chatId === '202').at(-1);
  const btn = msg.markup.inline_keyboard.flat().find((b) => b.callback_data === ADS_OFF);
  assert.ok(btn, 'кнопка отписки есть в каждом письме');
  assert.match(btn.text, /Не присылать/);

  await t.raw(pressUpdate(max.id, max, ADS_OFF, msg.message_id));
  assert.match(t.answer().text, /Больше не пришлю/);

  await t.send(ivan, { t: 'cast', text: 'Второе письмо', audience: 'all' });
  await flush(t);
  assert.equal(letters(t, max).length, 1, 'второго письма он не получил');
  assert.equal(letters(t, ivan).length, 2, 'а тот, кто не отписывался, получил');
  t.app.store.close();
});

test('отписка переживает перезапуск', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store, admins: ['101'] });
  const max = user(202, 'Макс');
  await started(t, IVAN(), max);
  store.setAds('202', 'off');

  const again = new Table({ store, admins: ['101'] });
  again.tg.dmOpen.add('101');
  again.tg.dmOpen.add('202');
  again.openAdmin(IVAN());
  await again.send(IVAN(), { t: 'cast', text: 'После перезапуска', audience: 'all' });
  await flush(again);
  assert.equal(letters(again, max).length, 0, 'отписавшийся не получает и после рестарта');
  store.close();
});

test('заблокировавший бота не ломает рассылку и попадает в отчёт', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  const dima = user(303, 'Дима');
  await started(t, ivan, max, dima);
  t.tg.dmOpen.delete('202'); // Макс заблокировал бота

  t.openAdmin(ivan);
  await t.send(ivan, { t: 'cast', text: 'Всем привет', audience: 'all' });
  await flush(t);

  const [row] = t.app.store.broadcasts(1);
  assert.equal(row.status, 'done');
  assert.equal(row.sent, 2, 'двоим дошло');
  assert.equal(row.failed, 1, 'один заблокировал — это отдельное число, а не ошибка');
  assert.equal(t.app.store.getDm('202'), 'fail', 'и больше ему не пробуем');
  assert.equal(letters(t, dima).length, 1, 'рассылка не остановилась на нём');
  t.app.store.close();
});

test('аудитории: активные и спящие — разные люди', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  await started(t, ivan, max);
  const now = t.clock.now();
  t.app.store.noteSeen('101', now); // Иван заходил сегодня
  t.app.store.noteSeen('202', now - 30 * 86_400_000); // Макс — месяц назад

  assert.deepEqual(t.app.casts.sizes(), { all: 2, week: 1, sleep: 1 });

  t.openAdmin(ivan);
  await t.send(ivan, { t: 'cast', text: 'Возвращайтесь', audience: 'sleep' });
  await flush(t);
  assert.equal(letters(t, max).length, 1, 'спящему — письмо');
  assert.equal(letters(t, ivan).length, 0, 'активному — нет');
  t.app.store.close();
});

test('некому отправлять — так и сказано, пустая рассылка не создаётся', async () => {
  const t = withStats();
  const ivan = IVAN();
  t.openAdmin(ivan);
  await t.send(ivan, { t: 'cast', text: 'Кому-нибудь', audience: 'all' });
  assert.equal(t.lastError(ivan).code, 'NO_ONE');
  assert.equal(t.app.store.broadcasts(5).length, 0);
  t.app.store.close();
});

/* ---------------------------------------------------------------- темп */

test('темп — восемь писем в секунду, не быстрее', async () => {
  const t = withStats();
  const ivan = IVAN();
  const crowd = Array.from({ length: 12 }, (_, i) => user(500 + i, `Игрок ${i}`));
  await started(t, ivan, ...crowd);
  t.openAdmin(ivan);

  await t.send(ivan, { t: 'cast', text: 'Тринадцати сразу', audience: 'all' });
  await t.advance(SEND_GAP_MS * 4); // четыре паузы — ушло не больше пяти писем
  const early = t.app.store.broadcasts(1)[0];
  assert.ok(early.sent <= 5, `за полсекунды ушло ${early.sent}`);
  assert.equal(early.status, 'sending');

  await flush(t, 13);
  const done = t.app.store.broadcasts(1)[0];
  assert.equal(done.sent, 13);
  assert.equal(done.status, 'done');
  t.app.store.close();
});

/* --------------------------------------------------------- отложенная */

test('отложенная рассылка уходит в назначенное время, а не раньше', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  await started(t, ivan, max);
  t.openAdmin(ivan);

  const at = t.clock.now() + 2 * 60 * 60_000; // через два часа
  await t.send(ivan, { t: 'cast', text: 'Вечером играем', audience: 'all', at });
  assert.equal(t.app.store.broadcasts(1)[0].status, 'scheduled');

  await t.advance(60 * 60_000);
  assert.equal(letters(t, max).length, 0, 'через час — ещё нет');

  await t.advance(60 * 60_000 + 1000);
  await flush(t);
  assert.equal(letters(t, max).length, 1, 'в срок — ушла');
  t.app.store.close();
});

test('время в прошлом не принимается', async () => {
  const t = withStats();
  const ivan = IVAN();
  await started(t, ivan);
  t.openAdmin(ivan);
  await t.send(ivan, { t: 'cast', text: 'Вчера', audience: 'all', at: t.clock.now() - 3 * 60_000 });
  assert.equal(t.lastError(ivan).code, 'BAD_TIME');
  t.app.store.close();
});

test('отменённая до отправки не уходит вовсе', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  await started(t, ivan, max);
  t.openAdmin(ivan);

  await t.send(ivan, { t: 'cast', text: 'Передумал', audience: 'all', at: t.clock.now() + 3_600_000 });
  const id = t.app.store.broadcasts(1)[0].id;
  await t.send(ivan, { t: 'castCancel', id });
  assert.equal(t.app.store.broadcast(id).status, 'canceled');

  await t.advance(2 * 3_600_000);
  await flush(t);
  assert.equal(letters(t, max).length, 0, 'ни одного письма');
  t.app.store.close();
});

test('«остановить» посреди отправки: ушедшие ушли, остальные — нет', async () => {
  const t = withStats();
  const ivan = IVAN();
  const crowd = Array.from({ length: 30 }, (_, i) => user(600 + i, `Игрок ${i}`));
  await started(t, ivan, ...crowd);
  t.openAdmin(ivan);

  await t.send(ivan, { t: 'cast', text: 'Долгая рассылка', audience: 'all' });
  await t.advance(SEND_GAP_MS * 12);
  const id = t.app.store.broadcasts(1)[0].id;
  const sentBy = t.app.store.broadcast(id).sent;
  await t.send(ivan, { t: 'castCancel', id });
  await flush(t, 31);

  const row = t.app.store.broadcast(id);
  assert.equal(row.status, 'canceled');
  assert.ok(row.sent >= sentBy && row.sent < 31, `ушло ${row.sent} из 31 — остальные остановлены`);
  t.app.store.close();
});

test('пропущенная из-за простоя: свежая уходит, вчерашняя отменяется', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store, admins: ['101'] });
  const max = user(202, 'Макс');
  await started(t, IVAN(), max);
  const now = t.clock.now();
  store.addBroadcast({ at: now - 10 * 60_000, text: 'Свежая', audience: 'all', total: 2 });
  store.addBroadcast({ at: now - 2 * STALE_MS, text: 'Скисшая', audience: 'all', total: 2 });

  const again = new Table({ store, admins: ['101'] });
  again.tg.dmOpen.add('101');
  again.tg.dmOpen.add('202');
  const r = again.casts.resume();
  assert.equal(r.sending, 1);
  assert.equal(r.stale, 1);
  await flush(again);

  const said = letters(again, max).join('\n');
  assert.match(said, /Свежая/);
  assert.ok(!said.includes('Скисшая'), 'вчерашнюю новость рассылать хуже, чем не рассылать');
  const stale = store.broadcasts(5).find((c) => c.text === 'Скисшая');
  assert.equal(stale.status, 'canceled');
  assert.match(stale.note, /больше суток/, 'и сказано, почему');
  store.close();
});

test('после перезапуска посреди отправки никто не получает письмо дважды', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store, admins: ['101'] });
  const crowd = Array.from({ length: 10 }, (_, i) => user(700 + i, `Игрок ${i}`));
  await started(t, IVAN(), ...crowd);
  t.openAdmin(IVAN());
  await t.send(IVAN(), { t: 'cast', text: 'Прерванная', audience: 'all' });
  await t.advance(SEND_GAP_MS * 5);
  const id = t.app.store.broadcasts(1)[0].id;
  const first = store.broadcast(id).sent;
  assert.ok(first > 0 && first < 11, `успело уйти ${first}`);
  t.app.stop(); // как будто процесс убили

  const again = new Table({ store, admins: ['101'] });
  for (const u of [IVAN(), ...crowd]) again.tg.dmOpen.add(String(u.id));
  again.casts.resume();
  await flush(again, 11);

  const row = store.broadcast(id);
  assert.equal(row.status, 'done');
  assert.equal(row.sent, 11, 'всем по одному письму, и никому по два');
  for (const u of crowd) assert.ok(letters(again, u).length <= 1, 'ни одного повтора');
  store.close();
});

/* -------------------------------------------------------- себе и отчёт */

test('«сначала себе» шлёт только себе и ничего не создаёт', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  await started(t, ivan, max);
  t.openAdmin(ivan);

  await t.send(ivan, { t: 'castTest', text: 'Проверка вида', audience: 'all' });
  assert.equal(letters(t, ivan).length, 1);
  assert.equal(letters(t, max).length, 0, 'остальные ничего не получили');
  assert.equal(t.app.store.broadcasts(5).length, 0, 'и рассылки не появилось');
  t.app.store.close();
});

test('после рассылки владельцу приходит отчёт', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  await started(t, ivan, max);
  t.openAdmin(ivan);
  await t.send(ivan, { t: 'cast', text: 'Отчёт про это', audience: 'all' });
  await flush(t);

  assert.equal(t.castsDone.length, 1);
  assert.equal(t.castsDone[0].sent, 2);
  t.app.store.close();
});

/* ---------------------------------------------------------------- доступ */

test('игрок не может разослать ничего', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  await started(t, ivan, max);
  await t.cmd(ivan, '/newgame');
  t.openRoom(max, t.room);

  await t.send(max, { t: 'cast', text: 'Реклама от Макса', audience: 'all' });
  assert.equal(t.lastError(max).code, 'BAD_REQUEST');
  assert.equal(t.app.store.broadcasts(5).length, 0);
  assert.equal(letters(t, ivan).length, 0);
  t.app.store.close();
});

test('в рассылке нет ни одной карты: письмо — это только текст владельца', async () => {
  const t = withStats();
  const ivan = IVAN();
  const max = user(202, 'Макс');
  await started(t, ivan, max);
  await t.cmd(ivan, '/newgame');
  await t.send(max, { t: 'sit' });
  await t.send(ivan, { t: 'start' });

  t.close(ivan);
  t.openAdmin(ivan);
  await t.send(ivan, { t: 'cast', text: 'Играем в субботу', audience: 'all' });
  await flush(t);

  const letter = letters(t, max).at(-1);
  assert.equal(letter, 'Играем в субботу');
  t.app.store.close();
});
