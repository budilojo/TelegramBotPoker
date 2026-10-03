'use strict';
/**
 * Dealer mode: a real deck on a real table. The app keeps the chips, a human
 * says who won — pot by pot, split or not — and chips move only after the
 * review screen is confirmed. The numbers on that screen are the engine's own
 * `previewPayouts`, the same function that then pays.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from './room.js';
import { legalActions, totalPot } from '../server/game.js';

/** Иван hosts; Макс, Дима, Саша play; Лена deals. Real cards. */
function liveRoom({ dealer = true, stacks = null } = {}) {
  const room = R.createRoom({ chatId: -7, host: { id: 1, name: 'Иван' }, startingStack: 10000, smallBlind: 25, bigBlind: 50 });
  for (const [id, name] of [[2, 'Макс'], [3, 'Дима'], [4, 'Саша'], [5, 'Лена']]) R.addPlayer(room, { id, name });
  assert.equal(R.updateSettings(room, '1', { cards: 'live' }).ok, true);
  if (dealer) assert.equal(R.setRole(room, '1', '5', 'dealer').ok, true);
  if (stacks) room.players.forEach((p, i) => { if (stacks[i] != null) { p.stack = stacks[i]; p.stats.buyIn = stacks[i]; } });
  assert.equal(R.startGame(room, '1').ok, true);
  return room;
}

const seat = (room, id) => room.players.findIndex((p) => p.id === String(id));
const chips = (room) => room.players.reduce((s, p) => s + p.stack, 0) + (room.hand.phase === 'complete' ? 0 : totalPot(room));

/** Everyone checks or calls down to the showdown. */
function checkDown(room) {
  let guard = 0;
  while (room.hand.phase === 'betting' && guard++ < 60) {
    const id = room.hand.actorId;
    const l = legalActions(room, id);
    R.act(room, id, l.canCheck ? 'check' : 'call');
  }
}

/** Everyone shoves (or calls a shove they cannot cover). */
function shoveDown(room) {
  let guard = 0;
  while (room.hand.phase === 'betting' && guard++ < 60) R.act(room, room.hand.actorId, 'allin');
}

test('with real cards the bot holds no deck and deals nothing', () => {
  const room = liveRoom();
  assert.equal(room.hand.live, true);
  assert.equal(room.hand.deck, undefined);
  assert.equal(room.hand.holes, undefined, 'the cards are in people\'s hands, not in the bot');
});

test('the dealer is not dealt in and risks no chips', () => {
  const room = liveRoom();
  const lena = R.findPlayer(room, 5);
  assert.equal(lena.inHand, false);
  assert.equal(lena.stack, 10000);
  assert.equal(room.players.filter((p) => p.inHand).length, 4);
});

test('the showdown waits for a human and opens on the first pot', () => {
  const room = liveRoom();
  checkDown(room);
  assert.equal(room.hand.phase, 'showdown');
  // Nobody has been paid: every chip a player put in is still in the pot.
  for (const p of room.players) {
    assert.equal(p.stack + p.committed, room.hand.startStacks[p.id], `${p.name} was paid before anyone decided`);
  }
  assert.equal(totalPot(room), 200);
  assert.deepEqual(room.ui.winner, { potIndex: 0, review: false });
});

test('only the dealer — or the host, as a fallback — may decide; a player may not', () => {
  const room = liveRoom();
  checkDown(room);
  assert.equal(R.toggleWinner(room, '2', 0, seat(room, 2)).error, 'DEALER_DECIDES', 'Макс cannot award himself');
  assert.equal(R.toggleWinner(room, '999', 0, seat(room, 2)).error, 'DEALER_DECIDES', 'nor can a stranger');
  assert.equal(R.toggleWinner(room, '5', 0, seat(room, 2)).ok, true, 'the dealer can');
  assert.equal(R.toggleWinner(room, '1', 0, seat(room, 3)).ok, true, 'the host can too');
});

test('with no dealer, anyone seated decides — but not a stranger', () => {
  const room = liveRoom({ dealer: false });
  checkDown(room);
  assert.equal(R.toggleWinner(room, '999', 0, seat(room, 2)).error, 'DEALER_DECIDES');
  assert.equal(R.toggleWinner(room, '3', 0, seat(room, 2)).ok, true);
});

test('a folded player can never be picked', () => {
  const room = liveRoom();
  const folder = room.hand.actorId;
  R.act(room, folder, 'fold');
  checkDown(room);
  assert.equal(R.toggleWinner(room, '5', 0, seat(room, folder)).error, 'NOT_ELIGIBLE');
});

test('side pots are decided one by one, the review shows the engine\'s own split, chips move on confirm', () => {
  // Иван 1 000, Макс 3 000, Дима and Саша 10 000: main pot + two side pots.
  const room = liveRoom({ stacks: [1000, 3000, 10000, 10000] });
  const TOTAL = 1000 + 3000 + 10000 + 10000;
  shoveDown(room);
  assert.equal(room.hand.phase, 'showdown');
  assert.deepEqual(room.hand.pots.map((p) => p.amount), [4000, 6000, 14000]);

  // Main pot → Иван; side 1 → Макс; side 2 → Дима.
  const picks = [1, 2, 3];
  for (const id of picks) {
    assert.equal(R.toggleWinner(room, '5', room.ui.winner.potIndex, seat(room, id)).ok, true);
    assert.equal(R.winnerNext(room, '5').ok, true);
  }
  assert.equal(room.ui.winner.review, true);

  const promised = R.preview(room);
  const before = new Map(room.players.map((p) => [p.id, p.stack]));
  assert.equal(R.confirmWinners(room, '5', room.seq).ok, true);
  for (const row of promised) {
    const got = R.findPlayer(room, row.playerId).stack - before.get(row.playerId);
    assert.equal(got, row.amount, `${row.name}: the review said ${row.amount}, got ${got}`);
  }
  assert.equal(room.players.reduce((s, p) => s + p.stack, 0) - 10000, TOTAL, 'chips conserved (the dealer keeps 10 000)');
  assert.equal(room.hand.phase, 'complete');
});

test('a pot with one claimant is a refund — never a question for the dealer', () => {
  const room = liveRoom({ stacks: [1000, 10000, 10000, 20000] });
  shoveDown(room);
  const solo = room.hand.pots.findIndex((p) => p.eligible.length === 1);
  assert.ok(solo >= 0, 'the deepest stack over-shoved');
  assert.ok(!R.openPots(room).includes(solo), 'it is not one of the steps');
  assert.equal(R.toggleWinner(room, '5', solo, seat(room, 4)).error, 'BAD_POT');
});

test('a split pot: two winners share it, and the odd chip goes to one of them', () => {
  const room = liveRoom();
  checkDown(room); // 4 × 50 = 200
  room.hand.pots[0].amount += 1; // make it odd, the way uneven blinds would
  for (const p of room.players) if (p.id === '2') p.committed += 1;
  R.toggleWinner(room, '5', 0, seat(room, 2));
  R.toggleWinner(room, '5', 0, seat(room, 3));
  R.winnerNext(room, '5');
  const promised = R.preview(room).map((x) => x.amount).sort();
  assert.deepEqual(promised, [100, 101]);
});

test('no winner, no next step; nothing moves before the confirm', () => {
  const room = liveRoom();
  checkDown(room);
  assert.equal(R.winnerNext(room, '5').error, 'NO_WINNER_SELECTED');
  R.toggleWinner(room, '5', 0, seat(room, 2));
  assert.equal(R.confirmWinners(room, '5', room.seq).error, 'BAD_STEP', 'not before the review screen');
  assert.equal(room.hand.phase, 'showdown');
});

test('a double tap on confirm pays out once', () => {
  const room = liveRoom();
  checkDown(room);
  R.toggleWinner(room, '5', 0, seat(room, 2));
  R.winnerNext(room, '5');
  const seq = room.seq;
  assert.equal(R.confirmWinners(room, '5', seq).ok, true);
  const after = R.findPlayer(room, 2).stack;
  assert.ok(R.confirmWinners(room, '5', seq).error);
  assert.equal(R.findPlayer(room, 2).stack, after);
});

test('a mis-tapped result can be undone until the next deal', () => {
  const room = liveRoom();
  checkDown(room);
  const before = room.players.map((p) => p.stack);
  R.toggleWinner(room, '5', 0, seat(room, 2));
  R.winnerNext(room, '5');
  R.confirmWinners(room, '5', room.seq);
  assert.notDeepEqual(room.players.map((p) => p.stack), before);

  assert.equal(R.undo(room, '1').ok, true);
  assert.deepEqual(room.players.map((p) => p.stack), before, 'every stack restored');
  assert.equal(room.hand.phase, 'showdown');
  assert.equal(room.ui.winner.review, true, 'and the decision is back on screen');
});

test('with real cards the dealer paces the next hand, not the players', () => {
  const room = liveRoom();
  checkDown(room);
  R.toggleWinner(room, '5', 0, seat(room, 2));
  R.winnerNext(room, '5');
  R.confirmWinners(room, '5', room.seq);
  assert.equal(R.nextHand(room, '3').error, 'DEALER_DEALS', 'the cards are not shuffled yet');
  assert.equal(R.nextHand(room, '5').ok, true);
});

test('real cards never deal themselves, even with the turn timer on', () => {
  const room = liveRoom();
  room.settings.turnSeconds = 60;
  checkDown(room);
  R.toggleWinner(room, '5', 0, seat(room, 2));
  R.winnerNext(room, '5');
  R.confirmWinners(room, '5', room.seq);
  assert.equal(R.syncAutoNext(room, Date.now()), null);
});

test('a dealer exists only with real cards; switching back returns them to a seat', () => {
  const room = R.createRoom({ chatId: -8, host: { id: 1, name: 'Иван' } });
  R.addPlayer(room, { id: 2, name: 'Макс' });
  assert.equal(R.setRole(room, '1', '2', 'dealer').error, 'NOT_LIVE', 'the bot deals — nobody else to');
  R.updateSettings(room, '1', { cards: 'live' });
  assert.equal(R.setRole(room, '1', '2', 'dealer').ok, true);
  assert.equal(R.setRole(room, '2', '1', 'dealer').error, 'NOT_HOST', 'only the host hands out roles');
  R.updateSettings(room, '1', { cards: 'virtual' });
  assert.equal(R.roleOf(R.findPlayer(room, 2)), 'player');
});

test('the mode cannot flip in the middle of a hand', () => {
  const room = R.createRoom({ chatId: -9, host: { id: 1, name: 'Иван' } });
  R.addPlayer(room, { id: 2, name: 'Макс' });
  R.startGame(room, '1');
  assert.equal(R.updateSettings(room, '1', { cards: 'live' }).error, 'HAND_IN_PROGRESS');
});

test('the table seats eight — a ninth is refused, a dealer does not take a seat', () => {
  const room = R.createRoom({ chatId: -10, host: { id: 1, name: 'Игрок 1' } });
  for (let i = 2; i <= 8; i++) R.addPlayer(room, { id: i, name: `Игрок ${i}` });
  assert.equal(R.addPlayer(room, { id: 9, name: 'Лишний' }).error, 'TABLE_FULL');
  R.updateSettings(room, '1', { cards: 'live' });
  R.setRole(room, '1', '8', 'dealer');
  assert.ok(!R.addPlayer(room, { id: 9, name: 'Теперь влез' }).error, 'the dealer\'s chair freed a seat');
});

test('chips are conserved through many live hands decided by the dealer', () => {
  const room = liveRoom({ stacks: [2000, 3000, 4000, 5000] });
  const TOTAL = 2000 + 3000 + 4000 + 5000 + 10000;
  let hands = 0;
  for (let n = 0; n < 30 && room.status !== 'finished'; n++) {
    if (n % 3 === 0) shoveDown(room);
    else checkDown(room);
    // The dealer gives each pot to its first claimant.
    let guard = 0;
    while (room.hand.phase === 'showdown' && !room.ui.winner.review && guard++ < 10) {
      const pot = room.hand.pots[room.ui.winner.potIndex];
      R.toggleWinner(room, '5', room.ui.winner.potIndex, seat(room, pot.eligible[n % pot.eligible.length]));
      R.winnerNext(room, '5');
    }
    if (room.hand.phase === 'showdown') R.confirmWinners(room, '5', room.seq);
    assert.equal(room.hand.phase, 'complete');
    assert.equal(room.players.reduce((s, p) => s + p.stack, 0), TOTAL, `hand ${n + 1}`);
    hands++;
    if (room.status === 'finished') break;
    const r = R.nextHand(room, '5');
    if (r.finished) break;
    assert.ok(r.ok, r.error);
  }
  assert.ok(hands >= 5);
  void chips;
});
