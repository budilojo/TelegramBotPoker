'use strict';
/**
 * The bot's own room layer.
 *
 * `server/rooms.js` cannot be reused: it is built around session tokens,
 * WebSocket snapshots and a `publicState` projection, none of which exist
 * here. What IS reused, deliberately and without a single line rewritten, is
 * `server/game.js` — the betting engine. Every chip that moves in this bot
 * moves through it. Cards ride on top of it in `cards.js`.
 *
 * Ideas carried over from the web layer: blinds parked until the next deal,
 * undo snapshots, the host permission kept separate from having a seat.
 *
 * What is deliberately NOT carried over: tokens, sessions, reconnection,
 * "game open in another tab" — Telegram hands us a signed identity on every
 * update. And the human dealer role with manual winner selection: here the
 * bot deals and reads the hands itself, so there is nobody to pick a winner
 * and nothing to pick.
 */
import crypto from 'node:crypto';
import {
  startHand,
  applyAction,
  legalActions,
  computePots,
  awardPots,
  previewPayouts,
  gameOverCheck,
  canDeal,
  clone,
} from '../server/game.js';
import { cleanName } from './fmt.js';
import { dealHoles, syncCards } from './cards.js';
import { shuffled } from './deck.js';

const UNDO_DEPTH = 40;
const HISTORY_DEPTH = 60;

/** With the turn timer on, the next hand is dealt this long after the last one ends. */
export const AUTO_NEXT_MS = 10_000;
/** This many timed-out turns in a row and the player is sat out. */
export const TIMEOUTS_TO_SIT_OUT = 2;
/** Seats at the table. More does not fit legibly on a phone screen. */
export const MAX_SEATS = 8;

/**
 * The room's public handle — what goes into `startapp=` of the table link.
 * Random and unrelated to the chat id: a link must not be guessable, and a
 * chat id must not leak through it.
 */
export function newRoomCode() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => abc[b % abc.length]).join('');
}

/** Where decks come from. Tests inject a stacked deck; production shuffles. */
const defaultDeck = () => shuffled();

/* ------------------------------------------------------------------ model */

export function createRoom({ chatId, host, title = '', code = newRoomCode(), startingStack = 10000, smallBlind = 25, bigBlind = 50 }) {
  const sb = intIn(smallBlind, 1, 1_000_000, 25);
  const bb = intIn(bigBlind, sb, 2_000_000, Math.max(sb * 2, 50));
  const stack = intIn(startingStack, bb, 100_000_000, 10_000);

  const room = {
    chatId: String(chatId),
    code,
    title: cleanName(title, '', 40),
    createdAt: Date.now(),
    touchedAt: Date.now(),
    status: 'lobby', // lobby | playing | paused | finished
    settings: {
      startingStack: stack,
      smallBlind: sb,
      bigBlind: bb,
      blindMode: 'fixed', // 'fixed' | 'levels'
      levelMinutes: 20,
      schedule: makeSchedule(sb, bb),
      turnSeconds: 0, // 0 = no turn timer; the host opts in with /timer
      // 'virtual' — the bot shuffles, deals and reads the hands.
      // 'live'    — real cards on a real table: the app keeps the chips, a
      //             human dealer (or the table) says who won.
      cards: 'virtual',
    },
    level: { index: 0, elapsedMs: 0, runningSince: null },
    pendingBlinds: null,
    turn: null, // { key, actorId, deadline, remaining } — the turn timer
    autoNext: null, // { key, deadline, remaining } — the next deal, with the timer on
    players: [],
    hostId: null,
    dealerId: null, // the BUTTON seat (engine naming), not a person dealing
    dealerSeat: -1,
    handNo: 0,
    hand: null,
    history: [],
    seq: 1,
    undo: [],
    notice: null,
    finishedAt: null,
    // Everything Telegram-shaped lives under `ui` so the game state stays
    // a plain object the engine understands.
    ui: {
      tableMessageId: null,
      lastText: null,
      lastKb: null,
      lastMsgId: 0, // newest message id seen in the chat — to tell if the table got buried
      pendingBet: null, // { userId, promptMessageId }
      armedAllIn: null, // { userId } — ALL-IN by button needs a second tap
      reveal: null, // { handNo, shown } — an all-in board being turned card by card
      winner: null, // { potIndex, review } — live cards: which pot the dealer is deciding
    },
  };
  if (host) {
    const p = addPlayer(room, host);
    room.hostId = p.id;
  }
  return room;
}

/**
 * @returns the player row, or `{ error }` for somebody the host removed.
 */
export function addPlayer(room, user) {
  const existing = room.players.find((p) => p.id === String(user.id));
  if (existing) {
    // A removed player does not get to walk back in on their own.
    if (existing.kicked) return { error: 'KICKED' };
    // One Telegram account, one seat. A repeat /join returns the same row —
    // and brings back somebody who had left the chat or stood up.
    existing.name = cleanName(user.name, existing.name);
    if (existing.left || existing.sittingOut) {
      existing.left = false;
      existing.sittingOut = false;
      existing.timeouts = 0;
      touch(room);
    }
    return existing;
  }
  const taken = room.players.filter((x) => !x.kicked && !x.left && x.role !== 'dealer').length;
  if (taken >= MAX_SEATS) return { error: 'TABLE_FULL' };
  const p = {
    id: String(user.id),
    tgId: Number(user.tgId ?? user.id),
    name: cleanName(user.name, `Игрок ${room.players.length + 1}`),
    stack: room.settings.startingStack,
    joinedAt: Date.now(),
    sittingOut: false,
    left: false,
    kicked: false,
    timeouts: 0, // turns in a row lost to the timer
    dm: user.dm ?? null, // 'ok' | 'fail' | null — can the bot write to them?
    role: 'player', // 'player' | 'dealer' — the engine never deals a dealer in
    pendingRole: null, // a role change asked for mid-hand lands at the next deal
    waiting: room.status !== 'lobby', // joined mid-game -> dealt in next hand
    inHand: false,
    folded: false,
    allIn: false,
    bet: 0,
    committed: 0,
    acted: false,
    raiseLocked: false,
    lastAction: null,
    lastAmount: 0,
    stats: {
      buyIn: room.settings.startingStack,
      handsPlayed: 0,
      potsWon: 0,
      biggestPot: 0,
    },
  };
  room.players.push(p);
  touch(room);
  return p;
}

export const findPlayer = (room, id) => room.players.find((p) => p.id === String(id)) || null;
const seatOf = (room, id) => room.players.findIndex((p) => p.id === String(id));

/** Somebody who is at the table right now — not removed, not gone from the chat. */
export const isSeated = (room, id) => {
  const p = findPlayer(room, id);
  return !!p && !p.kicked && !p.left;
};

function intIn(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

export function touch(room) {
  room.touchedAt = Date.now();
  room.seq += 1;
}

/* -------------------------------------------------------------- authority */

/**
 * Three separate checks, as in the web app. The host is a PERMISSION (run the
 * room); dealer is a ROLE (run the hand with real cards). A person can hold
 * both, either or neither, and no screen is keyed off a single field.
 */
export const isHost = (room, userId) => room.hostId === String(userId);
export const roleOf = (p) => (p?.role === 'dealer' ? 'dealer' : 'player');
export const dealers = (room) => room.players.filter((p) => roleOf(p) === 'dealer' && !p.kicked && !p.left);
export const isLive = (room) => room.settings.cards === 'live';

/**
 * Who may close a pot — only ever a question with real cards: when the bot
 * deals, it reads the hands itself and nobody decides anything. With a dealer
 * assigned it is their job (the host kept as a fallback, so a dead phone
 * cannot freeze the table). With no dealer, any seated participant.
 */
export function canDecideWinner(room, userId) {
  const d = dealers(room);
  if (d.length === 0) return isSeated(room, userId);
  if (d.some((x) => x.id === String(userId))) return true;
  return isHost(room, userId);
}

/* ------------------------------------------------------------------ roles */

function lockedInHand(room, p) {
  return !!room.hand && room.hand.phase !== 'complete' && p.inHand && !p.folded;
}

export function setRole(room, userId, targetId, role) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (role !== 'player' && role !== 'dealer') return { error: 'BAD_ROLE' };
  if (role === 'dealer' && !isLive(room)) return { error: 'NOT_LIVE' };
  const p = findPlayer(room, targetId);
  if (!p || p.kicked) return { error: 'NO_PLAYER' };
  if (roleOf(p) === role && !p.pendingRole) return { ok: true, noop: true };

  pushUndo(room, `роль: ${p.name}`);
  // Swapping a role mid-hand would strand chips in the pot, so it waits.
  if (lockedInHand(room, p)) {
    p.pendingRole = roleOf(p) === role ? null : role;
    if (p.pendingRole === 'dealer') {
      for (const other of room.players) {
        if (other.id !== p.id && other.pendingRole === 'dealer') other.pendingRole = null;
      }
    }
    room.notice = p.pendingRole
      ? `${p.name} станет ${role === 'dealer' ? 'дилером' : 'игроком'} со следующей раздачи`
      : null;
    touch(room);
    return { ok: true, deferred: true };
  }

  applyRole(room, p, role);
  room.notice = `${p.name} — ${role === 'dealer' ? 'дилер' : 'игрок'}`;
  touch(room);
  return { ok: true };
}

/**
 * One pair of hands deals the cards, so the DEALER role is handed over, never
 * cloned: giving it to somebody takes it off whoever held it or was queued.
 */
function clearOtherDealers(room, keepId) {
  for (const other of room.players) {
    if (other.id === keepId) continue;
    if (other.pendingRole === 'dealer') other.pendingRole = null;
    if (roleOf(other) === 'dealer') applyRole(room, other, 'player');
  }
}

function applyRole(room, p, role) {
  p.role = role;
  p.pendingRole = null;
  if (role === 'dealer') {
    clearOtherDealers(room, p.id);
    p.waiting = false;
  } else if (room.status !== 'lobby') {
    p.waiting = true; // back to the felt from the next hand on
  }
}

function applyPendingRoles(room) {
  for (const p of room.players) if (p.pendingRole) applyRole(room, p, p.pendingRole);
}

/* ----------------------------------------------------------- blind levels */

const LEVEL_MULTIPLIERS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

function makeSchedule(sb, bb) {
  return LEVEL_MULTIPLIERS.map((m) => ({
    sb: Math.max(1, Math.round(sb * m)),
    bb: Math.max(1, Math.round(bb * m)),
  }));
}

function levelElapsed(room) {
  const L = room.level;
  if (!L) return 0;
  return L.elapsedMs + (L.runningSince ? Date.now() - L.runningSince : 0);
}

const levelMs = (room) => (room.settings.levelMinutes || 20) * 60_000;
const lastLevel = (room) => room.level.index >= (room.settings.schedule?.length ?? 1) - 1;

function setLevelClock(room, running) {
  const L = room.level;
  if (!L) return;
  if (running && !L.runningSince) L.runningSince = Date.now();
  else if (!running && L.runningSince) {
    L.elapsedMs += Date.now() - L.runningSince;
    L.runningSince = null;
  }
}

/**
 * Blinds never change inside a hand: the engine re-reads settings.bigBlind
 * when it resets minRaise on every street, so an edit mid-hand would move the
 * goalposts under the players. Changes park here and land at the next deal.
 */
function queueBlinds(room, sb, bb) {
  room.pendingBlinds = { sb, bb };
}

function applyPendingBlinds(room) {
  const b = room.pendingBlinds;
  if (!b) return null;
  room.pendingBlinds = null;
  room.settings.smallBlind = b.sb;
  room.settings.bigBlind = b.bb;
  return b;
}

/** One level per expiry — a slow hand must never skip a whole step. */
function maybeAdvanceLevel(room) {
  if (room.settings.blindMode !== 'levels' || !room.level) return false;
  if (lastLevel(room) || levelElapsed(room) < levelMs(room)) return false;
  return advanceLevel(room);
}

function advanceLevel(room) {
  const next = room.settings.schedule?.[room.level.index + 1];
  if (!next) return false;
  room.level.index += 1;
  room.level.elapsedMs = 0;
  room.level.runningSince = room.status === 'playing' ? Date.now() : null;
  queueBlinds(room, next.sb, next.bb);
  room.notice = `Уровень ${room.level.index + 1}: блайнды ${next.sb}/${next.bb} со следующей раздачи`;
  return true;
}

export function bumpLevel(room, userId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.settings.blindMode !== 'levels') return { error: 'NOT_LEVELS' };
  if (lastLevel(room)) return { error: 'LAST_LEVEL' };
  pushUndo(room, 'повышение блайндов');
  advanceLevel(room);
  touch(room);
  return { ok: true };
}

/* ---------------------------------------------------------- undo snapshot */

/**
 * Undo is for the HOST'S OWN admin actions only: settings, blinds, re-buys,
 * removals, ending the game. It never reaches back past a card.
 *
 * With physical cards, undoing a bet was harmless: the cards did not change.
 * Here the bot holds the deck, and every rollback of play is an exploit:
 * undo a fold after the flop came -> you played the flop for free; undo the
 * deal itself -> a fresh shuffle, i.e. a redraw of the hand you did not
 * like. So any game event — a deal, a bet, a fold, a showdown — wipes the
 * undo stack. The only snapshots left are the ones taken since the last
 * card moved, and restoring them cannot show anybody anything new.
 */
const SNAPSHOT_KEYS = [
  'stack', 'inHand', 'folded', 'allIn', 'bet', 'committed', 'acted',
  'raiseLocked', 'lastAction', 'lastAmount', 'waiting', 'sittingOut', 'kicked', 'left', 'timeouts',
  'role', 'pendingRole',
];

function pushUndo(room, label) {
  room.undo.push({
    label,
    at: Date.now(),
    status: room.status,
    hand: room.hand ? clone(room.hand) : null,
    handNo: room.handNo,
    dealerId: room.dealerId,
    dealerSeat: room.dealerSeat,
    historyLen: room.history.length,
    settings: clone(room.settings),
    level: clone(room.level),
    pendingBlinds: room.pendingBlinds ? { ...room.pendingBlinds } : null,
    hostId: room.hostId,
    finishedAt: room.finishedAt,
    winner: room.ui.winner ? clone(room.ui.winner) : null,
    players: room.players.map((p) => {
      const snap = { id: p.id, stats: clone(p.stats) };
      for (const k of SNAPSHOT_KEYS) snap[k] = p[k];
      return snap;
    }),
    // Seats that existed at snapshot time: a lobby removal is a real splice.
    roster: room.players.map((p) => clone(p)),
  });
  if (room.undo.length > UNDO_DEPTH) room.undo.shift();
}

/** A card moved or chips were bet: nothing before this point is undoable. */
function sealUndo(room) {
  room.undo = [];
}

export function undo(room, userId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  const snap = room.undo.pop();
  if (!snap) return { error: 'NOTHING_TO_UNDO' };
  room.status = snap.status;
  room.hand = snap.hand ? clone(snap.hand) : null;
  room.handNo = snap.handNo;
  room.dealerId = snap.dealerId;
  room.dealerSeat = snap.dealerSeat;
  room.settings = clone(snap.settings);
  room.level = clone(snap.level);
  room.pendingBlinds = snap.pendingBlinds ? { ...snap.pendingBlinds } : null;
  room.hostId = snap.hostId;
  room.finishedAt = snap.finishedAt;
  if (room.history.length > snap.historyLen)
    room.history.splice(0, room.history.length - snap.historyLen);

  // Put back anyone spliced out in the lobby, keep anyone who joined since.
  const byId = new Map(room.players.map((p) => [p.id, p]));
  const restored = snap.roster.map((r) => byId.get(r.id) || clone(r));
  for (const p of room.players) if (!restored.includes(p)) restored.push(p);
  room.players = restored;

  for (const s of snap.players) {
    const p = findPlayer(room, s.id);
    if (!p) continue;
    for (const k of SNAPSHOT_KEYS) p[k] = s[k];
    p.stats = clone(s.stats);
  }
  room.ui.armedAllIn = null;
  room.ui.winner = snap.winner ? clone(snap.winner) : null;
  room.notice = `Отменено: ${snap.label}`;
  touch(room);
  return { ok: true, label: snap.label };
}

/* -------------------------------------------------------------- game flow */

/** Players who get cards next hand. */
const dealable = (room) => room.players.filter((p) => canDeal(p) && !p.kicked && !p.left);

/** Why the table cannot start yet, or null when it can. */
export function startBlocker(room) {
  if (room.status !== 'lobby') return 'Игра уже идёт.';
  const n = dealable(room).length;
  if (n < 2) return n === 0 ? 'За столом никого нет.' : 'Нужен ещё хотя бы один игрок.';
  return null;
}

/**
 * Deal a hand: the engine posts blinds and sets the order, then the cards go
 * out. If the blinds alone put everybody all-in, `syncCards` runs the board
 * and the showdown right here — there is nobody left to act.
 */
function deal(room, deckFn) {
  const r = startHand(room);
  if (r.error) return r;
  room.hand.voluntary = 0; // moves people made themselves this hand
  room.hand.timeouts = 0; // moves the timer made for them
  room.autoNext = null;
  room.ui.reveal = null;
  room.ui.winner = null;
  if (isLive(room)) {
    // Real cards: the dealer at the table deals them. The bot holds no deck.
    room.hand.live = true;
  } else {
    dealHoles(room, deckFn());
  }
  syncCards(room);
  if (room.hand.phase === 'showdown') openWinnerFlow(room); // blinds alone put all in
  sealUndo(room);
  return { ok: true };
}

export function startGame(room, userId, { deck = defaultDeck } = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status !== 'lobby') return { error: 'ALREADY_STARTED' };
  applyPendingRoles(room);
  if (dealable(room).length < 2) return { error: 'NOT_ENOUGH_PLAYERS' };
  room.players.forEach((p) => (p.waiting = false));
  room.status = 'playing';
  setLevelClock(room, true);
  applyPendingBlinds(room);
  const r = deal(room, deck);
  if (r.error) {
    room.status = 'lobby';
    setLevelClock(room, false);
    return r;
  }
  room.notice = null;
  afterHandMaybeOver(room);
  touch(room);
  return { ok: true };
}

/**
 * @param auto  dealt by the table's own clock (turn timer on), not by a person
 */
export function nextHand(room, userId, { deck = defaultDeck, auto = false } = {}) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status === 'paused') return { error: 'GAME_PAUSED' };
  if (room.status === 'lobby') return { error: 'NOT_PLAYING' };
  if (room.hand && room.hand.phase !== 'complete') return { error: 'HAND_IN_PROGRESS' };
  if (!auto && !isSeated(room, userId) && !isHost(room, userId)) return { error: 'NOT_SEATED' };

  // Pacing belongs to whoever holds the deck: with a dealer at a real table,
  // an eager tap from a player would post blinds before the cards are shuffled.
  if (!auto && isLive(room) && dealers(room).length > 0 && !isHost(room, userId) &&
      !dealers(room).some((d) => d.id === String(userId))) {
    return { error: 'DEALER_DEALS' };
  }

  applyPendingRoles(room);
  if (dealable(room).length < 2) {
    touch(room);
    const withChips = room.players.filter((p) => !p.kicked && !p.left && p.stack > 0);
    if (withChips.length <= 1) {
      finish(room);
      return { ok: true, finished: true };
    }
    return { error: 'NOT_ENOUGH_PLAYERS' };
  }

  maybeAdvanceLevel(room);
  applyPendingBlinds(room);

  const r = deal(room, deck);
  if (r.error) return r;
  room.status = 'playing';
  room.ui.armedAllIn = null;
  room.notice = null;
  afterHandMaybeOver(room);
  touch(room);
  return { ok: true };
}

/**
 * A betting action. `seq` is the room counter the button was rendered with:
 * anything stale (double tap, slow network, someone else acted first) is
 * dropped without touching a single chip. Text commands carry no seq.
 */
export function act(room, userId, action, amount, seq) {
  if (room.status === 'paused') return { error: 'GAME_PAUSED' };
  if (room.status !== 'playing') return { error: 'NOT_PLAYING' };
  if (!room.hand) return { error: 'NO_HAND' };
  if (typeof seq === 'number' && seq !== room.seq) return { error: 'STALE', seq: room.seq };
  // The identity check that this whole bot is built around.
  if (room.hand.actorId !== String(userId)) return { error: 'NOT_YOUR_TURN' };

  // The engine validates `bet`/`raise` against `raiseLocked` but lets `allin`
  // through unchecked, so a player frozen out of raising can still re-open the
  // betting by shoving (see ENGINE-NOTE.md, finding B). Hiding the button is
  // not enough — a button is never a permission, and a typed /allin has no
  // button at all — so the rule is enforced here.
  if (action === 'allin') {
    const l = legalActions(room, String(userId));
    if (l && l.maxTotal > l.currentBet && !(l.canBet || l.canRaise)) {
      return { error: 'CANNOT_RAISE' };
    }
  }

  const h = room.hand;
  const r = applyAction(room, String(userId), action, amount);
  if (r.error) return r;
  room.notice = null; // a notice is news, not furniture: the next action clears it
  const p = findPlayer(room, userId);
  if (p) p.timeouts = 0; // they are here
  h.voluntary = (h.voluntary || 0) + 1;
  afterMove(room);
  return r;
}

/** Everything that follows a move, whoever or whatever made it. */
function afterMove(room) {
  room.ui.armedAllIn = null;
  room.ui.pendingBet = null;
  syncCards(room);
  // Real cards: the engine stops at the showdown and waits for a human.
  if (room.hand?.phase === 'showdown') openWinnerFlow(room);
  sealUndo(room);
  afterHandMaybeOver(room);
  touch(room);
}

/* ---------------------------------------------- winner selection (real cards) */

/** Pots that need a human decision — a pot with one claimant is a refund. */
export function openPots(room) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return [];
  return h.pots.map((p, i) => i).filter((i) => h.pots[i].eligible.length > 1);
}

function openWinnerFlow(room) {
  if (room.ui.winner) return;
  const steps = openPots(room);
  room.ui.winner = steps.length ? { potIndex: steps[0], review: false } : { potIndex: -1, review: true };
}

/** Mark or unmark `seat` as a winner of pot `potIndex`. Several = a split. */
export function toggleWinner(room, userId, potIndex, seat) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return { error: 'NOT_SHOWDOWN' };
  if (!canDecideWinner(room, userId)) return { error: 'DEALER_DECIDES' };
  const pot = h.pots[potIndex];
  if (!pot || pot.eligible.length < 2) return { error: 'BAD_POT' };
  const p = room.players[seat];
  // A folded player is never eligible — the one mistake that cannot be made.
  if (!p || !pot.eligible.includes(p.id)) return { error: 'NOT_ELIGIBLE' };
  const at = pot.winners.indexOf(p.id);
  if (at >= 0) pot.winners.splice(at, 1);
  else pot.winners.push(p.id);
  touch(room);
  return { ok: true, name: p.name, on: at < 0 };
}

/** Move to the next undecided pot, or to the review screen. */
export function winnerNext(room, userId) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return { error: 'NOT_SHOWDOWN' };
  if (!canDecideWinner(room, userId)) return { error: 'DEALER_DECIDES' };
  const w = room.ui.winner;
  if (!w || w.review) return { error: 'BAD_STEP' };
  if (!h.pots[w.potIndex] || h.pots[w.potIndex].winners.length === 0) return { error: 'NO_WINNER_SELECTED' };
  const steps = openPots(room);
  const nextIdx = steps[steps.indexOf(w.potIndex) + 1];
  room.ui.winner = nextIdx === undefined ? { potIndex: -1, review: true } : { potIndex: nextIdx, review: false };
  touch(room);
  return { ok: true };
}

export function winnerBack(room, userId) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return { error: 'NOT_SHOWDOWN' };
  if (!canDecideWinner(room, userId)) return { error: 'DEALER_DECIDES' };
  const steps = openPots(room);
  const w = room.ui.winner;
  if (!w) return { error: 'BAD_STEP' };
  if (w.review) {
    if (!steps.length) return { error: 'BAD_STEP' };
    room.ui.winner = { potIndex: steps[steps.length - 1], review: false };
  } else {
    const at = steps.indexOf(w.potIndex);
    if (at <= 0) return { error: 'BAD_STEP' };
    room.ui.winner = { potIndex: steps[at - 1], review: false };
  }
  touch(room);
  return { ok: true };
}

/**
 * The preview the dealer confirms and the real payout are THE SAME function
 * in the engine (`distribution`), so the numbers on screen cannot drift from
 * the numbers that land in the stacks.
 */
export const preview = (room) => previewPayouts(room);

/** Chips move here, and only here — after the review screen. */
export function confirmWinners(room, userId, seq) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return { error: 'NOT_SHOWDOWN' };
  if (!canDecideWinner(room, userId)) return { error: 'DEALER_DECIDES' };
  if (typeof seq === 'number' && seq !== room.seq) return { error: 'STALE', seq: room.seq };
  if (!room.ui.winner?.review) return { error: 'BAD_STEP' };
  if (h.pots.some((p) => p.winners.length === 0)) return { error: 'NO_WINNER_SELECTED' };

  // Real cards: undoing a mis-tapped result reveals nothing the table did not
  // see, so — unlike a dealt deck — this is allowed until the next deal.
  pushUndo(room, `итог раздачи #${h.no}`);
  const r = awardPots(room, h.pots.map((p) => p.winners));
  if (r.error) {
    room.undo.pop();
    return r;
  }
  h.decided = true;
  room.ui.winner = null;
  afterHandMaybeOver(room);
  touch(room);
  return r;
}

/* ------------------------------------------------------------- turn timer */

/**
 * Identifies one turn: the hand, how far it has got, and who is on the
 * clock. The engine logs every move and every new street, so the key changes
 * with each of them — including when the same player acts twice in a row
 * across a street (heads-up big blind), who then gets a fresh clock.
 */
export function turnKey(room) {
  const h = room.hand;
  if (!h || h.phase !== 'betting' || !h.actorId) return null;
  return `${h.no}:${h.log.length}:${h.actorId}`;
}

/**
 * Bring the turn timer in line with the room. Idempotent — call it as often
 * as you like. A pause parks the clock (the remaining time is kept), and so
 * does saving to disk: time the bot spent down is nobody's time.
 *
 * @returns the timer, or null when there is none to run
 */
export function syncTurn(room, now) {
  const secs = room.settings.turnSeconds || 0;
  const key = turnKey(room);
  if (!secs || !key || (room.status !== 'playing' && room.status !== 'paused')) {
    room.turn = null;
    return null;
  }
  if (room.turn?.key !== key) {
    room.turn = { key, actorId: room.hand.actorId, deadline: null, remaining: secs * 1000 };
  }
  const t = room.turn;
  if (room.status === 'paused') {
    if (t.deadline != null) {
      t.remaining = Math.max(0, t.deadline - now);
      t.deadline = null;
    }
    return null;
  }
  if (t.deadline == null) t.deadline = now + t.remaining;
  return t;
}

/**
 * The clock ran out. The table's rule — which the host switched on — makes
 * the one move that costs nothing: check if it is free, fold if it is not.
 * Never a call, never a bet: the timer may end your hand, it may not spend
 * your chips.
 *
 * `key` is the turn the timer was armed for. If anything has happened since
 * (the player moved, a street turned, the hand ended) it no longer matches
 * and nothing is done — which is also what makes a late timer harmless.
 */
export function timeoutMove(room, key, now) {
  const t = room.turn;
  if (room.status !== 'playing') return { error: 'NOT_PLAYING' };
  if (!key || turnKey(room) !== key || !t || t.key !== key) return { error: 'STALE' };
  if (t.deadline == null || now < t.deadline) return { error: 'EARLY' };

  const h = room.hand;
  const p = findPlayer(room, h.actorId);
  const l = legalActions(room, p.id);
  const action = l?.canCheck ? 'check' : 'fold';
  const r = applyAction(room, p.id, action);
  if (r.error) return r;

  h.timeouts = (h.timeouts || 0) + 1;
  p.timeouts = (p.timeouts || 0) + 1;
  const what = action === 'check' ? 'чек' : 'фолд';
  if (p.timeouts >= TIMEOUTS_TO_SIT_OUT) {
    p.sittingOut = true;
    room.notice = `${p.name}: время вышло — ${what}. Второй раз подряд — пропускает раздачи; /join, чтобы вернуться.`;
  } else {
    room.notice = `${p.name}: время вышло — ${what}.`;
  }
  afterMove(room);
  return { ok: true, action, playerId: p.id, satOut: p.sittingOut };
}

/* ------------------------------------------------------- automatic dealing */

/**
 * With the turn timer on, the table deals itself: AUTO_NEXT_MS after a hand
 * ends — and after an all-in board has finished turning over. Parked on
 * pause and on disk, like the turn timer.
 */
export function syncAutoNext(room, now) {
  const h = room.hand;
  const on =
    (room.settings.turnSeconds || 0) > 0 &&
    !isLive(room) && // real cards are shuffled by hand: the dealer paces the table
    (room.status === 'playing' || room.status === 'paused') &&
    h && h.phase === 'complete' &&
    !(room.ui.reveal && room.ui.reveal.handNo === h.no) &&
    room.autoNextHalted !== h.no; // it tried and there was nobody to deal to
  if (!on) {
    room.autoNext = null;
    return null;
  }
  const key = `next:${h.no}`;
  if (room.autoNext?.key !== key) room.autoNext = { key, deadline: null, remaining: AUTO_NEXT_MS };
  const a = room.autoNext;
  if (room.status === 'paused') {
    if (a.deadline != null) {
      a.remaining = Math.max(0, a.deadline - now);
      a.deadline = null;
    }
    return null;
  }
  if (a.deadline == null) a.deadline = now + a.remaining;
  return a;
}

/** The table's own clock deals the next hand, if it is still due. */
export function autoNextHand(room, key, now, opts = {}) {
  const a = room.autoNext;
  if (!a || a.key !== key || room.status !== 'playing') return { error: 'STALE' };
  if (a.deadline == null || now < a.deadline) return { error: 'EARLY' };
  room.autoNext = null;
  const r = nextHand(room, null, { ...opts, auto: true });
  if (r.error === 'NOT_ENOUGH_PLAYERS') {
    // Do not retry every ten seconds into an empty table: wait for a person
    // to press "next hand" (or /next) once people are back.
    room.autoNextHalted = room.hand?.no ?? null;
    room.notice = 'Автораздача остановлена: за столом меньше двух игроков. /join — вернуться, /next — раздать.';
    touch(room);
  }
  return r;
}

/**
 * Hand finished (by showdown or folds): trim history, end the game if it is
 * won — and if the timer played the whole hand while nobody moved a finger,
 * stop the table instead of letting it deal to an empty room forever.
 */
function afterHandMaybeOver(room) {
  const h = room.hand;
  if (!h || h.phase !== 'complete') return;
  if (room.history.length > HISTORY_DEPTH) room.history.length = HISTORY_DEPTH;
  const contenders = room.players.filter((p) => !p.kicked && !p.left);
  if (gameOverCheck({ players: contenders })) return finish(room);
  if ((h.timeouts || 0) > 0 && !(h.voluntary || 0) && room.status === 'playing') {
    room.status = 'paused';
    setLevelClock(room, false);
    room.notice = 'За всю раздачу никто не сходил сам — пауза. Хост продолжит: /resume.';
  }
}

function finish(room) {
  room.status = 'finished';
  room.finishedAt = Date.now();
  setLevelClock(room, false);
}

/* -------------------------------------------------------------- host acts */

export function setPaused(room, userId, paused) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status === 'lobby') return { error: 'NOT_PLAYING' };
  room.status = paused ? 'paused' : 'playing';
  setLevelClock(room, !paused); // a smoke break must not cost a blind level
  room.notice = paused ? 'Пауза' : null;
  touch(room);
  return { ok: true };
}

export function adjustStack(room, userId, targetId, delta) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  const p = findPlayer(room, targetId);
  if (!p || p.kicked) return { error: 'NO_PLAYER' };
  const d = Math.round(Number(delta));
  if (!Number.isFinite(d) || d === 0) return { error: 'BAD_AMOUNT' };
  if (p.stack + d < 0) return { error: 'NOT_ENOUGH_CHIPS' };
  pushUndo(room, `докупка: ${p.name}`);
  p.stack += d;
  p.stats.buyIn += d; // a top-up is not winnings — keep P/L honest
  room.notice = `${p.name}: стек ${d > 0 ? '+' : '−'}${Math.abs(d)}`;
  touch(room);
  return { ok: true };
}

export function updateSettings(room, userId, patch = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };

  const inLobby = room.status === 'lobby';
  const cur = room.settings;
  const mode =
    patch.blindMode === 'levels' || patch.blindMode === 'fixed' ? patch.blindMode : cur.blindMode;
  const minutes = intIn(patch.levelMinutes, 3, 180, cur.levelMinutes);
  const turnSeconds =
    patch.turnSeconds === 0 ? 0 : patch.turnSeconds != null ? intIn(patch.turnSeconds, 15, 600, 60) : cur.turnSeconds || 0;

  const editableBlinds = inLobby || mode === 'fixed';
  const sb = editableBlinds ? intIn(patch.smallBlind, 1, 1_000_000, cur.smallBlind) : cur.smallBlind;
  const bb = editableBlinds ? intIn(patch.bigBlind, sb, 2_000_000, cur.bigBlind) : cur.bigBlind;
  if (bb < sb) return { error: 'BAD_AMOUNT' };

  const stack = inLobby
    ? intIn(patch.startingStack, bb, 100_000_000, cur.startingStack)
    : cur.startingStack;

  const blindsMoved = sb !== cur.smallBlind || bb !== cur.bigBlind;
  const timerMoved = turnSeconds !== (cur.turnSeconds || 0);
  const cards = patch.cards === 'live' || patch.cards === 'virtual' ? patch.cards : cur.cards || 'virtual';
  const cardsMoved = cards !== (cur.cards || 'virtual');
  // Switching between real and dealt cards in the middle of a hand would
  // leave the hand half one thing, half the other.
  if (cardsMoved && room.hand && room.hand.phase !== 'complete' && !inLobby) return { error: 'HAND_IN_PROGRESS' };
  const changed =
    blindsMoved || timerMoved || cardsMoved || stack !== cur.startingStack || mode !== cur.blindMode ||
    minutes !== cur.levelMinutes;
  if (!changed) return { ok: true, noop: true };

  pushUndo(room, 'изменение настроек');
  room.settings = { ...cur, startingStack: stack, blindMode: mode, levelMinutes: minutes, turnSeconds, cards };
  if (cardsMoved && cards === 'virtual') {
    // No dealer when the bot deals: whoever held the role goes back to a seat.
    for (const p of room.players) {
      if (roleOf(p) === 'dealer' || p.pendingRole) applyRole(room, p, 'player');
    }
  }

  if (inLobby) {
    room.settings.smallBlind = sb;
    room.settings.bigBlind = bb;
    room.pendingBlinds = null;
    for (const p of room.players) {
      p.stack = stack;
      p.stats.buyIn = stack;
    }
  } else if (blindsMoved) {
    queueBlinds(room, sb, bb);
  }

  if (mode === 'levels') {
    const base = inLobby
      ? { sb, bb }
      : room.settings.schedule?.[room.level.index] ?? { sb: cur.smallBlind, bb: cur.bigBlind };
    if (inLobby || cur.blindMode !== 'levels') {
      room.settings.schedule = makeSchedule(base.sb, base.bb);
      room.level = {
        index: 0,
        elapsedMs: 0,
        runningSince: room.status === 'playing' ? Date.now() : null,
      };
    }
  }

  room.notice = cardsMoved
    ? cards === 'live'
      ? 'Играем настоящими картами: бот ведёт фишки, победителя отмечает дилер.'
      : 'Карты раздаёт бот.'
    : timerMoved && !blindsMoved
    ? turnSeconds
      ? `Таймер хода: ${turnSeconds} с. Не успел — чек или фолд; следующая раздача сама через ${AUTO_NEXT_MS / 1000} с.`
      : 'Таймер хода выключен. Следующую раздачу запускают вручную.'
    : inLobby
      ? `Настройки: стек ${stack}, блайнды ${room.settings.smallBlind}/${room.settings.bigBlind}`
      : blindsMoved
        ? `Блайнды со следующей раздачи: ${sb}/${bb}`
        : `Уровни блайндов: по ${minutes} мин`;
  touch(room);
  return { ok: true };
}

/**
 * Take somebody out of the current hand without removing their seat. Their
 * chips already in the pot STAY in the pot.
 *
 * An all-in player is left alone: they owe no more decisions, and walking
 * away from the table does not forfeit a hand that is already all in.
 *
 * @returns true when this changed the hand
 */
function foldOut(room, p) {
  const h = room.hand;
  if (!h || h.phase !== 'betting' || !p.inHand || p.folded || p.allIn) return false;
  if (h.actorId === p.id) {
    // Their own clock: a real fold, and the engine moves the hand on.
    applyAction(room, p.id, 'fold');
  } else {
    p.folded = true;
    p.acted = true;
    p.lastAction = 'FOLD';
    // The engine only re-examines the hand when somebody acts. If this left a
    // single player standing, nobody else ever will — and if that last player
    // then folded, the pot would have no claimant at all.
    if (room.players.filter((x) => x.inHand && !x.folded).length === 1) closeAsFoldWin(room);
  }
  syncCards(room);
  sealUndo(room);
  afterHandMaybeOver(room);
  return true;
}

/**
 * Everyone else is gone: the pot belongs to the last live player. This is
 * the engine's own fold-out path, built from its exported calls — pots from
 * `computePots`, chips through `awardPots` — so no chip math happens here,
 * and nobody is made to act in somebody else's name.
 */
function closeAsFoldWin(room) {
  const h = room.hand;
  const last = room.players.find((x) => x.inHand && !x.folded);
  h.pots = computePots(room);
  h.phase = 'showdown';
  h.actorId = null;
  const r = awardPots(room, h.pots.map(() => [last.id]), { auto: true });
  if (r.error) throw new Error(`движок не закрыл раздачу: ${r.error}`);
}

export function kickPlayer(room, userId, targetId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (String(targetId) === room.hostId) return { error: 'CANNOT_KICK_HOST' };
  const i = seatOf(room, targetId);
  if (i < 0) return { error: 'NO_PLAYER' };
  const p = room.players[i];
  if (p.kicked) return { error: 'NO_PLAYER' };

  if (room.status === 'lobby') {
    // Nobody has played yet: nothing to account for, the seat just goes.
    pushUndo(room, `удаление игрока ${p.name}`);
    room.players.splice(i, 1);
  } else {
    // Mid-game the row STAYS: chips they put in the pot remain in the pot
    // (the engine sums the pot from players' `committed`), and their result
    // stays in the final P/L, which must still add up to zero.
    const wasLive = room.hand?.phase === 'betting' && p.inHand && !p.folded;
    if (!wasLive) pushUndo(room, `удаление игрока ${p.name}`);
    p.kicked = true;
    p.sittingOut = true;
    if (wasLive) foldOut(room, p);
  }
  room.notice = `${p.name} удалён из игры`;
  touch(room);
  return { ok: true, removed: p };
}

/**
 * Somebody walked out of the Telegram group. Their seat is kept (chips in the
 * pot belong to that hand) but they stop being dealt in, and if the clock was
 * on them the hand is unblocked by folding.
 */
export function markLeft(room, targetId) {
  const p = findPlayer(room, targetId);
  if (!p) return { error: 'NO_PLAYER' };
  p.left = true;
  p.sittingOut = true;
  foldOut(room, p);
  if (room.hostId === p.id) reassignHost(room);
  room.notice = `${p.name} вышел из чата`;
  touch(room);
  return { ok: true, player: p };
}

export function sitOut(room, userId, out) {
  const p = findPlayer(room, userId);
  if (!p || p.kicked) return { error: 'NO_PLAYER' };
  p.sittingOut = !!out;
  if (out) foldOut(room, p);
  room.notice = `${p.name} ${out ? 'пропускает раздачи' : 'снова в игре'}`;
  touch(room);
  return { ok: true };
}

/** The table must never be left without an owner. */
function reassignHost(room) {
  const heir = room.players
    .filter((p) => !p.left && !p.kicked)
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (!heir) return;
  room.hostId = heir.id;
  room.notice = `${heir.name} — новый хост`;
}

export function transferHost(room, userId, targetId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  const p = findPlayer(room, targetId);
  if (!p || p.kicked || p.left) return { error: 'NO_PLAYER' };
  pushUndo(room, `передача хоста: ${p.name}`);
  room.hostId = p.id;
  room.notice = `${p.name} — новый хост`;
  touch(room);
  return { ok: true };
}

export function endGame(room, userId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { ok: true, noop: true };
  const h = room.hand;
  if (h && h.phase !== 'complete') {
    // Give back chips stuck in an unfinished pot so the table balances. The
    // hand is abandoned, not played out: no board, no cards shown.
    for (const p of room.players) {
      p.stack += p.committed;
      p.committed = 0;
      p.bet = 0;
    }
    h.phase = 'complete';
    h.payouts = [];
    h.actorId = null;
    h.aborted = true;
    h.deck = null;
    sealUndo(room);
  } else {
    pushUndo(room, 'завершение игры');
  }
  room.ui.winner = null;
  finish(room);
  touch(room);
  return { ok: true };
}

/* ------------------------------------------------------------ persistence */

/**
 * The level clock is parked on the way out: time the bot spent restarting is
 * not time the table spent playing.
 */
export function serialize(room, now = Date.now()) {
  const copy = clone(room);
  if (copy.level?.runningSince) {
    copy.level.elapsedMs += Date.now() - copy.level.runningSince;
    copy.level.runningSince = null;
  }
  // Same for the turn timer and the next deal: saved as time LEFT, so that a
  // bot that was down for ten minutes does not time everybody out on waking.
  for (const c of [copy.turn, copy.autoNext]) {
    if (c && c.deadline != null) {
      c.remaining = Math.max(0, c.deadline - now);
      c.deadline = null;
    }
  }
  return copy;
}

export function deserialize(data) {
  const room = clone(data);
  room.ui = room.ui || {};
  room.ui.pendingBet = null; // a ForceReply prompt does not survive a restart
  room.ui.armedAllIn = null;
  room.ui.lastText = null; // force a redraw of the table message
  room.ui.lastKb = null;
  room.ui.lastMsgId = room.ui.lastMsgId || 0;
  // A board half-way through turning over is shown whole after a restart.
  room.ui.reveal = null;
  room.settings.turnSeconds = room.settings.turnSeconds || 0;
  room.settings.cards = room.settings.cards || 'virtual';
  room.code = room.code || newRoomCode();
  if (room.level && room.status === 'playing') room.level.runningSince = Date.now();
  return room;
}
