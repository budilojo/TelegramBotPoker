'use strict';
/**
 * The bot's brain. The game itself is played in the Mini App (see hub.js);
 * the Telegram side is the lobby and the notifications:
 *
 *   - in the group: ONE card per game — created by /newgame, then only ever
 *     edited (edits do not ring anybody's phone) — with the button that opens
 *     the table; and the results of the evening at the end. Nothing else.
 *   - in private: "👉 your turn", only for somebody whose table is closed,
 *     and deleted again once the turn has passed.
 *
 * It also owns what has to run without anybody pressing anything: the turn
 * timer, the automatic next deal, and turning an all-in board over.
 *
 * THE TWO RULES still hold, and are enforced where the moves now come in:
 * nobody acts for somebody else (identity = verified initData, hub.js), and
 * nobody sees somebody else's cards (each viewer gets their own state,
 * view.js). The only move the bot ever makes in somebody's place is the turn
 * timer's — switched on by the host, and only a free check or a fold.
 */
import { identify } from './identity.js';
import * as R from './room.js';
import { renderCard, renderResults, renderTurnPing } from './render.js';
import { Outbox } from './outbox.js';
import { NullStore } from './store.js';
import { esc } from './fmt.js';

const HELP = [
  '♠️ <b>Покер в Telegram</b> — техасский холдем за столом в мини-приложении.',
  '',
  '<b>/newgame</b> — создать стол. Бот пришлёт карточку с кнопкой «Открыть стол» — дальше всё там:',
  'карты, ставки, банк, чей ход.',
  '',
  '/table — показать карточку стола внизу чата',
  '/finish — завершить игру и показать итоги (хост)',
  '/cancel — удалить стол (хост)',
  '',
  'Чтобы бот мог напомнить, что ваш ход, — один раз нажмите Start у него в личке.',
].join('\n');

const HELP_DM = [
  '♠️ <b>Покер в Telegram</b>',
  '',
  'Сюда приходят напоминания «ваш ход» — только когда стол у вас закрыт.',
  'Сама игра — в группе: напишите там /newgame и откройте стол.',
].join('\n');

const WELCOME_DM = '✅ Готово: если стол будет закрыт, когда до вас дойдёт ход, — напомню здесь.';

/** The real clock. Tests pass a fake one and move time by hand. */
const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

export class App {
  /**
   * @param deck           test seam: `(room) => number[52]` — a stacked deck
   * @param clock          `{ now, setTimeout, clearTimeout }` for the timers
   * @param runoutStepMs   pause between streets when an all-in board is shown
   * @param webappUrl      public HTTPS address of the Mini App
   * @param miniAppName    the short name registered with @BotFather (/newapp):
   *                       then the group button opens the table directly
   */
  constructor({
    api, store = new NullStore(), minIntervalMs = 1000, botUsername = '', onError = null, deck = null,
    clock = REAL_CLOCK, runoutStepMs = 1500, webappUrl = '', miniAppName = '',
  } = {}) {
    this.api = api;
    this.store = store;
    this.botUsername = botUsername;
    this.deck = deck;
    this.clock = clock;
    this.runoutStepMs = runoutStepMs;
    this.webappUrl = String(webappUrl || '').replace(/\/+$/, '');
    this.miniAppName = miniAppName;
    this.hub = null; // set by attachHub()
    this.log = onError || ((err) => console.error('[bot]', err?.description || err?.message || err));
    this.outbox = new Outbox(api, { minIntervalMs, onError: this.log, timers: clock });
    /** @type {Map<string, object>} chatId -> room */
    this.rooms = new Map();
    /** `${kind}:${chatId}` -> { key, deadline, h } — every timer the bot holds */
    this.handles = new Map();
    /** private-chat work in flight (turn pings) — awaited by settle() */
    this.inflight = new Set();
  }

  attachHub(hub) {
    this.hub = hub;
    return this;
  }

  room(chatId) {
    return this.rooms.get(String(chatId)) || null;
  }

  roomByCode(code) {
    if (!code) return null;
    for (const room of this.rooms.values()) if (room.code === code) return room;
    return null;
  }

  /* ---------------------------------------------------------- persistence */

  load() {
    for (const { chatId, data } of this.store.loadAll()) {
      try {
        this.rooms.set(String(chatId), R.deserialize(data));
      } catch (err) {
        this.log(err);
      }
    }
    return this.rooms.size;
  }

  save(room) {
    try {
      this.store.save(room, R.serialize(room, this.clock.now()));
    } catch (err) {
      this.log(err);
    }
  }

  /** After a restart: redraw every live card; open tables reconnect by themselves. */
  async resume() {
    this.syncClocks(); // timers come back with the time that was LEFT, not less
    let drawn = 0;
    for (const room of this.rooms.values()) {
      if (room.status === 'finished') continue;
      try {
        // Staggered: the global ceiling is ~30 messages a second.
        if (drawn++) await new Promise((r) => setTimeout(r, 50));
        await this.draw(room, { immediate: true });
      } catch (err) {
        this.log(err);
      }
    }
    return drawn;
  }

  /* ---------------------------------------------------------- the table link */

  /**
   * The group button. A `web_app` button is not allowed in groups, so this is
   * a plain link: with a Mini App registered at @BotFather it opens the table
   * directly (`startapp` arrives signed, inside initData). Without one, it
   * opens the bot's private chat, and the bot answers with a `web_app` button.
   */
  tableLink(room) {
    if (!this.botUsername) return null;
    if (this.miniAppName) return `https://t.me/${this.botUsername}/${this.miniAppName}?startapp=${room.code}`;
    return `https://t.me/${this.botUsername}?start=t_${room.code}`;
  }

  /** A `web_app` button — private chats only. */
  webAppButton(room, text = '🃏 Открыть стол') {
    if (!this.webappUrl) return null;
    return { text, web_app: { url: `${this.webappUrl}/?room=${room.code}` } };
  }

  /* -------------------------------------------------------------- drawing */

  /**
   * Something changed. Everyone at the table gets their own view NOW (a
   * socket has no rate limit), the group card is re-rendered at most once a
   * second (Telegram does), and whoever is on the clock with their table
   * closed gets a nudge.
   */
  draw(room, { immediate = false } = {}) {
    this.syncClocks(); // the view carries the turn deadline: set it first
    this.hub?.broadcast(room);
    this.track(this.pingTurn(room));
    const produce = async () => {
      const view = renderCard(room, { link: this.tableLink(room) });
      const kbKey = JSON.stringify(view.keyboard?.length ? { inline_keyboard: view.keyboard } : null);
      const unchanged = room.ui.lastText === view.text && room.ui.lastKb === kbKey;
      const buried = !!room.ui.tableMessageId && (room.ui.lastMsgId || 0) - room.ui.tableMessageId >= 2;
      await this.outbox.draw(room, view, { move: buried && !unchanged });
      this.seen(room, room.ui.tableMessageId);
      this.save(room);
    };
    if (immediate) return produce();
    this.outbox.schedule(room.chatId, produce);
    return Promise.resolve();
  }

  track(promise) {
    if (!promise) return;
    const p = Promise.resolve(promise).catch((err) => this.log(err)).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /** Remember the newest message id in a chat — the measure of "buried". */
  seen(room, messageId) {
    if (room && Number.isFinite(messageId)) room.ui.lastMsgId = Math.max(room.ui.lastMsgId || 0, messageId);
  }

  /** Post the card again at the bottom of the chat; the old copy loses its button. */
  async newCard(room) {
    this.outbox.cancel(room.chatId);
    const old = room.ui.tableMessageId;
    if (old) await this.outbox.dropKeyboard(room.chatId, old);
    room.ui.tableMessageId = null;
    room.ui.lastText = null;
    room.ui.lastKb = null;
    await this.draw(room, { immediate: true });
    this.save(room);
  }

  /** Test seam and shutdown: wait until every redraw and ping has gone out. */
  async settle() {
    for (let i = 0; i < 10; i++) {
      await this.outbox.drain();
      if (!this.inflight.size) return;
      await Promise.all([...this.inflight]);
    }
  }

  /* ------------------------------------------------------- "your turn" pings */

  /**
   * A new turn started. If the player on the clock does not have the table
   * open, send them a private "👉 your turn" with a button that opens it. The
   * previous ping — for a turn that has passed — is deleted, so a private
   * chat never fills up with stale calls to act.
   */
  async pingTurn(room) {
    const key = room.status === 'playing' ? R.turnKey(room) : null;
    const last = room.ui.ping;
    if ((last?.key ?? null) === key) return;
    room.ui.ping = key ? { key, userId: null, messageId: null } : null;
    if (last?.messageId) await this.outbox.removePrivate(last.userId, last.messageId);
    if (!key) return;

    const actor = R.findPlayer(room, room.hand.actorId);
    if (!actor || actor.dm !== 'ok') return; // never pressed Start: nobody to write to
    if (this.hub?.isPresent(room.code, actor.id)) return; // looking at the table already
    const btn = this.webAppButton(room) || (this.tableLink(room) ? { text: '🃏 Открыть стол', url: this.tableLink(room) } : null);
    const r = await this.outbox.dm(actor.tgId, renderTurnPing(room, actor), btn ? [[btn]] : null);
    if (r.forbidden) this.setDm(actor.id, 'fail', { redraw: false });
    // Only remember it if the turn is still the same one we pinged about.
    if (r.ok && room.ui.ping?.key === key) room.ui.ping = { key, userId: actor.tgId, messageId: r.message_id };
    else if (r.ok) await this.outbox.removePrivate(actor.tgId, r.message_id);
  }

  /* ------------------------------------------------------------ the deal */

  /** `{ deck }` for the room layer: stacked in tests, shuffled otherwise. */
  dealOpts(room) {
    return this.deck ? { deck: () => this.deck(room) } : {};
  }

  /**
   * Can the bot write to this person? Known from Start ('ok'), a bounced
   * message ('fail'), or Telegram telling us they blocked/unblocked the bot.
   */
  setDm(userId, status, { redraw = true } = {}) {
    const id = String(userId);
    if (this.store.getDm(id) !== status) this.store.setDm(id, status);
    for (const room of this.rooms.values()) {
      const p = R.findPlayer(room, id);
      if (!p || p.dm === status) continue;
      p.dm = status;
      if (redraw && room.status !== 'finished') this.draw(room);
    }
  }

  person(user) {
    return { id: user.id, tgId: user.tgId, name: user.name, dm: this.store.getDm(user.id) };
  }

  /** Chips or cards moved: show it — or, if that ended the game, the results. */
  async afterAction(room) {
    // An all-in board is shown street by street; the reveal posts the
    // results itself at the end if this was the last hand of the game.
    if (this.startReveal(room)) return this.draw(room);
    if (room.status === 'finished') return this.finishUp(room);
    await this.draw(room);
  }

  /** A hand was dealt (or the game ended instead). */
  async afterDeal(room, r) {
    if (r?.finished) return this.finishUp(room);
    // Blinds alone can put everybody all-in: then the board is turned over at
    // once, and that may even end the game on the spot.
    const revealing = this.startReveal(room);
    if (room.status === 'finished' && !revealing) return this.finishUp(room);
    await this.draw(room);
  }

  /** Settings, seats, roles — nothing that could end a hand. */
  async afterChange(room) {
    await this.draw(room);
  }

  /* --------------------------------------------------------------- router */

  async handleUpdate(update) {
    try {
      if (update.callback_query) return await this.onCallback(update.callback_query);
      if (update.message) return await this.onMessage(update.message);
      if (update.my_chat_member) return await this.onMyChatMember(update.my_chat_member);
    } catch (err) {
      this.log(err);
      // A crash must never leave a spinner on somebody's button.
      if (update.callback_query) {
        await this.outbox.answer(update.callback_query.id, 'Ошибка. Попробуйте ещё раз.');
      }
    } finally {
      // Whatever just happened may have started a turn, ended one or ended a
      // hand: re-arm the timers from the state, not from what we think changed.
      this.syncClocks();
    }
  }

  /* --------------------------------------------------------------- clocks */

  /**
   * The turn timer and the automatic deal, for every table. Idempotent: the
   * room layer works out what should be running, this only makes the real
   * timers match — arming new ones, dropping ones nobody needs.
   */
  syncClocks() {
    const now = this.clock.now();
    const live = new Set();
    for (const room of this.rooms.values()) {
      const chatId = room.chatId;
      const turn = R.syncTurn(room, now);
      this.arm(`turn:${chatId}`, turn, () => this.onTurnTimeout(chatId, turn.key));
      const next = R.syncAutoNext(room, now);
      this.arm(`next:${chatId}`, next, () => this.onAutoNext(chatId, next.key));
      live.add(`turn:${chatId}`).add(`next:${chatId}`).add(`reveal:${chatId}`);
    }
    for (const [id, cur] of this.handles) {
      if (!live.has(id)) {
        this.clock.clearTimeout(cur.h);
        this.handles.delete(id);
      }
    }
  }

  arm(id, timer, fire) {
    const cur = this.handles.get(id);
    const deadline = timer?.deadline ?? null;
    if (cur && cur.key === timer?.key && cur.deadline === deadline) return;
    if (cur) this.clock.clearTimeout(cur.h);
    this.handles.delete(id);
    if (deadline == null) return;
    const h = this.clock.setTimeout(() => {
      this.handles.delete(id);
      return this.guard(fire);
    }, Math.max(0, deadline - this.clock.now()));
    this.handles.set(id, { key: timer.key, deadline, h });
  }

  /** A timer callback runs outside any update: it must never throw into the void. */
  async guard(fn) {
    try {
      await fn();
    } catch (err) {
      this.log(err);
    }
  }

  /** Stop every timer — shutdown, and the end of a test. */
  stop() {
    for (const cur of this.handles.values()) this.clock.clearTimeout(cur.h);
    this.handles.clear();
  }

  /**
   * The clock ran out on somebody. `key` names the exact turn it was armed
   * for; if they moved in the meantime, the room layer refuses and nothing
   * happens.
   */
  async onTurnTimeout(chatId, key) {
    const room = this.room(chatId);
    if (!room) return;
    const r = R.timeoutMove(room, key, this.clock.now());
    if (!r.error) await this.afterAction(room);
    this.syncClocks(); // a timer that woke a hair early is simply re-armed
  }

  async onAutoNext(chatId, key) {
    const room = this.room(chatId);
    if (!room) return;
    const r = R.autoNextHand(room, key, this.clock.now(), this.dealOpts(room));
    if (!r.error) await this.afterDeal(room, r);
    else if (r.error === 'NOT_ENOUGH_PLAYERS') await this.draw(room);
    this.syncClocks();
  }

  /* --------------------------------------------------------- board reveal */

  /**
   * An all-in before the river: the board was dealt out to five cards in one
   * go, and the pot is already paid. What remains is to SHOW it the way a
   * table does — flop, turn, river — one step every `runoutStepMs`.
   *
   * Runs on timers, never on a sleep: grammY hands the bot one update at a
   * time, and a four-second sleep inside a handler would freeze every other
   * chat the bot is in.
   *
   * @returns true when a reveal started (and will finish the job itself)
   */
  startReveal(room) {
    const h = room.hand;
    if (!this.runoutStepMs || !h || h.phase !== 'complete' || h.runoutFrom == null || h.runoutShown) return false;
    h.runoutShown = true;
    room.ui.reveal = { handNo: h.no, shown: h.runoutFrom };
    this.scheduleReveal(room.chatId, h.no);
    return true;
  }

  scheduleReveal(chatId, handNo) {
    const id = `reveal:${chatId}`;
    const h = this.clock.setTimeout(() => {
      this.handles.delete(id);
      return this.guard(() => this.revealStep(chatId, handNo));
    }, this.runoutStepMs);
    this.handles.set(id, { key: `reveal:${handNo}`, deadline: null, h });
  }

  async revealStep(chatId, handNo) {
    const room = this.room(chatId);
    const r = room?.ui?.reveal;
    // Superseded — a new hand, /finish, a restart: the final view is already up.
    if (!r || r.handNo !== handNo || room.hand?.no !== handNo) return;
    const next = r.shown < 3 ? 3 : r.shown + 1;
    if (next >= 5) {
      // The river comes with the result: that frame IS the showdown.
      room.ui.reveal = null;
      if (room.status === 'finished') await this.finishUp(room);
      else await this.draw(room);
      this.syncClocks(); // the automatic deal counts from here
      return;
    }
    r.shown = next;
    await this.draw(room);
    this.scheduleReveal(chatId, handNo);
  }

  /* ------------------------------------------------------------- messages */

  async onMessage(msg) {
    if (msg.chat?.type === 'private') return this.onPrivate(msg);

    const chatId = String(msg.chat.id);

    // A group promoted to a supergroup changes chat.id. Re-key the table or
    // it is silently lost the moment somebody upgrades the group.
    if (msg.migrate_to_chat_id) return this.migrate(chatId, String(msg.migrate_to_chat_id));

    if (msg.left_chat_member) return this.onLeft(chatId, msg.left_chat_member);
    if (msg.new_chat_members?.length) return this.onJoined(chatId, msg.new_chat_members);
    if (typeof msg.text !== 'string') return;

    const room = this.room(chatId);
    this.seen(room, msg.message_id);
    const cmd = parseCommand(msg.text, this.botUsername);
    if (!cmd) return;
    return this.onCommand(cmd, msg);
  }

  /**
   * The private chat. Start here is what lets the bot send "your turn".
   * `/start t_<code>` comes from the group button when no Mini App is
   * registered at @BotFather: the answer is a `web_app` button, which Telegram
   * allows in private chats only. Nothing here seats anybody anywhere — a
   * deep-link payload is text the user controls.
   */
  async onPrivate(msg) {
    const who = identify(msg.from, msg.sender_chat);
    if (!who.ok) return;
    const user = who.user;
    this.setDm(user.id, 'ok'); // any private message means the chat is open

    const cmd = typeof msg.text === 'string' ? parseCommand(msg.text, this.botUsername) : null;
    if (cmd?.cmd === 'start') {
      const m = /^t_([a-z0-9]{4,32})$/.exec(cmd.rest);
      const room = m ? this.roomByCode(m[1]) : null;
      if (room) {
        const btn = this.webAppButton(room);
        const text = btn
          ? `♠️ Стол${room.title ? ` «${esc(room.title)}»` : ''} — открывайте:`
          : 'Стол есть, но адрес мини-приложения не настроен (WEBAPP_URL). Скажите тому, кто запускает бота.';
        return void (await this.outbox.post(user.tgId, text, btn ? [[btn]] : null));
      }
      return void (await this.outbox.post(user.tgId, cmd.rest ? WELCOME_DM : `${WELCOME_DM}\n\n${HELP_DM}`));
    }
    return void (await this.outbox.post(user.tgId, HELP_DM));
  }

  async onCommand(cmd, msg) {
    const chatId = String(msg.chat.id);
    const who = identify(msg.from, msg.sender_chat);

    if (cmd.cmd === 'start' || cmd.cmd === 'help') return void (await this.reply(chatId, HELP));
    if (!who.ok) return void (await this.reply(chatId, who.text, msg));

    const user = who.user;
    const room = this.room(chatId);

    switch (cmd.cmd) {
      case 'newgame':
      case 'poker': {
        if (room && room.status !== 'finished') {
          return void (await this.reply(
            chatId,
            `Стол уже есть, хост — ${esc(nameOf(room, room.hostId))}. /table — показать его. ` +
              'Новый — после /finish или /cancel.',
            msg
          ));
        }
        if (room) this.hub?.forget(room.code);
        const fresh = R.createRoom({ chatId, title: msg.chat.title, host: this.person(user) });
        this.rooms.set(chatId, fresh);
        await this.newCard(fresh);
        return;
      }

      case 'table': {
        if (!room) return void (await this.reply(chatId, 'Стола нет. /newgame', msg));
        await this.newCard(room);
        return;
      }

      case 'finish': {
        if (!room) return void (await this.reply(chatId, 'Стола нет.', msg));
        const r = R.endGame(room, user.id);
        if (r.error) return void (await this.reply(chatId, this.hostOnly(room), msg));
        await this.finishUp(room);
        return;
      }

      case 'cancel': {
        if (!room) return;
        if (!R.isHost(room, user.id)) return void (await this.reply(chatId, this.hostOnly(room), msg));
        if (room.ui.tableMessageId) await this.outbox.dropKeyboard(chatId, room.ui.tableMessageId);
        this.hub?.forget(room.code);
        this.rooms.delete(chatId);
        this.store.remove(chatId);
        this.syncClocks();
        await this.reply(chatId, 'Стол удалён. /newgame — создать новый.');
        return;
      }

      default:
        return;
    }
  }

  /**
   * Buttons from before the game moved to the Mini App may still sit in the
   * chat. Every press is answered — a silent one leaves a spinner and looks
   * like a dead bot.
   */
  async onCallback(cq) {
    const who = identify(cq.from);
    if (!who.ok) return this.outbox.answer(cq.id, who.text, { alert: true });
    const room = this.room(cq.message?.chat?.id ?? '');
    const link = room ? this.tableLink(room) : null;
    if (link && this.miniAppName) return this.outbox.answer(cq.id, '', { url: link });
    return this.outbox.answer(cq.id, 'Игра теперь идёт в мини-приложении — нажмите «Открыть стол».', { alert: true });
  }

  /* ----------------------------------------------------- chat membership */

  async onLeft(chatId, member) {
    const room = this.room(chatId);
    if (!room) return;
    const r = R.markLeft(room, member.id);
    if (r.error) return;
    await this.afterAction(room);
  }

  async onJoined(chatId, members) {
    const me = members.find((m) => m.is_bot && this.botUsername && m.username === this.botUsername);
    if (me) await this.reply(chatId, HELP);
  }

  async onMyChatMember(u) {
    const status = u.new_chat_member?.status;
    // In a private chat this is the only notice that somebody blocked the bot
    // (or unblocked it): exactly the "can we send a ping" signal.
    if (u.chat?.type === 'private') {
      const id = u.from?.id ?? u.chat.id;
      if (status === 'kicked') this.setDm(id, 'fail');
      else if (status === 'member') this.setDm(id, 'ok');
      return;
    }
    if (status === 'left' || status === 'kicked') {
      const chatId = String(u.chat.id);
      const room = this.room(chatId);
      if (room) this.hub?.forget(room.code);
      this.rooms.delete(chatId);
      this.store.remove(chatId);
    }
  }

  migrate(oldId, newId) {
    const room = this.room(oldId);
    if (!room) return;
    room.chatId = newId;
    // Message ids do not survive the migration either. The room code does,
    // so every open table keeps working without anybody noticing.
    room.ui.tableMessageId = null;
    room.ui.lastText = null;
    room.ui.lastKb = null;
    room.ui.lastMsgId = 0;
    room.ui.reveal = null; // its timer is keyed by the old id and will find nothing
    this.rooms.delete(oldId);
    this.rooms.set(newId, room);
    this.store.migrate(oldId, newId);
    this.save(room);
    return this.newCard(room);
  }

  /* --------------------------------------------------------------- finish */

  async finishUp(room) {
    // The card says the game is over; the results go below it as their own
    // message — the one message of the evening worth a notification.
    this.outbox.cancel(room.chatId);
    room.ui.reveal = null; // the final word is the whole board, not a frame of it
    this.hub?.broadcast(room);
    this.track(this.pingTurn(room)); // drops any "your turn" still hanging around
    if (room.ui.tableMessageId) {
      try {
        await this.outbox.draw(room, renderCard(room, { link: this.tableLink(room) }));
      } catch (err) {
        this.log(err);
      }
    }
    await this.outbox.post(room.chatId, renderResults(room));
    this.save(room);
  }

  /* ---------------------------------------------------------------- utils */

  /** A message in the group; as a reply when it answers somebody's command. */
  async reply(chatId, text, toMsg = null) {
    try {
      const m = await this.outbox.post(chatId, text, null, toMsg ? { reply_parameters: replyTo(toMsg) } : {});
      this.seen(this.room(chatId), m?.message_id);
      return m;
    } catch (err) {
      this.log(err);
      return null;
    }
  }

  hostOnly(room) {
    return `Это может только хост — ${esc(nameOf(room, room.hostId))}.`;
  }
}

/* -------------------------------------------------------------- helpers */

const nameOf = (room, id) => room.players.find((p) => p.id === String(id))?.name ?? '—';

const replyTo = (msg) => (msg?.message_id ? { message_id: msg.message_id, allow_sending_without_reply: true } : undefined);

export function parseCommand(text, botUsername = '') {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(String(text).trim());
  if (!m) return null;
  const [, cmd, addressed, rest] = m;
  // `/join@OtherBot` in a group is not ours to answer.
  if (addressed && botUsername && addressed.toLowerCase() !== botUsername.toLowerCase()) return null;
  const body = (rest || '').trim();
  return { cmd: cmd.toLowerCase(), rest: body, args: body ? body.split(/\s+/) : [] };
}
