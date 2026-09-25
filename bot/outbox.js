'use strict';
/**
 * Everything that talks to Telegram, and every Telegram quirk that costs a
 * day if you meet it in production:
 *
 * 1. Rate limits. Roughly 30 messages/second overall and ~20/minute into one
 *    group — edits count. So the table is ONE message that gets edited, and
 *    redraws are coalesced: a burst of state changes produces one edit of the
 *    LATEST state, never a queue of intermediate ones.
 * 2. `editMessageText` with identical text fails with
 *    `400: message is not modified`. The last rendered text and keyboard are
 *    kept on the room and compared before sending.
 * 3. The table message can be deleted by a human. An edit then fails with
 *    "message to edit not found" — post a fresh one instead of dying.
 * 4. 429 carries `retry_after`; honour it once rather than hammering.
 * 5. A bot may not write first. A private message to somebody who never
 *    pressed Start (or who blocked the bot) fails with 403 — that is an
 *    expected answer, not a crash, and the caller needs to know which it was.
 */

const NOT_MODIFIED = /message is not modified/i;
const GONE = /message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i;
const FORBIDDEN = /bot can't initiate conversation|bot was blocked|user is deactivated|chat not found|Forbidden/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Telegram error shape, whether it comes from grammY or the test stub. */
function describe(err) {
  return String(err?.description ?? err?.message ?? err ?? '');
}
function retryAfter(err) {
  const n = err?.parameters?.retry_after ?? err?.retry_after;
  return Number.isFinite(n) ? n : null;
}

export class Outbox {
  /**
   * @param api    the Telegram port (grammY's `bot.api`, or the test stub)
   * @param minIntervalMs  floor between two edits of the same chat
   * @param timers  `{ now, setTimeout, clearTimeout }` — the app's clock, so a
   *                test can space taps out in time without waiting for real
   */
  constructor(api, { minIntervalMs = 1000, onError = () => {}, timers = null } = {}) {
    this.api = api;
    this.minIntervalMs = minIntervalMs;
    this.onError = onError;
    this.timers = timers ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
    };
    /** @type {Map<string, {last:number, timer:any, pending:null|Function, running:boolean}>} */
    this.chats = new Map();
  }

  slot(chatId) {
    const key = String(chatId);
    let s = this.chats.get(key);
    if (!s) {
      s = { last: 0, timer: null, pending: null, running: false };
      this.chats.set(key, s);
    }
    return s;
  }

  /**
   * Ask for `produce()` to be run for this chat. `produce` is called at FLUSH
   * time, not now, so a coalesced burst always renders the latest state.
   */
  schedule(chatId, produce) {
    const s = this.slot(chatId);
    s.pending = produce;
    if (s.running || s.timer) return;
    const wait = Math.max(0, s.last + this.minIntervalMs - this.timers.now());
    if (wait === 0) return void this.#fire(chatId);
    s.timer = this.timers.setTimeout(() => {
      s.timer = null;
      this.#fire(chatId);
    }, wait);
  }

  async #fire(chatId) {
    const s = this.slot(chatId);
    if (s.running) return;
    const produce = s.pending;
    if (!produce) return;
    s.pending = null;
    s.running = true;
    s.last = this.timers.now();
    try {
      await produce();
    } catch (err) {
      this.onError(err, chatId);
    } finally {
      s.running = false;
      if (s.pending && !s.timer) {
        s.timer = this.timers.setTimeout(() => {
          s.timer = null;
          this.#fire(chatId);
        }, this.minIntervalMs);
      }
    }
  }

  /**
   * Forget a queued redraw. Needed before anything that replaces the table
   * message outright: a stale closure firing afterwards would edit the new
   * message, or re-attach a keyboard to a hand that is already frozen.
   */
  cancel(chatId) {
    const s = this.slot(chatId);
    s.pending = null;
    if (s.timer) {
      this.timers.clearTimeout(s.timer);
      s.timer = null;
    }
  }

  /** Drain everything immediately — used by tests and by graceful shutdown. */
  async drain() {
    for (let i = 0; i < 20; i++) {
      const slots = [...this.chats.values()];
      const busy = slots.filter((s) => s.pending || s.running || s.timer);
      if (!busy.length) return;
      for (const [chatId, s] of this.chats) {
        if (s.timer) {
          this.timers.clearTimeout(s.timer);
          s.timer = null;
        }
        if (s.pending && !s.running) await this.#fire(chatId);
      }
      await sleep(0);
    }
  }

  /* ------------------------------------------------------------- requests */

  async #call(method, ...args) {
    try {
      return await this.api[method](...args);
    } catch (err) {
      const wait = retryAfter(err);
      if (wait != null) {
        await sleep(Math.min(wait, 30) * 1000);
        return await this.api[method](...args);
      }
      throw err;
    }
  }

  /**
   * Draw `view` as the room's single table message: edit when it exists,
   * post when it does not, skip entirely when nothing changed.
   *
   * `move: true` re-posts the table at the bottom of the chat and deletes the
   * old copy. That is for when people are typing commands: each /call pushes
   * the table further up, and an edit nobody can see is no use to the next
   * player. A bot may always delete its own messages in a group, so this
   * needs no admin rights.
   */
  async draw(room, view, { forceNew = false, move = false } = {}) {
    const markup = view.keyboard?.length ? { inline_keyboard: view.keyboard } : undefined;
    const kbKey = JSON.stringify(markup ?? null);
    const opts = { parse_mode: 'HTML', reply_markup: markup, link_preview_options: { is_disabled: true } };

    if (move && room.ui.tableMessageId) {
      const old = room.ui.tableMessageId;
      const msg = await this.#call('sendMessage', room.chatId, view.text, opts);
      room.ui.tableMessageId = msg.message_id;
      room.ui.lastText = view.text;
      room.ui.lastKb = kbKey;
      // Older than 48 hours cannot be deleted; then at least take its buttons.
      if (!(await this.remove(room.chatId, old))) await this.dropKeyboard(room.chatId, old);
      return { sent: true, moved: true, message_id: msg.message_id };
    }

    if (!forceNew && room.ui.tableMessageId) {
      if (room.ui.lastText === view.text && room.ui.lastKb === kbKey) return { skipped: true };
      try {
        await this.#call('editMessageText', room.chatId, room.ui.tableMessageId, view.text, opts);
        room.ui.lastText = view.text;
        room.ui.lastKb = kbKey;
        return { edited: true };
      } catch (err) {
        const d = describe(err);
        // Racing redraws can still collide; that error is not a failure.
        if (NOT_MODIFIED.test(d)) {
          room.ui.lastText = view.text;
          room.ui.lastKb = kbKey;
          return { skipped: true };
        }
        if (!GONE.test(d)) throw err;
        room.ui.tableMessageId = null; // somebody deleted it — start over
      }
    }

    const msg = await this.#call('sendMessage', room.chatId, view.text, opts);
    room.ui.tableMessageId = msg.message_id;
    room.ui.lastText = view.text;
    room.ui.lastKb = kbKey;
    return { sent: true, message_id: msg.message_id };
  }

  /** A one-off message (hand result, error explanation, host panel). */
  async post(chatId, text, keyboard, extra = {}) {
    return this.#call('sendMessage', chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard?.length ? { inline_keyboard: keyboard } : extra.reply_markup,
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  }

  /**
   * MUST be called for every callback_query, including refusals: without it
   * the user's button spins forever and they assume the bot is dead.
   */
  async answer(id, text, { alert = false, url = null } = {}) {
    const opts = {};
    if (text) {
      opts.text = text;
      opts.show_alert = alert;
    }
    // `t.me/<bot>?start=...` — the one URL a callback answer may open without
    // a game: it takes the person straight into the private chat.
    if (url) opts.url = url;
    try {
      await this.api.answerCallbackQuery(id, opts);
    } catch (err) {
      this.onError(err, null);
    }
  }

  /**
   * A private message. Never throws for the expected refusal (never pressed
   * Start, blocked the bot): that comes back as `{ ok:false, forbidden:true }`
   * so the game can fall back instead of stalling.
   */
  async dm(userId, text, keyboard = null) {
    try {
      const msg = await this.#call('sendMessage', userId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
      return { ok: true, message_id: msg.message_id };
    } catch (err) {
      const forbidden = FORBIDDEN.test(describe(err)) || err?.error_code === 403;
      if (!forbidden) this.onError(err, userId);
      return { ok: false, forbidden };
    }
  }

  /**
   * Freeze an old table message: the text stays as the record of that hand,
   * the buttons go away so nobody taps a hand that is already over.
   */
  async dropKeyboard(chatId, messageId) {
    if (!messageId) return;
    try {
      await this.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: undefined });
    } catch (err) {
      const d = describe(err);
      if (!NOT_MODIFIED.test(d) && !GONE.test(d)) this.onError(err, chatId);
    }
  }

  /** A private message of ours that has served its purpose (a stale "your turn"). */
  async removePrivate(userId, messageId) {
    return this.remove(userId, messageId);
  }

  /** @returns true when the message is gone */
  async remove(chatId, messageId) {
    if (!messageId) return false;
    try {
      await this.api.deleteMessage(chatId, messageId);
      return true;
    } catch {
      /* somebody else's message needs admin rights; ours older than 48h cannot go */
      return false;
    }
  }
}
