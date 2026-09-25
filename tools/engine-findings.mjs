/**
 * Runnable evidence for ENGINE-NOTE.md. Prints expected vs actual for two
 * findings in server/game.js. Deliberately NOT a *.test.js file: it documents
 * behaviour that is currently wrong, and `npm test` must stay green.
 *
 *   node tools/engine-findings.mjs
 */
import { startHand, applyAction, legalActions } from '../server/game.js';

const mkRoom = (stacks, { sb = 25, bb = 50 } = {}) => ({
  settings: { startingStack: 10000, smallBlind: sb, bigBlind: bb },
  players: stacks.map((stack, i) => ({
    id: `p${i}`, name: `P${i}`, stack, sittingOut: false,
    stats: { buyIn: stack, handsPlayed: 0, potsWon: 0, biggestPot: 0 },
  })),
  dealerId: null, dealerSeat: -1, handNo: 0, hand: null, history: [],
});

const line = (label, expected, actual) =>
  console.log(
    `  ${expected === actual ? '✔' : '✘'} ${label}\n      ожидал: ${expected}\n      получил: ${actual}`
  );

console.log('\nA. Блайнд считается «уже сходившим»');
{
  const room = mkRoom([70, 5000, 5000]); // p0 button+first, p1 SB, p2 BB
  startHand(room);
  applyAction(room, 'p0', 'allin'); // 70 total — прибавка 20 против полного рейза 50

  const p1 = room.players.find((p) => p.id === 'p1');
  console.log(`  SB: acted=${p1.acted}, lastAction=${JSON.stringify(p1.lastAction)}, raiseLocked=${p1.raiseLocked}`);
  line('SB, не ходивший добровольно, может повышать', true, legalActions(room, 'p1').canRaise);
}

console.log('\nB. allin проходит мимо проверки raiseLocked');
{
  const room = mkRoom([5000, 90, 5000, 5000]); // p0 btn, p1 SB, p2 BB, p3 first
  startHand(room);
  applyAction(room, 'p3', 'call');
  applyAction(room, 'p0', 'call');
  applyAction(room, 'p1', 'allin'); // короткий олл-ин: 90 против 50
  applyAction(room, 'p2', 'call');

  const before = room.hand.currentBet;
  // Read the diagnostic BEFORE acting: a successful all-in moves the clock and
  // legalActions() then returns null for a player who is no longer on it.
  const L = legalActions(room, 'p3');
  console.log(`  p3 raiseLocked=${room.players[3].raiseLocked}, canRaise=${L.canRaise}`);
  const raise = applyAction(room, 'p3', 'raise', 500);
  const allin = applyAction(room, 'p3', 'allin');
  line('raise отклонён', 'CANNOT_RAISE', raise.error);
  line('allin отклонён так же', 'CANNOT_RAISE', allin.error ?? `ok, currentBet ${before} → ${room.hand.currentBet}`);
}
console.log('');
