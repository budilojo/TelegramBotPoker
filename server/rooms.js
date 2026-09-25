'use strict';
/**
 * Room lifecycle + authority. Everything that mutates chips lives behind these
 * functions so the client can never write a stack directly.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startHand,
  applyAction,
  legalActions,
  awardPots,
  totalPot,
  results,
  gameOverCheck,
  previewPayouts,
  clone,
  canDeal,
} from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SNAPSHOT = path.join(DATA_DIR, 'rooms.json');

const ROOM_TTL_MS = 18 * 60 * 60 * 1000; // rooms live for a long evening
const UNDO_DEPTH = 40;
const HOST_GRACE_MS = 60 * 1000;

// Unambiguous alphabet: no O/0, I/1, S/5.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

export const rooms = new Map();

/* ------------------------------------------------------------------ utils */

const uid = () => crypto.randomBytes(12).toString('base64url');
const token = () => crypto.randomBytes(24).toString('base64url');

function makeCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    let c = '';
    for (let i = 0; i < 4; i++)
      c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;

function cleanName(raw, fallback = 'Игрок') {
  const s = String(raw ?? '')
    .replace(CONTROL_CHARS, '')
    .trim()
    .slice(0, 16);
  return s || fallback;
}

function intIn(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------- room model */

export function createRoom({ name, startingStack, smallBlind, bigBlind }) {
  const code = makeCode();
  const sb = intIn(smallBlind, 1, 1_000_000, 50);
  const bb = intIn(bigBlind, sb, 2_000_000, Math.max(sb * 2, 100));
  const stack = intIn(startingStack, bb, 100_000_000, 10_000);

  const room = {
    code,
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
    hostLeftAt: null,
    dealerId: null,
    dealerSeat: -1,
    handNo: 0,
    hand: null,
    history: [],
    seq: 0,
    undo: [],
    notice: null,
  };
  const host = addPlayer(room, name);
  room.hostId = host.id;
  rooms.set(code, room);
  return { room, player: host };
}

export function addPlayer(room, name) {
  const p = {
    id: uid(),
    token: token(),
    name: cleanName(name, `Игрок ${room.players.length + 1}`),
    stack: room.settings.startingStack,
    connected: true,
    lastSeen: Date.now(),
    joinedAt: Date.now(),
    ready: false,
    sittingOut: false,
    role: 'player', // 'player' | 'dealer' — a game role, separate from isHost
    pendingRole: null, // queued until the current hand finishes
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
  return p;
}

export function findRoom(code) {
  if (typeof code !== 'string') return null;
  return rooms.get(code.trim().toUpperCase()) || null;
}

export const isHost = (room, playerId) => room.hostId === playerId;

/* ------------------------------------------------------------------ roles */

/**
 * ROLE (player / dealer) and PERMISSION (isHost) are deliberately separate:
 * the host is not a seat at the table, it is the right to run the room. So a
 * host can be HOST+PLAYER or HOST+DEALER.
 */
export const roleOf = (p) => (p.role === 'dealer' ? 'dealer' : 'player');

export const dealers = (room) => room.players.filter((p) => roleOf(p) === 'dealer');

/** A player with chips in a live hand cannot swap roles mid-hand. */
function lockedInHand(room, p) {
  return (
    !!room.hand &&
    room.hand.phase !== 'complete' &&
    p.inHand &&
    !p.folded
  );
}

export function setRole(room, playerId, targetId, role) {
  if (!isHost(room, playerId)) return { error: 'NOT_HOST' };
  if (role !== 'player' && role !== 'dealer') return { error: 'BAD_ROLE' };
  const p = room.players.find((x) => x.id === targetId);
  if (!p) return { error: 'NO_PLAYER' };

  if (roleOf(p) === role && !p.pendingRole) return { ok: true, noop: true };

  // Changing a role mid-hand would strand chips, so it waits for the next one.
  if (lockedInHand(room, p)) {
    p.pendingRole = roleOf(p) === role ? null : role;
    // The sitting dealer keeps running *this* hand; only a rival promotion
    // queued for the same moment is dropped, so exactly one lands.
    if (p.pendingRole === 'dealer') {
      for (const other of room.players) {
        if (other.id !== p.id && other.pendingRole === 'dealer') other.pendingRole = null;
      }
    }
    room.notice = p.pendingRole
      ? {
          kind: 'role',
          text: `${p.name} станет ${role === 'dealer' ? 'дилером' : 'игроком'} со следующей раздачи`,
          at: Date.now(),
        }
      : null;
    touch(room);
    return { ok: true, deferred: true };
  }

  applyRole(room, p, role);
  room.notice = {
    kind: 'role',
    text: `${p.name} — ${role === 'dealer' ? 'дилер' : 'игрок'}`,
    at: Date.now(),
  };
  touch(room);
  return { ok: true };
}

/**
 * There is one pair of hands at a real table, so the DEALER role is handed
 * over, never cloned: giving it to somebody else takes it off whoever holds
 * it (or was queued to get it). Without this, "назначить другого дилера"
 * would quietly seat two operators, drop them both from the deal, and leave
 * every client naming the *old* dealer as the one deciding the pot.
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
    // Back to the felt from the next hand on.
    p.waiting = true;
  }
}

/** Queued role swaps land between hands, where they cost nobody anything. */
export function applyPendingRoles(room) {
  for (const p of room.players) {
    if (p.pendingRole) applyRole(room, p, p.pendingRole);
  }
}

/**
 * Who may declare the winner. With a dealer at the table it is their job;
 * the host is kept as a fallback so a dead phone cannot freeze the game.
 * With no dealer assigned, the table decides together, as before.
 */
export function canRunTable(room, playerId) {
  return isHost(room, playerId) || dealers(room).some((d) => d.id === playerId);
}

export function canDecideWinner(room, playerId) {
  const live = dealers(room);
  if (live.length === 0) return true;
  if (live.some((d) => d.id === playerId)) return true;
  return isHost(room, playerId);
}

function touch(room) {
  room.touchedAt = Date.now();
  room.seq += 1;
}

/* --------------------------------------------------------- blind levels */

/**
 * A home-game blind ladder as multiples of the opening level. Roughly 1.4x
 * per step, in numbers people actually stack: 50/100 -> 100/200 -> 150/300...
 */
const LEVEL_MULTIPLIERS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

export function makeSchedule(sb, bb) {
  return LEVEL_MULTIPLIERS.map((m) => ({
    sb: Math.max(1, Math.round(sb * m)),
    bb: Math.max(1, Math.round(bb * m)),
  }));
}

/** Milliseconds spent on the current level, with paused time not counted. */
export function levelElapsed(room) {
  const L = room.level;
  if (!L) return 0;
  return L.elapsedMs + (L.runningSince ? Date.now() - L.runningSince : 0);
}

const levelMs = (room) => (room.settings.levelMinutes || 20) * 60_000;

const lastLevel = (room) =>
  room.level.index >= (room.settings.schedule?.length ?? 1) - 1;

/** The level clock only runs while hands are actually being played. */
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
 * Blinds never change inside a hand: the engine reads settings.bigBlind when
 * it resets minRaise on every street, so editing them mid-hand would quietly
 * move the goalposts. Changes are parked here and land at the next deal.
 */
function queueBlinds(room, sb, bb) {
  room.pendingBlinds = { sb, bb };
}

export function applyPendingBlinds(room) {
  const b = room.pendingBlinds;
  if (!b) return null;
  room.pendingBlinds = null;
  room.settings.smallBlind = b.sb;
  room.settings.bigBlind = b.bb;
  return b;
}

/** One level per expiry — a slow hand must not skip a whole step. */
export function maybeAdvanceLevel(room) {
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
  room.notice = {
    kind: 'blinds',
    text: `Уровень ${room.level.index + 1}: блайнды ${next.sb}/${next.bb} со следующей раздачи`,
    at: Date.now(),
  };
  return true;
}

/** Host nudges the ladder along without waiting for the clock. */
export function bumpLevel(room, playerId) {
  if (!isHost(room, playerId)) return { error: 'NOT_HOST' };
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
];

export function pushUndo(room, label) {
  room.undo.push({
    label,
    at: Date.now(),
    status: room.status,
    hand: room.hand ? clone(room.hand) : null,
    handNo: room.handNo,
    dealerId: room.dealerId,
    dealerSeat: room.dealerSeat,
    historyLen: room.history.length,
    players: room.players.map((p) => {
      const snap = { id: p.id, stats: clone(p.stats) };
      for (const k of SNAPSHOT_KEYS) snap[k] = p[k];
      return snap;
    }),
  });
  if (room.undo.length > UNDO_DEPTH) room.undo.shift();
}

export function undo(room) {
  const snap = room.undo.pop();
  if (!snap) return { error: 'NOTHING_TO_UNDO' };
  room.status = snap.status;
  room.hand = snap.hand ? clone(snap.hand) : null;
  room.handNo = snap.handNo;
  room.dealerId = snap.dealerId;
  room.dealerSeat = snap.dealerSeat;
  if (room.history.length > snap.historyLen)
    room.history.splice(0, room.history.length - snap.historyLen);
  for (const s of snap.players) {
    const p = room.players.find((x) => x.id === s.id);
    if (!p) continue;
    for (const k of SNAPSHOT_KEYS) p[k] = s[k];
    p.stats = clone(s.stats);
  }
  room.notice = { kind: 'undo', text: `Отменено: ${snap.label}`, at: Date.now() };
  touch(room);
  return { ok: true, label: snap.label };
}

/* -------------------------------------------------------------- game flow */

export function startGame(room, playerId) {
  if (!isHost(room, playerId)) return { error: 'NOT_HOST' };
  if (room.status !== 'lobby') return { error: 'ALREADY_STARTED' };
  if (room.players.filter(canDeal).length < 2)
    return { error: 'NOT_ENOUGH_PLAYERS' };
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
  touch(room);
  return { ok: true };
}

export function nextHand(room, playerId) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.hand && room.hand.phase !== 'complete')
    return { error: 'HAND_IN_PROGRESS' };

  // Pacing belongs to whoever holds the deck. With a dealer at the table they
  // are still gathering and shuffling cards, so an eager tap from a player
  // would post blinds before the next hand physically exists. With no dealer
  // assigned the table runs itself, exactly as before.
  if (dealers(room).length > 0 && !canRunTable(room, playerId))
    return { error: 'DEALER_DEALS' };

  // Role swaps queued during the last hand land here, before anyone is dealt.
  applyPendingRoles(room);

  if (room.players.filter(canDeal).length < 2) {
    // Out of chips is the end of the game; anything else (a fresh dealer, a
    // player sitting out) is recoverable, so say so instead of ending it.
    const withChips = room.players.filter((p) => p.role !== 'dealer' && p.stack > 0);
    touch(room);
    if (withChips.length <= 1) {
      room.status = 'finished';
      room.finishedAt = Date.now();
      return { ok: true, finished: true };
    }
    return { error: 'NOT_ENOUGH_PLAYERS' };
  }

  // The ladder steps between hands, never inside one.
  maybeAdvanceLevel(room);
  applyPendingBlinds(room);

  pushUndo(room, `раздача #${room.handNo + 1}`);
  const r = startHand(room);
  if (r.error) {
    room.undo.pop();
    return r;
  }
  room.status = 'playing';
  touch(room);
  return { ok: true };
}

export function act(room, playerId, action, amount, seq) {
  if (room.status === 'paused') return { error: 'GAME_PAUSED' };
  if (room.status !== 'playing') return { error: 'NOT_PLAYING' };
  // Optimistic concurrency: stale taps (double-press, slow network) are dropped.
  if (typeof seq === 'number' && seq !== room.seq)
    return { error: 'STALE', seq: room.seq };

  pushUndo(room, actionLabel(room, playerId, action, amount));
  const r = applyAction(room, playerId, action, amount);
  if (r.error) {
    room.undo.pop();
    return r;
  }
  touch(room);
  return r;
}

function actionLabel(room, playerId, action, amount) {
  const p = room.players.find((x) => x.id === playerId);
  const who = p ? p.name : '?';
  const map = {
    fold: 'Fold', check: 'Check', call: 'Call',
    bet: 'Bet', raise: 'Raise', allin: 'All-in',
  };
  const base = map[action] || action;
  return amount ? `${who} — ${base} ${amount}` : `${who} — ${base}`;
}

/** Winner selection, live-synced so the whole table watches it happen. */
export function selectWinners(room, playerId, potIndex, winners) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return { error: 'NOT_SHOWDOWN' };
  if (!canDecideWinner(room, playerId)) return { error: 'DEALER_DECIDES' };
  const pot = h.pots[potIndex];
  if (!pot) return { error: 'BAD_POT' };
  const ids = (Array.isArray(winners) ? winners : []).filter((id) =>
    pot.eligible.includes(id)
  );
  pot.winners = [...new Set(ids)];
  touch(room);
  return { ok: true };
}

export function confirmWinners(room, playerId, seq) {
  const h = room.hand;
  if (!h || h.phase !== 'showdown') return { error: 'NOT_SHOWDOWN' };
  if (!canDecideWinner(room, playerId)) return { error: 'DEALER_DECIDES' };
  if (typeof seq === 'number' && seq !== room.seq)
    return { error: 'STALE', seq: room.seq };
  if (h.pots.some((p) => p.winners.length === 0))
    return { error: 'NO_WINNER_SELECTED' };

  pushUndo(room, `итог раздачи #${h.no}`);
  const r = awardPots(room, h.pots.map((p) => p.winners));
  if (r.error) {
    room.undo.pop();
    return r;
  }
  if (gameOverCheck(room)) {
    room.status = 'finished';
    room.finishedAt = Date.now();
  }
  touch(room);
  return r;
}

/* -------------------------------------------------------------- host acts */

export function setPaused(room, playerId, paused) {
  if (!isHost(room, playerId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status === 'lobby') return { error: 'NOT_PLAYING' };
  room.status = paused ? 'paused' : 'playing';
  // A smoke break must not cost a blind level.
  setLevelClock(room, !paused);
  touch(room);
  return { ok: true };
}

export function adjustStack(room, playerId, targetId, delta) {
  if (!isHost(room, playerId)) return { error: 'NOT_HOST' };
  const p = room.players.find((x) => x.id === targetId);
  if (!p) return { error: 'NO_PLAYER' };
  const d = Math.round(Number(delta));
  if (!Number.isFinite(d) || d === 0) return { error: 'BAD_AMOUNT' };
  if (p.stack + d < 0) return { error: 'NOT_ENOUGH_CHIPS' };
  pushUndo(room, `коррекция стека: ${p.name}`);
  p.stack += d;
  // A manual top-up is not winnings — keep the final P/L honest.
  p.stats.buyIn += d;
  room.notice = {
    kind: 'adjust',
    text: `${p.name}: стек ${d > 0 ? '+' : ''}${d}`,
    at: Date.now(),
  };
  touch(room);
  return { ok: true };
}

/**
 * Host edits the table settings. Before the game starts everything is
 * adjustable (and stacks are re-dealt); once chips are in play only the
 * blinds can move, and they take effect from the next hand.
 */
export function updateSettings(room, playerId, patch = {}) {
  if (!isHost(room, playerId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };

  const inLobby = room.status === 'lobby';
  const cur = room.settings;

  const mode = patch.blindMode === 'levels' || patch.blindMode === 'fixed'
    ? patch.blindMode
    : cur.blindMode;
  const minutes = intIn(patch.levelMinutes, 3, 180, cur.levelMinutes);

  // While a ladder is running it owns the blinds; the host edits the opening
  // level only before the game starts.
  const editableBlinds = inLobby || mode === 'fixed';
  const sb = editableBlinds ? intIn(patch.smallBlind, 1, 1_000_000, cur.smallBlind) : cur.smallBlind;
  const bb = editableBlinds ? intIn(patch.bigBlind, sb, 2_000_000, cur.bigBlind) : cur.bigBlind;
  if (bb < sb) return { error: 'BAD_AMOUNT' };

  const stack = inLobby
    ? intIn(patch.startingStack, bb, 100_000_000, cur.startingStack)
    : cur.startingStack;

  const blindsMoved = sb !== cur.smallBlind || bb !== cur.bigBlind;
  const changed =
    blindsMoved ||
    stack !== cur.startingStack ||
    mode !== cur.blindMode ||
    minutes !== cur.levelMinutes;
  if (!changed) return { ok: true, noop: true };

  pushUndo(room, 'изменение настроек');

  room.settings = {
    ...cur,
    startingStack: stack,
    blindMode: mode,
    levelMinutes: minutes,
  };

  if (inLobby) {
    // Nothing is in play yet, so everything can land at once.
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

  // Re-cut the ladder whenever the opening level or the mode changes, and
  // restart the clock so a fresh schedule gets a full first level.
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

  room.notice = {
    kind: 'settings',
    text: inLobby
      ? `Настройки обновлены: стек ${stack}, блайнды ${room.settings.smallBlind}/${room.settings.bigBlind}`
      : mode === 'levels'
        ? `Уровни блайндов: по ${minutes} мин`
        : `Блайнды со следующей раздачи: ${sb}/${bb}`,
    at: Date.now(),
  };
  touch(room);
  return { ok: true };
}

export function kickPlayer(room, playerId, targetId) {
  if (!isHost(room, playerId)) return { error: 'NOT_HOST' };
  if (targetId === room.hostId) return { error: 'CANNOT_KICK_HOST' };
  const i = room.players.findIndex((x) => x.id === targetId);
  if (i < 0) return { error: 'NO_PLAYER' };
  const p = room.players[i];
  pushUndo(room, `удаление игрока ${p.name}`);
  // Chips already in the pot stay in the pot; the player simply folds out.
  if (room.hand && room.hand.phase === 'betting' && p.inHand && !p.folded) {
    if (room.hand.actorId === p.id) applyAction(room, p.id, 'fold');
    else {
      p.folded = true;
      p.acted = true;
      p.lastAction = 'FOLD';
    }
  }
  room.players.splice(i, 1);
  room.notice = { kind: 'kick', text: `${p.name} удалён из игры`, at: Date.now() };
  touch(room);
  return { ok: true, removed: p };
}

export function transferHost(room, playerId, targetId) {
  if (!isHost(room, playerId)) return { error: 'NOT_HOST' };
  const p = room.players.find((x) => x.id === targetId);
  if (!p) return { error: 'NO_PLAYER' };
  room.hostId = p.id;
  room.hostLeftAt = null;
  room.notice = { kind: 'host', text: `${p.name} — новый хост`, at: Date.now() };
  touch(room);
  return { ok: true };
}

export function endGame(room, playerId) {
  if (!isHost(room, playerId)) return { error: 'NOT_HOST' };
  pushUndo(room, 'завершение игры');
  if (room.hand && room.hand.phase !== 'complete') {
    // Return chips that are still in an unfinished pot so the table balances.
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
  touch(room);
  return { ok: true };
}

export function setReady(room, playerId, value) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return { error: 'NO_PLAYER' };
  p.ready = !!value;
  touch(room);
  return { ok: true };
}

export function setSittingOut(room, playerId, value) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return { error: 'NO_PLAYER' };
  p.sittingOut = !!value;
  touch(room);
  return { ok: true };
}

export function renamePlayer(room, playerId, name) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return { error: 'NO_PLAYER' };
  p.name = cleanName(name, p.name);
  touch(room);
  return { ok: true };
}

/** Host or dealer may fold for a player who is offline and holding up the table. */
export function forceFold(room, playerId, targetId) {
  if (!canRunTable(room, playerId)) return { error: 'NOT_HOST' };
  if (!room.hand || room.hand.actorId !== targetId)
    return { error: 'NOT_YOUR_TURN' };
  pushUndo(room, 'fold за отключившегося');
  const r = applyAction(room, targetId, 'fold');
  if (r.error) {
    room.undo.pop();
    return r;
  }
  touch(room);
  return r;
}

/* ------------------------------------------------------ presence + expiry */

export function markConnection(room, playerId, connected) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return;
  p.connected = connected;
  p.lastSeen = Date.now();
  if (playerId === room.hostId) room.hostLeftAt = connected ? null : Date.now();
  touch(room);
}

/** Hand the room to someone present if the host has been gone a while. */
export function maybeAutoTransferHost(room) {
  if (!room.hostLeftAt) return false;
  if (Date.now() - room.hostLeftAt < HOST_GRACE_MS) return false;
  const candidate = room.players
    .filter((p) => p.connected && p.id !== room.hostId)
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (!candidate) return false;
  room.hostId = candidate.id;
  room.hostLeftAt = null;
  room.notice = {
    kind: 'host',
    text: `Хост отключился — права перешли к ${candidate.name}`,
    at: Date.now(),
  };
  touch(room);
  return true;
}

export function sweep() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touchedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}

/* ------------------------------------------------------ public projection */

/**
 * Chips-only game: nothing is secret, so every player gets the same view.
 * Tokens are the one thing that must never leave the server.
 */
/** Everything the clients need to draw the blind clock, computed once. */
function blindView(room) {
  const st = room.settings;
  if (st.blindMode !== 'levels' || !room.level) {
    return { mode: 'fixed', pending: room.pendingBlinds };
  }
  const total = st.schedule?.length ?? 1;
  const isLast = room.level.index >= total - 1;
  return {
    mode: 'levels',
    levelIndex: room.level.index,
    levelCount: total,
    levelMinutes: st.levelMinutes,
    // Clients count down locally from this, so no per-second broadcast.
    remainingMs: isLast
      ? null
      : Math.max(0, st.levelMinutes * 60_000 - levelElapsed(room)),
    running: !!room.level.runningSince,
    next: st.schedule?.[room.level.index + 1] ?? null,
    pending: room.pendingBlinds,
  };
}

export function publicState(room, viewerId) {
  const h = room.hand;
  const legal = h ? legalActions(room, viewerId) : null;
  const hostName = room.players.find((p) => p.id === room.hostId)?.name;
  const dealerList = dealers(room);
  return {
    code: room.code,
    // Russian surnames/names cannot be declined reliably, so the room is
    // named after its code and the host is credited separately.
    name: `Стол ${room.code}`,
    hostName: hostName ?? null,
    // The player running the hand (DEALER role) — not the button position.
    dealerRoleId: dealerList[0]?.id ?? null,
    hasDealer: dealerList.length > 0,
    canDecideWinner: canDecideWinner(room, viewerId),
    blinds: blindView(room),
    status: room.status,
    settings: room.settings,
    hostId: room.hostId,
    hostConnected: !!room.players.find((p) => p.id === room.hostId)?.connected,
    dealerId: room.dealerId,
    seq: room.seq,
    handNo: room.handNo,
    canUndo: room.undo.length > 0,
    undoLabel: room.undo.length ? room.undo[room.undo.length - 1].label : null,
    notice: room.notice,
    pot: totalPot(room),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      stack: p.stack,
      connected: p.connected,
      ready: p.ready,
      waiting: p.waiting,
      sittingOut: p.sittingOut,
      isHost: p.id === room.hostId,
      role: roleOf(p),
      pendingRole: p.pendingRole || null,
      inHand: p.inHand,
      folded: p.folded,
      allIn: p.allIn,
      bet: p.bet,
      committed: p.committed,
      acted: p.acted,
      lastAction: p.lastAction,
      lastAmount: p.lastAmount,
      stats: p.stats,
    })),
    hand: h
      ? {
          no: h.no,
          street: h.street,
          phase: h.phase,
          currentBet: h.currentBet,
          minRaise: h.minRaise,
          actorId: h.actorId,
          sbId: h.sbId,
          bbId: h.bbId,
          runout: h.runout,
          pots: h.pots,
          payouts: h.payouts,
          // What the current winner selections would pay — computed by the
          // same code that will actually pay it, so the preview cannot drift.
          preview: h.phase === 'showdown' ? previewPayouts(room) : [],
          log: h.log,
        }
      : null,
    you: viewerId,
    legal,
    history: room.history.slice(0, 20),
    results: room.status === 'finished' ? results(room) : null,
  };
}

/* ------------------------------------------------------------ persistence */

export function persist() {
  if (process.env.CHIPTABLE_NO_PERSIST) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = [];
    for (const room of rooms.values()) {
      const { undo: _skip, ...copy } = room;
      out.push(copy);
    }
    fs.writeFileSync(SNAPSHOT, JSON.stringify(out), 'utf8');
  } catch (e) {
    console.error('[persist]', e.message);
  }
}

export function restore() {
  if (process.env.CHIPTABLE_NO_PERSIST) return;
  try {
    if (!fs.existsSync(SNAPSHOT)) return;
    const arr = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    let n = 0;
    for (const room of arr) {
      if (Date.now() - room.touchedAt > ROOM_TTL_MS) continue;
      room.undo = [];
      // Rooms persisted before blind levels existed.
      room.settings.blindMode ??= 'fixed';
      room.settings.levelMinutes ??= 20;
      room.settings.schedule ??= makeSchedule(room.settings.smallBlind, room.settings.bigBlind);
      room.level ??= { index: 0, elapsedMs: 0, runningSince: null };
      room.pendingBlinds ??= null;
      // The clock cannot have been running while the server was down.
      if (room.level.runningSince) {
        room.level.elapsedMs += Date.now() - room.level.runningSince;
        room.level.runningSince = null;
      }
      room.players.forEach((p) => (p.connected = false));
      rooms.set(room.code, room);
      n++;
    }
    if (n) console.log(`[restore] ${n} room(s) recovered`);
  } catch (e) {
    console.error('[restore]', e.message);
  }
}

export { cleanName };
