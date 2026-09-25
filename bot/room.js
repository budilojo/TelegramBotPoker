'use strict';
/**
 * The bot's own room layer.
 *
 * `server/rooms.js` cannot be reused: it is built around session tokens,
 * WebSocket snapshots and a `publicState` projection, none of which exist
 * here. What IS reused, deliberately and without a single line rewritten, is
 * `server/game.js` — the betting engine. Every chip that moves in this bot
 * moves through it.
 *
 * The ideas carried over from the web layer: ROLE separate from PERMISSION,
 * blinds parked until the next deal, undo snapshots, and the three distinct
 * authority checks (isHost / canRunTable / canDecideWinner).
 *
 * What is deliberately NOT carried over: tokens, sessions, reconnection,
 * "game open in another tab". Telegram hands us a signed identity on every
 * update, so all of that machinery has no job to do.
 */
import {
  startHand,
  applyAction,
  legalActions,
  awardPots,
  previewPayouts,
  gameOverCheck,
  canDeal,
  clone,
} from '../server/game.js';
import { cleanName } from './fmt.js';

const UNDO_DEPTH = 40;
const HISTORY_DEPTH = 60;

/* ------------------------------------------------------------------ model */

export function createRoom({ chatId, host, startingStack = 10000, smallBlind = 25, bigBlind = 50 }) {
  const sb = intIn(smallBlind, 1, 1_000_000, 25);
  const bb = intIn(bigBlind, sb, 2_000_000, Math.max(sb * 2, 50));
  const stack = intIn(startingStack, bb, 100_000_000, 10_000);

  const room = {
    chatId: String(chatId),
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
    },
    level: { index: 0, elapsedMs: 0, runningSince: null },
    pendingBlinds: null,
    players: [],
    hostId: null,
    dealerId: null, // BUTTON seat, not the dealer ROLE (engine naming)
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
      pinnedMessageId: null,
      lastText: null,
      lastKb: null,
      winner: null, // { potIndex, review }
      pendingBet: null, // { userId, promptMessageId, seq }
      armedAllIn: null, // { userId, seq } — ALL-IN needs a second tap
    },
  };
  if (host) {
    const p = addPlayer(room, host);
    room.hostId = p.id;
  }
  return room;
}

export function addPlayer(room, user) {
  const existing = room.players.find((p) => p.id === String(user.id));
  if (existing) {
    // One Telegram account, one seat. A repeat /join returns the same row —
    // and un-does a "left the group" mark if they came back.
    existing.name = cleanName(user.name, existing.name);
    existing.left = false;
    return existing;
  }
  const p = {
    id: String(user.id),
    tgId: Number(user.tgId ?? user.id),
    name: cleanName(user.name, `Игрок ${room.players.length + 1}`),
    stack: room.settings.startingStack,
    joinedAt: Date.now(),
    sittingOut: false,
    left: false,
    role: 'player', // game ROLE, independent of isHost
    pendingRole: null,
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
 * Three separate checks, exactly as in the web app. The host is a PERMISSION
 * (run the room); dealer is a ROLE (run the hand). A person can hold both,
 * either, or neither, and no screen is keyed off a single field.
 */
export const isHost = (room, userId) => room.hostId === String(userId);
export const roleOf = (p) => (p?.role === 'dealer' ? 'dealer' : 'player');
export const dealers = (room) => room.players.filter((p) => roleOf(p) === 'dealer');

/** Host or dealer: undo, fold for an absent player, pace the next hand. */
function canRunTable(room, userId) {
  return isHost(room, userId) || dealers(room).some((d) => d.id === String(userId));
}

/**
 * Who may close a pot. With a dealer assigned it is their job (host kept as a
 * fallback so a dead phone cannot freeze the table). With no dealer, the
 * table decides together — any seated participant, as in the web app.
 */
export function canDecideWinner(room, userId) {
  const live = dealers(room);
  if (live.length === 0) return !!findPlayer(room, userId);
  if (live.some((d) => d.id === String(userId))) return true;
  return isHost(room, userId);
}

/* ------------------------------------------------------------------ roles */

function lockedInHand(room, p) {
  return !!room.hand && room.hand.phase !== 'complete' && p.inHand && !p.folded;
}

export function setRole(room, userId, targetId, role) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (role !== 'player' && role !== 'dealer') return { error: 'BAD_ROLE' };
  const p = findPlayer(room, targetId);
  if (!p) return { error: 'NO_PLAYER' };
  if (roleOf(p) === role && !p.pendingRole) return { ok: true, noop: true };

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
    p.inHand = false;
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

const SNAPSHOT_KEYS = [
  'stack', 'inHand', 'folded', 'allIn', 'bet', 'committed',
  'acted', 'raiseLocked', 'lastAction', 'lastAmount', 'waiting', 'sittingOut',
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
    winner: room.ui.winner ? clone(room.ui.winner) : null,
    players: room.players.map((p) => {
      const snap = { id: p.id, stats: clone(p.stats) };
      for (const k of SNAPSHOT_KEYS) snap[k] = p[k];
      return snap;
    }),
  });
  if (room.undo.length > UNDO_DEPTH) room.undo.shift();
}

export function undo(room, userId) {
  if (!canRunTable(room, userId)) return { error: 'NOT_ALLOWED' };
  const snap = room.undo.pop();
  if (!snap) return { error: 'NOTHING_TO_UNDO' };
  room.status = snap.status;
  room.hand = snap.hand ? clone(snap.hand) : null;
  room.handNo = snap.handNo;
  room.dealerId = snap.dealerId;
  room.dealerSeat = snap.dealerSeat;
  room.finishedAt = snap.status === 'finished' ? room.finishedAt : null;
  if (room.history.length > snap.historyLen)
    room.history.splice(0, room.history.length - snap.historyLen);
  for (const s of snap.players) {
    const p = findPlayer(room, s.id);
    if (!p) continue;
    for (const k of SNAPSHOT_KEYS) p[k] = s[k];
    p.stats = clone(s.stats);
  }
  room.ui.winner = snap.winner ? clone(snap.winner) : null;
  room.ui.armedAllIn = null;
  room.notice = `Отменено: ${snap.label}`;
  touch(room);
  return { ok: true, label: snap.label };
}

/* -------------------------------------------------------------- game flow */

/** Why the table cannot start yet, or null when it can. */
export function startBlocker(room) {
  if (room.status !== 'lobby') return 'Игра уже идёт.';
  const seated = room.players.filter(canDeal);
  if (seated.length < 2) {
    const n = seated.length;
    return n === 0
      ? 'За столом никого нет.'
      : 'Нужен ещё хотя бы один игрок с фишками.';
  }
  return null;
}

export function startGame(room, userId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status !== 'lobby') return { error: 'ALREADY_STARTED' };
  if (room.players.filter(canDeal).length < 2) return { error: 'NOT_ENOUGH_PLAYERS' };
  applyPendingRoles(room);
  room.players.forEach((p) => (p.waiting = false));
  room.status = 'playing';
  setLevelClock(room, true);
  applyPendingBlinds(room);
  pushUndo(room, 'старт игры');
  const r = startHand(room);
  if (r.error) {
    room.status = 'lobby';
    room.undo.pop();
    return r;
  }
  room.ui.winner = null;
  room.notice = null;
  if (room.hand.phase === 'showdown') openWinnerFlow(room);
  touch(room);
  return { ok: true };
}

export function nextHand(room, userId) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status === 'lobby') return { error: 'NOT_PLAYING' };
  if (room.hand && room.hand.phase !== 'complete') return { error: 'HAND_IN_PROGRESS' };

  // Pacing belongs to whoever holds the deck: with a dealer at the table an
  // eager tap from a player would post blinds before the cards are shuffled.
  if (dealers(room).length > 0 && !canRunTable(room, userId)) return { error: 'DEALER_DEALS' };

  applyPendingRoles(room);

  if (room.players.filter(canDeal).length < 2) {
    const withChips = room.players.filter((p) => roleOf(p) !== 'dealer' && p.stack > 0);
    touch(room);
    if (withChips.length <= 1) {
      room.status = 'finished';
      room.finishedAt = Date.now();
      setLevelClock(room, false);
      return { ok: true, finished: true };
    }
    return { error: 'NOT_ENOUGH_PLAYERS' };
  }

  maybeAdvanceLevel(room);
  applyPendingBlinds(room);

  pushUndo(room, `раздача #${room.handNo + 1}`);
  const r = startHand(room);
  if (r.error) {
    room.undo.pop();
    return r;
  }
  room.status = 'playing';
  room.ui.winner = null;
  room.ui.armedAllIn = null;
  room.notice = null;
  if (room.hand.phase === 'showdown') openWinnerFlow(room);
  touch(room);
  return { ok: true };
}

/**
 * A betting action. `seq` is the room counter the button was rendered with:
 * anything stale (double tap, slow network, someone else acted first) is
 * dropped without touching a single chip.
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
  // not enough — a button is never a permission — so the rule is enforced
  // here, on the server side of this bot.
  if (action === 'allin') {
    const l = legalActions(room, String(userId));
    if (l && l.maxTotal > l.currentBet && !(l.canBet || l.canRaise)) {
      return { error: 'CANNOT_RAISE' };
    }
  }

  room.notice = null; // a notice is news, not furniture: the next action clears it
  pushUndo(room, actionLabel(room, userId, action, amount));
  const r = applyAction(room, String(userId), action, amount);
  if (r.error) {
    room.undo.pop();
    return r;
  }
  room.ui.armedAllIn = null;
  room.ui.pendingBet = null;
  if (room.hand.phase === 'showdown') openWinnerFlow(room);
  touch(room);
  return r;
}

function actionLabel(room, userId, action, amount) {
  const p = findPlayer(room, userId);
  const who = p ? p.name : '?';
  const map = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', allin: 'All-in' };
  const base = map[action] || action;
  return amount ? `${who} — ${base} ${amount}` : `${who} — ${base}`;
}

/* ------------------------------------------------------- winner selection */

/** Pots that still need a human decision (a lone claimant is a refund). */
export function openPots(room) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return [];
  return h.pots.map((p, i) => i).filter((i) => h.pots[i].eligible.length > 1);
}

function openWinnerFlow(room) {
  const steps = openPots(room);
  room.ui.winner = steps.length ? { potIndex: steps[0], review: false } : { potIndex: -1, review: true };
}

export function toggleWinner(room, userId, potIndex, seat) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return { error: 'NOT_SHOWDOWN' };
  if (!canDecideWinner(room, userId)) return { error: 'DEALER_DECIDES' };
  const pot = h.pots[potIndex];
  if (!pot) return { error: 'BAD_POT' };
  const p = room.players[seat];
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
  if (!h.pots[w.potIndex] || h.pots[w.potIndex].winners.length === 0)
    return { error: 'NO_WINNER_SELECTED' };
  const steps = openPots(room);
  const at = steps.indexOf(w.potIndex);
  const nextIdx = steps[at + 1];
  if (nextIdx === undefined) room.ui.winner = { potIndex: -1, review: true };
  else room.ui.winner = { potIndex: nextIdx, review: false };
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

export function confirmWinners(room, userId, seq) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return { error: 'NOT_SHOWDOWN' };
  if (!canDecideWinner(room, userId)) return { error: 'DEALER_DECIDES' };
  if (typeof seq === 'number' && seq !== room.seq) return { error: 'STALE', seq: room.seq };
  if (h.pots.some((p) => p.winners.length === 0)) return { error: 'NO_WINNER_SELECTED' };

  pushUndo(room, `итог раздачи #${h.no}`);
  const r = awardPots(room, h.pots.map((p) => p.winners));
  if (r.error) {
    room.undo.pop();
    return r;
  }
  room.ui.winner = null;
  if (room.history.length > HISTORY_DEPTH) room.history.length = HISTORY_DEPTH;
  if (gameOverCheck(room)) {
    room.status = 'finished';
    room.finishedAt = Date.now();
    setLevelClock(room, false);
  }
  touch(room);
  return r;
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
  if (!p) return { error: 'NO_PLAYER' };
  const d = Math.round(Number(delta));
  if (!Number.isFinite(d) || d === 0) return { error: 'BAD_AMOUNT' };
  if (p.stack + d < 0) return { error: 'NOT_ENOUGH_CHIPS' };
  pushUndo(room, `коррекция стека: ${p.name}`);
  p.stack += d;
  p.stats.buyIn += d; // a manual top-up is not winnings — keep P/L honest
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

  const editableBlinds = inLobby || mode === 'fixed';
  const sb = editableBlinds ? intIn(patch.smallBlind, 1, 1_000_000, cur.smallBlind) : cur.smallBlind;
  const bb = editableBlinds ? intIn(patch.bigBlind, sb, 2_000_000, cur.bigBlind) : cur.bigBlind;
  if (bb < sb) return { error: 'BAD_AMOUNT' };

  const stack = inLobby
    ? intIn(patch.startingStack, bb, 100_000_000, cur.startingStack)
    : cur.startingStack;

  const blindsMoved = sb !== cur.smallBlind || bb !== cur.bigBlind;
  const changed =
    blindsMoved || stack !== cur.startingStack || mode !== cur.blindMode || minutes !== cur.levelMinutes;
  if (!changed) return { ok: true, noop: true };

  pushUndo(room, 'изменение настроек');
  room.settings = { ...cur, startingStack: stack, blindMode: mode, levelMinutes: minutes };

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

  room.notice = inLobby
    ? `Настройки: стек ${stack}, блайнды ${room.settings.smallBlind}/${room.settings.bigBlind}`
    : blindsMoved
      ? `Блайнды со следующей раздачи: ${sb}/${bb}`
      : `Уровни блайндов: по ${minutes} мин`;
  touch(room);
  return { ok: true };
}

/** Fold somebody out of the current hand without removing their seat. */
function foldOut(room, p) {
  if (room.hand && room.hand.phase === 'betting' && p.inHand && !p.folded) {
    if (room.hand.actorId === p.id) {
      applyAction(room, p.id, 'fold');
      if (room.hand.phase === 'showdown') openWinnerFlow(room);
    } else {
      p.folded = true;
      p.acted = true;
      p.lastAction = 'FOLD';
    }
  }
}

export function kickPlayer(room, userId, targetId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (String(targetId) === room.hostId) return { error: 'CANNOT_KICK_HOST' };
  const i = seatOf(room, targetId);
  if (i < 0) return { error: 'NO_PLAYER' };
  const p = room.players[i];
  pushUndo(room, `удаление игрока ${p.name}`);
  foldOut(room, p); // chips already in the pot stay in the pot
  room.players.splice(i, 1);
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
  if (!p) return { error: 'NO_PLAYER' };
  p.sittingOut = !!out;
  if (out) foldOut(room, p);
  room.notice = `${p.name} ${out ? 'пропускает раздачи' : 'снова в игре'}`;
  touch(room);
  return { ok: true };
}

/** The table must never be left without an owner. */
function reassignHost(room) {
  const heir = room.players
    .filter((p) => !p.left)
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (!heir) return;
  room.hostId = heir.id;
  room.notice = `${heir.name} — новый хост`;
}

export function transferHost(room, userId, targetId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  const p = findPlayer(room, targetId);
  if (!p) return { error: 'NO_PLAYER' };
  room.hostId = p.id;
  room.notice = `${p.name} — новый хост`;
  touch(room);
  return { ok: true };
}

export function endGame(room, userId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { ok: true, noop: true };
  pushUndo(room, 'завершение игры');
  if (room.hand && room.hand.phase !== 'complete') {
    // Give back chips stuck in an unfinished pot so the table balances.
    for (const p of room.players) {
      p.stack += p.committed;
      p.committed = 0;
      p.bet = 0;
    }
    room.hand.phase = 'complete';
    room.hand.payouts = [];
    room.hand.actorId = null;
  }
  room.status = 'finished';
  room.finishedAt = Date.now();
  room.ui.winner = null;
  setLevelClock(room, false);
  touch(room);
  return { ok: true };
}


/* ------------------------------------------------------------ persistence */

/**
 * The level clock is parked on the way out: time the bot spent restarting is
 * not time the table spent playing.
 */
export function serialize(room) {
  const copy = clone(room);
  if (copy.level?.runningSince) {
    copy.level.elapsedMs += Date.now() - copy.level.runningSince;
    copy.level.runningSince = null;
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
  if (room.level && room.status === 'playing') room.level.runningSince = Date.now();
  return room;
}
