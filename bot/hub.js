'use strict';
/**
 * The table's side of the Mini App: who is looking at which room, what they
 * are allowed to do, and what each of them gets to see.
 *
 * Transport-agnostic on purpose — a session is anything with `send(obj)`.
 * `server.js` plugs WebSockets into it; the tests plug in plain functions,
 * so the whole protocol is tested without a socket.
 *
 * THE RULE, again: a session's identity comes from `initData` verified with
 * the bot token, and from nowhere else. Nothing in a message from the page —
 * a seat number, a user id, a name — can make it act as somebody else. Every
 * action goes through the same `room.js` calls, with the same checks, as
 * the buttons in the group used to.
 */
import { checkInitData } from './webapp-auth.js';
import { tableView } from './view.js';
import * as R from './room.js';

/** What the page may ask for, and nothing else. */
const ACTIONS = new Set([
  'sit', 'leave', 'start', 'act', 'next', 'settings', 'role', 'kick', 'rebuy', 'host',
  'pause', 'resume', 'undo', 'finish', 'pick', 'potNext', 'potBack', 'confirm', 'visible',
]);

/** Error codes in words a person can act on. Kept short: they show as a toast. */
export const ERRORS = {
  NOT_HOST: 'Это может только хост.',
  NOT_SEATED: 'Сначала сядьте за стол.',
  KICKED: 'Хост удалил вас из этой игры.',
  TABLE_FULL: 'За столом нет мест.',
  NOT_YOUR_TURN: 'Сейчас не ваш ход.',
  STALE: 'Стол уже изменился — посмотрите ещё раз.',
  NOT_ENOUGH_PLAYERS: 'Нужно минимум два игрока с фишками.',
  NOT_ENOUGH_CHIPS: 'Не хватает фишек.',
  BELOW_MIN_RAISE: 'Меньше минимального повышения.',
  CANNOT_CHECK: 'Чек нельзя — перед вами ставка.',
  CANNOT_CALL: 'Коллировать нечего.',
  CANNOT_BET: 'Ставку сейчас сделать нельзя.',
  CANNOT_RAISE: 'Повышать нельзя: короткий олл-ин не открыл торговлю заново.',
  BAD_AMOUNT: 'Некорректная сумма.',
  GAME_PAUSED: 'Игра на паузе.',
  GAME_FINISHED: 'Игра завершена.',
  NOT_PLAYING: 'Игра ещё не началась.',
  ALREADY_STARTED: 'Игра уже идёт.',
  HAND_IN_PROGRESS: 'Раздача ещё идёт.',
  DEALER_DECIDES: 'Победителя отмечает дилер.',
  DEALER_DEALS: 'Следующую раздачу начинает дилер.',
  NOT_ELIGIBLE: 'Этот игрок не претендует на этот банк.',
  NO_WINNER_SELECTED: 'Сначала отметьте победителя.',
  NOT_LIVE: 'Дилер нужен только для игры настоящими картами.',
  NOTHING_TO_UNDO: 'Отменять нечего. Ставки и раздачи не отменяются.',
  CANNOT_KICK_HOST: 'Хоста удалить нельзя — сначала передайте права.',
  NO_PLAYER: 'Игрок не найден.',
  NOT_LEVELS: 'Растущие блайнды выключены.',
  BAD_STEP: 'Сейчас этот шаг недоступен.',
  BAD_POT: 'Этот банк не требует решения.',
  BAD_REQUEST: 'Не понял запрос.',
};

export class Hub {
  /**
   * @param app       the bot's App: rooms, clocks, and the after-* hooks that
   *                  keep the group card and the timers in step
   * @param botToken  to verify initData
   */
  constructor(app, { botToken, maxAgeSec } = {}) {
    this.app = app;
    this.botToken = botToken;
    this.maxAgeSec = maxAgeSec;
    /** room code -> Set<session> */
    this.byRoom = new Map();
    this.nextId = 1;
  }

  /* -------------------------------------------------------------- sessions */

  /**
   * A page says hello with its initData and the room it wants.
   * @returns {{session}|{error, text}}
   */
  open({ initData, room: wanted } = {}, send) {
    const auth = checkInitData(initData, this.botToken, { now: this.app.clock.now(), maxAgeSec: this.maxAgeSec });
    if (!auth.ok) {
      return { error: 'AUTH', text: auth.reason === 'EXPIRED' ? 'Сессия устарела — откройте стол заново.' : 'Откройте стол из Telegram.' };
    }
    // The signed start_param wins over anything in the page's own URL.
    const code = String(auth.startParam || wanted || '').trim();
    const room = this.app.roomByCode(code);
    if (!room) return { error: 'NO_ROOM', text: 'Стол не найден — возможно, игру уже удалили.' };

    const session = { id: this.nextId++, user: auth.user, code: room.code, send, visible: true };
    if (!this.byRoom.has(room.code)) this.byRoom.set(room.code, new Set());
    this.byRoom.get(room.code).add(session);
    this.push(session, room);
    return { session };
  }

  close(session) {
    const set = this.byRoom.get(session.code);
    if (!set) return;
    set.delete(session);
    if (!set.size) this.byRoom.delete(session.code);
  }

  /** Is this person looking at this table right now? (Then no "your turn" ping.) */
  isPresent(code, userId) {
    for (const s of this.byRoom.get(code) || []) if (s.user.id === String(userId) && s.visible) return true;
    return false;
  }

  /* ------------------------------------------------------------ broadcasting */

  push(session, room) {
    try {
      session.send({ t: 'state', state: tableView(room, session.user.id, { now: this.app.clock.now(), botUsername: this.app.botUsername }) });
    } catch (err) {
      this.app.log(err);
    }
  }

  /** Everyone at this table gets THEIR OWN view of it. */
  broadcast(room) {
    for (const s of this.byRoom.get(room.code) || []) this.push(s, room);
  }

  /** A room was re-keyed (group -> supergroup) or deleted. */
  forget(code) {
    for (const s of this.byRoom.get(code) || []) {
      try {
        s.send({ t: 'gone', text: 'Игру удалили.' });
      } catch {
        /* closed already */
      }
    }
    this.byRoom.delete(code);
  }

  /* ---------------------------------------------------------------- actions */

  refuse(session, code) {
    session.send({ t: 'error', code, text: ERRORS[code] || `Не получилось: ${code}` });
  }

  /**
   * One message from one page. Returns when the room and everything that
   * follows from the move (group card, timers, reveal) has been taken care of.
   */
  async handle(session, msg) {
    const app = this.app;
    const room = app.roomByCode(session.code);
    if (!room) return session.send({ t: 'gone', text: 'Игру удалили.' });
    if (!msg || typeof msg !== 'object' || !ACTIONS.has(msg.t)) return this.refuse(session, 'BAD_REQUEST');

    const uid = session.user.id; // the ONLY identity there is
    const target = () => {
      const p = room.players[Number(msg.seat)];
      return Number.isInteger(Number(msg.seat)) && p ? p : null;
    };
    const fail = (r) => (r?.error ? (this.refuse(session, r.error), true) : false);

    switch (msg.t) {
      case 'visible':
        session.visible = !!msg.visible;
        return;

      case 'sit': {
        if (room.status === 'finished') return this.refuse(session, 'GAME_FINISHED');
        const p = R.addPlayer(room, app.person(session.user));
        if (fail(p)) return;
        return app.afterChange(room);
      }

      case 'leave':
        if (fail(R.sitOut(room, uid, true))) return;
        return app.afterAction(room);

      case 'start': {
        const r = R.startGame(room, uid, app.dealOpts(room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }

      case 'act': {
        const action = String(msg.action || '');
        if (!['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(action)) return this.refuse(session, 'BAD_REQUEST');
        const amount = msg.amount == null ? null : Number(msg.amount);
        const seq = Number.isInteger(msg.seq) ? msg.seq : undefined;
        if (fail(R.act(room, uid, action, amount, seq))) return this.push(session, room);
        return app.afterAction(room);
      }

      case 'next': {
        const r = R.nextHand(room, uid, app.dealOpts(room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }

      case 'settings': {
        const patch = {};
        for (const k of ['startingStack', 'smallBlind', 'bigBlind', 'turnSeconds']) {
          if (msg[k] != null && Number.isFinite(Number(msg[k]))) patch[k] = Number(msg[k]);
        }
        if (msg.cards === 'live' || msg.cards === 'virtual') patch.cards = msg.cards;
        if (fail(R.updateSettings(room, uid, patch))) return;
        return app.afterChange(room);
      }

      case 'role': {
        const p = target();
        if (!p) return this.refuse(session, 'NO_PLAYER');
        if (fail(R.setRole(room, uid, p.id, msg.role === 'dealer' ? 'dealer' : 'player'))) return;
        return app.afterChange(room);
      }

      case 'kick': {
        const p = target();
        if (!p) return this.refuse(session, 'NO_PLAYER');
        if (fail(R.kickPlayer(room, uid, p.id))) return;
        return app.afterAction(room);
      }

      case 'rebuy': {
        const p = target();
        if (!p) return this.refuse(session, 'NO_PLAYER');
        if (fail(R.adjustStack(room, uid, p.id, room.settings.startingStack))) return;
        return app.afterChange(room);
      }

      case 'host': {
        const p = target();
        if (!p) return this.refuse(session, 'NO_PLAYER');
        if (fail(R.transferHost(room, uid, p.id))) return;
        return app.afterChange(room);
      }

      case 'pause':
      case 'resume':
        if (fail(R.setPaused(room, uid, msg.t === 'pause'))) return;
        return app.afterChange(room);

      case 'undo':
        if (fail(R.undo(room, uid))) return;
        return app.afterChange(room);

      case 'finish':
        if (fail(R.endGame(room, uid))) return;
        return app.finishUp(room);

      case 'pick': {
        const r = R.toggleWinner(room, uid, Number(msg.pot), Number(msg.seat));
        if (fail(r)) return;
        return app.afterChange(room);
      }
      case 'potNext':
      case 'potBack': {
        const r = msg.t === 'potNext' ? R.winnerNext(room, uid) : R.winnerBack(room, uid);
        if (fail(r)) return;
        return app.afterChange(room);
      }
      case 'confirm': {
        const r = R.confirmWinners(room, uid, Number.isInteger(msg.seq) ? msg.seq : undefined);
        if (fail(r)) return this.push(session, room);
        return app.afterAction(room);
      }
      default:
        return this.refuse(session, 'BAD_REQUEST');
    }
  }
}
