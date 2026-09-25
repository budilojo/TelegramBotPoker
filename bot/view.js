'use strict';
/**
 * What ONE person sees at the table. A pure function `(room, viewer) -> state`
 * that the server sends to that person's Mini App and to nobody else.
 *
 * This is where "nobody sees somebody else's cards" is actually enforced.
 * Hiding a card in the interface is not enough — whatever reaches a phone can
 * be read off it — so a card that the viewer may not see is never put into
 * their state in the first place:
 *
 *   - your own two cards — to you;
 *   - somebody else's — only once they must be shown at showdown (pot winners
 *     and all-ins), and during an all-in reveal only the all-in hands;
 *   - the board — only as far as the table has seen it;
 *   - the deck, the cursor, anybody's Telegram id — never.
 *
 * Players are addressed by seat index, as the buttons in the group were.
 */
import { legalActions, results, distribution } from '../server/game.js';
import {
  isHost, isSeated, findPlayer, roleOf, dealers, isLive, canDecideWinner, openPots, preview, startBlocker,
  turnKey, MAX_SEATS,
} from './room.js';
import { boardShown, BOARD_SIZE } from './cards.js';
import { RANKS, rankOf, suitOf } from './deck.js';
import { best5 } from './eval.js';

const SUIT_CODE = ['S', 'H', 'D', 'C'];

/** 0..51 -> "AS", "10H" — the file name of the card picture. */
export const cardCode = (c) => RANKS[rankOf(c)] + SUIT_CODE[suitOf(c)];
const codes = (cs) => (cs || []).map(cardCode);

/** A stable colour for an avatar, without sending anybody's id. */
function hueOf(id) {
  // FNV-1a, then the golden angle: neighbouring ids (101, 102…) must still
  // land far apart on the colour wheel.
  let h = 0x811c9dc5;
  for (const ch of String(id)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return Math.round((h % 1000) * 137.508) % 360;
}

/** Pot-sized raise, the same formula as the web bet sheet and the old keyboard. */
const potRaise = (l, f) => Math.round(l.myBet + l.toCall + (l.potTotal + l.toCall) * f);

/**
 * Raise sizes that make sense right now, each with its final total. A size
 * below the minimum raise or at/above the stack is not offered — the latter is
 * ALL-IN, which comes last and on its own.
 */
export function presets(room, l) {
  if (!l || !(l.canBet || l.canRaise)) return [];
  const bb = room.settings.bigBlind;
  const raw = [
    [`+${bb}`, l.currentBet + bb],
    ['½ POT', potRaise(l, 0.5)],
    ['POT', potRaise(l, 1)],
  ];
  const out = [];
  const seen = new Set();
  for (const [label, total] of raw) {
    const t = Math.round(total);
    if (t < l.minTotal || t >= l.maxTotal || seen.has(t)) continue;
    seen.add(t);
    out.push({ label, total: t, kind: 'size' });
  }
  out.sort((a, b) => a.total - b.total);
  if (l.maxTotal > l.currentBet) out.push({ label: 'ALL-IN', total: l.maxTotal, kind: 'allin' });
  return out;
}

/** What the plate under a player says: one word (and an amount) for "what is up with them". */
function plateOf(room, p, isActor) {
  const h = room.hand;
  if (room.status === 'lobby' || !h) return { status: p.sittingOut ? 'out' : 'ready' };
  if (!p.inHand) {
    if (p.left) return { status: 'left' };
    if (p.sittingOut) return { status: 'out' };
    if (p.stack <= 0) return { status: 'broke' };
    return { status: 'wait' };
  }
  if (h.phase === 'complete') {
    if (p.folded) return { status: 'fold' };
    return { status: p.allIn ? 'allin' : 'in' };
  }
  if (isActor) return { status: 'turn' };
  if (p.folded) return { status: 'fold' };
  if (p.allIn) return { status: 'allin', amount: p.bet || 0 };
  const map = { CHECK: 'check', CALL: 'call', BET: 'bet', RAISE: 'raise', SB: 'sb', BB: 'bb' };
  const st = map[p.lastAction];
  if (st) return { status: st, amount: st === 'check' ? 0 : p.bet };
  return { status: 'in' };
}

/** Which other players' cards the viewer is entitled to see right now. */
function visibleShown(room) {
  const h = room.hand;
  if (!h || h.phase !== 'complete' || !h.shown) return {};
  const revealing = room.ui?.reveal?.handNo === h.no;
  const out = {};
  for (const [id, s] of Object.entries(h.shown)) {
    const p = findPlayer(room, id);
    // While the board is still being turned over, only all-in hands are on
    // their backs — a winner who is not all-in shows at the end, not before.
    if (revealing && !p?.allIn) continue;
    out[id] = revealing ? { cards: s.cards } : { cards: s.cards, name: s.name };
  }
  return out;
}

/** How the finished hand ended: winners, refunds, pots — for the table and the group card. */
export function resultOf(room) {
  const h = room.hand;
  if (!h || h.phase !== 'complete') return null;
  if (room.ui?.reveal?.handNo === h.no) return null; // not before the river is out
  const seat = (id) => room.players.findIndex((p) => p.id === id);
  if (h.aborted) return { kind: 'aborted', winners: [], refunds: [], pots: [] };

  const won = new Map();
  const back = new Map();
  if (h.pots?.length) {
    const { perPot } = distribution(room, h.pots);
    h.pots.forEach((pot, i) => {
      const into = pot.eligible.length > 1 ? won : back;
      for (const { id, share } of perPot[i]) into.set(id, (into.get(id) || 0) + share);
    });
  }
  // Everybody else folded: with dealt cards the bot never had to show
  // anything; with real cards the dealer never had to decide anything.
  const byFold = h.live ? !h.decided : !h.shown;
  // A pot everybody else folded away from is a win, not a refund.
  if (byFold) {
    for (const [id, amt] of back) won.set(id, (won.get(id) || 0) + amt);
    back.clear();
  }
  const shown = h.shown || {};
  return {
    kind: byFold ? 'fold' : h.live ? 'dealer' : 'showdown',
    winners: [...won].map(([id, amount]) => ({ seat: seat(id), amount, hand: shown[id]?.name ?? null })),
    refunds: [...back].map(([id, amount]) => ({ seat: seat(id), amount })),
    pots: (h.pots || []).map((pot, i) => ({
      label: i === 0 ? 'MAIN POT' : `SIDE POT ${i}`,
      amount: pot.amount,
      winners: pot.winners.map(seat),
      refund: pot.eligible.length === 1,
    })),
  };
}

/** The dealer's "who won?" flow, with real cards. */
function winnerFlowOf(room, viewerId) {
  const h = room.hand;
  if (!h || !h.live || h.phase !== 'showdown' || !room.ui?.winner) return null;
  const seat = (id) => room.players.findIndex((p) => p.id === id);
  const d = dealers(room)[0];
  return {
    potIndex: room.ui.winner.potIndex,
    review: !!room.ui.winner.review,
    steps: openPots(room),
    canDecide: canDecideWinner(room, viewerId),
    // Whose job it is first: the dealer — or, with no dealer, anyone seated.
    // The host can also decide (a dead phone must not freeze the table), but
    // the "who won?" screen should not jump up in their face.
    primary: d ? d.id === String(viewerId) : isSeated(room, viewerId),
    decider: d ? d.name : null,
    pots: h.pots.map((pot, i) => ({
      index: i,
      label: i === 0 ? 'MAIN POT' : `SIDE POT ${i}`,
      amount: pot.amount,
      eligible: pot.eligible.map(seat),
      winners: pot.winners.map(seat),
      refund: pot.eligible.length === 1,
    })),
    // The engine's own preview — the same numbers the confirm will pay.
    preview: room.ui.winner.review ? preview(room).map((x) => ({ seat: seat(x.playerId), name: x.name, amount: x.amount })) : [],
  };
}

/** A short name for your own hand; pre-flop only a pocket pair is worth saying. */
function myHandName(hole, board) {
  if (!hole) return null;
  if (board.length >= 3) return best5([...hole, ...board]).name;
  if (rankOf(hole[0]) === rankOf(hole[1])) return `Пара ${RANKS[rankOf(hole[0])]}`;
  return null;
}

/**
 * @param viewerId  the Telegram id from a VERIFIED initData — never from the page
 * @param now       server clock, so the page can count timers down correctly
 */
export function tableView(room, viewerId, { now = Date.now(), botUsername = '' } = {}) {
  const uid = String(viewerId);
  const h = room.hand;
  const meP = findPlayer(room, uid);
  const mySeat = room.players.findIndex((p) => p.id === uid);
  const live = isLive(room);
  const board = h ? boardShown(room) : [];
  const shownOthers = visibleShown(room);
  // The pot is paid the moment the betting ends — but while an all-in board
  // is still being turned over, a stack that already grew would give the
  // river away. Until the last card is out, stacks read as before the payout.
  const revealing = !!h && room.ui?.reveal?.handNo === h.no;
  const unpaid = new Map(revealing ? (h.payouts || []).map((x) => [x.playerId, x.amount]) : []);

  const players = room.players.map((p, seat) => {
    if (p.kicked && !p.inHand) return null; // a removed player has no chair any more
    const isActor = !!h && h.phase === 'betting' && h.actorId === p.id && room.status === 'playing';
    const plate = plateOf(room, p, isActor);
    const seen = p.id === uid ? null : shownOthers[p.id] || null;
    return {
      seat,
      name: p.name,
      hue: hueOf(p.id),
      stack: p.stack - (unpaid.get(p.id) || 0),
      bet: h && h.phase !== 'complete' ? p.bet : 0,
      role: roleOf(p),
      pendingRole: p.pendingRole || null,
      isHost: isHost(room, p.id),
      isMe: p.id === uid,
      inHand: !!p.inHand,
      folded: !!p.folded,
      allIn: !!p.allIn,
      isActor,
      isButton: !!h && p.id === h.dealerId,
      isSB: !!h && p.id === h.sbId,
      isBB: !!h && p.id === h.bbId,
      ...plate,
      // Somebody else's cards: present ONLY when the showdown requires them.
      cards: seen ? codes(seen.cards) : null,
      handName: seen?.name ?? null,
      mucked: !!h && h.phase === 'complete' && !!h.mucked?.includes(p.id) && !(room.ui?.reveal?.handNo === h.no),
    };
  }).filter(Boolean);

  const mine = h && !live && meP ? h.holes?.[uid] ?? null : null;
  const turn = room.turn && room.turn.key === turnKey(room) ? room.turn : null;
  const legal =
    h && room.status === 'playing' && h.phase === 'betting' && h.actorId === uid ? legalActions(room, uid) : null;

  const decider = live ? dealers(room).some((d) => d.id === uid) || (!dealers(room).length && isSeated(room, uid)) || isHost(room, uid) : isSeated(room, uid) || isHost(room, uid);
  const canNext =
    !!h && h.phase === 'complete' && !revealing && room.status === 'playing' && decider;

  const liveBoard = !h
    ? 0
    : h.phase === 'showdown' || (h.phase === 'complete' && h.decided)
      ? 5
      : BOARD_SIZE[h.street] ?? 0;

  return {
    seq: room.seq,
    now,
    bot: botUsername,
    room: {
      code: room.code,
      title: room.title || '',
      status: room.status,
      cards: live ? 'live' : 'virtual',
      maxSeats: MAX_SEATS,
      seated: room.players.filter((p) => !p.kicked && !p.left && roleOf(p) === 'player').length,
      handNo: room.handNo,
      settings: {
        startingStack: room.settings.startingStack,
        smallBlind: room.settings.smallBlind,
        bigBlind: room.settings.bigBlind,
        turnSeconds: room.settings.turnSeconds || 0,
        blindMode: room.settings.blindMode,
        levelMinutes: room.settings.levelMinutes,
      },
      level: room.settings.blindMode === 'levels' ? room.level.index + 1 : null,
      pendingBlinds: room.pendingBlinds,
      notice: room.notice || null,
      hostName: findPlayer(room, room.hostId)?.name ?? null,
      dealerName: dealers(room)[0]?.name ?? null,
      startBlocker: room.status === 'lobby' ? startBlocker(room) : null,
    },
    me: {
      seat: mySeat,
      name: meP?.name ?? null,
      seated: isSeated(room, uid),
      isHost: isHost(room, uid),
      role: meP ? roleOf(meP) : null,
      kicked: !!meP?.kicked,
      sittingOut: !!meP?.sittingOut,
      inHand: !!meP?.inHand,
      folded: !!meP?.folded,
      allIn: !!meP?.allIn,
      notify: meP?.dm === 'ok',
      cards: codes(mine),
      handName: myHandName(mine, board),
    },
    players,
    hand: h
      ? {
          no: h.no,
          street: h.street,
          phase: h.phase,
          live: !!h.live,
          board: live ? [] : codes(board),
          boardSlots: live ? liveBoard : board.length,
          pot: h.phase === 'complete' ? room.history.find((x) => x.no === h.no)?.pot ?? 0 : room.players.reduce((s, p) => s + (p.committed || 0), 0),
          currentBet: h.phase === 'betting' ? h.currentBet : 0,
          actorSeat: h.phase === 'betting' && room.status === 'playing' ? room.players.findIndex((p) => p.id === h.actorId) : -1,
          deadline: turn?.deadline ?? null,
          revealing,
          result: resultOf(room),
        }
      : null,
    legal: legal ? { ...legal, presets: presets(room, legal) } : null,
    winnerFlow: winnerFlowOf(room, uid),
    autoNextAt: room.autoNext?.deadline ?? null,
    canNext,
    canStart: room.status === 'lobby' && isHost(room, uid) && !startBlocker(room),
    results: room.status === 'finished' ? resultsOf(room) : null,
  };
}

function resultsOf(room) {
  const byId = new Map(room.players.map((p) => [p.id, p]));
  return results(room)
    .map((r) => ({
      name: r.name,
      stack: r.stack,
      net: r.net,
      hands: r.handsPlayed,
      pots: r.potsWon,
      biggest: r.biggestPot,
      isHost: r.isHost,
      role: r.role,
      kicked: !!byId.get(r.id)?.kicked,
    }))
    .sort((a, b) => b.net - a.net || b.stack - a.stack);
}
