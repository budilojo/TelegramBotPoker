'use strict';
/**
 * Durak — the rules, as plain functions over a room. No Telegram, no
 * sockets, no timers: every function takes the room and the id of the person
 * acting (always from a verified signature, never from a message), checks
 * the move, applies it or refuses with a code.
 *
 * The rules are those of pagat.com ("Durak", "Podkidnoy Durak",
 * "Perevodnoy Durak"), numbered in docs/game-hub.md, section 5 — and each of
 * them is one test in durak.rules.test.js.
 *
 * Seats go in the order people sat down; "to the left" is the next seat in
 * that order, and play goes round the table that way.
 */
import crypto from 'node:crypto';
import { newRoomCode } from '../../room.js';
import { cleanName } from '../../fmt.js';
import {
  HAND, beats, isFullDeck, lowestTrump, rankOf, suitOf, rankIndex, shuffled36, label, rankLabel, SUIT_SIGN,
} from './cards.js';

export const MAX_SEATS = 6;
export const MIN_PLAYERS = 2;
/** No more than this many attacking cards in one bout. */
export const BOUT_MAX = 6;
export const VARIANTS = ['podkidnoy', 'perevodnoy'];
export const VARIANT_RU = { podkidnoy: 'подкидной', perevodnoy: 'переводной' };

const defaultDeck = () => shuffled36();

/* ------------------------------------------------------------------ model */

export function createRoom({ chatId, host, title = '', code = newRoomCode(), variant = 'podkidnoy', turnSeconds = 0 }) {
  const room = {
    game: 'durak',
    chatId: String(chatId),
    code,
    title: cleanName(title, '', 40),
    createdAt: Date.now(),
    touchedAt: Date.now(),
    status: 'lobby', // lobby | playing | finished — between two games it is still `playing`
    settings: {
      variant: VARIANTS.includes(variant) ? variant : 'podkidnoy',
      turnSeconds: timerIn(turnSeconds, 0),
    },
    players: [],
    hostId: null,
    gameNo: 0,
    lastFool: null, // the durak of the last finished game: the next one is played "under" them
    lastDealer: null,
    history: [], // { no, fool, draw, aborted }
    deal: null,
    turn: null, // { key, deadline, remaining } — the turn timer, when the host switched it on
    seq: 1,
    notice: null,
    finishedAt: null,
    ui: { tableMessageId: null, lastText: null, lastKb: null, lastMsgId: 0, pings: {} },
  };
  if (host) {
    const p = addPlayer(room, host);
    room.hostId = p.id;
  }
  return room;
}

/** 0 = off; otherwise 15 s to 10 min. */
function timerIn(v, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  if (n <= 0) return 0;
  return Math.min(600, Math.max(15, n));
}

export const findPlayer = (room, id) => room.players.find((p) => p.id === String(id)) || null;
export const isHost = (room, id) => room.hostId === String(id);
/** In the room's seats right now (not the same as in the current game). */
export const isSeated = (p) => !!p && p.seated && !p.left && !p.kicked;
export const seatedPlayers = (room) => room.players.filter(isSeated);
const nameOf = (room, id) => findPlayer(room, id)?.name ?? '—';

export function touch(room) {
  room.touchedAt = Date.now();
  room.seq += 1;
}

/**
 * Take a seat. One Telegram account, one seat: a second tap finds the same
 * row. Somebody who sits down while a game is being played is dealt in from
 * the next one.
 */
export function addPlayer(room, user) {
  const id = String(user.id);
  const existing = findPlayer(room, id);
  if (existing?.kicked) return { error: 'KICKED' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (existing && isSeated(existing)) {
    existing.name = cleanName(user.name, existing.name);
    return existing;
  }
  if (seatedPlayers(room).length >= MAX_SEATS) return { error: 'TABLE_FULL' };
  if (existing) {
    existing.name = cleanName(user.name, existing.name);
    existing.seated = true;
    existing.left = false;
    touch(room);
    return existing;
  }
  const p = {
    id,
    tgId: Number(user.tgId ?? user.id),
    name: cleanName(user.name, `Игрок ${room.players.length + 1}`),
    dm: user.dm ?? null,
    joinedAt: Date.now(),
    seated: true,
    left: false,
    kicked: false,
    stats: { games: 0, fool: 0 },
  };
  room.players.push(p);
  touch(room);
  return p;
}

/** Stand up. Not in the middle of a game: the cards in your hand belong to it. */
export function leave(room, userId) {
  const p = findPlayer(room, userId);
  if (!p || !isSeated(p)) return { error: 'NOT_SEATED' };
  if (inLiveDeal(room, p.id)) return { error: 'IN_DEAL' };
  if (room.status === 'lobby' && !isHost(room, p.id)) {
    room.players.splice(room.players.indexOf(p), 1);
  } else {
    p.seated = false;
  }
  room.notice = `${p.name} встал из-за стола`;
  touch(room);
  return { ok: true };
}

/* --------------------------------------------------------------- the deal */

const live = (room) => room.deal && room.deal.phase === 'play' ? room.deal : null;
const inLiveDeal = (room, id) => !!live(room)?.order.includes(String(id));

/** Players of this game who have not gone out. */
export const alive = (d) => d.order.filter((id) => !d.out.includes(id));

/** The next player round the table after `id` who is still in the game. */
export function nextAlive(d, id) {
  const n = d.order.length;
  const at = d.order.indexOf(id);
  for (let k = 1; k <= n; k++) {
    const c = d.order[(at + k) % n];
    if (c !== id && !d.out.includes(c)) return c;
  }
  return null;
}

/** The one before `id` round the table — who sits on their right. */
function prevIn(order, id) {
  const at = order.indexOf(id);
  return order[(at - 1 + order.length) % order.length];
}

/** Why a game cannot start yet, or null when it can. */
export function startBlocker(room) {
  const n = seatedPlayers(room).length;
  if (n < MIN_PLAYERS) return n === 0 ? 'За столом никого нет.' : 'Нужен ещё хотя бы один игрок.';
  return null;
}

export function startGame(room, userId, opts = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status !== 'lobby') return { error: 'ALREADY_STARTED' };
  if (startBlocker(room)) return { error: 'NOT_ENOUGH_PLAYERS' };
  room.status = 'playing';
  const r = dealGame(room, opts);
  if (r.error) room.status = 'lobby';
  return r;
}

/** The next game of the series — anybody at the table may deal it. */
export function nextGame(room, userId, opts = {}) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  if (room.status !== 'playing') return { error: 'NOT_PLAYING' };
  if (live(room)) return { error: 'DEAL_IN_PROGRESS' };
  if (!isSeated(findPlayer(room, userId)) && !isHost(room, userId)) return { error: 'NOT_SEATED' };
  if (startBlocker(room)) return { error: 'NOT_ENOUGH_PLAYERS' };
  return dealGame(room, opts);
}

/**
 * Rules 2–5: six cards each, one at a time round the table from the left of
 * the dealer; the next card is the trump, face up under the pack (with six
 * players the pack is dealt out and the last card — the trump — stays with
 * the dealer); the first game is led by the lowest trump, the later ones
 * "under the durak".
 *
 * @param deck    `() => string[36]` — shuffled in play, stacked in tests
 * @param randInt for the lead when nobody holds a trump
 */
function dealGame(room, { deck = defaultDeck, randInt = (n) => crypto.randomInt(n) } = {}) {
  const { order, dealer, dealOrder } = nextDealOrder(room);
  const n = order.length;
  const cards = deck();
  if (!isFullDeck(cards)) return { error: 'BAD_DECK' };

  const hands = Object.fromEntries(order.map((id) => [id, []]));
  for (let k = 0; k < HAND * n; k++) hands[dealOrder[k % n]].push(cards[k]);
  const talon = cards.slice(HAND * n);
  const trumpCard = cards[35];
  const trump = suitOf(trumpCard);

  let attacker;
  let firstBy;
  let firstTrump = null;
  if (room.lastFool && order.includes(room.lastFool)) {
    // "Под дурака": the player on the durak's right attacks, the durak defends.
    attacker = prevIn(order, room.lastFool);
    firstBy = 'fool';
  } else {
    for (const id of dealOrder) {
      const t = lowestTrump(hands[id], trump);
      if (t && (!firstTrump || rankIndex(t) < rankIndex(firstTrump))) {
        firstTrump = t;
        attacker = id;
      }
    }
    firstBy = firstTrump ? 'trump' : 'random';
    if (!firstTrump) attacker = order[randInt(n)];
  }

  room.gameNo += 1;
  const d = {
    no: room.gameNo,
    variant: room.settings.variant,
    order,
    dealer,
    hands,
    talon,
    trump,
    trumpCard,
    // Six players: the whole pack is dealt, and everybody saw the trump go to the dealer.
    trumpHolder: talon.length === 0 ? dealOrder[n - 1] : null,
    discard: [],
    table: [], // { a, by, d, dby } — an attacking card and, once beaten, the card on it
    attacker,
    defender: null,
    bout: null,
    out: [],
    phase: 'play',
    firstBy,
    firstTrump,
    fool: null,
    draw: false,
    aborted: false,
    last: null, // how the previous bout ended: { kind: 'beaten'|'taken', defender, n, bout }
    moves: 0, // cards played this game, by people — the timer's moves are counted apart
  };
  d.defender = nextAlive(d, attacker);
  d.bout = newBout(d, 1);
  room.deal = d;
  room.turn = null;
  room.notice =
    firstBy === 'fool' ? `Ходим под дурака: ${nameOf(room, attacker)} ходит, ${nameOf(room, d.defender)} отбивается` :
    firstBy === 'trump' ? `Первым ходит ${nameOf(room, attacker)}: младший козырь ${label(firstTrump)}` :
    `Козырей ни у кого нет — первым по жребию ходит ${nameOf(room, attacker)}`;
  touch(room);
  return { ok: true };
}

/**
 * Who deals the next game, and in what order the cards go out: the durak
 * shuffles and deals (after a draw, the same dealer again; the first game,
 * the host), one card at a time from the dealer's left.
 */
export function nextDealOrder(room) {
  const order = seatedPlayers(room).map((p) => p.id);
  const n = order.length;
  const dealer = [room.lastFool, room.lastDealer, room.hostId].find((id) => id && order.includes(id)) || order[0];
  const from = order.indexOf(dealer);
  return { order, dealer, dealOrder: order.map((_, k) => order[(from + 1 + k) % n]) };
}

function newBout(d, no) {
  return { no, startHand: d.hands[d.defender].length, taking: false, passed: [], leader: d.attacker };
}

/** Rule 8: at most six attacking cards, and no more than the defender held when the bout began. */
export const boutLimit = (d) => Math.min(BOUT_MAX, d.bout.startHand);
export const allCovered = (d) => d.table.length > 0 && d.table.every((x) => x.d);
export const ranksOnTable = (d) => new Set(d.table.flatMap((x) => (x.d ? [rankOf(x.a), rankOf(x.d)] : [rankOf(x.a)])));

/** Who may still throw in this bout: everybody in the game but the defender, with cards in hand. */
export const throwers = (d) => alive(d).filter((id) => id !== d.defender && d.hands[id].length > 0);

/** Throwers the bout is still waiting on — none once the limit is reached. */
export function waitingThrowers(d) {
  if (!d.table.length || d.table.length >= boutLimit(d)) return [];
  return throwers(d).filter((id) => !d.bout.passed.includes(id));
}

/* --------------------------------------------------------------- the moves */

/** Checks every move shares: the game is on, it is a real player, the card is theirs. */
function guard(room, userId, seq, card) {
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  const d = live(room);
  if (!d) return { error: room.status === 'lobby' ? 'NOT_PLAYING' : 'DEAL_OVER' };
  if (typeof seq === 'number' && seq !== room.seq) return { error: 'STALE', seq: room.seq };
  const id = String(userId);
  if (!d.order.includes(id)) return { error: 'NOT_IN_DEAL' };
  if (d.out.includes(id)) return { error: 'OUT' };
  if (card !== undefined && !d.hands[id].includes(card)) return { error: 'NOT_YOUR_CARD' };
  return { d, id };
}

/**
 * Rules 6–8: lead a bout, or throw a card in. Leading is the attacker's;
 * throwing in is everybody's but the defender's — cards of a rank already on
 * the table, within the limit. While the defender is taking, cards may still
 * be thrown in after them.
 */
export function attack(room, userId, card, seq) {
  const g = guard(room, userId, seq, card);
  if (g.error) return g;
  const { d, id } = g;
  if (id === d.defender) {
    return d.variant === 'perevodnoy' && !d.table.some((x) => x.d) && d.table.length
      ? { error: 'DEFENDER_TRANSFERS' }
      : { error: 'DEFENDER_CANNOT_ATTACK' };
  }
  if (!d.table.length) {
    if (id !== d.attacker) return { error: 'NOT_YOUR_LEAD', text: `Первым ходит ${nameOf(room, d.attacker)} — подкидывать можно после.` };
  } else {
    const ranks = ranksOnTable(d);
    if (!ranks.has(rankOf(card))) {
      return { error: 'RANK_NOT_ON_TABLE', text: `Подкидывать можно только ${[...ranks].map(rankLabel).join(', ')} — они уже на столе.` };
    }
  }
  if (d.table.length >= boutLimit(d)) {
    return {
      error: 'TABLE_LIMIT',
      text: d.bout.startHand < BOUT_MAX
        ? `Больше не подкинуть: ${nameOf(room, d.defender)} отбивается, а у него было всего ${d.bout.startHand} карт${ending(d.bout.startHand)}.`
        : 'Больше не подкинуть: в одном отбое не больше 6 карт.',
    };
  }
  take1(d.hands[id], card);
  d.table.push({ a: card, by: id, d: null, dby: null });
  d.bout.passed = []; // a new card on the table: everybody may think again
  return played(room, id);
}

/** Rule 9: cover one attacking card with a higher one of its suit, or with a trump. */
export function defend(room, userId, card, target, seq) {
  const g = guard(room, userId, seq, card);
  if (g.error) return g;
  const { d, id } = g;
  if (id !== d.defender) return { error: 'NOT_DEFENDER', text: `Отбивается ${nameOf(room, d.defender)}.` };
  if (d.bout.taking) return { error: 'TAKING' };
  const i = Number(target);
  const pair = Number.isInteger(i) ? d.table[i] : null;
  if (!pair) return { error: 'BAD_TARGET' };
  if (pair.d) return { error: 'ALREADY_COVERED' };
  if (!beats(pair.a, card, d.trump)) {
    return {
      error: 'CANNOT_BEAT',
      text: suitOf(pair.a) === d.trump
        ? `${label(card)} не бьёт ${label(pair.a)}: козырь бьётся только старшим козырем.`
        : `${label(card)} не бьёт ${label(pair.a)}: нужна старшая ${SUIT_SIGN[suitOf(pair.a)]} или козырь.`,
    };
  }
  take1(d.hands[id], card);
  pair.d = card;
  pair.dby = id;
  d.bout.passed = [];
  return played(room, id);
}

/**
 * Rule 15 (perevodnoy): before any card is beaten, the defender may pass the
 * attack on with a card of the same rank — if the next player has enough
 * cards for everything that will then be on the table.
 */
export function transfer(room, userId, card, seq) {
  const g = guard(room, userId, seq, card);
  if (g.error) return g;
  const { d, id } = g;
  if (d.variant !== 'perevodnoy') return { error: 'NO_TRANSFER' };
  if (id !== d.defender) return { error: 'NOT_DEFENDER', text: `Отбивается ${nameOf(room, d.defender)}.` };
  if (d.bout.taking) return { error: 'TAKING' };
  if (!d.table.length) return { error: 'NOTHING_TO_TRANSFER' };
  if (d.table.some((x) => x.d)) return { error: 'TRANSFER_AFTER_BEAT' };
  if (rankOf(card) !== rankOf(d.table[0].a)) {
    return { error: 'TRANSFER_RANK', text: `Перевести можно только картой ${rankLabel(rankOf(d.table[0].a))}.` };
  }
  const next = nextAlive(d, id);
  const need = d.table.length + 1;
  if (!next || d.hands[next].length < need) {
    const has = d.hands[next]?.length ?? 0;
    return { error: 'TRANSFER_TOO_MANY', text: `Перевести нельзя: у следующего игрока (${nameOf(room, next)}) ${has} карт${ending(has)}, а на столе будет ${need}.` };
  }
  take1(d.hands[id], card);
  d.table.push({ a: card, by: id, d: null, dby: null });
  d.attacker = id; // the one who passed it on now attacks — and draws first
  d.defender = next;
  d.bout = { ...d.bout, startHand: d.hands[next].length, passed: [], transfers: (d.bout.transfers || 0) + 1 };
  room.notice = `${nameOf(room, id)} переводит — теперь отбивается ${nameOf(room, next)}`;
  return played(room, id, { keepNotice: true });
}

/** Rule 11: the defender gives up and will pick up everything on the table. */
export function take(room, userId, seq) {
  const g = guard(room, userId, seq);
  if (g.error) return g;
  const { d, id } = g;
  if (id !== d.defender) return { error: 'NOT_DEFENDER', text: `Отбивается ${nameOf(room, d.defender)}.` };
  if (d.bout.taking) return { error: 'TAKING' };
  if (!d.table.length || allCovered(d)) return { error: 'ALL_COVERED' };
  d.bout.taking = true;
  d.bout.passed = [];
  room.notice = `${nameOf(room, id)} берёт`;
  return played(room, id, { keepNotice: true });
}

/**
 * "Пас" — nothing more to throw in; the main attacker's "Бито" is the same
 * word. Only once everything is covered, or the defender is taking.
 */
export function pass(room, userId, seq) {
  const g = guard(room, userId, seq);
  if (g.error) return g;
  const { d, id } = g;
  if (id === d.defender) return { error: 'DEFENDER_PASS' };
  if (!d.table.length || !(allCovered(d) || d.bout.taking)) return { error: 'CANNOT_PASS' };
  if (!d.bout.passed.includes(id)) d.bout.passed.push(id);
  return played(room, id);
}

function take1(hand, card) {
  hand.splice(hand.indexOf(card), 1);
}

function ending(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'а';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'ы';
  return '';
}

/** Everything after a move: maybe the bout is over. */
function played(room, id, { keepNotice = false, byTimer = false } = {}) {
  const d = room.deal;
  if (!keepNotice) room.notice = null;
  if (byTimer) d.idle = (d.idle || 0) + 1;
  else {
    d.moves += 1;
    d.idle = 0;
  }
  settle(room);
  // The timer is playing the whole table while nobody is there: stop, like
  // the poker table pauses, instead of dealing a game to an empty room.
  if (byTimer && room.deal.phase === 'play' && d.idle >= IDLE_ROUNDS * d.order.length) {
    abortDeal(room, 'никто не ходит сам — время выходит у всех');
  }
  touch(room);
  return { ok: true };
}

/** This many timed-out waits per player in a row, and the game is stopped. */
export const IDLE_ROUNDS = 2;

/**
 * The bout ends when nobody can or will add anything: everything is covered
 * (or the defender is taking) and every player who could still throw in has
 * said "пас" — or the limit is reached, which everybody can see.
 */
function settle(room) {
  const d = room.deal;
  if (!d || d.phase !== 'play' || !d.table.length) return;
  if (!allCovered(d) && !d.bout.taking) return; // the defender's move
  if (waitingThrowers(d).length) return;
  endBout(room, d.bout.taking ? 'taken' : 'beaten');
}

/**
 * Rules 10–14: the cards go to the discard (beaten) or to the defender
 * (taken); everybody draws back up to six — the attacker first, the others
 * round the table, the defender last; whoever has no cards once the pack is
 * gone is out; the last one holding cards is the durak.
 */
function endBout(room, kind) {
  const d = room.deal;
  const cards = d.table.flatMap((x) => (x.d ? [x.a, x.d] : [x.a]));
  if (kind === 'beaten') d.discard.push(...cards);
  else d.hands[d.defender].push(...cards);
  d.table = [];
  d.last = { kind, defender: d.defender, n: cards.length, bout: d.bout.no };

  // Rule 12: the attacker, the others clockwise from him, the defender last.
  const drawOrder = [d.attacker];
  for (let id = nextAlive(d, d.attacker); id && id !== d.attacker; id = nextAlive(d, id)) {
    if (id !== d.defender) drawOrder.push(id);
  }
  if (d.defender !== d.attacker) drawOrder.push(d.defender);
  for (const id of drawOrder) {
    while (d.hands[id].length < HAND && d.talon.length) d.hands[id].push(d.talon.shift());
  }

  // Rule 13: out of cards with the pack gone — out of the game.
  if (!d.talon.length) for (const id of alive(d)) if (!d.hands[id].length) d.out.push(id);
  const left = alive(d);
  if (left.length <= 1) return endDeal(room, left[0] ?? null);

  // Rule 10: beaten — the defender leads next. Rule 11: taken — the player after him.
  const defender = d.defender;
  d.attacker = kind === 'beaten' && left.includes(defender) ? defender : nextAlive(d, defender);
  d.defender = nextAlive(d, d.attacker);
  d.bout = newBout(d, d.bout.no + 1);
}

/** Rule 14 and 16: the durak (or a draw) goes into the score of the series. */
function endDeal(room, foolId) {
  const d = room.deal;
  d.phase = 'over';
  d.fool = foolId;
  d.draw = !foolId;
  room.history.push({ no: d.no, fool: foolId, draw: !foolId });
  room.lastFool = foolId;
  room.lastDealer = d.dealer;
  for (const id of d.order) {
    const p = findPlayer(room, id);
    if (!p) continue;
    p.stats.games += 1;
    if (id === foolId) p.stats.fool += 1;
  }
  room.turn = null;
  room.notice = foolId ? `🤡 Дурак — ${nameOf(room, foolId)}` : '🤝 Ничья: карты кончились у всех разом';
}

/**
 * Somebody went away in the middle of a game (left the group, removed by the
 * host). Their cards nobody saw and nobody can play, so the game stops here
 * and does not count.
 */
function abortDeal(room, why) {
  const d = live(room);
  if (!d) return false;
  d.phase = 'over';
  d.aborted = true;
  d.abortedWhy = why;
  // What was on the table is nobody's any more; it goes with the rest, face down.
  d.discard.push(...d.table.flatMap((x) => (x.d ? [x.a, x.d] : [x.a])));
  d.table = [];
  room.history.push({ no: d.no, fool: null, draw: false, aborted: true });
  room.turn = null;
  room.notice = `Партия прервана: ${why}. Она не засчитывается.`;
  return true;
}

/* ------------------------------------------------------------- the timer */

/**
 * What the game is waiting for right now, as one key — any card on the table
 * or any change of who must act makes it a new wait (and a fresh clock).
 */
export function waitKey(room) {
  const d = live(room);
  if (!d) return null;
  const covered = d.table.filter((x) => x.d).length;
  return `${d.no}:${d.bout.no}:${d.table.length}:${covered}:${d.bout.taking ? 1 : 0}`;
}

/** The turn timer, parked on disk like the poker one. */
export function syncTurn(room, now) {
  const secs = room.settings.turnSeconds || 0;
  const key = waitKey(room);
  if (!secs || !key || room.status !== 'playing') {
    room.turn = null;
    return null;
  }
  if (room.turn?.key !== key) room.turn = { key, deadline: null, remaining: secs * 1000 };
  if (room.turn.deadline == null) room.turn.deadline = now + room.turn.remaining;
  return room.turn;
}

/**
 * Time is up (a timer the host switched on). The least the bot can do in
 * somebody's place: a defender takes, throwers pass — and a bout that has
 * to be opened is opened with the lowest card that is not a trump.
 */
export function timeoutMove(room, key, now) {
  const t = room.turn;
  const d = live(room);
  if (!d || !t || t.key !== key || waitKey(room) !== key) return { error: 'STALE' };
  if (t.deadline == null || now < t.deadline) return { error: 'EARLY' };
  if (!d.table.length) {
    const hand = d.hands[d.attacker];
    const plain = hand.filter((c) => suitOf(c) !== d.trump);
    const pool = plain.length ? plain : hand;
    const card = pool.reduce((a, b) => (rankIndex(b) < rankIndex(a) ? b : a));
    take1(hand, card);
    d.table.push({ a: card, by: d.attacker, d: null, dby: null });
    d.bout.passed = [];
    room.notice = `${nameOf(room, d.attacker)}: время вышло — бот сходил ${label(card)}`;
    played(room, d.attacker, { keepNotice: true, byTimer: true });
    return { ok: true, who: [d.attacker], move: 'lead' };
  }
  if (!allCovered(d) && !d.bout.taking) {
    const who = d.defender;
    d.bout.taking = true;
    d.bout.passed = [];
    room.notice = `${nameOf(room, who)}: время вышло — берёт`;
    played(room, who, { keepNotice: true, byTimer: true });
    return { ok: true, who: [who], move: 'take' };
  }
  const who = waitingThrowers(d);
  d.bout.passed.push(...who);
  room.notice = who.length ? `Время вышло: ${who.map((id) => nameOf(room, id)).join(', ')} — пас` : null;
  played(room, who[0], { keepNotice: true, byTimer: true });
  return { ok: true, who, move: 'pass' };
}

/* -------------------------------------------------------- what is allowed */

/**
 * The moves one player has right now — worked out from THEIR hand only, so
 * the answer says nothing about anybody else's cards. The page lights up
 * these; the server checks every move again anyway.
 */
export function legalFor(room, userId) {
  const d = live(room);
  const id = String(userId);
  const none = { attack: [], defend: {}, transfer: [], take: false, pass: false, passLabel: null, lead: false };
  if (!d || !d.order.includes(id) || d.out.includes(id)) return none;
  const hand = d.hands[id];
  const out = { ...none, defend: {} };
  if (id === d.defender) {
    if (d.bout.taking || !d.table.length) return out;
    for (const c of hand) {
      const targets = d.table.map((x, i) => (!x.d && beats(x.a, c, d.trump) ? i : -1)).filter((i) => i >= 0);
      if (targets.length) out.defend[c] = targets;
    }
    out.take = !allCovered(d);
    if (d.variant === 'perevodnoy' && !d.table.some((x) => x.d)) {
      const next = nextAlive(d, id);
      if (next && d.hands[next].length >= d.table.length + 1) out.transfer = hand.filter((c) => rankOf(c) === rankOf(d.table[0].a));
    }
    return out;
  }
  if (!d.table.length) {
    if (id === d.attacker) {
      out.lead = true;
      out.attack = [...hand];
    }
    return out;
  }
  if (d.table.length < boutLimit(d)) {
    const ranks = ranksOnTable(d);
    out.attack = hand.filter((c) => ranks.has(rankOf(c)));
  }
  if ((allCovered(d) || d.bout.taking) && waitingThrowers(d).includes(id)) {
    out.pass = true;
    out.passLabel = !d.bout.taking && id === d.attacker ? 'Бито' : 'Пас';
  }
  return out;
}

/* ----------------------------------------------------------- host and seats */

export function updateSettings(room, userId, patch = {}) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { error: 'GAME_FINISHED' };
  const cur = room.settings;
  const variant = VARIANTS.includes(patch.variant) ? patch.variant : cur.variant;
  const turnSeconds = patch.turnSeconds != null ? timerIn(patch.turnSeconds, cur.turnSeconds) : cur.turnSeconds;
  if (variant !== cur.variant && live(room)) return { error: 'DEAL_IN_PROGRESS' };
  if (variant === cur.variant && turnSeconds === cur.turnSeconds) return { ok: true, noop: true };
  room.settings = { ...cur, variant, turnSeconds };
  room.notice =
    variant !== cur.variant ? `Играем в ${VARIANT_RU[variant]}` :
    turnSeconds ? `Таймер хода: ${turnSeconds} с. Не успел — отбивающийся берёт, остальные пасуют.` : 'Таймер хода выключен.';
  touch(room);
  return { ok: true };
}

/** The table must never be left without an owner. */
function reassignHost(room) {
  const heir = room.players.filter((p) => !p.left && !p.kicked).sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (heir) room.hostId = heir.id;
}

export function transferHost(room, userId, targetId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  const p = findPlayer(room, targetId);
  if (!p || p.kicked || p.left) return { error: 'NO_PLAYER' };
  room.hostId = p.id;
  room.notice = `${p.name} — новый хост`;
  touch(room);
  return { ok: true };
}

export function kickPlayer(room, userId, targetId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (String(targetId) === room.hostId) return { error: 'CANNOT_KICK_HOST' };
  const p = findPlayer(room, targetId);
  if (!p || p.kicked) return { error: 'NO_PLAYER' };
  let stopped = false;
  if (room.status === 'lobby') {
    room.players.splice(room.players.indexOf(p), 1);
  } else {
    p.kicked = true;
    p.seated = false;
    stopped = inLiveDeal(room, p.id) && abortDeal(room, `хост удалил ${p.name}`);
  }
  if (!stopped) room.notice = `${p.name} удалён из игры`;
  touch(room);
  return { ok: true };
}

/** Somebody walked out of the Telegram group. */
export function markLeft(room, targetId) {
  const p = findPlayer(room, targetId);
  if (!p || p.left) return { error: 'NO_PLAYER' };
  p.left = true;
  p.seated = false;
  const stopped = inLiveDeal(room, p.id) && abortDeal(room, `${p.name} вышел из чата`);
  if (room.hostId === p.id) reassignHost(room);
  if (!stopped) room.notice = `${p.name} вышел из чата`;
  touch(room);
  return { ok: true, player: p };
}

/** The host stops a game that cannot go on (somebody fell asleep). It does not count. */
export function abortGame(room, userId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (!live(room)) return { error: 'DEAL_OVER' };
  abortDeal(room, 'её остановил хост');
  touch(room);
  return { ok: true };
}

/** The end of the series. A game still being played is dropped, not counted. */
export function endGame(room, userId) {
  if (!isHost(room, userId)) return { error: 'NOT_HOST' };
  if (room.status === 'finished') return { ok: true, noop: true };
  if (live(room)) abortDeal(room, 'игру завершил хост');
  room.status = 'finished';
  room.finishedAt = Date.now();
  room.turn = null;
  touch(room);
  return { ok: true };
}

/** Who was the durak how many times — the score of the series, best first. */
export function score(room) {
  return room.players
    .filter((p) => p.stats.games > 0 || isSeated(p))
    .map((p) => ({ id: p.id, name: p.name, fool: p.stats.fool, games: p.stats.games, isHost: isHost(room, p.id), kicked: !!p.kicked, left: !!p.left }))
    .sort((a, b) => a.fool - b.fool || b.games - a.games);
}

/* ------------------------------------------------------------ persistence */

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

/** The turn timer is saved as time LEFT: a bot that was down is nobody's time. */
export function serialize(room, now = Date.now()) {
  const copy = clone(room);
  if (copy.turn && copy.turn.deadline != null) {
    copy.turn.remaining = Math.max(0, copy.turn.deadline - now);
    copy.turn.deadline = null;
  }
  return copy;
}

export function deserialize(data) {
  const room = clone(data);
  room.game = 'durak';
  room.ui = room.ui || {};
  room.ui.lastText = null; // force a redraw of the card
  room.ui.lastKb = null;
  room.ui.lastMsgId = room.ui.lastMsgId || 0;
  room.ui.pings = room.ui.pings || {};
  room.code = room.code || newRoomCode();
  return room;
}
