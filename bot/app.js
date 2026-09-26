'use strict';
/**
 * The bot's brain — the core of the game hub. The games themselves are
 * played in the Mini App (see hub.js) and their rules live in their own
 * modules (games/); the Telegram side is the lobby and the notifications:
 *
 *   - in the group: `/game` posts the hub card («🎮 Во что играем?») that
 *     opens the Mini App for THIS group; every game has ONE card of its own —
 *     posted once, then only ever edited (edits do not ring anybody's phone) —
 *     with the button that opens it; and the results at the end. A group may
 *     have several games going at once, each with its own card.
 *   - in private: "👉 your turn", only for somebody whose app is closed,
 *     and deleted again once the turn has passed.
 *
 * It also owns what has to run without anybody pressing anything: every
 * game's timers (the modules say what should run, this arms it).
 *
 * THE TWO RULES still hold, and are enforced where the moves now come in:
 * nobody acts for somebody else (identity = verified initData, hub.js), and
 * nobody sees somebody else's cards (each viewer gets their own state, from
 * the game module's view). The only moves the bot ever makes in somebody's
 * place are a turn timer's — switched on by the host.
 */
import crypto from 'node:crypto';
import { identify } from './identity.js';
import { Outbox } from './outbox.js';
import { NullStore } from './store.js';
import { esc } from './fmt.js';
import { GAMES, GAME_LIST, gameOf } from './games/index.js';

const HELP = [
  '🎮 <b>Игры в Telegram</b> — покер и дурак в мини-приложении.',
  '',
  '<b>/game</b> — во что играем. Бот пришлёт карточку с кнопкой — в приложении выберите',
  '«Покер» или «Дурак» и создайте лобби; друзья присоединятся по его карточке.',
  '',
  '/table — показать карточки игр внизу чата',
  '/finish — завершить свою игру и показать итоги (хост)',
  '/cancel — удалить свою игру (хост)',
  '',
  'Чтобы бот мог напомнить, что ваш ход, — один раз нажмите Start у него в личке.',
].join('\n');

const HELP_DM = [
  '🎮 <b>Покер и дурак в Telegram</b>',
  '',
  'Сюда приходят напоминания «ваш ход» — только когда приложение у вас закрыто.',
  'Сама игра — в группе: напишите там /game и выберите игру.',
  'Или /game здесь — откроются игры ваших групп.',
].join('\n');

const WELCOME_DM = '✅ Готово: если приложение будет закрыто, когда до вас дойдёт ход, — напомню здесь.';

/** Games a group may have going at once. Past this the hub asks to finish one. */
export const MAX_LIVE_PER_GROUP = 10;
/** A finished game stays (its results on open phones) this long after it ended. */
export const FINISHED_KEEP_MS = 30 * 60_000;
/** …and is dropped at start-up after this long, new game or not. */
export const FINISHED_MAX_MS = 24 * 60 * 60_000;

/** The real clock. Tests pass a fake one and move time by hand. */
const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

/** A group's public handle — `startapp=g_<code>`. Random, unrelated to the chat id. */
export function newGroupCode() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => abc[b % abc.length]).join('');
}

export const HUB_PREFIX = 'g_';

export class App {
  /**
   * @param deck           test seam: `(room) => number[52]` — a stacked poker deck
   * @param durakDeck      test seam: `(room) => string[36]` — a stacked durak deck
   * @param clock          `{ now, setTimeout, clearTimeout }` for the timers
   * @param runoutStepMs   pause between streets when an all-in board is shown
   * @param webappUrl      public HTTPS address of the Mini App
   * @param miniAppName    the short name registered with @BotFather (/newapp):
   *                       then the group button opens the app directly
   */
  constructor({
    api, store = new NullStore(), minIntervalMs = 1000, botUsername = '', onError = null, deck = null, durakDeck = null,
    clock = REAL_CLOCK, runoutStepMs = 1500, webappUrl = '', miniAppName = '',
  } = {}) {
    this.api = api;
    this.store = store;
    this.botUsername = botUsername;
    this.deck = deck;
    this.durakDeck = durakDeck;
    this.clock = clock;
    this.runoutStepMs = runoutStepMs;
    this.webappUrl = String(webappUrl || '').replace(/\/+$/, '');
    this.miniAppName = miniAppName;
    this.hub = null; // set by attachHub()
    this.log = onError || ((err) => console.error('[bot]', err?.description || err?.message || err));
    this.outbox = new Outbox(api, { minIntervalMs, onError: this.log, timers: clock });
    /** @type {Map<string, object>} room code -> room (a group may have several) */
    this.rooms = new Map();
    /** @type {Map<string, object>} chatId -> group { chatId, code, title, ui } */
    this.groups = new Map();
    /** `${kind}:${code}` -> { key, deadline, h } — every timer the bot holds */
    this.handles = new Map();
    /** private-chat work in flight (turn pings) — awaited by settle() */
    this.inflight = new Set();
  }

  attachHub(hub) {
    this.hub = hub;
    return this;
  }

  /** Every game of a chat, oldest first. */
  roomsOf(chatId) {
    const id = String(chatId);
    return [...this.rooms.values()].filter((r) => r.chatId === id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  /** The newest game of a chat — what "the table in this group" means for one game. */
  room(chatId) {
    return this.roomsOf(chatId).at(-1) || null;
  }

  roomByCode(code) {
    if (!code) return null;
    return this.rooms.get(String(code)) || null;
  }

  /** Put a room under its code (tools and tests build rooms by hand). */
  addRoom(room) {
    room.game = room.game || 'poker';
    this.rooms.set(room.code, room);
    return room;
  }

  groupByCode(code) {
    if (!code) return null;
    for (const g of this.groups.values()) if (g.code === code) return g;
    return null;
  }

  /** The group's hub record — created the first time somebody asks for it. */
  ensureGroup(chatId, title = '', { save = true } = {}) {
    const id = String(chatId);
    let g = this.groups.get(id);
    if (!g) {
      g = { chatId: id, code: newGroupCode(), title: '', ui: { hubMessageId: null } };
      this.groups.set(id, g);
    }
    if (title) g.title = String(title).slice(0, 64);
    if (save) this.saveGroup(g);
    return g;
  }

  saveGroup(g) {
    try {
      this.store.saveGroup(g);
    } catch (err) {
      this.log(err);
    }
  }

  /* ---------------------------------------------------------- persistence */

  load() {
    const now = this.clock.now();
    for (const g of this.store.loadGroups()) {
      this.groups.set(String(g.chatId), { ...g, ui: g.ui || { hubMessageId: null } });
    }
    for (const { chatId, code, game, data } of this.store.loadAll()) {
      try {
        const room = (GAMES[game] || gameOf(data)).deserialize(data);
        room.chatId = String(chatId); // the column wins: it is what a migration re-keys
        room.code = room.code || code;
        room.ui = room.ui || {};
        // Saved before a game could wait for several people at once.
        if (room.ui.ping) {
          const { key, userId, messageId } = room.ui.ping;
          room.ui.pings = messageId ? { [String(userId)]: { key, tgId: userId, messageId } } : {};
          delete room.ui.ping;
        }
        // A finished game an evening ago is nobody's any more.
        if (room.status === 'finished' && now - (room.finishedAt || 0) > FINISHED_MAX_MS) {
          this.store.remove(room.code);
          continue;
        }
        this.rooms.set(room.code, room);
      } catch (err) {
        this.log(err);
      }
    }
    return this.rooms.size;
  }

  save(room) {
    try {
      this.store.save(room, gameOf(room).serialize(room, this.clock.now()));
    } catch (err) {
      this.log(err);
    }
  }

  /** After a restart: redraw every live card; open apps reconnect by themselves. */
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

  /* ---------------------------------------------------------- the links */

  /**
   * The group button. A `web_app` button is not allowed in groups, so this is
   * a plain link: with a Mini App registered at @BotFather it opens the app
   * directly (`startapp` arrives signed, inside initData). Without one, it
   * opens the bot's private chat, and the bot answers with a `web_app` button.
   */
  tableLink(room) {
    if (!this.botUsername) return null;
    if (this.miniAppName) return `https://t.me/${this.botUsername}/${this.miniAppName}?startapp=${room.code}`;
    return `https://t.me/${this.botUsername}?start=t_${room.code}`;
  }

  /** The hub of a group: `g_<code>` tells it apart from a room code (which has no `_`). */
  hubLink(group) {
    if (!this.botUsername) return null;
    if (this.miniAppName) return `https://t.me/${this.botUsername}/${this.miniAppName}?startapp=${HUB_PREFIX}${group.code}`;
    return `https://t.me/${this.botUsername}?start=${HUB_PREFIX}${group.code}`;
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
   * second (Telegram does), and whoever the game waits for with their app
   * closed gets a nudge.
   */
  draw(room, { immediate = false } = {}) {
    this.syncClocks(); // the view carries the turn deadline: set it first
    this.hub?.broadcast(room);
    this.track(this.pingTurns(room));
    const produce = async () => {
      const view = gameOf(room).card(room, { link: this.tableLink(room) });
      const kbKey = JSON.stringify(view.keyboard?.length ? { inline_keyboard: view.keyboard } : null);
      const unchanged = room.ui.lastText === view.text && room.ui.lastKb === kbKey;
      const buried = !!room.ui.tableMessageId && (room.ui.lastMsgId || 0) - room.ui.tableMessageId >= 2;
      await this.outbox.draw(room, view, { move: buried && !unchanged });
      this.seen(room, room.ui.tableMessageId);
      this.save(room);
    };
    if (immediate) return produce();
    this.outbox.schedule(room.chatId, produce, room.code);
    return Promise.resolve();
  }

  track(promise) {
    if (!promise) return;
    const p = Promise.resolve(promise).catch((err) => this.log(err)).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  /**
   * Remember the newest message id in a chat — the measure of "buried". A
   * card's own id counts for its own room only: two games' cards must not
   * keep pushing each other to the bottom of the chat.
   */
  seen(room, messageId) {
    if (room && Number.isFinite(messageId)) room.ui.lastMsgId = Math.max(room.ui.lastMsgId || 0, messageId);
  }

  seenInChat(chatId, messageId) {
    for (const room of this.roomsOf(chatId)) this.seen(room, messageId);
  }

  /** Post the card again at the bottom of the chat; the old copy loses its button. */
  async newCard(room) {
    this.outbox.cancel(room.chatId, room.code);
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
   * Whoever the game is waiting for, if they do not have the app open, gets a
   * private "👉 your turn" with a button that opens it. A ping for a turn that
   * has passed is deleted, so a private chat never fills up with stale calls
   * to act. Poker waits for one player at a time; durak may wait for several
   * (the defender, the players who may still throw in).
   */
  async pingTurns(room) {
    const g = gameOf(room);
    const wanted = () => (room.status === 'playing' ? g.waiting(room) : []);
    const isWanted = (w) => wanted().some((x) => x.id === w.id && x.key === w.key);
    const pings = (room.ui.pings ||= {});
    const want = wanted();
    for (const [uid, last] of Object.entries(pings)) {
      if (want.some((w) => w.id === uid && w.key === last.key)) continue;
      if (pings[uid] === last) delete pings[uid];
      if (last.messageId) await this.outbox.removePrivate(last.tgId, last.messageId);
    }
    for (const w of want) {
      if (room.ui.pings?.[w.id]?.key === w.key) continue;
      if (!isWanted(w)) continue; // the game moved on while we were busy
      const entry = { key: w.key, tgId: null, messageId: null };
      (room.ui.pings ||= {})[w.id] = entry;
      const p = room.players.find((x) => x.id === w.id);
      if (!p || p.dm !== 'ok') continue; // never pressed Start: nobody to write to
      if (this.hub?.isPresent(room.code, p.id)) continue; // looking at the table already
      const link = this.tableLink(room);
      const btn = this.webAppButton(room) || (link ? { text: '🃏 Открыть стол', url: link } : null);
      const r = await this.outbox.dm(p.tgId, g.pingText(room, p, w), btn ? [[btn]] : null);
      if (r.forbidden) this.setDm(p.id, 'fail', { redraw: false });
      if (!r.ok) continue;
      // Only remember it if the turn is still the same one we pinged about.
      if (room.ui.pings?.[w.id] === entry && isWanted(w)) Object.assign(entry, { tgId: p.tgId, messageId: r.message_id });
      else await this.outbox.removePrivate(p.tgId, r.message_id);
    }
  }

  /* ------------------------------------------------------------ the deal */

  /** `{ deck }` for the room layer: stacked in tests, shuffled otherwise. */
  dealOpts(room) {
    if (room.game === 'durak') return this.durakDeck ? { deck: () => this.durakDeck(room) } : {};
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
      const p = room.players.find((x) => x.id === id);
      if (!p || p.dm === status) continue;
      p.dm = status;
      if (redraw && room.status !== 'finished') this.draw(room);
    }
  }

  person(user) {
    return { id: user.id, tgId: user.tgId, name: user.name, dm: this.store.getDm(user.id) };
  }

  /**
   * A new game in a group — from /newgame or from the hub. Finished games of
   * this chat that nobody has looked at for a while are cleared out first.
   */
  createGame(gameId, { chatId, title = '', host, settings = null }) {
    const g = GAMES[gameId];
    if (!g) return { error: 'BAD_GAME' };
    this.purgeFinished(chatId);
    const room = g.create({ chatId: String(chatId), title, host: this.person(host), settings });
    if (room.error) return room;
    room.game = g.id;
    room.createdAt = Math.max(room.createdAt || 0, ...this.roomsOf(chatId).map((r) => (r.createdAt || 0) + 1));
    this.rooms.set(room.code, room);
    return room;
  }

  /** Drop a game for good: its card loses the button, open apps are told. */
  async dropGame(room) {
    if (room.ui.tableMessageId) await this.outbox.dropKeyboard(room.chatId, room.ui.tableMessageId);
    this.outbox.cancel(room.chatId, room.code);
    this.hub?.forget(room.code);
    this.rooms.delete(room.code);
    this.store.remove(room.code);
    this.syncClocks();
    this.hub?.broadcastGroup(room.chatId);
  }

  purgeFinished(chatId) {
    const now = this.clock.now();
    for (const room of this.roomsOf(chatId)) {
      if (room.status !== 'finished' || now - (room.finishedAt || 0) < FINISHED_KEEP_MS) continue;
      this.hub?.forget(room.code);
      this.rooms.delete(room.code);
      this.store.remove(room.code);
    }
  }

  /** Games of a chat that are not over yet. */
  liveRooms(chatId) {
    return this.roomsOf(chatId).filter((r) => r.status !== 'finished');
  }

  /** Chips or cards moved: show it — or, if that ended the game, the results. */
  async afterAction(room) {
    // Something the game shows on its own clock (the poker all-in board): it
    // posts the results itself at the end if this was the last hand.
    if (gameOf(room).beginShow?.(this, room)) return this.draw(room);
    if (room.status === 'finished') return this.finishUp(room);
    await this.draw(room);
  }

  /** A hand was dealt (or the game ended instead). */
  async afterDeal(room, r) {
    if (r?.finished) return this.finishUp(room);
    // Blinds alone can put everybody all-in: then the board is turned over at
    // once, and that may even end the game on the spot.
    const revealing = gameOf(room).beginShow?.(this, room);
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
   * Every game's timers, for every room. Idempotent: the game module works out
   * what should be running, this only makes the real timers match — arming
   * new ones, dropping ones nobody needs.
   */
  syncClocks() {
    const now = this.clock.now();
    const live = new Set();
    for (const room of this.rooms.values()) {
      for (const c of gameOf(room).clocks?.(this, room, now) || []) {
        const id = `${c.id}:${room.code}`;
        live.add(id);
        if (!c.keep) this.arm(id, c.timer, c.fire);
      }
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

  /** A one-off step on a game's own clock (the poker board, street by street). */
  after(id, key, ms, fn) {
    const cur = this.handles.get(id);
    if (cur) this.clock.clearTimeout(cur.h);
    const h = this.clock.setTimeout(() => {
      this.handles.delete(id);
      return this.guard(fn);
    }, ms);
    this.handles.set(id, { key, deadline: null, h });
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

  /* ------------------------------------------------------------- messages */

  async onMessage(msg) {
    if (msg.chat?.type === 'private') return this.onPrivate(msg);

    const chatId = String(msg.chat.id);

    // A group promoted to a supergroup changes chat.id. Re-key its games or
    // they are silently lost the moment somebody upgrades the group.
    if (msg.migrate_to_chat_id) return this.migrate(chatId, String(msg.migrate_to_chat_id));

    if (msg.left_chat_member) return this.onLeft(chatId, msg.left_chat_member);
    if (msg.new_chat_members?.length) return this.onJoined(chatId, msg.new_chat_members);
    if (typeof msg.text !== 'string') return;

    this.seenInChat(chatId, msg.message_id);
    const cmd = parseCommand(msg.text, this.botUsername);
    if (!cmd) return;
    return this.onCommand(cmd, msg);
  }

  /**
   * The private chat. Start here is what lets the bot send "your turn".
   * `/start t_<code>` (a table) and `/start g_<code>` (a group's hub) come
   * from the group buttons when no Mini App is registered at @BotFather: the
   * answer is a `web_app` button, which Telegram allows in private chats only.
   * Nothing here seats anybody anywhere — a deep-link payload is text the
   * user controls.
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
        const g = gameOf(room);
        const text = btn
          ? `${g.icon} ${g.id === 'poker' ? 'Стол' : g.title}${room.title ? ` «${esc(room.title)}»` : ''} — открывайте:`
          : 'Стол есть, но адрес мини-приложения не настроен (WEBAPP_URL). Скажите тому, кто запускает бота.';
        return void (await this.outbox.post(user.tgId, text, btn ? [[btn]] : null));
      }
      if (!cmd.rest) return this.sendMyGames(user, `${WELCOME_DM}\n\n${HELP_DM}`);
      const gm = /^g_([a-z0-9]{4,32})$/.exec(cmd.rest);
      const group = gm ? this.groupByCode(gm[1]) : null;
      if (group) {
        const btn = this.webappUrl ? { text: '🎮 Выбрать игру', web_app: { url: `${this.webappUrl}/?room=${HUB_PREFIX}${group.code}` } } : null;
        const text = btn
          ? `🎮 Игры группы${group.title ? ` «${esc(group.title)}»` : ''} — открывайте:`
          : 'Адрес мини-приложения не настроен (WEBAPP_URL). Скажите тому, кто запускает бота.';
        return void (await this.outbox.post(user.tgId, text, btn ? [[btn]] : null));
      }
      return void (await this.outbox.post(user.tgId, WELCOME_DM));
    }
    if (['game', 'play', 'games', 'newgame'].includes(cmd?.cmd)) return this.sendMyGames(user);
    return void (await this.outbox.post(user.tgId, HELP_DM));
  }

  /**
   * In private the bot does not know which group you mean — the Mini App
   * does not either. So the button opens the app without a group, and the
   * app shows the groups you play in (see hub.js, `groupsOf`).
   */
  async sendMyGames(user, lead = null) {
    const mine = this.groupsOf(user.id);
    const btn = this.webappUrl && mine.length ? { text: '🎮 Открыть игры', web_app: { url: `${this.webappUrl}/` } } : null;
    const text = mine.length
      ? `${lead ? `${lead}\n\n` : ''}🎮 Игры ваших групп — открывайте:`
      : `${lead ? `${lead}\n\n` : ''}Игры создаются в группе: добавьте меня в группу и напишите там /game.`;
    await this.outbox.post(user.tgId, text, btn ? [[btn]] : null);
  }

  /**
   * The groups this person plays in: they wrote a command there, or they sit
   * at one of its games. The only groups a page opened without a group may
   * show — the bot never lists a group to somebody it has not seen in it.
   */
  groupsOf(userId) {
    const id = String(userId);
    const out = new Map();
    for (const g of this.groups.values()) if (g.members?.includes(id)) out.set(g.chatId, g);
    for (const room of this.rooms.values()) {
      if (out.has(room.chatId) || room.status === 'finished') continue;
      if (room.players.some((p) => p.id === id && !p.kicked && !p.left)) out.set(room.chatId, this.ensureGroup(room.chatId, room.title));
    }
    return [...out.values()];
  }

  /** Somebody used a command in this group: they are one of its players. */
  noteMember(chatId, userId, title = '') {
    const g = this.ensureGroup(chatId, title, { save: false });
    const id = String(userId);
    g.members = g.members || [];
    if (!g.members.includes(id)) {
      g.members.push(id);
      if (g.members.length > 200) g.members.shift();
    }
    this.saveGroup(g);
    return g;
  }

  async onCommand(cmd, msg) {
    const chatId = String(msg.chat.id);
    const who = identify(msg.from, msg.sender_chat);

    if (cmd.cmd === 'start' || cmd.cmd === 'help') return void (await this.reply(chatId, HELP));
    if (!who.ok) return void (await this.reply(chatId, who.text, msg));

    const user = who.user;
    this.noteMember(chatId, user.id, msg.chat.title);

    switch (cmd.cmd) {
      case 'game':
      case 'play':
      case 'games': {
        const group = this.ensureGroup(chatId, msg.chat.title);
        await this.postHub(group);
        return;
      }

      case 'newgame':
      case 'poker': {
        const table = this.liveRooms(chatId).filter((r) => r.game === 'poker').at(-1);
        if (table) {
          return void (await this.reply(
            chatId,
            `Стол уже есть, хост — ${esc(nameOf(table, table.hostId))}. /table — показать его. ` +
              'Новый — после /finish или /cancel. Ещё одна игра — /game.',
            msg
          ));
        }
        // As it always did, a new table replaces a poker table that is over.
        for (const old of this.roomsOf(chatId)) {
          if (old.game !== 'poker' || old.status !== 'finished') continue;
          this.hub?.forget(old.code);
          this.rooms.delete(old.code);
          this.store.remove(old.code);
        }
        const fresh = this.createGame('poker', { chatId, title: msg.chat.title, host: user });
        await this.newCard(fresh);
        this.hub?.broadcastGroup(chatId);
        return;
      }

      case 'table': {
        const live = this.liveRooms(chatId);
        if (!live.length) {
          const last = this.room(chatId);
          if (!last) return void (await this.reply(chatId, 'Игр нет. /game — выбрать игру.', msg));
          await this.newCard(last);
          return;
        }
        for (const room of live) await this.newCard(room);
        return;
      }

      case 'finish': {
        const room = this.hostTarget(chatId, user.id, { finished: true });
        if (!room) {
          const any = this.liveRooms(chatId).at(-1) || this.room(chatId);
          return void (await this.reply(chatId, any ? this.hostOnly(any) : 'Стола нет.', msg));
        }
        const r = gameOf(room).endGame(room, user.id);
        if (r.error) return void (await this.reply(chatId, this.hostOnly(room), msg));
        await this.finishUp(room);
        return;
      }

      case 'cancel': {
        const room = this.hostTarget(chatId, user.id, { finished: true });
        if (!room) {
          const any = this.liveRooms(chatId).at(-1) || this.room(chatId);
          if (any) await this.reply(chatId, this.hostOnly(any), msg);
          return;
        }
        await this.dropGame(room);
        await this.reply(chatId, room.game === 'poker' ? 'Стол удалён. /newgame — создать новый.' : `${gameOf(room).icon} ${gameOf(room).title}: игра удалена. /game — новая игра.`);
        return;
      }

      default:
        return;
    }
  }

  /** The game a host's command is about: the newest one they run in this chat. */
  hostTarget(chatId, userId, { finished = false } = {}) {
    const mine = (list) => list.filter((r) => r.hostId === String(userId)).at(-1) || null;
    return mine(this.liveRooms(chatId)) || (finished ? mine(this.roomsOf(chatId)) : null);
  }

  /** «🎮 Во что играем?» — the card that opens the Mini App for this group. */
  async postHub(group) {
    const old = group.ui?.hubMessageId;
    if (old) await this.outbox.dropKeyboard(group.chatId, old);
    const link = this.hubLink(group);
    const lines = ['🎮 <b>Во что играем?</b>', ''];
    for (const g of GAME_LIST) lines.push(`${g.icon} <b>${g.title}</b> — ${esc(g.blurb)}, ${g.minPlayers}–${g.maxPlayers} игроков`);
    lines.push('', '<i>Откройте приложение, выберите игру и создайте лобби — друзья присоединятся по его карточке.</i>');
    try {
      const m = await this.outbox.post(group.chatId, lines.join('\n'), link ? [[{ text: '🎮 Выбрать игру', url: link }]] : null);
      group.ui = { ...(group.ui || {}), hubMessageId: m?.message_id ?? null };
      this.seenInChat(group.chatId, m?.message_id);
    } catch (err) {
      this.log(err);
    }
    this.saveGroup(group);
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
    for (const room of this.liveRooms(chatId)) {
      const r = gameOf(room).markLeft(room, member.id);
      if (r.error) continue;
      await this.afterAction(room);
    }
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
      for (const room of this.roomsOf(chatId)) {
        this.hub?.forget(room.code);
        this.rooms.delete(room.code);
      }
      const group = this.groups.get(chatId);
      if (group) this.hub?.forgetGroup(group.code);
      this.groups.delete(chatId);
      this.store.removeChat(chatId);
      this.syncClocks();
    }
  }

  async migrate(oldId, newId) {
    const rooms = this.roomsOf(oldId);
    for (const room of rooms) {
      room.chatId = newId;
      // Message ids do not survive the migration either. The room code does,
      // so every open table keeps working without anybody noticing.
      room.ui.tableMessageId = null;
      room.ui.lastText = null;
      room.ui.lastKb = null;
      room.ui.lastMsgId = 0;
      gameOf(room).onMigrate?.(room);
    }
    const group = this.groups.get(oldId);
    if (group) {
      this.groups.delete(oldId);
      group.chatId = newId;
      group.ui = { hubMessageId: null };
      this.groups.set(newId, group);
    }
    this.store.migrate(oldId, newId);
    if (group) this.saveGroup(group);
    for (const room of rooms) this.save(room);
    for (const room of rooms) if (room.status !== 'finished') await this.newCard(room);
  }

  /* --------------------------------------------------------------- finish */

  async finishUp(room) {
    // The card says the game is over; the results go below it as their own
    // message — the one message of the evening worth a notification.
    const g = gameOf(room);
    this.outbox.cancel(room.chatId, room.code);
    g.onFinish?.(room);
    this.hub?.broadcast(room);
    this.track(this.pingTurns(room)); // drops any "your turn" still hanging around
    if (room.ui.tableMessageId) {
      try {
        await this.outbox.draw(room, g.card(room, { link: this.tableLink(room) }));
      } catch (err) {
        this.log(err);
      }
    }
    await this.outbox.post(room.chatId, g.results(room));
    this.save(room);
  }

  /* ---------------------------------------------------------------- utils */

  /** A message in the group; as a reply when it answers somebody's command. */
  async reply(chatId, text, toMsg = null) {
    try {
      const m = await this.outbox.post(chatId, text, null, toMsg ? { reply_parameters: replyTo(toMsg) } : {});
      this.seenInChat(chatId, m?.message_id);
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
