'use strict';
/**
 * Шахматы как одна игра хаба: какие ходы страница вправе прислать, часы и
 * зацепки, за которые дёргает ядро. Тот же контракт, что у games/durak.
 *
 * Шахматы — первая ДУЭЛЬ: игра на двоих. Ядро видит это по `maxPlayers === 2`
 * и разрешает хосту несколько лобби сразу (hub.js) — у каждого своя карточка
 * в группе и свой соперник.
 */
import * as C from './rules.js';
import { chessView } from './view.js';
import { renderCard, renderResults, gameResultText, renderTurnPing, shareText } from './render.js';
import bot from './bot.js';

/** Что страница вправе просить у шахматного стола — и больше ничего. */
const ACTIONS = new Set([
  'sit', 'leave', 'start', 'next', 'move', 'resign', 'abort', 'draw', 'decline', 'takeback', 'declinetb',
  'settings', 'kick', 'host', 'finish',
]);

export const ERRORS = {
  NOT_YOUR_TURN: 'Сейчас ходит соперник.',
  NOT_IN_GAME: 'Вы не играете в этой партии — вы зритель.',
  ILLEGAL: 'Так ходить нельзя.',
  NEED_PROMO: 'Пешка дошла до края — выберите, в кого она превращается.',
  STALE: 'Позиция уже изменилась — посмотрите ещё раз.',
  TIME_UP: 'Время на ход вышло — партия закончена.',
  NOT_PLAYING: 'Партия сейчас не идёт.',
  GAME_IN_PROGRESS: 'Партия ещё идёт.',
  IN_GAME: 'Партия идёт — из-за стола уходят после неё. Можно сдаться.',
  TOO_EARLY: 'Это можно, когда каждый сделал по ходу. Пока партию можно отменить.',
  TOO_LATE: 'Отменить можно только до второго хода. Теперь — сдаться.',
  OFFER_COOLDOWN: 'Соперник уже отказал — предложите ещё раз через пару ходов.',
  NO_OFFER: 'Предложения ничьей нет.',
  NO_TAKEBACK: 'Просьбы вернуть ход нет.',
  NOTHING_TO_TAKE: 'Вы ещё не сделали ни одного хода — возвращать нечего.',
  OFFER_PENDING: 'Сначала ответьте на предложение соперника — или дождитесь ответа на своё.',
  ASK_TOO_FAST: 'Не так часто — подождите немного.',
  TAKEBACK_COOLDOWN: 'Соперник уже отказал — попросите ещё раз через пару ходов.',
  NOT_SEATED: 'Сначала сядьте за стол.',
  NOT_HOST: 'Это может только хост.',
  ALREADY_STARTED: 'Игра уже идёт.',
  GAME_FINISHED: 'Игра завершена.',
  NOT_ENOUGH_PLAYERS: 'Нужен соперник — стол на двоих.',
  TABLE_FULL: 'За доской уже двое — вы можете смотреть партию.',
  KICKED: 'Хост удалил вас из этой игры.',
  CANNOT_KICK_HOST: 'Хоста удалить нельзя — сначала передайте права.',
  NO_PLAYER: 'Игрок не найден.',
};

async function onTurnTimeout(app, code, key) {
  const room = app.roomByCode(code);
  if (!room) return;
  const r = C.timeoutMove(room, key, app.clock.now());
  if (!r.error) await app.afterAction(room);
  app.syncClocks();
}

export default {
  id: 'chess',
  title: 'Шахматы',
  icon: '♟',
  blurb: 'Дуэль на двоих, с часами',
  minPlayers: C.MIN_PLAYERS,
  maxPlayers: C.MAX_SEATS,
  errors: ERRORS,
  /** Лобби одной командой в группе: `[команда, описание в меню]`. */
  commands: [['chess', 'шахматы — новое лобби одной командой']],
  /** Соперник-бот для одиночной партии (bot.js). */
  bot,

  /** Жребий цвета: в тестах подставляется (`app.chessRand`), в игре — настоящий. */
  dealOpts: (room, app) => (app.chessRand ? { rand: app.chessRand } : {}),

  create({ chatId, title, host, settings = null }) {
    const s = settings || {};
    return C.createRoom({ chatId, title, host, base: s.base, inc: s.inc, side: s.side });
  },

  serialize: (room, now) => C.serialize(room, now),
  deserialize: (data) => C.deserialize(data),

  view: (room, viewerId, ctx) => chessView(room, viewerId, ctx),

  card: (room, opts) => renderCard(room, opts),
  shareText: (room, userId, opts) => shareText(room, userId, opts),
  results: (room) => renderResults(room),
  /** Тексты итогов партий, ещё не объявленных в группе (помечает объявленными). Ядро шлёт их само. */
  announcements: (room) => C.takeAnnouncements(room).map((g) => gameResultText(room, g)),

  /**
   * Партии для рейтинга. Победа и поражение считаются как места 1 и 2;
   * ничья очков не даёт (ей нет «проигравшего», а делить +20 пополам — значит
   * платить за сговор вничью), отменённая — тоже, и обе с объяснением.
   */
  rounds(room) {
    return room.history.map((g) => {
      const name = (id) => C.findPlayer(room, id)?.name ?? null;
      const win = g.winner;
      const lose = win ? (win === g.white ? g.black : g.white) : null;
      const order = win ? [win, lose] : [g.white, g.black];
      return {
        id: `${room.code}#${g.no}`,
        aborted: !!g.aborted,
        // Сдача или время на втором-третьем ходу — самая дешёвая накрутка: двое
        // договорились, и +20 за полминуты. Короткая партия очков не даёт;
        // мат, пат и остальные естественные концы считаются при любой длине.
        short: !g.aborted && !!win && ['resign', 'time'].includes(g.kind) && g.plies < C.RATED_MIN_PLIES,
        draw: !g.aborted && !win,
        loserId: lose,
        places: order.map((id) => ({ id, name: name(id) })),
      };
    });
  },

  /** Ждём того, чей ход. Ключ меняется с каждым ходом — на новый ход новое напоминание. */
  waiting(room) {
    const m = C.live(room);
    if (!m) return [];
    const id = C.mover(m) === 'w' ? m.white : m.black;
    return [{ id, key: `${m.no}:${m.moves.length}`, kind: 'move' }];
  },
  pingText: (room, p, w) => renderTurnPing(room, p, w),

  summary(room) {
    const seated = C.seatedPlayers(room);
    return {
      seated: seated.length,
      max: C.MAX_SEATS,
      names: seated.map((p) => p.name),
      detail: C.controlRu(room.settings) + (room.gameNo ? ` · партия ${room.gameNo}` : ''),
    };
  },

  markLeft: (room, userId, now) => C.markLeft(room, userId, now),
  endGame: (room, userId, now) => C.endGame(room, userId, now),

  clocks(app, room, now) {
    const code = room.code;
    const turn = C.syncTurn(room, now);
    return [{ id: 'turn', timer: turn, fire: () => onTurnTimeout(app, code, turn.key) }];
  },

  async handle({ app, session, room, uid, msg, refuse, push }) {
    if (!ACTIONS.has(msg.t)) return refuse('BAD_REQUEST');
    const ply = Number.isInteger(msg.ply) ? msg.ply : undefined;
    const target = () => {
      const p = room.players[Number(msg.seat)];
      return Number.isInteger(Number(msg.seat)) && p ? p : null;
    };
    /** Отказ: сказать почему и вернуть на страницу настоящую позицию. */
    const fail = (r, { resync = false } = {}) => {
      if (!r?.error) return false;
      refuse(r.error, r.text);
      // Действие отклонено, но срок уже завершил партию: вызывающий обязан
      // провести afterAction (рейтинг, состояние, карточка и сохранение).
      if (r.ended) return false;
      if (resync) push();
      return true;
    };

    switch (msg.t) {
      case 'sit': {
        const p = C.addPlayer(room, app.person(session.user));
        if (fail(p)) return;
        return app.afterChange(room);
      }
      case 'leave':
        if (fail(C.leave(room, uid))) return;
        return app.afterChange(room);

      case 'start': {
        const r = C.startGame(room, uid, app.dealOpts(room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }
      case 'next': {
        // С ботом соперник согласен заранее; двое людей — по обоюдному согласию.
        const r = room.solo ? C.nextGame(room, uid) : C.askRematch(room, uid);
        if (fail(r)) return;
        if (r.noop) return;
        return r.started ? app.afterDeal(room, r) : app.afterChange(room);
      }

      case 'move': {
        const r = C.move(room, uid, { from: String(msg.from || ''), to: String(msg.to || ''), promo: String(msg.promo || '') }, app.clock.now(), ply);
        if (r.ended) refuse(r.error, r.text); // флажок упал раньше, чем сработал таймер: партия закончилась
        else if (fail(r, { resync: true })) return;
        return app.afterAction(room);
      }
      case 'resign':
        if (fail(C.resign(room, uid, app.clock.now()), { resync: true })) return;
        return app.afterAction(room);
      case 'abort':
        if (fail(C.abortMatch(room, uid, app.clock.now()), { resync: true })) return;
        return app.afterAction(room);

      case 'draw': {
        const r = C.offerDraw(room, uid, app.clock.now());
        if (fail(r, { resync: true })) return;
        if (r.noop) return;
        return r.ended || r.accepted ? app.afterAction(room) : app.afterChange(room);
      }
      case 'decline':
        if (fail(C.declineDraw(room, uid), { resync: true })) return;
        return app.afterChange(room);

      // Откат своего последнего хода: просьба или разрешение. После согласия
      // позиция и часы возвращаются — это новый «ход партии» для всех.
      case 'takeback': {
        const r = C.requestTakeback(room, uid, app.clock.now());
        if (fail(r, { resync: true })) return;
        if (r.noop) return;
        return r.ended || r.accepted ? app.afterAction(room) : app.afterChange(room);
      }
      case 'declinetb':
        if (fail(C.declineTakeback(room, uid), { resync: true })) return;
        return app.afterChange(room);

      case 'settings': {
        const patch = {};
        for (const k of ['base', 'inc']) if (msg[k] != null && Number.isFinite(Number(msg[k]))) patch[k] = Number(msg[k]);
        if (typeof msg.side === 'string') patch.side = msg.side;
        if (fail(C.updateSettings(room, uid, patch))) return;
        return app.afterChange(room);
      }
      case 'kick': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(C.kickPlayer(room, uid, p.id, app.clock.now()))) return;
        return app.afterAction(room);
      }
      case 'host': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(C.transferHost(room, uid, p.id))) return;
        return app.afterChange(room);
      }
      case 'finish': {
        const r = C.endGame(room, uid, app.clock.now());
        if (fail(r) || r.noop) return;
        return app.finishUp(room);
      }

      default:
        return refuse('BAD_REQUEST');
    }
  },
};
