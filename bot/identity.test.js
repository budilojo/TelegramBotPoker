'use strict';
/**
 * The tests that matter most: NOBODY EVER ACTS FOR SOMEBODY ELSE.
 *
 * In the Mini App a person is the user inside an initData signed with the
 * bot's token — and nothing else. Every test here uses a real, validly signed
 * page for each person; the attack is not a broken signature (that has its
 * own tests) but being the wrong person, or claiming to be somebody else in
 * the body of a message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { identify, GROUP_ANONYMOUS_BOT_ID, CHANNEL_BOT_ID } from './identity.js';
import { Table, user, initDataFor, TEST_TOKEN } from './harness.js';
import { ANON_USER, cmdUpdate } from './tg-stub.js';
import { signInitData } from './webapp-auth.js';

const CAST = () => ({
  ivan: user(101, 'Иван'),
  max: user(202, 'Макс'),
  dima: user(303, 'Дима'),
  sasha: user(404, 'Саша'),
});

/* ------------------------------------------------------------- the unit */

test('identify: a normal member becomes a player id equal to their Telegram id', () => {
  const r = identify({ id: 555, is_bot: false, first_name: 'Иван' });
  assert.equal(r.ok, true);
  assert.equal(r.user.id, '555');
  assert.equal(r.user.name, 'Иван');
});

test('identify: the anonymous-admin account and sender_chat are refused, with a reason', () => {
  assert.equal(identify({ id: GROUP_ANONYMOUS_BOT_ID, is_bot: true }).reason, 'ANON');
  assert.equal(identify({ id: 777, is_bot: false, first_name: 'X' }, { id: -100500, type: 'supergroup' }).reason, 'ANON');
  assert.equal(identify({ id: CHANNEL_BOT_ID, is_bot: true }).reason, 'ANON');
  assert.equal(identify({ id: 12345, is_bot: true, first_name: 'SomeBot' }).reason, 'BOT');
  assert.equal(identify(null).ok, false);
});

test('identify: a missing first_name falls back without throwing', () => {
  assert.equal(identify({ id: 9, is_bot: false, username: 'nick' }).user.name, 'nick');
  assert.equal(identify({ id: 9, is_bot: false }).user.name, 'Игрок 9');
});

/* -------------------------------------------------------- in the group */

test('an anonymous admin cannot create a table, and is told why', async () => {
  const t = new Table();
  await t.cmd(ANON_USER, '/newgame');
  assert.equal(t.room, null);
  assert.match(t.lastPost(), /Анонимные админы/);

  await t.raw(cmdUpdate(t.chatId, user(101, 'Иван'), '/newgame', { sender_chat: { id: -1001, type: 'supergroup' } }));
  assert.equal(t.room, null, 'a message on behalf of the chat creates nothing');
});

/* ---------------------------------------------------- opening the table */

test('a page with a forged or foreign signature gets no seat at the table', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);

  const mallory = user(666, 'Мэллори');
  const forged = signInitData({ auth_date: Math.floor(t.clock.now() / 1000), user: { id: 101, first_name: 'Иван' }, start_param: t.room.code }, '999:another-bot');
  assert.equal(t.open(mallory, { initData: forged }).error, 'AUTH', 'signed by another bot = not signed');
  assert.equal(t.open(mallory, { initData: 'user=%7B%22id%22%3A101%7D' }).error, 'AUTH', 'unsigned');
  const stale = initDataFor(cast.ivan, { startParam: t.room.code, authDate: Math.floor(t.clock.now() / 1000) - 3 * 86400 });
  assert.match(t.open(cast.ivan, { initData: stale }).text, /устарела/, 'three-day-old session');
});

test('opening the table seats nobody — sitting down is a separate, deliberate tap', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  const guest = user(9999, 'Прохожий');
  const r = t.open(guest);
  assert.ok(r.session, 'anyone with the link may look');
  assert.equal(t.room.players.length, 4, 'but looking is not sitting');
  assert.equal(t.state(guest).me.seated, false);
  assert.equal(t.state(guest).me.cards.length, 0);
});

test('the signed room wins over whatever room the page asks for', async () => {
  const t = new Table();
  await t.seat({ ivan: user(101, 'Иван') });
  const u = user(202, 'Макс');
  const r = t.open(u, { room: 'somebody-elses-room' });
  assert.ok(r.session);
  assert.equal(r.session.code, t.room.code, 'the start_param inside the signature decides');
  assert.equal(t.open(user(203, 'Дима'), { initData: initDataFor(user(203, 'Дима'), { startParam: 'nosuchroom' }) }).error, 'NO_ROOM');
});

/* ----------------------------------------- nobody acts for anybody else */

test('a player who is not on the clock cannot move — and is told so', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const actorId = t.actor();
  const intruder = Object.values(cast).find((u) => String(u.id) !== actorId);
  const before = t.room.players.map((p) => [p.stack, p.folded]);

  for (const action of ['fold', 'call', 'check', 'allin']) await t.act(intruder, action);
  await t.act(intruder, 'raise', 500);

  assert.deepEqual(t.room.players.map((p) => [p.stack, p.folded]), before, 'nothing moved, nobody folded');
  assert.equal(t.actor(), actorId, 'the clock did not move');
  assert.equal(t.lastError(intruder).code, 'NOT_YOUR_TURN', 'the refusal is spoken, not silent');
});

test('a message cannot say who is acting: ids, seats and names in the body are ignored', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const actor = t.actorOf(cast);
  const intruder = Object.values(cast).find((u) => u !== actor);
  const seat = t.room.players.findIndex((p) => p.id === String(actor.id));
  const before = t.room.players.map((p) => p.stack);

  await t.send(intruder, { t: 'act', action: 'fold', seat, user: { id: actor.id }, userId: actor.id, from: actor, id: actor.id });
  assert.deepEqual(t.room.players.map((p) => p.stack), before);
  assert.equal(t.room.players[seat].folded, false, `${actor.first_name} was not folded by somebody else`);
  assert.equal(t.actor(), String(actor.id));
});

test('a spectator who never sat down cannot act either', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const ghost = user(9999, 'Прохожий');
  const before = t.actor();
  await t.act(ghost, 'call');
  assert.equal(t.actor(), before);
  assert.equal(t.lastError(ghost).code, 'NOT_YOUR_TURN');
  assert.equal(t.room.players.length, 4, 'and acting did not seat them');
});

test('the actor can act — the identity check is not a wall for everybody', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const actor = t.actorOf(cast);
  await t.act(actor, 'call');
  assert.notEqual(t.actor(), String(actor.id));
});

/* ------------------------------------------------------------ host rights */

test('a non-host cannot touch settings, seats, roles or the game itself', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  const settings = JSON.stringify(t.room.settings);

  const attempts = [
    { t: 'settings', smallBlind: 500, bigBlind: 1000, startingStack: 999999, turnSeconds: 15, cards: 'live' },
    { t: 'start' },
    { t: 'kick', seat: 2 },
    { t: 'rebuy', seat: 1 },
    { t: 'host', seat: 1 },
    { t: 'role', seat: 2, role: 'dealer' },
    { t: 'undo' },
    { t: 'finish' },
  ];
  for (const msg of attempts) {
    await t.send(cast.max, msg);
    assert.equal(t.lastError(cast.max).code, 'NOT_HOST', `${msg.t}: refused, and said so`);
  }
  assert.equal(JSON.stringify(t.room.settings), settings);
  assert.equal(t.room.status, 'lobby');
  assert.equal(t.room.players.length, 4);
  assert.equal(t.room.hostId, '101');
  assert.equal(t.room.players[1].stack, 10000);
});

test('the host can do exactly those things', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.send(cast.ivan, { t: 'settings', smallBlind: 100, bigBlind: 200 });
  assert.equal(t.room.settings.bigBlind, 200);
  await t.send(cast.ivan, { t: 'kick', seat: 3 });
  assert.equal(t.room.players.length, 3);
  await t.send(cast.ivan, { t: 'start' });
  assert.equal(t.room.status, 'playing');
});

test('with a dealer at a real table, only the dealer (or the host) decides who won', async () => {
  const cast = CAST();
  const t = new Table();
  await t.seat(cast);
  await t.send(cast.ivan, { t: 'settings', cards: 'live' });
  await t.send(cast.ivan, { t: 'role', seat: 3, role: 'dealer' }); // Саша deals
  await t.send(cast.ivan, { t: 'start' });
  await t.runToShowdown({ ivan: cast.ivan, max: cast.max, dima: cast.dima });
  assert.equal(t.room.hand.phase, 'showdown');

  const maxSeat = t.room.players.findIndex((p) => p.id === '202');
  await t.send(cast.max, { t: 'pick', pot: 0, seat: maxSeat });
  assert.equal(t.lastError(cast.max).code, 'DEALER_DECIDES', 'Макс cannot award himself');
  assert.deepEqual(t.room.hand.pots[0].winners, []);

  await t.send(cast.sasha, { t: 'pick', pot: 0, seat: maxSeat });
  assert.deepEqual(t.room.hand.pots[0].winners, ['202'], 'the dealer can');
});

/* ------------------------------------------------- one account, one seat */

test('sitting down twice, or from two phones, is still one seat', async () => {
  const t = new Table();
  const ivan = user(101, 'Иван');
  const max = user(202, 'Макс');
  await t.seat({ ivan, max });
  await t.send(max, { t: 'sit' });
  await t.send(max, { t: 'sit' });
  t.open(max); // the same account on a second device
  await t.send(max, { t: 'sit' });
  assert.equal(t.room.players.filter((p) => p.id === '202').length, 1);
  assert.equal(t.room.players.length, 2);
});

test('every refused request gets an answer — a silent refusal reads as a dead app', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const intruder = Object.values(cast).find((u) => String(u.id) !== t.actor());
  const before = t.page(intruder).inbox.filter((m) => m.t === 'error').length;
  await t.act(intruder, 'fold');
  await t.send(intruder, { t: 'no-such-thing' });
  await t.send(intruder, null);
  await t.send(intruder, { t: 'act', action: 'teleport' });
  assert.equal(t.page(intruder).inbox.filter((m) => m.t === 'error').length - before, 4);
  void TEST_TOKEN;
});
