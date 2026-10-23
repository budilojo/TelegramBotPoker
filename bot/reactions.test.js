'use strict';
/**
 * Смайлики во время игры (bot/reactions.js + приём `react` в bot/hub.js).
 *
 *   НИКТО НЕ ХОДИТ ЗА ДРУГОГО — кто прислал смайлик, решает подпись страницы;
 *   место, id и имя в теле сообщения ничего не значат.
 *   НИКТО НЕ ВИДИТ ЧУЖОГО — у реакции наружу только место, id смайлика и время.
 *   НЕ СОХРАНЯЕТСЯ — ни в комнату, ни в базу, ни в карточку группы.
 *   ЛИМИТ — раз в 3 с и шесть в минуту на человека, по часам приложения.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Table, user } from './harness.js';
import { Store } from './store.js';
import { REACTIONS, REACTION_IDS, REACT_GAP_MS, REACT_PER_MIN } from './reactions.js';
import { gameOf } from './games/index.js';

const ALICE = user(1, 'Алиса');
const BOB = user(2, 'Боб');
const CAROL = user(3, 'Катя');
const DAVE = user(4, 'Дима'); // зритель

const reacts = (t, u) => t.page(u).inbox.filter((m) => m.t === 'react');
const states = (t, u) => t.page(u).inbox.filter((m) => m.t === 'state').length;
const err = (t, u) => t.lastError(u);

/** Покерный стол на троих, начатый, и зритель с открытой страницей. */
async function poker(t) {
  await t.begin({ ALICE, BOB, CAROL });
  t.open(DAVE);
  return t.room;
}

async function durak(t, cast) {
  const [host, ...rest] = Object.values(cast);
  for (const u of Object.values(cast)) await t.start(u);
  await t.cmd(host, '/play');
  t.openHub(host);
  await t.send(host, { t: 'create', game: 'durak', settings: {} });
  const room = t.durak;
  for (const u of rest) {
    t.openRoom(u, room);
    await t.send(u, { t: 'sit' });
  }
  return room;
}

async function chess(t) {
  await t.start(ALICE);
  await t.cmd(ALICE, '/play');
  t.openHub(ALICE);
  await t.send(ALICE, { t: 'create', game: 'chess', settings: { base: 0 }, reqId: 'r1' });
  const room = t.chess;
  await t.start(BOB);
  t.openRoom(BOB, room);
  await t.send(BOB, { t: 'sit' });
  await t.send(ALICE, { t: 'start' });
  return room;
}

/**
 * Снимок комнаты для сравнения «до/после». Часы блайндов покера идут по
 * настоящему времени (bot/room.js, `Date.now()`), поэтому их поля между двумя
 * снимками сдвигаются сами — без всякого смайлика. Тот же список «живых» полей,
 * что в audit.identity.test.js.
 */
const VOLATILE = new Set(['ui', 'touchedAt', 'idleAt', 'idleWarned', 'botDue', 'deadline', 'remaining', 'runningSince', 'elapsedMs']);
const snap = (room, now) => JSON.stringify(gameOf(room).serialize(room, now), (k, v) => (VOLATILE.has(k) ? undefined : v));

const seatOf = (room, u) => room.players.findIndex((p) => p.id === String(u.id));

/* ------------------------------------------------------------- набор */

test('набор закрытый: 16 смайликов, подписи по-русски, клиент знает те же id', () => {
  assert.equal(REACTION_IDS.length, 16);
  assert.deepEqual(REACTION_IDS, ['gg', 'wow', 'haha', 'sad', 'think', 'fire', 'bluff', 'allin', 'thanks', 'sorry', 'hello', 'angry', 'facepalm', 'cool', 'wait', 'cheers']);
  for (const id of REACTION_IDS) assert.match(REACTIONS[id], /[а-яё]/i, `${id}: подпись по-русски`);
  // Клиент держит свою копию (запасной эмодзи и подпись) — списки обязаны совпадать.
  const src = readFileSync(new URL('../miniapp/reactions.js', import.meta.url), 'utf8');
  const block = src.match(/export const REACTIONS = \[([\s\S]*?)\];/);
  assert.ok(block, 'в miniapp/reactions.js есть список REACTIONS');
  const ids = [...block[1].matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, REACTION_IDS, 'тот же порядок и те же id');
  for (const id of REACTION_IDS) {
    assert.ok(block[1].includes(`label: '${REACTIONS[id]}'`), `${id}: та же подпись у клиента`);
  }
});

/* ------------------------------------------------------- рассылка */

test('смайлик за покерным столом: всем страницам стола одно лёгкое сообщение с местом, без пересборки состояния', async () => {
  const t = new Table();
  const room = await poker(t);
  const before = Object.fromEntries([ALICE, BOB, CAROL, DAVE].map((u) => [u.id, states(t, u)]));
  await t.send(BOB, { t: 'react', id: 'wow' });
  for (const u of [ALICE, BOB, CAROL, DAVE]) {
    const got = reacts(t, u);
    assert.equal(got.length, 1, `${u.first_name} получил смайлик`);
    assert.deepEqual(got[0], { t: 'react', seat: seatOf(room, BOB), id: 'wow', at: t.clock.now() });
    assert.equal(states(t, u), before[u.id], `${u.first_name}: состояние стола не пересылалось`);
  }
  assert.equal(err(t, BOB), null);
});

test('подмена в теле: место, id и имя из сообщения ничего не значат', async () => {
  const t = new Table();
  const room = await poker(t);
  await t.send(ALICE, { t: 'react', id: 'gg', seat: seatOf(room, CAROL), uid: String(CAROL.id), from: CAROL.id, user: { id: CAROL.id }, name: 'Катя' });
  const got = reacts(t, CAROL);
  assert.equal(got.length, 1);
  assert.equal(got[0].seat, seatOf(room, ALICE), 'пришло от Алисы, а не от Кати');
  assert.deepEqual(Object.keys(got[0]).sort(), ['at', 'id', 'seat', 't'], 'лишнее из тела не переехало в рассылку');
});

test('неизвестный смайлик — отказ словами и тишина у остальных', async () => {
  const t = new Table();
  await poker(t);
  for (const id of ['nope', 'constructor', '__proto__', 'toString', 'GG', '', 5, null, { id: 'gg' }, ['gg']]) {
    await t.send(ALICE, { t: 'react', id });
    assert.equal(err(t, ALICE)?.code, 'REACT_UNKNOWN', `id ${JSON.stringify(id)}`);
    assert.equal(err(t, ALICE).text, 'Такого смайлика нет.');
  }
  for (const u of [ALICE, BOB, CAROL, DAVE]) assert.equal(reacts(t, u).length, 0);
});

test('зритель не шлёт смайлики — отказ словами; ушедший из-за стола тоже', async () => {
  const t = new Table();
  await poker(t);
  await t.send(DAVE, { t: 'react', id: 'haha' });
  assert.equal(err(t, DAVE)?.code, 'REACT_NOT_SEATED');
  assert.equal(err(t, DAVE).text, 'Смайлики отправляют те, кто играет за этим столом.');
  for (const u of [ALICE, BOB, CAROL, DAVE]) assert.equal(reacts(t, u).length, 0);

  // Дурак: встал из-за стола (seated: false) — уже не игрок.
  const d = new Table();
  const room = await durak(d, { ALICE, BOB, CAROL });
  await d.send(CAROL, { t: 'leave' });
  // В лобби не-хост уходит совсем; хост встаёт, оставаясь в списке.
  await d.send(ALICE, { t: 'leave' });
  assert.equal(room.players.find((p) => p.id === '1')?.seated, false);
  await d.send(ALICE, { t: 'react', id: 'sad' });
  assert.equal(err(d, ALICE)?.code, 'REACT_NOT_SEATED');
  await d.send(CAROL, { t: 'react', id: 'sad' });
  assert.equal(err(d, CAROL)?.code, 'REACT_NOT_SEATED');
  await d.send(BOB, { t: 'react', id: 'sad' });
  assert.equal(err(d, BOB), null, 'сидящий Боб может');
  assert.equal(reacts(d, ALICE).length, 1, 'а Алиса (зритель теперь) его смайлик видит');
});

test('удалённый хостом из-за стола не шлёт смайлики', async () => {
  const t = new Table();
  const room = await poker(t);
  room.players.find((p) => p.id === '3').kicked = true;
  await t.send(CAROL, { t: 'react', id: 'angry' });
  assert.equal(err(t, CAROL)?.code, 'REACT_NOT_SEATED');
});

/* ------------------------------------------------------------ лимит */

test('лимит: не чаще раза в 3 с — отказ «подождите N с» по часам приложения', async () => {
  const t = new Table();
  await poker(t);
  await t.send(ALICE, { t: 'react', id: 'gg' });
  await t.send(ALICE, { t: 'react', id: 'wow' });
  assert.equal(err(t, ALICE)?.code, 'REACT_WAIT');
  assert.equal(err(t, ALICE).text, 'Не так часто — подождите 3 с.');
  assert.equal(err(t, ALICE).wait, REACT_GAP_MS);
  await t.advance(1_200);
  await t.send(ALICE, { t: 'react', id: 'wow' });
  assert.equal(err(t, ALICE).text, 'Не так часто — подождите 2 с.');
  // Отказ не считается реакцией: ждать не дольше, чем от первой.
  await t.advance(1_800);
  const n = t.page(ALICE).inbox.length;
  await t.send(ALICE, { t: 'react', id: 'wow' });
  assert.equal(t.page(ALICE).inbox.slice(n).some((m) => m.t === 'error'), false, 'через 3 с — можно');
  assert.deepEqual(reacts(t, BOB).map((m) => m.id), ['gg', 'wow'], 'отказанные не разосланы');
  // Лимит — на человека: Боба Алиса не тормозит.
  await t.send(BOB, { t: 'react', id: 'haha' });
  assert.equal(err(t, BOB), null);
});

test('лимит: не больше шести в минуту, даже с паузами по 3 с', async () => {
  const t = new Table();
  await poker(t);
  for (let i = 0; i < REACT_PER_MIN; i++) {
    await t.send(ALICE, { t: 'react', id: REACTION_IDS[i] });
    assert.equal(err(t, ALICE), null, `смайлик ${i + 1}`);
    await t.advance(REACT_GAP_MS);
  }
  // Прошло 18 с с первого: седьмой — только когда первый выйдет из минуты.
  await t.send(ALICE, { t: 'react', id: 'cheers' });
  assert.equal(err(t, ALICE)?.code, 'REACT_WAIT');
  assert.equal(err(t, ALICE).text, 'Не так часто — подождите 42 с.');
  await t.advance(41_000);
  await t.send(ALICE, { t: 'react', id: 'cheers' });
  assert.equal(err(t, ALICE).text, 'Не так часто — подождите 1 с.');
  await t.advance(1_000);
  const n = t.page(ALICE).inbox.length;
  await t.send(ALICE, { t: 'react', id: 'cheers' });
  assert.equal(t.page(ALICE).inbox.slice(n).some((m) => m.t === 'error'), false, 'через минуту — можно');
  assert.equal(reacts(t, BOB).length, REACT_PER_MIN + 1);
});

/* ------------------------------------------------- не сохраняется */

test('не в комнату и не в базу: serialize, база и номер версии стола не меняются', async () => {
  const store = new Store(':memory:');
  const t = new Table({ store });
  try {
    const room = await poker(t);
    const now = t.clock.now();
    const ser = snap(room, now);
    const rows = JSON.stringify(store.loadAll());
    const seq = room.seq;
    const keys = Object.keys(room).sort().join();
    const groupKeys = JSON.stringify(t.group);
    // Ни одной записи в базу — даже «того же самого».
    let writes = 0;
    for (const m of ['save', 'saveGroup', 'addEvent', 'setSetting', 'noteSeen']) {
      const orig = store[m].bind(store);
      store[m] = (...a) => { writes++; return orig(...a); };
    }
    await t.send(ALICE, { t: 'react', id: 'fire' });
    await t.send(BOB, { t: 'react', id: 'bluff' });
    assert.equal(writes, 0, 'смайлики не пишут в базу');
    assert.equal(reacts(t, CAROL).length, 2);
    assert.equal(snap(room, now), ser, 'serialize комнаты тот же (кроме часов, что идут сами)');
    assert.equal(JSON.stringify(store.loadAll()), rows, 'в базе то же самое');
    assert.equal(room.seq, seq, 'стол не «сдвинулся»');
    assert.equal(Object.keys(room).sort().join(), keys, 'в комнате не появилось полей');
    assert.equal(JSON.stringify(t.group), groupKeys, 'запись группы та же');
    assert.doesNotMatch(JSON.stringify(gameOf(room).serialize(room, now)), /fire|bluff/);
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
  await t.send(ALICE, { t: 'react', id: 'cool' });
  await t.advance(REACT_GAP_MS);
  await t.send(BOB, { t: 'react', id: 'thanks' });
  await t.advance(5_000);
  assert.equal(reacts(t, CAROL).length, 2);
  assert.deepEqual(t.tg.calls.slice(calls), [], 'смайлики не трогают Telegram');
});

/* ------------------------------------------- что получил каждый телефон */

test('что получил каждый телефон: в реакциях только место, id и время; карт и id людей нет', async () => {
  const t = new Table();
  const room = await poker(t);
  const cast = [ALICE, BOB, CAROL];
  for (const [i, u] of cast.entries()) {
    await t.send(u, { t: 'react', id: REACTION_IDS[i] });
  }
  const holes = Object.fromEntries(cast.map((u) => [u.id, t.hole(u)]));
  for (const u of [...cast, DAVE]) {
    const got = reacts(t, u);
    assert.equal(got.length, 3, `${u.first_name}: все три`);
    for (const m of got) {
      assert.deepEqual(Object.keys(m).sort(), ['at', 'id', 'seat', 't']);
      assert.ok(Number.isInteger(m.seat) && m.seat >= 0 && m.seat < room.players.length);
      const raw = JSON.stringify(m);
      for (const v of cast) {
        assert.ok(!raw.includes(`"${v.id}"`), 'нет Telegram-id строкой');
        for (const c of holes[v.id] || []) assert.ok(!raw.includes(c), `${u.first_name}: в смайлике нет карты ${c}`);
      }
    }
  }
});

/* ------------------------------------------------------- дуэли и боты */

test('шахматы: смайлик соперника приходит обоим, место — номер в списке игроков', async () => {
  const t = new Table();
  const room = await chess(t);
  await t.send(BOB, { t: 'react', id: 'think' });
  for (const u of [ALICE, BOB]) {
    assert.deepEqual(reacts(t, u).map((m) => [m.seat, m.id]), [[seatOf(room, BOB), 'think']]);
  }
  assert.equal(t.state(ALICE).players[seatOf(room, BOB)].isMe, false, 'место совпадает с местом в виде стола');
  assert.equal(t.state(BOB).players[seatOf(room, BOB)].isMe, true);
});

test('игра с ботами: владелец партии шлёт смайлик, место — его', async () => {
  const t = new Table();
  await t.start(ALICE);
  t.openSolo(ALICE);
  await t.send(ALICE, { t: 'play', game: 'durak', settings: {} });
  const room = t.app.soloOf('1');
  assert.ok(room);
  await t.send(ALICE, { t: 'react', id: 'hello' });
  assert.equal(err(t, ALICE), null);
  assert.deepEqual(reacts(t, ALICE).map((m) => [m.seat, m.id]), [[seatOf(room, ALICE), 'hello']]);
});

test('во время обслуживания смайлики не принимаются — отказ словами', async () => {
  const t = new Table();
  await poker(t);
  t.app.setMaintenance(true);
  await t.send(ALICE, { t: 'react', id: 'gg' });
  assert.equal(err(t, ALICE)?.code, 'DOWN');
  assert.equal(reacts(t, BOB).length, 0);
});

/* ------------------------------------- белый список по играм (набор эмодзи) */

test('набор по играм: «Блеф» и «Олл-ин» — только за покерным столом, общие — везде', async () => {
  const t = new Table();
  const room = await poker(t);
  await t.send(ALICE, { t: 'react', id: 'bluff' });
  assert.equal(err(t, ALICE), null, 'в покере можно');
  const d = new Table();
  await durak(d, { ALICE, BOB, CAROL });
  await d.send(BOB, { t: 'react', id: 'bluff' });
  assert.equal(err(d, BOB)?.code, 'REACT_UNKNOWN', 'в дураке «Блефа» нет');
  await d.send(BOB, { t: 'react', id: 'allin' });
  assert.equal(err(d, BOB)?.code, 'REACT_UNKNOWN');
  const errs = d.page(BOB).inbox.filter((m) => m.t === 'error').length;
  await d.send(BOB, { t: 'react', id: 'gg' });
  assert.equal(d.page(BOB).inbox.filter((m) => m.t === 'error').length, errs, 'общая реакция — везде');
  assert.equal(reacts(d, ALICE).length, 1);
});
