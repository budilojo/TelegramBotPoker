import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, initDataFor, user } from './harness.js';
import { RATING_SOON_TEXT } from './app.js';
import { rankedKey } from './ranked.js';
import { Store } from './store.js';
import { GAME_LIST } from './games/index.js';
import { apply as rateRound } from './rating.js';

const alice = user(101, 'Алиса');
const bob = user(202, 'Борис');
const carol = user(303, 'Карина');
const lastList = (t, u) => t.page(u).inbox.findLast(m => m.t === 'rtables')?.tables;
const publicTable = (options = {}) => new Table({ ratingSoon: false, legacyGroupRating: false, ...options });

test('выключатели блокируют список, создание и вход в публичные столы', async () => {
  for (const [settings, reason] of [[{ ratingSoon: true }, 'RATING_SOON'], [{ rankedTablesSoon: true }, 'RANKED_TABLES_SOON']]) {
    const t = publicTable(settings);
    t.openSolo(alice);
    for (const msg of [{ t: 'rtables', game: 'chess' }, { t: 'rcreate', game: 'chess' }, { t: 'rjoin', code: 'hidden' }]) {
      await t.send(alice, msg);
      assert.equal(t.lastError(alice)?.code, reason);
    }
    assert.equal(lastList(t, alice), undefined);
    assert.equal(t.app.liveRooms(rankedKey('chess')).length, 0);
    if (settings.ratingSoon) assert.equal(t.state(alice).ratingSoon, RATING_SOON_TEXT);
  }
});

test('публичный стол виден без группы, настройки фиксированы, последнего гостя пускают один раз', async () => {
  const t = publicTable();
  await t.cmd(alice, '/game');
  t.openHub(alice);
  await t.send(alice, { t: 'create', game: 'chess', ranked: true });
  const privateRoom = t.app.liveRooms(t.chatId)[0];
  t.openSolo(bob);
  t.openSolo(carol);
  await t.send(bob, { t: 'rtables', game: 'nope' });
  assert.equal(t.lastError(bob).code, 'NO_RANKED_GAME');
  await t.send(bob, { t: 'rtables', game: 'chess' });
  assert.deepEqual(lastList(t, bob), []);
  await t.send(bob, { t: 'rjoin', code: privateRoom.code });
  assert.equal(t.lastError(bob).code, 'NO_ROOM');

  await t.send(alice, { t: 'hub' });
  await t.send(alice, { t: 'rcreate', game: 'chess', settings: { base: 0 }, id: bob.id });
  const room = t.app.liveRooms(rankedKey('chess'))[0];
  assert.equal(room.hostId, String(alice.id));
  assert.ok(room.settings.base > 0);
  assert.equal(t.state(alice).ranked, true);
  assert.deepEqual(lastList(t, bob).map(r => r.code), [room.code], 'список обновился без повторного запроса');
  assert.equal(t.openRoom(carol, room).error, 'NO_ROOM', 'прямой код не сажает за стол');
  await t.send(bob, { t: 'rtables', game: 'poker' });
  assert.deepEqual(lastList(t, bob), []);
  await t.send(bob, { t: 'rjoin', code: room.code, id: carol.id });
  assert.equal(t.state(bob).room.code, room.code);
  assert.deepEqual(room.players.map(p => p.id), [String(alice.id), String(bob.id)]);
  await t.send(carol, { t: 'rjoin', code: room.code });
  assert.equal(t.lastError(carol)?.code, 'RANKED_FULL');
  await t.send(alice, { t: 'settings', base: 0 });
  assert.equal(t.lastError(alice)?.code, 'RANKED_RULES');
  await t.send(alice, { t: 'kick', seat: 1 });
  assert.equal(t.lastError(alice)?.code, 'RANKED_RULES');

  t.close(bob);
  t.open(bob, { initData: initDataFor(bob, { startParam: 'solo', clock: t.clock }), room: room.code, back: true });
  assert.equal(t.state(bob).room.code, room.code, 'возврат после обрыва из личного входа');
  t.close(alice);
  t.openHub(alice, { room: room.code });
  assert.equal(t.state(alice).room.code, room.code, 'возврат после обрыва из входа группы');
  await t.send(bob, { t: 'hub' });
  assert.equal(t.state(bob).tables, true);
  await t.send(bob, { t: 'rcreate', game: 'chess' });
  assert.equal(t.state(bob).room.code, room.code, 'один стол на игрока в этой игре');
  await t.send(bob, { t: 'leave' });
  assert.equal(t.state(bob).tables, true);
  await t.send(carol, { t: 'rjoin', code: room.code });
  assert.equal(t.state(carol).room.code, room.code);
});

async function finishChess(t, room) {
  await t.send(alice, { t: 'start' });
  for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
    const who = room.match.pos.t === 'w' ? room.match.white : room.match.black;
    await t.send(who === String(alice.id) ? alice : bob, { t: 'move', from, to, ply: room.match.moves.length });
  }
  assert.equal(room.match.over.kind, 'mate');
  await t.send(alice, { t: 'finish' });
  assert.equal(room.status, 'finished');
}

test('группа и старые очки вне лиги, публичная партия идёт в таблицу и журнал один раз', async ctx => {
  const store = new Store(':memory:');
  const t = publicTable({ store, admins: [String(alice.id)] });
  ctx.after(() => { t.app.stop(); store.close(); });
  store.rate({ userId: carol.id, game: 'chess', chatId: t.chatId, round: 'old', delta: 20, of: 2, place: 1, at: t.clock.now() });
  store.setRatingWatch([String(bob.id)]);

  await t.cmd(alice, '/game');
  t.openHub(alice);
  await t.send(alice, { t: 'create', game: 'chess' });
  const friends = t.app.liveRooms(t.chatId)[0];
  t.openRoom(bob, friends);
  await t.send(bob, { t: 'sit' });
  await finishChess(t, friends);
  assert.equal(store.ratingOf(bob.id, 'chess'), null);
  assert.equal(store.ratingOf(carol.id, 'chess').played, 1, 'архив сохранился');

  t.openSolo(alice);
  t.openSolo(bob);
  const before = t.tg.calls.length;
  await t.send(alice, { t: 'rcreate', game: 'chess' });
  const room = t.app.liveRooms(rankedKey('chess'))[0];
  await t.send(bob, { t: 'rjoin', code: room.code });
  await finishChess(t, room);
  assert.equal(t.tg.calls.length, before, 'рейтинговый стол не пишет в Telegram');
  assert.equal(t.app.groupsOf(bob.id).some(g => g.chatId === room.chatId), false);
  assert.equal(store.ratingReviews().length, 1, 'сработало наблюдение за игроком');
  assert.equal(store.ratingOf(bob.id, 'chess'), null, 'публичная партия не дописала старый рейтинг');

  await t.send(alice, { t: 'hub' });
  await t.send(alice, { t: 'pick', game: 'chess', scope: 'group' });
  const leaderboard = t.state(alice);
  assert.equal(leaderboard.canGroup, false);
  assert.deepEqual(leaderboard.top.map(p => p.userId).sort(), [String(alice.id), String(bob.id)]);
  assert.ok(leaderboard.top.every(p => p.played === 1));
  await t.send(alice, { t: 'who', id: carol.id });
  assert.equal(t.state(alice).who, null, 'история из старых групп недоступна в лиге');
  assert.equal(t.errors.length, 0);
});

test('публичный режим можно открыть из лички и вернуться в игры', async () => {
  const t = publicTable();
  t.openSolo(alice);
  assert.equal(t.state(alice).rankGames.length, 7);
  await t.send(alice, { t: 'rating' });
  assert.equal(t.state(alice).kind, 'rating');
  await t.send(alice, { t: 'back' });
  assert.equal(t.state(alice).kind, 'solo');
});


test('публичные лобби всех доступных игр переживают перезапуск и запускаются с часами', async ctx => {
  const store = new Store(':memory:');
  const t = publicTable({ store });
  ctx.after(() => { t.app.stop(); store.close(); });
  for (const game of GAME_LIST) {
    t.openSolo(alice);
    await t.send(alice, { t: 'rcreate', game: game.id });
    const [room] = t.app.liveRooms(rankedKey(game.id));
    assert.ok(room, game.id);
    assert.ok(room.settings.turnSeconds > 0 || room.settings.base > 0, `часы включены в ${game.id}`);
  }
  const restored = publicTable({ store, clock: t.clock });
  ctx.after(() => restored.app.stop());
  restored.app.load();
  for (const game of GAME_LIST) {
    const [room] = restored.app.liveRooms(rankedKey(game.id));
    assert.equal(room?.status, 'lobby', game.id);
    restored.openRoom(alice, room);
    restored.openSolo(bob);
    await restored.send(bob, { t: 'rjoin', code: room.code });
    await restored.send(alice, { t: 'start' });
    assert.equal(room.status, 'playing', game.id);
    await restored.send(alice, { t: 'finish' });
    assert.equal(restored.lastError(alice)?.code, 'RANKED_ACTIVE', game.id);
    assert.equal(room.status, 'playing', game.id);
  }
  assert.equal(restored.tg.calls.length, 0);
  assert.deepEqual(restored.errors, []);
});

test('сбой во второй записи партии откатывает первую, повтор засчитывается целиком', ctx => {
  const store = new Store(':memory:');
  ctx.after(() => store.close());
  const chatId = rankedKey('chess');
  const game = { game: 'chess', round: 'match', chatId, ranked: true,
    places: [alice, bob], loserId: bob.id };
  const rate = store.rate.bind(store);
  store.rate = (row) => {
    if (row.userId === String(bob.id)) throw new Error('сбой базы');
    return rate(row);
  };
  assert.throws(() => rateRound(store, game), /сбой базы/);
  assert.deepEqual(store.activityRating('chess', { chatId }), []);
  store.rate = rate;
  assert.equal(rateRound(store, game).rows.length, 2);
  assert.equal(rateRound(store, game).skipped, 'ALREADY');
  assert.deepEqual(store.activityRating('chess', { chatId }).map(p => p.played), [1, 1]);
});
