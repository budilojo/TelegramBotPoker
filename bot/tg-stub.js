'use strict';
/**
 * A fake Telegram. Tests drive the bot through this instead of the network:
 * hitting the real API would be slow, flaky, rate-limited and would need a
 * live group chat, and it would test Telegram rather than this code.
 *
 * It is deliberately not a yes-man. It reproduces the failures that actually
 * bite in production:
 *   - editing a message to the exact same text+markup raises 400
 *     "message is not modified";
 *   - editing a deleted message raises 400 "message to edit not found";
 *   - callback_data longer than 64 bytes is rejected outright.
 */

export class TelegramError extends Error {
  constructor(description, code = 400, parameters = undefined) {
    super(description);
    this.description = description;
    this.error_code = code;
    if (parameters) this.parameters = parameters;
  }
}

const sameMarkup = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class TelegramStub {
  constructor() {
    this.nextId = 100;
    /** @type {Map<number, {chatId:string, text:string, markup:any, deleted:boolean}>} */
    this.messages = new Map();
    this.calls = [];
    this.answered = [];
    this.pinned = new Set();
    this.failNext = null; // queue an error to test recovery paths
  }

  #record(method, payload) {
    this.calls.push({ method, ...payload });
    if (this.failNext && this.failNext.method === method) {
      const err = this.failNext.error;
      this.failNext = null;
      throw err;
    }
  }

  #checkKeyboard(markup) {
    for (const row of markup?.inline_keyboard ?? []) {
      for (const b of row) {
        const size = Buffer.byteLength(String(b.callback_data ?? ''), 'utf8');
        if (size > 64) throw new TelegramError(`BUTTON_DATA_INVALID: ${size} bytes`);
      }
    }
  }

  async sendMessage(chatId, text, opts = {}) {
    this.#record('sendMessage', { chatId: String(chatId), text });
    this.#checkKeyboard(opts.reply_markup);
    const id = this.nextId++;
    this.messages.set(id, {
      chatId: String(chatId),
      text,
      markup: opts.reply_markup ?? null,
      deleted: false,
    });
    return { message_id: id, chat: { id: chatId }, text };
  }

  async editMessageText(chatId, messageId, text, opts = {}) {
    this.#record('editMessageText', { chatId: String(chatId), messageId, text });
    this.#checkKeyboard(opts.reply_markup);
    const m = this.messages.get(messageId);
    if (!m || m.deleted) throw new TelegramError('Bad Request: message to edit not found');
    if (m.text === text && sameMarkup(m.markup, opts.reply_markup)) {
      throw new TelegramError('Bad Request: message is not modified');
    }
    m.text = text;
    m.markup = opts.reply_markup ?? null;
    return { message_id: messageId };
  }

  async editMessageReplyMarkup(chatId, messageId, opts = {}) {
    this.#record('editMessageReplyMarkup', { chatId: String(chatId), messageId });
    const m = this.messages.get(messageId);
    if (!m || m.deleted) throw new TelegramError('Bad Request: message to edit not found');
    if (sameMarkup(m.markup, opts.reply_markup)) {
      throw new TelegramError('Bad Request: message is not modified');
    }
    m.markup = opts.reply_markup ?? null;
    return { message_id: messageId };
  }

  async answerCallbackQuery(id, opts = {}) {
    this.#record('answerCallbackQuery', { id });
    this.answered.push({ id, text: opts.text ?? '', show_alert: !!opts.show_alert });
    return true;
  }

  async deleteMessage(chatId, messageId) {
    this.#record('deleteMessage', { chatId: String(chatId), messageId });
    const m = this.messages.get(messageId);
    if (!m) throw new TelegramError('Bad Request: message to delete not found');
    m.deleted = true;
    return true;
  }

  async pinChatMessage(chatId, messageId) {
    this.#record('pinChatMessage', { chatId: String(chatId), messageId });
    this.pinned.add(messageId);
    return true;
  }

  async unpinChatMessage(chatId, messageId) {
    this.#record('unpinChatMessage', { chatId: String(chatId), messageId });
    this.pinned.delete(messageId);
    return true;
  }

  /* ----------------------------------------------------------- assertions */

  /** The most recent message still carrying buttons — i.e. the live table. */
  live(chatId) {
    let found = null;
    for (const [id, m] of this.messages) {
      if (m.chatId !== String(chatId) || m.deleted) continue;
      if (m.markup?.inline_keyboard?.length) found = { id, ...m };
    }
    return found;
  }

  message(id) {
    return this.messages.get(id);
  }

  /** Every button label currently on the table, flattened. */
  buttons(chatId) {
    const m = this.live(chatId);
    if (!m) return [];
    return m.markup.inline_keyboard.flat();
  }

  /** Find a button whose label contains `needle` (case-insensitive). */
  button(chatId, needle) {
    const n = String(needle).toLowerCase();
    return this.buttons(chatId).find((b) => b.text.toLowerCase().includes(n)) || null;
  }

  lastAnswer() {
    return this.answered[this.answered.length - 1] ?? null;
  }

  countOf(method) {
    return this.calls.filter((c) => c.method === method).length;
  }

  reset() {
    this.calls = [];
    this.answered = [];
  }
}

/* ------------------------------------------------------- update builders */

let updateId = 1;

export function cmdUpdate(chatId, from, text, extra = {}) {
  return {
    update_id: updateId++,
    message: {
      message_id: 900000 + updateId,
      chat: { id: chatId, type: 'supergroup' },
      from,
      text,
      ...extra,
    },
  };
}

export function pressUpdate(chatId, from, data, messageId = 1) {
  return {
    update_id: updateId++,
    callback_query: {
      id: `cb${updateId}`,
      from,
      data,
      message: { message_id: messageId, chat: { id: chatId, type: 'supergroup' } },
    },
  };
}

export const user = (id, name) => ({ id, is_bot: false, first_name: name });

/** The anonymous-admin account every anonymous admin shares. */
export const ANON_USER = { id: 1087968824, is_bot: true, first_name: 'GroupAnonymousBot' };
