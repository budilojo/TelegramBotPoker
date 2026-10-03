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
import { Table, user, durakDecks, FakeClock } from './harness.js';
import { TelegramStub } from './tg-stub.js';
import { Store } from './store.js';
import { IDLE_CLOSE_MS, IDLE_WARN_MS, IDLE_GRACE_MS, IDLE_SPREAD_MS, IDLE_READY_MS } from './app.js';

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

test('перезапуск не укорачивает жизнь свежему столу', async () => {
  // С настоящей базой: в NullStore столу негде пережить перезапуск.
  const store = new Store(':memory:');
  const t = new Table({ store });
  const room = await lobby(t);
  t.app.save(room);
  const code = room.code;
  t.app.stop();

  // Хост создал стол минуту назад и зовёт друзей в чате — и тут деплой.
  await t.clock.advance(60_000);
  const again = new Table({ store, clock: t.clock, chatId: t.chatId, tg: t.tg });
  again.app.load();
  await again.app.resume(); // так поднимается настоящий бот

  await again.clock.advance(IDLE_GRACE_MS + 5000);
  assert.ok(again.app.roomByCode(code), 'столу осталось его время, а не две минуты');

  // И закроется он тогда, когда закрылся бы без перезапуска.
  await again.clock.advance(IDLE_CLOSE_MS);
  assert.equal(again.app.roomByCode(code), null, 'в свой срок — закрылся');
  again.app.stop();
  store.close();
});

test('давно брошенный стол после перезапуска закрывается вскоре, но не мгновенно', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  const room = await lobby(t);
  // Бот лежал полдня: стол этот всё время никому не был нужен.
  room.createdAt = t.clock.now() - 12 * 60 * 60_000;
  t.app.save(room);
  const code = room.code;
  t.app.stop();

  const again = new Table({ store, clock: t.clock, chatId: t.chatId, tg: t.tg });
  again.app.load();
  await again.app.resume();

  await again.clock.advance(IDLE_GRACE_MS - IDLE_WARN_MS - 1000);
  assert.ok(again.app.roomByCode(code), 'сразу после старта не закрываем');

  await again.clock.advance(IDLE_WARN_MS + 2000);
  assert.equal(again.app.roomByCode(code), null, 'а вскоре — закрываем: к нему так и не пришли');
  again.app.stop();
  store.close();
});

test('после перезапуска брошенные столы закрываются по очереди, а не залпом', async () => {
  const store = new Store(':memory:');
  const clock = new FakeClock();
  const tg = new TelegramStub();
  for (let i = 0; i < 12; i++) {
    const t = new Table({ store, clock, tg, chatId: -100000 - i });
    const room = await lobby(t, user(500 + i, `Хост${i}`));
    room.createdAt = clock.now() - 12 * 60 * 60_000; // все давно брошены
    t.app.save(room);
    t.app.stop();
  }

  const again = new Table({ store, clock, tg, chatId: -100000 });
  assert.equal(again.app.load(), 12, 'все лобби вернулись');
  const before = tg.calls.length;
  again.app.syncClocks();

  // Столько, сколько нужно самому первому из них.
  await again.clock.advance(IDLE_GRACE_MS - IDLE_WARN_MS + 1000);
  const burst = tg.calls.slice(before).filter((c) => c.method === 'sendMessage').length;
  assert.ok(burst <= 2, `в одну секунду ушло ${burst} сообщений — это залп по всем группам`);

  // Но и не теряются: за свою очередь каждый получает своё.
  await again.clock.advance(IDLE_SPREAD_MS * 12 + IDLE_WARN_MS + 5000);
  assert.equal(again.app.rooms.size, 0, 'все двенадцать закрылись');
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

/* ------------------------------------------------- гонки на закрытии */

/**
 * Пока idleStep ждёт Telegram, в бот успевает прийти что угодно: второй
 * таймер, признак жизни, старт игры. В тестах заглушка отвечает мгновенно,
 * поэтому окно подделано честно: хук делает то, что в живом боте сделал бы
 * событийный цикл, пока висит сетевой вызов.
 */
function duringTelegram(t, method, what) {
  const orig = t.tg[method].bind(t.tg);
  let once = false;
  t.tg[method] = async (...args) => {
    if (!once) {
      once = true;
      await what();
    }
    return orig(...args);
  };
}

test('пока идёт закрытие, стол не закрывается во второй раз', async () => {
  const t = new Table();
  const room = await lobby(t);
  // Второй стол в той же группе: любое действие с ним дёргает syncClocks,
  // а значит может перевзвести таймер первого — прямо посреди его закрытия.
  duringTelegram(t, 'editMessageReplyMarkup', async () => {
    t.app.syncClocks();
    await t.clock.advance(0); // событийный цикл успел прокрутить готовый таймер
  });

  await t.clock.advance(IDLE_CLOSE_MS + IDLE_WARN_MS + 2000);
  assert.equal(t.app.roomByCode(room.code), null, 'стол закрыт');
  assert.equal(said(t).filter((x) => /так никто и не собрался/.test(x)).length, 1, 'ровно одно сообщение о закрытии');
  t.app.stop();
});

test('решение о закрытии принимается до первого обращения к сети', async () => {
  const t = new Table();
  const room = await lobby(t);
  let stillListed = 'не проверено';
  duringTelegram(t, 'editMessageReplyMarkup', () => {
    // Мы внутри сетевой части закрытия. Стола в списке быть уже не должно:
    // иначе сюда успеет и второй таймер, и человек, которому отдадут
    // наполовину закрытый стол.
    stillListed = t.app.roomByCode(room.code);
    t.app.noteLive(room); // признак жизни на снесённый стол ничего не воскрешает
  });

  await t.clock.advance(IDLE_CLOSE_MS + IDLE_WARN_MS + 2000);
  assert.equal(stillListed, null, 'к началу сетевой части стола уже нет в списке');
  assert.equal(t.app.roomByCode(room.code), null, 'и после неё нет');
  assert.equal(said(t).filter((x) => /так никто и не собрался/.test(x)).length, 1, 'одно сообщение');
  t.app.stop();
});

test('признак жизни за секунду до срабатывания стол спасает', async () => {
  const t = new Table();
  const room = await lobby(t);
  await t.clock.advance(IDLE_CLOSE_MS - 1000); // предупреждение уже было
  t.openRoom(MAX, room); // успел
  await t.clock.advance(IDLE_WARN_MS * 2);
  assert.ok(t.app.roomByCode(room.code), 'стол жив: успели до решения');
  t.app.stop();
});

/* ------------------------------------------- что ещё считается жизнью */

test('написал в группе, где сидишь за столом, — стол живой', async () => {
  const t = new Table();
  const room = await lobby(t);
  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS - 2000);
  await t.cmd(IVAN, 'ща доиграю и сяду');
  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS - 2000);
  assert.ok(t.app.roomByCode(room.code), '«мы тут» в чате — тоже признак жизни');
  t.app.stop();
});

test('чужая болтовня в группе чужих столов не держит', async () => {
  const t = new Table();
  const room = await lobby(t);
  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS - 2000);
  await t.cmd(MAX, 'привет всем'); // Макс за этим столом не сидит
  await t.clock.advance(IDLE_WARN_MS * 3);
  assert.equal(t.app.roomByCode(room.code), null, 'стол закрылся по сроку');
  t.app.stop();
});

test('двоих за столом ждут дольше, чем одного', async () => {
  const t = new Table();
  const room = await lobby(t);
  t.openRoom(MAX, room);
  await t.send(MAX, { t: 'sit' });
  assert.equal(room.players.length, 2);

  await t.clock.advance(IDLE_CLOSE_MS + IDLE_WARN_MS + 5000);
  assert.ok(t.app.roomByCode(room.code), 'двое ждут третьего — это не брошенный стол');

  await t.clock.advance(IDLE_READY_MS);
  assert.equal(t.app.roomByCode(room.code), null, 'но и не навсегда');
  t.app.stop();
});

test('в предупреждении есть кнопка, по которой сразу попадают за стол', async () => {
  const t = new Table();
  await lobby(t);
  await t.clock.advance(IDLE_CLOSE_MS - IDLE_WARN_MS + 1000);
  // Кнопки видно в самом сообщении, а не в журнале вызовов.
  const warn = [...t.tg.messages.values()].filter((m) => /через минуту он закроется/.test(m.text || '')).at(-1);
  assert.ok(warn, 'предупреждение ушло');
  const btn = warn.markup?.inline_keyboard?.flat?.() ?? [];
  assert.ok(btn.some((b) => b.url), 'и в нём кнопка со ссылкой на стол');
  t.app.stop();
});
