'use strict';
/**
 * The game against the official rules, one rule per test, played through the
 * Mini App exactly as people play it.
 *
 * Sources: the Poker TDA Rules (2024) — the rules the big tournaments are
 * judged by — and Robert's Rules of Poker for what TDA leaves to the house
 * (dealing, burning, table stakes). Rules are named by their titles.
 *
 * Where the two allow a choice, the choice is written down here: the button
 * MOVES (Robert's Rules, "moving button" — the usual home-game method); TDA
 * tournaments use a dead button instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, stack } from './harness.js';
import { best5, compare } from './eval.js';
import { parseHand } from './deck.js';
import { cardCode } from './view.js';

const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });
const FOUR = () => ({ ...THREE(), sasha: user(404, 'Саша') });
const byId = (t, id) => t.room.players.find((p) => p.id === String(id));
const whoIs = (cast, id) => Object.values(cast).find((u) => String(u.id) === String(id));
/** 0..51 in order: whoever gets card k is plain to see. */
const identity = () => [...Array(52).keys()];

/* ------------------------------------------------------------- dealing */

test('Robert\'s Rules: one card at a time, starting left of the button, two rounds', async () => {
  const cast = THREE();
  const t = new Table();
  t.useDeck(identity);
  await t.begin(cast);
  const h = t.room.hand;
  // Button Иван, small blind Макс, big blind Дима.
  assert.deepEqual(h.holes[h.sbId], [0, 3], 'the small blind gets the first card');
  assert.deepEqual(h.holes[h.bbId], [1, 4]);
  assert.deepEqual(h.holes[h.dealerId], [2, 5], 'the button gets the last');
});

test('TDA, Button in Heads-up: the last card is dealt to the button', async () => {
  const duo = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  t.useDeck(identity);
  await t.begin(duo);
  const h = t.room.hand;
  assert.equal(h.dealerId, h.sbId, 'heads-up, the button is the small blind');
  assert.deepEqual(h.holes[h.bbId], [0, 2]);
  assert.deepEqual(h.holes[h.dealerId], [1, 3]);
});

test('Robert\'s Rules, burn and turn: a card is burnt before the flop, the turn and the river — and nobody ever sees it', async () => {
  const cast = THREE();
  const t = new Table();
  t.useDeck(identity);
  await t.begin(cast);
  await t.runToShowdown(cast);
  // Six hole cards (0..5); burn 6, flop 7 8 9; burn 10, turn 11; burn 12, river 13.
  assert.deepEqual(t.room.hand.board, [7, 8, 9, 11, 13]);
  for (const burnt of [6, 10, 12]) {
    const code = cardCode(burnt);
    for (const u of Object.values(cast)) assert.ok(!t.received(u).includes(`"${code}"`), `${code} was burnt, and stays unseen`);
  }
});

/* ------------------------------------------------------ blinds and order */

test('blinds left of the button; pre-flop the first to act is left of the big blind, after the flop left of the button', async () => {
  const cast = FOUR();
  const t = new Table();
  await t.begin(cast);
  const h = t.room.hand;
  assert.equal(h.dealerId, '101');
  assert.equal(h.sbId, '202');
  assert.equal(h.bbId, '303');
  assert.equal(t.actor(), '404', 'under the gun: left of the big blind');
  for (const u of [cast.sasha, cast.ivan, cast.max]) await t.act(u, 'call');
  await t.act(cast.dima, 'check');
  assert.equal(t.room.hand.street, 'flop');
  assert.equal(t.actor(), '202', 'after the flop: the first player left of the button');
});

test('TDA, Button in Heads-up: the button posts the small blind, acts first before the flop and last after it', async () => {
  const duo = { ivan: user(101, 'Иван'), max: user(202, 'Макс') };
  const t = new Table();
  await t.begin(duo);
  const h = t.room.hand;
  assert.equal(h.sbId, h.dealerId);
  assert.equal(t.actor(), h.dealerId, 'the button acts first pre-flop');
  await t.act(whoIs(duo, h.dealerId), 'call');
  await t.act(whoIs(duo, h.bbId), 'check');
  assert.equal(t.room.hand.street, 'flop');
  assert.equal(t.actor(), h.bbId, 'and the big blind first after the flop');
});

test('TDA, Button in Heads-up: going down to two, nobody takes the big blind twice in a row', async () => {
  const cast = THREE();
  const t = new Table();
  // The button gets the worst hand and busts; the blinds play on heads-up.
  t.useDeck((room) => stack({ [room.hand.dealerId]: '7c 2d', [room.hand.sbId]: 'As Ah', [room.hand.bbId]: 'Kd Kc' }, 'Qs Jh 4d 3c 8s')(room));
  await t.begin(cast);
  const first = { button: t.room.hand.dealerId, sb: t.room.hand.sbId, bb: t.room.hand.bbId };
  await t.act(whoIs(cast, first.button), 'allin');
  await t.act(whoIs(cast, first.sb), 'call');
  await t.act(whoIs(cast, first.bb), 'fold');
  assert.equal(byId(t, first.button).stack, 0, 'the button is out');

  await t.send(whoIs(cast, first.sb), { t: 'next' });
  const h = t.room.hand;
  assert.notEqual(h.bbId, first.bb, 'last hand\'s big blind is not the big blind again');
  assert.equal(h.bbId, first.sb);
  assert.equal(h.dealerId, first.bb, 'they get the button — and the small blind — instead');
});

/* ------------------------------------------------------------ betting */

test('no-limit: the smallest bet is the big blind; a raise is at least the last full bet or raise', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast, { blinds: [50, 100] });
  assert.equal(t.state(cast.ivan).legal.minTotal, 200, 'facing the big blind: raise to 200 at least');
  await t.act(cast.ivan, 'raise', 300); // a raise of 200
  assert.equal(t.state(cast.max).legal.minTotal, 500, 'the next raise is at least another 200');
  await t.act(cast.max, 'raise', 750); // a raise of 450
  assert.equal(t.state(cast.dima).legal.minTotal, 1200, 'and now at least another 450');
  await t.act(cast.dima, 'raise', 1150);
  assert.equal(t.lastError(cast.dima).code, 'BELOW_MIN_RAISE', 'less is refused');
  await t.act(cast.dima, 'call');
  await t.act(cast.ivan, 'call');
  assert.equal(t.room.hand.street, 'flop');
  assert.equal(t.state(whoIs(cast, t.actor())).legal.minTotal, 100, 'a new street: the smallest bet is the big blind again');
});

test('the big blind\'s option: when everybody just calls, the big blind may still raise', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast, { blinds: [50, 100] });
  await t.act(cast.ivan, 'call');
  await t.act(cast.max, 'call');
  assert.equal(t.actor(), '303', 'the betting is not over: the big blind has not acted');
  const l = t.state(cast.dima).legal;
  assert.equal(l.canCheck, true);
  assert.equal(l.canRaise, true);
});

/** Blinds 50/100, four players; Макс and Дима short, so their all-ins fall short of a full raise. */
async function shortAllIns() {
  const cast = FOUR();
  const t = new Table();
  await t.seat(cast, { blinds: [50, 100] });
  byId(t, 202).stack = 400; byId(t, 202).stats.buyIn = 400; // Макс, small blind
  byId(t, 303).stack = 550; byId(t, 303).stats.buyIn = 550; // Дима, big blind
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.sasha, 'raise', 300); // a full raise of 200
  await t.act(cast.ivan, 'call');
  await t.act(cast.max, 'allin'); // to 400: only 100 more — short of a full raise
  return { t, cast };
}

test('TDA, Re-Opening the Bet: one short all-in does not re-open the betting for those who already acted', async () => {
  const { t, cast } = await shortAllIns();
  await t.act(cast.dima, 'fold');
  assert.equal(t.actor(), '404');
  const l = t.state(cast.sasha).legal;
  assert.equal(l.toCall, 100, 'Саша faces 100 more — less than a full raise (200)');
  assert.equal(l.canRaise, false);
  await t.act(cast.sasha, 'raise', 1000);
  assert.ok(t.lastError(cast.sasha).code, 'a raise is refused');
  await t.act(cast.sasha, 'allin');
  assert.equal(t.lastError(cast.sasha).code, 'CANNOT_RAISE', 'so is a shove');
});

test('TDA, Re-Opening the Bet: short all-ins that add up to a full raise re-open it', async () => {
  const { t, cast } = await shortAllIns();
  await t.act(cast.dima, 'allin'); // to 550: 150 more — also short, but 250 in all over Саша's 300
  assert.equal(t.actor(), '404');
  const l = t.state(cast.sasha).legal;
  assert.equal(l.toCall, 250, 'Саша faces 250 more — at least a full raise (200)');
  assert.equal(l.canRaise, true, 'so Саша may raise again');
  await t.act(cast.sasha, 'raise', 1000);
  assert.equal(t.room.hand.currentBet, 1000);
  assert.equal(t.state(cast.ivan).legal.canRaise, true, 'and after a full raise, everybody may');
});

test('TDA, Re-Opening the Bet: posting a blind is not acting — a blind keeps the right to raise a short all-in', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  byId(t, 101).stack = 70; byId(t, 101).stats.buyIn = 70; // Иван, the button, is short
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'allin'); // to 70: 20 more than the big blind — short of a full raise
  assert.equal(t.state(cast.max).legal.canRaise, true, 'the small blind has not acted yet: it may raise');
  await t.act(cast.max, 'call');
  assert.equal(t.state(cast.dima).legal.canRaise, true, 'and so may the big blind');
  await t.act(cast.dima, 'raise', 500);
  assert.equal(t.room.hand.currentBet, 500);
});

test('an uncalled bet goes back to the one who made it', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [50, 100] });
  byId(t, 101).stack = 300; byId(t, 101).stats.buyIn = 300;
  t.useDeck(stack({ 101: 'As Ah', 202: '7c 2d', 303: '9c 8c' }, 'Kd Qh 4s 5d Jc'));
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'allin'); // 300
  await t.act(cast.max, 'raise', 2000);
  await t.act(cast.dima, 'fold');
  // Иван could win at most 300 from Макс; the other 1.700 were never called.
  assert.deepEqual(t.state(cast.dima).hand.result.refunds, [{ seat: 1, amount: 1700 }]);
  assert.equal(byId(t, 202).stack, 10000 - 300);
});

/* ------------------------------------------------------------ showdown */

test('TDA, Face Up for All-Ins: once the betting is over, every hand is turned face up — before the rest of the board', async () => {
  const cast = THREE();
  const t = new Table({ runoutStepMs: 1500 });
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc', 303: '7c 2d' }, 'Qs 9h 4d 3c 8s'));
  await t.seat(cast);
  byId(t, 101).stack = 2000; byId(t, 101).stats.buyIn = 2000;
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'allin');
  await t.act(cast.max, 'call'); // Макс covers Иван — nobody left to bet against
  await t.act(cast.dima, 'fold');
  const st = t.state(cast.dima);
  assert.deepEqual(st.hand.board, [], 'not a card of the board yet');
  assert.deepEqual(st.players[0].cards, ['AS', 'AH'], 'the all-in hand is face up');
  assert.deepEqual(st.players[1].cards, ['KD', 'KC'], 'and so is the one that called it');
  assert.equal(st.players[2].cards, null, 'a folded hand is not');
});

test('in a showdown without an all-in, a losing hand may be mucked; the winner of an uncontested pot never shows', async () => {
  const cast = THREE();
  const t = new Table();
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc', 303: '7c 2d' }, 'Qs 9h 4d 3c 8s'));
  await t.begin(cast);
  await t.runToShowdown(cast);
  const st = t.state(cast.dima);
  assert.deepEqual(st.players[0].cards, ['AS', 'AH'], 'the winner shows');
  assert.equal(st.players[1].mucked, true, 'the loser does not have to');

  const t2 = new Table();
  await t2.begin(cast);
  await t2.act(cast.ivan, 'raise', 500);
  await t2.act(cast.max, 'fold');
  await t2.act(cast.dima, 'fold');
  assert.equal(t2.state(cast.max).players[0].cards, null, 'everybody folded: the cards stay closed');
});

test('TDA, Awarding Odd Chips: the odd chip goes to the first winner left of the button', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({}, 'As Ks Qs Js 10s')); // the board plays: a tie
  await t.send(cast.ivan, { t: 'start' });
  await t.act(cast.ivan, 'call');
  await t.act(cast.max, 'fold'); // the small blind leaves 25 in: the pot is 125
  await t.act(cast.dima, 'check');
  await t.runToShowdown(cast);
  // Button Иван; left of him Макс (folded), then Дима — the first winner.
  assert.equal(byId(t, 303).stack - 9950, 63, 'Дима gets the odd chip');
  assert.equal(byId(t, 101).stack - 9950, 62);
});

test('hand rankings: straight flush > four of a kind > full house > flush > straight > three of a kind > two pair > pair > high card', () => {
  const board = (cards) => best5(parseHand(cards)).score;
  const ladder = [
    '9h 8h 7h 6h 5h 2c 3d', // straight flush
    'Kc Kd Kh Ks 2c 3d 4h', // four of a kind
    'Qc Qd Qh 4s 4c 2d 7h', // full house
    'Ah Jh 8h 4h 2h 3c 5d', // flush
    '9c 8d 7h 6s 5c 2d Kh', // straight
    'Jc Jd Jh 9s 4c 2d 7h', // three of a kind
    'Tc Td 8h 8s 4c 2d Ah', // two pair
    'Ac Ad 8h 6s 4c 3d 2h', // one pair
    'Ac Qd 9h 7s 4c 3d 2h', // high card
  ].map(board);
  for (let i = 0; i + 1 < ladder.length; i++) assert.ok(compare(ladder[i], ladder[i + 1]) > 0, `rank ${i} beats rank ${i + 1}`);
  assert.equal(best5(parseHand('Ac 2d 3h 4s 5c Kd Qh')).name, 'Стрит до 5', 'A-2-3-4-5 is a straight, the lowest one');
  assert.equal(best5(parseHand('Qc Kd Ah 2s 3c 8d 9h')).name, 'Старшая A', 'no straight goes round the corner');
  assert.equal(compare(best5(parseHand('Ah Kh Qh Jh 9h 2c 3d')).score, best5(parseHand('As Ks Qs Js 9s 2c 3d')).score), 0, 'suits never break a tie');
  assert.equal(best5(parseHand('Jc Jd Jh 9s 4c 2d 7h')).name, 'Тройка J', 'three of a kind');
});

/* ------------------------------------------------------- table stakes */

test('Robert\'s Rules, table stakes: chips added during a hand do not play in it', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast, { blinds: [50, 100] });
  const before = byId(t, 303).stack;
  await t.send(cast.ivan, { t: 'rebuy', seat: 2 }); // Дима is in this hand
  assert.equal(byId(t, 303).stack, before, 'not a chip more in this hand');
  assert.match(t.state(cast.dima).room.notice, /со следующей раздачи/);
  await t.runToShowdown(cast);
  const after = byId(t, 303).stack;
  await t.send(cast.max, { t: 'next' });
  assert.equal(byId(t, 303).stack + (byId(t, 303).committed || 0), after + 10000, 'they arrive with the next deal');
  assert.equal(byId(t, 303).stats.buyIn, 20000);
});
