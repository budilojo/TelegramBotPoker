'use strict';
/**
 * Test harness. Lets a test read like a hand of poker instead of like a pile
 * of Telegram update objects.
 */
import { App } from './app.js';
import { TelegramStub, cmdUpdate, pressUpdate, dmUpdate, user } from './tg-stub.js';
import { NullStore } from './store.js';
import { dealOrder } from './cards.js';
import { parseCard, freshDeck, shuffled, seededRng } from './deck.js';

export { user };

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
    String(board).trim().split(/\s+/).filter(Boolean).map(parseCard)
      .forEach((c, k) => put(2 * n + k, c));
    const rest = shuffled(seededRng(seed)).filter((c) => !used.has(c));
    for (let i = 0; i < 52; i++) if (deck[i] == null) deck[i] = rest.shift();
    return deck;
  };
}

/** A different honest-looking deck every hand, reproducible from the seed. */
export function seededDecks(seed = 1) {
  const rnd = seededRng(seed);
  return () => shuffled(rnd);
}

export { freshDeck };

export class Table {
  constructor({
    chatId = -1001234, minIntervalMs = 0, store = new NullStore(), botUsername = 'ChipTableBot', deck = seededDecks(1),
  } = {}) {
    this.chatId = chatId;
    this.tg = new TelegramStub();
    this.errors = [];
    this.app = new App({
      api: this.tg,
      store,
      minIntervalMs,
      botUsername,
      deck,
      onError: (e) => this.errors.push(e),
    });
    this.date = 1_700_000_000; // Telegram message clock, in seconds
  }

  get room() {
    return this.app.room(this.chatId);
  }

  /** Swap the deck the NEXT hands are dealt from. */
  useDeck(fn) {
    this.app.deck = fn;
    return this;
  }

  /* --------------------------------------------------------------- input */

  /**
   * A message typed into the group. It takes its id from the same counter as
   * the bot's own messages, as in a real supergroup — that is how the bot
   * tells whether its table has been buried under the conversation. Each
   * message is sent a few seconds after the previous one unless `date` says
   * otherwise.
   */
  async cmd(from, text, extra = {}) {
    this.date += extra.date != null ? 0 : 5;
    const upd = cmdUpdate(this.chatId, from, text, {
      message_id: this.tg.nextId++,
      date: extra.date ?? this.date,
      ...extra,
    });
    await this.app.handleUpdate(upd);
    await this.app.settle();
    return this;
  }

  /** A message in the private chat with the bot. */
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

  /** Press a button on the TABLE message, found by its visible label. */
  async press(from, label) {
    const b = this.button(label);
    if (!b) {
      throw new Error(
        `нет кнопки "${label}". Есть: ${this.buttons().map((x) => x.text).join(' | ')}`
      );
    }
    return this.pressData(from, b.callback_data);
  }

  /** Press by raw callback_data — used to replay somebody else's button. */
  async pressData(from, data, messageId = this.tableId) {
    await this.app.handleUpdate(pressUpdate(this.chatId, from, data, messageId));
    await this.app.settle();
    return this;
  }

  /** Press a button on the most recent HOST PANEL (kick / rebuy / host). */
  async panel(from, label) {
    const m = this.lastPanel();
    if (!m) throw new Error('панель не открыта');
    const b = m.markup.inline_keyboard.flat().find((x) => x.text.toLowerCase().includes(String(label).toLowerCase()));
    if (!b) throw new Error(`нет кнопки "${label}" в панели`);
    return this.pressData(from, b.callback_data, m.id);
  }

  /** "🂠 Мои карты" — returns the popup exactly as Telegram shows it to `from`. */
  async peek(from) {
    await this.press(from, 'Мои карты');
    return this.answer();
  }

  /* -------------------------------------------------------------- output */

  get tableId() {
    return this.room?.ui?.tableMessageId ?? null;
  }

  text() {
    const m = this.tg.message(this.tableId);
    return m ? m.text : '';
  }

  buttons() {
    const m = this.tg.message(this.tableId);
    return m?.markup?.inline_keyboard?.flat() ?? [];
  }

  /**
   * Find a button by its visible label, best match first. Ranking matters:
   * a plain `includes` makes "ALL-IN" match "CALL 2 975 (all-in)" and the
   * test then silently drives the wrong action.
   */
  button(label) {
    const n = String(label).toLowerCase();
    const all = this.buttons().filter((b) => b.callback_data);
    return (
      all.find((b) => b.text.toLowerCase() === n) ||
      all.find((b) => b.text.toLowerCase().startsWith(n)) ||
      all.find((b) => b.text.toLowerCase().includes(n)) ||
      null
    );
  }

  labels() {
    return this.buttons().map((b) => b.text);
  }

  lastPanel() {
    let found = null;
    for (const [id, m] of this.tg.messages) {
      if (m.chatId !== String(this.chatId) || m.deleted || id === this.tableId) continue;
      if (m.markup?.inline_keyboard?.some((row) => row.some((b) => b.callback_data))) found = { id, ...m };
    }
    return found;
  }

  /** Text of the newest plain message (errors, results, prompts). */
  lastPost() {
    let found = '';
    for (const [id, m] of this.tg.messages) {
      if (m.chatId !== String(this.chatId) || m.deleted) continue;
      if (id === this.tableId) continue;
      found = m.text;
    }
    return found;
  }

  answer() {
    return this.tg.lastAnswer();
  }

  /** Newest private message the bot sent to `u`. */
  lastDm(u) {
    const all = this.tg.dms(u.id);
    return all[all.length - 1] ?? null;
  }

  /** The two hole cards the bot dealt `u` this hand (card ints), or null. */
  hole(u) {
    return this.room?.hand?.holes?.[String(u.id)] ?? null;
  }

  /**
   * Press without draining the outbox — the only way to observe coalescing,
   * since state mutates synchronously but the redraw is queued.
   */
  async fire(from, label) {
    const b = this.button(label);
    if (!b) throw new Error(`нет кнопки "${label}"`);
    await this.app.handleUpdate(pressUpdate(this.chatId, from, b.callback_data, this.tableId));
    return this;
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

  /**
   * Seat everybody and set the table up. `cast[0]` is the host. Everyone
   * presses Start in private first (as the lobby asks them to), unless
   * `dm: false` — for the tests about people who did not.
   */
  async seat(cast, { blinds = null, stack: chips = null, dm = true } = {}) {
    const list = Object.values(cast);
    if (dm) for (const u of list) await this.start(u);
    await this.cmd(list[0], '/newgame');
    for (const u of list.slice(1)) await this.cmd(u, '/join');
    if (chips) await this.cmd(list[0], `/stack ${chips}`);
    if (blinds) await this.cmd(list[0], `/blinds ${blinds[0]} ${blinds[1]}`);
    return this;
  }

  async begin(cast, opts) {
    await this.seat(cast, opts);
    await this.press(Object.values(cast)[0], 'Начать игру');
    return this;
  }

  /**
   * Everyone shoves where they can, otherwise calls — the quickest way to a
   * board with side pots. Note the deliberate `startsWith`: a plain substring
   * match on "ALL-IN" also hits "CALL 2 975 (all-in)", which is a different
   * action entirely.
   */
  async shoveDown(cast, limit = 24) {
    let guard = 0;
    while (this.room.hand?.phase === 'betting' && guard++ < limit) {
      const who = this.actorOf(cast);
      if (!who) break;
      const allIn = this.buttons().find((b) => b.text.startsWith('ALL-IN'));
      if (allIn) {
        await this.pressData(who, allIn.callback_data);
        await this.press(who, 'ПОДТВЕРДИТЬ');
      } else {
        await this.press(who, this.button('CALL') ? 'CALL' : 'CHECK');
      }
    }
    return this;
  }

  /** Call/check the hand down to showdown. */
  async runToShowdown(cast, limit = 60) {
    let guard = 0;
    while (this.room.hand?.phase === 'betting' && guard++ < limit) {
      const who = this.actorOf(cast);
      if (!who) break;
      await this.press(who, this.button('CHECK') ? 'CHECK' : 'CALL');
    }
    return this;
  }
}
