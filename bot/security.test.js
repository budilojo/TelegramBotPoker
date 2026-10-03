'use strict';
/**
 * Попытки обойти правила продукта — то, что сделает недобрый человек, а не
 * обычный игрок.
 *
 * Проверяются две двери. ПЕРВАЯ: личность — только из подписанного initData,
 * и подделать её нельзя ни одним способом. ВТОРАЯ: что бы страница ни
 * прислала — чужой ход, чужую комнату, закрытый экран, мусор в полях, — она
 * получает объяснение по-русски, а стол не шелохнётся.
 *
 * Отдельная забота — имена. Они приходят от Telegram, попадают в сообщения с
 * parse_mode: HTML, и экранировать их должен каждый рендер. Тесты на это
 * ищут не «какой-то HTML», а `<script>` — тег, который бот не пишет никогда:
 * встретился в сообщении — значит, приехал из имени. И проверяют, что имя
 * вообще доехало до сообщения, иначе зелёный ничего не значит.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, colorsStack, colorsDecks, durakStack, durakDecks, seededDecks, initDataFor } from './harness.js';

/* ------------------------------------------------- HTML в именах */

// <script> бот не пишет никогда — значит, если он встретился в сообщении,
// он пришёл из имени. Этот маркер и ищем, а не абстрактный «HTML».
const EVIL = '<script>зло';
const EVIL2 = '</script>&b';

/** Всё, что бот когда-либо отправил или правил в Telegram. */
const everyText = (t) => [
  ...t.tg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.text),
  ...t.adminTg.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => c.text),
].filter(Boolean);

/**
 * Имя попадает в сообщения с parse_mode: HTML. Если его не экранировать,
 * «<b>зло</b>» в имени либо сломает разметку сообщения (Telegram ответит
 * ошибкой и карточка не обновится), либо нарисует чужой текст жирным.
 */
function noRawTags(texts, where) {
  for (const x of texts) {
    assert.ok(!/<script/i.test(x), `${where}: сырой <script> из имени в сообщении: ${x}`);
    assert.ok(!/<\/script/i.test(x), `${where}: сырой </script> из имени в сообщении: ${x}`);
  }
  // Защита от пустого теста: если имя вообще не доехало ни до одного
  // сообщения, проверять было нечего, и зелёный ничего не значит.
  assert.ok(
    texts.some((x) => /&lt;script&gt;|&lt;\/script&gt;/.test(x)),
    `${where}: имя не попало ни в одно сообщение — тест ничего не проверил`
  );
}

test('ЗЛО-1 дурак: HTML в имени не вытекает в сообщения группы', async () => {
  const t = new Table({ durakDeck: durakDecks(3) });
  const ivan = user(101, EVIL);
  const max = user(202, EVIL2);
  for (const u of [ivan, max]) await t.start(u);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'durak', settings: {} });
  t.openRoom(max, t.durak);
  await t.send(max, { t: 'sit' });
  await t.send(ivan, { t: 'start' });
  await t.cmd(ivan, '/finish');
  const texts = everyText(t);
  assert.ok(texts.length > 2, 'бот что-то написал');
  noRawTags(texts, 'дурак');
});

test('ЗЛО-2 UNOQ: HTML в имени не вытекает', async () => {
  const t = new Table({ colorsDeck: colorsDecks(3) });
  const ivan = user(101, EVIL);
  const max = user(202, EVIL2);
  for (const u of [ivan, max]) await t.start(u);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'colors', settings: {} });
  t.openRoom(max, t.colors);
  await t.send(max, { t: 'sit' });
  await t.send(ivan, { t: 'start' });
  await t.cmd(ivan, '/finish');
  noRawTags(everyText(t), 'UNOQ');
});

test('ЗЛО-3 покер: HTML в имени не вытекает', async () => {
  const t = new Table({ deck: seededDecks(3) });
  const ivan = user(101, EVIL);
  const max = user(202, EVIL2);
  for (const u of [ivan, max]) await t.start(u);
  await t.cmd(ivan, '/newgame');
  t.openRoom(max, t.room);
  await t.send(max, { t: 'sit' });
  await t.send(ivan, { t: 'start' });
  await t.cmd(ivan, '/finish');
  noRawTags(everyText(t), 'покер');
});

/* ------------------------------------------- закрытый рейтинг */

test('ЗЛО-4 рейтинг закрыт флагом — страницей его не открыть ни одним путём', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.start(ivan);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  // Из хаба группы.
  await t.send(ivan, { t: 'rating' });
  assert.equal(t.lastError(ivan).code, 'RATING_SOON', 'из хаба — отказ');
  assert.equal(t.state(ivan).kind, 'hub', 'и экран не сменился');
  // Из «моих групп».
  await t.send(ivan, { t: 'home' });
  await t.send(ivan, { t: 'rating', game: 'durak', period: 'all' });
  assert.notEqual(t.state(ivan).kind, 'rating', 'из home тоже не пустило');
  // Притворившись, что уже внутри.
  await t.send(ivan, { t: 'pick', game: 'poker' });
  assert.notEqual(t.state(ivan).kind, 'rating');
  await t.send(ivan, { t: 'who', id: '101' });
  assert.notEqual(t.state(ivan).kind, 'rating');
});

/* ----------------------------------------------------- админка */

test('ЗЛО-5 админку обычным человеком не открыть, и она не выдаёт, что существует', async () => {
  const t = new Table({ admins: [999] });
  const ivan = user(101, 'Иван');
  const r = t.open(ivan, { initData: initDataFor(ivan, { startParam: 'admin', clock: t.clock }) });
  assert.ok(r.error, 'не пустило');
  assert.equal(r.error, 'NO_ROOM');
  assert.match(r.text, /Стол не найден/, 'ответ тот же, что на выдуманный код — админки для него не существует');
  const bogus = t.open(ivan, { initData: initDataFor(ivan, { startParam: 'нетакогокода', clock: t.clock }) });
  assert.equal(bogus.text, r.text, 'ответы неотличимы');
});

/* ------------------------------------------------ мусор в полях */

const GARBAGE = [
  null, undefined, 0, -1, 1e308, NaN, '', ' ', 'x'.repeat(10_000), '🙂🙂🙂',
  '<script>alert(1)</script>', { a: 1 }, [1, 2, 3], true, '../../etc/passwd', '\u0000',
];

test('ЗЛО-6 мусор в любом поле любого действия: отказ словами, но не падение', async () => {
  const t = new Table({ colorsDeck: colorsDecks(4) });
  const ivan = user(101, 'Иван');
  const max = user(202, 'Макс');
  for (const u of [ivan, max]) await t.start(u);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'colors', settings: {} });
  t.openRoom(max, t.colors);
  await t.send(max, { t: 'sit' });
  await t.send(ivan, { t: 'start' });

  const actions = ['play', 'draw', 'pass', 'rainbow', 'catch', 'sit', 'leave', 'settings', 'kick', 'host', 'start', 'next', 'abort', 'finish'];
  const fields = ['card', 'color', 'seq', 'seat', 'stacking', 'turnSeconds', 'code', 'game', 'id'];
  let sent = 0;
  for (const a of actions) {
    for (const f of fields) {
      for (const g of GARBAGE) {
        await t.send(ivan, { t: a, [f]: g });
        sent += 1;
      }
    }
  }
  assert.ok(sent > 1000, `послано ${sent} кривых сообщений`);
  assert.deepEqual(t.errors, [], 'ни одного необработанного исключения');
  // Стол жив и не покорёжен.
  const room = t.colors;
  assert.ok(room, 'стол на месте');
  const all = Object.values(room.deal.hands).flat().length + room.deal.deck.length + room.deal.discard.length + 1;
  assert.equal(all, 108, 'карты не потерялись и не размножились');
});

test('ЗЛО-7 мусор в самом конверте сообщения', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  await t.start(ivan);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  const page = t.page(ivan);
  for (const bad of [null, undefined, 0, '', 'строка', [], { }, { t: null }, { t: 42 }, { t: {} }, { t: 'x'.repeat(5000) }]) {
    await t.hub.handle(page.session, bad);
  }
  assert.deepEqual(t.errors, [], 'ни одного необработанного исключения');
});

/* --------------------------------------- действие в чужой комнате */

test('ЗЛО-8 в комнату чужой группы не войти по коду', async () => {
  const t = new Table({ chatId: -1001, durakDeck: durakDecks(5) });
  const ivan = user(101, 'Иван');
  await t.start(ivan);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'durak', settings: {} });
  const mine = t.durak.code;

  // Вторая группа, тот же человек.
  const t2 = new Table({ chatId: -1002, tg: t.tg, store: t.app.store, clock: t.clock });
  // Чужая комната в первой группе — её кода второй хаб знать не должен.
  t2.app.addRoom(t.durak);
  await t2.cmd(ivan, '/play');
  t2.openHub(ivan);
  await t2.send(ivan, { t: 'join', code: mine });
  assert.equal(t2.lastError(ivan).code, 'NO_ROOM', 'комната не из этой группы');
  assert.notEqual(t2.state(ivan).room?.code, mine, 'и экран туда не ушёл');
});

/* ------------------------------------------- подделка подписи */

import { signInitData, checkInitData } from './webapp-auth.js';
import { TEST_TOKEN, ADMIN_TEST_TOKEN } from './harness.js';

const freshFields = (now, id, name = 'Чужак', extra = {}) => ({
  auth_date: Math.floor(now / 1000),
  user: { id, first_name: name, is_bot: false },
  ...extra,
});

test('ЗЛО-9 подделанная подпись не пускает ни одним способом', async () => {
  const t = new Table();
  const victim = user(101, 'Иван');
  await t.cmd(victim, '/play');
  const code = `g_${t.group.code}`;
  const now = t.clock.now(); // срок подписи считается по часам приложения
  const open = (initData) => t.hub.open({ initData }, () => {});

  // Без подписи вовсе.
  assert.ok(open('').error, 'пустая initData');
  assert.ok(open('user=%7B%22id%22%3A101%7D&auth_date=1').error, 'без hash');
  // Хеш не тот.
  const good = signInitData(freshFields(now, 101, 'Иван', { start_param: code }), TEST_TOKEN);
  const broken = good.replace(/hash=[0-9a-f]{64}/, `hash=${'0'.repeat(64)}`);
  assert.ok(open(broken).error, 'чужой hash');
  // Подпись настоящая, а поле user подменено после подписи.
  const tampered = good.replace(/user=[^&]+/, encodeURIComponent('{"id":999,"first_name":"Вор","is_bot":false}').replace(/^/, 'user='));
  assert.ok(open(tampered).error, 'подменённый user при настоящей подписи');
  // Подписано чужим токеном (админским) — для игровой страницы это никто.
  const byAdminToken = signInitData(freshFields(now, 101, 'Иван', { start_param: code }), ADMIN_TEST_TOKEN);
  const r = open(byAdminToken);
  assert.ok(r.error, 'подпись админского бота не открывает игровую страницу');
  // Протухшая.
  const stale = signInitData({ ...freshFields(now, 101), auth_date: Math.floor(now / 1000) - 60 * 60 * 25, start_param: code }, TEST_TOKEN);
  assert.ok(open(stale).error, 'подпись старше суток');
  // Бот вместо человека.
  const asBot = signInitData({ auth_date: Math.floor(now / 1000), user: { id: 7, first_name: 'Бот', is_bot: true }, start_param: code }, TEST_TOKEN);
  assert.ok(open(asBot).error, 'is_bot не пускают');
  // Строковый id вместо числового — классика обхода проверки типа.
  const strId = signInitData({ auth_date: Math.floor(now / 1000), user: { id: '101', first_name: 'Иван', is_bot: false }, start_param: code }, TEST_TOKEN);
  assert.equal(checkInitData(strId, TEST_TOKEN, { now }).ok, false, 'id строкой не принимается');
});

test('ЗЛО-10 выгнанный и вышедший больше не ходят', async () => {
  const t = new Table({ colorsDeck: colorsDecks(8) });
  const ivan = user(101, 'Иван');
  const max = user(202, 'Макс');
  const dima = user(303, 'Дима');
  for (const u of [ivan, max, dima]) await t.start(u);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'colors', settings: {} });
  for (const u of [max, dima]) {
    t.openRoom(u, t.colors);
    await t.send(u, { t: 'sit' });
  }
  await t.send(ivan, { t: 'start' });
  const room = t.colors;

  // Хост выгоняет Диму прямо посреди партии.
  const dimaSeat = room.players.findIndex((p) => p.id === '303');
  await t.send(ivan, { t: 'kick', seat: dimaSeat });
  const before = JSON.stringify(room.deal.hands);
  for (const m of [{ t: 'play', card: 'R5' }, { t: 'draw' }, { t: 'pass' }, { t: 'rainbow' }, { t: 'catch' }, { t: 'sit' }]) {
    await t.send(dima, m);
  }
  assert.equal(JSON.stringify(room.deal.hands), before, 'выгнанный ничего не изменил');
  assert.ok(t.lastError(dima), 'и каждый раз получал объяснение');
  assert.match(t.lastError(dima).text, /[а-яА-Я]/, 'по-русски');
});

test('ЗЛО-11 после конца игры ходить нельзя', async () => {
  const t = new Table({ colorsDeck: colorsDecks(9) });
  const ivan = user(101, 'Иван');
  const max = user(202, 'Макс');
  for (const u of [ivan, max]) await t.start(u);
  await t.cmd(ivan, '/play');
  t.openHub(ivan);
  await t.send(ivan, { t: 'create', game: 'colors', settings: {} });
  t.openRoom(max, t.colors);
  await t.send(max, { t: 'sit' });
  await t.send(ivan, { t: 'start' });
  const room = t.colors;
  await t.send(ivan, { t: 'finish' });
  assert.equal(room.status, 'finished');
  const snapshot = JSON.stringify(room.deal);
  for (const m of [{ t: 'play', card: 'R5' }, { t: 'draw' }, { t: 'start' }, { t: 'next' }, { t: 'sit' }, { t: 'rainbow' }]) {
    await t.send(max, m);
  }
  assert.equal(JSON.stringify(room.deal), snapshot, 'завершённая игра не шелохнулась');
});

test('ЗЛО-12 очень длинное имя не ломает ни сообщений, ни экранов', async () => {
  const t = new Table({ durakDeck: durakDecks(4) });
  const long = user(101, 'Я'.repeat(4000));
  const max = user(202, 'М'.repeat(500));
  for (const u of [long, max]) await t.start(u);
  await t.cmd(long, '/play');
  t.openHub(long);
  await t.send(long, { t: 'create', game: 'durak', settings: {} });
  t.openRoom(max, t.durak);
  await t.send(max, { t: 'sit' });
  await t.send(long, { t: 'start' });
  await t.cmd(long, '/finish');
  for (const x of everyText(t)) {
    assert.ok(x.length < 4096, `сообщение длиннее лимита Telegram: ${x.length} символов`);
  }
  assert.deepEqual(t.errors, [], 'без исключений');
});
