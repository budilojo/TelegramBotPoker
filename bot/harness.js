'use strict';
/**
 * Test harness. Lets a test read like a hand of poker instead of like a pile
 * of protocol messages.
 *
 * Every person at the table opens the Mini App the way Telegram would let
 * them — with an initData signed by the bot's token — and the harness keeps
 * EVERYTHING the server ever sent to each of them. That is what the privacy
 * tests read: not what the screen shows at the end, but every state that
 * ever reached a phone.
 */
import { App } from './app.js';
import { Hub } from './hub.js';
import { TelegramStub, cmdUpdate, pressUpdate, dmUpdate, user } from './tg-stub.js';
import { NullStore } from './store.js';
import { dealOrder } from './cards.js';
import { parseCard, freshDeck, shuffled, seededRng } from './deck.js';
import { signInitData } from './webapp-auth.js';
import { nextDealOrder } from './games/durak/rules.js';
import { freshDeck36, isCard, shuffled36 } from './games/durak/cards.js';

export { user };

export const TEST_TOKEN = '123456:test-token-for-the-harness';

/**
 * A stacked deck, for tests that need to know who wins.
 *
 *   stack({ [alice.id]: 'As Ah', [bob.id]: 'Kd Kc' }, '2s 7h 9d Jc 3s')
 *
 * Returns `(room) => deck`, called by the bot right after the engine posts
 * the blinds — so it can read the real dealing order (from the seat left of
 * the button, one card per round) and put each named hand exactly where that
 * player's cards will come from. Anyone not named gets unused cards.
 */
export function stack(holes = {}, board = '', { seed = 7 } = {}) {
  return (room) => {
    const order = dealOrder(room);
    const n = order.length;
    const deck = new Array(52).fill(null);
    const used = new Set();
    const put = (i, card) => {
      if (used.has(card)) throw new Error(`карта дважды в подтасовке: ${card}`);
      used.add(card);
      deck[i] = card;
    };
    order.forEach((id, i) => {
      const h = holes[id];
      if (!h) return;
      const [a, b] = String(h).trim().split(/\s+/).map(parseCard);
      put(i, a);
      put(n + i, b);
    });
    // A card is burnt before the flop, the turn and the river (see cards.js):
    // flop at 2n+1..2n+3, turn at 2n+5, river at 2n+7.
    const at = [1, 2, 3, 5, 7];
    String(board).trim().split(/\s+/).filter(Boolean).map(parseCard)
      .forEach((c, k) => put(2 * n + at[k], c));
    const rest = shuffled(seededRng(seed)).filter((c) => !used.has(c));
    for (let i = 0; i < 52; i++) if (deck[i] == null) deck[i] = rest.shift();
    return deck;
  };
}

/**
 * A stacked durak pack, for tests that need to know who holds what.
 *
 *   durakStack({ [alice.id]: '6S 7S 8S 9S 10S JS', [bob.id]: '…' }, { trump: 'AD', talon: 'KD QD' })
 *
 * Returns `(room) => string[36]`, called when the game is dealt — so it can
 * follow the real dealing order (one card at a time from the dealer's left).
 * `trump` is the bottom card of the pack; `talon` the cards on top of the pack
 * after the deal, top first. Everything not named fills in, in a fixed order.
 */
export function durakStack(hands = {}, { trump = null, talon = '' } = {}) {
  const parse = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).map((c) => {
    if (!isCard(c)) throw new Error(`не карта: ${c}`);
    return c;
  });
  return (room) => {
    const { dealOrder } = nextDealOrder(room);
    const n = dealOrder.length;
    const deck = new Array(36).fill(null);
    const used = new Set();
    const put = (i, c) => {
      if (used.has(c)) throw new Error(`карта дважды в подтасовке: ${c}`);
      if (deck[i] != null) throw new Error(`место ${i} занято дважды`);
      used.add(c);
      deck[i] = c;
    };
    dealOrder.forEach((id, i) => parse(hands[id]).forEach((c, k) => put(k * n + i, c)));
    if (trump && deck[35] !== trump) put(35, trump);
    parse(talon).forEach((c, k) => put(6 * n + k, c));
    const rest = freshDeck36().filter((c) => !used.has(c));
    for (let i = 0; i < 36; i++) if (deck[i] == null) deck[i] = rest.shift();
    return deck;
  };
}

/** A different honest-looking durak pack every game, reproducible from the seed. */
export function durakDecks(seed = 1) {
  const rnd = seededRng(seed);
  return () => shuffled36(rnd);
}

/** A different honest-looking deck every hand, reproducible from the seed. */
export function seededDecks(seed = 1) {
  const rnd = seededRng(seed);
  return () => shuffled(rnd);
}

export { freshDeck };

/**
 * A clock that only moves when the test says so. Timers fire in order of
 * their due time, each one awaited — so a turn timeout that redraws the table
 * and arms the next timer has fully happened before the next one fires.
 */
export class FakeClock {
  constructor(start = Date.UTC(2026, 8, 25, 11, 0, 0)) {
    this.t = start;
    this.queue = [];
    this.seq = 0;
    this.now = () => this.t;
    this.setTimeout = (fn, ms) => {
      const h = { at: this.t + Math.max(0, Number(ms) || 0), fn, n: ++this.seq };
      this.queue.push(h);
      return h;
    };
    this.clearTimeout = (h) => {
      this.queue = this.queue.filter((x) => x !== h);
    };
  }

  async advance(ms) {
    const end = this.t + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      this.queue.sort((a, b) => a.at - b.at || a.n - b.n);
      const next = this.queue[0];
      if (!next || next.at > end) break;
      this.queue.shift();
      this.t = Math.max(this.t, next.at);
      await next.fn();
    }
    this.t = end;
  }

  pending() {
    return this.queue.length;
  }
}

/** Sign the initData Telegram would hand this person's Mini App. */
export function initDataFor(u, { startParam = null, token = TEST_TOKEN, authDate = null, clock = null } = {}) {
  const fields = {
    auth_date: authDate ?? Math.floor((clock ? clock.now() : Date.now()) / 1000),
    user: { id: u.id, first_name: u.first_name, is_bot: false },
  };
  if (startParam) fields.start_param = startParam;
  return signInitData(fields, token);
}

export class Table {
  /**
   * `runoutStepMs` is 0 by default: most tests want the showdown on screen
   * the moment the last chip goes in. The reveal tests turn it on and move
   * the fake clock by hand.
   */
  constructor({
    chatId = -1001234, minIntervalMs = 0, store = new NullStore(), botUsername = 'ChipTableBot', deck = seededDecks(1),
    clock = new FakeClock(), runoutStepMs = 0, miniAppName = 'table', webappUrl = 'https://poker.example',
    durakDeck = durakDecks(1), tg = null,
  } = {}) {
    this.chatId = chatId;
    this.tg = tg || new TelegramStub();
    this.errors = [];
    this.clock = clock;
    this.app = new App({
      api: this.tg, store, minIntervalMs, botUsername, deck, durakDeck, clock, runoutStepMs, miniAppName, webappUrl,
      onError: (e) => this.errors.push(e),
    });
    this.hub = new Hub(this.app, { botToken: TEST_TOKEN });
    this.app.attachHub(this.hub);
    /** userId -> { session, inbox: [] } */
    this.pages = new Map();
    this.date = 1_700_000_000; // Telegram message clock, in seconds
  }

  get room() {
    return this.app.room(this.chatId);
  }

  /** The newest durak game of this group. */
  get durak() {
    return this.app.roomsOf(this.chatId).filter((r) => r.game === 'durak').at(-1) || null;
  }

  /** This group's hub record (after /play). */
  get group() {
    return this.app.groups.get(String(this.chatId)) || null;
  }

  /** Swap the pack the NEXT durak games are dealt from. */
  useDurakDeck(fn) {
    this.app.durakDeck = fn;
    return this;
  }

  /** Swap the deck the NEXT hands are dealt from. */
  useDeck(fn) {
    this.app.deck = fn;
    return this;
  }

  /* ------------------------------------------------------------- Telegram */

  /** A message typed into the group — ids share one counter with the bot's. */
  async cmd(from, text, extra = {}) {
    this.date += extra.date != null ? 0 : 5;
    const upd = cmdUpdate(this.chatId, from, text, { message_id: this.tg.nextId++, date: extra.date ?? this.date, ...extra });
    await this.app.handleUpdate(upd);
    await this.app.settle();
    return this;
  }

  async dm(from, text) {
    await this.app.handleUpdate(dmUpdate(from, text));
    await this.app.settle();
    return this;
  }

  /** Press Start in the bot's private chat — the only way it may write to you. */
  async start(from, payload = '') {
    this.tg.dmOpen.add(String(from.id));
    return this.dm(from, payload ? `/start ${payload}` : '/start');
  }

  async raw(update) {
    await this.app.handleUpdate(update);
    await this.app.settle();
    return this;
  }

  /** Press a button on a group message by raw callback_data (legacy buttons). */
  async pressData(from, data, messageId = this.cardId) {
    await this.app.handleUpdate(pressUpdate(this.chatId, from, data, messageId));
    await this.app.settle();
    return this;
  }

  get cardId() {
    return this.room?.ui?.tableMessageId ?? null;
  }

  /** The group card as it stands. */
  text() {
    return this.tg.message(this.cardId)?.text ?? '';
  }

  cardButtons() {
    return this.tg.message(this.cardId)?.markup?.inline_keyboard?.flat() ?? [];
  }

  /** Text of the newest group message that is not the card (replies, results). */
  lastPost() {
    let found = '';
    for (const [id, m] of this.tg.messages) {
      if (m.chatId !== String(this.chatId) || m.deleted || id === this.cardId) continue;
      found = m.text;
    }
    return found;
  }

  answer() {
    return this.tg.lastAnswer();
  }

  lastDm(u) {
    const all = this.tg.dms(u.id);
    return all[all.length - 1] ?? null;
  }

  /* ------------------------------------------------------------- Mini App */

  /** Open the table in `u`'s Mini App. Returns what the hub said. */
  open(u, { initData = null, room = null } = {}) {
    const inbox = [];
    const r = this.hub.open(
      { initData: initData ?? initDataFor(u, { startParam: this.room?.code, clock: this.clock }), room },
      (msg) => inbox.push(JSON.parse(JSON.stringify(msg)))
    );
    if (r.session) this.pages.set(String(u.id), { session: r.session, inbox });
    return r;
  }

  /**
   * Open the Mini App from the group's hub card — `startapp=g_<code>`, the
   * way the «🎮 Выбрать игру» button does. `room` is what a page asks for
   * after a reconnect (the room it had stepped into).
   */
  openHub(u, { room = null, group = this.group } = {}) {
    if (!group) throw new Error('сначала /play');
    return this.open(u, { initData: initDataFor(u, { startParam: `g_${group.code}`, clock: this.clock }), room });
  }

  /** Open the Mini App on a given room, as its card's button does. */
  openRoom(u, room) {
    return this.open(u, { initData: initDataFor(u, { startParam: room.code, clock: this.clock }) });
  }

  page(u) {
    const id = String(u.id);
    if (!this.pages.has(id)) {
      const r = this.open(u);
      if (!r.session) throw new Error(`не открылся стол для ${u.first_name}: ${r.text}`);
    }
    return this.pages.get(id);
  }

  close(u) {
    const p = this.pages.get(String(u.id));
    if (p) this.hub.close(p.session);
    this.pages.delete(String(u.id));
  }

  /** Send one message from `u`'s Mini App, and let everything it causes happen. */
  async send(u, msg) {
    const p = this.page(u);
    await this.hub.handle(p.session, msg);
    await this.app.settle();
    return this;
  }

  /** The latest state `u`'s Mini App holds. */
  state(u) {
    const inbox = this.page(u).inbox;
    for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].t === 'state') return inbox[i].state;
    return null;
  }

  /** Every message `u`'s Mini App ever received, as one string — for leak hunts. */
  received(u) {
    return JSON.stringify(this.pages.get(String(u.id))?.inbox ?? []);
  }

  /** The last error toast `u` got, or null. */
  lastError(u) {
    const inbox = this.page(u).inbox;
    for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].t === 'error') return inbox[i];
    return null;
  }

  act(u, action, amount, { seq } = {}) {
    return this.send(u, { t: 'act', action, amount, ...(seq != null ? { seq } : {}) });
  }

  /* -------------------------------------------------------------- sugar */

  /** Chips in stacks plus chips in the pot: the invariant the engine guarantees. */
  chips() {
    return this.room.players.reduce((s, p) => s + p.stack + (p.committed && this.room.hand?.phase !== 'complete' ? p.committed : 0), 0);
  }

  actor() {
    return this.room?.hand?.actorId ?? null;
  }

  /** The `user` object whose turn it is, given the cast of the test. */
  actorOf(cast) {
    const id = this.actor();
    return Object.values(cast).find((u) => String(u.id) === id) || null;
  }

  /** The two hole cards the bot dealt `u` this hand (card ints), or null. */
  hole(u) {
    return this.room?.hand?.holes?.[String(u.id)] ?? null;
  }

  /** Let `ms` of table time pass: turn timers, the automatic deal, the reveal. */
  async advance(ms) {
    await this.clock.advance(ms);
    await this.app.settle();
    return this;
  }

  /**
   * Set the table up: `cast[0]` creates it in the group, everyone opens the
   * Mini App from the card and sits down. With `dm` everyone has also
   * pressed Start in the bot's private chat (so turn pings can reach them).
   */
  async seat(cast, { blinds = null, stack: chips = null, dm = true } = {}) {
    const list = Object.values(cast);
    if (dm) for (const u of list) await this.start(u);
    await this.cmd(list[0], '/newgame');
    for (const u of list.slice(1)) await this.send(u, { t: 'sit' });
    this.page(list[0]);
    const patch = {};
    if (chips) patch.startingStack = chips;
    if (blinds) Object.assign(patch, { smallBlind: blinds[0], bigBlind: blinds[1] });
    if (Object.keys(patch).length) await this.send(list[0], { t: 'settings', ...patch });
    return this;
  }

  async begin(cast, opts) {
    await this.seat(cast, opts);
    await this.send(Object.values(cast)[0], { t: 'start' });
    return this;
  }

  /** Everyone shoves where they can, otherwise calls. */
  async shoveDown(cast, limit = 24) {
    let guard = 0;
    while (this.room.hand?.phase === 'betting' && guard++ < limit) {
      const who = this.actorOf(cast);
      if (!who) break;
      const l = this.state(who).legal;
      if (l && (l.canBet || l.canRaise) && l.maxTotal > l.currentBet) await this.act(who, 'allin');
      else await this.act(who, l?.canCheck ? 'check' : 'call');
    }
    return this;
  }

  /** Call/check the hand down to showdown. */
  async runToShowdown(cast, limit = 60) {
    let guard = 0;
    while (this.room.hand?.phase === 'betting' && guard++ < limit) {
      const who = this.actorOf(cast);
      if (!who) break;
      const l = this.state(who).legal;
      await this.act(who, l?.canCheck ? 'check' : 'call');
    }
    return this;
  }
}
