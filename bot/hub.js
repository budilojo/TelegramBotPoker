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
import { HUB_PREFIX, MAX_LIVE_PER_GROUP, RATING_SOON_TEXT, TOO_MANY_GAMES_TEXT } from './app.js';
import { AUDIENCES, ERRORS as CAST_ERRORS } from './broadcast.js';
import { GAME_RU, PER_DAY, sign } from './rating.js';
import { ym } from './fmt.js';

const CORE_ERRORS = {
  BAD_REQUEST: 'Не понял запрос.',
  NO_CASTS: 'Рассылка не настроена на этом сервере.',
  NO_ROOM: 'Эта игра уже закончилась или она не из этой группы.',
  BAD_GAME: 'Такой игры нет.',
  TOO_MANY_GAMES: TOO_MANY_GAMES_TEXT,
  NOT_FROM_HUB: 'Список игр группы открывается кнопкой «Выбрать игру» из /game.',
  NOT_YOUR_GROUP: 'Этой группы нет среди ваших — напишите в ней /game.',
  DOWN: 'Идёт обслуживание — игра пока стоит.',
  RATING_SOON: RATING_SOON_TEXT,
};

/** Error codes in words a person can act on — the core's and every game's. */
export const ERRORS = Object.assign({}, ...Object.values(GAMES).map((g) => g.errors || {}), CORE_ERRORS);

/** What a page may say whatever it is looking at. */
const COMMON = new Set(['visible']);
/** What a page may say on a group's hub. */
const HUB_ACTIONS = new Set(['create', 'join', 'home', 'rating']);
/** Код, по которому открывается админка. Пускает не он, а список в `.env`. */
const ADMIN_CODE = 'admin';
/** Что страница админки может попросить. Всё остальное — отказ. */
const ADMIN_ACTIONS = new Set(['refresh', 'maintenance', 'stopAll', 'stop', 'cast', 'castTest', 'castCancel']);

export class Hub {
  /**
   * @param app       the bot's App: rooms, groups, clocks, and the after-*
   *                  hooks that keep the group card and the timers in step
   * @param botToken    to verify initData
   * @param adminToken  токен админ-бота: приложение, открытое кнопкой из его
   *                    лички, подписано ЕГО токеном, а не игровым. Такой
   *                    странице открыт ровно один экран — админка.
   */
  constructor(app, { botToken, adminToken = null, maxAgeSec } = {}) {
    this.app = app;
    this.botToken = botToken;
    this.adminToken = adminToken || null;
    this.maxAgeSec = maxAgeSec;
    /** room code -> Set<session> */
    this.byRoom = new Map();
    /** group code -> Set<session> — pages on a group's hub */
    this.byGroup = new Map();
    /** Открытые страницы админки: им нужно досылать состояние, а не ждать «Обновить». */
    this.adminPages = new Set();
    this.nextId = 1;
  }

  /* -------------------------------------------------------------- sessions */

  /**
   * A page says hello with its initData and what it wants to look at.
   * @returns {{session}|{error, text}}
   */
  open({ initData, room: wanted } = {}, send) {
    const opts = { now: this.app.clock.now(), maxAgeSec: this.maxAgeSec };
    let auth = checkInitData(initData, this.botToken, opts);
    // Подпись админ-бота — вторая дверь, и ведёт она только в админку.
    let viaAdmin = false;
    if (!auth.ok && this.adminToken) {
      const second = checkInitData(initData, this.adminToken, opts);
      if (second.ok) {
        auth = second;
        viaAdmin = true;
      }
    }
    if (!auth.ok) {
      return { error: 'AUTH', text: auth.reason === 'EXPIRED' ? 'Сессия устарела — откройте стол заново.' : 'Откройте стол из Telegram.' };
    }
    // Владелец, зашедший посмотреть цифры, — не игрок: в «сколько людей
    // открывало приложение» он не попадает, иначе цифры врут про себя.
    if (!viaAdmin) this.app.noteSeen(auth.user.id);
    const asked = String(wanted || '').trim();
    // The signed start_param wins over anything in the page's own URL.
    const code = String(auth.startParam || asked || '').trim();

    // Страница из лички админ-бота не садится за стол и не открывает хаб:
    // тот бот про игры ничего не знает, и его подпись на это не даёт права.
    if (viaAdmin && code !== ADMIN_CODE) return { error: 'NO_ROOM', text: 'Стол не найден — возможно, игру уже удалили.' };

    if (code === ADMIN_CODE) {
      // Не админу отвечаем ровно тем же, чем на выдуманный код: знать, что
      // админка существует, ему незачем.
      if (!this.app.isAdmin(auth.user.id)) return { error: 'NO_ROOM', text: 'Стол не найден — возможно, игру уже удалили.' };
      const session = { id: this.nextId++, user: auth.user, kind: 'admin', group: null, code: null, send, visible: true };
      this.adminPages.add(session);
      this.pushAdmin(session);
      return { session };
    }
    // Opened without a group or a room — from the bot's profile or a button in
    // private. Telegram does not say which group; the bot knows which groups
    // this person plays in, and shows those (one — straight to its games).
    if (!code) {
      const mine = this.app.groupsOf(auth.user.id);
      if (!mine.length) {
        return { error: 'NO_ROOM', text: 'Игры открываются из группы: добавьте меня в группу, напишите там /game и нажмите кнопку.' };
      }
      const session = { id: this.nextId++, user: auth.user, kind: 'home', group: null, code: null, send, visible: true, home: true };
      if (mine.length === 1) {
        session.group = mine[0].code;
        this.enterHub(session);
      } else this.pushHome(session);
      return { session };
    }

    if (code.startsWith(HUB_PREFIX)) {
      const group = this.app.groupByCode(code.slice(HUB_PREFIX.length));
      if (!group) return { error: 'NO_ROOM', text: 'Игры группы не найдены — напишите /game в группе ещё раз.' };
      // No signed start_param (a button in private): the page may come back to
      // one of its own groups after a reconnect, and keeps its «my groups».
      const home = !auth.startParam;
      if (home && !this.app.groupsOf(auth.user.id).some((g) => g.code === group.code)) {
        return { error: 'NO_ROOM', text: 'Игры группы не найдены — напишите /game в группе ещё раз.' };
      }
      const session = { id: this.nextId++, user: auth.user, kind: 'hub', group: group.code, code: null, send, visible: true, home };
      // Back to the room it was in before a reconnect — if it is of this group.
      const inside = this.app.roomByCode(asked);
      if (inside && inside.chatId === group.chatId) this.enterRoom(session, inside);
      else this.enterHub(session);
      return { session };
    }

    const room = this.app.roomByCode(code);
    if (!room) return { error: 'NO_ROOM', text: 'Стол не найден — возможно, игру уже удалили.' };
    // Путь назад — для страницы, которая ПЕРЕПОДКЛЮЧАЕТСЯ, а не открывается
    // заново. Такую видно по тому, что кода комнаты в подписанной ссылке нет:
    // он пришёл из памяти самой страницы (`room`), то есть она уже была за
    // этим столом. Без этого человек, открывший приложение из лички и
    // зашедший за стол, после первого же обрыва связи терял «← Все игры
    // группы» и системную «Назад» — и оставался заперт за столом, пока не
    // закроет приложение целиком.
    //
    // Прав это не прибавляет: группа подставляется только своя — та, в
    // которой человек и так состоит, — а каждое действие в хабе проверяется
    // заново. Открытому по ссылке столу группа по-прежнему не достаётся.
    const reconnect = !auth.startParam && asked === code;
    const mine = reconnect ? this.app.groupsOf(auth.user.id).find((g) => g.chatId === room.chatId) : null;
    const session = {
      id: this.nextId++, user: auth.user, kind: 'room', group: mine ? mine.code : null, code: null, send, visible: true,
    };
    this.enterRoom(session, room);
    return { session };
  }

  close(session) {
    this.detach(session);
  }

  detach(session) {
    if (session.kind === 'admin') {
      this.adminPages.delete(session);
      return;
    }
    // У «моих групп» нет своего списка подписчиков: состояние собирается по
    // запросу, рассылать его некуда.
    if (session.kind === 'home' || session.kind === 'rating') return;
    const map = session.kind === 'hub' ? this.byGroup : this.byRoom;
    const key = session.kind === 'hub' ? session.group : session.code;
    const set = map.get(key);
    if (!set) return;
    set.delete(session);
    if (!set.size) map.delete(key);
  }

  enterRoom(session, room) {
    this.detach(session);
    // Стол открыли — он живой, отсчёт «за столом никого» начинается заново.
    this.app.noteLive(room);
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

  /** Это же состояние заново — что бы страница ни смотрела. */
  resend(session) {
    if (session.kind === 'admin') return this.pushAdmin(session);
    if (session.kind === 'home') return this.pushHome(session);
    if (session.kind === 'rating') return this.pushRating(session);
    if (session.kind === 'hub') return this.pushHub(session);
    if (this.app.down) return void session.send({ t: 'state', state: this.downState() });
    const room = this.app.roomByCode(session.code);
    if (!room) return void session.send({ t: 'gone', text: 'Игру удалили.' });
    return this.push(session, room);
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

  /**
   * Пока идёт обслуживание, игрок видит экран «вернёмся через несколько
   * минут», а не ошибку и не пустой стол: игра никуда не пропала. Админка —
   * единственное, что обслуживание не выключает, иначе его нельзя было бы
   * снять.
   */
  downState() {
    return {
      kind: 'down',
      now: this.app.clock.now(),
      bot: this.app.botUsername,
      text: this.app.downText,
      since: this.app.maintenance.since || null,
    };
  }

  push(session, room) {
    if (this.app.down) return void session.send({ t: 'state', state: this.downState() });
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
    if (this.app.down) {
      // Сбросить «что уже отправлено»: иначе после обслуживания хаб решит,
      // что ничего не изменилось, и страница останется на экране паузы.
      session.lastHub = null;
      return void session.send({ t: 'state', state: this.downState() });
    }
    const group = this.app.groupByCode(session.group);
    if (!group) return;
    try {
      const view = hubView(this.app, group, session.user, { home: !!session.home && this.app.groupsOf(session.user.id).length > 1 });
      const json = JSON.stringify(view);
      if (json === session.lastHub) return;
      session.lastHub = json;
      session.send({ t: 'state', state: { ...view, now: this.app.clock.now() } });
    } catch (err) {
      this.app.log(err);
    }
  }

  /** «My groups» — for a page opened without a group. */
  pushHome(session) {
    if (this.app.down) return void session.send({ t: 'state', state: this.downState() });
    this.detach(session);
    session.kind = 'home';
    session.group = null;
    session.code = null;
    const groups = this.app.groupsOf(session.user.id).map((g) => ({
      code: g.code,
      title: g.title || 'Группа',
      live: this.app.liveRooms(g.chatId).length,
    }));
    session.send({ t: 'state', state: { kind: 'home', now: this.app.clock.now(), bot: this.app.botUsername, me: { name: session.user.name }, groups } });
  }

  /** Всё, что видит владелец: цифры, живые сессии, обслуживание, рассылки. */
  pushAdmin(session) {
    try {
      session.send({ t: 'state', state: adminView(this.app) });
    } catch (err) {
      this.app.log(err);
    }
  }

  /** Сколько разных людей сейчас смотрят в приложение. */
  get people() {
    const ids = new Set();
    for (const set of this.byRoom.values()) for (const s of set) ids.add(s.user.id);
    for (const set of this.byGroup.values()) for (const s of set) ids.add(s.user.id);
    return ids.size;
  }

  /** Каждой открытой странице — её состояние заново. Для режима обслуживания. */
  broadcastAll() {
    for (const [code, set] of this.byRoom) {
      const room = this.app.roomByCode(code);
      for (const s of set) {
        if (this.app.down) s.send({ t: 'state', state: this.downState() });
        else if (room) this.push(s, room);
      }
    }
    for (const set of this.byGroup.values()) for (const s of set) this.pushHub(s);
    this.pushAdmins();
  }

  /** Досылать цифры открытым админкам: обслуживание и рассылки меняются редко. */
  pushAdmins() {
    for (const s of this.adminPages) this.pushAdmin(s);
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
      // Стол открывали кнопкой с карточки — тогда группы у сессии нет, и
      // раньше человек оставался на «Игру удалили» без выхода. Ведём его к
      // своим группам: оттуда он дойдёт куда хотел.
      if (s.group && this.app.groupByCode(s.group)) this.enterHub(s);
      else this.pushHome(s);
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
    // «Дай состояние заново» — это может попросить любая страница: во время
    // обслуживания она сама переспрашивает, снято ли оно.
    if (msg.t === 'refresh' && session.kind !== 'admin') return this.resend(session);
    if (COMMON.has(msg.t)) {
      // «Я на экране» / «свернули» — не ход, а хозяйственное сообщение: его
      // принимаем всегда, иначе страница получит отказ просто за то, что её
      // открыли во время обслуживания.
      session.visible = !!msg.visible;
      return;
    }
    if (this.app.down && session.kind !== 'admin') {
      // Пока идёт обслуживание, ни одного хода не принимается — ни за столом,
      // ни в хабе. Отказ объясняется, как любой другой.
      this.refuse(session, 'DOWN', `⏸ Идёт обслуживание. ${this.app.downText}`);
      return void this.resend(session);
    }
    if (session.kind === 'hub') return this.handleHub(session, msg);
    if (session.kind === 'home') return this.handleHome(session, msg);
    if (session.kind === 'rating') return this.handleRating(session, msg);
    if (session.kind === 'admin') {
      if (COMMON.has(msg.t)) {
        session.visible = !!msg.visible;
        return;
      }
      return this.handleAdmin(session, msg);
    }

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

    // Что бы страница ни просила у стола — за ним кто-то есть.
    this.app.noteLive(room);
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

  /**
   * Пульт владельца. Пускает сюда не сообщение, а `kind: 'admin'`, который
   * поставлен при входе по списку из `.env`: подделать его страница не может.
   */
  async handleAdmin(session, msg) {
    const app = this.app;
    if (!ADMIN_ACTIONS.has(msg.t)) return this.refuse(session, 'BAD_REQUEST');

    switch (msg.t) {
      case 'refresh':
        return this.pushAdmin(session);

      case 'maintenance': {
        app.setMaintenance(!!msg.on, msg.text);
        return this.pushAdmin(session);
      }

      case 'stopAll': {
        const n = await app.stopAll();
        session.send({ t: 'notice', text: n ? `Завершено игр: ${n}. Итоги ушли в группы.` : 'Живых игр не было.' });
        return this.pushAdmin(session);
      }

      case 'stop': {
        const room = app.roomByCode(String(msg.code || ''));
        if (!room || room.status === 'finished') return this.refuse(session, 'NO_ROOM');
        const r = gameOf(room).endGame(room, room.hostId);
        if (r.error) return this.refuse(session, r.error);
        await app.finishUp(room);
        session.send({ t: 'notice', text: 'Игра завершена, итоги ушли в группу.' });
        return this.pushAdmin(session);
      }

      case 'cast': {
        if (!app.casts) return this.refuse(session, 'NO_CASTS');
        const r = app.casts.plan({ text: msg.text, btnText: msg.btnText, btnUrl: msg.btnUrl, audience: msg.audience, at: Number(msg.at) || 0 });
        if (r.error) return this.refuse(session, r.error, r.text || CAST_ERRORS[r.error]);
        session.send({ t: 'notice', text: r.at > app.clock.now() + 60_000 ? 'Рассылка запланирована.' : 'Рассылка пошла.' });
        return this.pushAdmin(session);
      }

      case 'castTest': {
        if (!app.casts) return this.refuse(session, 'NO_CASTS');
        const r = await app.casts.test(session.user.id, { text: msg.text, btnText: msg.btnText, btnUrl: msg.btnUrl, audience: msg.audience || 'all' });
        if (r.error) return this.refuse(session, r.error, r.text || CAST_ERRORS[r.error]);
        session.send({ t: 'notice', text: 'Письмо ушло вам в личку игрового бота.' });
        return;
      }

      case 'castCancel': {
        if (!app.casts) return this.refuse(session, 'NO_CASTS');
        const r = app.casts.cancel(Number(msg.id));
        if (r.error) return this.refuse(session, r.error, CAST_ERRORS[r.error]);
        session.send({ t: 'notice', text: 'Рассылка отменена.' });
        return this.pushAdmin(session);
      }

      default:
        return this.refuse(session, 'BAD_REQUEST');
    }
  }

  /**
   * Рейтинг. Своего списка подписчиков у него нет — как и у «моих групп»:
   * он не меняется сам по себе, его собирают по запросу.
   */
  enterRating(session, { game = 'durak', period = 'month' } = {}) {
    // Решает сервер, а не кнопка на странице: старая вкладка не должна
    // открывать то, что ещё закрыто.
    if (this.app.ratingSoon) return this.refuse(session, 'RATING_SOON');
    this.detach(session);
    session.kind = 'rating';
    session.code = null;
    session.rating = {
      game: GAMES[game] ? game : 'durak',
      period: period === 'all' ? 'all' : 'month',
      // По умолчанию общий: у новой группы свой рейтинг пуст, и открывать
      // экран на пустом списке — плохо. «Эту группу» включают вкладкой, и
      // она есть только у страницы, открытой из группы.
      scope: 'all',
      who: null,
    };
    this.pushRating(session);
  }

  pushRating(session) {
    if (this.app.down) return void session.send({ t: 'state', state: this.downState() });
    try {
      const group = session.group ? this.app.groupByCode(session.group) : null;
      session.send({ t: 'state', state: ratingView(this.app, session.user, {
        ...session.rating,
        chatId: session.rating.scope === 'group' ? group?.chatId ?? null : null,
        groupTitle: group?.title || '',
        back: session.group ? 'hub' : 'home',
      }) });
    } catch (err) {
      this.app.log(err);
      this.refuse(session, 'NO_RATING', 'Рейтинг сейчас не отдаётся — попробуйте позже.');
    }
  }

  handleRating(session, msg) {
    if (COMMON.has(msg.t)) {
      session.visible = !!msg.visible;
      return;
    }
    switch (msg.t) {
      case 'pick':
        // Игра и срок — единственное, что страница здесь решает.
        if (msg.game != null) session.rating.game = GAMES[String(msg.game)] ? String(msg.game) : session.rating.game;
        if (msg.period != null) session.rating.period = msg.period === 'all' ? 'all' : 'month';
        // Группу подставляет сервер из сессии: страница не может попросить
        // рейтинг чужой группы, назвав её код.
        if (msg.scope != null) session.rating.scope = msg.scope === 'group' && session.group ? 'group' : 'all';
        session.rating.who = null;
        return this.pushRating(session);
      case 'who':
        // Карточка игрока: места и очки. Ни карт, ни ставок здесь нет.
        session.rating.who = msg.id == null ? null : String(msg.id);
        return this.pushRating(session);
      case 'refresh':
        return this.pushRating(session);
      case 'back':
        if (session.group && this.app.groupByCode(session.group)) return this.enterHub(session);
        return this.pushHome(session);
      default:
        return this.refuse(session, 'BAD_REQUEST');
    }
  }

  /** «My groups»: step into one of them — only one of this person's own. */
  handleHome(session, msg) {
    if (COMMON.has(msg.t)) {
      session.visible = !!msg.visible;
      return;
    }
    if (msg.t === 'rating') return this.enterRating(session, msg);
    if (msg.t !== 'group') return this.refuse(session, 'BAD_REQUEST');
    const group = this.app.groupsOf(session.user.id).find((g) => g.code === String(msg.code || ''));
    if (!group) return this.refuse(session, 'NOT_YOUR_GROUP');
    session.group = group.code;
    return this.enterHub(session);
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
    if (msg.t === 'home') {
      if (!session.home) return this.refuse(session, 'BAD_REQUEST');
      return this.pushHome(session);
    }
    if (msg.t === 'rating') return this.enterRating(session, msg);

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
export function hubView(app, group, user, { home = false } = {}) {
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
    group: { title: group.title || '', code: group.code },
    home, // opened without a group: «← Мои группы»
    me: { name: user.name },
    ratingSoon: app.ratingSoon ? RATING_SOON_TEXT : null,
    games: GAME_LIST.map((g) => ({ id: g.id, title: g.title, icon: g.icon, blurb: g.blurb, min: g.minPlayers, max: g.maxPlayers })),
    lobbies,
  };
}

/**
 * Рейтинг одним состоянием: список, своя строка и, если открыли карточку
 * человека, его карточка.
 *
 * Своя строка отдаётся ВСЕГДА, даже когда человека нет в первой полусотне:
 * без неё список — чужая доска почёта, а не твой рейтинг. Ни карт, ни ставок,
 * ни того, с кем именно играли, здесь нет: только места и очки.
 */
export function ratingView(app, user, {
  game = 'durak', period = 'month', scope = 'all', chatId = null, groupTitle = '', who = null, back = 'hub',
} = {}) {
  const now = app.clock.now();
  const month = period === 'month' ? ym(now) : null;
  const store = app.store;
  const uid = String(user.id);
  const top = store.ratingTop(game, { month, limit: 50, chatId }).map((r, i) => ({
    place: i + 1,
    userId: String(r.userId),
    name: r.name || 'Игрок',
    points: r.points,
    played: r.played,
    wins: r.wins,
    fools: r.fools,
    me: String(r.userId) === uid,
  }));
  const card = (id) => {
    const r = store.ratingOf(id, game, { month, chatId });
    if (!r) return null;
    return {
      userId: String(id),
      name: r.name || 'Игрок',
      points: r.points,
      place: r.place,
      total: r.total,
      played: r.played,
      wins: r.wins,
      fools: r.fools,
      // Последние партии — откуда взялись очки. Без этого число не объяснить.
      last: store.ratingLog(id, game, 5, { chatId }).map((x) => ({ place: x.place, of: x.of, delta: x.delta, sign: sign(x.delta), at: x.at })),
    };
  };
  return {
    kind: 'rating',
    now,
    bot: app.botUsername,
    me: { name: user.name },
    back,
    game,
    period,
    // scope: 'all' — все группы вместе, 'group' — только эта.
    scope: chatId == null ? 'all' : 'group',
    canGroup: back === 'hub',
    groupTitle,
    month,
    perDay: PER_DAY,
    games: GAME_LIST.map((g) => ({ id: g.id, title: GAME_RU[g.id] || g.title, icon: g.icon })),
    top,
    mine: card(uid),
    who: who && who !== uid ? card(who) : null,
  };
}

/**
 * Пульт целиком, одним состоянием: цифры, живые сессии, обслуживание,
 * рассылки.
 *
 * Ни одного имени игрока и ни одной карты здесь нет — как и в цифрах. Чтобы
 * понять, какую игру снимать, хватает названия группы и кода; обещание «никто
 * не видит чужих карт» не знает исключений, в том числе для владельца.
 */
export function adminView(app) {
  const now = app.clock.now();
  const rooms = [...app.rooms.values()].filter((r) => r.status !== 'finished');
  const sessions = rooms
    .map((room) => {
      const g = gameOf(room);
      const s = g.summary(room);
      const group = app.groups.get(String(room.chatId));
      return {
        code: room.code,
        game: g.id,
        icon: g.icon,
        title: g.title,
        group: group?.title || room.title || '',
        status: room.status,
        seated: s.seated,
        max: s.max,
        detail: s.detail || '',
        watching: app.hub?.byRoom.get(room.code)?.size || 0,
        started: room.startedAt || room.createdAt || null,
      };
    })
    .sort((a, b) => (b.started || 0) - (a.started || 0));

  return {
    kind: 'admin',
    now,
    bot: app.botUsername,
    me: null, // на этом экране даже своё имя ни к чему
    live: app.liveNow(),
    stats: app.store.stats(now),
    down: { on: app.down, text: app.maintenance.text || '', since: app.maintenance.since || null },
    sessions,
    casts: app.casts ? { list: app.casts.list(10), sizes: app.casts.sizes(), audiences: AUDIENCES, sending: app.casts.busy } : null,
  };
}
