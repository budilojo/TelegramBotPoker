'use strict';
/**
 * Админка: цифры по игре, и только для своих.
 *
 * Два обещания, которые тут проверяются:
 *   — экран видит только тот, чей id стоит в `.env`; чужому он не то что не
 *     открывается, а не отличим от несуществующей комнаты;
 *   — в цифрах нет ни имён, ни карт, ни текста — только счётчики.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, initDataFor, durakStack } from './harness.js';
import { Store } from './store.js';
import { ymd } from './fmt.js';

const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });

/** Стол с настоящей базой: считать события в NullStore нечем. */
const withStats = (opts = {}) => new Table({ store: new Store(':memory:'), admins: ['101'], ...opts });

const openAdmin = (t, u) => t.openAdmin(u);

/* ------------------------------------------------------------ доступ */

test('админку открывает только тот, чей id в списке', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  const max = user(202, 'Макс');

  const mine = openAdmin(t, ivan);
  assert.ok(mine.session, 'свой — входит');
  assert.equal(t.state(ivan).kind, 'admin');

  const theirs = openAdmin(t, max);
  assert.equal(theirs.error, 'NO_ROOM', 'чужой — не входит');
  assert.equal(theirs.text, 'Стол не найден — возможно, игру уже удалили.',
    'и отказ тот же, что на выдуманный код: о существовании админки он не узнаёт');
});

test('без списка админов в неё не попадает никто', () => {
  const t = new Table({ store: new Store(':memory:') });
  assert.equal(openAdmin(t, user(101, 'Иван')).error, 'NO_ROOM');
});

test('/admin в личке шлёт кнопку админу и обычную справку остальным', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  const max = user(202, 'Макс');
  await t.start(ivan);
  await t.dm(ivan, '/admin');
  const m = [...t.tg.messages.values()].filter((x) => x.chatId === '101').at(-1);
  assert.match(m.text, /Цифры по игре/);
  assert.deepEqual(m.markup.inline_keyboard[0][0].web_app, { url: 'https://poker.example/?room=admin' });

  await t.start(max);
  await t.dm(max, '/admin');
  assert.match(t.lastDm(max), /Покер и дурак/, 'чужому — та же справка, что на любое сообщение');
  assert.ok(!t.lastDm(max).includes('Цифры'));
});

test('со страницы админки нельзя ходить за столом', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/newgame');
  openAdmin(t, ivan);
  await t.send(ivan, { t: 'act', action: 'fold' });
  assert.equal(t.lastError(ivan).code, 'BAD_REQUEST');
  await t.send(ivan, { t: 'create', game: 'durak' });
  assert.equal(t.lastError(ivan).code, 'BAD_REQUEST');
  assert.equal(t.app.roomsOf(t.chatId).length, 1, 'ничего не создалось');
});

/* ------------------------------------------------------------- цифры */

test('цифры считают то, что происходило: людей, группы, партии', async () => {
  const cast = THREE();
  const t = withStats();
  const day = ymd(t.clock.now());

  await t.cmd(cast.ivan, '/newgame');
  const poker = t.room;
  for (const u of [cast.max, cast.dima]) {
    t.openRoom(u, poker);
    await t.send(u, { t: 'sit' });
  }
  await t.send(cast.ivan, { t: 'start' });
  await t.runToShowdown(cast);
  await t.send(cast.max, { t: 'next' }); // вторая раздача
  await t.runToShowdown(cast);

  const s = t.app.store.stats(t.clock.now());
  assert.equal(s.day, day);
  assert.equal(s.people.total, 3, 'трое открывали приложение');
  assert.equal(s.people.today, 3);
  assert.equal(s.people.fresh, 3, 'все трое сегодня впервые');
  assert.equal(s.groups.total, 1);
  assert.equal(s.today.created, 1, 'одно лобби');
  assert.equal(s.today.rounds, 2, 'две раздачи');
  assert.equal(s.today.games, 1, 'обе — в одной игре');
  assert.deepEqual(s.today.byGame, { poker: { rounds: 2, games: 1 } });
  assert.equal(s.today.finished, 0);

  await t.cmd(cast.ivan, '/finish');
  assert.equal(t.app.store.stats(t.clock.now()).today.finished, 1);
  t.app.store.close();
});

test('две игры в группе считаются порознь, и партии тоже', async () => {
  const cast = THREE();
  const t = withStats();
  t.useDurakDeck(durakStack({ 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' }, { trump: 'AD' }));
  await t.cmd(cast.ivan, '/newgame');
  await t.send(cast.max, { t: 'sit' });
  await t.send(cast.ivan, { t: 'start' });

  await t.cmd(cast.ivan, '/game');
  t.openHub(cast.dima);
  await t.send(cast.dima, { t: 'create', game: 'durak' });
  const durak = t.durak;
  for (const u of [cast.ivan, cast.max]) {
    t.openRoom(u, durak);
    await t.send(u, { t: 'sit' });
  }
  await t.send(cast.dima, { t: 'start' });

  const s = t.app.store.stats(t.clock.now());
  assert.deepEqual(s.today.byGame, { poker: { rounds: 1, games: 1 }, durak: { rounds: 1, games: 1 } });
  assert.equal(s.today.created, 2);
  assert.equal(s.groups.total, 1, 'группа одна');
  t.app.store.close();
});

test('«вернулись» считается по вчерашним, а не по всем', async () => {
  const t = withStats();
  const now = t.clock.now();
  const store = t.app.store;
  const day = 86_400_000;
  store.noteSeen('1', now - day);
  store.noteSeen('2', now - day);
  store.noteSeen('3', now - day);
  store.noteSeen('1', now); // вернулся
  store.noteSeen('9', now); // новый

  const s = store.stats(now);
  assert.equal(s.people.yesterday, 3);
  assert.equal(s.people.returned, 1);
  assert.equal(s.people.today, 2);
  assert.equal(s.people.fresh, 1, 'новый — только тот, кого раньше не видели');
  assert.equal(s.people.total, 4);
  store.close();
});

test('один человек за вечер — одна строка, сколько бы раз он ни открывал', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  await t.cmd(ivan, '/newgame');
  for (let i = 0; i < 5; i++) {
    t.close(ivan);
    t.openRoom(ivan, t.room);
  }
  assert.equal(t.app.store.stats(t.clock.now()).people.total, 1);
  t.app.store.close();
});

test('хвост по дням отдаёт две недели подряд, включая пустые', async () => {
  const t = withStats();
  const now = t.clock.now();
  t.app.store.noteSeen('1', now - 3 * 86_400_000);
  const s = t.app.store.stats(now);
  assert.equal(s.days.length, 14);
  assert.equal(s.days.at(-1).day, ymd(now), 'последний — сегодня');
  assert.equal(s.days.at(-4).people, 1);
  assert.equal(s.days.at(-2).people, 0, 'пустой день — ноль, а не пропуск');
  t.app.store.close();
});

test('«сейчас в игре» берётся из памяти, а не из базы', async () => {
  const cast = THREE();
  const t = withStats();
  await t.cmd(cast.ivan, '/newgame');
  t.openRoom(cast.ivan, t.room);
  t.openRoom(cast.max, t.room);
  await t.send(cast.max, { t: 'sit' });

  let live = t.app.liveNow();
  assert.equal(live.lobbies, 1);
  assert.equal(live.playing, 0);
  assert.equal(live.groups, 1);
  assert.equal(live.online, 2, 'Иван и Макс смотрят в приложение');

  await t.send(cast.ivan, { t: 'start' });
  live = t.app.liveNow();
  assert.equal(live.playing, 1);
  assert.equal(live.lobbies, 0);
  assert.deepEqual(live.byGame, { poker: 1 });
  t.app.store.close();
});

/* -------------------------------------------------- ничего лишнего */

test('в состоянии админки нет ни имён игроков, ни карт', async () => {
  const cast = THREE();
  const t = withStats();
  t.useDurakDeck(durakStack({ 202: '6D 7S 8S 9S 10S JS', 303: '7H 8H 9H 10H JH QH', 101: '7C 8C 9C 10C JC QC' }, { trump: 'AD' }));
  await t.cmd(cast.ivan, '/game');
  t.openHub(cast.ivan);
  await t.send(cast.ivan, { t: 'create', game: 'durak' });
  const room = t.durak;
  for (const u of [cast.max, cast.dima]) {
    t.openRoom(u, room);
    await t.send(u, { t: 'sit' });
  }
  await t.send(cast.ivan, { t: 'start' });

  const admin = user(101, 'Иван');
  t.close(admin);
  openAdmin(t, admin);
  const json = JSON.stringify(t.state(admin));

  for (const name of ['Макс', 'Дима']) assert.ok(!json.includes(name), `в цифрах есть имя ${name}`);
  for (const card of Object.values(room.deal.hands).flat()) {
    assert.ok(!json.includes(`"${card}"`), `в цифрах есть карта ${card}`);
  }
  // Код комнаты — единственное, что теперь на экране есть: им игра и
  // завершается со вкладки «Сейчас» (docs/admin.md, раздел 2). Имя игрока и
  // карта не добавили бы к этому ничего, кроме нарушенного обещания.
  assert.ok(json.includes(room.code), 'код нужен: им завершают зависшую игру');
  assert.ok(!json.includes(String(t.chatId)), 'а id чата — нет');
  assert.equal(t.state(admin).stats.today.rounds, 1, 'а цифры при этом настоящие');
  t.app.store.close();
});

test('«Обновить» пересчитывает; ничего другого страница админки не просит', async () => {
  const t = withStats();
  const ivan = user(101, 'Иван');
  openAdmin(t, ivan);
  assert.equal(t.state(ivan).stats.today.created, 0);
  await t.cmd(ivan, '/newgame');
  assert.equal(t.state(ivan).stats.today.created, 0, 'сама собой не обновляется');
  await t.send(ivan, { t: 'refresh' });
  assert.equal(t.state(ivan).stats.today.created, 1);
  t.app.store.close();
});
