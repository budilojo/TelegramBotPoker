'use strict';
/**
 * Морской бой как одна игра хаба: какие действия страница вправе прислать,
 * часы и зацепки ядра. Дуэль (`maxPlayers: 2`) по образцу шахмат, шашек и
 * нард.
 *
 * Тайна флота: расстановку присылает страница, проверяет сервер; наружу её
 * отдаёт только view.js — и до конца партии только хозяину. Жребий первого
 * выстрела и «Расставить случайно» — на сервере (`app.battleshipRand`,
 * `app.battleshipFleetRand` — подмена в тестах); числа со страницы не
 * читаются.
 */
import * as B from './rules.js';
import { battleshipView } from './view.js';
import { renderCard, renderResults, renderTurnPing, shareText, ICON } from './render.js';

/** Что страница вправе просить у стола морского боя — и больше ничего. */
const ACTIONS = new Set([
  'sit', 'leave', 'start', 'next', 'place', 'random', 'ready', 'fire', 'resign', 'abort',
  'settings', 'kick', 'host', 'finish',
]);

/**
 * Отказы словами. Ни один текст не называет клеток и не зависит от того,
 * что стоит на поле соперника: «уже стреляли» и «рядом с потопленным»
 * решаются по тому, что стрелок знает сам.
 */
export const ERRORS = {
  NOT_YOUR_TURN: 'Сейчас ходит соперник.',
  NOT_IN_GAME: 'Вы не играете в этой партии — вы зритель.',
  PLACING: 'Бой ещё не начался — флоты расставляют.',
  BATTLE_ON: 'Расстановка закончилась — идёт бой.',
  ALREADY_READY: 'Флот уже заперт — бой начнётся, когда соперник будет готов.',
  NO_FLEET: 'Сначала расставьте все корабли.',
  BAD_FLEET: 'Во флоте должны быть ровно: один четырёхпалубный, два трёхпалубных, три двухпалубных и четыре однопалубных.',
  BAD_SHIP: 'Корабль должен стоять в поле целиком — по прямой, вдоль или поперёк.',
  SHIPS_TOUCH: 'Корабли не должны касаться друг друга — даже углами.',
  BAD_CELL: 'Такой клетки на поле нет.',
  ALREADY_SHOT: 'Сюда вы уже стреляли — выберите другую клетку.',
  NEAR_SUNK: 'Рядом с потопленным кораблём кораблей не бывает — выберите другую клетку.',
  STALE: 'Позиция уже изменилась — посмотрите ещё раз.',
  TIME_UP: 'Время на ход вышло — партия закончена.',
  NOT_PLAYING: 'Партия сейчас не идёт.',
  GAME_IN_PROGRESS: 'Партия ещё идёт.',
  IN_GAME: 'Партия идёт — из-за стола уходят после неё. Можно сдаться.',
  RESIGN_EARLY: 'Сдаться можно, когда каждый выстрелил хотя бы раз. Пока партию можно отменить.',
  ABORT_LATE: 'Отменить можно только до первого выстрела каждого. Теперь — сдаться.',
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
/** Коды правил, у которых в морском бое свой смысл (у других дуэлей те же коды — про другое). */
const OWN_CODE = { TOO_EARLY: 'RESIGN_EARLY', TOO_LATE: 'ABORT_LATE' };

/** Случайность сервера; в тестах — подмена из приложения. Со страницы — никогда. */
const randOpts = (app) => ({
  ...(app.battleshipRand ? { rand: app.battleshipRand } : {}),
  ...(app.battleshipFleetRand ? { fleetRand: app.battleshipFleetRand } : {}),
});

async function onTurnTimeout(app, code, key) {
  const room = app.roomByCode(code);
  if (!room) return;
  const r = B.timeoutMove(room, key, app.clock.now(), randOpts(app));
  if (!r.error) await app.afterAction(room);
  app.syncClocks();
}

export default {
  id: 'battleship',
  title: 'Морской бой',
  icon: ICON,
  blurb: 'Морской бой на двоих, с часами',
  minPlayers: B.MIN_PLAYERS,
  maxPlayers: B.MAX_SEATS,
  errors: ERRORS,
  /** Черновик: экрана и бота ещё нет — людям игра не видна (bot/games/index.js). Снять на этапе 3. */
  draft: true,
  commands: [['battleship', 'морской бой — новое лобби одной командой']],

  /** Жребий первого выстрела и случайная расстановка — подменяются в тестах. */
  dealOpts: (room, app) => randOpts(app),

  create({ chatId, title, host, settings = null }) {
    const s = settings || {};
    return B.createRoom({ chatId, title, host, base: s.base, inc: s.inc });
  },

  serialize: (room, now) => B.serialize(room, now),
  deserialize: (data) => B.deserialize(data),

  view: (room, viewerId, ctx) => battleshipView(room, viewerId, ctx),

  card: (room, opts) => renderCard(room, opts),
  shareText: (room, userId, opts) => shareText(room, userId, opts),
  results: (room) => renderResults(room),

  /**
   * Партии для рейтинга: победа и поражение — места 1 и 2. Ничьей нет.
   * Короткая сдача или время (меньше 20 выстрелов) — без очков.
   */
  rounds(room) {
    return room.history.map((g) => {
      const name = (id) => B.findPlayer(room, id)?.name ?? null;
      const win = g.winner;
      const lose = win ? g.ids.find((id) => id !== win) : null;
      const order = win ? [win, lose] : g.ids.slice();
      return {
        id: `${room.code}#${g.no}`,
        aborted: !!g.aborted,
        short: !g.aborted && !!win && ['resign', 'time'].includes(g.kind) && g.shots < B.RATED_MIN_SHOTS,
        draw: false,
        loserId: lose,
        places: order.map((id) => ({ id, name: name(id) })),
      };
    });
  },

  /** Расстановка — ждём каждого, кто не готов; бой — того, чей выстрел. */
  waiting(room) {
    const m = B.live(room);
    if (!m) return [];
    if (m.phase === 'place') {
      return [0, 1].filter((s) => !m.ready[s]).map((s) => ({ id: m.ids[s], key: `${B.turnKey(m)}:${s}`, kind: 'place' }));
    }
    return [{ id: m.ids[B.mover(m)], key: B.turnKey(m), kind: 'move' }];
  },
  pingText: (room, p, w) => renderTurnPing(room, p, w),

  summary(room) {
    const seated = B.seatedPlayers(room);
    return {
      seated: seated.length,
      max: B.MAX_SEATS,
      names: seated.map((p) => p.name),
      detail: B.controlRu(room.settings) + (room.gameNo ? ` · партия ${room.gameNo}` : ''),
    };
  },

  markLeft: (room, userId, now) => B.markLeft(room, userId, now),
  endGame: (room, userId, now) => B.endGame(room, userId, now),

  clocks(app, room, now) {
    const code = room.code;
    const turn = B.syncTurn(room, now);
    return [{ id: 'turn', timer: turn, fire: () => onTurnTimeout(app, code, turn.key) }];
  },

  async handle({ app, session, room, uid, msg, refuse, push }) {
    // Отказ — всегда текстом этой игры: общие коды у других игр значат другое.
    const say = (code) => {
      const c = OWN_CODE[code] || code;
      return refuse(c, ERRORS[c]);
    };
    if (!ACTIONS.has(msg.t)) return refuse('BAD_REQUEST');
    const shotNo = Number.isInteger(msg.shot) ? msg.shot : undefined;
    const now = () => app.clock.now();
    const opts = () => randOpts(app);
    const target = () => {
      const p = room.players[Number(msg.seat)];
      return Number.isInteger(Number(msg.seat)) && p ? p : null;
    };
    const fail = (r, { resync = false } = {}) => {
      if (!r?.error) return false;
      say(r.error);
      if (r.ended) return false;
      if (resync) push();
      return true;
    };

    switch (msg.t) {
      case 'sit': {
        const p = B.addPlayer(room, app.person(session.user));
        if (fail(p)) return;
        return app.afterChange(room);
      }
      case 'leave':
        if (fail(B.leave(room, uid))) return;
        return app.afterChange(room);

      case 'start': {
        const r = B.startGame(room, uid, app.dealOpts(room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }
      case 'next': {
        const r = B.nextGame(room, uid, app.dealOpts(room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }

      // Расстановка: свой флот целиком; проверяет сервер. Чей флот — из initData, не из тела.
      case 'place': {
        const r = B.place(room, uid, msg.ships, now(), opts());
        if (fail(r, { resync: true })) return;
        return r.ended ? app.afterAction(room) : app.afterChange(room);
      }
      case 'random': {
        const r = B.placeRandom(room, uid, now(), opts());
        if (fail(r, { resync: true })) return;
        return r.ended ? app.afterAction(room) : app.afterChange(room);
      }
      case 'ready': {
        const r = B.ready(room, uid, now(), opts());
        if (fail(r, { resync: true })) return;
        return app.afterAction(room);
      }

      // Выстрел: только тот, чей ход, только в клетку, о которой он ещё не знает.
      case 'fire': {
        const r = B.fire(room, uid, msg.cell, now(), shotNo, opts());
        if (fail(r, { resync: true })) return;
        return app.afterAction(room);
      }
      case 'resign':
        if (fail(B.resign(room, uid, now(), opts()), { resync: true })) return;
        return app.afterAction(room);
      case 'abort':
        if (fail(B.abortMatch(room, uid, now(), opts()), { resync: true })) return;
        return app.afterAction(room);

      case 'settings': {
        const patch = {};
        for (const k of ['base', 'inc']) if (msg[k] != null && Number.isFinite(Number(msg[k]))) patch[k] = Number(msg[k]);
        if (fail(B.updateSettings(room, uid, patch))) return;
        return app.afterChange(room);
      }
      case 'kick': {
        const p = target();
        if (!p) return say('NO_PLAYER');
        if (fail(B.kickPlayer(room, uid, p.id, now()))) return;
        return app.afterAction(room);
      }
      case 'host': {
        const p = target();
        if (!p) return say('NO_PLAYER');
        if (fail(B.transferHost(room, uid, p.id))) return;
        return app.afterChange(room);
      }
      case 'finish': {
        const r = B.endGame(room, uid, now());
        if (fail(r) || r.noop) return;
        return app.finishUp(room);
      }

      default:
        return refuse('BAD_REQUEST');
    }
  },
};
