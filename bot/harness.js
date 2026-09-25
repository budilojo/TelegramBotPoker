'use strict';
/**
 * Test harness. Lets a test read like a hand of poker instead of like a pile
 * of Telegram update objects.
 */
import { App } from './app.js';
import { TelegramStub, cmdUpdate, pressUpdate, user } from './tg-stub.js';
import { NullStore } from './store.js';

export { user };

export class Table {
  constructor({ chatId = -1001234, minIntervalMs = 0, store = new NullStore(), botUsername = 'ChipTableBot' } = {}) {
    this.chatId = chatId;
    this.tg = new TelegramStub();
    this.errors = [];
    this.app = new App({
      api: this.tg,
      store,
      minIntervalMs,
      botUsername,
      onError: (e) => this.errors.push(e),
    });
  }

  get room() {
    return this.app.room(this.chatId);
  }

  /* --------------------------------------------------------------- input */

  async cmd(from, text, extra = {}) {
    await this.app.handleUpdate(cmdUpdate(this.chatId, from, text, extra));
    await this.app.settle();
    return this;
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

  /** Press a button on the most recent HOST PANEL (roles / kick). */
  async panel(from, label) {
    const m = this.lastPanel();
    if (!m) throw new Error('панель не открыта');
    const b = m.markup.inline_keyboard.flat().find((x) => x.text.toLowerCase().includes(String(label).toLowerCase()));
    if (!b) throw new Error(`нет кнопки "${label}" в панели`);
    return this.pressData(from, b.callback_data, m.id);
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
    const all = this.buttons();
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
      if (m.markup?.inline_keyboard?.length) found = { id, ...m };
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

  /** Total chips on the table: the invariant the engine guarantees. */
  chips() {
    return this.room.players.reduce((s, p) => s + p.stack, 0);
  }

  actor() {
    return this.room?.hand?.actorId ?? null;
  }

  /** The `user` object whose turn it is, given the cast of the test. */
  actorOf(cast) {
    const id = this.actor();
    return Object.values(cast).find((u) => String(u.id) === id) || null;
  }

  /** Seat everybody and start the game. `cast[0]` is the host. */
  async seat(cast, { blinds = null, stack = null } = {}) {
    const list = Object.values(cast);
    await this.cmd(list[0], '/newgame');
    for (const u of list.slice(1)) await this.cmd(u, '/join');
    if (stack) await this.cmd(list[0], `/stack ${stack}`);
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
