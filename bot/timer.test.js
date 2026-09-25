'use strict';
/**
 * Everything that happens because TIME passes: the turn timer, the table
 * dealing itself, the all-in board turned over street by street. And the
 * showdown rule that decides whose cards are shown.
 *
 * Time here is a fake clock that moves only when a test says so, so every
 * "59 seconds — not yet, 60 — now" is exact, and nothing sleeps.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, stack, FakeClock, TEST_TOKEN, initDataFor } from './harness.js';
import { App } from './app.js';
import { Hub } from './hub.js';
import { Store } from './store.js';
import { cardCode } from './view.js';
import * as R from './room.js';

const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });
const SEC = 1000;
const player = (t, u) => t.room.players.find((p) => p.id === String(u.id));

/** Seat everybody, switch the timer on in the lobby, deal. */
async function timed(cast, { secs = 60, deck = null, runoutStepMs = 0, store } = {}) {
  const t = new Table({ runoutStepMs, store });
  await t.seat(cast, { blinds: [25, 50] });
  await t.send(cast.ivan, { t: 'settings', turnSeconds: secs });
  if (deck) t.useDeck(deck);
  await t.send(cast.ivan, { t: 'start' });
  return t;
}

/** Everyone except `afk` checks or calls; `afk` just lets the clock run. */
async function playAround(t, cast, afk, secs = 60) {
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 60) {
    const who = t.actorOf(cast);
    if (who === afk) await t.advance(secs * SEC);
    else await t.act(who, t.state(who).legal.canCheck ? 'check' : 'call');
  }
}

/* ----------------------------------------------------------- the timer */

test('there is no turn timer unless the host switches it on', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  const actor = t.actor();
  await t.advance(3600 * SEC);
  assert.equal(t.actor(), actor, 'an hour later the same player is still thinking');
  assert.equal(t.clock.pending(), 0, 'and no timer is even armed');
  assert.equal(t.state(cast.ivan).hand.deadline, null);
});

test('only the host sets the timer, and only within 15–600 seconds', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  await t.send(cast.max, { t: 'settings', turnSeconds: 30 });
  assert.equal(t.lastError(cast.max).code, 'NOT_HOST');
  assert.equal(t.room.settings.turnSeconds, 0);

  await t.send(cast.ivan, { t: 'settings', turnSeconds: 5 });
  assert.equal(t.room.settings.turnSeconds, 15, 'too short is raised to the minimum, not taken');
  await t.send(cast.ivan, { t: 'settings', turnSeconds: 60 });
  assert.equal(t.room.settings.turnSeconds, 60);
  assert.match(t.text(), /⏱ 60 с на ход/, 'the group card says what the table agreed to');
  await t.send(cast.ivan, { t: 'settings', turnSeconds: 0 });
  assert.equal(t.room.settings.turnSeconds, 0);
});

test('when the clock runs out: a free check is a check, a bet is a fold — never a chip put in', async () => {
  const cast = THREE();
  const t = await timed(cast);
  assert.equal(t.actor(), '101');
  const deadline = t.state(cast.ivan).hand.deadline;
  assert.equal(deadline, t.clock.now() + 60 * SEC, 'every phone knows the exact deadline');

  await t.advance(59 * SEC);
  assert.equal(t.actor(), '101', 'one second left — nothing yet');
  await t.advance(1 * SEC);
  assert.equal(player(t, cast.ivan).folded, true, 'facing a bet, the timer folds');
  assert.equal(player(t, cast.ivan).stack, 10000, 'and puts in nothing');
  assert.ok(t.page(cast.max).inbox.some((m) => m.t === 'state' && /Иван: время вышло — фолд/.test(m.state.room.notice || '')));

  await t.act(cast.max, 'call');
  assert.equal(t.actor(), '303');
  const before = player(t, cast.dima).stack;
  await t.advance(60 * SEC);
  assert.equal(player(t, cast.dima).folded, false, 'with a free check the timer checks, it does not fold');
  assert.equal(player(t, cast.dima).stack, before);
  assert.equal(t.room.hand.street, 'flop');
});

test('a move in time disarms the clock, and the next player gets their own full minute', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.advance(59 * SEC);
  await t.act(cast.ivan, 'call');
  assert.equal(t.actor(), '202');
  await t.advance(59 * SEC);
  assert.equal(t.actor(), '202', 'Макс has not had a minute yet');
  assert.equal(player(t, cast.ivan).folded, false, 'the timer did not fire for Иван after he moved');
  await t.advance(1 * SEC);
  assert.equal(player(t, cast.max).folded, true);
});

test('the same player on the clock twice in a row gets a fresh clock each time', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = await timed(cast);
  await t.act(cast.ivan, 'call');
  assert.equal(t.actor(), '202');
  await t.advance(50 * SEC);
  await t.act(cast.max, 'check');
  assert.equal(t.room.hand.street, 'flop');
  assert.equal(t.actor(), '202');
  await t.advance(50 * SEC);
  assert.equal(t.actor(), '202', 'a new street, a new minute');
  await t.advance(10 * SEC);
  assert.notEqual(t.actor(), '202');
});

test('a timer for a turn that is already over does nothing, even if it fires late', () => {
  const room = R.createRoom({ chatId: -5, host: { id: 1, name: 'Иван' } });
  R.addPlayer(room, { id: 2, name: 'Макс' });
  R.addPlayer(room, { id: 3, name: 'Дима' });
  room.settings.turnSeconds = 60;
  R.startGame(room, 1);
  const t0 = 1_000_000;
  const key = R.syncTurn(room, t0).key;
  R.act(room, room.hand.actorId, 'call');
  const stacks = room.players.map((p) => p.stack);
  assert.equal(R.timeoutMove(room, key, t0 + 3600 * SEC).error, 'STALE');
  assert.deepEqual(room.players.map((p) => p.stack), stacks);
  const cur = R.syncTurn(room, t0 + 1);
  assert.equal(R.timeoutMove(room, cur.key, cur.deadline - 1).error, 'EARLY');
});

test('two timeouts in a row sit a player out; sitting down again brings them back', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await playAround(t, cast, cast.ivan);
  assert.equal(player(t, cast.ivan).timeouts, 1);
  assert.equal(player(t, cast.ivan).sittingOut, false, 'once is not a pattern');

  await t.advance(10 * SEC);
  assert.equal(t.room.handNo, 2);
  await playAround(t, cast, cast.ivan);
  assert.equal(player(t, cast.ivan).sittingOut, true, 'twice in a row — sat out');
  assert.equal(t.state(cast.ivan).players.find((p) => p.isMe).status === 'out' || t.state(cast.ivan).me.sittingOut, true);

  await t.advance(10 * SEC);
  assert.equal(t.room.handNo, 3);
  assert.equal(player(t, cast.ivan).inHand, false, 'not dealt in while away');
  assert.deepEqual(t.state(cast.ivan).me.cards, [], 'and no cards for an empty chair');

  await t.send(cast.ivan, { t: 'sit' });
  assert.equal(player(t, cast.ivan).sittingOut, false);
  assert.equal(player(t, cast.ivan).timeouts, 0);
});

test('a pause stops the clock; resuming carries on with the time that was left', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.advance(40 * SEC);
  await t.send(cast.ivan, { t: 'pause' });
  await t.advance(600 * SEC);
  assert.equal(t.actor(), '101', 'a smoke break costs nobody their turn');
  await t.send(cast.ivan, { t: 'resume' });
  await t.advance(19 * SEC);
  assert.equal(player(t, cast.ivan).folded, false, '20 seconds were left, 19 have passed');
  await t.advance(1 * SEC);
  assert.equal(player(t, cast.ivan).folded, true);
});

test('a restart does not bill anybody for the time the bot was down', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = await timed(cast, { store });
  await t.advance(40 * SEC);
  await t.send(cast.ivan, { t: 'settings', smallBlind: 100, bigBlind: 200 }); // any redraw saves: 20 s left

  const clock2 = new FakeClock(t.clock.now() + 600 * SEC);
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock: clock2, runoutStepMs: 0 });
  app2.attachHub(new Hub(app2, { botToken: TEST_TOKEN }));
  app2.load();
  await app2.resume();
  const room2 = app2.room(t.chatId);
  assert.equal(room2.hand.actorId, '101', 'nobody was timed out on waking up');
  await clock2.advance(19 * SEC);
  await app2.settle();
  assert.equal(room2.players[0].folded, false);
  await clock2.advance(1 * SEC);
  await app2.settle();
  assert.equal(room2.players[0].folded, true, 'the 20 seconds that were left, and not a second less');
  store.close();
});

/* ------------------------------------------------- the table deals itself */

test('with the timer on, the next hand is dealt 10 s after the last — cards and all', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.runToShowdown(cast);
  assert.equal(t.room.hand.phase, 'complete');
  assert.equal(t.state(cast.max).autoNextAt, t.clock.now() + 10 * SEC, 'the phones count down to it');
  await t.advance(9999);
  assert.equal(t.room.handNo, 1);
  await t.advance(1);
  assert.equal(t.room.handNo, 2);
  for (const u of Object.values(cast)) {
    assert.equal(t.state(u).hand.no, 2);
    assert.equal(t.state(u).me.cards.length, 2, `${u.first_name} has the new cards on screen`);
  }
});

test('without the timer, the table waits for a person to deal', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  await t.runToShowdown(cast);
  await t.advance(3600 * SEC);
  assert.equal(t.room.handNo, 1);
  assert.equal(t.state(cast.max).canNext, true, 'anyone at the table can deal it');
});

test('dealing by hand before the countdown cancels it — never two hands', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.runToShowdown(cast);
  await t.advance(5 * SEC);
  await t.send(cast.max, { t: 'next' });
  assert.equal(t.room.handNo, 2);
  await t.advance(10 * SEC);
  assert.equal(t.room.handNo, 2, 'the old countdown did not deal a third hand');
});

test('a hand nobody played themselves pauses the table instead of dealing into an empty room', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.advance(60 * SEC); // Иван
  await t.advance(60 * SEC); // Макс — Дима wins the blinds, nobody touched a thing
  assert.equal(t.room.hand.phase, 'complete');
  assert.equal(t.room.status, 'paused');
  await t.advance(3600 * SEC);
  assert.equal(t.room.handNo, 1, 'an hour later, still no new hand');
  await t.send(cast.ivan, { t: 'resume' });
  await t.advance(10 * SEC);
  assert.equal(t.room.handNo, 2, 'back to normal once the host says so');
});

test('with fewer than two players left, the automatic deal stops instead of retrying forever', async () => {
  const cast = THREE();
  const t = await timed(cast);
  await t.runToShowdown(cast);
  await t.send(cast.max, { t: 'leave' });
  await t.send(cast.dima, { t: 'leave' });
  await t.advance(10 * SEC);
  assert.equal(t.room.handNo, 1);
  assert.match(t.room.notice, /Автораздача остановлена/);
  const calls = t.tg.calls.length;
  const sent = t.page(cast.ivan).inbox.length;
  await t.advance(3600 * SEC);
  assert.equal(t.tg.calls.length, calls, 'no retry every ten seconds — not in the group…');
  assert.equal(t.page(cast.ivan).inbox.length, sent, '…and not on the phones');
  await t.send(cast.max, { t: 'sit' });
  await t.send(cast.max, { t: 'next' });
  assert.equal(t.room.handNo, 2);
});

/* ------------------------------------------------- who shows at showdown */

test('an all-in loser is shown; a loser who is not all-in mucks', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  player(t, cast.ivan).stack = 1000;
  player(t, cast.ivan).stats.buyIn = 1000;
  t.useDeck(stack({ 101: 'Kd Kc', 202: 'As Ah', 303: 'Qh Qd' }, '2s 7h 9d Jc 3s'));
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'allin');
  await t.act(cast.max, 'call');
  await t.act(cast.dima, 'call');
  await t.runToShowdown(cast);

  const st = t.state(cast.max);
  const row = (name) => st.players.find((p) => p.name === name);
  assert.deepEqual(st.hand.result.winners, [{ seat: 1, amount: 3000, hand: 'Пара A', best: ['AS', 'AH', '7H', '9D', 'JC'] }]);
  assert.deepEqual(row('Иван').cards, ['KD', 'KC'], 'all-in: the hand is tabled, win or lose');
  assert.equal(row('Дима').cards, null);
  assert.equal(row('Дима').mucked, true);
  for (const c of t.hole(cast.dima)) assert.ok(!t.received(cast.ivan).includes(`"${cardCode(c)}"`), 'Дима mucked unseen');
});

test('a split pot shows both winners', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({}, 'As Ks Qs Js 10s'));
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'call');
  await t.act(cast.max, 'fold');
  await t.runToShowdown(cast);
  assert.deepEqual(Object.keys(t.room.hand.shown).sort(), ['101', '303']);
  assert.equal(t.state(cast.max).hand.result.winners.length, 2);
});

test('chips nobody called come back as a refund, not as a won pot', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  player(t, cast.ivan).stack = 300;
  player(t, cast.ivan).stats.buyIn = 300;
  t.useDeck(stack({ 101: 'As Ah', 202: '7c 2d', 303: '9c 8c' }, 'Kd Qh 4s 5d Jc'));
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'allin');
  await t.act(cast.max, 'raise', 2000);
  await t.act(cast.dima, 'fold');

  const r = t.state(cast.dima).hand.result;
  assert.deepEqual(r.winners, [{ seat: 0, amount: 650, hand: 'Пара A', best: ['AS', 'AH', 'KD', 'QH', 'JC'] }]);
  assert.deepEqual(r.refunds, [{ seat: 1, amount: 1700 }], 'getting your own chips back is not a win');
  // Heads-up against an all-in, nobody is left to bet: both hands are opened.
  assert.equal(t.state(cast.dima).players[1].mucked, false);
  assert.deepEqual(t.state(cast.dima).players[1].cards, ['7C', '2D']);
});

/* ------------------------------------------- the all-in board, one street at a time */

async function allInPreflop(cast, opts = {}) {
  const t = new Table({ runoutStepMs: 1500, ...opts });
  await t.seat(cast, { blinds: [25, 50] });
  if (opts.timer) await t.send(cast.ivan, { t: 'settings', turnSeconds: opts.timer });
  player(t, cast.ivan).stack = 2000; // a short stack, so the game goes on after
  player(t, cast.ivan).stats.buyIn = 2000;
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc', 303: '7c 2d' }, 'Qs 9h 4d 3c 8s'));
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'allin');
  await t.act(cast.max, 'call');
  const started = Date.now();
  await t.act(cast.dima, 'fold'); // ends the betting: the reveal starts here
  return { t, took: Date.now() - started };
}

test('an all-in board is run out street by street; hands, stacks and result come with the river', async () => {
  const cast = THREE();
  const { t, took } = await allInPreflop(cast);
  const [q, n9, n4, n3, n8] = t.room.hand.board.map(cardCode);
  const st = () => t.state(cast.dima);

  assert.ok(took < 1000, `handling the move must not sleep through the reveal (${took} ms)`);
  assert.equal(st().hand.revealing, true);
  assert.deepEqual(st().hand.board, [], 'nothing out yet');
  assert.equal(st().players[0].cards, null, 'the hands stay face down while the board runs out');
  assert.equal(st().players[1].cards, null);
  assert.deepEqual(t.state(cast.ivan).me.cards, ['AS', 'AH'], 'your own two cards you always see');
  assert.equal(t.state(cast.ivan).players[1].cards, null, 'but not the other all-in hand');
  assert.equal(st().hand.result, null, 'no result before the board is out');
  assert.equal(st().players[0].stack, 0, 'and no stack gives the river away');
  assert.equal(st().players[1].stack, 8000);
  assert.equal(st().canNext, false, 'and no "next hand" to skip past it');

  await t.advance(1500);
  assert.deepEqual(st().hand.board, [q, n9, n4], 'the flop');
  await t.advance(1500);
  assert.deepEqual(st().hand.board, [q, n9, n4, n3], 'the turn');
  assert.equal(st().players[1].cards, null, 'turn: still face down');
  await t.advance(1500);
  assert.deepEqual(st().hand.board, [q, n9, n4, n3, n8], 'the river — with the result');
  assert.equal(st().hand.revealing, false);
  assert.deepEqual(st().players[0].cards, ['AS', 'AH'], 'now the hands turn over');
  assert.deepEqual(st().players[1].cards, ['KD', 'KC']);
  const win = st().hand.result.winners[0];
  assert.equal(win.seat, 0);
  assert.equal(st().players[0].stack, 4050);

  // The winning five: the two aces and the three best board cards — all already face up.
  assert.equal(win.best.length, 5);
  assert.ok(win.best.includes('AS') && win.best.includes('AH'));
  for (const c of win.best) assert.ok(['AS', 'AH', q, n9, n4, n3, n8].includes(c), `${c} is on the table`);
  assert.deepEqual([...win.best].sort(), ['AH', 'AS', q, n9, n8].sort(), 'aces with Q, 9, 8 kickers');

  // Nothing ever reached a phone ahead of the table.
  const states = t.page(cast.dima).inbox.filter((m) => m.t === 'state').map((m) => JSON.stringify(m.state));
  const firstRiver = states.findIndex((x) => x.includes(`"${n8}"`));
  const firstResult = states.findIndex((x) => x.includes('"winners"'));
  const firstAce = states.findIndex((x) => x.includes('"AS"'));
  const firstKing = states.findIndex((x) => x.includes('"KD"'));
  assert.equal(firstRiver, firstResult, 'the river and the result arrive in the same state');
  assert.equal(firstAce, firstRiver, 'and the hands with them, not before');
  assert.equal(firstKing, firstRiver);
  const ivanStates = t.page(cast.ivan).inbox.filter((m) => m.t === 'state').map((m) => JSON.stringify(m.state));
  assert.equal(ivanStates.findIndex((x) => x.includes('"KD"')), ivanStates.findIndex((x) => x.includes(`"${n8}"`)),
    'the other all-in player sees the kings only with the river too');
});

test('while the board turns over, your own hand name does not run ahead of the table', async () => {
  const cast = THREE();
  const { t } = await allInPreflop(cast);
  await t.advance(1500); // the flop is out
  const st = t.state(cast.max);
  assert.deepEqual(st.me.cards, ['KD', 'KC']);
  assert.equal(st.me.handName, 'Пара K', 'judged on the flop, not on the river nobody has seen');
});

test('the automatic deal waits for the board to finish turning over', async () => {
  const cast = THREE();
  const { t } = await allInPreflop(cast, { timer: 60 });
  await t.advance(4500);
  assert.equal(t.state(cast.max).hand.revealing, false);
  await t.advance(9999);
  assert.equal(t.room.handNo, 1, 'ten seconds from the river, not from the all-in');
  await t.advance(1);
  assert.equal(t.room.handNo, 2);
});

test('a restart in the middle of the reveal shows the finished hand', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const { t } = await allInPreflop(cast, { store });
  await t.advance(1500);
  const clock = new FakeClock();
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock, runoutStepMs: 1500 });
  const hub2 = new Hub(app2, { botToken: TEST_TOKEN });
  app2.attachHub(hub2);
  app2.load();
  await app2.resume();
  const inbox = [];
  hub2.open({ initData: initDataFor(cast.max, { startParam: app2.room(t.chatId).code, clock }) }, (m) => inbox.push(m));
  const st = inbox.at(-1).state;
  assert.equal(st.hand.revealing, false);
  assert.equal(st.hand.board.length, 5);
  assert.ok(st.hand.result);
  store.close();
});

test('/finish during the reveal ends on the whole board, and the reveal stays stopped', async () => {
  const cast = THREE();
  const { t } = await allInPreflop(cast);
  await t.send(cast.ivan, { t: 'finish' });
  assert.equal(t.state(cast.max).room.status, 'finished');
  assert.match(t.lastPost(), /ИТОГИ/);
  const calls = t.tg.calls.length;
  const sent = t.page(cast.max).inbox.length;
  await t.advance(10 * SEC);
  assert.equal(t.tg.calls.length, calls, 'the stopped reveal does not wake up and edit anything');
  assert.equal(t.page(cast.max).inbox.length, sent);
});

test('the all-in that ends the game: first the board, then the results', async () => {
  const cast = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table({ runoutStepMs: 1500 });
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc' }, 'Qs 9h 4d 3c 8s'));
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'allin');
  await t.act(cast.max, 'call');
  assert.equal(t.room.status, 'finished');
  assert.doesNotMatch(t.lastPost(), /ИТОГИ/, 'not while the cards are still coming');
  await t.advance(4500);
  assert.match(t.lastPost(), /ИТОГИ/);
  assert.equal(t.state(cast.max).results[0].name, 'Иван');
});
