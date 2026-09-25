'use strict';
/** Betting-engine tests: node --test server/game.test.js  (or: npm test) */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startHand,
  applyAction,
  legalActions,
  computePots,
  awardPots,
  totalPot,
} from './game.js';

/* ------------------------------------------------------------- fixtures  */

function mkRoom(stacks, { sb = 50, bb = 100 } = {}) {
  const room = {
    settings: { startingStack: 10000, smallBlind: sb, bigBlind: bb },
    players: stacks.map((stack, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      stack,
      sittingOut: false,
      stats: { buyIn: stack, handsPlayed: 0, potsWon: 0, biggestPot: 0 },
    })),
    dealerId: null,
    dealerSeat: -1,
    handNo: 0,
    hand: null,
    history: [],
  };
  return room;
}

const actor = (room) => room.hand.actorId;
const stackOf = (room, id) => room.players.find((p) => p.id === id).stack;
const doAct = (room, action, amount) => {
  const r = applyAction(room, actor(room), action, amount);
  assert.ok(!r.error, `unexpected error: ${r.error}`);
  return r;
};

/* ---------------------------------------------------------------- blinds */

test('blinds and first actor — 3+ handed', () => {
  const room = mkRoom([10000, 10000, 10000, 10000]);
  startHand(room);
  assert.equal(room.dealerId, 'p0');
  assert.equal(room.hand.sbId, 'p1');
  assert.equal(room.hand.bbId, 'p2');
  assert.equal(stackOf(room, 'p1'), 9950);
  assert.equal(stackOf(room, 'p2'), 9900);
  assert.equal(actor(room), 'p3', 'UTG acts first pre-flop');
  assert.equal(totalPot(room), 150);
});

test('heads-up — button is the small blind and acts first pre-flop', () => {
  const room = mkRoom([10000, 10000]);
  startHand(room);
  assert.equal(room.hand.sbId, room.dealerId);
  assert.equal(actor(room), room.dealerId);

  doAct(room, 'call'); // button completes
  doAct(room, 'check'); // BB checks option
  assert.equal(room.hand.street, 'flop');
  assert.notEqual(actor(room), room.dealerId, 'BB acts first post-flop');
});

test('big blind keeps the option to raise after limps', () => {
  const room = mkRoom([10000, 10000, 10000]);
  startHand(room); // d=p0 sb=p1 bb=p2, first = p0
  doAct(room, 'call');
  doAct(room, 'call');
  assert.equal(actor(room), 'p2', 'BB still gets to act');
  const legal = legalActions(room, 'p2');
  assert.ok(legal.canCheck && legal.canRaise);
  doAct(room, 'check');
  assert.equal(room.hand.street, 'flop');
});

/* -------------------------------------------------------- betting rounds */

test('a raise re-opens the action for players who already acted', () => {
  const room = mkRoom([10000, 10000, 10000]);
  startHand(room);
  doAct(room, 'call'); // p0 limps
  doAct(room, 'call'); // p1 completes
  doAct(room, 'raise', 400); // BB raises to 400
  assert.equal(actor(room), 'p0', 'action returns to the first limper');
  doAct(room, 'fold');
  doAct(room, 'call');
  assert.equal(room.hand.street, 'flop');
  assert.equal(totalPot(room), 900);
});

test('minimum raise is tracked from the last full raise', () => {
  const room = mkRoom([10000, 10000, 10000]);
  startHand(room);
  doAct(room, 'raise', 300); // raise of 200 over the 100 bb
  let legal = legalActions(room, actor(room));
  assert.equal(legal.minTotal, 500, 'next raise must be at least 300 + 200');
  const bad = applyAction(room, actor(room), 'raise', 450);
  assert.equal(bad.error, 'BELOW_MIN_RAISE');
  doAct(room, 'raise', 500);
  legal = legalActions(room, actor(room));
  assert.equal(legal.minTotal, 700);
});

test('post-flop action starts left of the button', () => {
  const room = mkRoom([10000, 10000, 10000, 10000]);
  startHand(room); // button p0
  doAct(room, 'call'); // p3
  doAct(room, 'call'); // p0
  doAct(room, 'call'); // p1 (sb)
  doAct(room, 'check'); // p2 (bb)
  assert.equal(room.hand.street, 'flop');
  assert.equal(actor(room), 'p1');
});

test('check-around advances the street and resets the bet', () => {
  const room = mkRoom([10000, 10000]);
  startHand(room);
  doAct(room, 'call');
  doAct(room, 'check');
  assert.equal(room.hand.currentBet, 0);
  doAct(room, 'check');
  doAct(room, 'check');
  assert.equal(room.hand.street, 'turn');
});

/* ------------------------------------------------------- folds and wins  */

test('everyone folds — the last player standing is paid automatically', () => {
  const room = mkRoom([10000, 10000, 10000]);
  startHand(room);
  doAct(room, 'fold'); // p0
  doAct(room, 'fold'); // p1 (sb)
  assert.equal(room.hand.phase, 'complete');
  assert.equal(stackOf(room, 'p2'), 10050, 'BB collects the 150 pot');
  assert.equal(room.hand.payouts[0].playerId, 'p2');
});

/* ------------------------------------------------------------ all-in     */

test('a player cannot bet more chips than they have', () => {
  const room = mkRoom([10000, 10000, 10000]);
  startHand(room);
  const r = applyAction(room, actor(room), 'raise', 999999);
  assert.equal(r.error, 'NOT_ENOUGH_CHIPS');
});

test('short all-in does not re-open betting for players who already acted', () => {
  // p0 raises, p1 shoves for less than a full raise, p0 may only call or fold.
  const room = mkRoom([10000, 550, 10000]);
  startHand(room); // d=p0 sb=p1(550) bb=p2
  doAct(room, 'raise', 400); // p0 to 400
  assert.equal(actor(room), 'p1');
  doAct(room, 'allin'); // p1 all-in to 550 -> increment 150 < minRaise 300
  assert.equal(room.hand.currentBet, 550);
  assert.equal(actor(room), 'p2');
  doAct(room, 'fold');
  assert.equal(actor(room), 'p0');
  const legal = legalActions(room, 'p0');
  assert.equal(legal.canRaise, false, 'betting is not re-opened');
  assert.equal(legal.toCall, 150);
});

test('full-size all-in does re-open betting', () => {
  const room = mkRoom([10000, 10000, 10000]);
  startHand(room);
  doAct(room, 'raise', 300);
  doAct(room, 'raise', 900); // full re-raise
  const legal = legalActions(room, 'p2');
  assert.equal(legal.canRaise, true);
});

test('all-in for less than the call is treated as a call', () => {
  const room = mkRoom([10000, 10000, 60]);
  startHand(room); // p2 is bb with 60 -> posts 60, already all-in
  assert.equal(room.players[2].allIn, true);
  assert.equal(room.hand.currentBet, 100, 'price is still a full big blind');
});

test('remaining streets are skipped once nobody can act', () => {
  const room = mkRoom([500, 500]);
  startHand(room);
  doAct(room, 'allin');
  doAct(room, 'call');
  assert.equal(room.hand.phase, 'showdown');
  assert.equal(room.hand.runout, true);
  assert.equal(totalPot(room), 1000);
});

/* ----------------------------------------------------------- side pots   */

test('side pots split correctly across unequal stacks', () => {
  const room = mkRoom([1000, 500, 200]);
  startHand(room); // d=p0 sb=p1(50) bb=p2(100)
  doAct(room, 'allin'); // p0 all-in 1000
  doAct(room, 'allin'); // p1 all-in 500
  doAct(room, 'allin'); // p2 all-in 200
  assert.equal(room.hand.phase, 'showdown');

  const pots = room.hand.pots;
  // level 200: 3 x 200 = 600 (all eligible)
  // level 500: 2 x 300 = 600 (p0, p1)
  // level 1000: 1 x 500 = 500 (p0 only -> uncalled, auto-returned)
  assert.equal(pots.length, 3);
  assert.equal(pots[0].amount, 600);
  assert.deepEqual(pots[0].eligible.sort(), ['p0', 'p1', 'p2']);
  assert.equal(pots[1].amount, 600);
  assert.deepEqual(pots[1].eligible.sort(), ['p0', 'p1']);
  assert.equal(pots[2].amount, 500);
  assert.deepEqual(pots[2].winners, ['p0'], 'uncalled chips return to p0');
});

test('short stack wins only the main pot', () => {
  const room = mkRoom([1000, 500, 200]);
  startHand(room);
  doAct(room, 'allin');
  doAct(room, 'allin');
  doAct(room, 'allin');
  const res = awardPots(room, [['p2'], ['p1'], ['p0']]);
  assert.ok(!res.error);
  assert.equal(stackOf(room, 'p2'), 600);
  assert.equal(stackOf(room, 'p1'), 600);
  assert.equal(stackOf(room, 'p0'), 500);
  assert.equal(
    stackOf(room, 'p0') + stackOf(room, 'p1') + stackOf(room, 'p2'),
    1700,
    'chips are conserved'
  );
});

test('folded players still contribute dead money to the pot', () => {
  const room = mkRoom([1000, 1000, 1000]);
  startHand(room);
  doAct(room, 'raise', 300); // p0
  doAct(room, 'call'); // p1 -> 300
  doAct(room, 'fold'); // p2 (bb, 100 dead)
  doAct(room, 'check'); // flop, p1 first
  doAct(room, 'check');
  doAct(room, 'check');
  doAct(room, 'check');
  doAct(room, 'check');
  doAct(room, 'check');
  assert.equal(room.hand.phase, 'showdown');
  const pots = computePots(room);
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 700);
  assert.deepEqual(pots[0].eligible.sort(), ['p0', 'p1']);
});

/* ------------------------------------------------------------- payouts   */

test('split pot divides evenly and the odd chip goes left of the button', () => {
  const room = mkRoom([1000, 1000, 1000]);
  startHand(room); // button p0
  doAct(room, 'call');
  doAct(room, 'call');
  doAct(room, 'check');
  for (let i = 0; i < 9; i++) doAct(room, 'check');
  assert.equal(room.hand.phase, 'showdown');
  assert.equal(room.hand.pots[0].amount, 300);
  awardPots(room, [['p0', 'p1']]);
  assert.equal(stackOf(room, 'p1'), 1050, 'p1 is first left of the button');
  assert.equal(stackOf(room, 'p0'), 1050);

  const room2 = mkRoom([1000, 1000, 1000], { sb: 25, bb: 50 });
  startHand(room2);
  doAct(room2, 'raise', 175);
  doAct(room2, 'call');
  doAct(room2, 'call');
  for (let i = 0; i < 12; i++) if (room2.hand.phase === 'betting') doAct(room2, 'check');
  const pot = room2.hand.pots[0].amount; // 525
  awardPots(room2, [['p0', 'p1']]);
  const total = room2.players.reduce((s, p) => s + p.stack, 0);
  assert.equal(pot, 525);
  assert.equal(total, 3000, 'no chips created or destroyed on an odd split');
});

test('three-way split of an indivisible pot conserves chips', () => {
  const room = mkRoom([1000, 1000, 1000], { sb: 1, bb: 2 });
  startHand(room);
  doAct(room, 'raise', 101);
  doAct(room, 'call');
  doAct(room, 'call');
  while (room.hand.phase === 'betting') doAct(room, 'check');
  awardPots(room, [['p0', 'p1', 'p2']]);
  assert.equal(
    room.players.reduce((s, p) => s + p.stack, 0),
    3000
  );
});

/* -------------------------------------------------------- button rotation */

test('the button moves to the next player with chips each hand', () => {
  const room = mkRoom([1000, 1000, 1000]);
  startHand(room);
  assert.equal(room.dealerId, 'p0');
  doAct(room, 'fold');
  doAct(room, 'fold');
  startHand(room);
  assert.equal(room.dealerId, 'p1');
  room.players[2].stack = 0; // p2 busted
  doAct(room, 'fold');
  doAct(room, 'fold');
  startHand(room);
  assert.equal(room.dealerId, 'p0', 'busted player is skipped');
});

/* ------------------------------------------------------------- invariant */

test('chips are conserved and hands always terminate — randomised games', () => {
  const makeRng = (seed) => {
    let s = seed >>> 0 || 1;
    return (n) => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s % n;
    };
  };

  let handsPlayed = 0;
  let showdowns = 0;
  let sidePots = 0;

  for (let game = 0; game < 60; game++) {
    const rnd = makeRng(1000 + game * 7919);
    const seats = 2 + rnd(7); // 2..8 players
    const stacks = Array.from({ length: seats }, () => 400 + rnd(9600));
    const room = mkRoom(stacks, { sb: 25, bb: 50 });
    const TOTAL = stacks.reduce((a, b) => a + b, 0);

    for (let hand = 0; hand < 60; hand++) {
      if (room.players.filter((p) => p.stack > 0).length < 2) break;
      if (startHand(room).error) break;
      handsPlayed++;

      let guard = 0;
      while (room.hand.phase === 'betting') {
        assert.ok(guard++ < 400, 'betting round did not terminate');
        const id = actor(room);
        const legal = legalActions(room, id);
        assert.ok(legal, 'the player on the clock must have legal actions');

        const choices = [];
        if (legal.canCheck) choices.push(['check'], ['check']);
        if (legal.canCall) choices.push(['call'], ['call'], ['call']);
        if (legal.canBet || legal.canRaise) {
          const span = Math.max(1, legal.maxTotal - legal.minTotal);
          choices.push([legal.canBet ? 'bet' : 'raise', legal.minTotal + rnd(span)]);
          choices.push([legal.canBet ? 'bet' : 'raise', legal.minTotal]);
        }
        choices.push(['fold']);
        if (rnd(20) === 0) choices.push(['allin']);

        const [a, amt] = choices[rnd(choices.length)];
        const res = applyAction(room, id, a, amt);
        assert.ok(!res.error, `rejected a self-declared legal action: ${res.error}`);
        assert.ok(room.players.every((p) => p.stack >= 0), 'no negative stacks');
        assert.ok(
          room.players.every((p) => p.bet <= room.hand.currentBet || p.allIn),
          'nobody is above the current price without being all-in'
        );
      }

      if (room.hand.phase === 'showdown') {
        showdowns++;
        const pots = room.hand.pots;
        if (pots.length > 1) sidePots++;
        // Sometimes split, sometimes single winner.
        const picks = pots.map((p) =>
          rnd(5) === 0 ? [...p.eligible] : [p.eligible[rnd(p.eligible.length)]]
        );
        const res = awardPots(room, picks);
        assert.ok(!res.error, res.error);
      }

      assert.equal(room.hand.phase, 'complete', 'every hand must be settled');
      assert.equal(
        room.players.reduce((s, p) => s + p.stack, 0),
        TOTAL,
        `chips leaked in game ${game}, hand ${hand + 1}`
      );
    }
  }

  assert.ok(handsPlayed > 500, `expected a deep simulation, got ${handsPlayed} hands`);
  assert.ok(showdowns > 50, 'showdown path barely exercised');
  assert.ok(sidePots > 5, 'side-pot path barely exercised');
});
