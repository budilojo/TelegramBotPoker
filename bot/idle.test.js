'use strict';
/**
 * Заброшенный стол: создали и не пришли.
 *
 * Проверяется не «сработал ли таймер», а четыре вещи, без которых механика
 * вредна:
 *
 *   1. НАЧАТУЮ ИГРУ НЕ ТРОГАЕТ. Закрыть стол, за которым люди думают над
 *      картами, хуже, чем оставить сто пустых.
 *   2. ПРИЗНАК ЖИЗНИ ОТМЕНЯЕТ ЗАКРЫТИЕ — в том числе после предупреждения.
 *      Иначе предупреждение было бы враньём: вернулись, а стол всё равно
 *      закрылся.
 *   3. ЗАКРЫТИЕ ВИДНО И ПОНЯТНО: карточка теряет кнопку, в группе объяснение,
 *      у открытых приложений экран не остаётся мёртвым.
 *   4. ПЕРЕЗАПУСК И ОБСЛУЖИВАНИЕ не считаются простоем игроков: бот лежал —
 *      люди не виноваты.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, durakDecks } from './harness.js';
import { Store } from './store.js';
import { IDLE_CLOSE_MS, IDLE_WARN_MS, IDLE_GRACE_MS } from './app.js';

const IVAN = user(101, 'Иван');
const MAX = user(202, 'Макс');

/** Всё, что бот написал в группу за игру. */
const said = (t) => t.tg.calls.filter((c) => c.method === 'sendMessage' && c.chatId === String(t.chatId)).map((c) => c.text);

/** `/play` → хаб → «создать лобби». Так стол и появляется у людей. */
async function lobby(t, host = IVAN, game = 'durak') {
  await t.start(host);
  await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game, settings: {} });
  return t.app.roomsOf(t.chatId).at(-1);
}

/* ------------------------------------------------------------ закрытие */

test('стол, к которому никто не пришёл, закрывается сам — с предупреждением', async () => {
  const t = new Table();
  const room = await lobby(t);
  const code = room.code;
  assert.equal(room.status, 'lobby');

  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS - 1000);
  assert.equal(said(t).some((x) => /закроется/.test(x)), false, 'рано предупреждать');
  assert.ok(t.app.roomByCode(code), 'и рано закрывать');

  await t.clock.advance(2000);
  assert.ok(said(t).some((x) => /через минуту он закроется/.test(x)), 'предупредили в группе');
  assert.ok(t.app.roomByCode(code), 'но стол ещё жив — минута у людей есть');

  await t.clock.advance(IDLE_WARN_MS);
  assert.equal(t.app.roomByCode(code), null, 'стол закрыт');
  assert.equal(t.app.roomsOf(t.chatId).length, 0, 'и из списка группы пропал');
  assert.ok(said(t).some((x) => /так никто и не собрался/.test(x)), 'и объяснил, почему');
  t.app.stop();
});

test('закрытый стол не оставляет живой кнопки и мёртвых экранов', async () => {
  const t = new Table();
  const room = await lobby(t);
  t.openRoom(MAX, room); // Макс смотрит на стол из приложения
  await t.clock.advance(IDLE_CLOSE_MS + IDLE_WARN_MS + 1000);

  assert.equal(t.app.roomByCode(room.code), null);
  const drops = t.tg.calls.filter((c) => c.method === 'editMessageReplyMarkup');
  assert.ok(drops.length, 'у карточки в группе забрали кнопку');
  // Открытое приложение не осталось на несуществующем столе.
  const seen = t.page(MAX).inbox;
  assert.ok(seen.some((m) => m.t === 'gone' || m.state?.kind === 'hub'), 'Максу сказали, что стола больше нет');
  t.app.stop();
});

/* ----------------------------------------------------- признаки жизни */

test('кто-то открыл стол — отсчёт начинается заново', async () => {
  const t = new Table();
  const room = await lobby(t);

  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS - 2000);
  t.openRoom(MAX, room); // вот и признак жизни
  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS - 2000);

  assert.ok(t.app.roomByCode(room.code), 'стол жив: с открытия прошло меньше срока');
  assert.equal(said(t).some((x) => /закроется/.test(x)), false, 'и предупреждать не о чем');
  t.app.stop();
});

test('сел за стол — тоже признак жизни', async () => {
  const t = new Table();
  const room = await lobby(t);
  t.openRoom(MAX, room);
  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS - 2000);
  await t.send(MAX, { t: 'sit' });
  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS - 2000);
  assert.ok(t.app.roomByCode(room.code), 'стол жив');
  t.app.stop();
});

test('вернулись после предупреждения — стол остаётся', async () => {
  const t = new Table();
  const room = await lobby(t);

  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS + 1000);
  assert.ok(said(t).some((x) => /через минуту он закроется/.test(x)), 'предупредили');

  t.openRoom(MAX, room); // пришли
  await t.clock.advance(IDLE_WARN_MS * 3);
  assert.ok(t.app.roomByCode(room.code), 'предупреждение — не приговор');

  // И предупредят снова, если опять затихнут: один раз — не навсегда.
  await t.clock.advance(IDLE_CLOSE_MS);
  assert.equal(t.app.roomByCode(room.code), null, 'затихли снова — закрылся');
  assert.equal(said(t).filter((x) => /через минуту он закроется/.test(x)).length, 2, 'предупредили оба раза');
  t.app.stop();
});

test('в лобби остался один игрок — это всё равно простой', async () => {
  const t = new Table();
  const room = await lobby(t);
  assert.equal(room.players.length, 1, 'хост за столом один');
  await t.clock.advance(IDLE_CLOSE_MS + IDLE_WARN_MS + 1000);
  assert.equal(t.app.roomByCode(room.code), null, 'один игрок стол не спасает');
  t.app.stop();
});

/* --------------------------------------------------- начатую не трогаем */

test('начатую игру таймер не закрывает никогда', async () => {
  const t = new Table({ durakDeck: durakDecks(5) });
  const room = await lobby(t);
  t.openRoom(MAX, room);
  await t.send(MAX, { t: 'sit' });
  await t.send(IVAN, { t: 'start' });
  assert.equal(room.status, 'playing');

  await t.clock.advance(IDLE_CLOSE_MS * 5);
  assert.ok(t.app.roomByCode(room.code), 'игра идёт — стол на месте');
  assert.equal(said(t).some((x) => /закроется|не собрался/.test(x)), false, 'и ничего грустного в группе');
  t.app.stop();
});

/* ------------------------------------------- перезапуск и обслуживание */

test('после перезапуска бота у стола есть время подать признаки жизни', async () => {
  // С настоящей базой: в NullStore столу негде пережить перезапуск.
  const store = new Store(':memory:');
  const t = new Table({ store });
  const room = await lobby(t);
  t.app.save(room);
  const code = room.code;
  t.app.stop();

  // Бот поднялся заново с той же базой.
  const again = new Table({ store, clock: t.clock, chatId: t.chatId, tg: t.tg });
  again.app.load();
  await again.app.resume(); // так поднимается настоящий бот: сперва загрузка, потом часы
  assert.ok(again.app.roomByCode(code), 'стол восстановился');

  await again.clock.advance(IDLE_GRACE_MS - IDLE_WARN_MS - 1000);
  assert.ok(again.app.roomByCode(code), 'сразу после старта не закрываем');

  await again.clock.advance(IDLE_WARN_MS + 2000);
  assert.equal(again.app.roomByCode(code), null, 'а вскоре — закрываем: к нему так и не пришли');
  again.app.stop();
  store.close();
});

test('обслуживание простоем игроков не считается', async () => {
  const t = new Table();
  const room = await lobby(t);

  t.app.setMaintenance(true, 'Чиним');
  await t.clock.advance(IDLE_CLOSE_MS * 3);
  assert.ok(t.app.roomByCode(room.code), 'во время обслуживания столы не закрываются');
  assert.equal(said(t).some((x) => /не собрался/.test(x)), false);

  t.app.setMaintenance(false);
  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS - 2000);
  assert.ok(t.app.roomByCode(room.code), 'после снятия отсчёт начинается заново, а не догоняет');

  await t.clock.advance(IDLE_WARN_MS + 2000);
  assert.equal(t.app.roomByCode(room.code), null, 'дальше — как обычно');
  t.app.stop();
});
