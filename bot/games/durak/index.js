'use strict';
/**
 * Durak as one game of the hub: the moves the Mini App may send, the turn
 * timer, and the hooks the core calls — the same shape as games/poker.
 */
import * as D from './rules.js';
import { durakView } from './view.js';
import { renderCard, renderResults, renderTurnPing } from './render.js';
import { isCard } from './cards.js';

/** What the page may ask for at a durak game, and nothing else. */
const ACTIONS = new Set([
  'sit', 'leave', 'start', 'next', 'attack', 'defend', 'transfer', 'take', 'pass',
  'settings', 'kick', 'host', 'abort', 'finish',
]);

export const ERRORS = {
  NOT_IN_DEAL: 'Вы не играете в этой партии — сядьте, и вас сдадут со следующей.',
  OUT: 'Вы уже вышли из этой партии — ждём остальных.',
  NOT_YOUR_CARD: 'Этой карты у вас нет.',
  NOT_YOUR_LEAD: 'Сейчас ходит другой игрок.',
  DEFENDER_CANNOT_ATTACK: 'Вы отбиваетесь — подкидывать нельзя.',
  DEFENDER_TRANSFERS: 'Вы отбиваетесь: покрыть — тапом по карте на столе, перевести — кнопкой «Перевести».',
  DEFENDER_PASS: 'Вы отбиваетесь: покройте карты или нажмите «Взять».',
  RANK_NOT_ON_TABLE: 'Подкидывать можно только карты тех достоинств, что уже на столе.',
  TABLE_LIMIT: 'Больше не подкинуть: в отбое не больше 6 карт и не больше, чем карт у отбивающегося.',
  NOT_DEFENDER: 'Сейчас отбивается другой игрок.',
  TAKING: 'Отбивающийся уже берёт.',
  BAD_TARGET: 'Выберите карту на столе, которую кроете.',
  ALREADY_COVERED: 'Эта карта уже побита.',
  CANNOT_BEAT: 'Эта карта её не бьёт.',
  ALL_COVERED: 'Всё побито — брать нечего.',
  CANNOT_PASS: '«Пас» — когда всё побито или отбивающийся берёт.',
  NO_TRANSFER: 'Переводить можно только в переводном.',
  NOTHING_TO_TRANSFER: 'Переводить нечего — на столе пусто.',
  TRANSFER_AFTER_BEAT: 'Переводить можно, пока ни одна карта не побита.',
  TRANSFER_RANK: 'Перевести можно только картой того же достоинства.',
  TRANSFER_TOO_MANY: 'Перевести нельзя: у следующего игрока меньше карт, чем окажется на столе.',
  DEAL_IN_PROGRESS: 'Партия ещё идёт.',
  DEAL_OVER: 'Партия уже кончилась.',
  IN_DEAL: 'Партия идёт — встать можно после неё. (Хост может прервать партию.)',
  NOT_SEATED: 'Сначала сядьте за стол.',
  NOT_HOST: 'Это может только хост.',
  NOT_PLAYING: 'Игра ещё не началась.',
  ALREADY_STARTED: 'Игра уже идёт.',
  GAME_FINISHED: 'Игра завершена.',
  NOT_ENOUGH_PLAYERS: 'Нужно минимум два игрока.',
  TABLE_FULL: 'За столом нет мест — играют до шести.',
  KICKED: 'Хост удалил вас из этой игры.',
  CANNOT_KICK_HOST: 'Хоста удалить нельзя — сначала передайте права.',
  NO_PLAYER: 'Игрок не найден.',
  STALE: 'Стол уже изменился — посмотрите ещё раз.',
  BAD_DECK: 'Колода не собралась — попробуйте ещё раз.',
};

async function onTurnTimeout(app, code, key) {
  const room = app.roomByCode(code);
  if (!room) return;
  const r = D.timeoutMove(room, key, app.clock.now());
  if (!r.error) await app.afterAction(room);
  app.syncClocks();
}

export default {
  id: 'durak',
  title: 'Дурак',
  icon: '🃏',
  blurb: 'Подкидной или переводной',
  minPlayers: D.MIN_PLAYERS,
  maxPlayers: D.MAX_SEATS,
  errors: ERRORS,

  create({ chatId, title, host, settings = null }) {
    const s = settings || {};
    return D.createRoom({ chatId, title, host, variant: s.variant, turnSeconds: s.turnSeconds });
  },

  serialize: (room, now) => D.serialize(room, now),
  deserialize: (data) => D.deserialize(data),

  view: (room, viewerId, ctx) => durakView(room, viewerId, ctx),

  card: (room, opts) => renderCard(room, opts),
  results: (room) => renderResults(room),

  /**
   * Who the game is blocked on: the attacker who must open a bout, the
   * defender facing cards, or — once everything is covered or being taken —
   * everybody who may still throw in and has not said "пас".
   */
  waiting(room) {
    const d = room.deal;
    if (!d || d.phase !== 'play') return [];
    const b = `${d.no}:${d.bout.no}`;
    if (!d.table.length) return [{ id: d.attacker, key: `${b}:lead`, kind: 'lead' }];
    if (!D.allCovered(d) && !d.bout.taking) return [{ id: d.defender, key: `${b}:def`, kind: 'defend' }];
    return D.waitingThrowers(d).map((id) => ({ id, key: `${b}:throw:${d.table.length}`, kind: 'throw' }));
  },
  pingText: (room, p, w) => renderTurnPing(room, p, w),

  summary(room) {
    const seated = D.seatedPlayers(room);
    return {
      seated: seated.length,
      max: D.MAX_SEATS,
      names: seated.map((p) => p.name),
      detail: D.VARIANT_RU[room.settings.variant] + (room.gameNo ? ` · партия ${room.gameNo}` : ''),
    };
  },

  markLeft: (room, userId) => D.markLeft(room, userId),
  endGame: (room, userId) => D.endGame(room, userId),

  clocks(app, room, now) {
    const code = room.code;
    const turn = D.syncTurn(room, now);
    return [{ id: 'turn', timer: turn, fire: () => onTurnTimeout(app, code, turn.key) }];
  },

  async handle({ app, session, room, uid, msg, refuse, push }) {
    if (!ACTIONS.has(msg.t)) return refuse('BAD_REQUEST');
    const seq = Number.isInteger(msg.seq) ? msg.seq : undefined;
    const card = isCard(msg.card) ? msg.card : null;
    const target = () => {
      const p = room.players[Number(msg.seat)];
      return Number.isInteger(Number(msg.seat)) && p ? p : null;
    };
    /** A refused move: say why, and put the true table back on the page. */
    const fail = (r, { resync = false } = {}) => {
      if (!r?.error) return false;
      refuse(r.error, r.text);
      if (resync) push();
      return true;
    };

    switch (msg.t) {
      case 'sit': {
        const p = D.addPlayer(room, app.person(session.user));
        if (fail(p)) return;
        return app.afterChange(room);
      }
      case 'leave':
        if (fail(D.leave(room, uid))) return;
        return app.afterChange(room);

      case 'start':
        if (fail(D.startGame(room, uid, app.dealOpts(room)))) return;
        return app.afterAction(room);

      case 'next':
        if (fail(D.nextGame(room, uid, app.dealOpts(room)))) return;
        return app.afterAction(room);

      case 'attack':
        if (!card) return refuse('NOT_YOUR_CARD');
        if (fail(D.attack(room, uid, card, seq), { resync: true })) return;
        return app.afterAction(room);

      case 'defend':
        if (!card) return refuse('NOT_YOUR_CARD');
        if (fail(D.defend(room, uid, card, msg.target, seq), { resync: true })) return;
        return app.afterAction(room);

      case 'transfer':
        if (!card) return refuse('NOT_YOUR_CARD');
        if (fail(D.transfer(room, uid, card, seq), { resync: true })) return;
        return app.afterAction(room);

      case 'take':
        if (fail(D.take(room, uid, seq), { resync: true })) return;
        return app.afterAction(room);

      case 'pass':
        if (fail(D.pass(room, uid, seq), { resync: true })) return;
        return app.afterAction(room);

      case 'settings': {
        const patch = {};
        if (D.VARIANTS.includes(msg.variant)) patch.variant = msg.variant;
        if (msg.turnSeconds != null && Number.isFinite(Number(msg.turnSeconds))) patch.turnSeconds = Number(msg.turnSeconds);
        if (fail(D.updateSettings(room, uid, patch))) return;
        return app.afterChange(room);
      }
      case 'kick': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(D.kickPlayer(room, uid, p.id))) return;
        return app.afterAction(room);
      }
      case 'host': {
        const p = target();
        if (!p) return refuse('NO_PLAYER');
        if (fail(D.transferHost(room, uid, p.id))) return;
        return app.afterChange(room);
      }
      case 'abort':
        if (fail(D.abortGame(room, uid))) return;
        return app.afterAction(room);

      case 'finish':
        if (fail(D.endGame(room, uid))) return;
        return app.finishUp(room);

      default:
        return refuse('BAD_REQUEST');
    }
  },
};
