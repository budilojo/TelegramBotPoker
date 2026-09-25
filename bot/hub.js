'use strict';
/**
 * The Mini App's side of the bot: who is looking at what, what they are
 * allowed to do, and what each of them gets to see.
 *
 * A page looks at one of two things:
 *   - a GROUP'S HUB (`startapp=g_<code>`): pick a game, see the lobbies open
 *     in that group, create one or join one;
 *   - a ROOM (`startapp=<code>`): one poker table or one durak game — the
 *     rules and the view come from that game's module (games/).
 *
 * Transport-agnostic on purpose — a session is anything with `send(obj)`.
 * `server.js` plugs WebSockets into it; the tests plug in plain functions,
 * so the whole protocol is tested without a socket.
 *
 * THE RULE, again: a session's identity comes from `initData` verified with
 * the bot token, and from nowhere else. Nothing in a message from the page —
 * a seat number, a user id, a name — can make it act as somebody else. And
 * what a session may look at comes from the signature too: the signed
 * `start_param` picks the room or the group, and from a group's hub a page
 * may only step into rooms of THAT group.
 */
import { checkInitData } from './webapp-auth.js';
import { GAMES, GAME_LIST, gameOf } from './games/index.js';
import { HUB_PREFIX, MAX_LIVE_PER_GROUP } from './app.js';

const CORE_ERRORS = {
  BAD_REQUEST: 'Не понял запрос.',
  NO_ROOM: 'Эта игра уже закончилась или она не из этой группы.',
  BAD_GAME: 'Такой игры нет.',
  TOO_MANY_GAMES: `В группе уже ${MAX_LIVE_PER_GROUP} незаконченных игр — завершите какую-нибудь.`,
  NOT_FROM_HUB: 'Список игр группы открывается кнопкой «Выбрать игру» из /play.',
};

/** Error codes in words a person can act on — the core's and every game's. */
export const ERRORS = Object.assign({}, ...Object.values(GAMES).map((g) => g.errors || {}), CORE_ERRORS);

/** What a page may say whatever it is looking at. */
const COMMON = new Set(['visible']);
/** What a page may say on a group's hub. */
const HUB_ACTIONS = new Set(['create', 'join']);

export class Hub {
  /**
   * @param app       the bot's App: rooms, groups, clocks, and the after-*
   *                  hooks that keep the group card and the timers in step
   * @param botToken  to verify initData
   */
  constructor(app, { botToken, maxAgeSec } = {}) {
    this.app = app;
    this.botToken = botToken;
    this.maxAgeSec = maxAgeSec;
    /** room code -> Set<session> */
    this.byRoom = new Map();
    /** group code -> Set<session> — pages on a group's hub */
    this.byGroup = new Map();
    this.nextId = 1;
  }

  /* -------------------------------------------------------------- sessions */

  /**
   * A page says hello with its initData and what it wants to look at.
   * @returns {{session}|{error, text}}
   */
  open({ initData, room: wanted } = {}, send) {
    const auth = checkInitData(initData, this.botToken, { now: this.app.clock.now(), maxAgeSec: this.maxAgeSec });
    if (!auth.ok) {
      return { error: 'AUTH', text: auth.reason === 'EXPIRED' ? 'Сессия устарела — откройте стол заново.' : 'Откройте стол из Telegram.' };
    }
    const asked = String(wanted || '').trim();
    // The signed start_param wins over anything in the page's own URL.
    const code = String(auth.startParam || asked || '').trim();
    // Opened without a room: from @BotFather's link or the bot's profile.
    if (!code) {
      return { error: 'NO_ROOM', text: 'Игры открываются из группы: напишите там /play (или /newgame для покера) и нажмите кнопку.' };
    }

    if (code.startsWith(HUB_PREFIX)) {
      const group = this.app.groupByCode(code.slice(HUB_PREFIX.length));
      if (!group) return { error: 'NO_ROOM', text: 'Игры группы не найдены — напишите /play в группе ещё раз.' };
      const session = { id: this.nextId++, user: auth.user, kind: 'hub', group: group.code, code: null, send, visible: true };
      // Back to the room it was in before a reconnect — if it is of this group.
      const inside = this.app.roomByCode(asked);
      if (inside && inside.chatId === group.chatId) this.enterRoom(session, inside);
      else this.enterHub(session);
      return { session };
    }

    const room = this.app.roomByCode(code);
    if (!room) return { error: 'NO_ROOM', text: 'Стол не найден — возможно, игру уже удалили.' };
    const session = { id: this.nextId++, user: auth.user, kind: 'room', group: null, code: null, send, visible: true };
    this.enterRoom(session, room);
    return { session };
  }

  close(session) {
    this.detach(session);
  }

  detach(session) {
    const map = session.kind === 'hub' ? this.byGroup : this.byRoom;
    const key = session.kind === 'hub' ? session.group : session.code;
    const set = map.get(key);
    if (!set) return;
    set.delete(session);
    if (!set.size) map.delete(key);
  }

  enterRoom(session, room) {
    this.detach(session);
    session.kind = 'room';
    session.code = room.code;
    if (!this.byRoom.has(room.code)) this.byRoom.set(room.code, new Set());
    this.byRoom.get(room.code).add(session);
    this.push(session, room);
  }

  enterHub(session) {
    this.detach(session);
    session.kind = 'hub';
    session.code = null;
    session.lastHub = null;
    if (!this.byGroup.has(session.group)) this.byGroup.set(session.group, new Set());
    this.byGroup.get(session.group).add(session);
    this.pushHub(session);
  }

  /** Is this person looking at this table right now? (Then no "your turn" ping.) */
  isPresent(code, userId) {
    for (const s of this.byRoom.get(code) || []) if (s.user.id === String(userId) && s.visible) return true;
    return false;
  }

  /** Pages open anywhere — for /health. */
  get sessions() {
    let n = 0;
    for (const set of this.byRoom.values()) n += set.size;
    for (const set of this.byGroup.values()) n += set.size;
    return n;
  }

  /* ------------------------------------------------------------ broadcasting */

  push(session, room) {
    try {
      const state = gameOf(room).view(room, session.user.id, { now: this.app.clock.now(), botUsername: this.app.botUsername });
      if (session.group) state.hub = true; // it came from the group's hub: offer the way back
      session.send({ t: 'state', state });
    } catch (err) {
      this.app.log(err);
    }
  }

  /** The hub of a group, for one person. Skipped when nothing on it changed. */
  pushHub(session) {
    const group = this.app.groupByCode(session.group);
    if (!group) return;
    try {
      const view = hubView(this.app, group, session.user);
      const json = JSON.stringify(view);
      if (json === session.lastHub) return;
      session.lastHub = json;
      session.send({ t: 'state', state: { ...view, now: this.app.clock.now() } });
    } catch (err) {
      this.app.log(err);
    }
  }

  /** Everyone at this table gets THEIR OWN view of it — and the group's hubs a fresh list. */
  broadcast(room) {
    for (const s of this.byRoom.get(room.code) || []) this.push(s, room);
    this.broadcastGroup(room.chatId);
  }

  broadcastGroup(chatId) {
    const group = this.app.groups.get(String(chatId));
    if (!group) return;
    for (const s of this.byGroup.get(group.code) || []) this.pushHub(s);
  }

  /** A room was deleted. Pages that came from the hub go back to it. */
  forget(code) {
    for (const s of [...(this.byRoom.get(code) || [])]) {
      try {
        s.send({ t: 'gone', text: 'Игру удалили.' });
      } catch {
        /* closed already */
      }
      if (s.group && this.app.groupByCode(s.group)) this.enterHub(s);
    }
    this.byRoom.delete(code);
  }

  /** The bot left the group: its hub is gone too. */
  forgetGroup(groupCode) {
    for (const s of this.byGroup.get(groupCode) || []) {
      try {
        s.send({ t: 'gone', text: 'Бота удалили из группы.' });
      } catch {
        /* closed already */
      }
    }
    this.byGroup.delete(groupCode);
  }

  /* ---------------------------------------------------------------- actions */

  refuse(session, code, text = null) {
    session.send({ t: 'error', code, text: text || ERRORS[code] || `Не получилось: ${code}` });
  }

  /**
   * One message from one page. Returns when the room and everything that
   * follows from the move (group card, timers, reveal) has been taken care of.
   */
  async handle(session, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.refuse(session, 'BAD_REQUEST');
    if (session.kind === 'hub') return this.handleHub(session, msg);

    const app = this.app;
    const room = app.roomByCode(session.code);
    if (!room) return session.send({ t: 'gone', text: 'Игру удалили.' });

    if (COMMON.has(msg.t)) {
      session.visible = !!msg.visible;
      return;
    }
    if (msg.t === 'hub') {
      if (!session.group || !app.groupByCode(session.group)) return this.refuse(session, 'NOT_FROM_HUB');
      return this.enterHub(session);
    }

    const game = gameOf(room);
    return game.handle({
      app,
      hub: this,
      session,
      room,
      uid: session.user.id, // the ONLY identity there is
      msg,
      refuse: (code, text) => this.refuse(session, code, text),
      push: () => this.push(session, room),
    });
  }

  /** The group's hub: create a lobby, or step into one. */
  async handleHub(session, msg) {
    const app = this.app;
    const group = app.groupByCode(session.group);
    if (!group) return session.send({ t: 'gone', text: 'Бота удалили из группы.' });
    if (COMMON.has(msg.t)) {
      session.visible = !!msg.visible;
      return;
    }
    if (!HUB_ACTIONS.has(msg.t)) return this.refuse(session, 'BAD_REQUEST');

    if (msg.t === 'join') {
      const room = app.roomByCode(String(msg.code || ''));
      // Only a room of the group this page was opened for — never another's.
      if (!room || room.chatId !== group.chatId) return this.refuse(session, 'NO_ROOM');
      return this.enterRoom(session, room);
    }

    // create
    const game = GAMES[String(msg.game || '')];
    if (!game) return this.refuse(session, 'BAD_GAME');
    const uid = session.user.id;
    // A double tap must not put two cards in the group: one open lobby per host.
    const mine = app.liveRooms(group.chatId).find((r) => r.status === 'lobby' && r.hostId === uid && r.game === game.id);
    if (mine) {
      session.send({ t: 'notice', text: 'У вас уже есть открытое лобби — вот оно.' });
      return this.enterRoom(session, mine);
    }
    if (app.liveRooms(group.chatId).length >= MAX_LIVE_PER_GROUP) return this.refuse(session, 'TOO_MANY_GAMES');
    const settings = msg.settings && typeof msg.settings === 'object' ? msg.settings : null;
    const room = app.createGame(game.id, { chatId: group.chatId, title: group.title, host: session.user, settings });
    if (room.error) return this.refuse(session, room.error);
    this.enterRoom(session, room);
    await app.newCard(room);
    this.broadcastGroup(group.chatId);
  }
}

/**
 * What a group's hub shows one person: the games on offer and the games
 * already open in this group. No cards, no stacks — the same things the
 * group cards say to everybody.
 */
export function hubView(app, group, user) {
  const uid = String(user.id);
  const lobbies = app.liveRooms(group.chatId).reverse().map((room) => {
    const g = gameOf(room);
    const s = g.summary(room);
    const host = room.players.find((p) => p.id === room.hostId);
    return {
      code: room.code,
      game: g.id,
      icon: g.icon,
      title: g.title,
      status: room.status,
      seated: s.seated,
      max: s.max,
      names: s.names.slice(0, 8),
      detail: s.detail || '',
      host: host?.name ?? null,
      mine: room.hostId === uid,
      inside: room.players.some((p) => p.id === uid && !p.left && !p.kicked),
    };
  });
  return {
    kind: 'hub',
    bot: app.botUsername,
    group: { title: group.title || '' },
    me: { name: user.name },
    games: GAME_LIST.map((g) => ({ id: g.id, title: g.title, icon: g.icon, blurb: g.blurb, min: g.minPlayers, max: g.maxPlayers })),
    lobbies,
  };
}
