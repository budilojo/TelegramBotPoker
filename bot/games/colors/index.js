'use strict';
/**
 * «Радуга» как одна игра хаба: ходы, которые может прислать приложение,
 * таймер хода и крючки, которые зовёт ядро, — та же форма, что у games/durak
 * и games/poker. Ядро про эту игру не знает ничего, кроме строки в реестре.
 */
import crypto from 'node:crypto';
import * as C from './rules.js';
import { colorsView } from './view.js';
import { renderCard, renderResults, renderTurnPing } from './render.js';
import { isCard, COLORS, COLOR_RU } from './cards.js';

/** Название показываемое. Вынесено сюда: его могут поменять. */
export const TITLE = C.TITLE;
export const ICON = '🌈';
export const BLURB = 'Цветные карты: кто первым сбросит все';

/** Что страница может попросить у стола «Радуги», и ничего больше. */
const ACTIONS = new Set([
  'sit', 'leave', 'start', 'next', 'play', 'draw', 'pass', 'rainbow', 'catch',
  'settings', 'kick', 'host', 'abort', 'finish',
]);

/**
 * Слова на каждый отказ. Трёх кодов здесь нет нарочно — `NOT_YOUR_TURN`,
 * `NOT_ENOUGH_PLAYERS` и `TABLE_FULL`: словарь ошибок один на все игры, а у
 * покера и дурака они написаны по-своему и про своё («играют до шести»).
 * «Радуга» присылает на них свои слова прямо из правил, рядом с кодом.
 */
export const ERRORS = {
  NOT_IN_DEAL: 'Вы не играете в этой партии — сядьте, и вас сдадут со следующей.',
  OUT: 'Вы уже вышли из этой партии — ждём остальных.',
  NOT_YOUR_CARD: 'Этой карты у вас нет.',
  CANNOT_PLAY: 'Эту карту сюда не положить: нужен тот же цвет, то же число или тот же знак.',
  ONLY_DRAWN: 'Вы уже взяли карту — сыграть можно только её или передать ход.',
  NEED_COLOR: 'Выберите цвет: красный, жёлтый, зелёный или синий.',
  MUST_TAKE: 'Накопление выключено — на «+2» карту не положить, берите.',
  STACK_ONLY: 'На «+2» кладут только «+2» или «смену цвета +4».',
  STACK_FOUR_ONLY: 'На «+4» кладут только «смену цвета +4».',
  CAN_PLAY: 'У вас есть чем ходить — брать не нужно.',
  ALREADY_DREW: 'Карта уже взята: сыграйте её или передайте ход.',
  NOTHING_TO_PASS: 'Передать ход можно только после того, как взяли карту.',
  NOT_ONE_CARD: '«Радуга!» — когда у вас осталась ровно одна карта.',
  NOTHING_TO_CATCH: 'Ловить некого: все назвали «Радугу!» вовремя.',
  CATCH_SELF: 'Себя поймать нельзя — «Радугу!» за себя нажимают сами.',
  TOO_LATE: 'Поздно: пять секунд прошли, он ушёл чисто.',
  DEAL_IN_PROGRESS: 'Партия ещё идёт.',
  DEAL_OVER: 'Партия уже кончилась.',
  IN_DEAL: 'Партия идёт — встать можно после неё. (Хост может прервать партию.)',
  NOT_SEATED: 'Сначала сядьте за стол.',
  NOT_HOST: 'Это может только хост.',
  NOT_PLAYING: 'Игра ещё не началась.',
  ALREADY_STARTED: 'Игра уже идёт.',
  GAME_FINISHED: 'Игра завершена.',
  KICKED: 'Хост удалил вас из этой игры.',
  CANNOT_KICK_HOST: 'Хоста удалить нельзя — сначала передайте права.',
  NO_PLAYER: 'Игрок не найден.',
  STALE: 'Стол уже изменился — посмотрите ещё раз.',
  BAD_DECK: 'Колода не собралась — попробуйте ещё раз.',
};

/**
 * Пачка и случайность для перетасовки сброса.
 *
 * В проде — настоящая колода и `crypto.randomInt`. В тестах их подменяет
 * харнесс, выставляя `app.colorsDeck` и `app.colorsRand` прямо на приложении:
 * сиденье принадлежит модулю игры, а не ядру, поэтому ядру для новой игры
 * менять нечего.
 */
function opts(app, room) {
  const o = {};
  if (app.colorsDeck) o.deck = () => app.colorsDeck(room);
  if (app.colorsRand) o.randInt = app.colorsRand;
  return o;
}
const randOf = (app) => app.colorsRand || ((n) => crypto.randomInt(n));

async function onTurnTimeout(app, code, key) {
  const room = app.roomByCode(code);
  if (!room) return;
  const r = C.timeoutMove(room, key, app.clock.now(), { randInt: randOf(app) });
  if (!r.error) await app.afterAction(room);
  app.syncClocks();
}

export default {
  id: 'colors',
  title: TITLE,
  icon: ICON,
  blurb: BLURB,
  minPlayers: C.MIN_PLAYERS,
  maxPlayers: C.MAX_SEATS,
  errors: ERRORS,

  create({ chatId, title, host, settings = null }) {
    const s = settings || {};
    return C.createRoom({ chatId, title, host, stacking: s.stacking, turnSeconds: s.turnSeconds });
  },

  serialize: (room, now) => C.serialize(room, now),
  deserialize: (data) => C.deserialize(data),

  view: (room, viewerId, ctx) => colorsView(room, viewerId, ctx),

  card: (room, o) => renderCard(room, o),
  results: (room) => renderResults(room),

  /**
   * Партии, которые рейтингу есть смысл считать. В «Радуге» партия — это одна
   * сдача: у неё есть порядок выхода и есть последний. Прерванная сюда тоже
   * попадает — и получает отказ с объяснением, а не тихо пропадает.
   *
   * Кто ушёл из чата посреди партии, в места не попадает: он её не доиграл,
   * и ни очков, ни минуса за неё не получает.
   */
  rounds(room) {
    return room.history.map((g) => {
      const quit = new Set(g.quit || []);
      const order = (g.out || []).filter((id) => !quit.has(id));
      return {
        id: `${room.code}#${g.no}`,
        aborted: !!g.aborted,
        loserId: g.loser || null,
        places: order.map((id) => ({ id, name: C.findPlayer(room, id)?.name ?? null })),
      };
    });
  },

  /** Кого игра ждёт: всегда ровно одного — того, чей ход. */
  waiting(room) {
    const d = room.deal;
    if (!d || d.phase !== 'play' || !d.turn) return [];
    return [{ id: d.turn, key: C.waitKey(room), kind: d.pending ? 'pending' : 'turn' }];
  },
  pingText: (room, p, w) => renderTurnPing(room, p, w),

  summary(room) {
    const seated = C.seatedPlayers(room);
    return {
      seated: seated.length,
      max: C.MAX_SEATS,
      names: seated.map((p) => p.name),
      detail:
        (room.settings.stacking ? 'с накоплением' : 'без накопления') +
        (room.gameNo ? ` · партия ${room.gameNo}` : ''),
    };
  },

  markLeft: (room, userId) => C.markLeft(room, userId),
  endGame: (room, userId) => C.endGame(room, userId),

  clocks(app, room, now) {
    const code = room.code;
    const turn = C.syncTurn(room, now);
    return [{ id: 'turn', timer: turn, fire: () => onTurnTimeout(app, code, turn.key) }];
  },

  async handle({ app, session, room, uid, msg, refuse, push }) {
    if (!ACTIONS.has(msg.t)) return refuse('BAD_REQUEST');
    const seq = Number.isInteger(msg.seq) ? msg.seq : undefined;
    const card = isCard(msg.card) ? msg.card : null;
    const color = COLORS.includes(msg.color) ? msg.color : null;
    const now = app.clock.now();
    const randInt = randOf(app);
    const target = () => {
      const p = room.players[Number(msg.seat)];
      return Number.isInteger(Number(msg.seat)) && p ? p : null;
    };
    /** Отказ: сказать почему и вернуть на страницу настоящий стол. */
    const fail = (r, { resync = false } = {}) => {
      if (!r?.error) return false;
      refuse(r.error, r.text);
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

      // Через afterDeal, а не afterAction: сдача партии — это то же событие,
      // что раздача в покере, и считается ядром в одном месте.
      case 'start': {
        const r = C.startGame(room, uid, opts(app, room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }
      case 'next': {
        const r = C.nextGame(room, uid, opts(app, room));
        if (fail(r)) return;
        return app.afterDeal(room, r);
      }

      case 'play':
        if (!card) return refuse('NOT_YOUR_CARD');
        if (fail(C.play(room, uid, card, { color, seq, now, randInt }), { resync: true })) return;
        return app.afterAction(room);

      case 'draw':
        if (fail(C.draw(room, uid, { seq, now, randInt }), { resync: true })) return;
        return app.afterAction(room);

      case 'pass':
        if (fail(C.pass(room, uid, { seq, now, randInt }), { resync: true })) return;
        return app.afterAction(room);

      case 'rainbow':
        if (fail(C.rainbow(room, uid, { now }), { resync: true })) return;
        return app.afterAction(room);

      case 'catch':
        if (fail(C.catchRainbow(room, uid, { now, randInt }), { resync: true })) return;
        return app.afterAction(room);

      case 'settings': {
        const patch = {};
        if (typeof msg.stacking === 'boolean') patch.stacking = msg.stacking;
        if (msg.turnSeconds != null && Number.isFinite(Number(msg.turnSeconds))) patch.turnSeconds = Number(msg.turnSeconds);
        if (fail(C.updateSettings(room, uid, patch))) return;
        return app.afterChange(room);
      }
      case 'kick': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(C.kickPlayer(room, uid, p.id))) return;
        return app.afterAction(room);
      }
      case 'host': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(C.transferHost(room, uid, p.id))) return;
        return app.afterChange(room);
      }
      case 'abort':
        if (fail(C.abortGame(room, uid))) return;
        return app.afterAction(room);

      case 'finish':
        if (fail(C.endGame(room, uid))) return;
        return app.finishUp(room);

      default:
        return refuse('BAD_REQUEST');
    }
  },
};

export { COLOR_RU };
