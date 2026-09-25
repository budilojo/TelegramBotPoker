'use strict';
/**
 * Pure poker *betting* engine. Knows nothing about cards, hand ranks or winners.
 * It only tracks chips: stacks, bets, pots, turn order, blinds, side pots.
 *
 * Every function here mutates the plain `room` object and returns either
 * `{ ok: true, ... }` or `{ error: 'CODE' }`. No I/O, no randomness except
 * where explicitly noted, so it is trivially testable.
 */

export const STREETS = ['preflop', 'flop', 'turn', 'river'];

/* ------------------------------------------------------------------ utils */

export const clone = (o) => JSON.parse(JSON.stringify(o));

const sameSet = (a, b) =>
  a.length === b.length && a.every((x) => b.includes(x));

function seatIndex(room, playerId) {
  return room.players.findIndex((p) => p.id === playerId);
}

/** Walk seats clockwise from `fromIdx` (exclusive) until `pred` matches. */
function nextSeat(room, fromIdx, pred) {
  const n = room.players.length;
  if (n === 0) return -1;
  for (let i = 1; i <= n; i++) {
    const j = (((fromIdx + i) % n) + n) % n;
    if (pred(room.players[j], j)) return j;
  }
  return -1;
}

const blankHandFields = () => ({
  inHand: false,
  folded: false,
  allIn: false,
  bet: 0, // committed on the current street
  committed: 0, // committed across the whole hand
  acted: false, // acted at the current bet level
  raiseLocked: false, // a sub-minimum all-in cannot re-open betting for them
  lastAction: null,
  lastAmount: 0,
});

/**
 * Who gets dealt into a hand. The DEALER role is an operator, not a seat:
 * they run the table and never put chips at risk.
 */
export const canDeal = (p) =>
  p.stack > 0 && !p.sittingOut && p.role !== 'dealer';

export const livePlayers = (room) =>
  room.players.filter((p) => p.inHand && !p.folded);

export const actingPlayers = (room) =>
  room.players.filter((p) => p.inHand && !p.folded && !p.allIn);

/* ------------------------------------------------------------- hand start */

export function startHand(room) {
  const eligible = room.players.filter(canDeal);
  if (eligible.length < 2) return { error: 'NOT_ENOUGH_PLAYERS' };

  for (const p of room.players) {
    Object.assign(p, blankHandFields());
    p.inHand = canDeal(p);
    // players who joined mid-game stop "waiting" once they are dealt in
    if (p.inHand) p.waiting = false;
  }

  // Move the button to the next player who is actually in the hand.
  let base;
  const prev = room.dealerId ? seatIndex(room, room.dealerId) : -1;
  base = prev >= 0 ? prev : Math.min(room.dealerSeat ?? -1, room.players.length - 1);
  const dIdx = nextSeat(room, base, (p) => p.inHand);
  room.dealerId = room.players[dIdx].id;
  room.dealerSeat = dIdx;

  const inHandCount = room.players.filter((p) => p.inHand).length;
  let sbIdx, bbIdx;
  if (inHandCount === 2) {
    // Heads-up: the button posts the small blind and acts first pre-flop.
    sbIdx = dIdx;
    bbIdx = nextSeat(room, dIdx, (p) => p.inHand);
  } else {
    sbIdx = nextSeat(room, dIdx, (p) => p.inHand);
    bbIdx = nextSeat(room, sbIdx, (p) => p.inHand);
  }

  room.handNo = (room.handNo || 0) + 1;
  room.hand = {
    no: room.handNo,
    street: 'preflop',
    phase: 'betting', // betting | showdown | complete
    currentBet: room.settings.bigBlind,
    minRaise: room.settings.bigBlind,
    dealerId: room.dealerId,
    sbId: room.players[sbIdx].id,
    bbId: room.players[bbIdx].id,
    actorId: null,
    pots: [],
    payouts: [],
    startStacks: Object.fromEntries(room.players.map((p) => [p.id, p.stack])),
    startedAt: Date.now(),
    runout: false,
    log: [],
  };

  postBlind(room, sbIdx, room.settings.smallBlind, 'SB');
  postBlind(room, bbIdx, room.settings.bigBlind, 'BB');

  const firstIdx = nextSeat(
    room,
    bbIdx,
    (p) => p.inHand && !p.folded && !p.allIn
  );
  room.hand.actorId = firstIdx >= 0 ? room.players[firstIdx].id : null;

  // Blinds alone can already close the action (everyone all-in).
  settle(room);
  return { ok: true };
}

function postBlind(room, i, blind, label) {
  const p = room.players[i];
  const amount = Math.min(blind, p.stack);
  p.stack -= amount;
  p.bet += amount;
  p.committed += amount;
  if (p.stack === 0) p.allIn = true;
  p.lastAction = label;
  p.lastAmount = amount;
  room.hand.log.push({
    type: 'blind',
    playerId: p.id,
    name: p.name,
    label,
    amount,
    street: 'preflop',
  });
}

/* ---------------------------------------------------------- legal actions */

/**
 * What can `playerId` do right now? Used by the server to validate and by the
 * client to render only the buttons that make sense.
 */
export function legalActions(room, playerId) {
  const h = room.hand;
  if (!h || h.phase !== 'betting' || h.actorId !== playerId) return null;
  const p = room.players[seatIndex(room, playerId)];
  if (!p || !p.inHand || p.folded || p.allIn) return null;

  const toCall = Math.max(0, h.currentBet - p.bet);
  const canCheck = toCall === 0;
  const callAmount = Math.min(toCall, p.stack);
  const isCallAllIn = toCall >= p.stack;

  // Raise/bet sizing, expressed as a *total* street bet (p.bet + added chips).
  const maxTotal = p.bet + p.stack;
  const opening = h.currentBet === 0;
  const minTotal = opening
    ? Math.min(room.settings.bigBlind, maxTotal)
    : Math.min(h.currentBet + h.minRaise, maxTotal);

  // A short all-in never re-opens the betting for players who already acted.
  const canAggress = !p.raiseLocked && p.stack > toCall;

  return {
    toCall,
    callAmount,
    isCallAllIn,
    canCheck,
    canCall: toCall > 0,
    canFold: true,
    canBet: opening && canAggress,
    canRaise: !opening && canAggress,
    minTotal,
    maxTotal,
    potTotal: totalPot(room),
    stack: p.stack,
    currentBet: h.currentBet,
    myBet: p.bet,
  };
}

export function totalPot(room) {
  return room.players.reduce((s, p) => s + (p.committed || 0), 0);
}

/* ----------------------------------------------------------- apply action */

export function applyAction(room, playerId, action, rawAmount) {
  const h = room.hand;
  if (!h) return { error: 'NO_HAND' };
  if (h.phase !== 'betting') return { error: 'NOT_BETTING' };
  if (h.actorId !== playerId) return { error: 'NOT_YOUR_TURN' };

  const i = seatIndex(room, playerId);
  const p = room.players[i];
  const legal = legalActions(room, playerId);
  if (!legal) return { error: 'NOT_YOUR_TURN' };

  let entry = null;

  switch (action) {
    case 'fold': {
      p.folded = true;
      p.acted = true;
      p.lastAction = 'FOLD';
      p.lastAmount = 0;
      entry = { type: 'fold', amount: 0 };
      break;
    }
    case 'check': {
      if (!legal.canCheck) return { error: 'CANNOT_CHECK' };
      p.acted = true;
      p.lastAction = 'CHECK';
      p.lastAmount = 0;
      entry = { type: 'check', amount: 0 };
      break;
    }
    case 'call': {
      if (!legal.canCall) return { error: 'CANNOT_CALL' };
      const amt = legal.callAmount;
      commit(p, amt);
      p.acted = true;
      p.lastAction = p.allIn ? 'ALL-IN' : 'CALL';
      p.lastAmount = amt;
      entry = { type: p.allIn ? 'allin-call' : 'call', amount: amt, total: p.bet };
      break;
    }
    case 'bet':
    case 'raise':
    case 'allin': {
      let total;
      if (action === 'allin') {
        total = legal.maxTotal;
      } else {
        total = Math.round(Number(rawAmount));
        if (!Number.isFinite(total)) return { error: 'BAD_AMOUNT' };
        if (action === 'bet' && !legal.canBet) return { error: 'CANNOT_BET' };
        if (action === 'raise' && !legal.canRaise) return { error: 'CANNOT_RAISE' };
        if (total > legal.maxTotal) return { error: 'NOT_ENOUGH_CHIPS' };
        // Anything below the legal minimum is only allowed as a full all-in.
        if (total < legal.minTotal && total !== legal.maxTotal)
          return { error: 'BELOW_MIN_RAISE' };
        if (total <= legal.currentBet && total !== legal.maxTotal)
          return { error: 'BELOW_MIN_RAISE' };
      }
      if (action === 'allin' && total <= h.currentBet) {
        // All-in that does not even cover the call: treated as a call.
        const amt = Math.min(p.stack, Math.max(0, h.currentBet - p.bet));
        commit(p, amt);
        p.acted = true;
        p.lastAction = 'ALL-IN';
        p.lastAmount = amt;
        entry = { type: 'allin-call', amount: amt, total: p.bet };
        break;
      }
      const added = total - p.bet;
      if (added <= 0) return { error: 'BAD_AMOUNT' };
      commit(p, added);

      const increment = total - h.currentBet;
      const fullRaise = increment >= h.minRaise || h.currentBet === 0;
      const wasOpen = h.currentBet === 0;
      h.currentBet = Math.max(h.currentBet, total);
      if (fullRaise) h.minRaise = Math.max(h.minRaise, increment);

      for (const other of room.players) {
        if (other.id === p.id || !other.inHand || other.folded || other.allIn)
          continue;
        other.acted = false; // must respond to the new price
        if (!fullRaise) other.raiseLocked = other.raiseLocked || other.lastAction != null;
        else other.raiseLocked = false;
      }
      p.acted = true;
      p.lastAction = p.allIn ? 'ALL-IN' : wasOpen ? 'BET' : 'RAISE';
      p.lastAmount = total;
      entry = {
        type: p.allIn ? 'allin' : wasOpen ? 'bet' : 'raise',
        amount: added,
        total,
      };
      break;
    }
    default:
      return { error: 'UNKNOWN_ACTION' };
  }

  h.log.push({
    ...entry,
    playerId: p.id,
    name: p.name,
    street: h.street,
    stack: p.stack,
    at: Date.now(),
  });

  settle(room);
  return { ok: true, action: entry.type };
}

function commit(p, amount) {
  const amt = Math.min(amount, p.stack);
  p.stack -= amt;
  p.bet += amt;
  p.committed += amt;
  if (p.stack === 0) p.allIn = true;
  return amt;
}

/* --------------------------------------------------- street / hand engine */

/** Advance the hand as far as it can go without further human input. */
function settle(room) {
  const h = room.hand;
  let guard = 0;
  while (h.phase === 'betting' && guard++ < 12) {
    const live = livePlayers(room);
    if (live.length <= 1) return toShowdown(room); // everyone folded out

    if (!roundComplete(room)) {
      const cur = seatIndex(room, h.actorId);
      const curP = cur >= 0 ? room.players[cur] : null;
      // The player on the clock keeps it until they have actually responded.
      if (curP && curP.inHand && !curP.folded && !curP.allIn && needsToAct(room, curP))
        return;
      const from = cur >= 0 ? cur : seatIndex(room, room.dealerId);
      const nextIdx = nextSeat(
        room,
        from,
        (p) => p.inHand && !p.folded && !p.allIn && needsToAct(room, p)
      );
      if (nextIdx >= 0) {
        h.actorId = room.players[nextIdx].id;
        return;
      }
    }
    if (!nextStreet(room)) return;
  }
}

function needsToAct(room, p) {
  return !p.acted || p.bet < room.hand.currentBet;
}

function roundComplete(room) {
  const h = room.hand;
  const live = livePlayers(room);
  const actors = actingPlayers(room);
  if (actors.length === 0) return true;
  if (actors.length === 1) {
    const p = actors[0];
    const maxOther = live
      .filter((x) => x.id !== p.id)
      .reduce((m, x) => Math.max(m, x.bet), 0);
    // Nothing left to match and nobody left who could call a raise.
    return p.bet >= Math.min(maxOther, h.currentBet);
  }
  return actors.every((p) => p.acted && p.bet >= h.currentBet);
}

/** @returns false when the hand moved to showdown instead. */
function nextStreet(room) {
  const h = room.hand;
  for (const p of room.players) {
    p.bet = 0;
    p.acted = false;
    p.raiseLocked = false;
    if (p.inHand && !p.folded) p.lastAction = null;
  }
  h.currentBet = 0;
  h.minRaise = room.settings.bigBlind;

  // Not enough players able to bet -> the rest of the board is a formality.
  if (actingPlayers(room).length <= 1) {
    h.runout = true;
    toShowdown(room);
    return false;
  }
  const i = STREETS.indexOf(h.street);
  if (i >= STREETS.length - 1) {
    toShowdown(room);
    return false;
  }
  h.street = STREETS[i + 1];
  h.log.push({ type: 'street', street: h.street, at: Date.now() });

  const dIdx = seatIndex(room, room.dealerId);
  const firstIdx = nextSeat(
    room,
    dIdx >= 0 ? dIdx : -1,
    (p) => p.inHand && !p.folded && !p.allIn
  );
  h.actorId = firstIdx >= 0 ? room.players[firstIdx].id : null;
  return true;
}

/* -------------------------------------------------------------- side pots */

export function computePots(room) {
  const contribs = room.players
    .filter((p) => p.committed > 0)
    .map((p) => ({
      id: p.id,
      amt: p.committed,
      live: p.inHand && !p.folded,
    }));
  if (contribs.length === 0) return [];

  const levels = [...new Set(contribs.map((c) => c.amt))].sort((a, b) => a - b);
  const raw = [];
  let prev = 0;
  for (const L of levels) {
    let amount = 0;
    for (const c of contribs) {
      amount += Math.max(0, Math.min(c.amt, L) - Math.min(c.amt, prev));
    }
    const eligible = contribs.filter((c) => c.live && c.amt >= L).map((c) => c.id);
    if (amount > 0) raw.push({ amount, eligible });
    prev = L;
  }

  const merged = [];
  for (const pot of raw) {
    const last = merged[merged.length - 1];
    if (pot.eligible.length === 0) {
      // Only dead money at this level (can happen if the biggest bettor folds).
      if (last) last.amount += pot.amount;
      else {
        const sole = contribs.find((c) => c.live);
        merged.push({ amount: pot.amount, eligible: sole ? [sole.id] : [] });
      }
      continue;
    }
    if (last && sameSet(last.eligible, pot.eligible)) last.amount += pot.amount;
    else merged.push({ amount: pot.amount, eligible: [...pot.eligible] });
  }
  return merged.map((p, i) => ({
    index: i,
    amount: p.amount,
    eligible: p.eligible,
    label: i === 0 ? 'main' : 'side',
    sideNo: i,
    winners: [],
  }));
}

function toShowdown(room) {
  const h = room.hand;
  h.pots = computePots(room);
  h.phase = 'showdown';
  h.actorId = null;

  // Uncontested pots need no human decision.
  for (const pot of h.pots) {
    if (pot.eligible.length === 1) pot.winners = [pot.eligible[0]];
  }
  if (h.pots.every((p) => p.winners.length > 0)) {
    awardPots(room, h.pots.map((p) => p.winners), { auto: true });
  }
}

/* ---------------------------------------------------------------- payouts */

/**
 * @param assignments array aligned with hand.pots, each an array of winner ids
 */
/**
 * Splits each pot between its winners. Odd chips go to the first winner left
 * of the button — the usual house rule.
 *
 * Pure: it never touches stacks. Both the real payout and the preview the
 * dealer confirms go through here, so what they see is what they get.
 */
export function distribution(room, pots) {
  const dIdx = Math.max(0, seatIndex(room, room.dealerId));
  const n = room.players.length || 1;
  const orderFromButton = room.players
    .map((p, idx) => ({ p, rank: (idx - dIdx - 1 + n * 2) % n }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.p.id);

  const totals = new Map();
  const perPot = [];
  for (const pot of pots) {
    const winners = [...(pot.winners || [])].sort(
      (a, b) => orderFromButton.indexOf(a) - orderFromButton.indexOf(b)
    );
    const shares = [];
    if (winners.length) {
      const base = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - base * winners.length;
      for (const id of winners) {
        let share = base;
        if (remainder > 0) {
          share += 1;
          remainder -= 1;
        }
        shares.push({ id, share });
        totals.set(id, (totals.get(id) || 0) + share);
      }
    }
    perPot.push(shares);
  }
  return { totals, perPot };
}

/** What the current selections would pay out, for the dealer's review screen. */
export function previewPayouts(room) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return [];
  const { totals } = distribution(room, h.pots);
  return [...totals]
    .map(([id, amount]) => ({
      playerId: id,
      name: room.players.find((p) => p.id === id)?.name ?? '?',
      amount,
    }))
    .sort((a, b) => b.amount - a.amount);
}

export function awardPots(room, assignments, opts = {}) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return { error: 'NOT_SHOWDOWN' };
  if (!Array.isArray(assignments) || assignments.length !== h.pots.length)
    return { error: 'BAD_ASSIGNMENT' };

  for (let i = 0; i < h.pots.length; i++) {
    const winners = [...new Set(assignments[i] || [])].filter((id) =>
      h.pots[i].eligible.includes(id)
    );
    if (winners.length === 0) return { error: 'NO_WINNER_SELECTED' };
    h.pots[i].winners = winners;
  }

  const { totals, perPot } = distribution(room, h.pots);
  for (const shares of perPot) {
    for (const { id, share } of shares) {
      const pl = room.players.find((x) => x.id === id);
      if (!pl) continue;
      pl.stats.potsWon += 1;
      pl.stats.biggestPot = Math.max(pl.stats.biggestPot, share);
    }
  }

  const payouts = [];
  for (const [id, amount] of totals) {
    const pl = room.players.find((x) => x.id === id);
    if (!pl) continue;
    pl.stack += amount;
    payouts.push({ playerId: id, name: pl.name, amount });
  }

  h.payouts = payouts;
  h.phase = 'complete';
  h.endedAt = Date.now();
  h.auto = !!opts.auto;

  for (const p of room.players) {
    if (p.inHand) p.stats.handsPlayed += 1;
    p.bet = 0;
  }

  room.history.unshift({
    no: h.no,
    endedAt: h.endedAt,
    pot: totalPot(room),
    payouts,
    runout: h.runout,
    log: h.log,
    pots: h.pots.map((p) => ({
      amount: p.amount,
      label: p.label,
      sideNo: p.sideNo,
      winners: p.winners,
    })),
  });
  if (room.history.length > 60) room.history.length = 60;

  return { ok: true, payouts };
}

/* ------------------------------------------------------------ end of game */

export function gameOverCheck(room) {
  // Only people who actually play count — a dealer holding chips is not
  // an opponent anybody can win them from.
  const contenders = room.players.filter((p) => p.role !== 'dealer' && p.stack > 0);
  return contenders.length <= 1;
}

export function results(room) {
  return room.players
    .map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role || 'player',
      isHost: p.id === room.hostId,
      stack: p.stack,
      buyIn: p.stats.buyIn,
      net: p.stack - p.stats.buyIn,
      handsPlayed: p.stats.handsPlayed,
      potsWon: p.stats.potsWon,
      biggestPot: p.stats.biggestPot,
    }))
    .sort((a, b) => b.stack - a.stack || b.net - a.net);
}
