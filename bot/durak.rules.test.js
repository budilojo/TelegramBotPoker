'use strict';
/**
 * Durak by the rules — one rule, one test. The numbers are those of
 * docs/game-hub.md, section 5 (pagat.com: "Durak", "Podkidnoy Durak",
 * "Perevodnoy Durak"); the app's own rules come after.
 *
 * These run on the rules layer itself (games/durak/rules.js): a room, the
 * ids of the people acting, stacked packs. What each phone gets to see, and
 * that nobody acts for somebody else through the Mini App, is durak.test.js.
 *
 * Seats: the host '1' sits first, then '2', '3', … — the order people sat
 * down, which is the order play goes round. The host deals the first game,
 * so the cards go out from '2'.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from './games/durak/rules.js';
import { freshDeck36, shuffled36, beats, isCard, RANKS, SUITS } from './games/durak/cards.js';
import { durakView } from './games/durak/view.js';
import { durakStack, durakDecks } from './harness.js';
import { seededRng } from './deck.js';

const NAMES = ['Иван', 'Макс', 'Дима', 'Саша', 'Лена', 'Артём'];

function table(n, { variant = 'podkidnoy', turnSeconds = 0 } = {}) {
  const room = D.createRoom({ chatId: -1, host: { id: 1, name: NAMES[0] }, variant, turnSeconds });
  for (let i = 2; i <= n; i++) D.addPlayer(room, { id: i, name: NAMES[i - 1] });
  return room;
}

const cards = (s) => String(s).trim().split(/\s+/).filter(Boolean);

/** Deal the first game from a stacked pack. */
function deal(room, hands, opts = {}) {
  const r = D.startGame(room, '1', { deck: () => durakStack(hands, opts)(room), randInt: opts.randInt });
  assert.equal(r.error, undefined, `раздача: ${r.error}`);
  return room.deal;
}

/**
 * A position in the middle of a game: these hands, this pack, everything
 * else already in the discard. For the rules that only show once hands are
 * small and the pack is running out.
 */
function position(room, { hands, talon = '', trump = 'S', attacker, defender = null }) {
  if (!room.deal) D.startGame(room, '1', { deck: () => shuffled36(seededRng(3)) });
  const d = room.deal;
  d.hands = Object.fromEntries(d.order.map((id) => [id, cards(hands[id] || '')]));
  d.talon = cards(talon);
  d.trump = trump;
  d.trumpCard = d.talon.at(-1) || `A${trump}`;
  const used = new Set([...Object.values(d.hands).flat(), ...d.talon]);
  d.discard = freshDeck36().filter((c) => !used.has(c));
  d.out = d.order.filter((id) => !d.hands[id].length && !d.talon.length);
  d.table = [];
  d.attacker = attacker;
  d.defender = defender ?? D.nextAlive(d, attacker);
  d.bout = { no: 1, startHand: d.hands[d.defender].length, taking: false, passed: [], leader: attacker };
  room.notice = null;
  return d;
}

const ok = (r, what = '') => assert.equal(r.error, undefined, `${what}: ${r.error} ${r.text || ''}`);
const refused = (r, code, what = '') => assert.equal(r.error, code, `${what}: ждали ${code}, получили ${r.error ?? 'ok'}`);

/** Everybody still owed a "пас" says it. */
function passAll(room) {
  for (const id of D.waitingThrowers(room.deal)) ok(D.pass(room, id), `пас ${id}`);
}

/** Every card is somewhere, once: in a hand, on the table, in the pack or in the discard. */
function accounted(d) {
  const all = [...Object.values(d.hands).flat(), ...d.talon, ...d.discard, ...d.table.flatMap((x) => [x.a, x.d].filter(Boolean))];
  assert.equal(all.length, 36, 'все 36 карт на месте');
  assert.equal(new Set(all).size, 36, 'ни одной карты дважды');
}

/** A plain bot: leads its lowest card, beats if it can, takes otherwise, never throws in. */
function autoplay(room, limit = 3000) {
  const low = (hand) => hand.reduce((a, b) => (RANKS.indexOf(b.slice(0, -1)) < RANKS.indexOf(a.slice(0, -1)) ? b : a));
  for (let i = 0; room.deal.phase === 'play' && i < limit; i++) {
    const d = room.deal;
    if (!d.table.length) ok(D.attack(room, d.attacker, low(d.hands[d.attacker])), 'ход');
    else if (!D.allCovered(d) && !d.bout.taking) {
      const at = d.table.findIndex((x) => !x.d);
      const l = D.legalFor(room, d.defender);
      const card = Object.keys(l.defend).find((c) => l.defend[c].includes(at));
      ok(card ? D.defend(room, d.defender, card, at) : D.take(room, d.defender), 'защита');
    } else passAll(room);
    accounted(room.deal);
  }
  assert.equal(room.deal.phase, 'over', 'партия доиграна до конца');
}

/* ================================================================ rules */

test('1 · the pack is 36 cards, 6 up to the ace, and the ace is the highest', () => {
  const deck = freshDeck36();
  assert.equal(deck.length, 36);
  assert.equal(new Set(deck).size, 36);
  assert.deepEqual(RANKS, ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']);
  for (const s of SUITS) for (const r of RANKS) assert.ok(deck.includes(r + s));
  assert.ok(!deck.some((c) => /^[2-5]/.test(c)), 'no twos to fives');
  assert.equal(beats('KH', 'AH', 'S'), true, 'the ace beats the king');
  assert.equal(beats('AH', 'KH', 'S'), false);

  const room = table(4);
  D.startGame(room, '1'); // a real shuffle
  accounted(room.deal);
  assert.ok(Object.values(room.deal.hands).flat().every(isCard));
});

test('2 · six cards each, one at a time round the table from the dealer\'s left', () => {
  const room = table(3);
  const pack = freshDeck36();
  D.startGame(room, '1', { deck: () => pack });
  const d = room.deal;
  assert.equal(d.dealer, '1', 'the host deals the first game');
  // The dealer's left is '2', then '3', then the dealer: card 0 to '2', card 1 to '3', card 2 to '1'…
  assert.deepEqual(d.hands['2'], [0, 3, 6, 9, 12, 15].map((i) => pack[i]));
  assert.deepEqual(d.hands['3'], [1, 4, 7, 10, 13, 16].map((i) => pack[i]));
  assert.deepEqual(d.hands['1'], [2, 5, 8, 11, 14, 17].map((i) => pack[i]));
  assert.equal(d.talon.length, 36 - 18);
});

test('3 · the next card is the trump, face up under the pack, and it is drawn last', () => {
  const room = table(4);
  const pack = shuffled36(seededRng(11));
  D.startGame(room, '1', { deck: () => pack });
  const d = room.deal;
  assert.equal(d.trumpCard, pack[35], 'the bottom of the pack');
  assert.equal(d.trump, pack[35].slice(-1));
  assert.equal(d.talon.at(-1), d.trumpCard, 'under the pack: the last card to be drawn');
  assert.equal(d.trumpHolder, null);
  const v = durakView(room, '2');
  assert.equal(v.deal.trumpCard, d.trumpCard, 'everybody sees it');
});

test('3 · with six players the pack is dealt out and the trump stays with the dealer, face up', () => {
  const room = table(6);
  const pack = shuffled36(seededRng(5));
  D.startGame(room, '1', { deck: () => pack });
  const d = room.deal;
  assert.equal(d.talon.length, 0);
  assert.equal(d.trumpCard, pack[35]);
  assert.equal(d.trumpHolder, '1', 'the dealer');
  assert.ok(d.hands['1'].includes(d.trumpCard), 'the last card dealt is his');
  const v = durakView(room, '4');
  assert.equal(v.deal.trumpHolderSeat, 0, 'and everybody saw it go to him');
  assert.ok(!v.me.cards.includes(d.trumpCard) || v.me.seat === 0);
});

test('4 · the first game is led by the player with the lowest trump', () => {
  const room = table(3);
  const d = deal(room, {
    2: '9D KS KH KC 10S 10H', // lowest trump: 9♦
    3: '7D QS QH QC JS JH', //   lowest trump: 7♦ — this one leads
    1: 'AD AS AH AC JC JD', //    lowest trump: J♦
  }, { trump: '8D' });
  assert.equal(d.trump, 'D');
  assert.equal(d.attacker, '3');
  assert.equal(d.defender, '1', 'and attacks the player on his left');
  assert.equal(d.firstBy, 'trump');
  assert.match(room.notice, /Дима: младший козырь 7♦/);
});

test('4 · nobody holding a trump: the first lead is drawn by lot', () => {
  const room = table(2);
  // Both hands named in full, so no club can slip into them.
  const d = deal(room, { 2: '6S 7S 8S 9S 10S JS', 1: '6H 7H 8H 9H 10H JH' }, { trump: 'AC', randInt: (n) => n - 1 });
  assert.equal(d.trump, 'C');
  assert.equal(d.firstBy, 'random');
  assert.equal(d.attacker, '2', 'whoever the lot picked');
  assert.match(room.notice, /по жребию/);
});

test('5 · later games are played "under the durak": the player on his right attacks him', () => {
  const room = table(4);
  D.startGame(room, '1', { deck: durakDecks(21) });
  autoplay(room);
  const fool = room.deal.fool;
  assert.ok(fool, 'somebody is the durak');
  ok(D.nextGame(room, '2', { deck: durakDecks(22) }));
  const d = room.deal;
  const order = d.order;
  const right = order[(order.indexOf(fool) - 1 + order.length) % order.length];
  assert.equal(d.defender, fool, 'the durak defends first');
  assert.equal(d.attacker, right, 'attacked by the one on his right');
  assert.equal(d.firstBy, 'fool');
  assert.equal(d.dealer, fool, 'and he dealt');
});

test('6 · the attacker leads any card; nobody else may open the bout', () => {
  const room = table(3);
  const d = deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: 'QS KH AD 6C 7S 8H', 1: '9S 10H JD QC KS AH' }, { trump: '6D' });
  assert.equal(d.attacker, '2');
  refused(D.attack(room, '1', '9S'), 'NOT_YOUR_LEAD', 'a thrower before the lead');
  refused(D.attack(room, '3', 'QS'), 'DEFENDER_CANNOT_ATTACK', 'the defender');
  ok(D.attack(room, '2', '10S'), 'any card — not the lowest');
  assert.deepEqual(d.table.map((x) => x.a), ['10S']);
});

test('7 · anyone but the defender throws in cards of a rank already on the table — attack or defence', () => {
  const room = table(3);
  const d = deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: 'QS KH AD 6C 7S 8H', 1: '9S 10H JD QC KS AH' }, { trump: '6D' });
  ok(D.attack(room, '2', '9C'));
  refused(D.attack(room, '1', '10H'), 'RANK_NOT_ON_TABLE', 'a 10 — no 10 on the table');
  assert.match(D.attack(room, '1', '10H').text, /только 9/);
  ok(D.attack(room, '1', '9S'), 'a nine, by the other player — not only the attacker throws in');
  ok(D.defend(room, '3', 'QS', 1), 'Q♠ on 9♠');
  ok(D.attack(room, '1', 'QC'), 'a queen: the rank of a DEFENDING card counts too');
  refused(D.attack(room, '3', '7S'), 'DEFENDER_CANNOT_ATTACK');
  assert.deepEqual(d.table.map((x) => x.a), ['9C', '9S', 'QC']);
});

test('8 · no more than six attacking cards in a bout', () => {
  const room = table(3);
  const d = deal(room, {
    2: '6S 8H 9D 10C JH QD', // attacker: the lowest trump, 6♠
    3: '8S 9H 10D JC QH KD', // defender
    1: '6H 6C 7S 7H 9C AC', //  the third player
  }, { trump: 'AS' });
  assert.equal(d.attacker, '2');
  ok(D.attack(room, '2', '6S'));
  ok(D.attack(room, '1', '6H'));
  ok(D.attack(room, '1', '6C'));
  ok(D.defend(room, '3', '8S', 0)); // eights on the table now
  ok(D.attack(room, '2', '8H'));
  ok(D.defend(room, '3', '9H', 1)); // …and nines
  ok(D.attack(room, '2', '9D'));
  ok(D.defend(room, '3', 'JC', 2)); // …and jacks
  ok(D.attack(room, '2', 'JH'));
  assert.equal(d.table.length, 6, 'six attacking cards on the table');
  assert.deepEqual(D.legalFor(room, '1').attack, [], 'a seventh is not even offered');
  const r = D.attack(room, '1', '9C'); // a nine — the rank is there, the room is not
  refused(r, 'TABLE_LIMIT');
  assert.match(r.text, /не больше 6 карт/);
});

test('8 · …and no more than the defender held when the bout began', () => {
  const room = table(3);
  const d = position(room, {
    hands: { 1: '6S 6H 6D 6C 7S', 2: '9S 10S JS', 3: 'QH KH' },
    attacker: '1', // attacks '2', who holds three cards
  });
  assert.equal(d.defender, '2');
  assert.equal(D.boutLimit(d), 3);
  ok(D.attack(room, '1', '6S'));
  ok(D.attack(room, '1', '6H'));
  ok(D.attack(room, '1', '6D'));
  const r = D.attack(room, '1', '6C');
  refused(r, 'TABLE_LIMIT');
  assert.match(r.text, /Макс отбивается, а у него было всего 3 карты/);
});

test('9 · beat with a higher card of the suit, or with a trump; a trump only with a higher trump', () => {
  const room = table(2);
  const d = position(room, {
    hands: { 1: '9H KS 7D 6C', 2: '8H 10H 6D 9D AS' },
    trump: 'D',
    attacker: '1',
  });
  ok(D.attack(room, '1', '9H'));
  refused(D.defend(room, '2', '8H', 0), 'CANNOT_BEAT', 'a lower heart');
  assert.match(D.defend(room, '2', '8H', 0).text, /8♥ не бьёт 9♥: нужна старшая ♥ или козырь/);
  refused(D.defend(room, '2', 'AS', 0), 'CANNOT_BEAT', 'a higher card of another suit');
  ok(D.defend(room, '2', '10H', 0), 'a higher heart');
  refused(D.defend(room, '2', '6D', 0), 'ALREADY_COVERED', 'one defending card per attacking card');
  passAll(room);
  // '2' beat off the attack and leads now: a trump, which only a higher trump beats.
  assert.equal(d.attacker, '2');
  ok(D.attack(room, '2', '9D'));
  refused(D.defend(room, '1', 'KS', 0), 'CANNOT_BEAT', 'a plain card on a trump');
  const r = D.defend(room, '1', '7D', 0);
  refused(r, 'CANNOT_BEAT', 'a lower trump on a higher one');
  assert.match(r.text, /козырь бьётся только старшим козырем/);
  assert.equal(beats('9D', 'JD', 'D'), true, 'a higher trump does');

  // And a trump beats any card that is not one.
  assert.equal(beats('AS', '6D', 'D'), true);
  assert.equal(beats('7D', 'AS', 'D'), false);
});

test('10 · beaten off: the cards go to the discard face down, and the defender leads next', () => {
  const room = table(3);
  const d = deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: 'QS KH AD 6C 7S 8H', 1: '9S 10H JD QC KS AH' }, { trump: '6D' });
  ok(D.attack(room, '2', '9C'));
  ok(D.defend(room, '3', 'AD', 0)); // a trump over a club
  assert.equal(D.legalFor(room, '2').passLabel, 'Бито', 'the attacker says "Бито"…');
  assert.equal(D.legalFor(room, '1').passLabel, 'Пас', '…the others "Пас" — the same word');
  ok(D.pass(room, '2'));
  assert.equal(d.table.length, 1, 'the pair is still on the table: not over while somebody may still throw in');
  ok(D.pass(room, '1'));
  assert.equal(d.table.length, 0);
  assert.deepEqual(d.discard.sort(), ['9C', 'AD']);
  assert.equal(d.last.kind, 'beaten');
  assert.equal(d.attacker, '3', 'the defender leads the next bout');
  assert.equal(d.defender, '1');
  const v = durakView(room, '1');
  assert.equal(v.deal.discard, 2, 'the discard is a number to everybody');
  assert.ok(!JSON.stringify(v).includes('9C'), 'and its cards are nowhere in what a phone gets');
});

test('11 · taken: attackers may still throw in, then the defender picks up everything, and loses his turn', () => {
  const room = table(3);
  const d = deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: 'QS KH AD 6C 7S 8H', 1: '9S 10H JD QC KS AH' }, { trump: '6D' });
  ok(D.attack(room, '2', '7H'));
  ok(D.take(room, '3'));
  refused(D.defend(room, '3', 'KH', 0), 'TAKING', 'no covering once he takes');
  ok(D.pass(room, '2'));
  assert.equal(d.table.length, 1, 'the third player has not said a word yet');
  refused(D.attack(room, '1', 'KS'), 'RANK_NOT_ON_TABLE');
  refused(D.attack(room, '2', '8D'), 'RANK_NOT_ON_TABLE');
  const n = d.hands['3'].length;
  ok(D.pass(room, '1'));
  assert.equal(d.hands['3'].length, n + 1, 'he picked it up');
  assert.ok(d.hands['3'].includes('7H'));
  assert.equal(d.last.kind, 'taken');
  assert.equal(d.attacker, '1', 'the player after the one who took leads');
  assert.equal(d.defender, '2');
});

test('11 · …thrown in "after him" while he takes, within the limit', () => {
  const room = table(3);
  const d = deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: 'QS KH AD 6C 7S 8H', 1: '9S 10H JD QC KS 7C' }, { trump: '6D' });
  ok(D.attack(room, '2', '7H'));
  ok(D.take(room, '3'));
  ok(D.attack(room, '1', '7C'), 'a seven thrown in after him');
  ok(D.pass(room, '2'));
  ok(D.pass(room, '1'));
  assert.ok(d.hands['3'].includes('7H') && d.hands['3'].includes('7C'));
});

test('12 · drawing up to six: the attacker first, then round the table, the defender last — the trump last of all', () => {
  const room = table(5);
  const d = position(room, {
    hands: {
      1: '6H 6D 7H 7D 8H 8D', // sits after the attacker's neighbours
      2: '6S 6C 7C JH JD QH', // the attacker
      3: 'KS KH KD KC AS AH', // the defender
      4: '9H 9D 10H 10D QD QC', // throws in
      5: 'JC JS QS 8C 8S 9C',
    },
    talon: '10S 10C 9S AD AC 7S', // 7♠ — the trump — at the bottom
    trump: 'S',
    attacker: '2',
  });
  ok(D.attack(room, '2', '6S'));
  ok(D.attack(room, '2', '6C'));
  ok(D.defend(room, '3', 'KS', 0));
  ok(D.defend(room, '3', 'KC', 1));
  ok(D.attack(room, '1', '6H'));
  ok(D.attack(room, '1', '6D'));
  ok(D.defend(room, '3', 'KH', 2));
  ok(D.defend(room, '3', 'KD', 3));
  passAll(room); // attacker 2 needs 2, player 1 needs 2, defender 3 needs 4 — six cards for eight
  assert.deepEqual(d.hands['2'].slice(-2), ['10S', '10C'], 'the attacker draws first');
  assert.deepEqual(d.hands['1'].slice(-2), ['9S', 'AD'], 'then the others, clockwise from him');
  assert.deepEqual(d.hands['3'].slice(-2), ['AC', '7S'], 'the defender last — and the trump from under the pack is the last card');
  assert.equal(d.hands['3'].length, 4, 'the pack ran out before he had six');
  assert.equal(d.talon.length, 0);
});

test('13 · with the pack gone, whoever has no cards is out — and play goes on past them', () => {
  const room = table(4);
  const d = position(room, {
    hands: { 1: 'QS QH', 2: '6H 8H 9H', 3: '7H 10H JH', 4: 'KS KH AS' },
    trump: 'D',
    attacker: '2',
  });
  ok(D.attack(room, '2', '6H'));
  ok(D.defend(room, '3', '7H', 0));
  passAll(room);
  assert.equal(d.attacker, '3');
  ok(D.attack(room, '3', '10H'));
  ok(D.defend(room, '4', 'KH', 0));
  passAll(room);
  assert.deepEqual(d.out, [], 'still a card each');
  assert.equal(d.attacker, '4');
  assert.equal(d.defender, '1');
  ok(D.attack(room, '4', 'KS'));
  ok(D.take(room, '1')); // queens do not beat a king
  passAll(room);
  assert.equal(d.attacker, '2', 'after the one who took');
  assert.equal(d.defender, '3');
  ok(D.attack(room, '2', '8H'));
  ok(D.defend(room, '3', 'JH', 0)); // his last card: the bout is over at once (rule 8)
  assert.deepEqual(d.out, ['3'], 'the defender beat off with his last card: out');
  assert.equal(d.hands['2'].length, 1, '2 still holds 9♥');
  assert.equal(d.attacker, '4', 'the defender who went out cannot lead: the next one does');
  assert.equal(d.defender, '1');
});

test('14 · the last one holding cards is the durak', () => {
  const room = table(3);
  const d = position(room, { hands: { 1: '6H', 2: '7H', 3: 'AS AH' }, trump: 'D', attacker: '1' });
  ok(D.attack(room, '1', '6H'));
  ok(D.defend(room, '2', '7H', 0));
  // Both went out on that bout; '3' is left holding cards.
  assert.equal(d.phase, 'over');
  assert.equal(d.fool, '3');
  assert.equal(d.draw, false);
  assert.match(room.notice, /Дурак — Дима/);
});

test('14 · the last cards gone from everybody at once: a draw, no durak', () => {
  const room = table(2);
  const d = position(room, { hands: { 1: '7S', 2: '9S' }, trump: 'D', attacker: '1' });
  ok(D.attack(room, '1', '7S'));
  ok(D.defend(room, '2', '9S', 0));
  assert.equal(d.phase, 'over');
  assert.equal(d.fool, null);
  assert.equal(d.draw, true);
  assert.equal(room.history.at(-1).draw, true);
  ok(D.nextGame(room, '1', { deck: durakDecks(4) }));
  assert.equal(room.deal.firstBy === 'trump' || room.deal.firstBy === 'random', true, 'after a draw: the lowest trump again');
});

test('15 · perevodnoy: before anything is beaten, the defender passes the attack on with the same rank', () => {
  const room = table(3, { variant: 'perevodnoy' });
  const d = deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: '9H KH AD 6C 7S 8H', 1: '9S 10H JD QC KS AH' }, { trump: '6D' });
  ok(D.attack(room, '2', '9C'));
  ok(D.transfer(room, '3', '9H'));
  assert.equal(d.defender, '1', 'the next player defends now');
  assert.equal(d.attacker, '3');
  assert.deepEqual(d.table.map((x) => x.a), ['9C', '9H'], 'against every card on the table');
  ok(D.transfer(room, '1', '9S'), 'and he may pass it on again');
  assert.equal(d.defender, '2');
  assert.equal(d.table.length, 3);
});

test('15 · no transfer once a card is beaten, with another rank, in podkidnoy — or onto too few cards', () => {
  const pod = table(3);
  deal(pod, { 2: '6S 7H 8D 9C 10S JH', 3: '9H KH AD 6C 7S 8H', 1: '9S 10H JD QC KS AH' }, { trump: '6D' });
  ok(D.attack(pod, '2', '9C'));
  refused(D.transfer(pod, '3', '9H'), 'NO_TRANSFER', 'podkidnoy has no transfers');
  assert.deepEqual(D.legalFor(pod, '3').transfer, []);

  const room = table(3, { variant: 'perevodnoy' });
  deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: '9H KH AD 6C 7S 8H', 1: '9S 10H JD QC KS AH' }, { trump: '6D' });
  ok(D.attack(room, '2', '9C'));
  refused(D.transfer(room, '3', 'KH'), 'TRANSFER_RANK');
  ok(D.attack(room, '1', '9S'));
  ok(D.defend(room, '3', 'AD', 0));
  refused(D.transfer(room, '3', '9H'), 'TRANSFER_AFTER_BEAT');

  const short = table(3, { variant: 'perevodnoy' });
  const d = position(short, { hands: { 1: '7S 7H 6D', 2: '7C KH AH', 3: 'AS' }, trump: 'D', attacker: '1' });
  ok(D.attack(short, '1', '7S'));
  ok(D.attack(short, '1', '7H'));
  assert.equal(d.defender, '2');
  const r = D.transfer(short, '2', '7C');
  refused(r, 'TRANSFER_TOO_MANY', 'Дима holds one card, the table would have three');
  assert.match(r.text, /у следующего игрока \(Дима\) 1 карта, а на столе будет 3/);
});

test('15 · two players: the attack passes back to the attacker', () => {
  const room = table(2, { variant: 'perevodnoy' });
  const d = deal(room, { 2: '6D 7S 8S 9S 10S JS', 1: '7H 7C 8H 9H 10H JH' }, { trump: 'AD' });
  assert.equal(d.attacker, '2');
  ok(D.attack(room, '2', '7S'));
  ok(D.transfer(room, '1', '7H'));
  assert.equal(d.defender, '2');
  assert.equal(d.attacker, '1');
});

test('16 · a series: who was the durak how many times, game after game', () => {
  const room = table(3);
  D.startGame(room, '1', { deck: durakDecks(31) });
  const fools = [];
  for (let g = 0; g < 4; g++) {
    if (g) ok(D.nextGame(room, '3', { deck: durakDecks(40 + g) }));
    autoplay(room);
    fools.push(room.deal.fool);
  }
  const sc = D.score(room);
  for (const id of ['1', '2', '3']) {
    const row = sc.find((r) => r.id === id);
    assert.equal(row.fool, fools.filter((f) => f === id).length, `счёт ${id}`);
    assert.equal(row.games, 4);
  }
  assert.ok(sc[0].fool <= sc.at(-1).fool, 'the least often durak first');
  assert.equal(room.history.length, 4);
});

/* ======================================================= the app's rules */

test('app · "пас" is said by each player: a thrower with nothing to add is not passed for him', () => {
  const room = table(3);
  const d = deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: 'QS KH AD 6C 7S 8H', 1: 'QD 10H JD QC KS 7C' }, { trump: '6D' });
  ok(D.attack(room, '2', '9C'));
  ok(D.defend(room, '3', 'AD', 0));
  // '1' holds no nine and no ace: nothing to throw in. The server knows it —
  // and still waits for him, or "passed" would tell the table what he lacks.
  assert.deepEqual(D.legalFor(room, '1').attack, []);
  assert.deepEqual(D.waitingThrowers(d).sort(), ['1', '2']);
  ok(D.pass(room, '2'));
  assert.equal(d.table.length, 1, 'the pair stays on the table: still waiting for him');
  assert.equal(durakView(room, '2').players.find((p) => p.seat === 0).waiting, true);
});

test('app · a new card on the table takes back every "пас"', () => {
  const room = table(3);
  const d = deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: 'QS KH AD 6C 7S 8H', 1: '9S 10H JD QC KS AH' }, { trump: '6D' });
  ok(D.attack(room, '2', '9C'));
  ok(D.defend(room, '3', 'AD', 0));
  ok(D.pass(room, '2'));
  ok(D.attack(room, '1', '9S'));
  assert.deepEqual(d.bout.passed, [], 'the attacker may throw in again after this nine');
  refused(D.pass(room, '2'), 'CANNOT_PASS', 'not while a card is uncovered');
});

test('app · the limit reached ends the bout without waiting for anybody', () => {
  const room = table(3);
  const d = position(room, { hands: { 1: '6S 6H', 2: '9S 9H', 3: 'QH KH' }, trump: 'D', attacker: '1' });
  ok(D.attack(room, '1', '6S'));
  ok(D.attack(room, '1', '6H'));
  ok(D.defend(room, '2', '9S', 0));
  ok(D.defend(room, '2', '9H', 1));
  assert.equal(d.last?.kind, 'beaten', 'two cards on a defender who had two: nothing more can come');
});

test('app · somebody leaving in the middle of a game stops it, and it does not count', () => {
  const room = table(3);
  D.startGame(room, '1', { deck: durakDecks(8) });
  refused(D.leave(room, '2'), 'IN_DEAL', 'standing up mid-game is refused');
  ok(D.markLeft(room, '2'));
  assert.equal(room.deal.phase, 'over');
  assert.equal(room.deal.aborted, true);
  assert.equal(room.deal.fool, null);
  assert.match(room.notice, /Партия прервана: Макс вышел из чата/);
  assert.ok(room.players.every((p) => p.stats.games === 0 && p.stats.fool === 0), 'nobody scored');
  ok(D.nextGame(room, '1', { deck: durakDecks(9) }));
  assert.deepEqual(room.deal.order, ['1', '3'], 'the next game without him');
});

test('app · the host removing a player mid-game stops it the same way', () => {
  const room = table(3);
  D.startGame(room, '1', { deck: durakDecks(8) });
  refused(D.kickPlayer(room, '2', '3'), 'NOT_HOST');
  ok(D.kickPlayer(room, '1', '3'));
  assert.equal(room.deal.aborted, true);
  refused(D.addPlayer(room, { id: 3, name: 'Дима' }), 'KICKED');
});

test('app · the turn timer: the defender takes, the throwers pass, a bout to open gets the lowest plain card', () => {
  const room = table(3, { turnSeconds: 30 });
  const d = deal(room, { 2: '6S 7H 8D 9C 10S JH', 3: 'QS KH AD 6C 7S 8H', 1: '9S 10H JD QC KS AH' }, { trump: '6D' });
  const t0 = 1_000_000;
  let turn = D.syncTurn(room, t0);
  refused(D.timeoutMove(room, turn.key, t0 + 29_000), 'EARLY');
  ok(D.timeoutMove(room, turn.key, t0 + 30_000));
  assert.deepEqual(d.table.map((x) => x.a), ['6S'], 'the lowest card that is not a trump (8♦ is one)');

  turn = D.syncTurn(room, t0 + 30_000);
  ok(D.timeoutMove(room, turn.key, t0 + 60_000));
  assert.equal(d.bout.taking, true, 'the defender, out of time, takes');

  turn = D.syncTurn(room, t0 + 60_000);
  ok(D.timeoutMove(room, turn.key, t0 + 90_000));
  assert.equal(d.last.kind, 'taken', 'the throwers, out of time, pass — and he has picked up');
  assert.ok(d.hands['3'].includes('6S'));
  refused(D.timeoutMove(room, turn.key, t0 + 200_000), 'STALE', 'a timer for a wait that is over does nothing');
});

test('app · nobody moving on their own for two rounds stops the game instead of playing it for them', () => {
  const room = table(2, { turnSeconds: 30 });
  D.startGame(room, '1', { deck: durakDecks(12) });
  let t = 5_000_000;
  for (let i = 0; i < 20 && room.deal.phase === 'play'; i++) {
    const turn = D.syncTurn(room, t);
    t += 30_000;
    D.timeoutMove(room, turn.key, t);
  }
  assert.equal(room.deal.phase, 'over');
  assert.equal(room.deal.aborted, true);
  assert.match(room.notice, /никто не ходит сам/);
});

test('app · a double tap (a stale seq) is dropped instead of playing twice', () => {
  const room = table(2);
  const d = deal(room, { 2: '6D 7S 8S 9S 10S JS', 1: '6H 7H 8H 9H 10H JH' }, { trump: 'AD' });
  const seq = room.seq;
  ok(D.attack(room, '2', '7S', seq));
  refused(D.attack(room, '2', '8S', seq), 'STALE');
  assert.equal(d.table.length, 1);
});

test('app · a card that is not in your hand is refused, whoever you are', () => {
  const room = table(2);
  const d = deal(room, { 2: '6D 7S 8S 9S 10S JS', 1: '6H 7H 8H 9H 10H JH' }, { trump: 'AD' });
  assert.equal(d.attacker, '2');
  refused(D.attack(room, '2', '6H'), 'NOT_YOUR_CARD', 'somebody else\'s card');
  refused(D.attack(room, '2', 'AD'), 'NOT_YOUR_CARD', 'the trump under the pack');
  refused(D.attack(room, '9', '7S'), 'NOT_IN_DEAL', 'a stranger');
  assert.equal(d.table.length, 0);
});
