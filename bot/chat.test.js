'use strict';
/**
 * Чат за игровым столом (bot/chat.js + приём `chat` в bot/hub.js).
 *
 *   НИКТО НЕ ХОДИТ ЗА ДРУГОГО — автор только из подписи страницы.
 *   НИКТО НЕ ВИДИТ ЧУЖОГО — чат читают лишь сидящие за этим столом; зритель,
 *   чужой стол, ушедший и удалённый не получают ничего.
 *   НЕ СОХРАНЯЕТСЯ — ни в комнату, ни в базу, ни в карточку группы, ни в вид.
 *   ТЕКСТ — только текст, очищенный; лимиты по часам приложения.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { cleanChatText, CHAT_MAX_LEN, CHAT_GAP_MS, CHAT_PER_MIN, CHAT_SAME_MS, CHAT_HISTORY } from './chat.js';
import { gameOf } from './games/index.js';

const ALICE = user(1, 'Алиса');
const BOB = user(2, 'Боб');
const CAROL = user(3, 'Катя');
const DAVE = user(4, 'Дима'); // зритель

const chats = (t, u) => t.page(u).inbox.filter((m) => m.t === 'chat');
const syncs = (t, u) => t.page(u).inbox.filter((m) => m.t === 'chat-sync');
const states = (t, u) => t.page(u).inbox.filter((m) => m.t === 'state').length;
const err = (t, u) => t.lastError(u);
const seatOf = (room, u) => room.players.findIndex((p) => p.id === String(u.id));

async function poker(t) {
  await t.begin({ ALICE, BOB, CAROL });
  t.open(DAVE);
  return t.room;
}

/* ------------------------------------------------------------ очистка */

test('очистка текста: пробелы, переводы строк, невидимые символы, длина в символах', () => {
  assert.equal(cleanChatText('  привет  ').text, 'привет');
  assert.equal(cleanChatText('а\r\nб').text, 'а\nб');
  assert.equal(cleanChatText('а\n\n\n\n\n\nб').text, 'а\n\n\nб', 'не больше трёх переводов подряд');
  assert.equal(cleanChatText('до​после‮кон⁦ец﻿\u0007').text, 'допослеконец', 'нулевой ширины, RTL-override и управляющие вырезаны');
  assert.equal(cleanChatText('👨‍👩‍👧 ок').text, '👨‍👩‍👧 ок', 'составной эмодзи не разваливается');
  for (const bad of ['', '   ', '\n\n', '​​', '‮', '‍', 5, null, undefined, {}, ['a']]) {
    assert.equal(cleanChatText(bad).error, 'CHAT_EMPTY', JSON.stringify(bad));
  }
  assert.equal(cleanChatText('я'.repeat(CHAT_MAX_LEN)).text.length, CHAT_MAX_LEN);
  assert.equal(cleanChatText('я'.repeat(CHAT_MAX_LEN + 1)).error, 'CHAT_TOO_LONG');
  // Длина — в символах, не в байтах и не в UTF-16: 300 «😀» проходят, 301 — нет.
  assert.ok(cleanChatText('😀'.repeat(CHAT_MAX_LEN)).text);
  assert.equal(cleanChatText('😀'.repeat(CHAT_MAX_LEN + 1)).error, 'CHAT_TOO_LONG');
  // HTML остаётся текстом, как есть.
  assert.equal(cleanChatText('<img src=x onerror=alert(1)> & "q"').text, '<img src=x onerror=alert(1)> & "q"');
});

/* ------------------------------------------------------- рассылка */

test('сообщение за покерным столом: всем сидящим одно лёгкое сообщение, состояние не пересобирается', async () => {
  const t = new Table();
  const room = await poker(t);
  const before = Object.fromEntries([ALICE, BOB, CAROL, DAVE].map((u) => [u.id, states(t, u)]));
  await t.send(BOB, { t: 'chat', text: '  всем привет  ' });
  assert.equal(err(t, BOB), null);
  for (const u of [ALICE, BOB, CAROL]) {
    const got = chats(t, u);
    assert.equal(got.length, 1, `${u.first_name} получил`);
    assert.deepEqual(got[0].m, { k: 'm', seat: seatOf(room, BOB), name: 'Боб', text: 'всем привет', at: t.clock.now(), n: 1 });
    assert.equal(got[0].unread, u === BOB ? 0 : 1, 'свои сообщения не непрочитанные, чужие — да');
    assert.equal(states(t, u), before[u.id], 'состояние стола не пересылалось');
  }
  assert.equal(chats(t, DAVE).length, 0, 'зритель не получил ничего');
});

test('подмена в теле: место, имя и id из сообщения ничего не значат', async () => {
  const t = new Table();
  const room = await poker(t);
  await t.send(ALICE, { t: 'chat', text: 'это я', seat: seatOf(room, CAROL), name: 'Катя', uid: String(CAROL.id), from: CAROL.id, user: { id: CAROL.id } });
  const m = chats(t, CAROL)[0].m;
  assert.equal(m.seat, seatOf(room, ALICE));
  assert.equal(m.name, 'Алиса');
  assert.deepEqual(Object.keys(m).sort(), ['at', 'k', 'n', 'name', 'seat', 'text']);
});

test('HTML остаётся текстом: в рассылке ровно то, что написали', async () => {
  const t = new Table();
  await poker(t);
  await t.send(ALICE, { t: 'chat', text: '<b>жирно</b> <script>x</script>' });
  assert.equal(chats(t, BOB)[0].m.text, '<b>жирно</b> <script>x</script>');
});

/* --------------------------------------------- кто участник */

test('зритель не пишет — отказ словами, никто ничего не получает', async () => {
  const t = new Table();
  await poker(t);
  await t.send(DAVE, { t: 'chat', text: 'я вижу вас' });
  assert.equal(err(t, DAVE)?.code, 'CHAT_NOT_SEATED');
  assert.equal(err(t, DAVE).text, 'Писать в чат могут игроки, сидящие за этим столом.');
  for (const u of [ALICE, BOB, CAROL, DAVE]) assert.equal(chats(t, u).length, 0);
});

test('зритель не читает: история и счётчик ему не приходят, запрос «дай историю» молчит', async () => {
  const t = new Table();
  await poker(t);
  await t.send(ALICE, { t: 'chat', text: 'секрет стола' });
  await t.send(DAVE, { t: 'chat-sync' });
  await t.send(DAVE, { t: 'chat-read' });
  assert.equal(syncs(t, DAVE).length, 0);
  assert.doesNotMatch(JSON.stringify(t.page(DAVE).inbox), /секрет стола/);
  // Свежеоткрытая страница зрителя — тоже ничего.
  const late = user(5, 'Поздний');
  t.open(late);
  assert.doesNotMatch(JSON.stringify(t.page(late).inbox), /секрет стола/);
});

test('чужой стол: чат одного стола не уходит на другой', async () => {
  const t = new Table();
  await poker(t);
  const other = new Table();
  await other.begin({ ALICE, BOB, CAROL });
  await t.send(ALICE, { t: 'chat', text: 'только наш стол' });
  for (const u of [ALICE, BOB, CAROL]) assert.equal(chats(other, u).length, 0);
});

test('ушедший из-за стола и удалённый хостом: не пишут и перестают получать', async () => {
  const t = new Table();
  const room = await poker(t);
  room.players.find((p) => p.id === '3').kicked = true;
  await t.send(CAROL, { t: 'chat', text: 'меня выгнали' });
  assert.equal(err(t, CAROL)?.code, 'CHAT_NOT_SEATED');
  await t.send(ALICE, { t: 'chat', text: 'без Кати' });
  assert.equal(chats(t, CAROL).length, 0, 'удалённому не доставлено');
  assert.equal(chats(t, BOB).length, 1);
});

test('дурак: вставший из-за стола (seated: false) не пишет и не читает', async () => {
  const t = new Table();
  for (const u of [ALICE, BOB, CAROL]) await t.start(u);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  await t.send(ALICE, { t: 'create', game: 'durak', settings: {} });
  const room = t.durak;
  for (const u of [BOB, CAROL]) {
    t.openRoom(u, room);
    await t.send(u, { t: 'sit' });
  }
  await t.send(ALICE, { t: 'leave' });
  assert.equal(room.players.find((p) => p.id === '1')?.seated, false);
  await t.send(ALICE, { t: 'chat', text: 'я встал' });
  assert.equal(err(t, ALICE)?.code, 'CHAT_NOT_SEATED');
  await t.send(BOB, { t: 'chat', text: 'играем' });
  assert.equal(chats(t, ALICE).length, 0, 'вставший не получает');
  assert.equal(chats(t, CAROL).length, 1);
});

test('партия с ботами: чата нет — отказ словами', async () => {
  const t = new Table();
  await t.start(ALICE);
  t.openSolo(ALICE);
  await t.send(ALICE, { t: 'play', game: 'durak', settings: {} });
  await t.send(ALICE, { t: 'chat', text: 'эй' });
  assert.equal(err(t, ALICE)?.code, 'CHAT_SOLO');
  assert.equal(chats(t, ALICE).length, 0);
  assert.equal(syncs(t, ALICE).length, 0);
});

/* ------------------------------------------------------ отказы по тексту */

test('пустое и слишком длинное — отказ словами, ничего не разослано', async () => {
  const t = new Table();
  await poker(t);
  await t.send(ALICE, { t: 'chat', text: ' \n​ ' });
  assert.equal(err(t, ALICE)?.code, 'CHAT_EMPTY');
  await t.advance(CHAT_GAP_MS);
  await t.send(ALICE, { t: 'chat', text: 'ы'.repeat(CHAT_MAX_LEN + 1) });
  assert.equal(err(t, ALICE)?.code, 'CHAT_TOO_LONG');
  assert.match(err(t, ALICE).text, /не больше 300 символов/);
  for (const bad of [5, null, { text: 'x' }, ['a']]) {
    await t.advance(CHAT_GAP_MS);
    await t.send(ALICE, { t: 'chat', text: bad });
    assert.equal(err(t, ALICE)?.code, 'CHAT_EMPTY');
  }
  for (const u of [ALICE, BOB, CAROL]) assert.equal(chats(t, u).length, 0);
});

/* ------------------------------------------------------------ частота */

test('частота: не чаще раза в 1,5 с — «подождите N с», по часам приложения', async () => {
  const t = new Table();
  await poker(t);
  await t.send(ALICE, { t: 'chat', text: 'раз' });
  await t.send(ALICE, { t: 'chat', text: 'два' });
  assert.equal(err(t, ALICE)?.code, 'CHAT_WAIT');
  assert.equal(err(t, ALICE).text, 'Не так часто — подождите 2 с.');
  assert.equal(err(t, ALICE).wait, CHAT_GAP_MS);
  await t.advance(CHAT_GAP_MS);
  const n = t.page(ALICE).inbox.length;
  await t.send(ALICE, { t: 'chat', text: 'два' });
  assert.equal(t.page(ALICE).inbox.slice(n).some((m) => m.t === 'error'), false);
  assert.deepEqual(chats(t, BOB).map((m) => m.m.text), ['раз', 'два'], 'отказанные не разосланы');
  await t.send(BOB, { t: 'chat', text: 'Боб не ждёт' });
  assert.equal(err(t, BOB), null, 'лимит на человека');
});

test('частота: не больше двенадцати в минуту, даже с паузами', async () => {
  const t = new Table();
  await poker(t);
  for (let i = 0; i < CHAT_PER_MIN; i++) {
    await t.send(ALICE, { t: 'chat', text: `сообщение ${i}` });
    assert.equal(err(t, ALICE), null, `№ ${i + 1}`);
    await t.advance(CHAT_GAP_MS);
  }
  // Прошло 18 с с первого: тринадцатое — когда первое выйдет из минуты.
  await t.send(ALICE, { t: 'chat', text: 'лишнее' });
  assert.equal(err(t, ALICE)?.code, 'CHAT_WAIT');
  assert.equal(err(t, ALICE).text, 'Не так часто — подождите 42 с.');
  await t.advance(42_000);
  const n = t.page(ALICE).inbox.length;
  await t.send(ALICE, { t: 'chat', text: 'лишнее' });
  assert.equal(t.page(ALICE).inbox.slice(n).some((m) => m.t === 'error'), false);
});

test('одинаковый текст подряд не принимается 10 с', async () => {
  const t = new Table();
  await poker(t);
  await t.send(ALICE, { t: 'chat', text: 'ку' });
  await t.advance(CHAT_GAP_MS);
  await t.send(ALICE, { t: 'chat', text: '  ку ' });
  assert.equal(err(t, ALICE)?.code, 'CHAT_SAME');
  assert.match(err(t, ALICE).text, /^Это вы уже писали — подождите 9 с\.$/);
  await t.advance(CHAT_SAME_MS);
  const n = t.page(ALICE).inbox.length;
  await t.send(ALICE, { t: 'chat', text: 'ку' });
  assert.equal(t.page(ALICE).inbox.slice(n).some((m) => m.t === 'error'), false, 'через 10 с — можно');
  await t.send(BOB, { t: 'chat', text: 'ку' });
  assert.equal(err(t, BOB), null, 'другому человеку тот же текст можно');
});

/* ------------------------------------------- история и непрочитанные */

test('история: последние 50, новому подключению приходит участнику, а не зрителю', async () => {
  const t = new Table();
  const room = await poker(t);
  for (let i = 1; i <= CHAT_HISTORY + 5; i++) {
    await t.send(ALICE, { t: 'chat', text: `№${i}` });
    await t.advance(6_000); // двенадцать в минуту — это раз в 5 с
  }
  // Боб переоткрыл страницу.
  t.openRoom(BOB, room);
  const s = syncs(t, BOB).at(-1);
  assert.equal(s.log.length, CHAT_HISTORY);
  assert.equal(s.log[0].text, '№6');
  assert.equal(s.log.at(-1).text, `№${CHAT_HISTORY + 5}`);
  assert.equal(s.unread, CHAT_HISTORY + 5, 'не прочитал ничего');
  // Запрос «дай историю» участнику отвечает тем же.
  await t.send(CAROL, { t: 'chat-sync' });
  assert.equal(syncs(t, CAROL).at(-1).log.length, CHAT_HISTORY);
});

test('непрочитанные: растут у остальных, не у автора; «прочитал» сбрасывает', async () => {
  const t = new Table();
  await poker(t);
  await t.send(ALICE, { t: 'chat', text: 'раз' });
  await t.advance(CHAT_GAP_MS);
  await t.send(ALICE, { t: 'chat', text: 'два' });
  assert.deepEqual(chats(t, BOB).map((m) => m.unread), [1, 2]);
  assert.deepEqual(chats(t, ALICE).map((m) => m.unread), [0, 0]);
  await t.send(BOB, { t: 'chat-read' });
  assert.equal(t.page(BOB).inbox.filter((m) => m.t === 'chat-unread').at(-1).unread, 0);
  await t.advance(CHAT_GAP_MS);
  await t.send(ALICE, { t: 'chat', text: 'три' });
  assert.equal(chats(t, BOB).at(-1).unread, 1, 'с нуля');
  assert.equal(chats(t, CAROL).at(-1).unread, 3, 'Катя не прочитала');
});

test('реакция ложится в историю маленькой строкой и считается непрочитанной', async () => {
  const t = new Table();
  const room = await poker(t);
  await t.send(ALICE, { t: 'react', id: 'haha' });
  assert.equal(t.page(BOB).inbox.filter((m) => m.t === 'chat-unread').at(-1).unread, 1);
  assert.equal(t.page(ALICE).inbox.filter((m) => m.t === 'chat-unread').length, 0, 'автору счётчик не шлётся');
  assert.equal(t.page(DAVE).inbox.filter((m) => m.t === 'chat-unread').length, 0, 'зрителю тоже');
  t.openRoom(BOB, room);
  const log = syncs(t, BOB).at(-1).log;
  assert.deepEqual(log.map((l) => [l.k, l.react, l.name]), [['r', 'haha', 'Алиса']]);
});

/* ------------------------------------------------- не сохраняется */

test('не в комнату, не в базу, не в вид: serialize, база, версия стола и вид стола те же', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  try {
    const room = await poker(t);
    const now = t.clock.now();
    const VOLATILE = new Set(['ui', 'touchedAt', 'idleAt', 'idleWarned', 'botDue', 'deadline', 'remaining', 'runningSince', 'elapsedMs']);
    const snap = () => JSON.stringify(gameOf(room).serialize(room, now), (k, v) => (VOLATILE.has(k) ? undefined : v));
    const ser = snap();
    const rows = JSON.stringify(store.loadAll());
    const seq = room.seq;
    const keys = Object.keys(room).sort().join();
    const groupKeys = JSON.stringify(t.group);
    let writes = 0;
    for (const m of ['save', 'saveGroup', 'addEvent', 'setSetting', 'noteSeen']) {
      const orig = store[m].bind(store);
      store[m] = (...a) => { writes++; return orig(...a); };
    }
    await t.send(ALICE, { t: 'chat', text: 'тайное слово ЖИРАФ' });
    await t.send(BOB, { t: 'chat', text: 'ответ ЖИРАФ' });
    await t.send(BOB, { t: 'chat-read' });
    assert.equal(writes, 0, 'чат не пишет в базу');
    assert.equal(chats(t, CAROL).length, 2);
    assert.equal(snap(), ser, 'serialize комнаты тот же');
    assert.equal(JSON.stringify(store.loadAll()), rows);
    assert.equal(room.seq, seq);
    assert.equal(Object.keys(room).sort().join(), keys, 'в комнате не появилось полей');
    assert.equal(JSON.stringify(t.group), groupKeys);
    assert.doesNotMatch(JSON.stringify(gameOf(room).serialize(room, now)), /ЖИРАФ/);
    // Вид стола (то, что получает каждый телефон) тоже без чата.
    for (const u of [ALICE, BOB, CAROL, DAVE]) {
      await t.send(u, { t: 'refresh' });
      assert.doesNotMatch(JSON.stringify(t.state(u)), /ЖИРАФ/, `${u.first_name}: чата нет в виде`);
    }
  } finally {
    t.app.stop();
    store.close();
  }
});

test('не в карточку группы и не в Telegram: ни одного вызова API', async () => {
  const t = new Table();
  await poker(t);
  await t.app.settle();
  const calls = t.tg.calls.length;
  await t.send(ALICE, { t: 'chat', text: 'привет' });
  await t.advance(CHAT_GAP_MS);
  await t.send(BOB, { t: 'chat', text: 'привет' });
  await t.advance(5_000);
  assert.equal(chats(t, CAROL).length, 2);
  assert.deepEqual(t.tg.calls.slice(calls), [], 'чат не трогает Telegram');
});

test('что получил каждый телефон: в чате только место, имя, текст, время; карт и id людей нет', async () => {
  const t = new Table();
  await poker(t);
  const cast = [ALICE, BOB, CAROL];
  for (const u of cast) {
    await t.send(u, { t: 'chat', text: `от ${u.first_name}` });
    await t.advance(CHAT_GAP_MS);
  }
  const holes = Object.fromEntries(cast.map((u) => [u.id, t.hole(u)]));
  for (const u of [...cast, DAVE]) {
    const raw = JSON.stringify(t.page(u).inbox.filter((m) => m.t.startsWith('chat')));
    if (u === DAVE) assert.equal(raw, '[]', 'зрителю — ни строчки');
    for (const v of cast) {
      assert.ok(!raw.includes(`"${v.id}"`), 'нет Telegram-id строкой');
      if (u !== v) for (const c of holes[v.id] || []) assert.ok(!raw.includes(c), `${u.first_name}: нет карты ${c}`);
    }
  }
});

/* ------------------------------------------------------------ дуэль */

test('шахматы: сообщение соперника приходит обоим', async () => {
  const t = new Table();
  await t.start(ALICE);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  await t.send(ALICE, { t: 'create', game: 'chess', settings: { base: 0 }, reqId: 'r1' });
  const room = t.chess;
  await t.start(BOB);
  t.openRoom(BOB, room);
  await t.send(BOB, { t: 'sit' });
  await t.send(ALICE, { t: 'start' });
  await t.send(BOB, { t: 'chat', text: 'удачи' });
  for (const u of [ALICE, BOB]) assert.deepEqual(chats(t, u).map((m) => [m.m.seat, m.m.text]), [[seatOf(room, BOB), 'удачи']]);
});

test('во время обслуживания чат не принимается — отказ словами', async () => {
  const t = new Table();
  await poker(t);
  t.app.setMaintenance(true);
  await t.send(ALICE, { t: 'chat', text: 'эй' });
  assert.equal(err(t, ALICE)?.code, 'DOWN');
  assert.equal(chats(t, BOB).length, 0);
});

test('стол удалён — история стёрта', async () => {
  const t = new Table();
  const room = await poker(t);
  await t.send(ALICE, { t: 'chat', text: 'раз' });
  assert.ok(t.app.hub.chats.rooms.has(room.code));
  t.app.hub.chats.prune(() => false);
  assert.equal(t.app.hub.chats.rooms.size, 0);
});
