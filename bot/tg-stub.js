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
 *   - callback_data longer than 64 bytes is rejected outright;
 *   - a private message to somebody who never pressed Start raises 403
 *     "bot can't initiate conversation with a user" — the rule that shapes
 *     the whole card-delivery design.
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
    /** Users who pressed Start: the only private chats the bot may write to. */
    this.dmOpen = new Set();
    /** Группы, откуда бота удалили, пока он не слышал: писать туда — 403. */
    this.gone = new Set();
    /** Группа стала супергруппой: старый id → новый (Telegram отвечает 400 с migrate_to_chat_id). */
    this.upgraded = new Map();
  }

  #record(method, payload) {
    this.calls.push({ method, ...payload });
    if (this.failNext && this.failNext.method === method) {
      const err = this.failNext.error;
      this.failNext = null;
      throw err;
    }
  }

  #checkKeyboard(markup, chatId) {
    for (const row of markup?.inline_keyboard ?? []) {
      for (const b of row) {
        if (b.url != null) continue; // a link button carries no callback_data
        if (b.web_app != null) {
          // Telegram allows Mini App buttons in private chats only.
          if (Number(chatId) < 0) throw new TelegramError('Bad Request: BUTTON_TYPE_INVALID');
          continue;
        }
        const size = Buffer.byteLength(String(b.callback_data ?? ''), 'utf8');
        if (size > 64 || size === 0) throw new TelegramError(`BUTTON_DATA_INVALID: ${size} bytes`);
      }
    }
  }

  async sendMessage(chatId, text, opts = {}) {
    this.#record('sendMessage', { chatId: String(chatId), text });
    this.#checkKeyboard(opts.reply_markup, chatId);
    // Positive ids are people. Groups and supergroups are negative.
    if (Number(chatId) > 0 && !this.dmOpen.has(String(chatId))) {
      throw new TelegramError("Forbidden: bot can't initiate conversation with a user", 403);
    }
    if (this.gone.has(String(chatId))) throw new TelegramError('Forbidden: bot was kicked from the supergroup chat', 403);
    if (this.upgraded.has(String(chatId))) {
      throw new TelegramError('Bad Request: group chat was upgraded to a supergroup chat', 400, { migrate_to_chat_id: Number(this.upgraded.get(String(chatId))) });
    }
    const id = this.nextId++;
    this.messages.set(id, {
      chatId: String(chatId),
      text,
      markup: opts.reply_markup ?? null,
      deleted: false,
    });
    return { message_id: id, chat: { id: chatId }, text };
  }

  /**
   * Bot API 8.0: сообщение, которое человек потом отправит ОТ СВОЕГО ИМЕНИ в
   * любой чат (`Telegram.WebApp.shareMessage`). В заглушке — только запись.
   */
  async savePreparedInlineMessage(userId, result, opts = {}) {
    this.#record('savePreparedInlineMessage', { userId: String(userId), result, opts });
    this.prepared ??= [];
    const row = { id: `prep${this.prepared.length + 1}`, userId: String(userId), result, opts };
    this.prepared.push(row);
    return { id: row.id, expiration_date: 0 };
  }

  async editMessageText(chatId, messageId, text, opts = {}) {
    this.#record('editMessageText', { chatId: String(chatId), messageId, text });
    this.#checkKeyboard(opts.reply_markup, chatId);
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

  /* -------------------------------------------- payments: Stars (только в тестах) */

  /**
   * Заглушка оплаты Stars. Реальных денег здесь нет: счёт — запись, оплата — то, что тест сам «нажал».
   * Строго как у Telegram: XTR — пустой provider_token и ровно одна цена; повторный возврат — 400.
   */
  async createInvoiceLink(title, description, payload, providerToken, currency, prices) {
    this.#record('createInvoiceLink', { title, description, payload, currency, prices });
    if (currency !== 'XTR' || providerToken !== '' || !Array.isArray(prices) || prices.length !== 1) throw new TelegramError('Bad Request: STARS_INVOICE_INVALID');
    if (Buffer.byteLength(payload, 'utf8') > 128 || !payload) throw new TelegramError('Bad Request: INVOICE_PAYLOAD_INVALID');
    if (String(title).length > 32 || String(description).length > 255) throw new TelegramError('Bad Request: INVOICE_TEXT_INVALID');
    this.invoices ??= [];
    const inv = { slug: `inv${this.invoices.length + 1}`, title, payload, amount: prices[0].amount };
    this.invoices.push(inv);
    return `https://t.me/$${inv.slug}`;
  }

  async answerPreCheckoutQuery(id, ok, opts = {}) {
    this.#record('answerPreCheckoutQuery', { id, ok, error: opts.error_message ?? null });
    this.preAnswers ??= [];
    this.preAnswers.push({ id, ok, error: opts.error_message ?? null });
    return true;
  }

  async refundStarPayment(userId, chargeId) {
    this.#record('refundStarPayment', { userId, chargeId });
    if (typeof userId !== 'number') throw new TelegramError('Bad Request: USER_ID_INVALID');
    this.stars ??= [];
    const paid = this.stars.find((t) => t.id === chargeId && t.source);
    if (!paid || String(paid.source.user.id) !== String(userId)) throw new TelegramError('Bad Request: CHARGE_NOT_FOUND');
    if (this.stars.some((t) => t.id === chargeId && t.receiver)) throw new TelegramError('Bad Request: CHARGE_ALREADY_REFUNDED');
    this.stars.push({ id: chargeId, amount: paid.amount, date: 0, receiver: { type: 'user', user: paid.source.user } });
    return true;
  }

  async getStarTransactions({ offset = 0, limit = 100 } = {}) {
    this.#record('getStarTransactions', { offset, limit });
    // Как у Telegram: свежие первыми.
    return { transactions: [...(this.stars ?? [])].reverse().slice(offset, offset + limit) };
  }

  async answerCallbackQuery(id, opts = {}) {
    this.#record('answerCallbackQuery', { id });
    this.answered.push({ id, text: opts.text ?? '', show_alert: !!opts.show_alert, url: opts.url ?? null });
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

  /** Every message the bot sent into this person's private chat. */
  dms(userId) {
    return [...this.messages.values()].filter((m) => m.chatId === String(userId)).map((m) => m.text);
  }

  /** Every message the bot sent into the group, deleted ones included. */
  groupTexts(chatId) {
    return [...this.messages.values()].filter((m) => m.chatId === String(chatId)).map((m) => m.text);
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
      chat: { id: chatId, type: 'supergroup', title: 'Покер по пятницам' },
      from,
      text,
      ...extra,
    },
  };
}

/** A message in the private chat between `from` and the bot. */
export function dmUpdate(from, text) {
  return {
    update_id: updateId++,
    message: {
      message_id: 900000 + updateId,
      chat: { id: from.id, type: 'private', first_name: from.first_name },
      from,
      text,
      date: Math.floor(Date.now() / 1000),
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
