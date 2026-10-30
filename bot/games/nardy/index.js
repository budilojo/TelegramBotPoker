'use strict';
/**
 * Нарды как одна игра хаба: какие действия страница вправе прислать, часы и
 * зацепки ядра. Дуэль (`maxPlayers: 2`) по образцу шахмат и шашек.
 *
 * Кубики: `roll` бросает сервер — числа берутся из `app.nardyDice` (подмена
 * в тестах) или из crypto.randomInt; что бы страница ни прислала в
 * сообщении, сервер его чисел не читает.
 */
import * as N from './rules.js';
import { nardyView } from './view.js';
import { renderCard, renderResults, renderTurnPing, shareText, ICON } from './render.js';
import bot from './bot.js';

/** Что страница вправе просить у стола нардов — и больше ничего. */
const ACTIONS = new Set([
  'sit', 'leave', 'start', 'next', 'roll', 'move', 'undo', 'end', 'resign', 'abort',
  'settings', 'kick', 'host', 'finish',
]);

export const ERRORS = {
  NOT_YOUR_TURN: 'Сейчас ходит соперник.',
  NOT_IN_GAME: 'Вы не играете в этой партии — вы зритель.',
  ROLL_FIRST: 'Сначала бросьте кубики.',
  ALREADY_ROLLED: 'Кубики уже брошены — играйте выпавшие числа.',
  NO_SUCH_DIE: 'Такого числа на кубиках нет — или оно уже сыграно.',
  NOT_YOUR_CHECKER: 'Здесь нет вашей шашки.',
  HEAD_ONCE: 'С головы за ход — только одна шашка.',
  BAD_STEP: 'Так нельзя: этим ходом не сыграть оба числа, пункт занят, рано снимать или выйдет шесть подряд, запирающих все шашки соперника.',
  TURN_DONE: 'Ход сыгран — нажмите «Готово» или отмените шаг.',
  MOVES_LEFT: 'Ещё не всё сыграно: числа, которые можно сыграть, сыграть обязательно.',
  NOTHING_TO_UNDO: 'Отменять нечего — в этом ходу вы ещё не ходили.',
  STALE: 'Позиция уже изменилась — посмотрите ещё раз.',
  TIME_UP: 'Время на ход вышло — партия закончена.',
  NOT_PLAYING: 'Партия сейчас не идёт.',
  GAME_IN_PROGRESS: 'Партия ещё идёт.',
  IN_GAME: 'Партия идёт — из-за стола уходят после неё. Можно сдаться.',
  TOO_EARLY: 'Это можно, когда каждый сделал по ходу. Пока партию можно отменить.',
  TOO_LATE: 'Отменить можно только до второго хода. Теперь — сдаться.',
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

/** Кубики: в тестах — `app.nardyDice`, в бою — настоящие. Со страницы — никогда. */
const diceOpts = (app) => (app.nardyDice ? { dice: app.nardyDice } : {});

async function onTurnTimeout(app, code, key) {
  const room = app.roomByCode(code);
  if (!room) return;
  const r = N.timeoutMove(room, key, app.clock.now());
  if (!r.error) await app.afterAction(room);
  app.syncClocks();
}

export default {
  id: 'nardy',
  title: 'Нарды',
  icon: ICON,
  blurb: 'Длинные нарды на двоих, с часами',
  minPlayers: N.MIN_PLAYERS,
  maxPlayers: N.MAX_SEATS,
  // Атомарные действия: общая защита версии позиции в хабе.
  positionActions: ['move', 'roll', 'end', 'undo'],
  errors: ERRORS,
  commands: [['nardy', 'нарды — новое лобби одной командой']],
  /** Соперник-бот для одиночной партии (bot.js). */
  bot,

  /** Жребий цвета и кубики жребия первого хода — подменяются в тестах. */
  dealOpts: (room, app) => ({ ...(app.nardyRand ? { rand: app.nardyRand } : {}), ...diceOpts(app) }),

  create({ chatId, title, host, settings = null }) {
    const s = settings || {};
    return N.createRoom({ chatId, title, host, base: s.base, inc: s.inc, side: s.side });
  },

  serialize: (room, now) => N.serialize(room, now),
  deserialize: (data) => N.deserialize(data),

  view: (room, viewerId, ctx) => nardyView(room, viewerId, ctx),

  card: (room, opts) => renderCard(room, opts),
  shareText: (room, userId, opts) => shareText(room, userId, opts),
  results: (room) => renderResults(room),

  /**
   * Партии для рейтинга: победа и поражение — места 1 и 2 (марс — тоже просто
   * победа). Ничьей нет. Короткая сдача или время — без очков, как в шахматах.
   */
  rounds(room) {
    return room.history.map((g) => {
      const name = (id) => N.findPlayer(room, id)?.name ?? null;
      const win = g.winner;
      const lose = win ? (win === g.white ? g.black : g.white) : null;
      const order = win ? [win, lose] : [g.white, g.black];
      return {
        id: `${room.code}#${g.no}`,
        aborted: !!g.aborted,
        short: !g.aborted && !!win && ['resign', 'time'].includes(g.kind) && g.turns < N.RATED_MIN_TURNS,
        draw: false,
        loserId: lose,
        places: order.map((id) => ({ id, name: name(id) })),
      };
    });
  },

  /** Ждём того, чей ход; ключ — на ход целиком (бросок, шаги, «Готово»). */
  waiting(room) {
    const m = N.live(room);
    if (!m) return [];
    const id = N.mover(m) === 'w' ? m.white : m.black;
    return [{ id, key: N.turnKey(m), kind: 'move' }];
  },
  pingText: (room, p, w) => renderTurnPing(room, p, w),

  summary(room) {
    const seated = N.seatedPlayers(room);
    return {
      seated: seated.length,
      max: N.MAX_SEATS,
      names: seated.map((p) => p.name),
      detail: N.controlRu(room.settings) + (room.gameNo ? ` · партия ${room.gameNo}` : ''),
    };
  },

  markLeft: (room, userId, now) => N.markLeft(room, userId, now),
  endGame: (room, userId, now) => N.endGame(room, userId, now),

  clocks(app, room, now) {
    const code = room.code;
    const turn = N.syncTurn(room, now);
    return [{ id: 'turn', timer: turn, fire: () => onTurnTimeout(app, code, turn.key) }];
  },

  async handle({ app, session, room, uid, msg, refuse, push }) {
    if (!ACTIONS.has(msg.t)) return refuse('BAD_REQUEST');
    const turnNo = Number.isInteger(msg.turn) ? msg.turn : undefined;
    const target = () => {
      const p = room.players[Number(msg.seat)];
      return Number.isInteger(Number(msg.seat)) && p ? p : null;
    };
    const fail = (r, { resync = false } = {}) => {
      if (!r?.error) return false;
      refuse(r.error, r.text);
      if (r.ended) return false;
      if (resync) push();
      return true;
    };

    switch (msg.t) {
      case 'sit': {
        const p = N.addPlayer(room, app.person(session.user));
        if (fail(p)) return;
        return app.afterChange(room);
      }
      case 'leave':
        if (fail(N.leave(room, uid))) return;
        return app.afterChange(room);

      case 'start': {
        const r = N.startGame(room, uid, app.dealOpts(room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }
      case 'next': {
        const r = N.nextGame(room, uid, app.dealOpts(room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }

      // Бросок: числа — только с сервера. Поля сообщения не читаются вовсе.
      case 'roll': {
        const r = N.roll(room, uid, app.clock.now(), diceOpts(app));
        if (r.ended) refuse(r.error, r.text);
        else if (fail(r, { resync: true })) return;
        return app.afterAction(room);
      }
      case 'move': {
        const r = N.move(room, uid, { from: Number(msg.from), die: Number(msg.die) }, app.clock.now(), turnNo);
        if (r.ended) refuse(r.error, r.text);
        else if (fail(r, { resync: true })) return;
        return r.over ? app.afterAction(room) : app.afterChange(room);
      }
      case 'undo': {
        const r = N.undo(room, uid, app.clock.now());
        if (r.ended) refuse(r.error, r.text);
        else if (fail(r, { resync: true })) return;
        return app.afterChange(room);
      }
      case 'end': {
        const r = N.endTurn(room, uid, app.clock.now());
        if (r.ended) refuse(r.error, r.text);
        else if (fail(r, { resync: true })) return;
        return app.afterAction(room);
      }
      case 'resign':
        if (fail(N.resign(room, uid, app.clock.now()), { resync: true })) return;
        return app.afterAction(room);
      case 'abort':
        if (fail(N.abortMatch(room, uid, app.clock.now()), { resync: true })) return;
        return app.afterAction(room);

      case 'settings': {
        const patch = {};
        for (const k of ['base', 'inc']) if (msg[k] != null && Number.isFinite(Number(msg[k]))) patch[k] = Number(msg[k]);
        if (typeof msg.side === 'string') patch.side = msg.side;
        if (fail(N.updateSettings(room, uid, patch))) return;
        return app.afterChange(room);
      }
      case 'kick': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(N.kickPlayer(room, uid, p.id, app.clock.now()))) return;
        return app.afterAction(room);
      }
      case 'host': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(N.transferHost(room, uid, p.id))) return;
        return app.afterChange(room);
      }
      case 'finish': {
        const r = N.endGame(room, uid, app.clock.now());
        if (fail(r) || r.noop) return;
        return app.finishUp(room);
      }

      default:
        return refuse('BAD_REQUEST');
    }
  },
};
