'use strict';
/**
 * The second rule, next to "nobody acts for somebody else":
 * NOBODY SEES SOMEBODY ELSE'S CARDS.
 *
 * Hiding a card on screen is not enough — whatever reaches a phone can be
 * read off it. So these tests read EVERYTHING the server ever sent to each
 * person's Mini App, every state of every hand, plus every text the bot ever
 * put into the group (sends and edits). A card that reached the wrong phone
 * once has leaked, whatever the screen showed.
 *
 * And the other half of dealing: the bot decides who wins, so a wrong answer
 * here silently hands a pot to the wrong person.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, user, stack, FakeClock } from './harness.js';
import { BOARD_SIZE } from './cards.js';
import { cardCode } from './view.js';
import { rank } from './eval.js';
import { Store } from './store.js';
import { App } from './app.js';
import { Hub } from './hub.js';
import { distribution } from '../server/game.js';
import { seededRng } from './deck.js';
import { TEST_TOKEN, initDataFor } from './harness.js';

const CAST = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима'), sasha: user(404, 'Саша') });
const THREE = () => ({ ivan: user(101, 'Иван'), max: user(202, 'Макс'), dima: user(303, 'Дима') });

/** A card code as it travels to a page: quoted, so "AS" does not match inside "10AS…". */
const q = (c) => `"${cardCode(c)}"`;

/** Every text the bot ever put into the group chat. */
const groupTexts = (t) =>
  t.tg.calls.filter((c) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.chatId === String(t.chatId)).map((c) => c.text).join('\n');

/* ---------------------------------------------------------- the deal */

test('every player sees exactly their own two cards — and nobody else\'s', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);

  const all = [];
  for (const u of Object.values(cast)) {
    const mine = t.hole(u);
    assert.equal(mine.length, 2);
    all.push(...mine);
    assert.deepEqual(t.state(u).me.cards, mine.map(cardCode), `${u.first_name} has their cards on screen`);
    for (const other of Object.values(cast)) {
      if (other === u) continue;
      for (const c of t.hole(other)) {
        assert.ok(!t.received(u).includes(q(c)), `${u.first_name}'s phone received ${cardCode(c)} of ${other.first_name}`);
      }
    }
  }
  assert.equal(new Set(all).size, 8, 'one deck: no card dealt twice');
});

test('no phone ever receives a hole card of another player before the showdown', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc', 303: '7c 2d' }, '4s 9h Jd 3c 8s'));
  await t.send(cast.ivan, { t: 'start' });
  const spectator = user(9999, 'Прохожий');
  t.open(spectator);

  // Play to the river and stop one move short of the showdown.
  let guard = 0;
  while (guard++ < 40) {
    const h = t.room.hand;
    const lastMove = h.street === 'river' && t.room.players.filter((p) => p.inHand && !p.folded && !p.acted).length === 1;
    if (lastMove) break;
    const who = t.actorOf(cast);
    await t.act(who, t.state(who).legal.canCheck ? 'check' : 'call');
  }
  assert.equal(t.room.hand.street, 'river');

  for (const viewer of [...Object.values(cast), spectator]) {
    for (const owner of Object.values(cast)) {
      if (owner === viewer) continue;
      for (const c of t.hole(owner)) {
        assert.ok(!t.received(viewer).includes(q(c)), `${viewer.first_name} saw ${cardCode(c)} of ${owner.first_name}`);
      }
    }
  }
  for (const c of t.room.hand.board) assert.ok(t.received(spectator).includes(q(c)), 'the board is public');
});

test('at showdown only the hands that must be shown reach the other phones', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast);
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc', 303: 'Qh Qd' }, '4s 9h Jd 3c 8s'));
  await t.send(cast.ivan, { t: 'start' });
  // Дима folds on his first turn; Иван and Макс go to showdown. Nobody all-in.
  let folded = false;
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 40) {
    const who = t.actorOf(cast);
    if (who === cast.dima && !folded) {
      await t.act(who, 'fold');
      folded = true;
    } else await t.act(who, t.state(who).legal.canCheck ? 'check' : 'call');
  }
  assert.ok(folded && t.room.hand.shown);

  const seen = t.received(cast.dima);
  for (const c of t.hole(cast.ivan)) assert.ok(seen.includes(q(c)), 'the winner shows');
  for (const c of t.hole(cast.max)) assert.ok(!seen.includes(q(c)), 'the loser mucks — unseen');
  for (const c of t.hole(cast.dima)) assert.ok(!t.received(cast.ivan).includes(q(c)), 'the folded hand is never shown');
  const maxRow = t.state(cast.dima).players.find((p) => p.name === 'Макс');
  assert.equal(maxRow.mucked, true);
  assert.equal(maxRow.handName, null, 'not even the name of a mucked hand');
});

test('winning because everyone folded shows nobody\'s cards, the winner\'s included', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 10) await t.act(t.actorOf(cast), 'fold');

  assert.equal(t.room.hand.phase, 'complete');
  for (const viewer of Object.values(cast)) {
    for (const owner of Object.values(cast)) {
      if (owner === viewer) continue;
      for (const c of t.hole(owner)) assert.ok(!t.received(viewer).includes(q(c)), `${cardCode(c)} of ${owner.first_name} reached ${viewer.first_name}`);
    }
  }
  assert.equal(t.state(cast.ivan).hand.result.kind, 'fold');
});

test('the group chat never gets a card — not a hole card, not even the board', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  await t.runToShowdown(cast);
  assert.ok(t.room.hand.shown, 'it went all the way to a showdown');
  // A card, in any way the bot could ever write one: a rank next to a suit
  // ("A♠", "10♥️") or a picture code ("AS", "10H"). The ♠️ in the card's
  // title is decoration and has no rank next to it.
  const group = groupTexts(t);
  assert.doesNotMatch(group, /(?:10|[2-9JQKA])[♠♥♦♣]/, 'a card was written into the group');
  for (const c of [...Object.values(t.room.hand.holes).flat(), ...t.room.hand.board]) {
    assert.ok(!new RegExp(`\\b${cardCode(c)}\\b`).test(group), `${cardCode(c)} in the group`);
  }
});

test('the deck and anybody\'s Telegram id never reach a phone', async () => {
  const cast = CAST();
  const t = new Table();
  await t.begin(cast);
  const next = t.room.hand.deck.slice(t.room.hand.cursor, t.room.hand.cursor + 5).map(cardCode);
  const seen = t.received(cast.max);
  assert.doesNotMatch(seen, /"deck"|"cursor"|"holes"/);
  assert.ok(!next.every((c) => seen.includes(`"${c}"`)), 'the coming board is not on the phone');
  for (const u of Object.values(cast)) {
    assert.ok(!seen.includes(String(u.id)), `Telegram id ${u.id} was sent to a page`);
  }
});

/* -------------------------------------------------------- the board */

test('the board follows the street: 0, 3, 4, 5 cards — the same on every phone', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  const seen = new Set();
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 40) {
    const h = t.room.hand;
    for (const u of Object.values(cast)) {
      assert.deepEqual(t.state(u).hand.board, h.board.map(cardCode));
    }
    assert.equal(h.board.length, BOARD_SIZE[h.street]);
    seen.add(h.street);
    const who = t.actorOf(cast);
    await t.act(who, t.state(who).legal.canCheck ? 'check' : 'call');
  }
  assert.deepEqual([...seen], ['preflop', 'flop', 'turn', 'river']);
  const dealt = [...Object.values(t.room.hand.holes).flat(), ...t.room.hand.board];
  assert.equal(new Set(dealt).size, dealt.length, 'hole cards and board come from one deck');
});

test('an all-in before the river still deals the whole board', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast);
  await t.shoveDown(cast);
  assert.equal(t.room.hand.phase, 'complete');
  assert.equal(t.room.hand.board.length, 5);
});

/* ---------------------------------------------------------- who wins */

test('the best hand takes the pot — the bot reads the cards, nobody picks', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({ 101: '9c 9d', 202: 'Kd Kc', 303: '7c 2d' }, 'As 9h Jd 3c 8s'));
  await t.send(cast.ivan, { t: 'start' });
  await t.runToShowdown(cast);

  assert.deepEqual(t.room.hand.pots.map((p) => p.winners), [['101']], 'a set of nines beats kings');
  const r = t.state(cast.max).hand.result;
  assert.deepEqual(r.winners, [{ seat: 0, amount: 150, hand: 'Сет 9', best: ['9C', '9D', 'AS', '9H', 'JD'] }]);
  const stackOf = (id) => t.room.players.find((p) => p.id === id).stack;
  assert.deepEqual(['101', '202', '303'].map(stackOf), [10100, 9950, 9950]);
});

test('equal hands split the pot, and not a chip goes missing on the odd one', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  t.useDeck(stack({}, 'As Ks Qs Js 10s')); // the board plays: everybody ties
  await t.send(cast.ivan, { t: 'start' });
  let guard = 0;
  while (t.room.hand.phase === 'betting' && guard++ < 40) {
    const who = t.actorOf(cast);
    const l = t.state(who).legal;
    if (String(who.id) === t.room.hand.sbId && l.toCall > 0) await t.act(who, 'fold');
    else await t.act(who, l.canCheck ? 'check' : 'call');
  }
  const [pot] = t.room.hand.pots;
  assert.equal(pot.amount, 125);
  assert.equal(pot.winners.length, 2);
  const gains = pot.winners.map((id) => t.room.players.find((p) => p.id === id).stack - 9950);
  assert.deepEqual(gains.sort(), [62, 63]);
  assert.equal(t.chips(), 30000);
});

test('side pots: the short stack with the best hand wins only what it could cover', async () => {
  const cast = THREE();
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50] });
  const depth = { 101: 1000, 202: 5000, 303: 5000 };
  for (const p of t.room.players) {
    p.stack = depth[p.id];
    p.stats.buyIn = depth[p.id];
  }
  t.useDeck(stack({ 101: 'As Ah', 202: 'Kd Kc', 303: 'Qh Qd' }, '2s 7h 9d Jc 3s'));
  await t.send(cast.ivan, { t: 'start' });
  await t.shoveDown(cast);

  assert.deepEqual(t.room.hand.pots.map((p) => [p.amount, p.winners]), [[3000, ['101']], [8000, ['202']]]);
  const r = t.state(cast.dima).hand.result;
  assert.deepEqual(r.pots.map((p) => [p.label, p.amount, p.winners]), [['MAIN POT', 3000, [0]], ['SIDE POT 1', 8000, [1]]]);
});

test('every pot pays exactly the engine\'s split of the best hands among ITS claimants', async () => {
  const cast = CAST();
  const rnd = seededRng(31337);
  let checked = 0;
  for (let round = 0; round < 25; round++) {
    const t = new Table();
    t.useDeck(() => {
      const d = Array.from({ length: 52 }, (_, i) => i);
      for (let i = 51; i > 0; i--) {
        const j = rnd(i + 1);
        [d[i], d[j]] = [d[j], d[i]];
      }
      return d;
    });
    await t.seat(cast, { blinds: [25, 50] });
    const depth = [300 + rnd(3000), 300 + rnd(3000), 300 + rnd(3000), 300 + rnd(3000)];
    t.room.players.forEach((p, i) => {
      p.stack = depth[i];
      p.stats.buyIn = depth[i];
    });
    await t.send(cast.ivan, { t: 'start' });
    await t.shoveDown(cast);

    const room = t.room;
    const h = room.hand;
    assert.equal(h.phase, 'complete');
    assert.equal(t.chips(), depth.reduce((a, b) => a + b, 0));
    if (!h.shown) continue;

    const seven = (id) => [...h.holes[id], ...h.board];
    const expected = h.pots.map((pot) => ({
      ...pot,
      winners: pot.eligible.length === 1 ? [...pot.eligible] : rank(pot.eligible.map((id) => ({ id, cards: seven(id) })))[0].ids,
    }));
    expected.forEach((pot, i) => assert.deepEqual([...h.pots[i].winners].sort(), [...pot.winners].sort(), `pot ${i}`));
    const { totals } = distribution(room, expected);
    for (const p of room.players) {
      assert.equal(p.stack - (h.startStacks[p.id] - p.committed), totals.get(p.id) ?? 0, p.name);
    }
    checked++;
  }
  assert.ok(checked >= 20, `only ${checked} showdowns were checked`);
});

/* ---------------------------------------------- no second chances */

test('undo can never re-deal a hand or take back a card', async () => {
  const cast = THREE();
  const t = new Table();
  await t.begin(cast, { blinds: [25, 50] });
  const holes = JSON.stringify(t.room.hand.holes);

  await t.send(cast.ivan, { t: 'undo' });
  assert.equal(t.lastError(cast.ivan).code, 'NOTHING_TO_UNDO', 'right after the deal — otherwise undo is a re-shuffle');
  assert.equal(JSON.stringify(t.room.hand.holes), holes);

  await t.runToShowdown(cast, 3);
  assert.equal(t.room.hand.street, 'flop');
  const board = [...t.room.hand.board];
  await t.send(cast.ivan, { t: 'undo' });
  assert.deepEqual(t.room.hand.board, board, 'the flop stays out');

  await t.send(cast.ivan, { t: 'settings', smallBlind: 100, bigBlind: 200 });
  assert.deepEqual(t.room.pendingBlinds, { sb: 100, bb: 200 });
  await t.send(cast.ivan, { t: 'undo' });
  assert.equal(t.room.pendingBlinds, null, 'the host\'s own settings change was undone');
  assert.deepEqual(t.room.hand.board, board, 'and the cards did not move');
});

/* ------------------------------------------------------- restarts */

test('a restart mid-hand keeps the cards and deals the same turn it would have', async () => {
  const store = new Store(':memory:');
  const cast = THREE();
  const t = new Table({ store });
  await t.begin(cast, { blinds: [25, 50] });
  await t.runToShowdown(cast, 3);
  assert.equal(t.room.hand.street, 'flop');
  const holes = JSON.stringify(t.room.hand.holes);
  const nextCard = t.room.hand.deck[t.room.hand.cursor];
  const maxCards = t.state(cast.max).me.cards;

  const clock = new FakeClock();
  const app2 = new App({ api: t.tg, store, minIntervalMs: 0, botUsername: 'ChipTableBot', clock, runoutStepMs: 0 });
  const hub2 = new Hub(app2, { botToken: TEST_TOKEN });
  app2.attachHub(hub2);
  app2.load();
  await app2.resume();
  const room2 = app2.room(t.chatId);
  assert.equal(JSON.stringify(room2.hand.holes), holes, 'nobody got new cards');

  // Phones reconnect by themselves; Макс sees the same two cards.
  const inbox = {};
  const pages = {};
  for (const u of Object.values(cast)) {
    inbox[u.id] = [];
    pages[u.id] = hub2.open({ initData: initDataFor(u, { startParam: room2.code, clock }) }, (m) => inbox[u.id].push(m)).session;
  }
  const last = (u) => inbox[u.id].filter((m) => m.t === 'state').at(-1).state;
  assert.deepEqual(last(cast.max).me.cards, maxCards);

  let guard = 0;
  while (room2.hand.street === 'flop' && guard++ < 6) {
    const who = Object.values(cast).find((u) => String(u.id) === room2.hand.actorId);
    await hub2.handle(pages[who.id], { t: 'act', action: 'check' });
    await app2.settle();
  }
  assert.equal(room2.hand.street, 'turn');
  assert.equal(room2.hand.board[3], nextCard, 'the turn is the card that was next in the saved deck');
  store.close();
});

/* ------------------------------------------------ the long run */

test('many random hands through the Mini App: cards and chips stay sound', async () => {
  const cast = CAST();
  const rnd = seededRng(4242);
  const t = new Table();
  await t.seat(cast, { blinds: [25, 50], stack: 3000 });
  let TOTAL = t.chips();
  await t.send(cast.ivan, { t: 'start' });

  let hands = 0;
  let rebuys = 0;
  let guard = 0;
  while (t.room.status !== 'finished' && hands < 40 && guard++ < 3000) {
    const h = t.room.hand;
    if (h.phase === 'complete') {
      assert.equal(t.chips(), TOTAL, `chips leaked in hand ${h.no}`);
      hands++;
      // Pot-sized raises bust people fast; the host re-buys them, as at a
      // real table — and the total grows by exactly the re-buys.
      for (const [seat, p] of t.room.players.entries()) {
        if (p.stack > 0) continue;
        await t.send(cast.ivan, { t: 'rebuy', seat });
        TOTAL += t.room.settings.startingStack;
        rebuys++;
      }
      assert.equal(t.chips(), TOTAL, 'a re-buy adds exactly one starting stack');
      await t.send(Object.values(cast)[rnd(4)], { t: 'next' });
      continue;
    }
    const dealt = [...Object.values(h.holes).flat(), ...h.board];
    assert.equal(new Set(dealt).size, dealt.length, 'a card was dealt twice');
    assert.equal(h.board.length, BOARD_SIZE[h.street]);
    assert.ok(t.room.players.every((p) => p.stack >= 0));

    const who = t.actorOf(cast);
    const l = t.state(who).legal;
    const moves = [];
    if (l.canCheck) moves.push(['check'], ['check']);
    if (l.canCall) moves.push(['call'], ['call']);
    if (l.toCall > 0) moves.push(['fold']);
    for (const p of l.presets) {
      if (p.kind === 'size') moves.push([l.canBet ? 'bet' : 'raise', p.total]);
      else if (rnd(6) === 0) moves.push(['allin']); // rare, or the evening ends in four hands
    }
    const [move, amount] = moves[rnd(moves.length)];
    // Half the time, send the seq the page was drawn with — as the real page does.
    await t.act(who, move, amount, rnd(2) ? { seq: t.state(who).seq } : {});
  }
  assert.ok(hands >= 30, `expected a long session, got ${hands} hands`);
  assert.ok(rebuys > 0, 'the re-buy path was exercised');
  if (t.room.hand.phase === 'complete') assert.equal(t.chips(), TOTAL);
  assert.equal(t.errors.length, 0, t.errors.map((e) => e.message || e).join('; '));
});
