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
import {
  startHand,
  applyAction,
  legalActions,
  computePots,
  awardPots,
  gameOverCheck,
  canDeal,
  clone,
} from '../server/game.js';
import { cleanName } from './fmt.js';
import { dealHoles, syncCards } from './cards.js';
import { shuffled } from './deck.js';

const UNDO_DEPTH = 40;
const HISTORY_DEPTH = 60;

/** Where decks come from. Tests inject a stacked deck; production shuffles. */
const defaultDeck = () => shuffled();

/* ------------------------------------------------------------------ model */

export function createRoom({ chatId, host, title = '', startingStack = 10000, smallBlind = 25, bigBlind = 50 }) {
  const sb = intIn(smallBlind, 1, 1_000_000, 25);
  const bb = intIn(bigBlind, sb, 2_000_000, Math.max(sb * 2, 50));
  const stack = intIn(startingStack, bb, 100_000_000, 10_000);

  const room = {
    chatId: String(chatId),
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
    },
    level: { index: 0, elapsedMs: 0, runningSince: null },
    pendingBlinds: null,
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
      touch(room);
    }
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
    kicked: false,
    dm: user.dm ?? null, // 'ok' | 'fail' | null — can the bot write to them?
    role: 'player', // the engine deals in anyone whose role is not 'dealer'
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
 * The host is a PERMISSION (run the room), independent of having a seat.
 * With the bot dealing and reading the hands there is no second authority:
 * nobody decides a pot, so nobody needs the right to.
 */
export const isHost = (room, userId) => room.hostId === String(userId);

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
  'raiseLocked', 'lastAction', 'lastAmount', 'waiting', 'sittingOut', 'kicked', 'left',
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
  dealHoles(room, deckFn());
  syncCards(room);
  sealUndo(room);
  return { ok: true };
}

export function startGame(room, userId, { deck = defaultDeck } = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status !== 'lobby') return { error: 'ALREADY_STARTED' };
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

export function nextHand(room, userId, { deck = defaultDeck } = {}) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status === 'paused') return { error: 'GAME_PAUSED' };
  if (room.status === 'lobby') return { error: 'NOT_PLAYING' };
  if (room.hand && room.hand.phase !== 'complete') return { error: 'HAND_IN_PROGRESS' };
  if (!isSeated(room, userId) && !isHost(room, userId)) return { error: 'NOT_SEATED' };

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

  const r = applyAction(room, String(userId), action, amount);
  if (r.error) return r;
  room.notice = null; // a notice is news, not furniture: the next action clears it
  room.ui.armedAllIn = null;
  room.ui.pendingBet = null;
  syncCards(room);
  sealUndo(room);
  afterHandMaybeOver(room);
  touch(room);
  return r;
}

/** Hand finished (by showdown or folds): trim history, end the game if it is won. */
function afterHandMaybeOver(room) {
  const h = room.hand;
  if (!h || h.phase !== 'complete') return;
  if (room.history.length > HISTORY_DEPTH) room.history.length = HISTORY_DEPTH;
  const contenders = room.players.filter((p) => !p.kicked && !p.left);
  if (gameOverCheck({ players: contenders })) finish(room);
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
  finish(room);
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
  room.ui.lastMsgId = room.ui.lastMsgId || 0;
  if (room.level && room.status === 'playing') room.level.runningSince = Date.now();
  return room;
}
